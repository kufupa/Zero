import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bindStoredWork,
  quoteAnalysisOf,
  workItemsFromTrpc,
  type RecordFieldEventInput,
  type StoredWork,
} from './backend-bind';
import type { QuoteAnalysis, QuoteBoard, StayGroupRequirement } from './types';

/**
 * The pane's stored read for the selected mail (U4). Ready shows the stored analysis with no model call. Reading is a
 * live read. Failed shows the stored reason until the person asks for a retry. Edits to dates and room fields are
 * logged as field events, one per field path after a quiet period, so five keystrokes make one event.
 */

export const WORK_EVENT_DEBOUNCE_MS = 800;
/** A lookup slower than this reads live, so a slow lookup cannot hold the pane on its reading copy. */
export const STORED_LOOKUP_TIMEOUT_MS = 4000;
const MAX_MS_SINCE_OPEN = 86_400_000;

export type StoredPane =
  | { state: 'loading' }
  | { state: 'reading' }
  | { state: 'failed'; reason: string }
  | { state: 'ready'; analysis: QuoteAnalysis; workItemId: string };

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
type PendingEvent = {
  workItemId: string;
  value: RecordFieldEventInput['value'];
  msSinceOpen: number;
  timer: ReturnType<typeof setTimeout>;
};
export type FieldEvent = { path: string; value: RecordFieldEventInput['value'] };
type Refs = Record<string, { stayId: string; rowId: string | null }>;

/** Date fields of a group patch. They belong to the stay, so every group of that stay takes them. */
export function stayDatesOf(patch: Partial<StayGroupRequirement>): Partial<StayGroupRequirement> {
  return {
    ...(patch.arrivalDate !== undefined ? { arrivalDate: patch.arrivalDate } : {}),
    ...(patch.departureDate !== undefined ? { departureDate: patch.departureDate } : {}),
  };
}

/** The pane's board as the extraction names it. Unknown is no board stated. */
function extractionBoard(board: QuoteBoard): string | null {
  if (board === 'dinner_bb') return 'dbb';
  if (board === 'unknown') return null;
  return board;
}

/**
 * The field events one group patch makes. Dates go to the stay path and room fields to the row path, both by stable
 * id, so deleting one stay cannot shift another stay's values. A group with no row logs stay dates only.
 */
export function fieldEventsFor(refs: Refs, groupId: string, patch: Partial<StayGroupRequirement>): FieldEvent[] {
  const ref = refs[groupId];
  if (!ref) return [];
  const stay = `stays[${ref.stayId}]`;
  const row = ref.rowId ? `${stay}.rows[${ref.rowId}]` : null;
  const events: FieldEvent[] = [];
  if (patch.arrivalDate !== undefined) events.push({ path: `${stay}.requested.arrival`, value: patch.arrivalDate });
  if (patch.departureDate !== undefined) {
    events.push({ path: `${stay}.requested.departure`, value: patch.departureDate });
  }
  if (row) {
    if (patch.quantity !== undefined) events.push({ path: `${row}.count`, value: patch.quantity });
    if (patch.adults !== undefined) events.push({ path: `${row}.adults`, value: patch.adults });
    if (patch.roomPreference !== undefined) events.push({ path: `${row}.roomType`, value: patch.roomPreference });
    if (patch.childrenAges !== undefined) events.push({ path: `${row}.childAges`, value: patch.childrenAges });
    if (patch.board !== undefined) events.push({ path: `${row}.board`, value: extractionBoard(patch.board) });
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
  const trpcRef = useRef(trpc);

  useEffect(() => {
    trpcRef.current = trpc;
  }, [trpc]);

  const send = useCallback((path: string) => {
    const entry = pending.current.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.current.delete(path);
    const recordEvent = workItemsFromTrpc(trpcRef.current).recordEvent;
    // ponytail: a failed log is dropped, not retried. The next edit to the same field logs again.
    void recordEvent
      ?.mutate({
        workItemId: entry.workItemId,
        type: 'field.edit',
        fieldPath: path,
        value: entry.value,
        msSinceOpen: entry.msSinceOpen,
      })
      .catch(() => undefined);
  }, []);

  const flushAll = useCallback(() => {
    // send() deletes the entry it flushes, which a Map iterator allows.
    for (const path of pending.current.keys()) send(path);
  }, [send]);

  const schedule = useCallback(
    (path: string, workItemId: string, value: RecordFieldEventInput['value']) => {
      const existing = pending.current.get(path);
      if (existing) clearTimeout(existing.timer);
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
    pane = { state: 'ready', analysis: quoteAnalysisOf(stored.analysis), workItemId: stored.workItemId };
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

  const recordGroupPatch = useCallback(
    (groupId: string, patch: Partial<StayGroupRequirement>) => {
      if (!readyRefs || !readyWorkItemId) return;
      for (const event of fieldEventsFor(readyRefs, groupId, patch)) {
        schedule(event.path, readyWorkItemId, event.value);
      }
    },
    [readyRefs, readyWorkItemId, schedule],
  );

  /** The other groups of the same stay. A stay's dates reach them as well. */
  const siblingGroupIds = useCallback(
    (groupId: string): string[] => {
      if (!readyRefs) return [];
      const stayId = readyRefs[groupId]?.stayId;
      if (!stayId) return [];
      return Object.keys(readyRefs).filter((id) => id !== groupId && readyRefs[id]?.stayId === stayId);
    },
    [readyRefs],
  );

  return { pane, key, retry, recordGroupPatch, siblingGroupIds };
}
