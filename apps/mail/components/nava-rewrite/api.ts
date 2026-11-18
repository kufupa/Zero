import { z } from 'zod';
import {
  acceptedGoSchema, acceptedQuoteSchema, acceptedStageSchema, apiErrorSchema, capabilitiesSchema, eventSchema,
  proposalSchema, threadInputSchema, threadSnapshotSchema,
} from './wire';
import type {
  AcceptedGo, AcceptedQuote, AcceptedStage, Capabilities, Change, NavaEvent, Proposal, QuoteSelection, ThreadInput,
} from './wire';

const boundProposalSchema = proposalSchema.extend({ source_message_id: z.string().min(1).nullable().optional() });
const boundThreadSnapshotSchema = threadSnapshotSchema.extend({ proposals: z.array(boundProposalSchema) });
export type BoundThreadSnapshot = z.infer<typeof boundThreadSnapshotSchema>;

export type RequestOptions = { signal?: AbortSignal };
type EventOptions = RequestOptions & { onConnected?: () => void };
export type RevisionRequest = RequestOptions & { proposalId: string; expectedRevision: number };
export type NavaApi = {
  upsertThread: (input: ThreadInput, options?: RequestOptions) => Promise<BoundThreadSnapshot>;
  getThread: (id: string, options?: RequestOptions) => Promise<BoundThreadSnapshot>;
  getCapabilities: (options?: RequestOptions) => Promise<Capabilities>;
  events: (id: string, afterSequence: number, options?: EventOptions) => AsyncGenerator<NavaEvent>;
  patchProposal: (request: RevisionRequest & { changes: Change[]; staffAttachmentsChecked?: boolean }) => Promise<Proposal>;
  undo: (request: RevisionRequest) => Promise<Proposal>;
  redo: (request: RevisionRequest) => Promise<Proposal>;
  quote: (request: RevisionRequest & { quoteId: string; idempotencyKey: string }) => Promise<AcceptedQuote>;
  quoteArtifacts: (request: RevisionRequest & { quoteId: string; selections: QuoteSelection[] }) => Promise<void>;
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

export function createNavaApi(config: NavaApiConfig): NavaApi {
  const base = `${(config.baseUrl ?? '').replace(/\/+$/, '')}/api/nava/v1`;
  const pathId = (id: string) => encodeURIComponent(id);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await config.fetch(`${base}${path}`, init);
    } catch (error) {
      throw new NavaApiError('Connection to Nava failed.', 'network', null, null, error);
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const parsed = apiErrorSchema.safeParse(payload);
      const message = parsed.success ? parsed.data.error.message : `Nava request failed (${response.status}).`;
      throw new NavaApiError(
        message, response.status === 409 ? 'conflict' : 'http', response.status,
        parsed.success ? parsed.data.error.code : null, parsed.success ? parsed.data.error.details : payload,
      );
    }
    return response;
  }

  async function json<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> {
    const response = await request(path, init);
    const payload: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new NavaApiError('Nava returned an invalid response.', 'invalid_response', response.status);
    }
    return parsed.data;
  }

  const body = (value: unknown, signal?: AbortSignal, headers?: Record<string, string>): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value), signal,
  });
  const revisionBody = (request: RevisionRequest) => body({ expected_revision: request.expectedRevision }, request.signal);
  const proposalPath = (id: string) => `/proposals/${pathId(id)}`;

  async function* events(threadId: string, afterSequence: number, options?: EventOptions): AsyncGenerator<NavaEvent> {
    const response = await request(`/threads/${pathId(threadId)}/events?after_sequence=${encodeURIComponent(afterSequence)}`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(afterSequence) }, signal: options?.signal,
    });
    if (!response.body) throw new NavaApiError('Nava event stream is unavailable.', 'invalid_response');
    options?.onConnected?.();
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
    upsertThread: async (input, options) => {
      const parsed = threadInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
      const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return json('/threads', boundThreadSnapshotSchema, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: payload, signal: options?.signal,
      });
    },
    getThread: (id, options) => json(`/threads/${pathId(id)}`, boundThreadSnapshotSchema, { signal: options?.signal }),
    getCapabilities: options => json('/capabilities', capabilitiesSchema, { signal: options?.signal }),
    events,
    patchProposal: ({ proposalId, expectedRevision, changes, staffAttachmentsChecked, signal }) => json(proposalPath(proposalId), proposalSchema, {
      ...body({ expected_revision: expectedRevision, changes, ...(staffAttachmentsChecked === undefined ? {} : { staff_attachments_checked: staffAttachmentsChecked }) }, signal), method: 'PATCH',
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
    quoteArtifacts: async ({ proposalId, expectedRevision, quoteId, selections, signal }) => {
      const response = await request(`${proposalPath(proposalId)}/quote-artifacts`, body({
        expected_revision: expectedRevision, quote_id: quoteId, selections,
      }, signal));
      if (response.status !== 201) throw new NavaApiError('Nava did not confirm the quote files.', 'invalid_response', response.status);
    },
    stage: async requestValue => {
      const response = await request(`${proposalPath(requestValue.proposalId)}/stage`, revisionBody(requestValue));
      const payload: unknown = await response.json().catch(() => null);
      const parsed = acceptedStageSchema.safeParse(payload);
      if (response.status !== 202 || !parsed.success || parsed.data.proposal_id !== requestValue.proposalId || parsed.data.revision !== requestValue.expectedRevision) {
        throw new NavaApiError('Nava returned an invalid Prepare response.', 'invalid_response', response.status);
      }
      return parsed.data;
    },
    go: async requestValue => {
      const response = await request(`${proposalPath(requestValue.proposalId)}/go`, body({
        expected_revision: requestValue.expectedRevision, idempotency_key: requestValue.idempotencyKey,
      }, requestValue.signal));
      const payload: unknown = await response.json().catch(() => null);
      const parsed = acceptedGoSchema.safeParse(payload);
      if (response.status !== 202 || !parsed.success || parsed.data.proposal_id !== requestValue.proposalId) {
        throw new NavaApiError('Nava returned an invalid Go response.', 'invalid_response', response.status);
      }
      return parsed.data;
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
