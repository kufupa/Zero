import { useCallback, useEffect, useRef, useState } from 'react';
import { getMailCacheScope, inMailbox } from '@/lib/mail/mail-cache-scope';
import {
  bindStoredWork,
  quoteAnalysisOf,
  workItemsFromTrpc,
  type ContactField,
  type RecordFieldEventInput,
  type StoredContact,
  type StoredStayCommit,
  type SourcePartyFields,
  type StoredTranslation,
  type StoredWork,
} from './backend-bind';
import type { QuoteAnalysis, QuoteBoard, StayGroupRequirement } from './types';

/**
 * The pane's stored read for the selected mail (U4). Ready shows the stored analysis with no model call. Reading is a
 * live read. Failed shows the stored reason until the person asks for a retry. Edits to dates and room fields, and
 * rows or stays she adds or removes, are logged as field events, one per field path after a quiet period, so five
 * keystrokes make one event. A send that
 * fails is tried once more, then kept and shown as "Couldn't save change" with a retry, so no edit is lost.
 */

export const WORK_EVENT_DEBOUNCE_MS = 800;
/** Wait before the one automatic re-send of a failed field event. */
export const WORK_EVENT_RETRY_MS = 1500;
/** Start the live read after this deadline without discarding a ready stored result that arrives later. */
export const STORED_LOOKUP_TIMEOUT_MS = 4000;
const MAX_MS_SINCE_OPEN = 86_400_000;

export type StoredPane =
  | { state: 'loading' }
  | { state: 'reading' }
  | { state: 'failed'; reason: string }
  | {
      state: 'ready';
      analysis: QuoteAnalysis;
      /** The mail kind and current work-item state, shared with the pane's read-as and work-state banners. */
      kind: string;
      existingStayInformation?: boolean;
      confirmationNumbers?: string[];
      workItemStatus: string | null;
      /** Null when the read has no work item (it could not be opened): the read shows, edits are not logged. */
      workItemId: string | null;
      extractionId: string;
      contact: StoredContact;
      sourcePartyDigest?: string | null;
      /** Last HMS commits for this mail. The Book step shows them again after a reload. */
      savedStays?: Record<string, StoredStayCommit>;
      language: string | null;
      translation: StoredTranslation;
      /** Latest per-path source from getByMessage. Null when the older server omits it. */
      fieldProvenance?: WorkItemProvenanceMap | null;
      refs?: Record<string, { stayId: string; rowId: string | null }>;
    };

export type StoredDecision =
  | { kind: 'wait' }
  | { kind: 'live' }
  | { kind: 'ready'; analysis: QuoteAnalysis }
  | { kind: 'failed'; reason: string };

/**
 * What the analysis effect does with the stored read. A treat-as or staff note asks for a fresh read, so the stored
 * result is not used. Loading waits, so the live read does not start twice.
 */
export function storedDecision(pane: StoredPane, overridden: boolean): StoredDecision {
  if (overridden) return { kind: 'live' };
  if (pane.state === 'loading') return { kind: 'wait' };
  if (pane.state === 'ready') return { kind: 'ready', analysis: pane.analysis };
  if (pane.state === 'failed') return { kind: 'failed', reason: pane.reason };
  return { kind: 'live' };
}

/** One mail's lookup, and the mailbox it was made in: edits to its work item are saved there. */
type LookupResult = StoredWork | { status: 'unavailable' };
type Lookup = {
  key: string;
  transportId: string | null;
  /** The stored payload can arrive after the deadline; it does not own the live-read timeout state. */
  result: LookupResult | null;
  timedOut: boolean;
};
type FieldSend = {
  workItemId: string;
  /** The mailbox that owns the work item. A save queued across a mailbox switch still goes there. */
  transportId: string | null;
  path: string;
  value: RecordFieldEventInput['value'];
  msSinceOpen: number;
};
type PendingEvent = FieldSend & { timer: ReturnType<typeof setTimeout> };
export type FieldEvent = { path: string; value: RecordFieldEventInput['value'] };
type Refs = Record<string, { stayId: string; rowId: string | null }>;
export type WorkItemProvenanceSource = 'ai' | 'staff' | 'unknown';
export type WorkItemProvenanceEntry = { source: WorkItemProvenanceSource; value: unknown };
export type WorkItemProvenanceMap = Record<string, WorkItemProvenanceEntry>;
export type WorkItemSection = { type: 'contact' } | { type: 'stay'; stayId: string };
export type WorkItemHistoryCursor = { revision: number; revisionHead: number };
export type WorkItemPaneControls = {
  fieldProvenance: WorkItemProvenanceMap;
  refs: Record<string, { stayId: string; rowId: string | null }>;
  onResetContact?: () => void;
  onResetStay?: (stayId: string) => void;
  resetPending?: boolean;
};

type HistorySeqCursor = WorkItemHistoryCursor & { seq: number };
type HistoryMutate = (
  input: { workItemId: string; expectedSeq: number },
  opts?: ReturnType<typeof inMailbox>,
) => Promise<unknown>;
type ResetMutate = (
  input: { workItemId: string; section: WorkItemSection },
  opts?: ReturnType<typeof inMailbox>,
) => Promise<unknown>;
type CursorQuery = (
  input: { workItemId: string },
  opts?: ReturnType<typeof inMailbox>,
) => Promise<HistorySeqCursor>;

const HISTORY_STALE = 'history_stale';
const HISTORY_STALE_COPY = "This email was re-read, so older changes can't be undone.";
const HISTORY_REFRESH_COPY = "Saved, but couldn't refresh —";
/** J1 CONFLICT copy. The formatter does not send `cause.code`. */
const HISTORY_STALE_SERVER = 'The mail reading changed. Reload, then undo or redo.';

function messageOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** J1 may throw or return this typed error while that PR is still landing. */
function historyStaleOf(value: unknown): boolean {
  if (value === HISTORY_STALE) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const shape =
    record.shape && typeof record.shape === 'object' && !Array.isArray(record.shape)
      ? (record.shape as Record<string, unknown>)
      : null;
  const shapeData =
    shape?.data && typeof shape.data === 'object' && !Array.isArray(shape.data)
      ? (shape.data as Record<string, unknown>)
      : null;
  const messages = [record.message, shape?.message, record.error].map(messageOf);
  if (messages.some((message) => message === HISTORY_STALE_SERVER || message.includes('mail reading changed'))) {
    return true;
  }
  return [
    record.error,
    record.message,
    record.code,
    data?.code,
    data?.error,
    shape?.message,
    shapeData?.code,
  ].some((token) => token === HISTORY_STALE);
}

function historyMoveErrorCopy(error: unknown, fallback: string): string {
  return historyStaleOf(error) ? HISTORY_STALE_COPY : fallback;
}

/** Older servers omit these routes; the pane hides the controls then. */
function historyRoutesFrom(trpc: unknown): {
  revisionCursor: { query: CursorQuery } | null;
  undoRevision: { mutate: HistoryMutate } | null;
  redoRevision: { mutate: HistoryMutate } | null;
  resetSection: { mutate: ResetMutate } | null;
} {
  const workItems = (trpc as {
    workItems?: {
      revisionCursor?: { query?: CursorQuery };
      undoRevision?: { mutate?: HistoryMutate };
      redoRevision?: { mutate?: HistoryMutate };
      resetSection?: { mutate?: ResetMutate };
    };
  } | null)?.workItems;
  const query = workItems?.revisionCursor?.query;
  const undo = workItems?.undoRevision?.mutate;
  const redo = workItems?.redoRevision?.mutate;
  const reset = workItems?.resetSection?.mutate;
  return {
    revisionCursor: typeof query === 'function' ? { query } : null,
    undoRevision: typeof undo === 'function' ? { mutate: undo } : null,
    redoRevision: typeof redo === 'function' ? { mutate: redo } : null,
    resetSection: typeof reset === 'function' ? { mutate: reset } : null,
  };
}

export function sectionHasStaffEdit(
  provenance: WorkItemProvenanceMap | null | undefined,
  section: WorkItemSection,
): boolean {
  if (!provenance) return false;
  for (const [path, entry] of Object.entries(provenance)) {
    if (fieldPathInSection(path, section) && entry.source === 'staff') return true;
  }
  return false;
}

function fieldPathInSection(path: string, section: WorkItemSection): boolean {
  if (section.type === 'contact') return path.startsWith('contact.');
  const prefix = `stays[${section.stayId}]`;
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** The pane's board as the extraction names it. Unknown is no board stated. */
function extractionBoard(board: QuoteBoard): string | null {
  if (board === 'dinner_bb') return 'dbb';
  if (board === 'unknown') return null;
  return board;
}

/** Ids the server takes in a field path. The pane's own date-made stay ids ("d:…") are not stable ids. */
const STABLE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A row's stay and row id: the stored read's, or its own for a row she added or copied. */
function refOf(refs: Refs, group: StayGroupRequirement): Refs[string] | null {
  const stored = refs[group.id];
  if (stored) return stored;
  return group.stayId && STABLE_ID.test(group.stayId) && STABLE_ID.test(group.id)
    ? { stayId: group.stayId, rowId: group.id }
    : null;
}

function datesAt(stay: string, group: StayGroupRequirement): FieldEvent[] {
  return [
    { path: `${stay}.requested.arrival`, value: group.arrivalDate || null },
    { path: `${stay}.requested.departure`, value: group.departureDate || null },
  ];
}

function rowFieldsAt(row: string, group: StayGroupRequirement): FieldEvent[] {
  return [
    { path: `${row}.count`, value: group.quantity ?? null },
    { path: `${row}.adults`, value: group.adults ?? null },
    { path: `${row}.roomType`, value: group.roomPreference || null },
    { path: `${row}.childrenPerRoom`, value: group.childrenPerRoom ?? null },
    { path: `${row}.childAges`, value: group.childrenAges },
    { path: `${row}.board`, value: extractionBoard(group.board) },
  ];
}

/**
 * The row id for room values on a stay the read gave dates but no rows. It is made from the stay id, so every edit to
 * that stay lands on the same row, and on reopen the stay comes back with that row.
 */
export function stayRowId(stayId: string): string {
  return `${stayId}_row`;
}

const CONTACT_PATHS = ['name', 'company', 'endClient', 'email', 'phone'].map((field) => `contact.${field}`);

/**
 * The extraction field paths the pane shows for these groups and the contact block. A group with no stored ref (a row
 * she added) has no path. Only names are sent: the server reads each AI value and skips any field she edited.
 */
export function shownFieldPaths(refs: Refs, groups: StayGroupRequirement[]): string[] {
  const paths: string[] = [];
  for (const group of groups) {
    const ref = refOf(refs, group);
    if (!ref) continue;
    const stay = `stays[${ref.stayId}]`;
    paths.push(...datesAt(stay, group).map((event) => event.path));
    const rowId = ref.rowId ?? stayRowId(ref.stayId);
    if (STABLE_ID.test(rowId)) paths.push(...rowFieldsAt(`${stay}.rows[${rowId}]`, group).map((event) => event.path));
  }
  return [...paths, ...CONTACT_PATHS];
}

function sameValue(a: FieldEvent['value'] | undefined, b: FieldEvent['value']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Whether a row's count moved only because the stay total set it or took it back. The server derives that default from
 * the total for as long as no count is saved for the row, so the move is not saved: saved, it would read as a staff count
 * on reopen and the default would stop following the rows. A count she sets or clears on a defaulted row is hers.
 */
function countFromStayTotal(group: StayGroupRequirement, old: StayGroupRequirement | undefined): boolean {
  if (group.fields.quantity === 'defaulted') return true;
  return old?.fields.quantity === 'defaulted' && group.fields.quantity !== 'staff_corrected';
}

/**
 * The field events between the rows before and after one edit. Paths use stable ids, so removing one stay never moves
 * another stay's values. A stay's dates go to the stay path. A row or stay that appears logs `.removed: null` (it
 * exists) plus its values; one that goes logs `.removed: true`. Rows with no stable id (the blank reading stay) log
 * nothing. A count that only the stay total moved is not logged (countFromStayTotal).
 */
export function fieldEventsBetween(
  refs: Refs,
  before: StayGroupRequirement[],
  after: StayGroupRequirement[],
): FieldEvent[] {
  const events: FieldEvent[] = [];
  const prior = new Map(before.map((group) => [group.id, group]));
  const priorStay = new Map<string, StayGroupRequirement>();
  for (const group of before) {
    const ref = refOf(refs, group);
    if (ref && !priorStay.has(ref.stayId)) priorStay.set(ref.stayId, group);
  }
  // `always` paths are logged even when the value is unchanged: a default she confirms as her own count.
  const changed = (now: FieldEvent[], then: FieldEvent[] | null, always?: ReadonlySet<string>) => {
    const old = new Map(then?.map((event) => [event.path, event.value]));
    for (const event of now) {
      const forced = always?.has(event.path) ?? false;
      if (forced || (then ? !sameValue(old.get(event.path), event.value) : event.value !== null)) events.push(event);
    }
  };
  for (const group of after) {
    const ref = refOf(refs, group);
    if (!ref) continue;
    const stay = `stays[${ref.stayId}]`;
    const old = prior.get(group.id);
    const oldStay = old ?? priorStay.get(ref.stayId);
    if (!oldStay) events.push({ path: `${stay}.removed`, value: null });
    changed(datesAt(stay, group), oldStay ? datesAt(stay, oldStay) : null);
    // A stay with dates and no rows still shows room controls. Her values there go on the stay's own row, which is
    // removed and put back like any other row.
    const rowId = ref.rowId ?? stayRowId(ref.stayId);
    if (!STABLE_ID.test(rowId)) continue;
    const row = `${stay}.rows[${rowId}]`;
    if (!old) events.push({ path: `${row}.removed`, value: null });
    const count = `${row}.count`;
    const fromTotal = countFromStayTotal(group, old);
    const confirmed = old?.fields.quantity === 'defaulted' && !fromTotal;
    // A dates-only stay has no source row: an explicit zero must save its empty age list too.
    const confirmedNoChildren = old && group.childrenPerRoom === 0 && old.childrenPerRoom !== 0;
    const always = new Set<string>();
    if (confirmed) always.add(count);
    if (confirmedNoChildren) always.add(`${row}.childAges`);
    changed(
      rowFieldsAt(row, group).filter((event) => !fromTotal || event.path !== count),
      old ? rowFieldsAt(row, old) : null,
      always,
    );
  }
  const kept = new Set(after.map((group) => group.id));
  const keptStays = new Set(after.flatMap((group) => refOf(refs, group)?.stayId ?? []));
  for (const group of before) {
    const ref = kept.has(group.id) ? null : refOf(refs, group);
    if (!ref) continue;
    const rowId = ref.rowId ?? stayRowId(ref.stayId);
    if (STABLE_ID.test(rowId)) events.push({ path: `stays[${ref.stayId}].rows[${rowId}].removed`, value: true });
    if (!keptStays.has(ref.stayId)) events.push({ path: `stays[${ref.stayId}].removed`, value: true });
  }
  return events;
}

/** One save slot: a field of one work item, so the same field on two mails never shares a pending or failed save. */
function saveKey(workItemId: string, path: string): string {
  return `${workItemId}\n${path}`;
}

export function useStoredWork(args: {
  trpc: unknown;
  internetMessageId: string | null;
  /** Read an existing item without opening a new work item when this is a non-actionable channel/system message. */
  openMissingWorkItem?: boolean;
  /** The signed-in user, session and mailbox. A mailbox switch looks the mail up again in the new mailbox. */
  scope?: string | null;
  /** Centurion quotes bind the party facts the pane has actually seen. */
  verifyQuotePartySource?: boolean;
}) {
  const { trpc, internetMessageId } = args;
  const openMissingWorkItem = args.openMissingWorkItem !== false;
  const scope = args.scope ?? '';
  // The lookup is for this mail in this mailbox. Either changing makes the last lookup someone else's.
  const lookupKey = internetMessageId ? `${scope}\n${internetMessageId}` : null;
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const selection = useRef({ key: lookupKey, epoch: 0 });
  if (selection.current.key !== lookupKey) selection.current = { key: lookupKey, epoch: selection.current.epoch + 1 };
  const renderEpoch = selection.current.epoch;
  const editEpoch = useRef(0);
  const partyEdits = useRef(new Map<string, { epoch: number; extractionId: string; fields: SourcePartyFields | null }>());
  const confirmedParty = useRef(new Map<string, { epoch: number; extractionId: string; digest: string }>());
  const [partySourceProblem, setPartySourceProblem] = useState<{ key: string; message: string } | null>(null);
  const retryPartySource = useRef<() => void>(() => undefined);
  // Retries asked for on the mail on screen. A retry reads live, so the stored failure stops showing for that mail.
  const [retries, setRetries] = useState<{ messageId: string | null; count: number }>({ messageId: null, count: 0 });
  const readyAt = useRef(0);
  const pending = useRef(new Map<string, PendingEvent>());
  // The newest send per save slot, so an older send's failure never stands in for a newer value.
  const latest = useRef(new Map<string, FieldSend>());
  // The send in flight per save slot. The next one waits for it, so an older value never lands after a newer one.
  const inFlight = useRef(new Map<string, Promise<void>>());
  // Sends that failed twice. Kept across mail changes until a retry or a newer edit to the same field.
  const failed = useRef(new Map<string, FieldSend>());
  // Every save slot she edited on this screen. A save still pending, failed or retrying has not reached the server yet,
  // so its field is never sent as an accept.
  const edited = useRef(new Set<string>());
  const [saveFailed, setSaveFailed] = useState(false);
  // The work item whose translation is being asked for again, so "Translating…" shows for that mail only.
  const [translating, setTranslating] = useState<string | null>(null);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<HistorySeqCursor | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  // Guard synchronous callbacks as well as the next render while a history action is in flight.
  const historyPendingRef = useRef(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyNeedsReload, setHistoryNeedsReload] = useState(false);
  const [cursorEpoch, setCursorEpoch] = useState(0);
  const trpcRef = useRef(trpc);
  const lookupKeyRef = useRef(lookupKey);
  lookupKeyRef.current = lookupKey;

  useEffect(() => {
    trpcRef.current = trpc;
  }, [trpc]);

  const post = useCallback((entry: FieldSend, retried: boolean) => {
    const recordEvent = workItemsFromTrpc(trpcRef.current).recordEvent;
    if (!recordEvent) return;
    const key = saveKey(entry.workItemId, entry.path);
    latest.current.set(key, entry);
    const send = async () => {
      // A newer value queued behind this one is sent instead.
      if (latest.current.get(key) !== entry) return;
      try {
        const input = {
          workItemId: entry.workItemId,
          type: 'field.edit' as const,
          fieldPath: entry.path,
          value: entry.value,
          msSinceOpen: entry.msSinceOpen,
        };
        const pinned = inMailbox(entry.transportId);
        await (pinned ? recordEvent.mutate(input, pinned) : recordEvent.mutate(input));
        if (latest.current.get(key) === entry) latest.current.delete(key);
        setCursorEpoch((n) => n + 1);
      } catch {
        if (latest.current.get(key) !== entry) return;
        if (!retried) {
          setTimeout(() => {
            if (latest.current.get(key) === entry) post(entry, true);
          }, WORK_EVENT_RETRY_MS);
          return;
        }
        failed.current.set(key, entry);
        setSaveFailed(true);
      }
    };
    // Nothing in flight: send now, so an unmount flush reaches the server before the pane goes.
    const prior = inFlight.current.get(key);
    const run = prior ? prior.then(send) : send();
    inFlight.current.set(key, run);
    void run.finally(() => {
      if (inFlight.current.get(key) === run) inFlight.current.delete(key);
    });
  }, []);

  const send = useCallback(
    (key: string) => {
      const entry = pending.current.get(key);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.current.delete(key);
      post(
        {
          workItemId: entry.workItemId,
          transportId: entry.transportId,
          path: entry.path,
          value: entry.value,
          msSinceOpen: entry.msSinceOpen,
        },
        false,
      );
    },
    [post],
  );

  /** Sends every failed change again. One that fails twice more shows the retry again. */
  const retrySave = useCallback(() => {
    const entries = [...failed.current.values()];
    failed.current.clear();
    setSaveFailed(false);
    for (const entry of entries) post(entry, false);
    retryPartySource.current();
  }, [post]);

  const flushAll = useCallback(() => {
    // send() deletes the entry it flushes, which a Map iterator allows.
    for (const key of pending.current.keys()) send(key);
  }, [send]);

  const dropQueuedSaves = useCallback((section?: WorkItemSection) => {
    for (const [key, entry] of pending.current) {
      if (section && !fieldPathInSection(entry.path, section)) continue;
      clearTimeout(entry.timer);
      pending.current.delete(key);
    }
  }, []);

  const schedule = useCallback(
    (path: string, workItemId: string, transportId: string | null, value: RecordFieldEventInput['value']) => {
      const key = saveKey(workItemId, path);
      edited.current.add(key);
      const existing = pending.current.get(key);
      if (existing) clearTimeout(existing.timer);
      // A newer value for the field replaces one that failed to save.
      if (failed.current.delete(key)) setSaveFailed(failed.current.size > 0);
      latest.current.delete(key);
      // The clock starts at the field's first change in the quiet window, so later keystrokes do not move it.
      const elapsed = Math.round(Date.now() - readyAt.current);
      const msSinceOpen = existing?.msSinceOpen ?? Math.min(MAX_MS_SINCE_OPEN, Math.max(0, elapsed));
      const timer = setTimeout(() => send(key), WORK_EVENT_DEBOUNCE_MS);
      pending.current.set(key, { workItemId, transportId, path, value, msSinceOpen, timer });
    },
    [send],
  );

  // Without a stored-read route the pane reads live at once, with no extra render before the live read.
  const canLookUp = Boolean(workItemsFromTrpc(trpc).getByMessage);

  // One lookup per mail and mailbox. Switching either or unmounting sends the last mail's pending edits first.
  useEffect(() => {
    if (!internetMessageId || !lookupKey || !canLookUp) return;
    let current = true;
    let settled = false;
    let timedOut = false;
    // The lookup goes out under the active mailbox, so its work item lives there.
    const transportId = getMailCacheScope().activeTransportId;
    const settle = (result: LookupResult) => {
      if (!current || settled) return;
      // A timeout starts the live read. Only a late ready payload can supersede that fallback; a late miss or
      // transport failure leaves the current live-read state alone and keeps Retry available there.
      if (timedOut && result.status !== 'ready') {
        settled = true;
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (result.status === 'ready') readyAt.current = Date.now();
      setLookup({ key: lookupKey, transportId, result, timedOut });
    };
    const timer = setTimeout(() => {
      if (!current || settled) return;
      timedOut = true;
      setLookup({ key: lookupKey, transportId, result: null, timedOut: true });
    }, STORED_LOOKUP_TIMEOUT_MS);
    setLookup({ key: lookupKey, transportId, result: null, timedOut: false });
    const routes = workItemsFromTrpc(trpcRef.current);
    // The deadline covers the stored read. Once it is in, a slow open shows that read rather than reading live.
    void bindStoredWork({
      query: routes.getByMessage,
      open: openMissingWorkItem ? routes.open : undefined,
      internetMessageId,
      transportId,
      isStale: () => !current,
      onRead: () => clearTimeout(timer),
      openTimeoutMs: STORED_LOOKUP_TIMEOUT_MS,
    }).then(settle);
    return () => {
      current = false;
      clearTimeout(timer);
      flushAll();
      if (selection.current.key === lookupKey && selection.current.epoch === renderEpoch) selection.current.epoch += 1;
    };
  }, [internetMessageId, lookupKey, canLookUp, openMissingWorkItem, flushAll]);

  const currentLookup = lookup && lookup.key === lookupKey ? lookup : null;
  const stored = currentLookup?.result ?? null;
  const retried = retries.messageId === internetMessageId ? retries.count : 0;
  let pane: StoredPane;
  if (!internetMessageId || !canLookUp) pane = { state: 'reading' };
  else if (!currentLookup) pane = { state: 'loading' };
  else if (stored?.status === 'ready') {
    pane = {
      state: 'ready',
      analysis: quoteAnalysisOf(stored.analysis),
      kind: stored.kind,
      existingStayInformation: stored.existingStayInformation === true,
      confirmationNumbers: stored.confirmationNumbers ?? [],
      workItemStatus: stored.workItemStatus,
      workItemId: stored.workItemId,
      extractionId: stored.extractionId,
      contact: stored.contact,
      sourcePartyDigest: stored.sourcePartyDigest ?? null,
      savedStays: stored.stays,
      language: stored.language,
      translation: stored.translation,
      fieldProvenance: provenanceOf(stored),
      refs: stored.refs,
    };
  } else if (stored?.status === 'failed' && retried === 0) {
    pane = { state: 'failed', reason: stored.reason };
  } else if (currentLookup.timedOut || stored) pane = { state: 'reading' };
  else pane = { state: 'loading' };

  // Changes when the stored read changes or a retry is asked for, so the pane's analysis effect re-runs on it.
  const key = [
    internetMessageId ?? '',
    pane.state,
    pane.state === 'ready' ? (pane.workItemId ?? '') : '',
    pane.state === 'failed' ? pane.reason : '',
    String(retried),
    String(historyEpoch),
  ].join('|');

  const readyRefs = stored?.status === 'ready' ? stored.refs : null;
  const readyWorkItemId = stored?.status === 'ready' ? stored.workItemId : null;
  const readyTransportId = currentLookup?.transportId ?? null;

  /** Wait until the selected email's pending edits have actually reached the server. */
  const flushEdits = useCallback(async (): Promise<boolean> => {
    if (!readyWorkItemId || !lookupKey || !internetMessageId || selection.current.epoch !== renderEpoch ||
        historyPendingRef.current || historyPending || historyNeedsReload ||
        !workItemsFromTrpc(trpcRef.current).recordEvent) return false;
    const epoch = renderEpoch;
    const fail = (message: string) => {
      if (selection.current.key === lookupKey && selection.current.epoch === epoch)
        setPartySourceProblem({ key: lookupKey, message });
      return false;
    };
    const prefix = `${readyWorkItemId}\n`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      flushAll();
      const active = [...inFlight.current.entries()]
        .filter(([key]) => key.startsWith(prefix)).map(([, promise]) => promise);
      if (active.length) await Promise.allSettled(active);
      if (historyPendingRef.current || lookupKeyRef.current !== lookupKey || selection.current.epoch !== epoch) return false;
      if ([...pending.current.keys()].some((key) => key.startsWith(prefix))) continue;
      if ([...latest.current.keys(), ...failed.current.keys()].some((key) => key.startsWith(prefix))) return false;
      const party = partyEdits.current.get(lookupKey);
      if (party) {
        const query = workItemsFromTrpc(trpcRef.current).getByMessage;
        if (!query || !party.fields) return fail('Refresh the email before getting rates.');
        const revision = editEpoch.current;
        try {
          const input = { internetMessageId };
          const pinned = inMailbox(readyTransportId);
          const read = await (pinned ? query.query(input, pinned) : query.query(input));
          if (historyPendingRef.current || selection.current.key !== lookupKey || selection.current.epoch !== epoch ||
              editEpoch.current !== revision || partyEdits.current.get(lookupKey) !== party) return false;
          if (read.status !== 'ready' || read.workItemId !== readyWorkItemId || read.extractionId !== party.extractionId ||
              JSON.stringify(read.sourcePartyFields) !== JSON.stringify(party.fields) ||
              !read.sourcePartyDigest || !/^[a-f0-9]{64}$/.test(read.sourcePartyDigest)) {
            return fail('The saved agency or company changed. Refresh the email before getting rates.');
          }
          const current = lookupRef.current;
          const seen = current?.key === lookupKey && current.result?.status === 'ready' ? current.result : null;
          if (party.epoch !== epoch && (!seen || seen.extractionId !== read.extractionId ||
              seen.sourcePartyDigest !== read.sourcePartyDigest)) {
            if (!seen || seen.extractionId !== read.extractionId) return fail('Refresh the email before getting rates.');
            // Show a party saved after this visit's read and let the pane invalidate the old HMS pick.
            partyEdits.current.delete(lookupKey);
            confirmedParty.current.delete(lookupKey);
            setLookup((prev) => !historyPendingRef.current && selection.current.key === lookupKey &&
              selection.current.epoch === epoch && prev && prev.key === lookupKey && prev.result?.status === 'ready' &&
              prev.result.extractionId === read.extractionId
              ? { ...prev, result: { ...prev.result, contact: { ...prev.result.contact,
                  company: read.contact.company, endClient: read.contact.endClient },
                  sourcePartyDigest: read.sourcePartyDigest, sourcePartyFields: read.sourcePartyFields } } : prev);
            return fail('The saved agency or company changed. Review it before getting rates.');
          }
          confirmedParty.current.set(lookupKey, { epoch, extractionId: read.extractionId, digest: read.sourcePartyDigest });
          partyEdits.current.delete(lookupKey);
          setLookup((prev) => !historyPendingRef.current && selection.current.key === lookupKey &&
            selection.current.epoch === epoch && prev && prev.key === lookupKey && prev.result?.status === 'ready' &&
            prev.result.extractionId === read.extractionId
            ? { ...prev, result: { ...prev.result, sourcePartyDigest: read.sourcePartyDigest,
                sourcePartyFields: read.sourcePartyFields } } : prev);
        } catch {
          return fail("The change was saved, but the agency or company couldn't be refreshed. Retry saving.");
        }
      }
      setPartySourceProblem((problem) => problem?.key === lookupKey ? null : problem);
      return true;
    }
    return false;
  }, [flushAll, historyNeedsReload, historyPending, internetMessageId, lookupKey, readyTransportId, readyWorkItemId, renderEpoch]);

  retryPartySource.current = () => {
    if (partySourceProblem?.key === lookupKey) void flushEdits();
  };

  const retry = useCallback(() => {
    if (!internetMessageId) return;
    setRetries((prev) => ({
      messageId: internetMessageId,
      count: (prev.messageId === internetMessageId ? prev.count : 0) + 1,
    }));
  }, [internetMessageId]);

  /** Logs one edit (a field patch or a stay/row action) as field events. Only a stored read has a work item. */
  const recordGroups = useCallback(
    (before: StayGroupRequirement[], after: StayGroupRequirement[]) => {
      if (selection.current.key !== lookupKey || selection.current.epoch !== renderEpoch ||
          historyPendingRef.current || historyPending || historyNeedsReload) return;
      editEpoch.current += 1;
      if (!readyRefs || !readyWorkItemId) return;
      const events = fieldEventsBetween(readyRefs, before, after);
      if (events.length) {
        setLookup((prev) =>
          selection.current.key === lookupKey && selection.current.epoch === renderEpoch &&
          prev && prev.key === lookupKey && prev.result?.status === 'ready'
            ? { ...prev, result: withStaffPaths(prev.result, events) }
            : prev,
        );
      }
      for (const event of events) {
        schedule(event.path, readyWorkItemId, readyTransportId, event.value);
      }
    },
    [historyNeedsReload, historyPending, lookupKey, readyRefs, readyWorkItemId, readyTransportId, renderEpoch, schedule],
  );

  /** Logs one contact edit as a `contact.<field>` event. Nothing is logged until the mail has a stored read. */
  const recordContact = useCallback(
    (field: ContactField, value: string | null) => {
      if (selection.current.key !== lookupKey || selection.current.epoch !== renderEpoch ||
          historyPendingRef.current || historyPending || historyNeedsReload) return;
      editEpoch.current += 1;
      if (args.verifyQuotePartySource && lookupKey && (field === 'company' || field === 'endClient')) {
        const current = lookupRef.current;
        const pendingParty = partyEdits.current.get(lookupKey);
        const previous = pendingParty?.epoch === renderEpoch ? pendingParty : null;
        const ready = current?.key === lookupKey && current.result?.status === 'ready' ? current.result : null;
        const fields = previous ? previous.fields : ready?.sourcePartyFields ?? null;
        const updated = fields ? { ...fields, [field]: value === null ? ['cleared'] : ['value', value] } as SourcePartyFields : null;
        partyEdits.current.set(lookupKey, { epoch: renderEpoch, extractionId: previous?.extractionId ?? ready?.extractionId ?? '', fields: updated });
        confirmedParty.current.delete(lookupKey);
      }
      // The stored read takes the edit at once, so the HMS notes agree with the Contact block before the save lands.
      setLookup((prev) =>
        selection.current.key === lookupKey && selection.current.epoch === renderEpoch &&
        prev && prev.key === lookupKey && prev.result?.status === 'ready'
          ? {
              ...prev,
              result: withStaffPaths(
                { ...prev.result, contact: { ...prev.result.contact, [field]: value },
                  ...(args.verifyQuotePartySource && (field === 'company' || field === 'endClient')
                    ? { sourcePartyDigest: null, sourcePartyFields: partyEdits.current.get(lookupKey ?? '')?.fields ?? null } : {}) },
                [{ path: `contact.${field}`, value }],
              ),
            }
          : prev,
      );
      if (!readyWorkItemId) return;
      schedule(`contact.${field}`, readyWorkItemId, readyTransportId, value);
    },
    [args.verifyQuotePartySource, historyNeedsReload, historyPending, lookupKey, readyWorkItemId, readyTransportId, renderEpoch, schedule],
  );

  /**
   * Called when she proceeds with the read (Get rates). The fields shown for these groups and the contact block go to the
   * server as accepts (v5 B2). A field she edited here is never sent, even while its save is pending, failed or being
   * retried, since the server has not seen that edit yet. The server skips any edit it has, so a repeat call adds nothing.
   * It goes out after the saves in flight settle, so an edit she just made lands first. The list is checked again at that
   * point, so an edit made while those saves were out is never accepted. A failed call is dropped: a missing accept only
   * loses a label.
   */
  const acceptUnedited = useCallback(
    (groups: StayGroupRequirement[]) => {
      const accept = workItemsFromTrpc(trpcRef.current).acceptFields;
      if (!accept || !readyWorkItemId || !readyRefs) return;
      flushAll();
      const workItemId = readyWorkItemId;
      const shown = shownFieldPaths(readyRefs, groups);
      const pinned = inMailbox(readyTransportId);
      void Promise.allSettled(inFlight.current.values())
        .then(() => {
          // Every field she edited on this screen, including one still pending, failed or retrying, is left out.
          const fieldPaths = shown.filter((path) => !edited.current.has(saveKey(workItemId, path)));
          if (!fieldPaths.length) return;
          const input = { workItemId, fieldPaths };
          return pinned ? accept.mutate(input, pinned) : accept.mutate(input);
        })
        .catch(() => undefined);
    },
    [readyRefs, readyWorkItemId, readyTransportId, flushAll],
  );

  /**
   * Asks for the stored translation again. The answer replaces the stored translation on the pane, if the same mail is
   * still on screen. A call that fails leaves the translation as it was.
   */
  const retryTranslation = useCallback(() => {
    const retry = workItemsFromTrpc(trpcRef.current).retryTranslation;
    if (!retry || !readyWorkItemId) return;
    const workItemId = readyWorkItemId;
    const settle = () => setTranslating((current) => (current === workItemId ? null : current));
    setTranslating(workItemId);
    retry.mutate({ workItemId }).then((result) => {
      settle();
      if (result.status !== 'done') return;
      setLookup((prev) =>
        prev && prev.result?.status === 'ready' && prev.result.workItemId === workItemId
          ? { ...prev, result: { ...prev.result, translation: result.translation ?? null } }
          : prev,
      );
    }, settle);
  }, [readyWorkItemId]);

  const refetchStored = useCallback(() => {
    const getByMessage = workItemsFromTrpc(trpcRef.current).getByMessage;
    const messageId = internetMessageId;
    const keyNow = lookupKey;
    if (!getByMessage || !messageId || !keyNow) return Promise.resolve();
    const pinned = inMailbox(readyTransportId);
    const input = { internetMessageId: messageId };
    return (pinned ? getByMessage.query(input, pinned) : getByMessage.query(input))
      .then((result) => {
        if (lookupKeyRef.current !== keyNow || selection.current.epoch !== renderEpoch) return;
        const party = partyEdits.current.get(keyNow);
        const pendingParty = readyWorkItemId && ['contact.company', 'contact.endClient'].some((path) => {
          const slot = saveKey(readyWorkItemId, path);
          return [pending.current, inFlight.current, latest.current, failed.current].some((saves) => saves.has(slot));
        });
        if (party && pendingParty) partyEdits.current.set(keyNow, { ...party, epoch: -1 });
        else partyEdits.current.delete(keyNow);
        confirmedParty.current.delete(keyNow);
        if (!pendingParty) setPartySourceProblem((problem) => problem?.key === keyNow ? null : problem);
        setLookup((prev) => (selection.current.key === keyNow && selection.current.epoch === renderEpoch &&
          prev && prev.key === keyNow ? { ...prev, result } : prev));
        setHistoryEpoch((n) => n + 1);
        setHistoryError(null);
        setHistoryNeedsReload(false);
      })
      .catch(() => {
        if (lookupKeyRef.current !== keyNow || selection.current.epoch !== renderEpoch) return;
        setHistoryError(HISTORY_REFRESH_COPY);
        setHistoryNeedsReload(true);
      });
  }, [internetMessageId, lookupKey, readyTransportId, readyWorkItemId, renderEpoch]);

  const historyRoutes = historyRoutesFrom(trpc);
  const historyAvailable = Boolean(readyWorkItemId && historyRoutes.undoRevision && historyRoutes.redoRevision);
  const resetAvailable = Boolean(readyWorkItemId && historyRoutes.resetSection);

  useEffect(() => {
    setHistoryEpoch(0);
    setHistoryCursor(null);
    setHistoryError(null);
    setHistoryNeedsReload(false);
    setCursorEpoch(0);
  }, [lookupKey]);

  useEffect(() => {
    const routes = historyRoutesFrom(trpcRef.current);
    if (!readyWorkItemId || !routes.revisionCursor) {
      setHistoryCursor(null);
      return;
    }
    let current = true;
    const pinned = inMailbox(readyTransportId);
    const input = { workItemId: readyWorkItemId };
    void (pinned ? routes.revisionCursor.query(input, pinned) : routes.revisionCursor.query(input))
      .then((result) => {
        if (
          current &&
          result &&
          Number.isSafeInteger(result.revision) &&
          Number.isSafeInteger(result.revisionHead) &&
          Number.isSafeInteger(result.seq)
        ) {
          setHistoryCursor(result);
        }
      })
      .catch(() => {
        if (current) setHistoryCursor(null);
      });
    return () => {
      current = false;
    };
  }, [readyWorkItemId, readyTransportId, historyEpoch, cursorEpoch]);

  const runHistoryMove = useCallback(
    (mutate: HistoryMutate | undefined, message: string) => {
      const seq = historyCursor?.seq;
      if (!readyWorkItemId || !mutate || seq === undefined || historyPendingRef.current) return;
      const keyNow = lookupKey;
      historyPendingRef.current = true;
      setHistoryPending(true);
      setHistoryError(null);
      setHistoryNeedsReload(false);
      dropQueuedSaves();
      const pinned = inMailbox(readyTransportId);
      const input = { workItemId: readyWorkItemId, expectedSeq: seq };
      void Promise.allSettled(inFlight.current.values())
        .then(() => {
          if (lookupKeyRef.current !== keyNow) return;
          dropQueuedSaves();
          return pinned ? mutate(input, pinned) : mutate(input);
        })
        .then((result) => {
          if (lookupKeyRef.current !== keyNow) return;
          if (historyStaleOf(result)) {
            setHistoryError(HISTORY_STALE_COPY);
            return;
          }
          if (result && typeof result === 'object' && 'seq' in result) {
            const next = result as HistorySeqCursor;
            if (Number.isSafeInteger(next.revision) && Number.isSafeInteger(next.seq)) setHistoryCursor(next);
          }
          return refetchStored();
        })
        .catch((error) => {
          setHistoryError(historyMoveErrorCopy(error, message));
        })
        .finally(() => {
          historyPendingRef.current = false;
          setHistoryPending(false);
        });
    },
    [dropQueuedSaves, historyCursor, lookupKey, readyWorkItemId, readyTransportId, refetchStored],
  );

  const undo = useCallback(
    (_workItemId: string, _expectedRevision: number) => {
      runHistoryMove(historyRoutesFrom(trpcRef.current).undoRevision?.mutate, "Couldn't undo — try again");
    },
    [runHistoryMove],
  );

  const redo = useCallback(
    (_workItemId: string, _expectedRevision: number) => {
      runHistoryMove(historyRoutesFrom(trpcRef.current).redoRevision?.mutate, "Couldn't redo — try again");
    },
    [runHistoryMove],
  );

  const resetSection = useCallback(
    (section: WorkItemSection) => {
      const mutate = historyRoutesFrom(trpcRef.current).resetSection?.mutate;
      if (!readyWorkItemId || !mutate || historyPendingRef.current) return;
      const keyNow = lookupKey;
      historyPendingRef.current = true;
      setHistoryPending(true);
      setHistoryError(null);
      setHistoryNeedsReload(false);
      // Hold only this work item's section and cancel its scheduled automatic retries.
      const held = new Map<string, FieldSend>();
      const belongs = (entry: FieldSend) =>
        entry.workItemId === readyWorkItemId && fieldPathInSection(entry.path, section);
      for (const saves of [failed.current, latest.current]) {
        for (const [key, entry] of saves) {
          if (!belongs(entry)) continue;
          held.set(key, entry);
          saves.delete(key);
        }
      }
      // A debounced edit is newer than any send already in flight for the same field.
      for (const [key, entry] of pending.current) {
        if (!belongs(entry)) continue;
        clearTimeout(entry.timer);
        held.set(key, entry);
        pending.current.delete(key);
      }
      setSaveFailed(failed.current.size > 0);
      const pinned = inMailbox(readyTransportId);
      const input = { workItemId: readyWorkItemId, section };
      let resetSent = false;
      let resetApplied = false;
      void Promise.allSettled(inFlight.current.values())
        .then(() => {
          if (lookupKeyRef.current !== keyNow) return;
          resetSent = true;
          return pinned ? mutate(input, pinned) : mutate(input);
        })
        .then((result) => {
          if (!resetSent) return;
          if (historyStaleOf(result)) {
            if (lookupKeyRef.current === keyNow) setHistoryError(HISTORY_STALE_COPY);
            return;
          }
          resetApplied = true;
          if (lookupKeyRef.current !== keyNow) return;
          return refetchStored();
        })
        .catch((error) => {
          if (lookupKeyRef.current === keyNow) {
            setHistoryError(historyMoveErrorCopy(error, "Couldn't reset — try again"));
          }
        })
        .finally(() => {
          if (!resetApplied) {
            for (const [key, entry] of held) {
              if (!pending.current.has(key) && !latest.current.has(key) && !failed.current.has(key)) {
                failed.current.set(key, entry);
              }
            }
            setSaveFailed(failed.current.size > 0);
          }
          historyPendingRef.current = false;
          setHistoryPending(false);
        });
    },
    [lookupKey, readyWorkItemId, readyTransportId, refetchStored],
  );

  const reloadHistory = useCallback(() => {
    if (historyPendingRef.current) return;
    historyPendingRef.current = true;
    setHistoryPending(true);
    void refetchStored().finally(() => {
      historyPendingRef.current = false;
      setHistoryPending(false);
    });
  }, [refetchStored]);

  return {
    pane,
    key,
    /** True when the stored lookup missed its deadline, independent of whether a ready payload later arrives. */
    lookupTimedOut: currentLookup?.timedOut ?? false,
    /** The mailbox the shown read was looked up in, which owns its work item. Null while no read is shown. */
    transportId: readyWorkItemId ? readyTransportId : null,
    /** How many times the person asked to read this mail again. A live read with a treat-as re-runs on it. */
    retryCount: retried,
    retry,
    recordGroups,
    recordContact,
    acceptUnedited,
    flushEdits,
    /** Read after flush: React may not have rendered the freshly verified digest yet. */
    quoteSourceAfterFlush: () => {
      if (!lookupKey || selection.current.key !== lookupKey || selection.current.epoch !== renderEpoch ||
          partyEdits.current.has(lookupKey)) return { sourcePartyDigest: null, sourceExtractionId: null };
      const confirmed = confirmedParty.current.get(lookupKey);
      if (confirmed?.epoch === renderEpoch) return { sourcePartyDigest: confirmed.digest, sourceExtractionId: confirmed.extractionId };
      const current = lookupRef.current;
      const ready = current?.key === lookupKey && current.result?.status === 'ready' ? current.result : null;
      return { sourcePartyDigest: ready?.sourcePartyDigest ?? null, sourceExtractionId: ready?.extractionId ?? null };
    },
    retryTranslation,
    translationBusy: translating !== null && translating === readyWorkItemId,
    saveFailed: saveFailed || Boolean(partySourceProblem?.key === lookupKey),
    saveError: partySourceProblem?.key === lookupKey ? partySourceProblem.message : null,
    retrySave,
    historyEpoch,
    historyCursor: historyCursor
      ? { revision: historyCursor.revision, revisionHead: historyCursor.revisionHead }
      : null,
    historyPending,
    historyError,
    historyNeedsReload,
    historyAvailable,
    resetAvailable,
    undo,
    redo,
    resetSection,
    reloadHistory,
  };
}

function withStaffPaths(stored: StoredWork, events: FieldEvent[]): StoredWork {
  if (stored.status !== 'ready' || !events.length) return stored;
  const fieldProvenance: WorkItemProvenanceMap = { ...provenanceOf(stored) };
  for (const event of events) {
    fieldProvenance[event.path] = { source: 'staff', value: event.value };
  }
  return { ...stored, fieldProvenance } as StoredWork;
}

function provenanceOf(stored: StoredWork): WorkItemProvenanceMap | null {
  if (stored.status !== 'ready') return null;
  const raw = (stored as { fieldProvenance?: unknown }).fieldProvenance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provenance: WorkItemProvenanceMap = {};
  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = (entry as { source?: unknown }).source;
    if (source !== 'ai' && source !== 'staff' && source !== 'unknown') continue;
    provenance[path] = { source, value: (entry as { value?: unknown }).value };
  }
  return provenance;
}
