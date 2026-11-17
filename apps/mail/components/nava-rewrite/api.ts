import { z } from 'zod';
import {
  acceptedGoSchema, acceptedStageSchema, apiErrorSchema, capabilitiesSchema, eventSchema,
  proposalSchema, threadInputSchema, threadSnapshotSchema,
} from './wire';
import type {
  AcceptedGo, AcceptedStage, Capabilities, Change, NavaEvent, Proposal, ThreadInput, ThreadSnapshot,
} from './wire';

export type RequestOptions = { signal?: AbortSignal };
export type RevisionRequest = RequestOptions & { proposalId: string; expectedRevision: number };
export type NavaApi = {
  upsertThread: (input: ThreadInput, options?: RequestOptions) => Promise<ThreadSnapshot>;
  getThread: (id: string, options?: RequestOptions) => Promise<ThreadSnapshot>;
  getCapabilities: (options?: RequestOptions) => Promise<Capabilities>;
  events: (id: string, afterSequence: number, options?: RequestOptions) => AsyncGenerator<NavaEvent>;
  patchProposal: (request: RevisionRequest & { changes: Change[] }) => Promise<Proposal>;
  undo: (request: RevisionRequest) => Promise<Proposal>;
  redo: (request: RevisionRequest) => Promise<Proposal>;
  stage: (request: RevisionRequest) => Promise<AcceptedStage>;
  go: (request: RevisionRequest & { idempotencyKey: string }) => Promise<AcceptedGo>;
  reconcile: (request: RevisionRequest) => Promise<void>;
  sendContext: (request: RequestOptions & { threadId: string; text: string; proposalId?: string }) => Promise<void>;
  getArtifact: (id: string, options?: RequestOptions) => Promise<Response>;
};

export type NavaErrorKind = 'http' | 'conflict' | 'network' | 'invalid_response' | 'unavailable';
export class NavaApiError extends Error {
  constructor(
    message: string,
    readonly kind: NavaErrorKind,
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly details: unknown = null,
    // A failed Go may have reached HMS. Reload and reconcile before any further Go.
    readonly outcome: 'known' | 'uncertain' = 'known',
  ) {
    super(message);
    this.name = 'NavaApiError';
  }
}

type HostFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type NavaApiConfig = {
  // Supplied by authenticated host; no bootstrap/service token belongs in the pane.
  fetch: HostFetch;
  baseUrl?: string;
  // Enable only after the backend-verifiable staff principal bridge is proven.
  staffGoEnabled?: boolean;
};

export function createNavaApi(config: NavaApiConfig): NavaApi {
  const base = `${(config.baseUrl ?? '').replace(/\/+$/, '')}/api/nava/v1`;
  const pathId = (id: string) => encodeURIComponent(id);

  async function request(path: string, init: RequestInit = {}, go = false): Promise<Response> {
    let response: Response;
    try {
      response = await config.fetch(`${base}${path}`, init);
    } catch (error) {
      throw new NavaApiError('Connection to Nava failed.', 'network', null, null, error, go ? 'uncertain' : 'known');
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const parsed = apiErrorSchema.safeParse(payload);
      const message = parsed.success ? parsed.data.error.message : `Nava request failed (${response.status}).`;
      throw new NavaApiError(
        message, response.status === 409 ? 'conflict' : 'http', response.status,
        parsed.success ? parsed.data.error.code : null, parsed.success ? parsed.data.error.details : payload,
        go && (response.status >= 500 || response.status === 409) ? 'uncertain' : 'known',
      );
    }
    return response;
  }

  async function json<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, go = false): Promise<T> {
    const response = await request(path, init, go);
    const payload: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new NavaApiError('Nava returned an invalid response.', 'invalid_response', response.status, null, null, go ? 'uncertain' : 'known');
    }
    return parsed.data;
  }

  const body = (value: unknown, signal?: AbortSignal, headers?: Record<string, string>): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value), signal,
  });
  const revisionBody = (request: RevisionRequest) => body({ expected_revision: request.expectedRevision }, request.signal);
  const proposalPath = (id: string) => `/proposals/${pathId(id)}`;

  async function* events(threadId: string, afterSequence: number, options?: RequestOptions): AsyncGenerator<NavaEvent> {
    const response = await request(`/threads/${pathId(threadId)}/events?after_sequence=${encodeURIComponent(afterSequence)}`, {
      headers: { Accept: 'text/event-stream' }, signal: options?.signal,
    });
    if (!response.body) throw new NavaApiError('Nava event stream is unavailable.', 'invalid_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let lastSequence = afterSequence;
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline = buffer.search(/[\r\n]/);
        while (newline !== -1) {
          if (!chunk.done && buffer[newline] === '\r' && newline === buffer.length - 1) break;
          const line = buffer.slice(0, newline);
          const width = buffer.slice(newline, newline + 2) === '\r\n' ? 2 : 1;
          buffer = buffer.slice(newline + width);
          if (line === '') {
            if (data.length) {
              let payload: unknown;
              try { payload = JSON.parse(data.join('\n')); } catch { throw new NavaApiError('Nava returned an invalid event.', 'invalid_response'); }
              const parsed = eventSchema.safeParse(payload);
              if (!parsed.success) throw new NavaApiError('Nava returned an invalid event.', 'invalid_response');
              if (parsed.data.sequence > lastSequence) {
                lastSequence = parsed.data.sequence;
                yield parsed.data;
              }
              data = [];
            }
          } else if (line === 'data' || line.startsWith('data:')) {
            const value = line === 'data' ? '' : line.slice(5);
            data.push(value.startsWith(' ') ? value.slice(1) : value);
          }
          newline = buffer.search(/[\r\n]/);
        }
        if (chunk.done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return {
    upsertThread: (input, options) => {
      const parsed = threadInputSchema.parse(input);
      const key = encodeURIComponent(JSON.stringify([parsed.source, parsed.mailbox_id, parsed.source_thread_id, parsed.selected_message_id]));
      return json('/threads', threadSnapshotSchema, body(parsed, options?.signal, { 'Idempotency-Key': key }));
    },
    getThread: (id, options) => json(`/threads/${pathId(id)}`, threadSnapshotSchema, { signal: options?.signal }),
    getCapabilities: options => json('/capabilities', capabilitiesSchema, { signal: options?.signal }),
    events,
    patchProposal: ({ proposalId, expectedRevision, changes, signal }) => json(proposalPath(proposalId), proposalSchema, {
      ...body({ expected_revision: expectedRevision, changes }, signal), method: 'PATCH',
    }),
    undo: request => json(`${proposalPath(request.proposalId)}/undo`, proposalSchema, revisionBody(request)),
    redo: request => json(`${proposalPath(request.proposalId)}/redo`, proposalSchema, revisionBody(request)),
    stage: request => json(`${proposalPath(request.proposalId)}/stage`, acceptedStageSchema, revisionBody(request)),
    go: request => {
      if (!config.staffGoEnabled) throw new NavaApiError('Staff authorization is not ready.', 'unavailable');
      if (!request.idempotencyKey.trim()) throw new NavaApiError('Go requires an idempotency key.', 'unavailable');
      return json(`${proposalPath(request.proposalId)}/go`, acceptedGoSchema, body({
        expected_revision: request.expectedRevision, idempotency_key: request.idempotencyKey,
      }, request.signal), true);
    },
    reconcile: async requestValue => {
      await request(`${proposalPath(requestValue.proposalId)}/reconcile`, revisionBody(requestValue));
    },
    sendContext: async ({ threadId, text, proposalId, signal }) => {
      await request(`/threads/${pathId(threadId)}/messages`, body({ text, ...(proposalId === undefined ? {} : { proposal_id: proposalId }) }, signal));
    },
    getArtifact: (id, options) => request(`/artifacts/${pathId(id)}`, { signal: options?.signal }),
  };
}
