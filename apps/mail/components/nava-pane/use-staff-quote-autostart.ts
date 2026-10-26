import { useEffect } from 'react';

import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import {
  autoRunHeader,
  canRunQuoteStep,
  groupsForQuoteStep,
  partyLookupWaitReason,
  quoteRunBlockReason,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import { isQuoteFixturePreview } from '@/lib/quote-workflow/preview';
import {
  canBuildStaffQuoteRequest,
  staffQuoteFromTrpc,
} from '@/lib/quote-workflow/staff-quote-bind';
import type { QuotePaneConfig, QuoteSession } from '@/lib/quote-workflow/types';
import { trpcClient } from '@/providers/query-provider';

type MutableRef<T> = { current: T };
type QuoteStepRunner = (stepId: string, autoStart?: boolean, readBack?: boolean) => void;

type UseStaffQuoteAutostartArgs = {
  isNonActionableMessage: boolean;
  staffQuoteQueueMode: 'checking' | 'on' | 'off';
  isLoading: boolean;
  session: { user?: { id?: unknown } | null } | null | undefined;
  requiresRelogin: boolean;
  activeEmail: PaneBridge['activeEmail'];
  contactMessageKey: string;
  quoteRunPending: boolean;
  staffQuoteReadBackInFlight: MutableRef<boolean>;
  quoteSession: QuoteSession;
  staffQuoteAutoSuppressed: MutableRef<Set<string>>;
  staffQuoteAutoAttempted: MutableRef<Set<string>>;
  activePaneConfig: QuotePaneConfig | null;
  autoStartStaffQuoteStepRef: MutableRef<() => void>;
  runQuoteStep: QuoteStepRunner;
  autoStaffQuoteSuppressed: (emailKey: string) => boolean;
  staffQuoteAttemptKey: (transportId: string, messageId: string, sourceHash: string, stayKey: string) => string;
};

export function useStaffQuoteAutostart({
  isNonActionableMessage,
  staffQuoteQueueMode,
  isLoading,
  session,
  requiresRelogin,
  activeEmail,
  contactMessageKey,
  quoteRunPending,
  staffQuoteReadBackInFlight,
  quoteSession,
  staffQuoteAutoSuppressed,
  staffQuoteAutoAttempted,
  activePaneConfig,
  autoStartStaffQuoteStepRef,
  runQuoteStep,
  autoStaffQuoteSuppressed,
  staffQuoteAttemptKey,
}: UseStaffQuoteAutostartArgs): void {
  const autoStartStaffQuoteStep = () => {
    if (
      isNonActionableMessage ||
      staffQuoteQueueMode !== 'on' ||
      isLoading ||
      !session?.user ||
      requiresRelogin ||
      !activeEmail ||
      !contactMessageKey ||
      isQuoteFixturePreview() ||
      quoteRunPending ||
      staffQuoteReadBackInFlight.current ||
      quoteSession.runningStepId ||
      quoteSession.analysis?.intent !== 'quote' ||
      !quoteSession.binding ||
      (quoteSession.binding.internetMessageId ?? null) !== (activeEmail.internetMessageId ?? null) ||
      !staffSourceReady(quoteSession) ||
      partyLookupWaitReason(quoteSession) ||
      staffQuoteAutoSuppressed.current.has(contactMessageKey) ||
      autoStaffQuoteSuppressed(contactMessageKey)
    ) {
      return;
    }
    const source = quoteSession.staffSource;
    const binding = quoteSession.binding;
    if (!source || !binding) return;
    const staff = staffQuoteFromTrpc(trpcClient);
    if (!staff.workstation.queueStaffQuote?.mutate || !staff.workstation.staffQuoteJob?.query) return;
    const step = quoteSession.steps.find((candidate) => {
      if (
        candidate.kind !== 'quote_stay' ||
        candidate.status !== 'ready' ||
        !candidate.shareKey ||
        !canRunQuoteStep(candidate, quoteSession.steps, quoteSession.runningStepId) ||
        quoteSession.staffQuotes[candidate.shareKey] ||
        quoteRunBlockReason(quoteSession, candidate)
      ) {
        return false;
      }
      return canBuildStaffQuoteRequest({
        source,
        selectionEpoch: binding.selectionEpoch,
        inputRevision: quoteSession.inputRevision,
        groups: groupsForQuoteStep(quoteSession, candidate),
        header: autoRunHeader(quoteSession),
        propertyCode: activePaneConfig?.propertyCode,
        stayKey: candidate.shareKey,
      });
    });
    if (!step?.shareKey) return;
    const attemptKey = staffQuoteAttemptKey(
      binding.transportId,
      source.messageId,
      source.sourceHash,
      step.shareKey,
    );
    const readBack = staffQuoteAutoAttempted.current.has(attemptKey);
    staffQuoteAutoAttempted.current.add(attemptKey);
    runQuoteStep(step.id, true, readBack);
  };
  autoStartStaffQuoteStepRef.current = autoStartStaffQuoteStep;

  useEffect(() => {
    if (staffQuoteQueueMode !== 'on') return;
    autoStartStaffQuoteStepRef.current();
  }, [
    quoteSession,
    quoteRunPending,
    staffQuoteQueueMode,
    contactMessageKey,
    isLoading,
    session?.user?.id,
    requiresRelogin,
    isNonActionableMessage,
    activePaneConfig?.transportId,
  ]);
}
