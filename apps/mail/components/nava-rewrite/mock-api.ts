import { NavaApiError } from './api';
import type { NavaApi } from './api';
import { capabilitiesSchema, jsonSchema, proposalSchema, threadInputSchema, threadSnapshotSchema } from './wire';
import type { Capabilities, Change, Json, ThreadInput, ThreadSnapshot } from './wire';

function invalidPatch(): never {
  throw new NavaApiError('This fixture edit is unavailable.', 'unavailable');
}

function arrayIndex(segment: string, length: number, add: boolean): number {
  if (segment === '-' && add) return length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) return invalidPatch();
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || (add ? index > length : index >= length)) return invalidPatch();
  return index;
}

function editJson(root: Json, change: Change): void {
  if (!change.path.startsWith('/') || /~(?:[^01]|$)/.test(change.path)) return invalidPatch();
  const segments = change.path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  const top = segments[0];
  if (!top || ['id', 'thread_id', 'session_id', 'revision', 'phase', 'created_at', 'updated_at', 'stage', 'result', 'error', 'field_specs'].includes(top)) return invalidPatch();
  if ((top === 'bookings' || top === 'actions') && segments.length < 3) return invalidPatch();
  if (top === 'bookings' && ['id', 'reservation_id', 'current_state'].includes(segments[2] ?? '')) return invalidPatch();
  if (top === 'actions' && segments[2] === 'id') return invalidPatch();
  const leaf = segments.pop();
  if (leaf === undefined) return invalidPatch();
  let parent: Json = root;
  for (const segment of segments) {
    if (Array.isArray(parent)) {
      const item = parent[arrayIndex(segment, parent.length, false)];
      if (item === undefined) return invalidPatch();
      parent = item;
    } else if (parent !== null && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, segment)) {
      const item: Json | undefined = parent[segment];
      if (item === undefined) return invalidPatch();
      parent = item;
    } else return invalidPatch();
  }
  if (Array.isArray(parent)) {
    const index = arrayIndex(leaf, parent.length, change.op === 'add');
    if (change.op === 'remove') parent.splice(index, 1);
    else if (change.op === 'add') parent.splice(index, 0, structuredClone(change.value));
    else parent[index] = structuredClone(change.value);
  } else if (parent !== null && typeof parent === 'object') {
    const exists = Object.prototype.hasOwnProperty.call(parent, leaf);
    if (change.op !== 'add' && !exists) return invalidPatch();
    if (change.op === 'remove') delete parent[leaf];
    else Object.defineProperty(parent, leaf, { value: structuredClone(change.value), writable: true, enumerable: true, configurable: true });
  } else return invalidPatch();
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NavaApiError('Request was cancelled.', 'network');
}

/** Development-only fixtures. Edits are in memory; no HMS write is simulated. */
export function createMockNavaApi(fixture: {
  input: ThreadInput;
  snapshot: ThreadSnapshot;
  capabilities: Capabilities;
}): NavaApi {
  if (!import.meta.env.DEV) throw new Error('Nava mock API is available only in development.');
  const input = threadInputSchema.parse(fixture.input);
  const snapshot = threadSnapshotSchema.parse(fixture.snapshot);
  const capabilities = capabilitiesSchema.parse(fixture.capabilities);
  if (snapshot.selected_message_id !== input.selected_message_id) throw new Error('Mock selected message does not match input.');
  if (snapshot.proposals.some(proposal =>
    ['create', 'amend', 'cancel', 'filing'].includes(proposal.workflow) && (proposal.phase === 'done' || proposal.result !== null)
  )) throw new Error('Mock fixtures cannot claim a completed HMS write.');

  const unavailable = async (): Promise<never> => {
    throw new NavaApiError('This operation is unavailable in the development fixture.', 'unavailable');
  };
  return {
    upsertThread: async (candidate, options) => {
      checkAbort(options?.signal);
      const selected = threadInputSchema.parse(candidate);
      if (selected.source !== input.source || selected.mailbox_id !== input.mailbox_id ||
          selected.source_thread_id !== input.source_thread_id || selected.selected_message_id !== input.selected_message_id) {
        throw new NavaApiError('No fixture for this selected thread.', 'unavailable');
      }
      return structuredClone(snapshot);
    },
    getThread: async (id, options) => {
      checkAbort(options?.signal);
      if (id !== snapshot.id) throw new NavaApiError('No fixture for this thread.', 'unavailable');
      return structuredClone(snapshot);
    },
    getCapabilities: async options => { checkAbort(options?.signal); return structuredClone(capabilities); },
    events: async function* () { throw new NavaApiError('No fixture event stream.', 'unavailable'); },
    patchProposal: async ({ proposalId, expectedRevision, changes, signal }) => {
      checkAbort(signal);
      const index = snapshot.proposals.findIndex(proposal => proposal.id === proposalId);
      const current = snapshot.proposals[index];
      if (!current) return invalidPatch();
      if (current.revision !== expectedRevision) throw new NavaApiError('Proposal revision changed.', 'conflict', 409);
      if (current.phase !== 'ready' || current.stage !== null || !changes.length) return invalidPatch();
      const updated = jsonSchema.parse(current);
      for (const change of changes) {
        if (!current.field_specs.some(field => field.path === change.path && field.editable)) return invalidPatch();
        editJson(updated, change);
      }
      const parsed = proposalSchema.parse(updated);
      parsed.revision = current.revision + 1;
      parsed.updated_at = new Date().toISOString();
      parsed.field_specs = parsed.field_specs.map(field =>
        changes.some(change => change.path === field.path) ? { ...field, provenance: 'staff' } : field
      );
      snapshot.proposals[index] = parsed;
      return structuredClone(parsed);
    },
    undo: unavailable,
    redo: unavailable,
    quote: unavailable,
    quoteArtifacts: unavailable,
    stage: unavailable,
    lookupStay: unavailable,
    selectStay: unavailable,
    go: unavailable,
    reconcile: unavailable,
    sendContext: unavailable,
    getArtifact: unavailable,
  };
}
