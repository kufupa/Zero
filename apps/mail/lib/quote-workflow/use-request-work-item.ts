import { useCallback, useEffect, useRef, useState } from 'react';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { workItemsFromTrpc, type AmendDraftSnapshot, type RecordFieldEventInput } from './backend-bind';

type Cursor = { seq: number; revision: number; revisionHead: number };
type Value = RecordFieldEventInput['value'];
type Entry = { value: Value; valid: boolean };
type Session = { key: string; snapshot: AmendDraftSnapshot; transportId: string; entries: Map<string, Entry>; saved: Map<string, Value>;
  running: Promise<boolean> | null; timer: ReturnType<typeof setTimeout> | null; error: string | null; retryable: boolean };

/** Transient, source-bound save queue; the WorkItem projection remains the draft authority. */
export function useRequestWorkItem(args: {
  trpc: unknown; snapshot: AmendDraftSnapshot | null; transportId: string | null;
  flushSnapshot: (snapshot: AmendDraftSnapshot, transportId: string, visible?: boolean) => Promise<Cursor | null>;
  reload: (snapshot: AmendDraftSnapshot, transportId: string) => Promise<AmendDraftSnapshot | null>;
  onSave: (cursor: Cursor) => void;
}) {
  const refs = useRef(args);
  refs.current = args;
  const sessions = useRef(new Map<string, Session>());
  const [, render] = useState(0);
  const key = args.snapshot && args.transportId ? JSON.stringify([args.transportId, args.snapshot.workItemId, args.snapshot.source]) : null;
  let session = key ? sessions.current.get(key) ?? null : null;
  if (!session && key && args.snapshot && args.transportId) {
    session = { key, snapshot: args.snapshot, transportId: args.transportId, entries: new Map(), saved: new Map(), running: null,
      timer: null, error: null, retryable: false };
    sessions.current.set(key, session);
  }
  if (session && args.snapshot && !session.entries.size && !session.running && !session.error) {
    if (session.snapshot.revisionSeq !== args.snapshot.revisionSeq) session.saved.clear();
    session.snapshot = args.snapshot;
  }
  const currentKey = useRef(key);
  currentKey.current = key;
  const changed = useCallback((item: Session) => { if (currentKey.current === item.key) render((n) => n + 1); }, []);
  const pump = useCallback((item: Session): Promise<boolean> => {
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }
    if (item.running) return item.running;
    if (item.error) return Promise.resolve(false);
    if (!item.entries.size) return Promise.resolve(true);
    const run = async () => {
      const mutate = workItemsFromTrpc(refs.current.trpc).recordEvent?.mutate;
      const mailbox = inMailbox(item.transportId);
      if (!mutate || !mailbox) { item.error = 'Changes could not be saved. Retry.'; item.retryable = true; changed(item); return false; }
      let cursor = await refs.current.flushSnapshot(item.snapshot, item.transportId);
      if (!cursor) { item.error = 'Save the stay changes, then retry these entries.'; item.retryable = true; changed(item); return false; }
      while (true) {
        const next = [...item.entries].find(([, entry]) => entry.valid);
        if (!next) break;
        const [path, entry] = next;
        const source = item.snapshot.source;
        try {
          const input: RecordFieldEventInput = { workItemId: item.snapshot.workItemId, type: 'field.edit', fieldPath: path,
            value: entry.value, source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash },
            expectedSeq: cursor.seq, expectedExtractionId: source.extractionId };
          const result = await mutate(input, mailbox) as { seq?: number; revision?: number; revisionHead?: number; workItemExtractionId?: string };
          if (result?.seq !== cursor.seq + 1 || !Number.isSafeInteger(result.revision) || !Number.isSafeInteger(result.revisionHead) ||
              result.workItemExtractionId !== source.extractionId) throw new Error('Unexpected save response');
          cursor = { seq: result.seq, revision: result.revision!, revisionHead: result.revisionHead! };
          item.saved.set(path, entry.value);
          if (item.entries.get(path) === entry) item.entries.delete(path);
          if (currentKey.current === item.key) refs.current.onSave(cursor);
          changed(item);
        } catch {
          let fresh: AmendDraftSnapshot | null = null;
          try { fresh = await refs.current.reload(item.snapshot, item.transportId); } catch { /* retain entries for retry */ }
          const same = fresh && fresh.workItemId === item.snapshot.workItemId &&
            JSON.stringify(fresh.source) === JSON.stringify(item.snapshot.source) &&
            item.snapshot.requests.every((request) => fresh!.requests.some((nextRequest) => nextRequest.requestId === request.requestId));
          if (same && fresh) item.snapshot = fresh;
          item.error = same ? 'Draft changed or could not save. Check your entries, then retry.'
            : 'Email or draft changed. Your unsaved entries are held here.';
          item.retryable = Boolean(same || !fresh);
          changed(item);
          return false;
        }
      }
      changed(item);
      return item.entries.size === 0;
    };
    item.running = run().catch(() => {
      item.error = 'Changes could not be saved. Retry.'; item.retryable = true; changed(item); return false;
    }).finally(() => { item.running = null; changed(item); });
    changed(item);
    return item.running;
  }, [changed]);

  const pathFor = useCallback((requestId: string, suffix: string) => {
    if (!session) return null;
    const request = session.snapshot.requests.find((item) => item.requestId === requestId && item.status === 'pending');
    if (!request || !request.fields || request.fields.kind !== request.workflow) return null;
    const quoteRow = /^rows\[([A-Za-z0-9_-]{1,40})\]\.ratePlan$/.exec(suffix);
    const room = /^rows\[([A-Za-z0-9_-]{1,40})\]\.rooms\[([0-7])\]\.(firstName|lastName|guest\.profile|guestEmail|guestMobile|bookerName|bookerEmail|roomTypeCode|ratePlan|adults|childAges|arrival|departure|parties\.agency|parties\.organization|sourceOfBusiness|track|guaranteeType|reservationNote|cms\.send|cms\.messageId|cms\.recipient)$/.exec(suffix);
    if (quoteRow && request.action === 'quote_availability' && request.workflow === 'quote') {
      const value = request.fields.value as { rows?: Array<{ rowId?: string }> } | null;
      if (!Array.isArray(value?.rows) || !value.rows.some((row) => row.rowId === quoteRow[1])) return null;
    } else if (room && request.action === 'new_booking' && request.workflow === 'create') {
      const value = request.fields.value;
      if (!Array.isArray(value) || !value.some((row) => row && row.rowId === room[1] && row.roomIndex === Number(room[2]))) return null;
    } else return null;
    return `requests[${requestId}].${suffix}`;
  }, [session]);
  const record = useCallback((requestId: string, suffix: string, value: Value, valid = true) => {
    const path = pathFor(requestId, suffix);
    if (!session || !path) return false;
    if (valid && !session.running && !session.entries.has(path) && session.saved.has(path) &&
        JSON.stringify(session.saved.get(path)) === JSON.stringify(value)) {
      session.entries.delete(path);
      changed(session);
      return true;
    }
    session.entries.set(path, { value, valid });
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => void pump(session), 800);
    changed(session);
    return true;
  }, [session, pathFor, pump, changed]);
  const held = useCallback((requestId: string, suffix: string) => {
    const path = pathFor(requestId, suffix);
    if (!path || !session) return undefined;
    return session.entries.get(path) ?? (session.saved.has(path) ? { value: session.saved.get(path), valid: true } : undefined);
  }, [pathFor, session]);
  const flush = useCallback(async () => {
    if (!session || !(await pump(session)) || currentKey.current !== session.key) return null;
    const cursor = await refs.current.flushSnapshot(session.snapshot, session.transportId, true);
    if (cursor && currentKey.current === session.key) refs.current.onSave(cursor);
    return currentKey.current === session.key ? cursor : null;
  }, [session, pump]);
  const retry = useCallback(() => {
    if (!session?.retryable) return;
    session.retryable = false;
    void refs.current.reload(session.snapshot, session.transportId).then((fresh) => {
      if (!fresh || fresh.workItemId !== session.snapshot.workItemId || JSON.stringify(fresh.source) !== JSON.stringify(session.snapshot.source)) {
        session.error = 'Email or draft changed. Your unsaved entries are held here.'; changed(session); return;
      }
      session.snapshot = fresh; session.error = null; void pump(session);
    }).catch(() => { session.error = 'Could not reload. Your entries are held here.'; session.retryable = true; changed(session); });
  }, [session, pump, changed]);
  useEffect(() => () => { if (session) void pump(session); }, [session, pump]);
  return { snapshot: session?.snapshot ?? null, available: Boolean(session), record, held, flush, retry,
    pending: Boolean(session && (session.entries.size || session.running || session.error)), error: session?.error ?? null,
    retryable: session?.retryable ?? false };
}
