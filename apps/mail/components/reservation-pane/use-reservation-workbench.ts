'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import { ReservationWorkflowStaleRevisionError, type ReservationFieldOverride, type ReservationPaneSnapshot, type ReservationSourceContext, type ReservationWorkflowClient, type ReservationWorkflowKind } from '@/lib/reservation-workflow/types';
import { effectiveAt, valueAt, record, requestPath, snapshotMatchesSource, text, type WorkbenchCommands } from '@/lib/reservation-workflow/views';

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
  return !!snapshot && snapshot.session.draft.generationId === edit.generation
    && edit.rows.every(row => rowIdentity(effectiveAt(snapshot, row.path)) === row.identity);
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
  snapshot: ReservationPaneSnapshot | null;
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
const sourceKey = (source: ReservationSourceContext) => `${source.mailboxId}:${source.messageId}:${source.sourceHash}`;
const guestAttemptKey = (source: ReservationSourceContext, requestId: string, allocationId: string) =>
  `nava:guest-profile:${source.messageId}:${source.sourceHash}:${requestId}:${allocationId}`;
function readGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string): string | null {
  try { return window.localStorage.getItem(guestAttemptKey(source, requestId, allocationId)); } catch { return null; }
}
function saveGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string, operationId: string): boolean {
  try {
    const key = guestAttemptKey(source, requestId, allocationId);
    window.localStorage.setItem(key, operationId);
    return window.localStorage.getItem(key) === operationId;
  } catch { return false; }
}
function clearGuestAttempt(source: ReservationSourceContext, requestId: string, allocationId: string) {
  try { window.localStorage.removeItem(guestAttemptKey(source, requestId, allocationId)); } catch { /* A terminal result still remains in the draft. */ }
}

function notify(buffer: Buffer) { buffer.listeners.forEach(listener => listener()); }

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
    // Match the server's atomic identity invalidation while the edit is pending.
    const guest = edit.path.match(/^(.*\/guest)\/(?:firstName|lastName|email)$/);
    const party = edit.path.match(/^(.*\/(?:bookingAgency|organization|arAccount|agency|company))(?:\/name)?$/);
    const target = edit.path.match(/^(.*\/targets\/include\/[^/]+)\/(?:confirmation|guestName|bookedArrival|bookedDeparture)$/);
    const service = edit.path.match(/^(\/proposal\/content\/services\/[^/]+)\/code$/);
    const selection = guest ? `${guest[1]}/nativeSelectionRef` : party ? `${party[1]}/nativeSelectionRef` :
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
    for (const path of selections) if (!pending.has(path)) fieldOverrides[path] = { state: 'unknown', updatedAt: new Date().toISOString() };
  }
  return { ...snapshot, session: { ...snapshot.session, draft: { ...snapshot.session.draft, fieldOverrides } } };
}

export function useReservationWorkbench({ source, snapshot, client, onSnapshot, preview = false }: {
  source: ReservationSourceContext; snapshot: ReservationPaneSnapshot | null; client: ReservationWorkflowClient;
  onSnapshot(snapshot: ReservationPaneSnapshot): void; preview?: boolean;
}) {
  const key = sourceKey(source);
  const safeSnapshot = snapshotMatchesSource(snapshot, source) ? snapshot : null;
  if (!buffers.has(key)) buffers.set(key, { snapshot: safeSnapshot, pending: new Map(), conflict: false,
    error: null, pendingMutationHeld: false, actionsPending: 0, token: 0, queue: Promise.resolve(), listeners: new Set() });
  const entry = buffers.get(key)!;
  if (safeSnapshot && (!entry.snapshot || safeSnapshot.session.seq >= entry.snapshot.session.seq)) entry.snapshot = safeSnapshot;
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
  useEffect(() => { setError(null); setUncommitted(new Set()); setActiveId(null); }, [key]);

  const apply = useCallback((next: ReservationPaneSnapshot, bound: ReservationSourceContext, buffer: Buffer) => {
    if (!snapshotMatchesSource(next, bound)) return;
    buffer.snapshot = next;
    notify(buffer);
    if (mounted.current && active.current.key === sourceKey(bound) && active.current.epoch === bound.selectionEpoch) onSnapshot(next);
  }, [onSnapshot]);
  const flush = async (bound: ReservationSourceContext, buffer: Buffer, captured?: Pending[]) => {
    if (buffer.conflict) throw new Error('This draft changed elsewhere. Apply your pending edits or discard them before continuing.');
    try {
      let remaining = captured ?? Array.from(buffer.pending.values());
      while (remaining.length) {
        for (const pending of remaining) {
          if (buffer.pending.get(pending.path)?.token !== pending.token) continue;
          if (!buffer.snapshot) throw new Error('The email draft is still opening.');
          if (!pendingMatches(buffer.snapshot, pending)) throw new Error('The room or action changed elsewhere. Discard this pending edit and enter it on the current row.');
          const requestId = buffer.snapshot.requests.find(request => pending.path.startsWith(`${requestPath(request.id)}/`))?.id
            ?? buffer.snapshot.requests[0]?.id;
          if (!requestId) throw new Error('Add an action before editing its fields.');
          const before = buffer.snapshot;
          const next = await client.edit({ source: bound, snapshot: before, requestId, fieldPath: pending.path, state: pending.state, value: pending.value });
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
      buffer.error = null;
    } catch (failure) {
      if (failure instanceof ReservationWorkflowStaleRevisionError) apply(failure.snapshot, bound, buffer);
      buffer.conflict = true;
      buffer.error = failure instanceof Error ? failure.message : 'Your pending edits could not be saved.';
      notify(buffer);
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
  const run = (action: (context: { source: ReservationSourceContext; snapshot: ReservationPaneSnapshot }) => Promise<ReservationPaneSnapshot | void>, write = false): Promise<void> => {
    const bound = source;
    const buffer = entry;
    const execute = async () => {
      if (!mounted.current || active.current.key !== sourceKey(bound) || active.current.epoch !== bound.selectionEpoch) return;
      setBusy(true); setError(null);
      if (write) beginMutation();
      try {
        await flush(bound, buffer);
        if (!buffer.snapshot) throw new Error('The email draft is still opening.');
        if (!mounted.current || active.current.key !== sourceKey(bound) || active.current.epoch !== bound.selectionEpoch) return;
        const next = await action({ source: bound, snapshot: buffer.snapshot });
        if (next) { apply(next, bound, buffer); if (next.serviceNotice) throw new Error(next.serviceNotice); }
      } catch (failure) {
        if (failure instanceof ReservationWorkflowStaleRevisionError) {
          buffer.conflict = true; buffer.error = failure.message; apply(failure.snapshot, bound, buffer);
        }
        if (mounted.current && active.current.key === key) setError(failure instanceof Error ? failure.message : 'Infor could not complete this step. Your draft is retained.');
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
  const stageEdit = (path: string, value: unknown, state: ReservationFieldOverride['state'] = 'set') => {
    if (!entry.pendingMutationHeld) { entry.pendingMutationHeld = true; beginMutation(); }
    const previous = entry.pending.get(path);
    entry.pending.set(path, { path, value, state, token: ++entry.token, generation: previous?.generation ?? entry.snapshot?.session.draft.generationId ?? null,
      rows: previous?.rows ?? captureRows(entry.snapshot, path) });
    notify(entry);
  };
  const current = displaySnapshot(entry.snapshot ?? safeSnapshot, entry.pending);
  const request = current?.requests.find(row => row.id === activeId) ?? current?.requests[0];
  const requireRequest = () => { if (!request) throw new Error('Choose an action first.'); return request.id; };
  const commands: WorkbenchCommands = {
    stageEdit,
    setUncommitted(id, dirty) {
      const previous = liveInputs.current.key === key ? liveInputs.current.uncommitted : new Set<string>();
      if (previous.has(id) === dirty) return;
      const next = new Set(previous); if (dirty) next.add(id); else next.delete(id);
      liveInputs.current = { key, uncommitted: next }; setUncommitted(next);
    },
    edit(path, value, state = 'set') { stageEdit(path, value, state); return run(async () => {}); },
    changeRows(change) { return run(context => client.changeRows({ ...context, ...change })); },
    selectNative(fieldPath, observationRef) { return run(context => client.selectNative({ ...context, requestId: requireRequest(), fieldPath, observationRef })); },
    lookup() { return run(context => client.lookup({ ...context, requestId: requireRequest() })); },
    async guestProfileOptions(allocationId, field) {
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
      if (uncommitted.size) return Promise.reject(new Error('Apply changed fields before creating a profile.'));
      const requestId = requireRequest();
      return run(async context => {
        const previousAttempt = readGuestAttempt(context.source, requestId, allocationId);
        const previousResult = previousAttempt ? context.snapshot.operationResults.find(row => row.id === previousAttempt && row.workflow === 'guest_profile') : undefined;
        if (previousResult?.status === 'succeeded' || previousResult?.status === 'failed') clearGuestAttempt(context.source, requestId, allocationId);
        else if (previousAttempt) throw new Error('Check the previous profile creation outcome before trying again.');
        let current = context.snapshot;
        const root = `${requestPath(requestId)}/body`;
        const body = record(effectiveAt(current, root));
        const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
        const index = allocations.findIndex(row => row.id === allocationId);
        if (index < 0) throw new Error('This room changed. Review its guest before creating a profile.');
        const guestPath = `${root}/allocations/${index}/guest`;
        if (valueAt(current, `${guestPath}/profileIntent`) !== 'requested_new') throw new Error('Choose New profile first.');
        // Go accepts staff-entered values only. Source suggestions still need their own acknowledgement.
        for (const field of ['firstName', 'lastName', 'mobile', 'email', 'titleCode', 'phoneNumber', 'phoneTypeCode', 'emailTypeCode']) {
          const path = `${guestPath}/${field}`;
          const override = current.session.draft.fieldOverrides[path];
          if (override?.state !== 'set' || typeof override.value !== 'string' || !override.value.trim() ||
              current.session.draft.staffReviews[path]?.status === 'accepted') continue;
          current = await client.review({ source: context.source, snapshot: current, fieldPath: path, decision: 'accepted', note: 'Entered by staff' });
          apply(current, context.source, entry);
          if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return current;
        }
        const prepared = await client.prepareGuestProfile({ source: context.source, snapshot: current, requestId, allocationId, confirmDuplicateName });
        apply(prepared, context.source, entry);
        const reply = record(prepared.workflowReply);
        if (prepared.serviceNotice || reply.status !== 'prepared' || typeof reply.prepareRef !== 'string') return prepared;
        if (!mounted.current || active.current.key !== sourceKey(context.source) || active.current.epoch !== context.source.selectionEpoch) return prepared;
        if ([...entry.pending.keys()].some(path => path === guestPath || path.startsWith(`${guestPath}/`))) {
          throw new Error('Guest details changed. Review them before creating the profile.');
        }
        const idempotencyKey = crypto.randomUUID();
        if (!saveGuestAttempt(context.source, requestId, allocationId, idempotencyKey)) {
          throw new Error('This device cannot retain the profile attempt for recovery. Profile creation is unavailable.');
        }
        const result = await client.createGuestProfile({ source: context.source, snapshot: prepared, requestId, allocationId,
          confirmDuplicateName, prepareRef: reply.prepareRef, idempotencyKey });
        const operation = result.operationResults.find(row => row.id === idempotencyKey);
        if (operation?.status === 'succeeded' || operation?.status === 'failed') clearGuestAttempt(context.source, requestId, allocationId);
        return result;
      }, true);
    },
    guestProfilePending(allocationId) {
      if (!request) return null;
      const id = readGuestAttempt(source, request.id, allocationId);
      const operation = id ? current?.operationResults.find(row => row.id === id && row.workflow === 'guest_profile') : undefined;
      if (operation?.status === 'succeeded' || operation?.status === 'failed') return null;
      return id;
    },
    checkGuestProfile(allocationId) {
      const requestId = requireRequest();
      const operationId = readGuestAttempt(source, requestId, allocationId);
      if (!operationId) return Promise.reject(new Error('No pending profile attempt was found on this device.'));
      return run(async context => {
        const latest = await client.get(context);
        apply(latest, context.source, entry);
        const operation = latest.operationResults.find(row => row.id === operationId && row.workflow === 'guest_profile' &&
          row.requestId === requestId && row.allocationId === allocationId);
        if (!operation) throw new Error('Infor has not recorded the profile outcome yet. Check again later or contact support.');
        if (operation.status === 'succeeded' || operation.status === 'failed') {
          clearGuestAttempt(context.source, requestId, allocationId); return latest;
        }
        const result = await client.reconcile({ source: context.source, snapshot: latest, operationId });
        const checked = result.operationResults.find(row => row.id === operationId);
        if (checked?.status === 'succeeded' || checked?.status === 'failed') clearGuestAttempt(context.source, requestId, allocationId);
        return result;
      });
    },
    prepare(allocationId) { if (uncommitted.size) return Promise.reject(new Error('Apply changed fields before checking Infor.')); return run(context => client.prepare({ ...context, requestId: requireRequest(), allocationId })); },
    review(scope, ids) { return run(context => client.reviewScope({ ...context, requestId: requireRequest(), scope, ids })); },
    execute(allocationId) { if (uncommitted.size) return Promise.reject(new Error('Apply changed fields before saving.')); if (preview) return Promise.reject(new Error('Preview only. Native Save is disabled.')); return run(context => client.execute({ ...context, requestId: requireRequest(), allocationId, idempotencyKey: crypto.randomUUID() }), true); },
    reconcile(operationId) { return run(context => {
      const operation = context.snapshot.operationResults.find(row => row.id === operationId);
      return operation?.workflow === 'services' ? client.reconcileServices({ ...context, operationId }) : client.reconcile({ ...context, operationId });
    }); },
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
      return { ...reviewed, workflowReply: context.snapshot.workflowReply };
    }); },
    configureFiling(attachmentId, confirmation, kind) { return run(context => client.configureFiling({ ...context, requestId: requireRequest(), attachmentId, confirmation, kind })); },
    lookupServices(target, serviceId) { return run(context => client.lookupServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId })); },
    previewServices(target, serviceId) { return run(context => client.previewServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId })); },
    executeServices(target, serviceId, reviewedPrepareRef) { if (preview) return Promise.reject(new Error('Preview only. Native Save is disabled.')); return run(context => client.executeServices({ ...context, requestId: requireRequest(), ...(typeof target === 'string' ? { allocationId: target } : { targetRef: target }), serviceId, reviewedPrepareRef, idempotencyKey: crypto.randomUUID() }), true); },
  };
  const initialLookup = useRef(new Set<string>());
  useEffect(() => {
    if (!current || !request || request.kind !== 'create' || busy || entry.pending.size || entry.conflict || preview) return;
    const lookupKey = `${key}:${request.id}:${current.session.draft.generationId}`;
    if (initialLookup.current.has(lookupKey)) return;
    const timer = setTimeout(() => { initialLookup.current.add(lookupKey); void commands.lookup().catch(() => {}); }, 700);
    return () => clearTimeout(timer);
  }, [current, request, busy, changed, key, preview]);
  const autoDigest = useRef(new Map<string, string>());
  useEffect(() => {
    if (!current || !request || busy || entry.pending.size || uncommitted.size || entry.conflict || preview) return;
    const body = record(effectiveAt(current, `${requestPath(request.id)}/body`));
    if (request.kind !== 'create' && request.kind !== 'quote') return;
    const digest = JSON.stringify({ generation: current.session.draft.generationId, body });
    const actionKey = `${key}:${request.id}`;
    if (autoDigest.current.get(actionKey) === digest) return;
    const timer = setTimeout(() => {
      autoDigest.current.set(actionKey, digest);
      if (request.kind === 'quote') {
        const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
        if (groups.length && groups.every(group => text(group.arrival) && text(group.departure) && typeof group.quantity === 'number' && record(group.occupancy).scope === 'per_room')) void commands.lookup().catch(() => {});
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
            && text(guest.firstName) && text(guest.lastName) && text(guest.nativeSelectionRef ?? guest.suggestedRef)
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
  }, [current, request, busy, changed, uncommitted, key, preview]);

  return { snapshot: current, readyForReply: () => mounted.current && active.current.key === key
      && active.current.epoch === source.selectionEpoch && entry.pending.size === 0 && !entry.conflict && entry.actionsPending === 0
      && liveInputs.current.key === key && liveInputs.current.uncommitted.size === 0, latestSnapshot: () => entry.snapshot, request, commands, busy, error: error ?? entry.error, saving: entry.pending.size > 0, blocked: uncommitted.size > 0,
    conflict: entry.conflict, activeId: request?.id ?? null, setActiveId,
    addAction: (kind: Exclude<ReservationWorkflowKind, 'other'>) => run(async context => { const next = await client.addAction({ ...context, kind }); setActiveId(next.requests.at(-1)?.id ?? null); return next; }),
    undo: () => run(context => client.undo(context)), redo: () => run(context => client.redo(context)),
    retryPrefill: () => run(context => client.prefill(context)),
    applyPending: () => { entry.conflict = false; entry.error = null; return run(async () => {}); },
    discardPending: () => { entry.pending.clear(); releasePendingMutation(entry); entry.conflict = false; entry.error = null; setError(null); notify(entry); },
  };
}
