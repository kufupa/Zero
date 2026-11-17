import { z } from 'zod';
import {
  acceptedGoSchema, acceptedQuoteSchema, acceptedStageSchema, apiErrorSchema, capabilitiesSchema, eventSchema,
  proposalSchema, threadInputSchema, threadSnapshotSchema,
} from './wire';
import type {
  AcceptedGo, AcceptedQuote, AcceptedStage, Capabilities, Change, NavaEvent, Proposal, ThreadInput, ThreadSnapshot,
} from './wire';

export type RequestOptions = { signal?: AbortSignal };
export type RevisionRequest = RequestOptions & { proposalId: string; expectedRevision: number };
export type ManualLabtestSource = Pick<ThreadInput, 'source' | 'mailbox_id' | 'source_thread_id' | 'selected_message_id'>;
export type ManualLabtestBinding = { threadId: string; sessionId: string; proposalId: string; revision: number; selectedMessageId: string };
export type NavaApi = {
  upsertThread: (input: ThreadInput, options?: RequestOptions) => Promise<ThreadSnapshot>;
  getThread: (id: string, options?: RequestOptions) => Promise<ThreadSnapshot>;
  getCapabilities: (options?: RequestOptions) => Promise<Capabilities>;
  getManualLabtest: (source: ManualLabtestSource, options?: RequestOptions) => Promise<ThreadSnapshot | null>;
  events: (id: string, afterSequence: number, options?: RequestOptions) => AsyncGenerator<NavaEvent>;
  patchProposal: (request: RevisionRequest & { changes: Change[] }) => Promise<Proposal>;
  undo: (request: RevisionRequest) => Promise<Proposal>;
  redo: (request: RevisionRequest) => Promise<Proposal>;
  quote: (request: RevisionRequest & { quoteId: string; idempotencyKey: string }) => Promise<AcceptedQuote>;
  stage: (request: RevisionRequest) => Promise<AcceptedStage>;
  go: (request: RevisionRequest & { idempotencyKey: string; source: ManualLabtestSource; threadId: string; sessionId: string }) => Promise<AcceptedGo>;
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
};

export function matchesManualLabtest(snapshot: ThreadSnapshot | null, binding: ManualLabtestBinding): boolean {
  if (!snapshot || snapshot.id !== binding.threadId || snapshot.selected_message_id !== binding.selectedMessageId ||
      snapshot.session?.id !== binding.sessionId || snapshot.session.mode !== 'labtest') return false;
  return snapshot.proposals.some(proposal => proposal.id === binding.proposalId && proposal.thread_id === binding.threadId &&
    proposal.session_id === binding.sessionId && proposal.workflow === 'create' && proposal.revision === binding.revision &&
    proposal.phase === 'waiting_go' && proposal.stage?.revision === binding.revision);
}

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

  async function getManualLabtest(source: ManualLabtestSource, options?: RequestOptions): Promise<ThreadSnapshot | null> {
    const query = new URLSearchParams({
      source: source.source, mailbox_id: source.mailbox_id,
      source_thread_id: source.source_thread_id, selected_message_id: source.selected_message_id,
    });
    try {
      return await json(`/labtest/create?${query}`, threadSnapshotSchema, { signal: options?.signal });
    } catch (error) {
      if (error instanceof NavaApiError && error.status === 404) return null;
      throw error;
    }
  }

  async function* events(threadId: string, afterSequence: number, options?: RequestOptions): AsyncGenerator<NavaEvent> {
    const response = await request(`/threads/${pathId(threadId)}/events?after_sequence=${encodeURIComponent(afterSequence)}`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(afterSequence) }, signal: options?.signal,
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
    getManualLabtest,
    events,
    patchProposal: ({ proposalId, expectedRevision, changes, signal }) => json(proposalPath(proposalId), proposalSchema, {
      ...body({ expected_revision: expectedRevision, changes }, signal), method: 'PATCH',
    }),
    undo: request => json(`${proposalPath(request.proposalId)}/undo`, proposalSchema, revisionBody(request)),
    redo: request => json(`${proposalPath(request.proposalId)}/redo`, proposalSchema, revisionBody(request)),
    quote: async ({ proposalId, expectedRevision, quoteId, idempotencyKey, signal }) => {
      const response = await request(`${proposalPath(proposalId)}/quote`, body({
        expected_revision: expectedRevision, quote_id: quoteId, idempotency_key: idempotencyKey,
      }, signal));
      const payload: unknown = await response.json().catch(() => null);
      const parsed = acceptedQuoteSchema.safeParse(payload);
      if (response.status !== 202 || !parsed.success || parsed.data.proposal_id !== proposalId ||
          parsed.data.revision !== expectedRevision || parsed.data.quote_id !== quoteId) {
        throw new NavaApiError('Nava returned an invalid quote response.', 'invalid_response', response.status);
      }
      return parsed.data;
    },
    stage: request => json(`${proposalPath(request.proposalId)}/stage`, acceptedStageSchema, revisionBody(request)),
    go: async request => {
      if (!request.idempotencyKey.trim()) throw new NavaApiError('Go requires an idempotency key.', 'unavailable');
      let manual: ThreadSnapshot | null;
      try {
        manual = await getManualLabtest(request.source, { signal: request.signal });
      } catch (error) {
        if (error instanceof NavaApiError && error.status === 401) throw error;
        throw new NavaApiError('Could not verify this Labtest.', 'unavailable');
      }
      if (!matchesManualLabtest(manual, {
        threadId: request.threadId, sessionId: request.sessionId, proposalId: request.proposalId,
        revision: request.expectedRevision, selectedMessageId: request.source.selected_message_id,
      })) throw new NavaApiError('This Labtest is not ready for Go.', 'unavailable');
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
