import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bindStoredWork,
  quoteAnalysisOf,
  workItemsFromTrpc,
  type ContactField,
  type RecordFieldEventInput,
  type StoredContact,
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
/** A lookup slower than this reads live, so a slow lookup cannot hold the pane on its reading copy. */
export const STORED_LOOKUP_TIMEOUT_MS = 4000;
const MAX_MS_SINCE_OPEN = 86_400_000;

export type StoredPane =
  | { state: 'loading' }
  | { state: 'reading' }
  | { state: 'failed'; reason: string }
  | {
      state: 'ready';
      analysis: QuoteAnalysis;
      workItemId: string;
      contact: StoredContact;
      language: string | null;
      translation: StoredTranslation;
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

type Lookup = { messageId: string; result: StoredWork | { status: 'unavailable' } };
type FieldSend = {
  workItemId: string;
  value: RecordFieldEventInput['value'];
  msSinceOpen: number;
};
type PendingEvent = FieldSend & { timer: ReturnType<typeof setTimeout> };
export type FieldEvent = { path: string; value: RecordFieldEventInput['value'] };
type Refs = Record<string, { stayId: string; rowId: string | null }>;

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
    { path: `${row}.childAges`, value: group.childrenAges },
    { path: `${row}.board`, value: extractionBoard(group.board) },
  ];
}

function sameValue(a: FieldEvent['value'] | undefined, b: FieldEvent['value']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The field events between the rows before and after one edit. Paths use stable ids, so removing one stay never moves
 * another stay's values. A stay's dates go to the stay path. A row or stay that appears logs `.removed: null` (it
 * exists) plus its values; one that goes logs `.removed: true`. Rows with no stable id (the blank reading stay) log
 * nothing.
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
  const changed = (now: FieldEvent[], then: FieldEvent[] | null) => {
    const old = new Map(then?.map((event) => [event.path, event.value]));
    for (const event of now) {
      if (then ? !sameValue(old.get(event.path), event.value) : event.value !== null) events.push(event);
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
    if (!ref.rowId) continue;
    const row = `${stay}.rows[${ref.rowId}]`;
    if (!old) events.push({ path: `${row}.removed`, value: null });
    changed(rowFieldsAt(row, group), old ? rowFieldsAt(row, old) : null);
  }
  const kept = new Set(after.map((group) => group.id));
  const keptStays = new Set(after.flatMap((group) => refOf(refs, group)?.stayId ?? []));
  for (const group of before) {
    const ref = kept.has(group.id) ? null : refOf(refs, group);
    if (!ref) continue;
    if (ref.rowId) events.push({ path: `stays[${ref.stayId}].rows[${ref.rowId}].removed`, value: true });
    if (!keptStays.has(ref.stayId)) events.push({ path: `stays[${ref.stayId}].removed`, value: true });
  }
  return events;
}

export function useStoredWork(args: { trpc: unknown; internetMessageId: string | null }) {
  const { trpc, internetMessageId } = args;
  const [lookup, setLookup] = useState<Lookup | null>(null);
  // Retries asked for on the mail on screen. A retry reads live, so the stored failure stops showing for that mail.
  const [retries, setRetries] = useState<{ messageId: string | null; count: number }>({ messageId: null, count: 0 });
  const readyAt = useRef(0);
  const pending = useRef(new Map<string, PendingEvent>());
  // The newest send per field path, so an older send's failure never stands in for a newer value.
  const latest = useRef(new Map<string, FieldSend>());
  // Sends that failed twice. Kept across mail changes until a retry or a newer edit to the same field.
  const failed = useRef(new Map<string, FieldSend>());
  const [saveFailed, setSaveFailed] = useState(false);
  // The work item whose translation is being asked for again, so "Translating…" shows for that mail only.
  const [translating, setTranslating] = useState<string | null>(null);
  const trpcRef = useRef(trpc);

  useEffect(() => {
    trpcRef.current = trpc;
  }, [trpc]);

  const post = useCallback((path: string, entry: FieldSend, retried: boolean) => {
    const recordEvent = workItemsFromTrpc(trpcRef.current).recordEvent;
    if (!recordEvent) return;
    latest.current.set(path, entry);
    recordEvent
      .mutate({
        workItemId: entry.workItemId,
        type: 'field.edit',
        fieldPath: path,
        value: entry.value,
        msSinceOpen: entry.msSinceOpen,
      })
      .then(
        () => {
          if (latest.current.get(path) === entry) latest.current.delete(path);
        },
        () => {
          if (latest.current.get(path) !== entry) return;
          if (!retried) {
            setTimeout(() => {
              if (latest.current.get(path) === entry) post(path, entry, true);
            }, WORK_EVENT_RETRY_MS);
            return;
          }
          failed.current.set(path, entry);
          setSaveFailed(true);
        },
      );
  }, []);

  const send = useCallback(
    (path: string) => {
      const entry = pending.current.get(path);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.current.delete(path);
      post(path, { workItemId: entry.workItemId, value: entry.value, msSinceOpen: entry.msSinceOpen }, false);
    },
    [post],
  );

  /** Sends every failed change again. One that fails twice more shows the retry again. */
  const retrySave = useCallback(() => {
    const entries = [...failed.current];
    failed.current.clear();
    setSaveFailed(false);
    for (const [path, entry] of entries) post(path, entry, false);
  }, [post]);

  const flushAll = useCallback(() => {
    // send() deletes the entry it flushes, which a Map iterator allows.
    for (const path of pending.current.keys()) send(path);
  }, [send]);

  const schedule = useCallback(
    (path: string, workItemId: string, value: RecordFieldEventInput['value']) => {
      const existing = pending.current.get(path);
      if (existing) clearTimeout(existing.timer);
      // A newer value for the field replaces one that failed to save.
      if (failed.current.delete(path)) setSaveFailed(failed.current.size > 0);
      latest.current.delete(path);
      // The clock starts at the field's first change in the quiet window, so later keystrokes do not move it.
      const elapsed = Math.round(Date.now() - readyAt.current);
      const msSinceOpen = existing?.msSinceOpen ?? Math.min(MAX_MS_SINCE_OPEN, Math.max(0, elapsed));
      const timer = setTimeout(() => send(path), WORK_EVENT_DEBOUNCE_MS);
      pending.current.set(path, { workItemId, value, msSinceOpen, timer });
    },
    [send],
  );

  // Without a stored-read route the pane reads live at once, with no extra render before the live read.
  const canLookUp = Boolean(workItemsFromTrpc(trpc).getByMessage);

  // One lookup per mail. Switching mails or unmounting sends the last mail's pending edits first.
  useEffect(() => {
    if (!internetMessageId || !canLookUp) return;
    let current = true;
    let settled = false;
    const settle = (result: Lookup['result']) => {
      if (!current || settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.status === 'ready') readyAt.current = Date.now();
      setLookup({ messageId: internetMessageId, result });
    };
    const timer = setTimeout(() => settle({ status: 'unavailable' }), STORED_LOOKUP_TIMEOUT_MS);
    setLookup(null);
    void bindStoredWork({ query: workItemsFromTrpc(trpcRef.current).getByMessage, internetMessageId }).then(settle);
    return () => {
      current = false;
      clearTimeout(timer);
      flushAll();
    };
  }, [internetMessageId, canLookUp, flushAll]);

  const stored = lookup && lookup.messageId === internetMessageId ? lookup.result : null;
  const retried = retries.messageId === internetMessageId ? retries.count : 0;
  let pane: StoredPane;
  if (!internetMessageId || !canLookUp) pane = { state: 'reading' };
  else if (!stored) pane = { state: 'loading' };
  else if (stored.status === 'ready') {
    pane = {
      state: 'ready',
      analysis: quoteAnalysisOf(stored.analysis),
      workItemId: stored.workItemId,
      contact: stored.contact,
      language: stored.language,
      translation: stored.translation,
    };
  } else if (stored.status === 'failed' && retried === 0) {
    pane = { state: 'failed', reason: stored.reason };
  } else pane = { state: 'reading' };

  // Changes when the stored read changes or a retry is asked for, so the pane's analysis effect re-runs on it.
  const key = [
    internetMessageId ?? '',
    pane.state,
    pane.state === 'ready' ? pane.workItemId : '',
    pane.state === 'failed' ? pane.reason : '',
    String(retried),
  ].join('|');

  const readyRefs = stored?.status === 'ready' ? stored.refs : null;
  const readyWorkItemId = stored?.status === 'ready' ? stored.workItemId : null;

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
      if (!readyRefs || !readyWorkItemId) return;
      for (const event of fieldEventsBetween(readyRefs, before, after)) {
        schedule(event.path, readyWorkItemId, event.value);
      }
    },
    [readyRefs, readyWorkItemId, schedule],
  );

  /** Logs one contact edit as a `contact.<field>` event. Nothing is logged until the mail has a stored read. */
  const recordContact = useCallback(
    (field: ContactField, value: string | null) => {
      if (!readyWorkItemId) return;
      schedule(`contact.${field}`, readyWorkItemId, value);
    },
    [readyWorkItemId, schedule],
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
        prev && prev.result.status === 'ready' && prev.result.workItemId === workItemId
          ? { ...prev, result: { ...prev.result, translation: result.translation ?? null } }
          : prev,
      );
    }, settle);
  }, [readyWorkItemId]);

  return {
    pane,
    key,
    retry,
    recordGroups,
    recordContact,
    retryTranslation,
    translationBusy: translating !== null && translating === readyWorkItemId,
    saveFailed,
    retrySave,
  };
}
