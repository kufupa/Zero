'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoundThreadSnapshot, NavaApi } from './api';
import { NavaApiError } from './api';
import { NavaPane, PaneMessage } from './pane';
import type { SelectedEmail } from './pane';
import type { QuoteDraftBinding } from './quote-output-bridge';
import { Workflow, hasWorkflowAction, quoteCheckIssue, workflowPrimaryAction } from './workflow';
import { quoteArtifactIds } from './quote-draft';
import type { DraftValue, GuestCandidate } from './workflow';
import type { StayLookup } from './api';
import { jsonSchema } from './wire';
import type { Capabilities, Change, FieldSpec, Json, Proposal, QuoteSelection, ThreadInput, Workflow as WorkflowName } from './wire';

export type QuoteDraftRequest = {
  proposalId: string; revision: number; quoteId: string; jobId: string; body: string;
  artifacts: NonNullable<NonNullable<Proposal['stage']>['artifacts']>;
  signal: AbortSignal;
  isCurrentSnapshot: () => boolean;
  verifyCurrentSnapshot: () => Promise<boolean>;
};

export type NavaControllerProps = {
  input: ThreadInput | null;
  email: SelectedEmail | null;
  api: NavaApi;
  reconcileSupported?: boolean;
  onAuthenticationRequired?: () => void | Promise<void>;
  onSourceNotEligible?: () => void;
  quoteDraftTarget?: 'webmail' | 'outlook';
  saveQuoteDraft?: (request: QuoteDraftRequest) => Promise<{ status: string; message: string }>;
  findQuoteDraft?: (binding: QuoteDraftBinding) => Promise<boolean>;
  openQuoteDraft?: (binding: QuoteDraftBinding, isCurrent: () => boolean) => Promise<{ subject: string; body: string; files: string[]; to?: string; cc?: string } | null>;
};

type Draft = { value: DraftValue; version: number; base: { exists: boolean; value?: unknown } };
type Drafts = Record<string, Record<string, Draft>>;
type Issue = { kind: 'conflict' | 'error'; message: string };
type GoLock = 'accepted' | 'profile_accepted' | 'uncertain' | 'reconciling';
type ActiveOperation = { kind: 'stage' | 'target' | 'quote' | 'go' | 'reconcile' | 'refresh' | 'attachments' | 'quote_artifacts' | 'quote_draft' | 'context'; proposalId: string; signal: AbortSignal };
type Cache = {
  drafts: Drafts;
  issues: Record<string, Issue>;
  goLocks: Record<string, GoLock>;
  goUncertainAfter: Record<string, number>;
  stagePending: Record<string, number>;
  quoteAttempts: Record<string, string>;
  autoQuotes: Set<string>;
  attachmentNeedsRecheck: Record<string, boolean>;
  operationStarts: Record<string, { phase: Proposal['phase']; at: number }>;
  selectedId: string | null;
  nextVersion: number;
  inFlightEdit: { proposalId: string; signal: AbortSignal } | null;
};

function emptyCache(): Cache {
  return { drafts: {}, issues: {}, goLocks: {}, goUncertainAfter: {}, stagePending: {}, quoteAttempts: {}, autoQuotes: new Set(), attachmentNeedsRecheck: {}, operationStarts: {}, selectedId: null, nextVersion: 0, inFlightEdit: null };
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

function editValue(spec: FieldSpec, draft: DraftValue, workflow: WorkflowName, previous: unknown): { ok: true; value: Json } | { ok: false; message: string } {
  const quoteRequired = workflow === 'quote' && /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/required$/.test(spec.path);
  if (quoteRequired) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { ok: false, message: 'Enter a room and rate code.' };
    const required: Record<string, unknown> = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
    const currentRoom = Array.isArray(required.roomCodes) && typeof required.roomCodes[0] === 'string' ? required.roomCodes[0] : '';
    const currentRate = Array.isArray(required.rateCodes) && typeof required.rateCodes[0] === 'string' ? required.rateCodes[0] : '';
    if (draft.roomCode !== currentRoom) {
      if (draft.roomCode.trim()) required.roomCodes = [draft.roomCode.trim()];
      else delete required.roomCodes;
    }
    if (draft.rateCode !== currentRate) {
      if (draft.rateCode.trim()) required.rateCodes = [draft.rateCode.trim()];
      else delete required.rateCodes;
    }
    const parsed = jsonSchema.safeParse(required);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: 'Could not update the rate code. Refresh the quote.' };
  }
  if (workflow === 'quote' && /\/rooms\/(?:0|[1-9]\d*)\/preferred\/(?:rateCodes|bedTypes|mealPlanBases)$/.test(spec.path)) {
    return typeof draft === 'string' ? { ok: true, value: draft.split(',').map(item => item.trim()).filter(Boolean) }
      : { ok: false, message: `${spec.label}: enter preferences separated by commas.` };
  }
  if (Array.isArray(draft)) {
    const createAges = workflow === 'create' && /^\/bookings\/(?:0|[1-9]\d*)\/fields\/child_ages$/.test(spec.path);
    const quoteAges = workflow === 'quote' && /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/child_ages$/.test(spec.path);
    const maxAge = quoteAges ? 99 : 17;
    if ((!createAges && !quoteAges) ||
        draft.some(age => !/^\d+$/.test(age) || Number(age) > maxAge)) {
      return { ok: false, message: `Enter an age from 0 to ${maxAge} for each child.` };
    }
    return { ok: true, value: draft.map(Number) };
  }
  const quoteChildCount = workflow === 'quote' && /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/children$/.test(spec.path);
  const quoteNumber = workflow === 'quote' && /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/(?:quantity|adults)$/.test(spec.path);
  if (spec.control === 'checkbox' && !quoteChildCount) return typeof draft === 'boolean'
    ? { ok: true, value: draft } : { ok: false, message: `${spec.label}: choose yes or no.` };
  if (typeof draft !== 'string') return { ok: false, message: `${spec.label}: check this value.` };
  if (workflow === 'create' && /^\/bookings\/(?:0|[1-9]\d*)\/fields\/guest_profile_id$/.test(spec.path) && draft === '') return { ok: true, value: null };
  if (spec.control === 'number' || quoteChildCount || quoteNumber) {
    if (!draft.trim()) return { ok: true, value: null };
    const value = Number(draft);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: `${spec.label}: enter a valid number.` };
  }
  return { ok: true, value: draft };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && sameValue(value, (b as Record<string, unknown>)[key]));
}

function validChildren(count: unknown, ages: unknown, quote = false): boolean {
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 && (quote || count <= 16) &&
    Array.isArray(ages) && ages.length === count && ages.every(age => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= (quote ? 99 : 17));
}

function validSavedChildren(proposal: Proposal): boolean {
  return proposal.workflow !== 'create' || proposal.bookings.every(booking => validChildren(booking.fields.child_count, booking.fields.child_ages));
}

function supports(capabilities: Capabilities | null, key: 'tools' | 'workflows', name: string): boolean {
  const value = capabilities?.[key];
  return Array.isArray(value) && value.some(item => item === name);
}

function advertised(capabilities: Capabilities | null, workflow: WorkflowName, operation: 'stage' | 'quote' | 'go'): boolean {
  return capabilities?.auth_ready === true && supports(capabilities, 'workflows', workflow) &&
    capabilities.workflow_capabilities?.[workflow]?.[operation] === true;
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
    case 'REQUIRED_FIELDS_MISSING': return goMissingMessage(error.details);
    case 'FORBIDDEN': return 'You do not have permission to save this booking in Infor.';
    case 'REAL_GUEST_GO_UNAVAILABLE': return 'This request cannot be saved in Infor.';
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

function goMissingMessage(details: unknown): string {
  const fields = details && typeof details === 'object' && !Array.isArray(details) && Array.isArray((details as { fields?: unknown }).fields)
    ? (details as { fields: unknown[] }).fields.filter((item): item is string => typeof item === 'string') : [];
  return fields.length ? `Fill before Go: ${fields.join(', ')}.` : 'Some required details are missing. Fill them in, then try Go again.';
}

// Required fields (server field_specs) whose saved value is still empty. Labels only; never hardcode field lists.
function missingRequired(proposal: Proposal): string[] {
  return proposal.field_specs.filter(spec => {
    if (!spec.required) return false;
    const value = pointer(proposal, spec.path);
    return !value.exists || value.value === null || value.value === undefined || typeof value.value === 'string' && value.value.trim() === '';
  }).map(spec => spec.label);
}

function goReady(proposal: Proposal): boolean {
  return proposal.phase === 'ready' && proposal.stage?.state === 'prepared' && !!proposal.stage.job_id &&
    proposal.stage.revision === proposal.revision &&
    (!proposal.error || proposal.workflow === 'cancel' && proposal.error.code === 'CANCEL_PENALTY_CHANGED' && Boolean(cancellationPenalty(proposal))) &&
    missingRequired(proposal).length === 0;
}

function cancellationPenalty(proposal: Proposal): string | null {
  if (proposal.workflow !== 'cancel') return null;
  const native = proposal.stage?.native_result;
  const fee = proposal.stage?.cancellation_fee ?? (native && typeof native === 'object' && !Array.isArray(native) ? native.cancellation_fee : null);
  return fee && typeof fee === 'object' && !Array.isArray(fee) && fee.state === 'review_required' &&
    typeof fee.text === 'string' && fee.text.trim() ? fee.text : null;
}

function goConfirmation(proposal: Proposal) {
  return JSON.stringify([proposal.id, proposal.revision, proposal.stage?.job_id]);
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

function ThreadController({ input, email, api, cache, reconcileSupported = false, onAuthenticationRequired, onSourceNotEligible, quoteDraftTarget = 'outlook', saveQuoteDraft, findQuoteDraft, openQuoteDraft }: ThreadControllerProps) {
  const [snapshot, setSnapshot] = useState<BoundThreadSnapshot | null>(null);
  const snapshotRef = useRef<BoundThreadSnapshot | null>(null);
  const inputKey = JSON.stringify(input);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [streamMessage, setStreamMessage] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const streamConnectedRef = useRef(false);
  const [bindingUnavailable, setBindingUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState(cache.selectedId);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingQuote, setPendingQuote] = useState<{ proposalId: string; quoteId: string } | null>(null);
  const [confirmedPreparation, setConfirmedPreparation] = useState<string | null>(null);
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
        // Server says Go was refused before dispatch (back to ready with a known error): nothing was saved, so release
        // an accepted Go (or a remounted pending key) and let staff Prepare again. An uncertain lock is never released here.
        const knownGoRefusal = authoritative && latest.phase === 'ready' && latest.error?.outcome === 'known' && proposal.revision === latest.revision;
        if (knownGoRefusal && cache.goLocks[latest.id] !== 'uncertain' && cache.goLocks[latest.id] !== 'reconciling') {
          let pendingKey = false;
          try { pendingKey = Boolean(window.sessionStorage.getItem(goStorageKey(latest.id))); } catch { /* storage unavailable */ }
          if (cache.goLocks[latest.id] === 'accepted' || pendingKey) {
            delete cache.goLocks[latest.id]; delete cache.goUncertainAfter[latest.id]; clearPendingGo(latest.id);
          }
        }
        try {
          const pending = window.sessionStorage.getItem(goStorageKey(latest.id));
          if (pending?.startsWith('profile-accepted:')) {
            const jobId = pending.slice('profile-accepted:'.length);
            if (authoritative && latest.phase === 'ready' && (latest.stage?.job_id === jobId || latest.error?.outcome === 'known')) {
              delete cache.goLocks[latest.id]; clearPendingGo(latest.id);
            } else if (latest.phase === 'staging') cache.goLocks[latest.id] = 'profile_accepted';
            else if (!cache.goLocks[latest.id]) cache.goLocks[latest.id] = 'uncertain';
          } else if (pending && !cache.goLocks[latest.id]) {
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
    streamConnectedRef.current = false;
    setStreamConnected(false);
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
            for await (const event of api.events(thread.id, cursor, { signal, onConnected: () => {
              if (!signal.aborted) { streamConnectedRef.current = true; setStreamConnected(true); setStreamMessage(null); }
            } })) {
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
            streamConnectedRef.current = false;
            if (signal.aborted) return;
            setStreamConnected(false);
            setStreamMessage('Connection interrupted. Reconnecting to Nava.');
          } catch (error) {
            streamConnectedRef.current = false;
            if (signal.aborted) return;
            setStreamConnected(false);
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
          } catch (error) {
            if (signal.aborted) return;
            if (expireAuthentication(error, signal)) return;
          }
        }
      } catch (error) {
        if (signal.aborted || expireAuthentication(error, signal)) return;
        if (error instanceof NavaApiError && error.code === 'source_not_eligible' && onSourceNotEligible) {
          onSourceNotEligible();
          return;
        }
        setMessage('Could not open this email in Nava. Check your connection and try again.');
      }
    }
    void start();
    return () => {
      mounted.current = false;
      streamConnectedRef.current = false;
      window.clearTimeout(openingTimer);
      cancelOwnedWork(signal);
      controller.abort();
    };
  }, [api, cache, inputKey, openAttempt, onSourceNotEligible]);

  useEffect(() => {
    if (!snapshot || busy || authenticationExpired || operationRef.current || cache.inFlightEdit) return;
    const proposal = snapshot.proposals.find(item => item.workflow !== 'quote' && Object.keys(cache.drafts[item.id] ?? {}).length > 0 && !cache.issues[item.id] && !cache.goLocks[item.id]);
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
      const parsed = editValue(spec, draft.value, proposal.workflow, current.value);
      if (!parsed.ok) { cache.issues[proposalId] = { kind: 'error', message: parsed.message }; refreshVersion(); return; }
      changes.push({ op: pointer(proposal, path).exists ? 'replace' : 'add', path, value: parsed.value });
    }
    const childPairs = new Map<string, string>();
    for (const [path] of entries) {
      const create = proposal.workflow === 'create' && /^(\/bookings\/(?:0|[1-9]\d*)\/fields)\/child_(?:count|ages)$/.exec(path);
      const quote = proposal.workflow === 'quote' && /^(\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*))\/(?:children|child_ages)$/.exec(path);
      if (create) childPairs.set(create[1], 'child_count');
      if (quote) childPairs.set(quote[1], 'children');
    }
    for (const [prefix, countField] of childPairs) {
      const countPath = `${prefix}/${countField}`;
      const agesPath = `${prefix}/child_ages`;
      const countChange = changes.find(change => change.path === countPath);
      const agesChange = changes.find(change => change.path === agesPath);
      const count = countChange && countChange.op !== 'remove' ? countChange.value : pointer(proposal, countPath).value;
      const ages = agesChange && agesChange.op !== 'remove' ? agesChange.value : pointer(proposal, agesPath).value;
      if (!validChildren(count, ages, proposal.workflow === 'quote')) {
        cache.issues[proposalId] = { kind: 'error', message: proposal.workflow === 'quote'
          ? 'Enter a child count and an age from 0 to 99 for each child.'
          : 'Enter a child count from 0 to 16 and an age from 0 to 17 for each child.' };
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
        const saved = jsonSchema.safeParse(value.value);
        if (!saved.success) {
          cache.issues[proposalId] = { kind: 'error', message: 'Child count and ages must both be available. Refresh the proposal.' };
          refreshVersion(); return;
        }
        changes.push({ op: 'replace', path, value: saved.data });
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

  async function selectGuest(proposal: Proposal, candidate: GuestCandidate, roomIndex: number) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !current || cache.selectedId !== current.id || current.revision !== proposal.revision || current.workflow !== 'create' || !current.bookings[roomIndex] ||
        !['ready', 'waiting_go'].includes(current.phase) ||
        cache.goLocks[current.id] || cache.issues[current.id] || cache.stagePending[current.id] !== undefined ||
        Object.keys(cache.drafts[current.id] ?? {}).length) return;
    const booking=current.bookings[roomIndex];
    const review=current.profile_reviews.find(item=>item.booking_id===booking.id && item.first_name===booking.fields.first_name && item.last_name===booking.fields.last_name && item.guest_email===(booking.fields.guest_email??null));
    if(!review && current.stage?.revision!==current.revision) return;
    const native = current.stage?.revision===current.revision ? current.stage.native_result : null;
    const room = native && typeof native === 'object' && !Array.isArray(native) ? (current.bookings.length===1 ? native : Array.isArray(native.rooms) ? native.rooms[roomIndex] : null) : null;
    const choices = (room && typeof room==='object' && !Array.isArray(room) ? room.guest_candidates : null) ?? review?.choices;
    const items = choices && typeof choices === 'object' && !Array.isArray(choices) && choices.status !== 'unavailable' && Array.isArray(choices.items) ? choices.items : [];
    if (!/^\d{1,100}$/.test(candidate.nativeId) || !candidate.firstName.trim() || !candidate.lastName.trim() ||
        items.filter(item => item && typeof item === 'object' && !Array.isArray(item) &&
          item.native_id === candidate.nativeId && item.first_name === candidate.firstName && item.last_name === candidate.lastName).length !== 1) return;
    const changes: Change[] = [];
    for (const [field, value] of [['guest_profile_id', candidate.nativeId], ['first_name', candidate.firstName], ['last_name', candidate.lastName]] as const) {
      const path = `/bookings/${roomIndex}/fields/${field}`;
      if (!current.field_specs.some(spec => spec.path === path && spec.editable)) {
        setMessage('Guest profile fields are unavailable. Refresh the proposal.'); return;
      }
      changes.push({ op: pointer(current, path).exists ? 'replace' : 'add', path, value });
    }
    const newPath = `/bookings/${roomIndex}/fields/profile_create_new`;
    if(pointer(current,newPath).value===true) changes.push({op:'replace',path:newPath,value:false});
    const emailPath = `/bookings/${roomIndex}/fields/guest_email`;
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
        current.phase === 'staging' || cache.issues[proposalId] || cache.stagePending[proposalId] !== undefined || operationRef.current || cache.inFlightEdit) return;
    const stageJobId = current.stage?.revision === revision ? current.stage.job_id : undefined;
    const stageArtifact = current.stage?.revision === revision ? current.stage.artifacts?.find(item => item.id === artifactId) : undefined;
    const artifact = stageArtifact ?? current.result?.artifacts.find(item => item.id === artifactId);
    if (!artifact) return;
    try {
      const response = await api.getArtifact(artifactId, { signal });
      const blob = await response.blob();
      if (signal.aborted) return;
      if (blob.size === 0 || blob.type.split(';')[0]?.trim().toLowerCase() !== artifact.mime_type.toLowerCase()) {
        throw new Error('Invalid artifact content');
      }
      const latest = snapshotRef.current?.proposals.find(item => item.id === proposalId);
      if (!latest || latest.revision !== revision || latest.phase === 'staging' || cache.selectedId !== proposalId || Object.keys(cache.drafts[proposalId] ?? {}).length ||
          cache.issues[proposalId] || cache.stagePending[proposalId] !== undefined || operationRef.current || cache.inFlightEdit ||
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

  function currentQuote(proposal: Proposal, quoteId: string, jobId: string) {
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    return current && cache.selectedId === current.id && current.workflow === 'quote' && current.revision === proposal.revision &&
      current.phase === 'ready' && current.stage?.revision === current.revision && current.stage.quote_id === quoteId &&
      current.stage.job_id === jobId && !cache.issues[current.id] && !cache.goLocks[current.id] &&
      cache.stagePending[current.id] === undefined && Object.keys(cache.drafts[current.id] ?? {}).length === 0 ? current : undefined;
  }

  function currentQuoteBinding(proposal: Proposal, binding: QuoteDraftBinding) {
    const current = currentQuote(proposal, binding.quoteId, binding.jobId);
    const ids = current?.stage?.artifacts && quoteArtifactIds(current.stage.artifacts);
    return Boolean(streamConnectedRef.current && binding.proposalId === proposal.id && binding.revision === proposal.revision &&
      ids && sameValue(binding.artifactIds, ids));
  }

  async function openCurrentQuoteDraft(proposal: Proposal, binding: QuoteDraftBinding) {
    const signal = controllerRef.current?.signal, thread = snapshotRef.current;
    const isCurrent = () => Boolean(signal && !signal.aborted && currentQuoteBinding(proposal, binding));
    if (!openQuoteDraft || !signal || !thread || !isCurrent()) throw new Error('The quote changed.');
    try {
      const fresh = await api.getThread(thread.id, { signal });
      const current = fresh.proposals.find(item => item.id === binding.proposalId);
      const ids = current?.stage?.artifacts && quoteArtifactIds(current.stage.artifacts);
      if (!isCurrent() || fresh.id !== thread.id || fresh.selected_message_id !== input.selected_message_id ||
          fresh.event_sequence < (snapshotRef.current?.event_sequence ?? 0) || current?.source_message_id !== input.selected_message_id ||
          current.thread_id !== thread.id || current.session_id !== fresh.session?.id || current.workflow !== 'quote' ||
          current.revision !== binding.revision || current.phase !== 'ready' || current.stage?.revision !== binding.revision ||
          current.stage.quote_id !== binding.quoteId || current.stage.job_id !== binding.jobId || !ids || !sameValue(ids, binding.artifactIds))
        throw new Error('The quote changed.');
      return await openQuoteDraft(binding, isCurrent);
    } catch (error) {
      if (!signal.aborted) expireAuthentication(error, signal);
      throw error;
    }
  }

  async function generateQuoteArtifacts(proposal: Proposal, quoteId: string, selections: QuoteSelection[]) {
    const signal = controllerRef.current?.signal;
    const jobId = proposal.stage?.job_id;
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit || !jobId) return;
    const current = currentQuote(proposal, quoteId, jobId);
    const options = current?.stage?.quote_options ?? [];
    if (!current || current.stage?.artifacts?.length || !selections.length ||
        new Set(selections.map(item => JSON.stringify([item.group_id, item.room_id]))).size !== selections.length ||
        selections.some(item => options.filter(option => option.group_id === item.group_id && option.room_id === item.room_id && option.option_index === item.option_index).length !== 1)) return;
    const active: ActiveOperation = { kind: 'quote_artifacts', proposalId: current.id, signal };
    operationRef.current = active;
    setBusy(true); setMessage(null);
    try {
      await api.quoteArtifacts({ proposalId: current.id, expectedRevision: current.revision, quoteId, selections, signal });
      if (signal.aborted) return;
      const threadId = snapshotRef.current?.id;
      if (!threadId) return;
      const latest = await api.getThread(threadId, { signal });
      if (!signal.aborted) applySnapshot(latest);
    } catch (error) {
      if (!signal.aborted && !expireAuthentication(error, signal)) setMessage(error instanceof NavaApiError && error.kind === 'conflict'
        ? 'The quote changed or the selected options cannot be used. Check Infor again.'
        : 'Could not confirm the quote files. Refresh the proposal before trying again.');
    } finally {
      if (operationRef.current === active) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function saveCurrentQuoteDraft(proposal: Proposal, body: string) {
    const signal = controllerRef.current?.signal;
    const stage = proposal.stage;
    const quoteId = stage?.quote_id, jobId = stage?.job_id;
    const artifacts = stage?.artifacts;
    if (!saveQuoteDraft || !signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !quoteId || !jobId || !artifacts?.length || !currentQuote(proposal, quoteId, jobId)) {
      return { status: 'error', message: 'The quote changed. Review the latest files before saving a draft.' };
    }
    const active: ActiveOperation = { kind: 'quote_draft', proposalId: proposal.id, signal };
    const refs = artifacts.map(item => [item.id, item.name, item.mime_type]);
    operationRef.current = active;
    setBusy(true);
    try {
      const isCurrentSnapshot = () => {
        const current = currentQuote(proposal, quoteId, jobId);
        return !signal.aborted && streamConnectedRef.current && operationRef.current === active && Boolean(current?.stage?.artifacts &&
          sameValue(refs, current.stage.artifacts.map(item => [item.id, item.name, item.mime_type])));
      };
      const verifyCurrentSnapshot = async () => {
        const thread = snapshotRef.current;
        if (!thread || !isCurrentSnapshot()) return false;
        try {
          const fresh = await api.getThread(thread.id, { signal });
          const current = fresh.proposals.find(item => item.id === proposal.id);
          return isCurrentSnapshot() && fresh.id === thread.id && fresh.selected_message_id === input.selected_message_id &&
            fresh.event_sequence >= (snapshotRef.current?.event_sequence ?? 0) && current?.source_message_id === input.selected_message_id &&
            current.thread_id === thread.id && current.session_id === fresh.session?.id && current.workflow === 'quote' &&
            current.revision === proposal.revision && current.phase === 'ready' && current.stage?.revision === current.revision &&
            current.stage.quote_id === quoteId && current.stage.job_id === jobId && Boolean(current.stage.artifacts &&
              sameValue(refs, current.stage.artifacts.map(item => [item.id, item.name, item.mime_type])));
        } catch (error) {
          if (!signal.aborted) expireAuthentication(error, signal);
          return false;
        }
      };
      const result = await saveQuoteDraft({ proposalId: proposal.id, revision: proposal.revision, quoteId, jobId, body, artifacts, signal, isCurrentSnapshot, verifyCurrentSnapshot });
      return result;
    } finally {
      if (operationRef.current === active) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function setAttachmentsChecked(proposal: Proposal, checked: boolean) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !current || current.revision !== proposal.revision || cache.goLocks[proposal.id] || cache.issues[proposal.id] ||
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

  async function addContext(proposal: Proposal, text: string) {
    const signal = controllerRef.current?.signal;
    const thread = snapshotRef.current;
    const current = thread?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || !thread || !text.trim() || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit ||
        !current || cache.selectedId !== current.id || current.revision !== proposal.revision || cache.issues[current.id] ||
        cache.stagePending[current.id] !== undefined || Object.keys(cache.drafts[current.id] ?? {}).length) return 'The request changed. Review it before adding details.';
    const active: ActiveOperation = { kind: 'context', proposalId: current.id, signal };
    operationRef.current = active;
    setBusy(true);
    try {
      await api.sendContext({ threadId: thread.id, proposalId: current.id, text, signal });
      return 'Nava is reviewing these details. Choose the updated request when it appears.';
    } catch (error) {
      if (!signal.aborted) expireAuthentication(error, signal);
      return 'Could not confirm the update. Check the request before trying again.';
    } finally {
      if (operationRef.current === active) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function go(proposal: Proposal) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit) return;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!current || current.revision !== proposal.revision || cache.issues[current.id] || cache.goLocks[current.id] ||
        cache.stagePending[current.id] !== undefined || Object.keys(cache.drafts[current.id] ?? {}).length) return;
    if (!advertised(capabilities, current.workflow, 'go') || !goReady(current) ||
        confirmedPreparation !== goConfirmation(current)) return;
    let idempotencyKey: string;
    try { idempotencyKey = crypto.randomUUID(); window.sessionStorage.setItem(goStorageKey(current.id), idempotencyKey); }
    catch { setMessage('Could not start the Save. Reload the pane and try again.'); return; }
    const currentOperation = { kind: 'go' as const, proposalId: current.id, signal };
    operationRef.current = currentOperation;
    setConfirmedPreparation(null);
    setMessage(null);
    setBusy(true);
    cache.goLocks[current.id] = 'accepted';
    refreshVersion();
    try {
      const accepted = await api.go({ proposalId: current.id, expectedRevision: current.revision, idempotencyKey, signal,
        preparedJobId: current.stage?.job_id, ...(cancellationPenalty(current) ? { confirmPenalty: true } : {}),
      });
      if (signal.aborted) return;
      cache.operationStarts[current.id] = { phase: 'saving', at: Date.now() };
      applyProposal({ ...current, phase: accepted.phase });
      const latest = await api.getThread(snapshotRef.current?.id ?? current.thread_id, { signal }).catch(() => null);
      if (latest && !signal.aborted) applySnapshot(latest, true);
    } catch (error) {
      if (signal.aborted || expireAuthentication(error, signal)) return;
      // A definite refusal (4xx with a known code) means nothing was sent to Infor; anything else is unknown.
      const refused = error instanceof NavaApiError && error.code !== null && error.status !== null && error.status >= 400 && error.status < 500;
      if (refused) { delete cache.goLocks[current.id]; clearPendingGo(current.id); }
      else cache.goLocks[current.id] = 'uncertain';
      setMessage(refused ? safeOperationError(error) ?? 'Nava could not start the Save. Refresh and try again.'
        : 'Infor may have applied this change. Check the stay in HMS before trying again.');
    } finally {
      if (operationRef.current === currentOperation) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function goProfile(proposal: Proposal) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || !current || current.revision !== proposal.revision || operationRef.current || cache.inFlightEdit ||
        authenticationExpiredRef.current || cache.issues[current.id] || cache.goLocks[current.id] ||
        cache.stagePending[current.id] !== undefined || Object.keys(cache.drafts[current.id] ?? {}).length) return;
    let idempotencyKey: string;
    try { idempotencyKey = crypto.randomUUID(); window.sessionStorage.setItem(goStorageKey(current.id), `profile:${idempotencyKey}`); }
    catch { setMessage('Could not start the Guest Profile creation. Reload and try again.'); return; }
    const active: ActiveOperation = { kind: 'go', proposalId: current.id, signal };
    const sequence = snapshotRef.current?.event_sequence ?? 0;
    operationRef.current = active; setBusy(true); setMessage(null); cache.goLocks[current.id] = 'uncertain'; refreshVersion();
    try {
      const accepted = await api.go({ proposalId: current.id, expectedRevision: current.revision, idempotencyKey, createProfile: true, signal });
      if (signal.aborted) return;
      if (!accepted.job_id) throw new Error('Missing profile job');
      window.sessionStorage.setItem(goStorageKey(current.id), `profile-accepted:${accepted.job_id}`);
      cache.goLocks[current.id] = 'profile_accepted';
      cache.stagePending[current.id] = sequence;
      cache.operationStarts[current.id] = { phase: 'staging', at: Date.now() };
      applyProposal({ ...current, phase: accepted.phase });
      const threadId = snapshotRef.current?.id;
      if (threadId) {
        const latest = await api.getThread(threadId, { signal }).catch(() => null);
        if (latest && !signal.aborted) applySnapshot(latest, true, current.id);
        if (!signal.aborted && cache.stagePending[current.id] === sequence) void recoverStage(threadId, current.id, sequence, signal);
      }
    } catch (error) {
      if (signal.aborted || expireAuthentication(error, signal)) return;
      const refused = error instanceof NavaApiError && error.code !== null && error.status !== null && error.status >= 400 && error.status < 500;
      if (refused) { delete cache.goLocks[current.id]; clearPendingGo(current.id); }
      else cache.goLocks[current.id] = 'uncertain';
      setMessage(refused ? safeOperationError(error) ?? 'Could not create the Guest Profile. Review the details.'
        : 'Infor may have created the Guest Profile. Check Infor before trying again.');
    } finally {
      if (operationRef.current === active) operationRef.current = null;
      if (!signal.aborted && mounted.current) { setBusy(false); refreshVersion(); }
    }
  }

  async function operation(kind: 'stage' | 'target' | 'quote' | 'reconcile', proposal: Proposal, quoteId?: string, lookup?: StayLookup) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit) return;
    if (kind !== 'reconcile' && (cache.stagePending[proposal.id] !== undefined || Object.keys(cache.drafts[proposal.id] ?? {}).length)) return;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!current || current.revision !== proposal.revision || current.phase !== proposal.phase || cache.issues[current.id]) return;
    if (kind !== 'reconcile' && (cache.goLocks[current.id] || !['ready', 'waiting_go'].includes(current.phase))) return;
    if (kind === 'stage' && !validSavedChildren(current)) return;
    const sequenceBeforeOperation = snapshotRef.current?.event_sequence ?? 0;
    if (kind === 'stage' && (current.workflow === 'quote' || !advertised(capabilities, current.workflow, 'stage'))) return;
    if (kind === 'target' && (!lookup || !['amend', 'cancel', 'filing'].includes(current.workflow) || !advertised(capabilities, current.workflow, 'stage'))) return;
    if (kind === 'stage' && current.workflow !== 'triage' && (current.disposition !== 'propose' || !hasWorkflowAction(current))) return;
    if (kind === 'quote' && (current.workflow !== 'quote' || !quoteId || !hasQuote(current, quoteId) || quoteCheckIssue(current, quoteId) || !advertised(capabilities, current.workflow, 'quote'))) return;
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
      if (kind === 'stage' || kind === 'quote' || kind === 'target') {
        const accepted = kind === 'stage' ? await api.stage(request)
          : kind === 'target' && lookup ? await api.lookupStay({ ...request, lookup })
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
          if (!signal.aborted) applySnapshot(latest, true, kind === 'stage' || kind === 'quote' || kind === 'target' ? proposal.id : undefined);
        } catch (error) {
          if (!signal.aborted && !expireAuthentication(error, signal)) setStreamMessage('Could not refresh Nava. Reconnecting to check the latest status.');
        }
        if ((kind === 'stage' || kind === 'quote' || kind === 'target') && !signal.aborted && cache.stagePending[proposal.id] === sequenceBeforeOperation) {
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

  async function selectStay(proposal: Proposal, jobId: string, removeFields: string[]) {
    const signal = controllerRef.current?.signal;
    const current = snapshotRef.current?.proposals.find(item => item.id === proposal.id);
    if (!signal || signal.aborted || authenticationExpiredRef.current || operationRef.current || cache.inFlightEdit || !current ||
      cache.selectedId !== current.id || current.revision !== proposal.revision || current.phase !== 'ready' ||
      current.stage?.state !== 'target' || current.stage.job_id !== jobId || current.stage.revision !== current.revision ||
      cache.goLocks[current.id] || cache.issues[current.id] || cache.stagePending[current.id] !== undefined ||
      Object.keys(cache.drafts[current.id] ?? {}).length) return;
    const active: ActiveOperation = { kind: 'target', proposalId: current.id, signal };
    operationRef.current = active; setBusy(true); setMessage(null);
    try {
      const updated = await api.selectStay({ proposalId: current.id, expectedRevision: current.revision, jobId, removeFields, signal });
      if (!signal.aborted) applyProposal(updated);
    } catch (error) {
      if (!signal.aborted && !expireAuthentication(error, signal)) {
        setMessage(safeOperationError(error) ?? 'The stay result changed. Search again.');
        const threadId = snapshotRef.current?.id;
        if (threadId) { const latest = await api.getThread(threadId, { signal }).catch(() => null); if (latest && !signal.aborted) applySnapshot(latest); }
      }
    } finally {
      if (operationRef.current === active) operationRef.current = null;
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
  const canGo = Boolean(proposal && advertised(capabilities, proposal.workflow, 'go'));
  useEffect(() => {
    if (!pendingQuote || busy || authenticationExpired || operationRef.current || cache.inFlightEdit) return;
    const current = snapshotRef.current?.proposals.find(item => item.id === pendingQuote.proposalId);
    if (!current || cache.selectedId !== current.id || cache.issues[current.id] || !advertised(capabilities, 'quote', 'quote')) {
      setPendingQuote(null); return;
    }
    if (Object.keys(cache.drafts[current.id] ?? {}).length) {
      void saveDraft(current.id); return;
    }
    const issue = quoteCheckIssue(current, pendingQuote.quoteId);
    setPendingQuote(null);
    if (issue) { setMessage(issue); return; }
    void operation('quote', current, pendingQuote.quoteId);
  }, [pendingQuote, snapshot, busy, authenticationExpired, version, capabilities]);
  useEffect(() => {
    if (!proposal || !canQuote || busy || pendingQuote || authenticationExpired || proposal.phase !== 'ready' ||
        !['propose', 'staff_review', 'needs_info'].includes(proposal.disposition) || proposal.stage || proposal.error ||
        cache.autoQuotes.has(proposal.id) || cache.issues[proposal.id] || Object.keys(cache.drafts[proposal.id] ?? {}).length) return;
    const action = proposal.actions.find(item => item.type === 'quote' && item.details && typeof item.details === 'object' &&
      !Array.isArray(item.details) && typeof item.details.quote_id === 'string');
    const details = action?.details;
    const quoteId = details && typeof details === 'object' && !Array.isArray(details) && typeof details.quote_id === 'string' ? details.quote_id : null;
    if (!quoteId || quoteCheckIssue(proposal, quoteId)) return;
    cache.autoQuotes.add(proposal.id);
    void operation('quote', proposal, quoteId);
  }, [proposal, canQuote, busy, pendingQuote, authenticationExpired, version]);
  const goEnabled = Boolean(proposal && canGo && goReady(proposal) && !busy && !isUncertain && !lock && !issue && !authenticationExpired &&
    cache.stagePending[proposal.id] === undefined && Object.keys(drafts).length === 0);
  const goMissing = proposal && canGo && proposal.phase === 'ready' && proposal.stage?.state === 'prepared' ? missingRequired(proposal) : [];
  const confirmingGo = Boolean(proposal && goEnabled && confirmedPreparation === goConfirmation(proposal));
  const penalty = proposal ? cancellationPenalty(proposal) : null;
  const needsProfile = proposal?.workflow === 'create' && proposal.bookings.some(booking => booking.fields.profile_create_new === true && !booking.fields.guest_profile_id);
  const goLabels = {
    create: proposal && proposal.bookings.length>1 ? `Save all ${proposal.bookings.length} rooms in Infor?` : 'Save this booking in Infor?',
    amend: 'Save these changes in Infor?',
    cancel: 'Cancel this booking in Infor?',
    filing: 'File this PDF in the stay’s Infor Documents?',
    triage: 'Save in Infor?',
    quote: 'Save in Infor?',
  };
  const stagePrimary = proposal && !isUncertain ? workflowPrimaryAction({ proposal, drafts, busy: busy || Boolean(issue) || Boolean(lock) ||
        cache.stagePending[proposal.id] !== undefined || !validSavedChildren(proposal),
      onStage: canStage && (!needsProfile || canGo) ? () => { if (needsProfile) void goProfile(proposal); else void operation('stage', proposal); } : undefined,
    }) : undefined;
  const primary = proposal && goEnabled
    ? confirmingGo ? undefined : {
      label: proposal.workflow === 'cancel' ? 'Go — cancel in Infor' : proposal.workflow === 'filing' ? 'Go — file PDF' : 'Go — save in Infor',
      onClick: () => setConfirmedPreparation(goConfirmation(proposal)),
    }
    : proposal && isUncertain
    ? reconcileSupported ? { label: 'Check Infor', disabled: busy || Boolean(issue), onClick: () => { void operation('reconcile', proposal); } } : undefined
    : stagePrimary;
  const goFooter = proposal && canGo && !isUncertain && proposal.phase !== 'done' ? <>
    {confirmingGo && proposal && <div role="group" aria-label="Confirm Go">
      <p>{goLabels[proposal.workflow]}</p>
      {penalty && <p>Infor shows this penalty: {penalty}</p>}
      <button type="button" disabled={busy} onClick={() => { void go(proposal); }}>{penalty ? 'Confirm Go and accept fee' : 'Confirm Go'}</button>{' '}
      <button type="button" onClick={() => setConfirmedPreparation(null)}>Back</button>
    </div>}
    {goEnabled && !confirmingGo && stagePrimary && proposal && <button type="button" disabled={stagePrimary.disabled} onClick={stagePrimary.onClick}>Prepare again</button>}
    {goMissing.length > 0 && <p role="status">Fill before Go: {goMissing.join(', ')}</p>}
  </> : undefined;

  return <NavaPane email={email} actions={snapshot && snapshot.proposals.length > 0 ? {
    items: snapshot.proposals.map(item => {
      const matching = snapshot.proposals.filter(other => other.workflow === item.workflow);
      const name = `${item.workflow[0].toUpperCase()}${item.workflow.slice(1)}`;
      return { id: item.id, label: matching.length > 1 ? `${name} ${matching.findIndex(other => other.id === item.id) + 1}` : name };
    }),
    selectedId, onSelect: id => { cache.selectedId = id; setSelectedId(id); }, available: [], onAdd: () => {},
  } : undefined} footer={goFooter || undefined} primaryAction={primary && authenticationExpired ? { ...primary, disabled: true } : primary}>
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
      {isUncertain && <PaneMessage tone="error">{proposal.profile_outcome ? "Infor may have created the Guest Profile. Check Infor before trying again." : "Infor may have saved this booking. Check HMS before trying again."}</PaneMessage>}
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
      <Workflow proposal={proposal} drafts={drafts} onEdit={(path, value) => edit(proposal.id, path, value)} busy={busy || authenticationExpired || issue?.kind === 'conflict' || Boolean(lock) || cache.stagePending[proposal.id] !== undefined} operationStartedAt={cache.operationStarts[proposal.id]?.at} onOpenArtifact={!issue ? id => { void openArtifact(proposal.id, proposal.revision, id); } : undefined}
        onLookupStay={canStage && !issue && !isUncertain ? lookup => { void operation('target', proposal, undefined, lookup); } : undefined}
        onSelectStay={canStage && !issue && !isUncertain ? (jobId, removeFields) => { void selectStay(proposal, jobId, removeFields); } : undefined}
        createdStays={(snapshot?.proposals ?? []).filter(item => item.workflow === 'create').flatMap(item => (item.result?.rooms ?? []).flatMap(room => {
          if (room.state !== 'saved') return [];
          const confirmation = [room.reservation_id, room.confirmation].find(value => typeof value === 'string' && /^\d{6,10}-\d{1,10}$/.test(value));
          const index = item.bookings.findIndex(booking => booking.id === room.booking_id);
          return confirmation && index >= 0 ? [{ bookingId: room.booking_id, confirmation, label: `Room ${index + 1} · ${confirmation}` }] : [];
        }))}
        onSelectGuest={proposal.workflow === 'create' && !issue ? (candidate,index) => { void selectGuest(proposal, candidate,index); } : undefined}
        onQuote={canQuote && !issue && !isUncertain && ['ready', 'waiting_go'].includes(proposal.phase) ? quoteId => { void operation('quote', proposal, quoteId); } : undefined}
        onSubmitQuote={canQuote && !issue && !isUncertain && ['ready', 'waiting_go'].includes(proposal.phase) ? quoteId => { cache.autoQuotes.add(proposal.id); setPendingQuote({ proposalId: proposal.id, quoteId }); } : undefined}
        onGenerateQuoteArtifacts={canQuote && !issue && !isUncertain ? (quoteId, selections) => { void generateQuoteArtifacts(proposal, quoteId, selections); } : undefined}
        quoteDraftTarget={quoteDraftTarget}
        onSaveQuoteDraft={saveQuoteDraft && !issue && !isUncertain ? body => saveCurrentQuoteDraft(proposal, body) : undefined}
        quoteConnectionReady={streamConnected}
        onFindQuoteDraft={findQuoteDraft ? binding => currentQuoteBinding(proposal, binding) ? findQuoteDraft(binding) : Promise.resolve(false) : undefined}
        onOpenQuoteDraft={openQuoteDraft ? binding => openCurrentQuoteDraft(proposal, binding) : undefined}
        onAddContext={!issue && !isUncertain ? text => addContext(proposal, text) : undefined}
        attachmentsChecked={proposal.staff_attachments_checked && !cache.attachmentNeedsRecheck[proposal.id]} attachmentsAttention={(snapshot?.messages ?? []).some(item => item.attachment_status !== 'complete')}
        attachmentMessages={snapshot?.messages ?? []} selectedMessageId={input.selected_message_id} attachmentsBusy={busy || authenticationExpired || Boolean(issue) || Boolean(lock) || cache.stagePending[proposal.id] !== undefined || Object.keys(drafts).length > 0}
        onAttachmentsCheckedChange={checked => { void setAttachmentsChecked(proposal, checked); }} />
    </>}
  </NavaPane>;
}
