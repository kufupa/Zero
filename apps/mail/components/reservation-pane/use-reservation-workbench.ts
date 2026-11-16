'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import { ReservationWorkflowStaleRevisionError, type ReservationFieldOverride, type ReservationPaneSnapshot, type ReservationSourceContext, type ReservationWorkflowClient, type ReservationWorkflowKind, type PropertyConfiguration } from '@/lib/reservation-workflow/types';
import { effectiveAt, guestProfileDefaultsToNew, valueAt, record, requestPath, snapshotMatchesSource, staffEnteredAt, text, type WorkbenchCommands } from '@/lib/reservation-workflow/views';

type Pending = { path: string; value: unknown; state: ReservationFieldOverride['state']; token: number;
  generation: string | null; rows: { path: string; identity: string }[] };

function rowIdentity(value: unknown): string {
  const row = record(value);
  if (typeof row.id === 'string') return `id:${row.id}`;
  if (typeof row.hintId === 'string') return `hint:${row.hintId}`;
  if (row.target && typeof row.target === 'object') return `target:${JSON.stringify(row.target)}`;
  return `value:${JSON.stringify(value)}`;
}

function pendingMatches(snapshot: ReservationPaneSnapshot | null, edit: Pending): boolean {
  if (!snapshot || snapshot.session.draft.generationId !== edit.generation) return false;
  const owner = edit.path.match(/^\/proposal\/content\/(?:requests|services|documents)\/[^/]+/);
  if (owner && !valueAt(snapshot, owner[0])) return false;
  return edit.rows.every(row => rowIdentity(effectiveAt(snapshot, row.path)) === row.identity);
}

function captureRows(snapshot: ReservationPaneSnapshot | null, path: string): Pending['rows'] {
  if (!snapshot) return [];
  const rows: Pending['rows'] = [], parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    if (!/^\d+$/.test(parts[index]!)) continue;
    const rowPath = parts.slice(0, index + 1).join('/');
    rows.push({ path: rowPath, identity: rowIdentity(effectiveAt(snapshot, rowPath)) });
  }
  return rows;
}
type Buffer = {
  sourceKey: string;
  owner: symbol;
  snapshot: ReservationPaneSnapshot | null;
  sourceReviewBase: ReservationPaneSnapshot | null;
  pending: Map<string, Pending>;
  conflict: boolean;
  error: string | null;
  pendingMutationHeld: boolean;
  actionsPending: number;
  token: number;
  queue: Promise<void>;
  listeners: Set<() => void>;
};
const buffers = new Map<string, Buffer>();
const guestCreatesInFlight = new Set<string>();
const sourceKey = (source: ReservationSourceContext) => JSON.stringify([source.mailboxId, source.propertyId, source.propertySelectionEpoch ?? 0, source.selectionEpoch, source.messageId, source.sourceHash]);
const bufferKey = (source: ReservationSourceContext) => JSON.stringify([source.mailboxId, source.propertyId, source.threadId, source.messageId]);
const guestAttemptKey = (source: ReservationSourceContext, requestId: string, allocationId: string) =>
  `nava:guest-profile:${source.mailboxId}:${source.propertyId}:${source.messageId}:${source.sourceHash}:${requestId}:${allocationId}`;
// HRCEN attempts saved before the key carried mailbox and property stay readable until they are cleared.
const legacyGuestAttemptKey = (source: ReservationSourceContext, requestId: string, allocationId: string) =>
  source.propertyId === 'HRCEN' ? `nava:guest-profile:${source.messageId}:${source.sourceHash}:${requestId}:${allocationId}` : null;
function readGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string): string | null {
  try {
    const legacyKey = legacyGuestAttemptKey(source, requestId, allocationId);
    return window.localStorage.getItem(guestAttemptKey(source, requestId, allocationId)) ?? (legacyKey ? window.localStorage.getItem(legacyKey) : null);
  } catch { return null; }
}
function saveGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string, operationId: string): boolean {
  try {
    const key = guestAttemptKey(source, requestId, allocationId);
    window.localStorage.setItem(key, operationId);
    return window.localStorage.getItem(key) === operationId;
  } catch { return false; }
}
function clearGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string) {
  try {
    window.localStorage.removeItem(guestAttemptKey(source, requestId, allocationId));
    const legacyKey = legacyGuestAttemptKey(source, requestId, allocationId);
    if (legacyKey) window.localStorage.removeItem(legacyKey);
  } catch { /* A terminal result still remains in the draft. */ }
}

function notify(buffer: Buffer) { buffer.listeners.forEach(listener => listener()); }

// A source rebind may succeed even if its follow-up read fails. Only carry
// pending edits forward after an explicit review and matching row identities.
function retainReviewedSourceEdits(buffer: Buffer, next: ReservationPaneSnapshot, bound: ReservationSourceContext) {
  const base = buffer.sourceReviewBase;
  if (!base || next.session.sourceChanged || !snapshotMatchesSource(next, bound)) return;
  for (const pending of buffer.pending.values()) {
    if (pendingMatches(base, pending) && pendingMatches(next, { ...pending, generation: next.session.draft.generationId })) {
      pending.generation = next.session.draft.generationId;
    }
  }
  buffer.sourceReviewBase = null;
  if (buffer.pending.size) {
    buffer.conflict = true;
    buffer.error = 'Your pending edits are retained. Apply them after reviewing the updated evidence.';
  }
}

function releasePendingMutation(buffer: Buffer) {
  if (buffer.pendingMutationHeld && buffer.pending.size === 0) {
    buffer.pendingMutationHeld = false;
    endMutation();
  }
}

function enqueue(buffer: Buffer, action: () => Promise<void>): Promise<void> {
  const next = buffer.queue.then(action, action);
  buffer.queue = next.catch(() => {});
  return next;
}

/** Pending edits are visible immediately, but never become a command's server cursor. */
function displaySnapshot(snapshot: ReservationPaneSnapshot | null, pending: Map<string, Pending>): ReservationPaneSnapshot | null {
  if (!snapshot || !pending.size) return snapshot;
  const fieldOverrides = { ...snapshot.session.draft.fieldOverrides };
  for (const edit of pending.values()) {
    if (!pendingMatches(snapshot, edit)) continue;
    if (edit.state === 'set' && edit.path.endsWith('/occupancy')) {
      for (const path of Object.keys(fieldOverrides)) {
        if (path === `${edit.path}/childCount` || path.startsWith(`${edit.path}/childCount/`) ||
            path === `${edit.path}/childAges` || path.startsWith(`${edit.path}/childAges/`)) delete fieldOverrides[path];
      }
    }
    fieldOverrides[edit.path] = { state: edit.state, ...(edit.state === 'set' ? { value: edit.value } : {}), updatedAt: new Date().toISOString() };
    const quoteRate = edit.path.match(/^(\/proposal\/content\/requests\/([^/]+)\/body\/groups\/\d+)\/ratePlan$/);
    const mealPath = quoteRate && `${quoteRate[1]}/mealPlan`;
    if (mealPath && snapshot.requests.some(request => request.kind === 'quote' && request.id === decodeURIComponent(quoteRate![2]!)) && !pending.has(mealPath)) {
      fieldOverrides[mealPath] = { state: 'unknown', updatedAt: new Date().toISOString() };
    }
    // Match the server's atomic identity invalidation while the edit is pending.
    const guest = edit.path.match(/^(.*\/guest)\/(?:firstName|lastName|email|mobile)$/);
    const party = edit.path.match(/^(.*\/(?:bookingAgency|organization|arAccount))(?:\/name)?$/);
    const quoteParty = edit.path.match(/^\/proposal\/content\/requests\/([^/]+)\/body\/parties\/(?:organization|bookingAgency)(?:\/name)?$/);
    const isQuoteParty = Boolean(quoteParty && snapshot.requests.some(request => request.kind === 'quote' && request.id === decodeURIComponent(quoteParty[1]!)));
    if (isQuoteParty && !edit.path.endsWith('/name')) {
      for (const path of Object.keys(fieldOverrides)) if (path.startsWith(`${edit.path}/`)) delete fieldOverrides[path];
    }
    const amendParty = edit.path.match(/^(\/proposal\/content\/requests\/[^/]+\/body\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/value)(?:\/name)?$/);
    const amendField = amendParty && valueAt(snapshot, `${amendParty[1]!.slice(0, -'/value'.length)}/field`);
    const target = edit.path.match(/^(.*\/targets\/include\/[^/]+)\/(?:confirmation|guestName|bookedArrival|bookedDeparture)$/);
    const service = edit.path.match(/^(\/proposal\/content\/services\/[^/]+)\/code$/);
    const selection = guest ? `${guest[1]}/nativeSelectionRef` : party ? `${party[1]}/nativeSelectionRef` :
      amendParty && ['bookingAgency', 'organization', 'arAccount'].includes(text(amendField)) ? `${amendParty[1]}/nativeSelectionRef` :
      target ? `${target[1]}/suggestedRef` : service ? `${service[1]}/itemCandidateRef` : null;
    const selections = new Set(selection ? [selection] : []);
    if (target) {
      const root = target[1]!.slice(0, target[1]!.lastIndexOf('/'));
      const rows = valueAt(snapshot, root), key = decodeURIComponent(target[1]!.split('/').at(-1)!);
      const request = snapshot.requests.find(row => edit.path.startsWith(`${requestPath(row.id)}/`));
      if (request?.kind === 'filing' && Array.isArray(rows)) {
        const index = /^\d+$/.test(key) ? Number(key) : rows.findIndex(row => record(row).id === key);
        const id = record(rows[index]).id;
        if (typeof id === 'string') {
          selections.add(`${root}/${index}/suggestedRef`);
          selections.add(`${root}/${encodeURIComponent(id)}/suggestedRef`);
        }
      }
    }
    const partyName = (value: unknown) => text(value && typeof value === 'object' && !Array.isArray(value)
      ? record(value).name : value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const unchangedPartyName = Boolean(party || amendParty && ['bookingAgency', 'organization', 'arAccount'].includes(text(amendField))) &&
      edit.state === 'set' && Boolean(partyName(valueAt(snapshot, edit.path))) &&
      partyName(valueAt(snapshot, edit.path)) === partyName(edit.value);
    for (const path of selections) if (!pending.has(path)) {
      if (unchangedPartyName) {
        const override = snapshot.session.draft.fieldOverrides[path];
        const selected = valueAt(snapshot, path) ?? (override && override.state !== 'inherit' ? null
          : valueAt(snapshot, `${path.slice(0, -'/nativeSelectionRef'.length)}/suggestedRef`));
        if (typeof selected === 'string') fieldOverrides[path] = { state: 'set', value: selected, updatedAt: new Date().toISOString() };
      } else fieldOverrides[path] = { state: isQuoteParty ? 'none' : 'unknown', updatedAt: new Date().toISOString() };
    }
  }
  return { ...snapshot, session: { ...snapshot.session, draft: { ...snapshot.session.draft, fieldOverrides } } };
}

export function useReservationWorkbench({ source, activeProperty, configuration, snapshot, client, onSnapshot, preview = false }: {
  source: ReservationSourceContext; activeProperty: PropertyConfiguration['propertyCode'] | undefined; configuration: PropertyConfiguration | null; snapshot: ReservationPaneSnapshot | null; client: ReservationWorkflowClient;
  onSnapshot(snapshot: ReservationPaneSnapshot): void; preview?: boolean;
}) {
  const key = sourceKey(source);
  const draftKey = bufferKey(source);
  const scoped = (!activeProperty || activeProperty === source.propertyId) && (!configuration ||
    configuration.propertyCode === source.propertyId && configuration.transportId === source.mailboxId);
  const capabilities = scoped ? configuration?.capabilities : undefined;
  const canPrepare = (status: string | undefined) => status === 'prepare-only' || status === 'lab' || status === 'staff-enabled';
  const canPrepareCreate = canPrepare(capabilities?.create?.status);
  const canPrepareQuote = canPrepare(capabilities?.quote?.status);
  const canPrepareAttach = canPrepare(capabilities?.attach?.status);
  const canRead = canPrepare(capabilities?.reads?.status);
  const canPrepareAddons = canPrepare(capabilities?.addons?.status);
  const canSaveAddons = capabilities?.addons?.status === 'lab' || capabilities?.addons?.status === 'staff-enabled';
  const canCreateGuest = capabilities?.guest_profile_create?.status === 'lab' || capabilities?.guest_profile_create?.status === 'staff-enabled';
  const safeSnapshot = scoped && snapshotMatchesSource(snapshot, source) ? snapshot : null;
  const owner = useRef(Symbol('reservation-workbench')).current;
  if (!buffers.has(draftKey)) buffers.set(draftKey, { sourceKey: key, owner, snapshot: safeSnapshot, sourceReviewBase: null, pending: new Map(), conflict: false,
    error: null, pendingMutationHeld: false, actionsPending: 0, token: 0, queue: Promise.resolve(), listeners: new Set() });
  const entry = buffers.get(draftKey)!;
  if (entry.sourceKey !== key || entry.owner !== owner) {
    entry.sourceKey = key;
    entry.owner = owner;
    entry.snapshot = safeSnapshot;
    entry.sourceReviewBase = null;
  }
  if (safeSnapshot && (!entry.snapshot || safeSnapshot.session.seq >= entry.snapshot.session.seq)) {
    retainReviewedSourceEdits(entry, safeSnapshot, source);
    entry.snapshot = safeSnapshot;
    if ([...entry.pending.values()].some(pending => !pendingMatches(safeSnapshot, pending))) {
      entry.conflict = true;
      entry.error ??= 'Your pending edits are retained. Review the current draft before applying them.';
    }
  }
  const active = useRef({ key, epoch: source.selectionEpoch });
  active.current = { key, epoch: source.selectionEpoch };
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, rerender] = useState(0);
  const [uncommitted, setUncommitted] = useState<Set<string>>(new Set());
  const liveInputs = useRef({ key, uncommitted });
  liveInputs.current = { key, uncommitted };
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeAction = useRef(activeId);
  activeAction.current = activeId;
  useEffect(() => { setError(null); setUncommitted(new Set()); setActiveId(null); }, [key]);

  const apply = useCallback((next: ReservationPaneSnapshot, bound: ReservationSourceContext, buffer: Buffer) => {
    if (buffer.owner !== owner || buffer.sourceKey !== sourceKey(bound) || !snapshotMatchesSource(next, bound)) return;
    retainReviewedSourceEdits(buffer, next, bound);
    buffer.snapshot = next;
    notify(buffer);
    if (mounted.current && active.current.key === sourceKey(bound) && active.current.epoch === bound.selectionEpoch) onSnapshot(next);
  }, [onSnapshot, owner]);
  const flush = async (bound: ReservationSourceContext, buffer: Buffer, captured?: Pending[]) => {
    if (buffer.conflict) throw new Error('This draft changed elsewhere. Apply your pending edits or discard them before continuing.');
    let remaining = captured ?? Array.from(buffer.pending.values());
    try {
      while (remaining.length) {
        for (const pending of remaining) {
          if (buffer.pending.get(pending.path)?.token !== pending.token) continue;
          if (buffer.owner !== owner || buffer.sourceKey !== sourceKey(bound)) throw new Error('The email changed. Review its updated evidence before applying your edits.');
          if (!buffer.snapshot) throw new Error('The email draft is still opening.');
          if (buffer.snapshot.session.sourceChanged && /^\/proposal\/content\/services\/[^/]+\/targets$/.test(pending.path))
            throw new Error('Review the updated email and attachments before linking this Add-On.');
          if (!pendingMatches(buffer.snapshot, pending)) throw new Error('The room or action changed elsewhere. Discard this pending edit and enter it on the current row.');
          const requestId = buffer.snapshot.requests.find(request => pending.path.startsWith(`${requestPath(request.id)}/`))?.id
            ?? buffer.snapshot.requests[0]?.id;
          if (!requestId) throw new Error('Add an action before editing its fields.');
          const before = buffer.snapshot;
          const next = await client.edit({ source: bound, snapshot: before, requestId, fieldPath: pending.path, state: pending.state, value: pending.value });
          if (buffer.owner !== owner || buffer.sourceKey !== sourceKey(bound)) {
            if (buffer.pending.get(pending.path)?.token === pending.token) {
              buffer.conflict = true;
              buffer.error ??= 'Your pending edits are retained. Review the current draft before applying them.';
              notify(buffer);
            }
            return;
          }
          // Acknowledging our own write may change an idless change row. Advance
          // retained input bindings only when the returned cursor and row values
          // are exactly the expected result; external edits remain fenced.
          if (next.session.seq === before.session.seq + 1 && next.session.draft.generationId === before.session.draft.generationId) {
            const expected = displaySnapshot(before, new Map([[pending.path, pending]]));
            for (const queued of buffer.pending.values()) {
              if (!pendingMatches(before, queued)) continue;
              const rows = captureRows(expected, queued.path);
              if (rows.every(row => rowIdentity(effectiveAt(next, row.path)) === row.identity)) queued.rows = rows;
            }
          }
          apply(next, bound, buffer);
          if (buffer.pending.get(pending.path)?.token === pending.token) buffer.pending.delete(pending.path);
          releasePendingMutation(buffer);
          notify(buffer);
        }
        // A cleanup only owns the values captured for its source selection.
        remaining = captured || !mounted.current || active.current.key !== sourceKey(bound) || active.current.epoch !== bound.selectionEpoch
          ? [] : Array.from(buffer.pending.values());
      }
      if (buffer.owner === owner && buffer.sourceKey === sourceKey(bound)) buffer.error = null;
    } catch (failure) {
      const currentBinding = buffer.owner === owner && buffer.sourceKey === sourceKey(bound);
      if (currentBinding || remaining.some(pending => buffer.pending.get(pending.path)?.token === pending.token)) {
        if (failure instanceof ReservationWorkflowStaleRevisionError) apply(failure.snapshot, bound, buffer);
        buffer.conflict = true;
        const message = failure instanceof Error ? failure.message : 'Your pending edits could not be saved.';
        if (currentBinding) buffer.error = message;
        else buffer.error ??= message;
        notify(buffer);
      }
      throw failure;
    }
  };
  const lifecycle = useRef({ source, buffer: entry, flush });
  lifecycle.current = { source, buffer: entry, flush };
  useEffect(() => {
    const { source: bound, buffer, flush: flushCaptured } = lifecycle.current;
    const listener = () => { if (mounted.current) rerender(value => value + 1); };
    mounted.current = true;
    buffer.listeners.add(listener);
    return () => {
      mounted.current = false;
      buffer.listeners.delete(listener);
      const captured = Array.from(buffer.pending.values());
      if (captured.length) void enqueue(buffer, () => flushCaptured(bound, buffer, captured)).catch(() => {});
    };
  }, [key, source.selectionEpoch, client]);
  const run = (action: (context: { source: ReservationSourceContext; snapshot: ReservationPaneSnapshot }) => Promise<ReservationPaneSnapshot | void>, write = false, skipFlush = false): Promise<void> => {
    const bound = source;
    const buffer = entry;
    const execute = async () => {
      if (buffer.owner !== owner || !mounted.current || active.current.key !== sourceKey(bound) || active.current.epoch !== bound.selectionEpoch) return;
      setBusy(true); setError(null);
      if (write) beginMutation();
      try {
        if (!skipFlush) await flush(bound, buffer);
        if (buffer.owner !== owner || buffer.sourceKey !== sourceKey(bound) || !snapshotMatchesSource(buffer.snapshot, bound)) throw new Error('The email draft is still opening.');
        if (!mounted.current || active.current.key !== sourceKey(bound) || active.current.epoch !== bound.selectionEpoch) return;
        const next = await action({ source: bound, snapshot: buffer.snapshot });
        if (next) { apply(next, bound, buffer); if (next.serviceNotice) throw new Error(next.serviceNotice); }
      } catch (failure) {
        const currentBinding = buffer.owner === owner && buffer.sourceKey === sourceKey(bound);
        if (currentBinding && failure instanceof ReservationWorkflowStaleRevisionError) {
          buffer.conflict = true; buffer.error = failure.message; apply(failure.snapshot, bound, buffer);
        }
        if (currentBinding && mounted.current && active.current.key === key) setError(failure instanceof Error ? failure.message : 'Infor could not complete this step. Your draft is retained.');
        throw failure;
      } finally {
        if (write) endMutation();
        if (mounted.current && active.current.key === key) { setBusy(false); rerender(value => value + 1); }
      }
    };
    buffer.actionsPending++;
    notify(buffer);
    return enqueue(buffer, execute).finally(() => { buffer.actionsPending--; notify(buffer); });
  };
  const stageEdit = (path: string, value: unknown, state: ReservationFieldOverride['state'] = 'set', options?: { notify?: boolean }) => {
    if (!entry.pendingMutationHeld) { entry.pendingMutationHeld = true; beginMutation(); }
    const previous = entry.pending.get(path);
    entry.pending.set(path, { path, value, state, token: ++entry.token, generation: previous?.generation ?? entry.snapshot?.session.draft.generationId ?? null,
      rows: previous?.rows ?? captureRows(entry.snapshot, path) });
    if (options?.notify !== false) notify(entry);
  };
  const current = displaySnapshot(entry.snapshot ?? safeSnapshot, entry.pending);
  const pendingForCurrent = Array.from(entry.pending.values()).filter(edit => pendingMatches(entry.snapshot, edit));
  const unresolvedPending = Array.from(entry.pending.values()).filter(edit => !pendingMatches(entry.snapshot, edit)).map(edit => {
    const parts = edit.path.split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } });
    const last = parts.at(-1) ?? 'Field';
    const label = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
    const room = parts.indexOf('allocations');
    const roomLabel = room >= 0 && /^\d+$/.test(parts[room + 1] ?? '') ? ` · previous Room ${Number(parts[room + 1]) + 1}` : '';
    const value = edit.state === 'set' ? (typeof edit.value === 'string' ? edit.value : JSON.stringify(edit.value) ?? '')
      : ({ unknown: 'Marked unknown', none: 'None', clear: 'Clear value', inherit: 'Use source' } as Record<string, string>)[edit.state] ?? edit.state;
    return { path: edit.path, label: `${label}${roomLabel}`, value };
  });
  const request = current?.requests.find(row => row.id === activeId) ?? current?.requests[0];
  const requireRequest = () => { if (!request) throw new Error('Choose an action first.'); return request.id; };
  const workflow = request?.kind === 'filing' ? 'attach' : request?.kind === 'services' ? 'addons' : request?.kind;
  const workflowStatus = workflow && workflow !== 'other' ? capabilities?.[workflow]?.status : undefined;
  const canPrepareRequest = canPrepare(workflowStatus);
  const canReadRequest = canRead && canPrepareRequest;
  const canExecuteRequest = request?.kind === 'quote' ? canPrepareRequest : workflowStatus === 'lab' || workflowStatus === 'staff-enabled';
  const unavailable = () => Promise.reject(new Error('This action is not available for this hotel yet.'));
  // The native verifier is deployed independently; expose its action only when the client supports it.
  const verifyNativeLead = (client as ReservationWorkflowClient & {
    verifyNativeLead?: ReservationWorkflowClient['selectNative'];
  }).verifyNativeLead;
  const commands: WorkbenchCommands = {
    stageEdit,
    setUncommitted(id, dirty) {
      const previous = liveInputs.current.key === key ? liveInputs.current.uncommitted : new Set<string>();
      if (previous.has(id) === dirty) return;
      const next = new Set(previous); if (dirty) next.add(id); else next.delete(id);
      liveInputs.current = { key, uncommitted: next }; setUncommitted(next);
    },
    edit(path, value, state = 'set') { stageEdit(path, value, state); return run(async () => {}); },
    changeRows(change) {
      const selectedAction = activeAction.current;
      return run(async context => {
      const next = await client.changeRows({ ...context, ...change });
      const createdId = record(next.workflowReply).createdId;
      if (mounted.current && active.current.key === key && active.current.epoch === source.selectionEpoch &&
          activeAction.current === selectedAction && typeof createdId === 'string' &&
          next.requests.some(row => row.id === createdId)) setActiveId(createdId);
      return next;
      });
    },
    selectNative(fieldPath, observationRef) { return run(context => client.selectNative({ ...context, requestId: requireRequest(), fieldPath, observationRef })); },
    ...(verifyNativeLead ? { verifyNativeLead(fieldPath: string, observationRef: string) {
      if (!canReadRequest) return unavailable();
      return run(context => verifyNativeLead.call(client, { ...context, requestId: requireRequest(), fieldPath, observationRef }));
    } } : {}),
    lookup() { if (!canReadRequest) return unavailable(); return run(context => client.lookup({ ...context, requestId: requireRequest() })); },
    lookupChoices(nativeFieldPath) { if (!canReadRequest) return unavailable(); return run(context => client.lookup({ ...context, requestId: requireRequest(), nativeFieldPath })); },
    async guestProfileOptions(allocationId, field) {
      if (!canReadRequest) throw new Error('Guest profile choices are not available for this hotel yet.');
      const requestId = requireRequest();
      let reply: Record<string, unknown> = {};
      await run(async context => {
        const next = await client.guestProfileOptions({ ...context, requestId, allocationId, field });
        reply = record(next.workflowReply);
        return next;
      });
      return reply;
    },
    createGuestProfile(allocationId, confirmDuplicateName = false) {
      if (preview) return Promise.reject(new Error('Preview only. Profile creation is disabled.'));
      if (!canCreateGuest) return Promise.reject(new Error('Guest profile creation is not available for this hotel yet.'));
      if (liveInputs.current.key === key && [...liveInputs.current.uncommitted].some(hold =>
        !hold.startsWith('service-candidate:/proposal/content/services/'))) return Promise.reject(new Error('Apply changed fields before creating a profile.'));
      const requestId = requireRequest();
      const inFlightKey = guestAttemptKey(source, requestId, allocationId);
      if (guestCreatesInFlight.has(inFlightKey)) return Promise.reject(new Error('Profile creation is already in progress.'));
      guestCreatesInFlight.add(inFlightKey);
      return run(async context => {
        const previousAttempt = readGuestAttempt(context.source, requestId, allocationId);
        const previousDispatch = context.snapshot.session.workflowDispatches?.find(row => row.endpoint === 'createGuestProfile' &&
          row.requestId === requestId && row.allocationId === allocationId);
        const previousResult = previousAttempt ? context.snapshot.operationResults.find(row => row.id === previousAttempt && row.workflow === 'guest_profile') : undefined;
        if (previousDispatch && previousDispatch.status !== 'succeeded' && previousDispatch.status !== 'failed') throw new Error('Check the previous profile creation outcome before trying again.');
        if (previousDispatch?.status === 'succeeded' || previousDispatch?.status === 'failed' || previousResult?.status === 'succeeded' || previousResult?.status === 'failed') clearGuestAttempt(context.source, requestId, allocationId);
        else if (previousAttempt) throw new Error('Check the previous profile creation outcome before trying again.');
        let current = context.snapshot;
        const root = `${requestPath(requestId)}/body`;
        const body = record(effectiveAt(current, root));
        const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
        const index = allocations.findIndex(row => row.id === allocationId);
        if (index < 0) throw new Error('This room changed. Review its guest before creating a profile.');
        const guestPath = `${root}/allocations/${index}/guest`;
        if (valueAt(current, `${guestPath}/profileIntent`) !== 'requested_new') {
          if (!guestProfileDefaultsToNew(current, requestId, allocationId, guestPath)) throw new Error('Choose New profile first.');
          // The email search found no profile, so this click is the staff's choice to create one.
          current = await client.edit({ source: context.source, snapshot: current, requestId, fieldPath: `${guestPath}/profileIntent`, state: 'set', value: 'requested_new' });
          apply(current, context.source, entry);
          if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return current;
        }
        // The create click is the staff's acceptance of the profile values shown. A value staff flagged stays held.
        for (const field of ['firstName', 'lastName', 'mobile', 'email', 'titleCode', 'phoneNumber', 'phoneTypeCode', 'emailTypeCode']) {
          const path = `${guestPath}/${field}`;
          const value = effectiveAt(current, path);
          const entered = staffEnteredAt(current, path), review = current.session.draft.staffReviews[path]?.status;
          if (typeof value !== 'string' || !value.trim() || review === 'accepted' || (!entered &&
              (review === 'flagged' || current.session.draft.fieldReviewRequirements[path]?.required === false))) continue;
          current = await client.review({ source: context.source, snapshot: current, fieldPath: path, decision: 'accepted',
            note: entered ? 'Entered by staff' : 'Confirmed by staff when creating the profile' });
          apply(current, context.source, entry);
          if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return current;
        }
        const prepared = await client.prepareGuestProfile({ source: context.source, snapshot: current, requestId, allocationId, confirmDuplicateName });
        apply(prepared, context.source, entry);
        const reply = record(prepared.workflowReply);
        if (prepared.serviceNotice || reply.status !== 'prepared' || typeof reply.prepareRef !== 'string') return prepared;
        if (typeof reply.preparedRef !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reply.preparedRef) ||
            reply.expectedRevision !== prepared.session.revision || reply.generationId !== prepared.session.draft.generationId) {
          throw new Error('Check the guest profile again before creating it.');
        }
        if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return prepared;
        if ([...entry.pending.keys()].some(path => path === guestPath || path.startsWith(`${guestPath}/`))) {
          throw new Error('Guest details changed. Review them before creating the profile.');
        }
        const idempotencyKey = crypto.randomUUID();
        if (!saveGuestAttempt(context.source, requestId, allocationId, idempotencyKey)) {
          throw new Error('This device cannot retain the profile attempt for recovery. Profile creation is unavailable.');
        }
        let result: ReservationPaneSnapshot;
        try {
          result = await client.createGuestProfile({ source: context.source, snapshot: prepared, requestId, allocationId,
            confirmDuplicateName, prepareRef: reply.prepareRef, preparedRef: reply.preparedRef, idempotencyKey });
        } catch (error) {
          // A stale response with a fresh snapshot and no claim proves this attempt was rejected before dispatch.
          if (error instanceof ReservationWorkflowStaleRevisionError &&
              !error.snapshot.operationResults.some(row => row.id === idempotencyKey)) {
            clearGuestAttempt(context.source, requestId, allocationId);
          }
          throw error;
        }
        const response = record(result.workflowReply);
        const operationId = response.status === 'queued' && typeof response.operationId === 'string' && response.operationId === response.grantId
          ? response.operationId : idempotencyKey;
        if (operationId !== idempotencyKey) saveGuestAttempt(context.source, requestId, allocationId, operationId);
        const operation = result.operationResults.find(row => row.id === operationId);
        // These replies are returned before the server claims or dispatches this attempt.
        // A failed refresh or any uncertain reply must retain the recovery hold.
        const rejectedBeforeClaim = ['needs_prepare', 'stale_revision', 'wrong_property', 'not_found', 'invalid_source', 'invalid_value']
          .includes(text(response.status)) || (response.status === 'refused' &&
            ['authenticated_staff_session_required', 'guest_profile_write_flag_off'].includes(text(response.issue)));
        if (operation?.status === 'succeeded' || operation?.status === 'failed' ||
            (rejectedBeforeClaim && !result.loadError && !operation)) clearGuestAttempt(context.source, requestId, allocationId);
        return result;
      }, true).finally(() => guestCreatesInFlight.delete(inFlightKey));
    },
    guestProfilePending(allocationId) {
      if (!request) return null;
      const dispatch = current?.session.workflowDispatches?.find(row => row.endpoint === 'createGuestProfile' &&
        row.requestId === request.id && row.allocationId === allocationId);
      if (dispatch) return dispatch.status === 'succeeded' || dispatch.status === 'failed' ? null : dispatch.operationId;
      const id = readGuestAttempt(source, request.id, allocationId);
      const operation = id ? current?.operationResults.find(row => row.id === id && row.workflow === 'guest_profile') : undefined;
      if (operation?.status === 'succeeded' || operation?.status === 'failed') return null;
      return id;
    },
    checkGuestProfile(allocationId) {
      const requestId = requireRequest();
      const operationId = current?.session.workflowDispatches?.find(row => row.endpoint === 'createGuestProfile' &&
        row.requestId === requestId && row.allocationId === allocationId)?.operationId ?? readGuestAttempt(source, requestId, allocationId);
      if (!operationId) return Promise.reject(new Error('No pending profile attempt was found on this device.'));
      return run(async context => {
        const latest = await client.get(context);
        apply(latest, context.source, entry);
        if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return latest;
        const dispatch = latest.session.workflowDispatches?.find(row => row.endpoint === 'createGuestProfile' &&
          row.requestId === requestId && row.allocationId === allocationId);
        if (dispatch && dispatch.status !== 'succeeded' && dispatch.status !== 'failed' && dispatch.status !== 'needs_reconcile')
          throw new Error('Infor is still processing this profile. Check again shortly.');
        const currentOperationId = dispatch?.operationId ?? operationId;
        const operation = latest.operationResults.find(row => row.id === currentOperationId && row.workflow === 'guest_profile' &&
          row.requestId === requestId && row.allocationId === allocationId);
        if (!operation) throw new Error('Infor has not recorded the profile outcome yet. Check again later or contact support.');
        if (operation.status === 'succeeded' || operation.status === 'failed') {
          clearGuestAttempt(context.source, requestId, allocationId); return latest;
        }
        const result = await client.reconcile({ source: context.source, snapshot: latest, operationId: currentOperationId });
        const checked = result.operationResults.find(row => row.id === currentOperationId);
        if (checked?.status === 'succeeded' || checked?.status === 'failed') clearGuestAttempt(context.source, requestId, allocationId);
        return result;
      });
    },
    prepare(allocationId) { if (!canPrepareRequest || !canRead) return unavailable(); if (liveInputs.current.key === key && liveInputs.current.uncommitted.size) return Promise.reject(new Error('Apply changed fields before checking Infor.')); return run(context => client.prepare({ ...context, requestId: requireRequest(), allocationId })); },
    review(scope, ids) { return run(context => client.reviewScope({ ...context, requestId: requireRequest(), scope, ids })); },
    execute(allocationId) { if (!canExecuteRequest) return unavailable(); if (liveInputs.current.key === key && liveInputs.current.uncommitted.size) return Promise.reject(new Error('Apply changed fields before saving.')); if (preview) return Promise.reject(new Error('Preview only. Native Save is disabled.')); return run(context => client.execute({ ...context, requestId: requireRequest(), allocationId, idempotencyKey: crypto.randomUUID() }), true); },
    reconcile(operationId) { return run(context => {
      const operation = context.snapshot.operationResults.find(row => row.id === operationId);
      return operation?.workflow === 'services' ? client.reconcileServices({ ...context, operationId }) : client.reconcile({ ...context, operationId });
    }, false, entry.snapshot?.session.sourceChanged === true); },
    acceptServiceReview(fieldPath, note, expected) { return run(context => {
      if (expected && (context.snapshot.session.draft.generationId !== expected.generationId ||
          JSON.stringify({ value: effectiveAt(context.snapshot, expected.path) }) !== JSON.stringify({ value: expected.value }))) {
        throw new Error('This value changed while it was being reviewed. Check it again.');
      }
      return client.review({ ...context, fieldPath, decision: 'accepted', note });
    }); },
    acceptFinancialReview(fieldPath, note, observationRef) { return run(async context => {
      const next = await client.edit({ ...context, requestId: requireRequest(), fieldPath, state: 'set', value: observationRef });
      apply(next, context.source, entry);
      if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return next;
      const reviewed = await client.review({ source: context.source, snapshot: next, fieldPath, decision: 'accepted', note });
      apply(reviewed, context.source, entry);
      if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return reviewed;
      const requestId = requireRequest();
      const observation = reviewed.session.draft.observations.find(row => row.ref === observationRef &&
        row.generationId === reviewed.session.draft.generationId && row.criteria.requestId === requestId);
      const target = observation?.criteria.hintId;
      if (typeof target !== 'string' || !target) throw new Error('The reviewed stay changed. Check its details again.');
      const prepared = await client.prepare({ source: context.source, snapshot: reviewed, requestId, allocationId: target });
      return { ...prepared, workflowReply: context.snapshot.workflowReply };
    }); },
    configureFiling(attachmentId, target, kind) { return run(context => client.configureFiling({ ...context, requestId: requireRequest(), attachmentId, ...(typeof target === 'string' ? { confirmation: target } : target), kind })); },
    lookupServices(target, serviceId) { if (!canPrepareAddons || !canRead) return unavailable(); return run(context => client.lookupServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId })); },
    previewServices(target, serviceId) { if (!canPrepareAddons || !canRead) return unavailable(); if (liveInputs.current.key === key && liveInputs.current.uncommitted.size) return Promise.reject(new Error('Apply changed fields before checking Infor.')); return run(context => client.previewServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId })); },
    executeServices(target, serviceId, reviewedPrepareRef) { if (!canSaveAddons) return unavailable(); if (liveInputs.current.key === key && liveInputs.current.uncommitted.size) return Promise.reject(new Error('Apply changed fields before saving.')); if (preview) return Promise.reject(new Error('Preview only. Native Save is disabled.')); return run(context => client.executeServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId, reviewedPrepareRef, idempotencyKey: crypto.randomUUID() }), true); },
  };
  const initialLookup = useRef(new Set<string>());
  const prefill = current?.session.draft.prefill;
  const arrivalChecksPending = ['queued', 'running'].includes(prefill?.status ?? '') ||
    (prefill?.status === 'failed' && prefill.phase === 'native_checks');
  useEffect(() => {
    if (!current || current.session.sourceChanged || arrivalChecksPending || !request || request.kind !== 'create' || !canPrepareCreate || !canRead || busy || entry.pending.size || entry.conflict || preview) return;
    if (current.session.draft.prefill?.status !== 'superseded' &&
        current.session.draft.prefill?.nativeChecks?.some(check => check.key === `create:lookup:${request.id}`)) return;
    const lookupKey = `${key}:${request.id}:${current.session.draft.generationId}`;
    if (initialLookup.current.has(lookupKey)) return;
    const timer = setTimeout(() => { initialLookup.current.add(lookupKey); void commands.lookup().catch(() => {}); }, 700);
    return () => clearTimeout(timer);
  }, [current, request, busy, changed, key, preview, arrivalChecksPending, canPrepareCreate, canRead]);
  // A created room unlocks its dependent PDF lookup without asking staff to copy the confirmation.
  const warmedFilings = useRef(new Set<string>());
  useEffect(() => {
    if (!current || current.session.sourceChanged || arrivalChecksPending || !canPrepareAttach || !canRead || busy || entry.pending.size ||
        entry.actionsPending || uncommitted.size || entry.conflict || preview) return;
    const draft = current.session.draft;
    for (const filing of draft.proposal.content.requests.filter(row => row.kind === 'filing')) {
      const refs = effectiveAt(current, `${requestPath(filing.id)}/documentRefs`);
      const documents = draft.proposal.content.documents.filter(doc => doc.ownerRequestId === filing.id && Array.isArray(refs) && refs.includes(doc.id));
      if (documents.length !== 1 || current.operationResults.some(row => row.workflow === 'filing' && row.requestId === filing.id && ['succeeded', 'unknown'].includes(String(row.status)))) continue;
      const targets = documents[0]!.targetRefs.filter(row => row.kind === 'allocation');
      if (targets.length !== 1) continue;
      const target = targets[0]!;
      if (target.kind !== 'allocation') continue;
      const receipt = [...draft.operationResults].reverse().find(row => row.workflow === 'create' && row.requestId === target.requestId && row.allocationId === target.allocationId && row.generationId === draft.generationId && ['succeeded', 'failed', 'unknown'].includes(row.status));
      if (receipt?.status !== 'succeeded') continue;
      const warmKey = `${key}:${filing.id}:${receipt.id}:${receipt.updatedAt}`;
      if (warmedFilings.current.has(warmKey)) continue;
      warmedFilings.current.add(warmKey);
      void run(context => client.lookup({ ...context, requestId: filing.id })).catch(() => {});
      break;
    }
  }, [current, busy, changed, key, preview, arrivalChecksPending, uncommitted, canPrepareAttach, canRead]);
  const autoDigest = useRef(new Map<string, string>());
  useEffect(() => {
    if (!current || current.session.sourceChanged || current.preparationViews.some(view => view.dispatch) ||
        current.session.workflowDispatches?.some(dispatch => dispatch.status !== 'succeeded' && dispatch.status !== 'failed' && dispatch.status !== 'needs_review') || arrivalChecksPending || !request || busy || entry.pending.size || uncommitted.size || entry.conflict || preview) return;
    const body = record(effectiveAt(current, `${requestPath(request.id)}/body`));
    if (request.kind !== 'create' && request.kind !== 'quote') return;
    if (!canRead || (request.kind === 'create' ? !canPrepareCreate : !canPrepareQuote)) return;
    const digest = JSON.stringify({ generation: current.session.draft.generationId, body });
    const actionKey = `${key}:${request.id}`;
    if (autoDigest.current.get(actionKey) === digest) return;
    const timer = setTimeout(() => {
      autoDigest.current.set(actionKey, digest);
      if (request.kind === 'quote') {
        const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
        if (groups.length && groups.every(group => {
          const occupancy = record(group.occupancy), ages = occupancy.childAges;
          return /^\d{4}-\d{2}-\d{2}$/.test(text(group.arrival)) && text(group.departure) > text(group.arrival)
            && Number.isInteger(group.quantity) && Number(group.quantity) > 0 && occupancy.scope === 'per_room'
            && Number.isInteger(occupancy.adults) && Number(occupancy.adults) >= 1 && Number(occupancy.adults) <= 6
            && Number.isInteger(occupancy.childCount) && Number(occupancy.childCount) >= 0 && Number(occupancy.childCount) <= 6
            && (Number(occupancy.childCount) === 0
              ? ages === null || (Array.isArray(ages) && ages.length === 0)
              : Array.isArray(ages) && ages.length === occupancy.childCount &&
                ages.every(age => Number.isInteger(age) && Number(age) >= 0 && Number(age) <= 17));
        })) void commands.lookup().catch(() => {});
      } else {
        const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
        const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
        const ready = allocations.filter(room => {
          const section = sections.find(row => row.id === room.dateSectionId);
          const occupancy = record(room.occupancy), guest = record(room.guest);
          const settings = Object.assign({}, ...[body.shared, section?.defaults, room.overrides].map(values => Object.fromEntries(Object.entries(record(values)).filter(([, value]) => value != null))));
          const ages = occupancy.childAges;
          return section && text(section.arrival) && text(section.departure) && Number(occupancy.adults) > 0 && Number.isInteger(occupancy.childCount)
            && Array.isArray(ages) && ages.length === occupancy.childCount && ages.every(age => typeof age === 'number')
            && text(guest.firstName) && text(guest.lastName) && text(guest.nativeSelectionRef)
            && text(settings.roomType) && text(settings.ratePlan) && text(settings.guaranteeType) && text(settings.sourceOfBusiness);
        });
        for (const room of ready) {
          const finished = current.operationResults.some(row => row.workflow === 'create' && row.requestId === request.id && row.allocationId === room.id
            && (row.status === 'succeeded' || row.status === 'unknown'));
          if (!finished && !current.preparationViews.some(view => view.requestId === request.id && view.allocationId === room.id && view.current))
            void commands.prepare(String(room.id)).catch(() => {});
        }
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [current, request, busy, changed, uncommitted, key, preview, arrivalChecksPending, canPrepareCreate, canPrepareQuote, canRead]);

  return { snapshot: current, readyForReply: () => mounted.current && active.current.key === key
      && active.current.epoch === source.selectionEpoch && entry.pending.size === 0 && !entry.conflict && entry.actionsPending === 0
      && liveInputs.current.key === key && liveInputs.current.uncommitted.size === 0, latestSnapshot: () => entry.snapshot, request, commands, busy, error: error ?? entry.error, saving: entry.pending.size > 0, blocked: uncommitted.size > 0,
    conflict: entry.conflict, unresolvedPending, applicablePendingCount: pendingForCurrent.length, activeId: request?.id ?? null, setActiveId,
    addAction: (kind: Exclude<ReservationWorkflowKind, 'other'>) => run(async context => { const next = await client.addAction({ ...context, kind }); setActiveId(next.requests.at(-1)?.id ?? null); return next; }),
    undo: () => run(context => client.undo(context)), redo: () => run(context => client.redo(context)),
    retryPrefill: () => run(context => client.prefill(context)),
    reconcileSource: () => run(async context => {
      if (entry.pending.size) entry.sourceReviewBase = context.snapshot;
      return client.reconcileSource(context);
    }, false, true),
    applyPending: () => {
      entry.conflict = false; entry.error = null;
      return run(async context => {
        const matching = Array.from(entry.pending.values()).filter(edit => pendingMatches(context.snapshot, edit));
        await flush(context.source, entry, matching);
        if (entry.owner !== owner || entry.sourceKey !== sourceKey(context.source) || !mounted.current ||
            active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return;
        if (entry.pending.size) {
          entry.conflict = true;
          entry.error = 'Some pending edits no longer match a room or action. Copy the values below before discarding them.';
          notify(entry);
        }
      }, false, true);
    },
    discardPending: () => { entry.pending.clear(); releasePendingMutation(entry); entry.conflict = false; entry.error = null; setError(null); notify(entry); },
  };
}
