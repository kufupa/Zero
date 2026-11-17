'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoundThreadSnapshot, NavaApi } from './api';
import { NavaApiError } from './api';
import { NavaPane, PaneMessage } from './pane';
import type { SelectedEmail } from './pane';
import { Workflow, workflowPrimaryAction } from './workflow';
import type { DraftValue, GuestCandidate } from './workflow';
import type { Capabilities, Change, FieldSpec, Json, Proposal, ThreadInput, Workflow as WorkflowName } from './wire';

export type NavaControllerProps = {
  input: ThreadInput | null;
  email: SelectedEmail | null;
  api: NavaApi;
  reconcileSupported?: boolean;
  onAuthenticationRequired?: () => void | Promise<void>;
};

type Draft = { value: DraftValue; version: number; base: { exists: boolean; value?: unknown } };
type Drafts = Record<string, Record<string, Draft>>;
type Issue = { kind: 'conflict' | 'error'; message: string };
type GoLock = 'accepted' | 'uncertain' | 'reconciling';
type ActiveOperation = { kind: 'stage' | 'quote' | 'reconcile' | 'refresh' | 'attachments'; proposalId: string; signal: AbortSignal };
type Cache = {
  drafts: Drafts;
  issues: Record<string, Issue>;
  goLocks: Record<string, GoLock>;
  goUncertainAfter: Record<string, number>;
  stagePending: Record<string, number>;
  quoteAttempts: Record<string, string>;
  attachmentNeedsRecheck: Record<string, boolean>;
  operationStarts: Record<string, { phase: Proposal['phase']; at: number }>;
  selectedId: string | null;
  nextVersion: number;
  inFlightEdit: { proposalId: string; signal: AbortSignal } | null;
};

function emptyCache(): Cache {
  return { drafts: {}, issues: {}, goLocks: {}, goUncertainAfter: {}, stagePending: {}, quoteAttempts: {}, attachmentNeedsRecheck: {}, operationStarts: {}, selectedId: null, nextVersion: 0, inFlightEdit: null };
}

function pointer(root: unknown, path: string): { exists: boolean; value?: unknown } {
  if (!path.startsWith('/')) return { exists: false };
  let value: unknown = root;
  for (const part of path.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(part)) return { exists: false };
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return { exists: false };
      value = value[Number(key)];
    } else if (value !== null && typeof value === 'object') {
      const entry = Object.entries(value).find(([name]) => name === key);
      if (!entry) return { exists: false };
      value = entry[1];
    } else return { exists: false };
  }
  return { exists: true, value };
}

function editValue(spec: FieldSpec, draft: DraftValue, workflow: WorkflowName): { ok: true; value: Json } | { ok: false; message: string } {
  if (Array.isArray(draft)) {
    if (!/^\/bookings\/(?:0|[1-9]\d*)\/fields\/child_ages$/.test(spec.path) ||
        draft.some(age => !/^\d+$/.test(age) || Number(age) > 17)) {
      return { ok: false, message: 'Enter an age from 0 to 17 for each child.' };
    }
    return { ok: true, value: draft.map(Number) };
  }
  if (spec.control === 'checkbox') return typeof draft === 'boolean'
    ? { ok: true, value: draft } : { ok: false, message: `${spec.label}: choose yes or no.` };
  if (typeof draft !== 'string') return { ok: false, message: `${spec.label}: check this value.` };
  if (workflow === 'create' && spec.path === '/bookings/0/fields/guest_profile_id' && draft === '') return { ok: true, value: null };
  if (spec.control === 'number') {
    if (!draft.trim()) return { ok: true, value: null };
    const value = Number(draft);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: `${spec.label}: enter a valid number.` };
  }
  return { ok: true, value: draft };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
}

function validChildren(count: unknown, ages: unknown): boolean {
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 16 &&
    Array.isArray(ages) && ages.length === count && ages.every(age => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 17);
}

function validSavedChildren(proposal: Proposal): boolean {
  return proposal.workflow !== 'create' || proposal.bookings.every(booking => validChildren(booking.fields.child_count, booking.fields.child_ages));
}

function supports(capabilities: Capabilities | null, key: 'tools' | 'workflows', name: string): boolean {
  const value = capabilities?.[key];
  return Array.isArray(value) && value.some(item => item === name);
}

function advertised(capabilities: Capabilities | null, workflow: WorkflowName, operation: 'stage' | 'quote'): boolean {
  return capabilities?.auth_ready === true && supports(capabilities, 'workflows', workflow) &&
    capabilities.workflow_capabilities?.[workflow]?.[operation] === true;
}

function needsAttachmentReview(workflow: WorkflowName): boolean {
  return workflow === 'create' || workflow === 'amend' || workflow === 'cancel' || workflow === 'filing';
}

function hasQuote(proposal: Proposal, quoteId: string): boolean {
  return proposal.actions.some(action => action.type === 'quote' && action.details !== null &&
    typeof action.details === 'object' && !Array.isArray(action.details) && action.details.quote_id === quoteId);
}

function safeOperationError(error: unknown): string | null {
  if (!(error instanceof NavaApiError)) return null;
  switch (error.code) {
    case 'ATTACHMENTS_UNCONFIRMED': return 'Review the attachments and confirm before running Prepare.';
    case 'INVALID_GUEST_SELECTION': return 'Select a verified Infor profile with matching names and clear the email lookup.';
    case 'STALE_REVISION': case 'INVALID_PHASE': case 'NOT_EDITABLE': return 'The proposal changed. Refresh it and review the latest details.';
    case 'INVALID_INPUT': return 'Check the proposal details and try again.';
    case 'UNAVAILABLE': return 'This Infor check is currently unavailable.';
    default: return null;
  }
}

function delay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = window.setTimeout(done, ms);
    function done() { window.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

function displayDrafts(cache: Cache, proposalId: string): Record<string, DraftValue> {
  return Object.fromEntries(Object.entries(cache.drafts[proposalId] ?? {}).map(([path, draft]) => [path, draft.value]));
}

function goStorageKey(proposalId: string) { return `nava-pending-go:${proposalId}`; }

function clearPendingGo(proposalId: string) {
  try { window.sessionStorage.removeItem(goStorageKey(proposalId)); } catch { /* Leave the lock in place if storage is unavailable. */ }
}

export function NavaController(props: NavaControllerProps) {
  const caches = useRef(new Map<string, Cache>());
  if (!props.input || !props.email) return <NavaPane email={null} />;
  const threadKey = JSON.stringify([props.input.source, props.input.mailbox_id, props.input.source_thread_id]);
  const selectionKey = JSON.stringify([threadKey, props.input.selected_message_id, props.input]);
  let cache = caches.current.get(selectionKey);
  if (!cache) { cache = emptyCache(); caches.current.set(selectionKey, cache); }
  return <ThreadController key={selectionKey} {...props} input={props.input} email={props.email} cache={cache} />;
}

type ThreadControllerProps = Omit<NavaControllerProps, 'input' | 'email'> & { input: ThreadInput; email: SelectedEmail; cache: Cache };

function ThreadController({ input, email, api, cache, reconcileSupported = false, onAuthenticationRequired }: ThreadControllerProps) {
  const [snapshot, setSnapshot] = useState<BoundThreadSnapshot | null>(null);
  const snapshotRef = useRef<BoundThreadSnapshot | null>(null);
  const inputKey = JSON.stringify(input);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [streamMessage, setStreamMessage] = useState<string | null>(null);
  const [bindingUnavailable, setBindingUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState(cache.selectedId);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [openingLong, setOpeningLong] = useState(false);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [authenticationExpired, setAuthenticationExpired] = useState(false);
  const authenticationExpiredRef = useRef(false);
  const mounted = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef<ActiveOperation | null>(null);
  const refreshVersion = () => setVersion(value => value + 1);

  function cancelOwnedWork(signal: AbortSignal) {
    const edit = cache.inFlightEdit;
    if (edit?.signal === signal) {
      cache.issues[edit.proposalId] = { kind: 'conflict', message: 'Edit may have reached Nava. Review the latest values before applying your draft.' };
      cache.inFlightEdit = null;
    }
    const operation = operationRef.current;
    if (operation?.signal === signal) {
      if (operation.kind === 'reconcile' && cache.goLocks[operation.proposalId] === 'reconciling') cache.goLocks[operation.proposalId] = 'uncertain';
      operationRef.current = null;
    }
  }

  function expireAuthentication(error: unknown, signal: AbortSignal): boolean {
    if (!(error instanceof NavaApiError) || error.status !== 401 || signal.aborted || controllerRef.current?.signal !== signal) return false;
    authenticationExpiredRef.current = true;
    setAuthenticationExpired(true);
    setMessage(null);
    setStreamMessage(null);
    cancelOwnedWork(signal);
    controllerRef.current?.abort();
    setBusy(false);
    return true;
  }

  async function restoreAuthentication() {
    if (!onAuthenticationRequired) { window.location.reload(); return; }
    try {
      await onAuthenticationRequired();
      if (!mounted.current) return;
      authenticationExpiredRef.current = false;
      setAuthenticationExpired(false);
      setOpenAttempt(value => value + 1);
    } catch {
      if (mounted.current) setMessage('Could not sign in. Try again.');
    }
  }

  function applySnapshot(next: BoundThreadSnapshot, authoritative = true, stageObservedFor?: string) {
    if (next.selected_message_id !== input.selected_message_id || (snapshotRef.current && snapshotRef.current.id !== next.id)) {
      snapshotRef.current = null;
      setSnapshot(null);
      setMessage('This conversation changed. Select the email again.');
      throw new NavaApiError('The selected email changed.', 'invalid_response');
    }
    const previous = snapshotRef.current;
    if (previous && next.event_sequence < previous.event_sequence) return;
    const bound = next.proposals.filter(proposal => proposal.source_message_id === input.selected_message_id &&
      proposal.thread_id === next.id && proposal.session_id === next.session?.id);
    setBindingUnavailable(bound.length === 0 && next.proposals.length > 0);
    const proposals = bound.map(proposal => {
      const old = previous?.proposals.find(item => item.id === proposal.id);
      const pendingSequence = cache.stagePending[proposal.id];
      const observedStage = authoritative && pendingSequence !== undefined && next.event_sequence > pendingSequence &&
        (!old || proposal.revision >= old.revision) &&
        (proposal.phase === 'staging' || stageObservedFor === proposal.id);
      if (observedStage) delete cache.stagePending[proposal.id];
      const staleStage = pendingSequence !== undefined && !observedStage;
      const latest = old && (old.revision > proposal.revision || staleStage && old.phase === 'staging') ? old : proposal;
      const operation = cache.operationStarts[latest.id];
      if (!operation || operation.phase !== latest.phase) {
        const serverTime = Date.parse(latest.updated_at);
        cache.operationStarts[latest.id] = { phase: latest.phase, at: Number.isFinite(serverTime) ? serverTime : Date.now() };
      }
      if (latest.phase === 'done') { delete cache.goLocks[latest.id]; delete cache.goUncertainAfter[latest.id]; clearPendingGo(latest.id); }
      else {
        try {
          if (window.sessionStorage.getItem(goStorageKey(latest.id)) && !cache.goLocks[latest.id]) {
            cache.goLocks[latest.id] = latest.phase === 'saving' ? 'accepted' : 'uncertain';
          }
        } catch { /* Go cannot start unless its pending key can be stored. */ }
        const uncertainAfter = cache.goUncertainAfter[latest.id];
        if (authoritative && proposal.phase === 'saving' && proposal.error?.outcome !== 'uncertain' && proposal.revision === latest.revision && cache.goLocks[latest.id] === 'uncertain' && (uncertainAfter === undefined || next.event_sequence > uncertainAfter)) {
          cache.goLocks[latest.id] = 'accepted';
          delete cache.goUncertainAfter[latest.id];
        }
      }
      if (latest.phase === 'uncertain' || latest.error?.outcome === 'uncertain') {
        cache.goLocks[latest.id] = 'uncertain';
        if (authoritative) cache.goUncertainAfter[latest.id] = Math.max(cache.goUncertainAfter[latest.id] ?? 0, next.event_sequence);
      }
      return latest;
    });
    const merged = { ...next, proposals, event_sequence: Math.max(previous?.event_sequence ?? 0, next.event_sequence) };
    snapshotRef.current = merged;
    setSnapshot(merged);
    if (!cache.selectedId || !proposals.some(proposal => proposal.id === cache.selectedId)) {
      cache.selectedId = proposals[0]?.id ?? null;
      setSelectedId(cache.selectedId);
    }
  }

  function applyProposal(proposal: Proposal) {
    const current = snapshotRef.current;
    if (!current) return;
    const previous = current.proposals.find(item => item.id === proposal.id);
    if (!previous || previous.thread_id !== proposal.thread_id || previous.session_id !== proposal.session_id)
      throw new NavaApiError('The proposal no longer belongs to this email.', 'invalid_response');
    applySnapshot({ ...current, proposals: current.proposals.map(item => item.id === proposal.id
      ? { ...proposal, source_message_id: item.source_message_id } : item) }, false);
  }

  async function recoverStage(threadId: string, proposalId: string, sequence: number, signal: AbortSignal) {
    while (!signal.aborted && cache.stagePending[proposalId] === sequence) {
      await delay(signal, 2000);
      if (signal.aborted || cache.stagePending[proposalId] !== sequence) return;
      try {
        const latest = await api.getThread(threadId, { signal });
        if (signal.aborted || cache.stagePending[proposalId] !== sequence) return;
        applySnapshot(latest, true, proposalId);
        if (cache.stagePending[proposalId] === undefined) setStreamMessage(null);
      } catch (error) {
        if (signal.aborted || expireAuthentication(error, signal)) return;
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (authenticationExpiredRef.current) return () => { mounted.current = false; };
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;
    setMessage(null);
    setBusy(false);
    setOpeningLong(false);
    let cursor = 0;
    const openingTimer = window.setTimeout(() => setOpeningLong(true), 30_000);
    async function start() {
      try {
        const [thread, caps] = await Promise.all([
          api.upsertThread(input, { signal }), api.getCapabilities({ signal }),
        ]);
        if (signal.aborted) return;
        cursor = thread.event_sequence;
        window.clearTimeout(openingTimer);
        setCapabilities(caps);
        applySnapshot(thread);
        while (!signal.aborted) {
          try {
            for await (const event of api.events(thread.id, cursor, { signal })) {
              if (signal.aborted) return;
              if (event.sequence <= cursor) continue;
              const next = await api.getThread(thread.id, { signal });
              if (signal.aborted) return;
              if (next.event_sequence < event.sequence) throw new Error('Snapshot is behind the event stream.');
              const stageEvent = (event.kind === 'stage_queued' || event.kind === 'stage_finished') && event.proposal_id &&
                event.sequence > (cache.stagePending[event.proposal_id] ?? Number.POSITIVE_INFINITY) ? event.proposal_id : undefined;
              applySnapshot(next, true, stageEvent);
              cursor = Math.max(event.sequence, next.event_sequence);
              setStreamMessage(null);
            }
            if (signal.aborted) return;
            setStreamMessage('Connection interrupted. Reconnecting to Nava.');
          } catch (error) {
            if (signal.aborted) return;
            if (expireAuthentication(error, signal)) return;
            setStreamMessage('Connection interrupted. Reconnecting to Nava.');
          }
          await delay(signal, 2000);
          if (signal.aborted) return;
          try {
            const next = await api.getThread(thread.id, { signal });
            if (signal.aborted) return;
            applySnapshot(next);
            cursor = Math.max(cursor, next.event_sequence);
            setStreamMessage(null);
          } catch (error) {
            if (signal.aborted) return;
            if (expireAuthentication(error, signal)) return;
          }
        }
      } catch (error) {
        if (!signal.aborted && !expireAuthentication(error, signal)) setMessage('Could not open this email in Nava. Check your connection and try again.');
      }
    }
    void start();
    return () => {
      mounted.current = false;
      window.clearTimeout(openingTimer);
      cancelOwnedWork(signal);
      controller.abort();
    };
  }, [api, cache, inputKey, openAttempt]);

  useEffect(() => {
    if (!snapshot || busy || authenticationExpired || operationRef.current || cache.inFlightEdit) return;
    const proposal = snapshot.proposals.find(item => Object.keys(cache.drafts[item.id] ?? {}).length > 0 && !cache.issues[item.id] && !cache.goLocks[item.id]);
    if (!proposal) return;
    const timer = window.setTimeout(() => { void saveDraft(proposal.id); }, 450);
    return () => window.clearTimeout(timer);
  }, [snapshot, version, busy, authenticationExpired]);

  async function saveDraft(proposalId: string) {
    const proposal = snapshotRef.current?.proposals.find(item => item.id === proposalId);
    const drafts = cache.drafts[proposalId];
    const signal = controllerRef.current?.signal;
    if (!proposal || !drafts || !signal || signal.aborted || authenticationExpiredRef.current || cache.inFlightEdit || operationRef.current || cache.issues[proposalId] || cache.goLocks[proposalId] || cache.stagePending[proposalId] !== undefined) return;
    const entries = Object.entries(drafts);
    const changes: Change[] = [];
    for (const [path, draft] of entries) {
      const spec = proposal.field_specs.find(item => item.path === path && item.editable);
      if (!spec) { cache.issues[proposalId] = { kind: 'error', message: 'This field is no longer editable. Review your draft.' }; refreshVersion(); return; }
      const current = pointer(proposal, path);
      if (draft.base.exists !== current.exists || !sameValue(draft.base.value, current.value)) {
        cache.issues[proposalId] = { kind: 'conflict', message: 'This field changed elsewhere. Review the latest value before applying your draft.' };
        refreshVersion(); return;
      }
      const parsed = editValue(spec, draft.value, proposal.workflow);
      if (!parsed.ok) { cache.issues[proposalId] = { kind: 'error', message: parsed.message }; refreshVersion(); return; }
      changes.push({ op: pointer(proposal, path).exists ? 'replace' : 'add', path, value: parsed.value });
    }
    const childPrefixes = new Set(entries.flatMap(([path]) => {
      const match = /^(\/bookings\/(?:0|[1-9]\d*)\/fields)\/child_(?:count|ages)$/.exec(path);
      return match ? [match[1]] : [];
    }));
    for (const prefix of childPrefixes) {
      const countPath = `${prefix}/child_count`;
      const agesPath = `${prefix}/child_ages`;
      const countChange = changes.find(change => change.path === countPath);
      const agesChange = changes.find(change => change.path === agesPath);
      const count = countChange && countChange.op !== 'remove' ? countChange.value : pointer(proposal, countPath).value;
      const ages = agesChange && agesChange.op !== 'remove' ? agesChange.value : pointer(proposal, agesPath).value;
      if (!validChildren(count, ages)) {
        cache.issues[proposalId] = { kind: 'error', message: 'Enter a child count from 0 to 16 and an age from 0 to 17 for each child.' };
        refreshVersion(); return;
      }
      for (const path of [countPath, agesPath]) {
        if (changes.some(change => change.path === path)) continue;
        const spec = proposal.field_specs.find(item => item.path === path && item.editable);
        const value = pointer(proposal, path);
        if (!spec || !value.exists) {
          cache.issues[proposalId] = { kind: 'error', message: 'Child count and ages must both be editable. Refresh the proposal.' };
          refreshVersion(); return;
        }
        // Existing booking fields are validated JSON from the proposal schema.
        const saved = path === countPath ? proposal.bookings[Number(prefix.split('/')[2])]?.fields.child_count : proposal.bookings[Number(prefix.split('/')[2])]?.fields.child_ages;
        if (saved === undefined) {
          cache.issues[proposalId] = { kind: 'error', message: 'Child count and ages must both be available. Refresh the proposal.' };
          refreshVersion(); return;
        }
        changes.push({ op: 'replace', path, value: saved });
      }
    }
    if (!changes.length) return;
    const editRequest = { proposalId, signal };
    cache.inFlightEdit = editRequest;
    cache.attachmentNeedsRecheck[proposalId] = true;
    setBusy(true);
    try {
      const updated = await api.patchProposal({ proposalId, expectedRevision: proposal.revision, changes, signal });
      if (signal.aborted) return;
      applyProposal(updated);
      for (const [path, sent] of entries) {
        const current = cache.drafts[proposalId]?.[path];
        const change = changes.find(item => item.path === path);
        const received = pointer(updated, path);
        if (current?.version === sent.version && change && change.op !== 'remove' && received.exists && sameValue(received.value, change.value)) delete cache.drafts[proposalId][path];
        else if (current?.version === sent.version) cache.issues[proposalId] = { kind: 'conflict', message: 'Nava returned a different value. Review and apply your draft again if needed.' };
        else if (current && received.exists) current.base = received;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (expireAuthentication(error, signal)) return;
      const conflict = error instanceof NavaApiError && error.kind === 'conflict';
      cache.issues[proposalId] = { kind: conflict ? 'conflict' : 'error', message: conflict
        ? 'This proposal changed elsewhere. Review the latest values before applying your draft.'
        : 'Could not save your edits. Review the latest values before retrying.' };
      try {
        const threadId = snapshotRef.current?.id;
        if (threadId) {
          const latest = await api.getThread(threadId, { signal });
          if (!signal.aborted) applySnapshot(latest);
        }
      } catch (error) { if (!signal.aborted) expireAuthentication(error, signal); }
    } finally {
      if (cache.inFlightEdit === editRequest) cache.inFlightEdit = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  function edit(proposalId: string, path: string, value: DraftValue) {
    cache.drafts[proposalId] ??= {};
    const proposal = snapshotRef.current?.proposals.find(item => item.id === proposalId);
    const base = cache.drafts[proposalId][path]?.base ?? pointer(proposal, path);
    cache.drafts[proposalId][path] = { value, version: ++cache.nextVersion, base };
    if (cache.issues[proposalId]?.kind === 'error') delete cache.issues[proposalId];
    refreshVersion();
  }

  async function applyDraftAfterRefresh(proposalId: string) {
    const signal = controllerRef.current?.signal;
    const threadId = snapshotRef.current?.id;
    if (!signal || signal.aborted || authenticationExpiredRef.current || !threadId || operationRef.current || cache.inFlightEdit) return;
    const currentOperation: ActiveOperation = { kind: 'refresh', proposalId, signal };
    operationRef.current = currentOperation;
    setBusy(true);
    try {
      const reviewed = snapshotRef.current?.proposals.find(item => item.id === proposalId);
      const latest = await api.getThread(threadId, { signal });
      if (signal.aborted) return;
      applySnapshot(latest);
      const current = snapshotRef.current?.proposals.find(item => item.id === proposalId);
      if (!reviewed || !current || reviewed.revision !== current.revision) {
        cache.issues[proposalId] = { kind: 'conflict', message: 'The proposal changed again. Review the latest values before applying your draft.' };
      } else {
        for (const [path, draft] of Object.entries(cache.drafts[proposalId] ?? {})) draft.base = pointer(current, path);
        delete cache.issues[proposalId];
      }
    } catch (error) {
      if (!signal.aborted && !expireAuthentication(error, signal)) cache.issues[proposalId] = { kind: 'conflict', message: 'Could not refresh the proposal. Your draft is still here.' };
    } finally {
      if (operationRef.current === currentOperation) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function selectGuest(proposal: Proposal, candidate: GuestCandidate) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !current || cache.selectedId !== current.id || current.revision !== proposal.revision || current.workflow !== 'create' || current.bookings.length !== 1 ||
        !['ready', 'waiting_go'].includes(current.phase) || current.stage?.revision !== current.revision ||
        cache.goLocks[current.id] || cache.issues[current.id] || cache.stagePending[current.id] !== undefined ||
        Object.keys(cache.drafts[current.id] ?? {}).length) return;
    const native = current.stage.native_result;
    const choices = native && typeof native === 'object' && !Array.isArray(native) ? native.guest_candidates : null;
    const items = choices && typeof choices === 'object' && !Array.isArray(choices) && choices.status !== 'unavailable' && Array.isArray(choices.items) ? choices.items : [];
    if (!/^\d{1,100}$/.test(candidate.nativeId) || !candidate.firstName.trim() || !candidate.lastName.trim() ||
        items.filter(item => item && typeof item === 'object' && !Array.isArray(item) &&
          item.native_id === candidate.nativeId && item.first_name === candidate.firstName && item.last_name === candidate.lastName).length !== 1) return;
    const changes: Change[] = [];
    for (const [field, value] of [['guest_profile_id', candidate.nativeId], ['first_name', candidate.firstName], ['last_name', candidate.lastName]] as const) {
      const path = `/bookings/0/fields/${field}`;
      if (!current.field_specs.some(spec => spec.path === path && spec.editable)) {
        setMessage('Guest profile fields are unavailable. Refresh the proposal.'); return;
      }
      changes.push({ op: pointer(current, path).exists ? 'replace' : 'add', path, value });
    }
    const emailPath = '/bookings/0/fields/guest_email';
    if (pointer(current, emailPath).exists) {
      if (!current.field_specs.some(spec => spec.path === emailPath && spec.editable)) {
        setMessage('The guest email lookup cannot be cleared here. Review this proposal in Infor.'); return;
      }
      changes.push({ op: 'remove', path: emailPath });
    }
    const editRequest = { proposalId: current.id, signal };
    cache.inFlightEdit = editRequest;
    cache.attachmentNeedsRecheck[current.id] = true;
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.patchProposal({ proposalId: current.id, expectedRevision: current.revision, changes, signal });
      if (signal.aborted) return;
      const matches = updated.revision > current.revision && !updated.staff_attachments_checked && changes.every(change =>
        change.op === 'remove' ? pointer(updated, change.path).value == null
          : sameValue(pointer(updated, change.path).value, change.value));
      applyProposal(updated);
      if (!matches) cache.issues[current.id] = { kind: 'conflict', message: 'The selected guest profile changed. Review the latest details.' };
    } catch (error) {
      if (signal.aborted || expireAuthentication(error, signal)) return;
      cache.issues[current.id] = { kind: error instanceof NavaApiError && error.kind === 'conflict' ? 'conflict' : 'error',
        message: safeOperationError(error) ?? 'Could not save the selected guest profile. Refresh and try again.' };
      try {
        const threadId = snapshotRef.current?.id;
        if (threadId) {
          const latest = await api.getThread(threadId, { signal });
          if (!signal.aborted) applySnapshot(latest);
        }
      } catch (refreshError) { if (!signal.aborted) expireAuthentication(refreshError, signal); }
    } finally {
      if (cache.inFlightEdit === editRequest) cache.inFlightEdit = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function openArtifact(proposalId: string, revision: number, artifactId: string) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || authenticationExpiredRef.current) return;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposalId);
    if (!current || current.revision !== revision || cache.selectedId !== proposalId || Object.keys(cache.drafts[proposalId] ?? {}).length ||
        current.phase === 'staging' || cache.stagePending[proposalId] !== undefined || operationRef.current || cache.inFlightEdit) return;
    const stageJobId = current.stage?.revision === revision ? current.stage.job_id : undefined;
    const stageArtifact = current.stage?.revision === revision ? current.stage.artifacts?.find(item => item.id === artifactId) : undefined;
    const artifact = stageArtifact ?? current.result?.artifacts.find(item => item.id === artifactId);
    if (!artifact) return;
    try {
      const response = await api.getArtifact(artifactId, { signal });
      const blob = await response.blob();
      if (signal.aborted) return;
      const latest = snapshotRef.current?.proposals.find(item => item.id === proposalId);
      if (!latest || latest.revision !== revision || latest.phase === 'staging' || cache.selectedId !== proposalId || Object.keys(cache.drafts[proposalId] ?? {}).length ||
          cache.stagePending[proposalId] !== undefined || operationRef.current || cache.inFlightEdit ||
          (stageArtifact ? latest.stage?.revision !== revision || latest.stage.job_id !== stageJobId || !latest.stage.artifacts?.some(item => item.id === artifactId)
            : !latest.result?.artifacts.some(item => item.id === artifactId))) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (!signal.aborted && !expireAuthentication(error, signal)) setMessage('Could not open this attachment. Try again.');
    }
  }

  async function setAttachmentsChecked(proposal: Proposal, checked: boolean) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !current || current.revision !== proposal.revision || cache.goLocks[proposal.id] ||
        cache.stagePending[proposal.id] !== undefined || Object.keys(cache.drafts[proposal.id] ?? {}).length) return;
    const active: ActiveOperation = { kind: 'attachments', proposalId: proposal.id, signal };
    operationRef.current = active;
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.patchProposal({ proposalId: proposal.id, expectedRevision: proposal.revision, changes: [], staffAttachmentsChecked: checked, signal });
      if (signal.aborted) return;
      if (updated.staff_attachments_checked !== checked) throw new NavaApiError('Attachment review was not saved.', 'invalid_response');
      applyProposal(updated);
      const latest = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
      if (checked && latest?.revision === updated.revision && latest.staff_attachments_checked) delete cache.attachmentNeedsRecheck[proposal.id];
      if (!checked) cache.attachmentNeedsRecheck[proposal.id] = true;
    } catch (error) {
      if (signal.aborted || expireAuthentication(error, signal)) return;
      setMessage('Could not save your attachment review. Refresh and try again.');
      try {
        const threadId = snapshotRef.current?.id;
        if (threadId) {
          const latest = await api.getThread(threadId, { signal });
          if (!signal.aborted) applySnapshot(latest);
        }
      } catch (refreshError) { if (!signal.aborted) expireAuthentication(refreshError, signal); }
    } finally {
      if (operationRef.current === active) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function operation(kind: 'stage' | 'quote' | 'reconcile', proposal: Proposal, quoteId?: string) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit) return;
    if (kind !== 'reconcile' && (cache.stagePending[proposal.id] !== undefined || Object.keys(cache.drafts[proposal.id] ?? {}).length)) return;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!current || current.revision !== proposal.revision || current.phase !== proposal.phase) return;
    if (kind !== 'reconcile' && (cache.issues[current.id] || cache.goLocks[current.id] || !['ready', 'waiting_go'].includes(current.phase))) return;
    if (kind === 'stage' && needsAttachmentReview(current.workflow) &&
        (!current.staff_attachments_checked || cache.attachmentNeedsRecheck[current.id] || !validSavedChildren(current))) return;
    const sequenceBeforeOperation = snapshotRef.current?.event_sequence ?? 0;
    if (kind === 'stage' && (current.workflow === 'quote' || !advertised(capabilities, current.workflow, 'stage'))) return;
    if (kind === 'quote' && (current.workflow !== 'quote' || !quoteId || !hasQuote(current, quoteId) || !advertised(capabilities, current.workflow, 'quote'))) return;
    if (kind === 'reconcile' && !reconcileSupported) return;
    const attemptKey = kind === 'quote' ? JSON.stringify([proposal.id, proposal.revision, quoteId]) : null;
    let idempotencyKey = attemptKey ? cache.quoteAttempts[attemptKey] : undefined;
    if (attemptKey && !idempotencyKey) {
      try { idempotencyKey = crypto.randomUUID(); cache.quoteAttempts[attemptKey] = idempotencyKey; }
      catch { setMessage('Could not start the availability check. Try again.'); return; }
    }
    const currentOperation = { kind, proposalId: proposal.id, signal };
    operationRef.current = currentOperation;
    setMessage(null);
    setBusy(true);
    if (kind === 'reconcile') cache.goLocks[proposal.id] = 'reconciling';
    refreshVersion();
    const request = { proposalId: proposal.id, expectedRevision: proposal.revision, signal };
    try {
      if (kind === 'stage' || kind === 'quote') {
        const accepted = kind === 'stage' ? await api.stage(request)
          : quoteId && idempotencyKey ? await api.quote({ ...request, quoteId, idempotencyKey }) : null;
        if (!accepted) return;
        if (!signal.aborted) {
          if (attemptKey) delete cache.quoteAttempts[attemptKey];
          cache.stagePending[proposal.id] = sequenceBeforeOperation;
          cache.operationStarts[proposal.id] = { phase: 'staging', at: Date.now() };
          applyProposal({ ...proposal, phase: accepted.phase });
        }
      } else {
        await api.reconcile(request);
        if (!signal.aborted) cache.goLocks[proposal.id] = 'uncertain';
      }
      if (!signal.aborted && snapshotRef.current) {
        const threadId = snapshotRef.current.id;
        try {
          const latest = await api.getThread(threadId, { signal });
          if (!signal.aborted) applySnapshot(latest, true, kind === 'stage' || kind === 'quote' ? proposal.id : undefined);
        } catch (error) {
          if (!signal.aborted && !expireAuthentication(error, signal)) setStreamMessage('Could not refresh Nava. Reconnecting to check the latest status.');
        }
        if ((kind === 'stage' || kind === 'quote') && !signal.aborted && cache.stagePending[proposal.id] === sequenceBeforeOperation) {
          void recoverStage(threadId, proposal.id, sequenceBeforeOperation, signal);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (expireAuthentication(error, signal)) return;
      if (kind === 'reconcile') cache.goLocks[proposal.id] = 'uncertain';
      setMessage(safeOperationError(error) ?? (kind === 'quote' ? 'Could not confirm the availability check. Try again to check its status.'
        : `Could not ${kind === 'stage' ? 'check in Infor' : 'check the Save outcome'}. Try again.`));
    } finally {
      if (operationRef.current === currentOperation) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  const proposal = snapshot?.proposals.find(item => item.id === selectedId) ?? null;
  const drafts = proposal ? displayDrafts(cache, proposal.id) : {};
  const issue = proposal ? cache.issues[proposal.id] : undefined;
  const lock = proposal ? cache.goLocks[proposal.id] : undefined;
  const isUncertain = Boolean(proposal && (lock === 'uncertain' || lock === 'reconciling' || proposal.phase === 'uncertain' || proposal.error?.outcome === 'uncertain'));
  const canStage = Boolean(proposal && proposal.workflow !== 'quote' && advertised(capabilities, proposal.workflow, 'stage'));
  const canQuote = Boolean(proposal && proposal.workflow === 'quote' && advertised(capabilities, proposal.workflow, 'quote'));
  const primary = proposal && isUncertain
    ? reconcileSupported ? { label: 'Check Infor', disabled: busy, onClick: () => { void operation('reconcile', proposal); } } : undefined
    : proposal ? workflowPrimaryAction({ proposal, drafts, busy: busy || Boolean(issue) || Boolean(lock) || cache.stagePending[proposal.id] !== undefined ||
        (needsAttachmentReview(proposal.workflow) && (!proposal.staff_attachments_checked || Boolean(cache.attachmentNeedsRecheck[proposal.id]))) || !validSavedChildren(proposal),
      onStage: canStage ? () => { void operation('stage', proposal); } : undefined,
    }) : undefined;

  return <NavaPane email={email} actions={snapshot && snapshot.proposals.length > 0 ? {
    items: snapshot.proposals.map(item => {
      const matching = snapshot.proposals.filter(other => other.workflow === item.workflow);
      const name = `${item.workflow[0].toUpperCase()}${item.workflow.slice(1)}`;
      return { id: item.id, label: matching.length > 1 ? `${name} ${matching.findIndex(other => other.id === item.id) + 1}` : name };
    }),
    selectedId, onSelect: id => { cache.selectedId = id; setSelectedId(id); }, available: [], onAdd: () => {},
  } : undefined} primaryAction={primary && authenticationExpired ? { ...primary, disabled: true } : primary}>
    {authenticationExpired && <PaneMessage tone="error">Your Nava session has expired. Sign in again to continue.{' '}
      <button type="button" onClick={() => { void restoreAuthentication(); }}>{onAuthenticationRequired ? 'Sign in again' : 'Reload pane'}</button>
    </PaneMessage>}
    {message && <PaneMessage tone="error">{message}{!snapshot && <> <button type="button" onClick={() => setOpenAttempt(value => value + 1)}>Try again</button></>}</PaneMessage>}
    {streamMessage && <PaneMessage>{streamMessage}</PaneMessage>}
    {!snapshot && !message && !authenticationExpired && <PaneMessage>Opening this email in Nava…{openingLong && ' This is taking longer than expected. Please wait.'}</PaneMessage>}
    {snapshot && !proposal && <PaneMessage>{bindingUnavailable
      ? 'Nava cannot verify which email this proposal belongs to. Reopen the email or contact support.'
      : 'Nava is reading this email. Actions will appear here when available.'}</PaneMessage>}
    {proposal && <>
      {isUncertain && <PaneMessage tone="error">The Save outcome is unknown. Check Infor before any further Save.</PaneMessage>}
      {issue && <PaneMessage tone="error">{issue.message}
        <ul>{Object.keys(drafts).map(path => {
          const field = proposal.field_specs.find(spec => spec.path === path);
          const current = pointer(proposal, path);
          return <li key={path} data-pii>{field?.label ?? path}: saved value {current.exists ? JSON.stringify(current.value) : 'not provided'}</li>;
        })}</ul>
        <button type="button" disabled={busy || authenticationExpired} onClick={() => { void applyDraftAfterRefresh(proposal.id); }}>Apply my edits</button>{' '}
        <button type="button" disabled={busy || authenticationExpired} onClick={() => { delete cache.issues[proposal.id]; delete cache.drafts[proposal.id]; refreshVersion(); }}>Discard my edits</button>
      </PaneMessage>}
      {Object.keys(drafts).length > 0 && !issue && <PaneMessage>Edits are waiting to be saved.</PaneMessage>}
      <Workflow proposal={proposal} drafts={drafts} onEdit={(path, value) => edit(proposal.id, path, value)} busy={busy || authenticationExpired || Boolean(issue) || Boolean(lock) || cache.stagePending[proposal.id] !== undefined} operationStartedAt={cache.operationStarts[proposal.id]?.at} onOpenArtifact={id => { void openArtifact(proposal.id, proposal.revision, id); }}
        onSelectGuest={proposal.workflow === 'create' ? candidate => { void selectGuest(proposal, candidate); } : undefined}
        onQuote={canQuote && !isUncertain && ['ready', 'waiting_go'].includes(proposal.phase) ? quoteId => { void operation('quote', proposal, quoteId); } : undefined}
        attachmentsChecked={proposal.staff_attachments_checked && !cache.attachmentNeedsRecheck[proposal.id]} attachmentsAttention={(snapshot?.messages ?? []).some(item => item.attachment_status !== 'complete')}
        attachmentMessages={snapshot?.messages ?? []} selectedMessageId={input.selected_message_id} attachmentsBusy={busy || authenticationExpired || Boolean(lock) || cache.stagePending[proposal.id] !== undefined || Object.keys(drafts).length > 0}
        onAttachmentsCheckedChange={checked => { void setAttachmentsChecked(proposal, checked); }} />
    </>}
  </NavaPane>;
}
