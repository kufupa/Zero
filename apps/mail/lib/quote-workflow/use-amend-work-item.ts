import { useCallback, useEffect, useRef, useState } from 'react';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { workItemsFromTrpc, type AmendDraftSnapshot, type RecordFieldEventInput } from './backend-bind';

export type AmendDraftField = 'target' | 'arrival' | 'departure' | 'adults' | 'children' | 'childAges' | 'roomType' |
  'ratePlan' | 'retainRates' | 'firstName' | 'lastName' | 'guestEmail' | 'bookerName' | 'bookerContact' |
  'cms.send' | 'cms.messageId' | 'cms.recipient';
type Entry = { value: RecordFieldEventInput['value']; valid: boolean };
type Session = {
  key: string; snapshot: AmendDraftSnapshot; transportId: string; seq: number;
  entries: Map<string, Entry>; timer: ReturnType<typeof setTimeout> | null;
  running: Promise<boolean> | null; error: string | null; retryable: boolean; editVersion: number;
};

/** A transient save queue over the WorkItem; the server projection remains the draft authority. */
export function useAmendWorkItem(args: {
  trpc: unknown; snapshot: AmendDraftSnapshot | null; transportId: string | null;
  reload: (expected: AmendDraftSnapshot, transportId: string) => Promise<AmendDraftSnapshot | null>;
  onSave: (cursor: { seq: number; revision: number; revisionHead: number }) => void;
}) {
  const refs = useRef(args);
  refs.current = args;
  const sessions = useRef(new Map<string, Session>());
  const [, render] = useState(0);
  const request = args.snapshot?.requests.length === 1 ? args.snapshot.requests[0] : null;
  const key = args.snapshot && request && args.transportId
    ? JSON.stringify([args.transportId, args.snapshot.workItemId, args.snapshot.source, request.requestId]) : null;
  let session = key ? sessions.current.get(key) ?? null : null;
  if (key && !session && args.snapshot && args.transportId) {
    session = { key, snapshot: args.snapshot, transportId: args.transportId, seq: args.snapshot.revisionSeq,
      entries: new Map(), timer: null, running: null, error: null, retryable: false, editVersion: 0 };
    sessions.current.set(key, session);
  }
  if (session && args.snapshot && args.snapshot.revisionSeq >= session.seq &&
      !session.running && !session.entries.size && !session.error) {
    session.snapshot = args.snapshot;
    session.seq = args.snapshot.revisionSeq;
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
      if (!mutate) { item.error = 'Changes could not be saved. Retry.'; item.retryable = true; changed(item); return false; }
      while (true) {
        const next = [...item.entries].find(([, entry]) => entry.valid);
        if (!next) break;
        const [path, entry] = next;
        const { threadId, messageId, sourceHash } = item.snapshot.source;
        try {
          const input: RecordFieldEventInput = { workItemId: item.snapshot.workItemId, type: 'field.edit',
            fieldPath: path, value: entry.value, source: { threadId, messageId, sourceHash }, expectedSeq: item.seq };
          const pinned = inMailbox(item.transportId);
          const result = await (pinned ? mutate(input, pinned) : mutate(input));
          const saved = result && typeof result === 'object' ? result as Record<string, unknown> : null;
          if (!saved || !Number.isSafeInteger(saved.seq) || saved.seq !== item.seq + 1 ||
              !Number.isSafeInteger(saved.revision) || !Number.isSafeInteger(saved.revisionHead) ||
              saved.workItemExtractionId !== item.snapshot.source.extractionId) throw new Error('Unexpected save response');
          item.seq = saved.seq as number;
          if (item.entries.get(path) === entry) item.entries.delete(path);
          if (currentKey.current === item.key) refs.current.onSave({ seq: item.seq,
            revision: saved.revision as number, revisionHead: saved.revisionHead as number });
          changed(item);
        } catch {
          let fresh: AmendDraftSnapshot | null = null;
          let reloadFailed = false;
          try { fresh = await refs.current.reload(item.snapshot, item.transportId); } catch { reloadFailed = true; }
          const same = fresh && fresh.workItemId === item.snapshot.workItemId &&
            JSON.stringify(fresh.source) === JSON.stringify(item.snapshot.source) &&
            fresh.requests.some((candidate) => candidate.requestId === item.snapshot.requests[0]?.requestId);
          if (same && fresh) { item.snapshot = fresh; item.seq = fresh.revisionSeq; }
          item.error = reloadFailed ? 'Could not save or reload. Your entries are held here.'
            : same ? 'Draft changed or could not save. Check your entries, then retry.'
              : 'Email or draft changed. Your unsaved entries are held here.';
          item.retryable = Boolean(same || reloadFailed);
          changed(item);
          return false;
        }
      }
      changed(item);
      return item.entries.size === 0;
    };
    item.running = run().finally(() => { item.running = null; changed(item); });
    changed(item);
    return item.running;
  }, [changed]);

  const record = useCallback((field: AmendDraftField, value: RecordFieldEventInput['value'], valid = true) => {
    if (!session) return;
    const request = session.snapshot.requests[0];
    if (!request) return;
    const structural: Partial<Record<AmendDraftField, string>> = {
      arrival: `stays[${request.stayId}].requested.arrival`, departure: `stays[${request.stayId}].requested.departure`,
      adults: `stays[${request.stayId}].totalAdults`, children: `stays[${request.stayId}].totalChildren`,
    };
    const path = structural[field] ?? `requests[${request.requestId}].${field}`;
    session.entries.set(path, { value, valid });
    session.editVersion += 1;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => void pump(session), 800);
    changed(session);
  }, [session, pump, changed]);
  const flush = useCallback(() => session ? pump(session) : Promise.resolve(false), [session, pump]);
  const binding = useCallback(() => {
    const request = session?.snapshot.requests[0];
    return session && request && !session.entries.size && !session.running && !session.error
      ? { requestId: request.requestId, stayId: request.stayId, expectedSeq: session.seq } : null;
  }, [session]);
  const retry = useCallback(() => {
    if (!session?.retryable) return;
    session.retryable = false;
    changed(session);
    void refs.current.reload(session.snapshot, session.transportId).then((fresh) => {
      const same = fresh && fresh.workItemId === session.snapshot.workItemId &&
        JSON.stringify(fresh.source) === JSON.stringify(session.snapshot.source) &&
        fresh.requests.some((candidate) => candidate.requestId === session.snapshot.requests[0]?.requestId);
      if (!same || !fresh) {
        session.error = 'Email or draft changed. Your unsaved entries are held here.';
        changed(session);
        return;
      }
      session.snapshot = fresh;
      session.seq = fresh.revisionSeq;
      session.error = null;
      void pump(session);
    }).catch(() => {
      session.error = 'Could not save or reload. Your entries are held here.';
      session.retryable = true;
      changed(session);
    });
  }, [session, pump, changed]);
  useEffect(() => () => { if (session) void pump(session); }, [session, pump]);
  return { request, source: args.snapshot?.source ?? null, fieldMeta: args.snapshot?.fieldMeta ?? {}, record, flush, binding, retry,
    error: session?.error ?? null, retryable: session?.retryable ?? false,
    pending: Boolean(session && (session.entries.size || session.running || session.error)), available: Boolean(session),
    editVersion: session?.editVersion ?? 0, requestCount: args.snapshot?.requests.length ?? 0 };
}
