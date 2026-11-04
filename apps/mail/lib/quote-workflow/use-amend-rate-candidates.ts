import { useCallback, useEffect, useRef, useState } from 'react';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import type { useAmendWorkItem } from './use-amend-work-item';

type RateCandidate = {
  id: string; rateCode: string; rateLabel: string | null; roomCode: string; roomLabel: string | null;
  boardLabel: string | null; state: 'available' | 'unavailable' | 'restricted' | 'unchecked' | 'failed';
  reasons: string[]; minRoomsAvailable: number | null;
  coverage: { nightsExpected: number; nightsObserved: number; eligibilityVerified: boolean; nativePartyIdsMatched: boolean };
  price: { currency: string; averagePerNightMinor: number | null; totalMinor: number | null;
    totalBasis: 'native' | 'nightly_sum' } | null;
};
export type RateReply = {
  status: 'queued' | 'running' | 'ready' | 'blocked' | 'failed' | 'stale';
  requestId: string; jobId: string | null; contextKey: string | null; observedAt: string | null; expiresAt: string | null;
  coverage: { candidateList: 'complete' | 'partial' | 'unknown'; reason: string | null };
  options: RateCandidate[]; recommendation: { rateCode: string | null; explanation: string; validation: string } | null;
  issues: Array<{ message: string }>;
};
type RateBinding = {
  workItemId: string; source: { threadId: string; messageId: string; sourceHash: string };
  request: { requestId: string; stayId: string; rowId: null; roomIndex: null }; expectedSeq: number; expectedExtractionId: string;
};
type RateRoute = { mutate: (input: { kind: 'start'; binding: RateBinding; typedRatePlan?: string; forceRefresh?: boolean } |
  { kind: 'read'; binding: RateBinding; jobId: string }, options: { context: { activeTransportId: string } }) => Promise<RateReply> };
type RateView = { key: string; status: 'checking' | 'ready' | 'blocked'; reply?: RateReply; message?: string };

/** A rate observation belongs to one source, request and saved edit revision. */
export function useAmendRateCandidates(args: {
  trpc: unknown; transportId: string | null; workItemId: string | null;
  source: { threadId: string; messageId: string; sourceHash: string }; confirmation: string;
  draft: ReturnType<typeof useAmendWorkItem> | null;
}) {
  const latest = useRef(args);
  latest.current = args;
  const route = (args.trpc as { quoteWorkflow?: { rateCandidates?: RateRoute } } | null)?.quoteWorkflow?.rateCandidates;
  const key = JSON.stringify([args.transportId, args.workItemId, args.source, args.confirmation,
    args.draft?.request?.requestId, args.draft?.request?.stayId, args.draft?.editVersion]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [view, setView] = useState<RateView | null>(null);
  useEffect(() => () => { generation.current += 1; if (timer.current) clearTimeout(timer.current); }, [key]);
  const check = useCallback(async (typedRatePlan?: string) => {
    const current = latest.current;
    const mutate = (current.trpc as { quoteWorkflow?: { rateCandidates?: RateRoute } } | null)?.quoteWorkflow?.rateCandidates?.mutate;
    const mailbox = inMailbox(current.transportId);
    if (!mutate || !mailbox || !current.draft?.source || !current.workItemId) return;
    if (timer.current) clearTimeout(timer.current);
    const mine = ++generation.current;
    const startedKey = currentKey.current;
    const active = () => generation.current === mine && currentKey.current === startedKey;
    setView({ key: startedKey, status: 'checking' });
    try {
      const saved = await current.draft.flush();
      if (!active()) return;
      const cursor = current.draft.binding();
      if (!saved || !cursor) {
        setView({ key: startedKey, status: 'blocked', message: 'Save valid changes before checking rates.' });
        return;
      }
      const binding: RateBinding = { workItemId: current.workItemId, source: current.source,
        request: { requestId: cursor.requestId, stayId: cursor.stayId, rowId: null, roomIndex: null }, expectedSeq: cursor.expectedSeq,
        expectedExtractionId: current.draft.source.extractionId };
      let expectedContext: string | null = null;
      let polls = 0;
      const accept = async (reply: RateReply): Promise<void> => {
        if (!active()) return;
        if (reply.requestId !== binding.request.requestId || (expectedContext && reply.contextKey !== expectedContext)) {
          setView({ key: startedKey, status: 'blocked', message: 'The rate context changed. Check rates again.' }); return;
        }
        if (reply.status === 'queued' || reply.status === 'running') {
          if (!reply.jobId || !reply.contextKey || ++polls >= 45) {
            setView({ key: startedKey, status: 'blocked', message: 'Rates are still being checked. Try again.' }); return;
          }
          expectedContext = reply.contextKey;
          const jobId = reply.jobId;
          timer.current = setTimeout(() => { void mutate({ kind: 'read', binding, jobId }, mailbox).then(accept).catch(failed); }, 4000);
          return;
        }
        if (reply.status !== 'ready' || !reply.contextKey || !reply.observedAt || !reply.expiresAt ||
            !Number.isFinite(Date.parse(reply.expiresAt)) || Date.parse(reply.expiresAt) <= Date.now()) {
          setView({ key: startedKey, status: 'blocked', message: reply.issues[0]?.message ?? 'Rates could not be checked. Try again.' }); return;
        }
        setView({ key: startedKey, status: 'ready', reply });
        timer.current = setTimeout(() => {
          if (active()) setView({ key: startedKey, status: 'blocked', message: 'These rates have expired. Check rates again.' });
        }, Math.max(0, Date.parse(reply.expiresAt) - Date.now()));
      };
      const failed = () => { if (active()) setView({ key: startedKey, status: 'blocked', message: 'Rates could not be checked. Try again.' }); };
      await accept(await mutate({ kind: 'start', binding, ...(typedRatePlan ? { typedRatePlan } : {}) }, mailbox));
    } catch {
      if (active()) setView({ key: startedKey, status: 'blocked', message: 'Rates could not be checked. Try again.' });
    }
  }, []);
  return { available: Boolean(route && args.draft?.available && args.draft.request && args.workItemId && args.transportId),
    view: view?.key === key ? view : null, check };
}

export function rateMoney(currency: string, amountMinor: number | null): string | null {
  return amountMinor !== null && Number.isSafeInteger(amountMinor) && amountMinor >= 0 && currency.trim()
    ? `${currency.trim()} ${(amountMinor / 100).toFixed(2)}` : null;
}

export function rateReason(reason: string): string {
  const labels: Record<string, string> = {
    NIGHT_COVERAGE_INCOMPLETE: 'not all nights returned',
    NATIVE_STAY_ELIGIBILITY_UNVERIFIED: 'stay eligibility not verified',
    NATIVE_RATE_ROW_NOT_OBSERVED: 'rate not found in this read',
  };
  return labels[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
}
