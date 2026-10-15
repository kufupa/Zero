import { useEffect, useReducer, useRef } from 'react';
import {
  requestedQuoteKeys,
  salesStrategyForQueuedQuote,
  stayKeyForGroup,
} from '@/lib/quote-workflow/session';
import {
  bindReadBackStaffQuote,
  canBuildStaffQuoteRequest,
  type BoundExecuteStaffQuote,
  type StaffQuoteJobQuery,
} from '@/lib/quote-workflow/staff-quote-bind';
import type { QuoteSession, StaffQuoteHeader } from '@/lib/quote-workflow/types';

export type StaffQuoteReadBackSlot = { key: string; token: number; status: 'idle' | 'probing' | 'running' | 'done' };
export type StaffQuoteReadBackReady = Extract<BoundExecuteStaffQuote, { status: 'ok' }>;
export type StaffQuoteReadBackMeta = {
  stayKey: string;
  selectionEpoch: number;
  inputRevision: number;
  stayRevision: number;
  header: StaffQuoteHeader;
};

export function staffQuoteReadBackKey(parts: {
  transportId: string;
  messageId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  stayRevision: number;
  stayKey: string;
}): string {
  return [
    parts.transportId,
    parts.messageId,
    parts.sourceHash,
    parts.selectionEpoch,
    parts.inputRevision,
    parts.stayRevision,
    parts.stayKey,
  ].join('·');
}

/** One in-flight token. Done keys survive until that identity leaves the live set. */
export function createStaffQuoteReadBackMachine() {
  let slot: StaffQuoteReadBackSlot = { key: '', token: 0, status: 'idle' };
  const doneKeys = new Set<string>();
  const live = (token: number, key: string) => slot.token === token && slot.key === key;
  const inFlight = () => slot.status === 'probing' || slot.status === 'running';
  return {
    live,
    begin(nextKey: string): { token: number; started: boolean } {
      if (doneKeys.has(nextKey) || (slot.key === nextKey && slot.status !== 'idle') || inFlight()) {
        return { token: slot.token, started: false };
      }
      const token = slot.token + 1;
      slot = { key: nextKey, token, status: 'probing' };
      return { token, started: true };
    },
    markRunning(token: number, key: string): boolean {
      if (!live(token, key)) return false;
      slot = { ...slot, status: 'running' };
      return true;
    },
    markDone(token: number, key: string): boolean {
      if (!live(token, key)) return false;
      slot = { ...slot, status: 'done' };
      doneKeys.add(key);
      return true;
    },
    rememberDone(key: string) {
      doneKeys.add(key);
      if (slot.key === key) slot = { ...slot, status: 'done' };
    },
    forgetStale(liveKeys: readonly string[]) {
      const keep = new Set(liveKeys);
      for (const key of [...doneKeys]) if (!keep.has(key)) doneKeys.delete(key);
      if (slot.key && !keep.has(slot.key)) slot = { key: '', token: slot.token + 1, status: 'idle' };
    },
    busy: (key: string) => slot.key === key && inFlight(),
    done: (key: string) => doneKeys.has(key) || (slot.key === key && slot.status === 'done'),
    snapshot: (): StaffQuoteReadBackSlot => ({ ...slot }),
  };
}

function identityFor(session: QuoteSession, stayKey: string): string | null {
  const { binding } = session;
  const source = session.staffSource;
  return binding && source
    ? staffQuoteReadBackKey({
        transportId: binding.transportId,
        messageId: source.messageId,
        sourceHash: source.sourceHash,
        selectionEpoch: binding.selectionEpoch,
        inputRevision: session.inputRevision,
        stayRevision: session.stayRevision,
        stayKey,
      })
    : null;
}

/** Reads an HMS quote the server already has. Ignores party lookup, party decision, and auto-start suppression. */
export function useStaffQuoteReadBack(args: {
  session: QuoteSession;
  enabled: boolean;
  query?: StaffQuoteJobQuery;
  onQuote: (result: StaffQuoteReadBackReady, meta: StaffQuoteReadBackMeta) => void;
}): { busy: (stayKey: string) => boolean; done: (stayKey: string) => boolean; generation: number } {
  const machine = useRef(createStaffQuoteReadBackMachine()).current;
  const [generation, bump] = useReducer((count: number) => count + 1, 0);
  const onQuoteRef = useRef(args.onQuote);
  onQuoteRef.current = args.onQuote;
  const queryRef = useRef(args.query);
  queryRef.current = args.query;
  const { session } = args;
  const stayKeys = requestedQuoteKeys(session.groups);
  const liveIdentities = stayKeys.map((stayKey) => identityFor(session, stayKey)).filter((key): key is string => Boolean(key));

  useEffect(() => {
    if (!args.enabled || !queryRef.current || !session.binding || !session.staffSource || session.analysis?.intent !== 'quote') {
      machine.forgetStale([]);
      bump();
      return;
    }
    const binding = session.binding;
    const source = session.staffSource;
    machine.forgetStale(liveIdentities);
    const header = { ...session.staffHeader, salesStrategy: salesStrategyForQueuedQuote(session.staffHeader) };
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = session.inputRevision;
    const stayRevision = session.stayRevision;
    const poll = new AbortController();
    const nextStay = () =>
      stayKeys.find((stayKey) => {
        const identity = identityFor(session, stayKey);
        if (!identity) return false;
        if (session.staffQuotes[stayKey] || machine.done(identity)) {
          machine.rememberDone(identity);
          return false;
        }
        return canBuildStaffQuoteRequest({
          source,
          selectionEpoch,
          inputRevision,
          groups: session.groups.filter((group) => stayKeyForGroup(group) === stayKey),
          header,
          stayKey,
        });
      }) ?? null;
    void (async () => {
      for (;;) {
        const stayKey = nextStay();
        const identity = stayKey ? identityFor(session, stayKey) : null;
        const query = queryRef.current;
        if (!stayKey || !identity || !query) {
          bump();
          return;
        }
        const started = machine.begin(identity);
        if (!started.started) return;
        bump();
        const result = await bindReadBackStaffQuote({
          query: async (input, options) => {
            const view = await query(input, { ...options, signal: poll.signal });
            if (
              view &&
              (view.status === 'queued' || view.status === 'running' || view.status === 'retrying') &&
              machine.markRunning(started.token, identity)
            ) {
              bump();
            }
            return view;
          },
          signal: poll.signal,
          source,
          selectionEpoch,
          inputRevision,
          groups: session.groups.filter((group) => stayKeyForGroup(group) === stayKey),
          header,
          stayKey,
        });
        if (!machine.live(started.token, identity)) return;
        if (result?.status === 'ok') {
          onQuoteRef.current(result, { stayKey, selectionEpoch, inputRevision, stayRevision, header });
        }
        machine.markDone(started.token, identity);
        bump();
      }
    })();
    return () => poll.abort();
    // Token+key drop stale awaits; generation must not be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    args.enabled,
    Boolean(args.query),
    session.analysis?.intent,
    session.inputRevision,
    session.stayRevision,
    session.binding?.transportId,
    session.binding?.selectionEpoch,
    session.staffSource?.messageId,
    session.staffSource?.sourceHash,
    stayKeys.join(','),
    liveIdentities.join(','),
  ]);

  return {
    generation,
    busy: (stayKey) => Boolean(identityFor(session, stayKey) && machine.busy(identityFor(session, stayKey)!)),
    done: (stayKey) => Boolean(identityFor(session, stayKey) && machine.done(identityFor(session, stayKey)!)),
  };
}
