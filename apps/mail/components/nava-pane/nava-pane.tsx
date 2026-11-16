import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { outlookSyncLabel, OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { reportBridgeFailure } from '@/lib/workstation/use-outlook-bridge';
import { PaneMenu } from './pane-menu';
import {
  createPaneVersionWatch,
  fetchPaneVersion,
  loadedPaneBuild,
  PANE_IDLE_CHECK_MS,
  PANE_RELEASE_POLL_MS,
  reloadAtEmailSwitch,
  reloadAtIdle,
  reloadPane,
  type PaneVersion,
} from '@/lib/workstation/pane-release-watch';
import { mutationsInFlight } from '@/lib/workstation/mutations-in-flight';
import { downloadStaffQuoteWorkbook } from '@/lib/quote-workflow/quote-workbook-download';
import {
  missingQuoteDetailsWrapperHtml,
  quoteDeclineReplyHtml,
} from '@/lib/quote-proposal/copy';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { ContactField, MailSourceSelection, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ConfirmationSourcesBridge } from '@/components/quote-workflow/confirmation-recipient';
import { hideQuoteWorkspace, QuoteWorkflowPanel } from '@/components/quote-workflow/quote-workflow-panel';
import { WorkflowBadge } from '@/components/quote-workflow/workflow-badge';
import {
  HmsJobNoticeBanner,
  HmsJobNoticeProvider,
  HmsJobRunningChip,
} from '@/components/quote-workflow/hms-job-notices';
import type { HmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';
import { savedRatesFromTrpc } from '@/components/quote-workflow/rate-controls';
import {
  fixtureReplyHtml,
  loadQuoteFixture,
  pickFixtureForSession,
} from '@/lib/quote-workflow/fixtures';
import { isQuoteFixturePreview } from '@/lib/quote-workflow/preview';
import type { CombinedReplyEdit } from '@/lib/quote-workflow/multi-option-draft';
import type { QuoteAnalysis, QuotePaneConfig, QuoteSelectionBinding, QuoteSession, QuoteSessionAction } from '@/lib/quote-workflow/types';
import {
  bindAnalyseSelection,
  quoteWorkflowFromTrpc,
} from '@/lib/quote-workflow/backend-bind';
import { forgetPaneEdits, overlayRememberedGroups, paneEditKey, recalledPaneEdits, rememberPaneEdits } from '@/lib/quote-workflow/pane-edits';
import { forgetGuestName, guestNameCacheKey, recalledGuestName } from '@/lib/quote-workflow/guest-name-cache';
import { sectionHasStaffEdit, storedDecision, useStoredWork } from '@/lib/quote-workflow/use-work-item';
import { useAmendWorkItem } from '@/lib/quote-workflow/use-amend-work-item';
import { useRequestWorkItem } from '@/lib/quote-workflow/use-request-work-item';
import { useAmendExtractionRefresh } from '@/lib/quote-workflow/use-amend-extraction-refresh';
import { WorkItemHistoryControls } from './screens/work-item-history-controls';
import { readTreatAs, rememberTreatAs } from '@/lib/quote-workflow/treat-as-cache';
import { bindPaneTelemetry, currentPaneOwner, setPaneTelemetryScope, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import {
  bindGetPriorStaffQuoteRequote,
  bindListThreadQuoteRevisions,
  bindPrepareBookingDraft,
  bindUsePriorQuoteForBooking,
  UNQUOTED_BOOKING_REVISION_REF,
  buildExpiredPriorRequoteBindArgs,
  EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL,
  expiredPriorQuoteNotice,
  expiredPriorQuoteToastMessage,
  offerBoardFromRevision,
  overlayLunaGroupsFromStaff,
  type PriorStaffQuoteRequoteRow,
  type UsePriorQuoteForBookingReady,
} from '@/lib/quote-workflow/booking-draft-bind';
import { paneStayFromTrpc, readPaneSaveFlag } from '@/lib/quote-workflow/pane-stay-bind';
import {
  partyFinderFromTrpc,
  partyIndexFromTrpc,
  partySuggesterFromTrpc,
  type PartySuggestion,
} from '@/lib/quote-workflow/party-lookup';
import { amendFindClientFromTrpc, hmsJobTransport, type HmsJobRequest, type HmsJobView } from '@/lib/quote-workflow/amend-find';
import {
  bindAutoStartStaffQuote,
  bindExecuteStaffQuote,
  bindHmsQueueStatus,
  bindReadBackStaffQuote,
  bindQuoteRunScreenshot,
  bindStaffQuoteStrategies,
  bindStaffActions,
  bindStaffQuoteSource,
  staffQuoteFromTrpc,
  isStaffQuoteRefusal,
  type BoundExecuteStaffQuote,
  type StaffQuoteJobQuery,
} from '@/lib/quote-workflow/staff-quote-bind';
import { ratesReadyJobs, trackingStaffQuoteJob, useRatesReadyNotice } from '@/lib/quote-workflow/rates-ready-notice';
import { useHmsQueueStatus } from '@/lib/quote-workflow/use-hms-queue-status';
import {
  admissionKey,
  analysisRetryKey,
  DRAFT_GROUP_ID,
  canRunQuoteStep,
  missingQuoteDetailsReplyOnly,
  missingQuoteReplyFieldsForGroups,
  autoRunHeader,
  groupsForQuoteStep,
  isMultiStay,
  quoteRunIsCurrent,
  quoteStayRunIsCurrent,
  requestedQuoteKeys,
  stayKeyForGroup,
  hasStaffStayEdits,
  initialQuoteSession,
  nextSelectedOfferIds,
  partyLookupWaitReason,
  pickNextRunnableStep,
  quoteRunBlockReason,
  reduceQuoteSession,
  removedStayFor,
  quoteStrategyStayRevision,
} from '@/lib/quote-workflow/session';
import { useActiveConnection } from '@/hooks/use-connections';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { toast } from 'sonner';
import { WelcomeScreen } from './screens/welcome';
import { DiagnosticsScreen } from './screens/diagnostics';
import { TourScreen } from './screens/tour';
import { NeedsYouEntry, NeedsYouScreen, useNeedsYou } from './screens/needs-you';
import { SelectedEmailBlock } from './blocks/selected-email';
import { ContactBlock } from './blocks/contact-block';
import { TranslationBox } from './blocks/translation-box';
import { BookingVoucherCard } from './blocks/booking-voucher-card';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import { MailSourceNoActionCard } from './blocks/mail-source-no-action';
import { FollowUpCard } from './blocks/follow-up-card';
import { DraftPreviewBlock } from './blocks/draft-preview';
import { SystemCheckResultsBlock } from './blocks/system-check-results';
import { ReplyBody } from './reply-body';
import { useInsertAiDraft } from './use-insert-ai-draft';
import { useSavedReply } from './use-saved-reply';
import { useQuotePdfJob } from './use-quote-pdf-job';
import { useStaffQuoteAutostart } from './use-staff-quote-autostart';
import { useSystemCheck } from './use-system-check';
import { canonicalSourceBodyText, classifyMailSource } from '../../../server-pilot/src/ai/mail-source.js';
import { selfSentPreStayBodyConfirmationNumbers, selfSentPreStayCandidate } from '../../../server-pilot/src/ai/existing-stay-information.js';
import { readAsForAnalysis, workStateForStatus } from '@/lib/quote-workflow/workflow-vocabulary';
import { GOLD_ACTION_FOR_READ_AS } from '@/lib/workflow-action-labels';

type PaneScreen = 'welcome' | 'diagnostics' | 'tour' | 'tool' | 'needs-you';
type SenderFallback = Pick<StoredContact, 'name' | 'email'>;

/** Returns only a proven external sender. If either identity is missing, the fallback stays blank. */
function externalSenderFallback(
  activeEmail: NonNullable<PaneBridge['activeEmail']> | null,
  mailboxEmail: string | undefined,
): SenderFallback | null {
  if (!activeEmail || !mailboxEmail) return null;
  const address = (value: string) => {
    const extracted = value.match(/<\s*([^<>]+)\s*>/)?.[1] ?? value;
    const clean = extracted.trim();
    const match = /^([^@\s<>]+)@((?:[^@\s<>.]+\.)+[^@\s<>.]+)$/.exec(clean);
    if (!match) return null;
    return { display: clean, normalized: clean.toLowerCase(), domain: match[2]!.toLowerCase() };
  };
  const sender = address(activeEmail.senderEmail);
  const mailbox = address(mailboxEmail);
  if (!sender || !mailbox || sender.normalized === mailbox.normalized || sender.domain === mailbox.domain) return null;

  const displayName = activeEmail.senderName.trim().replace(/\s+/g, ' ');
  return {
    name: displayName && displayName.toLowerCase() !== sender.normalized ? displayName : null,
    email: sender.display,
  };
}

function ExistingStayInformationCard({ confirmationNumbers, separateAsk, needsReview }: {
  confirmationNumbers: string[];
  separateAsk: string | null;
  needsReview: boolean;
}) {
  return (
    <section
      role="status"
      aria-label="Existing stay information — no booking or quote action"
      data-testid="existing-stay-information"
      className="flex flex-col gap-2 rounded-[4px] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5"
    >
      <p className="text-[13px] leading-5 text-[#475569]">
        <span className="font-semibold text-[#1e293b]">Existing stay information</span> — this confirmation is for a
        reservation already on file.{needsReview ? '' : ' Nava takes no booking or quote action.'}
      </p>
      {needsReview ? (
        <p className="text-[13px] leading-5 text-[#475569]">
          <span className="font-semibold text-[#92400e]">Needs review</span>: this mail may also ask for something else.
          Read the email and action any other request by hand in HMS — Nava cannot action it here.
        </p>
      ) : null}
      {confirmationNumbers.length ? (
        <p className="text-[13px] leading-5 text-[#475569]">
          <span className="font-semibold text-[#1e293b]">
            {confirmationNumbers.length === 1 ? 'Confirmation number' : 'Confirmation numbers'}
          </span>
          : {confirmationNumbers.join(', ')}
        </p>
      ) : null}
      {separateAsk ? (
        <p className="text-[13px] leading-5 text-[#475569]">
          <span className="font-semibold text-[#1e293b]">Also needs attention</span>: {separateAsk}
        </p>
      ) : null}
    </section>
  );
}

// One client for the pane's life, so screenshot loaders keep their identity across renders.
const PANE_STAY_CLIENT = paneStayFromTrpc(trpcClient);
// One HMS party search for the quote header's Find in HMS picker. Null when the panePartyLookup route is missing.
const PANE_PARTY_FINDER = partyFinderFromTrpc(trpcClient);
const PANE_PARTY_SUGGESTER = partySuggesterFromTrpc(trpcClient);
const PANE_HMS_JOB_CLIENT = amendFindClientFromTrpc(trpcClient);
// The same picker's typeahead: the HMS list and the listed parties, as staff type. Null when the route is missing.
const PANE_PARTY_INDEX = partyIndexFromTrpc(trpcClient);
// The saved rates for each row's price (R7). Null when the rates route is missing, so only one-off and override show.
const PANE_SAVED_RATES = savedRatesFromTrpc(trpcClient);
// Pane action telemetry goes out through this client (v5 B1). Until it is bound, actions are dropped.
bindPaneTelemetry(trpcClient);

const STAFF_QUOTE_NOTICE_REQUEST = { kind: 'staff_quote' } as unknown as HmsJobRequest;
const STAFF_QUOTE_POLL_LOST_REASON =
  'The queued quote is still running, but Nava could not read its status. Try again in a minute.';
const STAFF_QUOTE_AUTO_SUPPRESSED_PREFIX = 'nava.staff-quote-auto-suppressed:';
let nextStaffQuoteNoticeScope = 0;

function autoStaffQuoteSuppressed(emailKey: string): boolean {
  try {
    return sessionStorage.getItem(`${STAFF_QUOTE_AUTO_SUPPRESSED_PREFIX}${emailKey}`) === '1';
  } catch {
    return false;
  }
}

function rememberAutoStaffQuoteSuppression(emailKey: string): void {
  try {
    sessionStorage.setItem(`${STAFF_QUOTE_AUTO_SUPPRESSED_PREFIX}${emailKey}`, '1');
  } catch {
    // The pane still suppresses this mount through its in-memory set when storage is unavailable.
  }
}

function staffQuoteAttemptKey(transportId: string, messageId: string, sourceHash: string, stayKey: string): string {
  return JSON.stringify([transportId, messageId, sourceHash, stayKey]);
}

function quoteSourceIdentity(session: QuoteSession): string {
  const binding = session.binding;
  const source = session.staffSource;
  return JSON.stringify([binding?.transportId, binding?.storeId, binding?.folderEntryId, binding?.entryId,
    binding?.selectionEpoch, binding?.scopeEpoch, source?.threadId, source?.messageId, source?.sourceHash]);
}

function analysisWithPaneEdits(
  analysis: QuoteAnalysis,
  transportId: string,
  messageKey: string | undefined,
): QuoteAnalysis {
  if (!messageKey) return analysis;
  const groups = overlayRememberedGroups(
    analysis.groups,
    recalledPaneEdits(paneEditKey(transportId, messageKey)),
  );
  return groups === analysis.groups ? analysis : { ...analysis, groups };
}

function staffQuoteNoticeView(jobId: string, result: BoundExecuteStaffQuote): HmsJobView {
  const asOf = new Date().toISOString();
  return {
    runId: result.status === 'ok' ? result.staffQuote.runId ?? jobId : jobId,
    request: STAFF_QUOTE_NOTICE_REQUEST,
    prefetch: false,
    status: result.status === 'ok' ? 'done' : 'failed',
    position: null,
    attempts: 1,
    failureClass: result.status === 'ok' ? null : 'STAFF_QUOTE_FAILED',
    asOf,
    createdAt: asOf,
    outcome: result.status === 'ok' ? 'ready' : 'failed',
    result: result.status === 'ok' ? { status: 'ready' } : { message: result.reason },
  };
}

/**
 * Pane body. The route calls useOutlookBridge() once and passes the result in as `bridge`.
 * `preview` (the /nava-preview viewer) starts on the quoting tool, skipping the welcome, connection
 * and tour screens and their automatic ping. Analysis does not wait on the ping. Outlook passes nothing.
 */
type NavaPaneProps = {
  bridge: PaneBridge;
  preview?: boolean;
  /** The web preview checked this exact message, or a unique inbound. */
  webSelectedMessageId?: string | null;
  /** Stored thread containing the web selection. Outlook does not supply a web thread ID. */
  webSelectedThreadId?: string;
  /** Webmail only: opens a Needs-you row's thread in the webmail. Outlook passes nothing. */
  onOpenThread?: (threadId: string, sourceMessageId?: string) => void;
  /** Normal inbox only: allow owners to save this message's workflow as a gold label. */
  goldLabelEnabled?: boolean;
  /** Webmail keeps notice state above its keyed thread panel so lookups survive email switches. */
  hmsNoticesManagedByParent?: boolean;
};

export function NavaPane({
  bridge,
  preview = false,
  webSelectedMessageId = null,
  webSelectedThreadId,
  onOpenThread,
  goldLabelEnabled = false,
  hmsNoticesManagedByParent = false,
}: NavaPaneProps) {
  const noticeReporterRef = useRef<HmsJobNoticeReporter | null>(null);
  const setNoticeReporter = useCallback((reporter: HmsJobNoticeReporter) => {
    noticeReporterRef.current = reporter;
  }, []);
  const [staffQuoteNoticeScope] = useState(() => `main-rates-${++nextStaffQuoteNoticeScope}`);
  const staffQuoteNoticeSequence = useRef(0);
  const staffQuoteAutoAttempted = useRef(new Set<string>());
  const quoteStrategyBindAttempts = useRef(new Set<string>());
  const staffQuoteAutoSuppressed = useRef(new Set<string>());
  const staffQuoteRunCount = useRef(0);
  const staffQuoteReadBackInFlight = useRef(false);
  const staffQuoteReadBackGeneration = useRef(0);
  const staffQuoteStepGenerations = useRef(new Map<string, number>());
  const preparedTaskGeneration = useRef(0);
  const autoStartStaffQuoteStepRef = useRef<() => void>(() => undefined);
  const runQuoteStepRef = useRef<(stepId: string, autoStart?: boolean, readBack?: boolean) => void>(() => undefined);
  const {
    isConnected,
    activeEmail,
    workstationInfo,
    capabilities,
    updateRequired,
    requiresRelogin,
    authorizationUnavailable,
    selectionOutsideMailbox,
    supportsAction,
    sendCommand,
    pairDevice,
    refreshAuthorization,
    activateMailboxSync,
  } = bridge;
  const selectedKey = activeEmail?.entryId
    ? `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`
    : null;
  const selectedEmailKey = activeEmail?.entryId
    ? JSON.stringify([activeEmail.storeId ?? '', activeEmail.folderEntryId ?? '', activeEmail.entryId])
    : null;
  const [quoteSession, dispatchQuote] = useReducer(reduceQuoteSession, undefined, initialQuoteSession);
  const partyJobThreadId = quoteSession.staffSource?.threadId ?? null;
  const partyJobMessageId = quoteSession.staffSource?.messageId ?? null;
  const partyJobTransport = useMemo(
    () => hmsJobTransport(PANE_HMS_JOB_CLIENT, partyJobThreadId, partyJobMessageId),
    [partyJobThreadId, partyJobMessageId],
  );
  const [propertySelection, setPropertySelection] = useState<{ transportId: string; propertySwitch: 'HRDAV' | 'HRDAVS' } | null>(null);
  const [quotePaneConfig, setQuotePaneConfig] = useState<{ key: string; value: QuotePaneConfig } | null>(null);
  // Preview/Book in HMS show only when create mode is lab or on. Until the read answers, the card stays copy-only.
  const [paneSaveOn, setPaneSaveOn] = useState(false);
  // Legacy attach readiness. HRCEN filing uses its mailbox-scoped server flags instead.
  const [attachWritesEnabled, setAttachWritesEnabled] = useState(false);
  // Staff's edit of the combined reply. It is used only while the completed options are the same ones.
  const [combinedEdit, setCombinedEdit] = useState<CombinedReplyEdit | null>(null);
  useEffect(() => {
    let alive = true;
    void readPaneSaveFlag(trpcClient).then((on) => {
      if (!alive) return;
      setPaneSaveOn(on);
      setAttachWritesEnabled(PANE_STAY_CLIENT.mode?.() === 'lab');
    });
    return () => {
      alive = false;
    };
  }, []);
  const quoteSessionRef = useRef(quoteSession);
  quoteSessionRef.current = quoteSession;
  // True from the executeStaffQuote call until it settles. Drives the HMS queue poller.
  const [quoteRunPending, setQuoteRunPending] = useState(false);
  const [staffQuoteQueueMode, setStaffQuoteQueueMode] = useState<'checking' | 'on' | 'off'>(() =>
    PANE_HMS_JOB_CLIENT?.jobQueueEnabled ? 'checking' : 'off',
  );
  useEffect(() => {
    const readQueueMode = PANE_HMS_JOB_CLIENT?.jobQueueEnabled;
    if (!readQueueMode) {
      setStaffQuoteQueueMode('off');
      return;
    }
    let live = true;
    void readQueueMode().then(
      (enabled) => live && setStaffQuoteQueueMode(enabled ? 'on' : 'off'),
      () => live && setStaffQuoteQueueMode('on'),
    );
    return () => {
      live = false;
    };
  }, []);
  const hmsQueue = useHmsQueueStatus({
    pending: quoteRunPending,
    fetchStatus: () =>
      bindHmsQueueStatus(staffQuoteFromTrpc(trpcClient).workstation.hmsQueueStatus?.query),
  });
  useRatesReadyNotice({
    jobsRef: ratesReadyJobs,
    openMessageId: quoteSession.staffSource?.messageId ?? null,
    openEmailKey: selectedEmailKey,
    query: staffQuoteFromTrpc(trpcClient).workstation.staffQuoteJob?.query,
    onOpenThread,
  });
  const trackRatesJob = (query: StaffQuoteJobQuery | undefined, source: { messageId: string; threadId: string }) =>
    trackingStaffQuoteJob(ratesReadyJobs, query, () => ({
      messageId: source.messageId,
      threadId: source.threadId,
      emailKey: selectedEmailKey,
      subject: activeEmail?.subject?.trim() || null,
      entryId: activeEmail?.entryId ?? null,
    }));
  const trackStaffQuoteRun = <T,>(run: Promise<T>): Promise<T> => {
    staffQuoteRunCount.current += 1;
    setQuoteRunPending(true);
    const startedAt = Date.now();
    // The lookup belongs to the item it started on. Staff may open another mail before it finishes.
    const owner = currentPaneOwner();
    trackPaneAction({ type: 'hms.lookup.started' }, owner);
    return run.finally(() => {
      staffQuoteRunCount.current -= 1;
      setQuoteRunPending(staffQuoteRunCount.current > 0);
      trackPaneAction({ type: 'hms.lookup.finished', ms: Math.max(0, Date.now() - startedAt) }, owner);
    });
  };
  const trackMainStaffQuoteRun = (
    run: Promise<BoundExecuteStaffQuote | null>,
    retry: () => void,
    email = {
      emailKey: selectedEmailKey,
      emailSubject: activeEmail?.subject?.trim() || null,
    },
  ): Promise<BoundExecuteStaffQuote | null> => {
    const observerId = `${staffQuoteNoticeScope}:${++staffQuoteNoticeSequence.current}`;
    const jobId = 'main-rates';
    noticeReporterRef.current?.started({
      observerId,
      jobId,
      request: STAFF_QUOTE_NOTICE_REQUEST,
      targetId: 'quote-rates',
      retry,
      transport: null,
      email,
    });
    return trackStaffQuoteRun(run).then(
      (result) => {
        if (result === null) {
          noticeReporterRef.current?.cancel(observerId, jobId);
          return null;
        }
        noticeReporterRef.current?.settled(observerId, jobId, staffQuoteNoticeView(jobId, result), retry);
        return result;
      },
      (error: unknown) => {
        const failed: BoundExecuteStaffQuote = {
          status: 'unavailable',
          reason:
            error instanceof Error && error.message.trim()
              ? error.message
              : 'Nava could not finish getting rates from HMS. Try again.',
        };
        noticeReporterRef.current?.settled(observerId, jobId, staffQuoteNoticeView(jobId, failed), retry);
        return failed;
      },
    );
  };
  const requoteSameStayRef = useRef<(row: PriorStaffQuoteRequoteRow) => void>(() => {});
  const { data: session, isLoading } = useSession();
  const staffSignerName = session?.user?.name ?? '';
  const { data: activeConnection, isLoading: transportLoading } = useActiveConnection();
  const propertySwitch = propertySelection && propertySelection.transportId === activeConnection?.id ? propertySelection.propertySwitch : undefined;
  const configKey = JSON.stringify([session?.user?.id, session?.session?.id, activeConnection?.id, propertySwitch]);
  const configEpoch = useRef({ key: configKey, value: 0 });
  if (configEpoch.current.key !== configKey) configEpoch.current = { key: configKey, value: configEpoch.current.value + 1 };
  const activePaneConfig = quotePaneConfig?.key === configKey ? quotePaneConfig.value : null;
  const quoteStrategyRegistryKey = (activePaneConfig?.salesStrategies ?? [])
    .map((strategy) => `${strategy.code}:${strategy.requestValue}`)
    .join('|');
  const sourceClassification = classifyMailSource({
    fromAddress: activeEmail?.senderEmail,
    subject: activeEmail?.subject,
    bodyText: activeEmail?.bodyText,
  });
  const nonActionableMailSource =
    sourceClassification.kind === 'direct' ? null : sourceClassification;
  const isNonActionableMailSource = nonActionableMailSource !== null;
  const selfPreStayBodyText = canonicalSourceBodyText({
    textBody: activeEmail?.bodyText,
    htmlBody: activeEmail?.bodyHtml,
  });
  const selfSentPreStay = selfSentPreStayCandidate({
    fromAddress: activeEmail?.senderEmail,
    mailboxAddress: activeConnection?.email,
    subject: activeEmail?.subject,
    bodyText: selfPreStayBodyText,
  });
  const isNonActionableBySourceOrSubject = isNonActionableMailSource || selfSentPreStay;
  useEffect(() => {
    let alive = true;
    const selectedEpoch = configEpoch.current.value;
    setQuotePaneConfig(null);
    const transportId = activeConnection?.id;
    if (!session?.user?.id || !transportId) {
      return () => {
        alive = false;
      };
    }
    void trpcClient.quoteWorkflow.rateCatalogue.query(propertySwitch ? { propertySwitch } : undefined, inMailbox(transportId) ?? undefined)
      .then((config) => {
        if (alive && configEpoch.current.value === selectedEpoch && config.transportId === transportId && (!propertySwitch || config.propertyCode === propertySwitch)) setQuotePaneConfig({ key: configKey, value: config });
      })
      .catch(() => {
        if (alive && configEpoch.current.value === selectedEpoch) setQuotePaneConfig(null);
      });
    return () => {
      alive = false;
    };
  }, [session?.user?.id, session?.session?.id, activeConnection?.id, propertySwitch, configKey]);
  const readOnlySyncStatus = Boolean(preview || onOpenThread);
  const sync = useOutlookSync({
    userId: session?.user?.id ?? null,
    sessionId: session?.session?.id ?? null,
    transportId: activeConnection?.id ?? null,
    mailbox: activeConnection?.email ?? '',
    deviceId: workstationInfo?.deviceId ?? null,
    capabilityVersion: capabilities?.mailboxSync,
    readRoots: capabilities?.readRoots ?? [],
    authorized: Boolean(isConnected && !requiresRelogin && !authorizationUnavailable),
    readOnlyStatus: readOnlySyncStatus,
    activateNative: activateMailboxSync,
  });
  const currentScope =
    !requiresRelogin && session?.user?.id && activeConnection?.id
      ? `${session.user.id}:${session.session?.id ?? ''}:${activeConnection.id}`
      : null;
  const voucherMailboxScope = !requiresRelogin && session?.user?.id && session.session?.id && activeConnection?.id
    ? JSON.stringify([session.user.id, session.session.id, activeConnection.id])
    : null;
  const sourceSelection = useMemo<MailSourceSelection | undefined>(() => {
    if (!activeEmail?.entryId) return undefined;
    if (preview) {
      return webSelectedThreadId !== undefined
        ? { kind: 'web', messageId: activeEmail.entryId, threadId: webSelectedThreadId }
        : undefined;
    }
    return {
      kind: 'outlook',
      storeId: activeEmail.storeId ?? '',
      entryId: activeEmail.entryId,
      ...(activeEmail.folderEntryId ? { folderEntryId: activeEmail.folderEntryId } : {}),
    };
  }, [activeEmail?.entryId, activeEmail?.storeId, activeEmail?.folderEntryId, preview, webSelectedThreadId]);
  const selectedIdentity = activeEmail?.entryId
    ? JSON.stringify([...(propertySwitch ? [propertySwitch] : []), sourceSelection ?? selectedEmailKey, activeEmail.internetMessageId ?? '']) : null;
  const contextRevision = useRef({ scope: currentScope, selection: selectedIdentity, scopeEpoch: 0, selectionEpoch: 0 });
  if (contextRevision.current.scope !== currentScope) {
    contextRevision.current = { scope: currentScope, selection: selectedIdentity,
      scopeEpoch: contextRevision.current.scopeEpoch + 1, selectionEpoch: contextRevision.current.selectionEpoch + 1 };
  } else if (contextRevision.current.selection !== selectedIdentity) {
    contextRevision.current = { ...contextRevision.current, selection: selectedIdentity,
      selectionEpoch: contextRevision.current.selectionEpoch + 1 };
  }
  // Keep a separate display snapshot: a same-ID edit must not leave a settled amend lookup on screen.
  const amendSourceSnapshot = useRef<{
    scopeEpoch: number; locator: string; internetMessageId?: string;
    subject: string; bodyText: string; bodyHtml: string; invalidated: boolean;
  } | null>(null);
  const amendLocator = activeEmail?.entryId ? JSON.stringify([activeEmail.entryId, activeEmail.storeId ?? '',
    activeEmail.folderEntryId ?? '']) : null;
  if (!activeEmail) amendSourceSnapshot.current = null;
  if (activeEmail && selectedIdentity && (
    amendSourceSnapshot.current?.scopeEpoch !== contextRevision.current.scopeEpoch ||
    amendSourceSnapshot.current?.locator !== amendLocator
  )) {
    amendSourceSnapshot.current = { scopeEpoch: contextRevision.current.scopeEpoch,
      locator: amendLocator!, internetMessageId: activeEmail.internetMessageId,
      subject: activeEmail.subject, bodyText: activeEmail.bodyText, bodyHtml: activeEmail.bodyHtml, invalidated: false };
  }
  if (activeEmail && amendSourceSnapshot.current && (
    amendSourceSnapshot.current.internetMessageId !== activeEmail.internetMessageId ||
    amendSourceSnapshot.current.subject !== activeEmail.subject ||
    amendSourceSnapshot.current.bodyText !== activeEmail.bodyText ||
    amendSourceSnapshot.current.bodyHtml !== activeEmail.bodyHtml
  )) amendSourceSnapshot.current.invalidated = true;
  const amendSourceChanged = amendSourceSnapshot.current?.invalidated === true;
  // Effects clean up after a render. A result can arrive in the meantime, including
  // after A → B → A, so identity alone is not enough to accept it.
  const isCurrentBinding = (binding: QuoteSelectionBinding) =>
    binding.selectionEpoch === contextRevision.current.selectionEpoch &&
    binding.scopeEpoch === contextRevision.current.scopeEpoch;
  const previousScope = useRef(currentScope);
  const detectedEmail = activeConnection?.email || 'Select an authorized mailbox';
  const {
    trackedDraft,
    trackedInsertSaved,
    trackedSave,
    isDraftPending,
    draftStatus,
    draftedDetails,
    dismissDraftedDetails,
    resetReplyDraft,
  } = useInsertAiDraft({
    activeEmail,
    mailboxEmail: activeConnection?.email,
    transportLoading,
    currentScope,
    contextRevision,
    quoteSession,
    combinedEdit,
    sendCommand,
    supportsAction,
  });
  // The thread's saved reply (Save reply on the webmail panel), offered for Insert in Outlook.
  const savedReplyThreadId =
    preview || isNonActionableBySourceOrSubject ? null : (quoteSession.staffSource?.threadId ?? null);
  const savedReply = useSavedReply(
    (input) => trpcClient.drafts.savedReply.query(input),
    savedReplyThreadId,
  );
  const { testing, testResults, runComprehensiveTest, resetTestResults } = useSystemCheck({
    activeEmail,
    capabilities,
    detectedEmail,
    sendCommand,
  });
  useLayoutEffect(() => {
    if (previousScope.current === currentScope) return;
    previousScope.current = currentScope;
    dispatchQuote({ type: 'reset' });
    resetReplyDraft();
    resetTestResults();
  }, [currentScope]);

  const showDraftPreview = Boolean(
    draftedDetails && activeEmail?.entryId && draftedDetails.entryId === activeEmail.entryId,
  );

  const noConnectionEntry = useRef<string | null>(null);
  useEffect(() => {
    // Diagnostics only, once per selected entry: a granted selection that cannot bind to a mailbox.
    if (
      currentScope && activeEmail?.entryId && (!activeConnection?.id || !activeConnection.email) &&
      noConnectionEntry.current !== activeEmail.entryId
    ) {
      noConnectionEntry.current = activeEmail.entryId;
      reportBridgeFailure('PANE_NO_CONNECTION', { message: 'activeConnection missing id/email' });
    }
    if (!currentScope || !activeEmail?.entryId || !activeConnection?.id || !activeConnection.email) return;
    dispatchQuote({
      type: 'selection',
      binding: {
        transportId: activeConnection.id,
        mailboxEmail: activeConnection.email,
        storeId: activeEmail.storeId ?? '',
        folderEntryId: activeEmail.folderEntryId ?? '',
        entryId: activeEmail.entryId,
        internetMessageId: activeEmail.internetMessageId,
        ...(preview && webSelectedThreadId !== undefined ? { threadId: webSelectedThreadId } : {}),
        selectionEpoch: contextRevision.current.selectionEpoch,
        scopeEpoch: contextRevision.current.scopeEpoch,
      },
    });
  }, [
    activeConnection?.email,
    activeConnection?.id,
    activeEmail?.entryId,
    activeEmail?.folderEntryId,
    activeEmail?.internetMessageId,
    activeEmail?.storeId,
    preview,
    webSelectedThreadId,
    selectedIdentity,
    currentScope,
  ]);

  const quoteAdmissionKey = quoteSession.binding ? admissionKey(quoteSession.binding) : '';
  const quoteAnalysisRetryKey = analysisRetryKey(
    quoteAdmissionKey,
    quoteSession.phase,
    sync.status?.committed,
    quoteSession.treatAs,
    quoteSession.staffNote,
  );
  const contactMessageKey = selectedIdentity ?? '';
  const contactCorrectionKey = `${currentScope ?? ''}::${contactMessageKey}`;
  const [contactCorrection, setContactCorrection] = useState<{
    key: string; fields: Partial<Record<ContactField, string | null>>;
  } | null>(null);
  const pendingContactCorrections = useRef<{
    key: string; fields: Partial<Record<ContactField, string | null>>;
  } | null>(null);
  const hasCachedEdits = Boolean(contactCorrection?.key === contactCorrectionKey && Object.keys(contactCorrection.fields).length) ||
    Boolean(activeConnection?.id && selectedIdentity && recalledPaneEdits(paneEditKey(activeConnection.id, selectedIdentity))) ||
    Boolean(activeConnection?.id && activeEmail?.entryId &&
      recalledGuestName(guestNameCacheKey(activeConnection.id, activeEmail)) !== null);
  // The stored read for the selected mail. A ready or failed read stands in for the live read. A treat-as or a staff
  // note asks for a fresh read, so the stored read is not used then, and it does not re-trigger the effect below.
  const storedWork = useStoredWork({
    trpc: trpcClient,
    internetMessageId: activeEmail?.internetMessageId ?? null,
    selection: sourceSelection,
    selectionEpoch: contextRevision.current.selectionEpoch,
    openMissingWorkItem: !isNonActionableBySourceOrSubject,
    scope: currentScope,
    hasCachedEdits,
    onFullReload: () => {
      if (activeConnection?.id && selectedIdentity) forgetPaneEdits(paneEditKey(activeConnection.id, selectedIdentity));
      if (activeConnection?.id && activeEmail?.entryId) forgetGuestName(guestNameCacheKey(activeConnection.id, activeEmail));
      requestWorkItem.discard();
      amendWorkItem.discard();
      setContactCorrection(null);
      pendingContactCorrections.current = null;
      const binding = quoteSessionRef.current.binding;
      dispatchQuote({ type: 'reset' });
      if (binding && isCurrentBinding(binding)) dispatchQuote({ type: 'selection', binding });
    },
  });
  const amendWorkItem = useAmendWorkItem({ trpc: trpcClient,
    snapshot: storedWork.pane.state === 'ready' ? storedWork.pane.amendDraft ?? null : null,
    transportId: storedWork.transportId ?? activeConnection?.id ?? null,
    reload: storedWork.reloadAmendDraft, canSaveSnapshot: storedWork.canSaveSnapshot, flushSnapshot: storedWork.flushSnapshot,
    onSave: storedWork.noteAmendSave });
  const requestWorkItem = useRequestWorkItem({ trpc: trpcClient,
    snapshot: storedWork.pane.state === 'ready' ? storedWork.pane.amendDraft ?? null : null,
    transportId: storedWork.transportId, flushSnapshot: storedWork.flushSnapshot, canSaveSnapshot: storedWork.canSaveSnapshot,
    reload: storedWork.reloadAmendDraft, onSave: storedWork.noteAmendSave });
  const amendRefresh = useAmendExtractionRefresh({ trpc: trpcClient,
    snapshot: !amendSourceChanged && storedWork.pane.state === 'ready' && storedWork.pane.kind === 'amendment'
      ? storedWork.pane.amendDraft ?? null : null,
    transportId: storedWork.transportId,
    selectionKey: selectedIdentity ? JSON.stringify([currentScope, selectedIdentity, contextRevision.current.selectionEpoch]) : null,
    editVersion: amendWorkItem.editVersion, hasDraft: amendWorkItem.available,
    flush: amendWorkItem.flush, reload: storedWork.reloadRefreshedAmend });
  const isExistingStayInformation =
    selfSentPreStay ||
    (storedWork.pane.state === 'ready' && storedWork.pane.existingStayInformation === true);
  const isNonActionableMessage = isNonActionableMailSource || isExistingStayInformation;
  const contactEditorKey = `${contactCorrectionKey}|${
    storedWork.pane.state === 'ready'
      ? `ready:${storedWork.pane.workItemId ?? ''}${storedWork.historyEpoch ? `:h${storedWork.historyEpoch}` : ''}`
      : storedWork.pane.state
  }`;
  const senderFallback =
    storedWork.pane.state === 'ready' ? null : externalSenderFallback(activeEmail, activeConnection?.email);
  const sourceContact: StoredContact | null =
    storedWork.pane.state === 'ready'
      ? storedWork.pane.contact
      : senderFallback
        ? { ...senderFallback, bookingAgency: null, organization: null, phone: null }
        : null;
  const normalizedContact = sourceContact ? { ...sourceContact } : null;
  const contactFields = contactCorrection?.key === contactCorrectionKey ? contactCorrection.fields : null;
  const documentContact = contactFields
    ? {
        ...(normalizedContact ?? { name: null, bookingAgency: null, organization: null, email: null, phone: null }),
        ...contactFields,
      }
    : normalizedContact;
  const documentContactRef = useRef(documentContact);
  documentContactRef.current = documentContact;
  useEffect(() => {
    if (storedWork.historyEpoch === 0) return;
    setContactCorrection(null);
    pendingContactCorrections.current = null;
    const transportId = quoteSession.binding?.transportId;
    if (transportId && contactMessageKey) forgetPaneEdits(paneEditKey(transportId, contactMessageKey));
  }, [storedWork.historyEpoch]);
  const workItemPane =
    storedWork.pane.state === 'ready' && storedWork.pane.workItemId
      ? {
          fieldProvenance: storedWork.pane.fieldProvenance ?? {},
          refs: storedWork.pane.refs ?? {},
          ...(requestWorkItem.available ? { requestDraft: requestWorkItem } : {}),
          ...(storedWork.pane.amendDraft && storedWork.transportId ? { rateDraft: {
            snapshot: storedWork.pane.amendDraft,
            trpc: trpcClient,
            transportId: storedWork.transportId,
            flush: storedWork.flushForBinding,
            onSave: storedWork.noteAmendSave,
          } } : {}),
          onResetContact: storedWork.resetAvailable && !requestWorkItem.pending && !storedWork.saveFailed
            ? () => storedWork.resetSection({ type: 'contact' })
            : undefined,
          onResetStay: storedWork.resetAvailable && !requestWorkItem.pending && !storedWork.saveFailed
            ? (stayId: string) => storedWork.resetSection({ type: 'stay', stayId })
            : undefined,
          resetPending: storedWork.historyPending || storedWork.historyNeedsReload,
          historyBusy: storedWork.historyPending || storedWork.historyNeedsReload,
          historyEpoch: storedWork.historyEpoch,
          bindingCursor: storedWork.bindingCursor,
          editGeneration: storedWork.editGeneration,
          bindingPending: storedWork.saveFailed || amendWorkItem.pending || amendRefresh.pending,
        }
      : null;
  const recordContact = (field: ContactField, value: string | null) => {
    if (storedWork.historyPending || storedWork.historyNeedsReload) return;
    const previous = documentContactRef.current ?? {
      name: null,
      bookingAgency: null,
      organization: null,
      email: null,
      phone: null,
    };
    const contact = { ...previous, [field]: value };
    documentContactRef.current = contact;
    setContactCorrection((prior) => ({
      key: contactCorrectionKey,
      fields: {
        ...(prior?.key === contactCorrectionKey ? prior.fields : {}),
        [field]: value,
      },
    }));

    const pending = pendingContactCorrections.current;
    const hasStoredWorkItem =
      storedWork.pane.state === 'ready' && Boolean(storedWork.pane.workItemId);
    if (!hasStoredWorkItem) {
      pendingContactCorrections.current = {
        key: contactCorrectionKey,
        fields: {
          ...(pending?.key === contactCorrectionKey ? pending.fields : {}),
          [field]: value,
        },
      };
      storedWork.recordContact(field, value);
      return;
    }
    if (pending?.key === contactCorrectionKey) {
      const fields = { ...pending.fields, [field]: value };
      pendingContactCorrections.current = null;
      for (const [pendingField, pendingValue] of Object.entries(fields)) {
        storedWork.recordContact(pendingField as ContactField, pendingValue);
      }
      return;
    }
    pendingContactCorrections.current = null;
    storedWork.recordContact(field, value);
  };
  useEffect(() => {
    const pending = pendingContactCorrections.current;
    if (!pending) return;
    if (pending.key !== contactCorrectionKey) {
      pendingContactCorrections.current = null;
      return;
    }
    if (storedWork.pane.state !== 'ready' || !storedWork.pane.workItemId) return;
    pendingContactCorrections.current = null;
    for (const [field, value] of Object.entries(pending.fields)) {
      storedWork.recordContact(field as ContactField, value);
    }
  }, [
    contactCorrection,
    contactCorrectionKey,
    storedWork.pane.state,
    storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : null,
    storedWork.recordContact,
  ]);
  const treatAsMailKey = paneEditKey(activeConnection?.id ?? '', contactMessageKey);
  useEffect(() => {
    if (!quoteSession.binding || !treatAsMailKey) return;
    const saved = readTreatAs(treatAsMailKey);
    if (!saved || quoteSession.treatAs) return;
    dispatchQuote({ type: 'treat_as', treatAs: saved });
  }, [treatAsMailKey, quoteSession.binding, quoteSession.treatAs]);
  const [partySuggestions, setPartySuggestions] = useState<PartySuggestion[]>([]);
  const senderEmail = activeEmail?.senderEmail ?? '';
  const bodyText = activeEmail?.bodyText ?? '';
  useEffect(() => {
    setPartySuggestions([]);
    if (!PANE_PARTY_SUGGESTER || !contactMessageKey) return;
    let cancelled = false;
    void PANE_PARTY_SUGGESTER({
      sender: senderEmail,
      body: bodyText.slice(0, 20_000),
    }).then(
      (reply) => {
        if (!cancelled) setPartySuggestions(reply.suggestions);
      },
      () => {
        if (!cancelled) setPartySuggestions([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [contactMessageKey, senderEmail, bodyText]);
  const suppressAutoStaffQuoteForCurrentEmail = () => {
    if (!contactMessageKey) return;
    staffQuoteAutoSuppressed.current.add(contactMessageKey);
    rememberAutoStaffQuoteSuppression(contactMessageKey);
  };
  const storedOverridden = Boolean(quoteSession.treatAs || quoteSession.staffNote);
  // The pane's work item for telemetry (v5 B1). Opening a stored read with a work item is the pane.opened action.
  const surface = onOpenThread ? 'web' : 'outlook';
  const paneWorkItemId = storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : null;
  const paneTransportId = storedWork.transportId;
  useEffect(() => {
    const owner = paneWorkItemId ? { workItemId: paneWorkItemId, transportId: paneTransportId } : null;
    setPaneTelemetryScope(owner ? { ...owner, surface } : null);
    if (owner) trackPaneAction({ type: 'pane.opened' }, owner);
  }, [paneWorkItemId, paneTransportId, surface]);
  /** A staff edit to the stay rows. On a stored read it is logged against the work item, so it is there on reopen. */
  const editStayRows = (action: QuoteSessionAction) => {
    suppressAutoStaffQuoteForCurrentEmail();
    const before = quoteSessionRef.current;
    dispatchQuote(action);
    const after = reduceQuoteSession(before, action);
    storedWork.recordGroups(before.groups, after.groups);
    if (after.binding && isCurrentBinding(after.binding) && contactMessageKey) {
      rememberPaneEdits(paneEditKey(after.binding.transportId, contactMessageKey), after.groups);
    }
  };
  // Keep the lookup deadline separate from its payload: a late ready result changes the decision to stored, not to
  // another live read. With a treat-as or note, only Retry read (its count) re-runs the live analysis.
  const storedGate = storedWork.pane.state === 'ready' && storedWork.pane.staffManual
    ? `manual|${storedWork.key}|${storedWork.pane.workItemId}`
    : storedOverridden && !storedWork.retryInProgress &&
    storedWork.pane.state !== 'loading' && storedWork.pane.state !== 'failed'
    ? `override|${storedWork.retryCount}`
    : `${storedWork.key}|timed-out:${storedWork.lookupTimedOut}`;
  useEffect(() => {
    if (isNonActionableMessage) return;
    const binding = quoteSession.binding;
    if (!binding || !quoteAdmissionKey || !isCurrentBinding(binding)) return;
    // The binding follows the selected mail one render later. Until then it names the previous mail.
    if ((binding.internetMessageId ?? null) !== (activeEmail?.internetMessageId ?? null)) return;
    dispatchQuote({ type: 'analysis_started' });
    const workflow = quoteWorkflowFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    const decision = storedDecision(storedWork.pane, storedOverridden);
    if (decision.kind === 'ready') {
      const manual = storedWork.pane.state === 'ready' && storedWork.pane.staffManual;
      const chooseBooking = { type: 'treat_as', treatAs: 'create_booking' } as const;
      if (manual && quoteSessionRef.current.treatAs !== 'create_booking') dispatchQuote(chooseBooking);
      const ready = {
        type: 'analysis_ready',
        analysis: analysisWithPaneEdits(
          decision.analysis,
          binding.transportId,
          contactMessageKey,
        ),
      } as const;
      const current = manual ? reduceQuoteSession(quoteSessionRef.current, chooseBooking) : quoteSessionRef.current;
      const before = reduceQuoteSession(current, { type: 'analysis_started' });
      dispatchQuote({ type: 'mailbox_status', status: 'ready' });
      dispatchQuote(ready);
      // What she typed into the blank stay while the stored read loaded is laid over its stays. Log it like any edit.
      if (before.groups.some((group) => group.id === DRAFT_GROUP_ID)) {
        // The read as a first read, the way analysis_ready reads it under her typing, so the diff is only her typing.
        const first = { ...before, groups: [], inputRevision: 0, stayRevision: 0, analysisStartStayRevision: null };
        const plain = reduceQuoteSession(first, ready).groups;
        storedWork.recordGroups(plain, reduceQuoteSession(before, ready).groups);
      }
    } else if (decision.kind === 'failed') {
      dispatchQuote({ type: 'mailbox_status', status: 'ready' });
      dispatchQuote({ type: 'analysis_failed', message: decision.reason });
    }
    let cancelled = false;
    if (decision.kind === 'live') void bindAnalyseSelection({
      mutate: workflow.analyseSelection?.mutate,
      input: {
        internetMessageId: binding.internetMessageId,
        ...(sourceSelection ? { selection: sourceSelection } : {}),
        storeId: binding.storeId,
        entryId: binding.entryId,
        folderEntryId: binding.folderEntryId,
        selectionEpoch,
        ...(quoteSession.treatAs ? { treatAs: quoteSession.treatAs } : {}),
        ...(quoteSession.staffNote ? { staffNote: quoteSession.staffNote } : {}),
      },
    })
      .then((remote) => {
        if (cancelled || !isCurrentBinding(binding)) return;
        if (remote.kind === 'ready') {
          dispatchQuote({ type: 'mailbox_status', status: 'ready' });
          dispatchQuote({
            type: 'analysis_ready',
            analysis: analysisWithPaneEdits(
              remote.analysis,
              binding.transportId,
              contactMessageKey,
            ),
          });
          if (!storedOverridden && remote.analysis.amendment?.kind === 'amend') void storedWork.rebindAmendDraft();
          return;
        }
        if (remote.kind === 'unsynced') {
          dispatchQuote({ type: 'mailbox_status', status: 'unsynced' });
          dispatchQuote({ type: 'analysis_unsynced' });
          return;
        }
        if (remote.kind === 'missing_source') {
          dispatchQuote({ type: 'mailbox_status', status: 'missing_source' });
          dispatchQuote({
            type: 'analysis_missing_source',
            missing: remote.missing,
            documents: remote.documents,
          });
          return;
        }
        dispatchQuote({ type: 'mailbox_status', status: 'unavailable' });
        dispatchQuote({ type: 'analysis_failed', message: remote.reason });
      })
      .catch((error: unknown) => {
        if (cancelled || !isCurrentBinding(binding)) return;
        const message =
          error instanceof Error && error.message.trim() ? error.message : 'Nava could not read this email. Select it again and try again.';
        dispatchQuote({ type: 'mailbox_status', status: 'unavailable' });
        dispatchQuote({ type: 'analysis_failed', message });
      });
    return () => { cancelled = true; };
    // Admission key is the selection identity. Body/subject are no longer read on the client.
    // Unsynced retries when mailbox committed count advances (sync finished ingesting this mail).
  }, [quoteAnalysisRetryKey, storedGate, isNonActionableMessage]);

  // Work-item lookup can finish after an overridden analysis; refresh task controls without re-running the model.
  useEffect(() => {
    if (isNonActionableMessage) return;
    const binding = quoteSession.binding;
    if (!binding || !quoteAdmissionKey || !isCurrentBinding(binding) ||
      (binding.internetMessageId ?? null) !== (activeEmail?.internetMessageId ?? null)) return;
    let cancelled = false;
    let candidateTimer: ReturnType<typeof setTimeout> | undefined;
    const staff = staffQuoteFromTrpc(trpcClient);
    void bindStaffQuoteSource({
      query: staff.workstation.staffQuoteSource?.query,
      internetMessageId: binding.internetMessageId,
      selection: sourceSelection,
    }).then((source) => {
      if (cancelled || !isCurrentBinding(binding)) return;
      if (source.kind === 'message_not_synced') {
        dispatchQuote({ type: 'mailbox_status', status: 'unsynced' });
        return;
      }
      if (source.kind !== 'ready') return;
      dispatchQuote({ type: 'staff_source_ready', source: source.source });
      const refreshActions = async () => {
        const generation = preparedTaskGeneration.current;
        const actions = await bindStaffActions({
          query: staff.drafts.reviewForMessage?.query,
          threadId: source.source.threadId,
          messageId: source.source.messageId,
          ...(paneWorkItemId ? { workItemId: paneWorkItemId } : {}),
        });
        if (cancelled || !isCurrentBinding(binding) || generation !== preparedTaskGeneration.current || actions.kind !== 'ready') return false;
        dispatchQuote({ type: 'staff_actions_ready', actions: actions.actions, tasks: actions.tasks });
        return true;
      };
      const candidateQuery = (trpcClient as unknown as { ai?: { hmsCandidateState?: {
        query?: (input: { threadId: string }, options?: ReturnType<typeof inMailbox>) => Promise<{ activeRun?: unknown }>;
      } } }).ai?.hmsCandidateState?.query;
      void (async () => {
        await refreshActions();
        if (cancelled || !isCurrentBinding(binding)) return;
        let sawActive = false, idleChecks = 0;
        const watch = async () => {
          let running = false, statusRead = false;
          try {
            if (candidateQuery) {
              const state = await candidateQuery({ threadId: source.source.threadId }, inMailbox(binding.transportId));
              if (cancelled || !isCurrentBinding(binding)) return;
              statusRead = true;
              running = Boolean(state.activeRun);
              if (running) { sawActive = true; idleChecks = 0; }
            }
          } catch { /* Review can still be available when candidate status is not. */ }
          if (!running && await refreshActions() && sawActive && statusRead) return;
          if (!cancelled && isCurrentBinding(binding) && (running || ++idleChecks < 12)) candidateTimer = setTimeout(() => void watch(), 5000);
        };
        await watch();
      })();
    });
    return () => {
      cancelled = true;
      if (candidateTimer) clearTimeout(candidateTimer);
    };
  }, [quoteAnalysisRetryKey, storedGate, isNonActionableMessage, paneWorkItemId]);

  useEffect(() => {
    const fields = missingQuoteReplyFieldsForGroups(quoteSession.groups);
    if (fields.length && missingQuoteDetailsReplyOnly(quoteSession)) {
      const html = missingQuoteDetailsWrapperHtml(
        replyGreetingName(documentContact?.name, activeEmail),
        fields,
        staffSignerName,
        activePaneConfig?.propertyCode,
      );
      if (
        (!quoteSession.reviewedReplyHtml.trim() && !quoteSession.reviewedReplyEdited) ||
        (quoteSession.reviewedReplySource === 'missing_quote_details' && quoteSession.reviewedReplyHtml !== html)
      ) {
        dispatchQuote({ type: 'set_reviewed_reply', html, source: 'missing_quote_details' });
      }
      return;
    }
    if (quoteSession.reviewedReplySource === 'missing_quote_details') {
      dispatchQuote({ type: 'set_reviewed_reply', html: '' });
    }
  }, [
    activeEmail?.senderEmail,
    activeEmail?.senderName,
    documentContact?.name,
    quoteSession.analysis,
    quoteSession.groups,
    quoteSession.reviewedReplyEdited,
    quoteSession.reviewedReplyHtml,
    quoteSession.reviewedReplySource,
    staffSignerName,
    activePaneConfig?.propertyCode,
  ]);

  const priorQuoteKey = [
    quoteSession.analysis?.luna?.workflow ?? '',
    quoteSession.staffSource?.threadId ?? '',
    String(quoteSession.inputRevision),
    String(quoteSession.stayRevision),
    String(quoteSession.binding?.selectionEpoch ?? 0),
    quoteSession.groups
      .map((group) => `${group.arrivalDate ?? ''}:${group.departureDate ?? ''}:${group.quantity ?? ''}:${group.adults ?? ''}`)
      .join(','),
    quoteSession.staffQuote ? 'quoted' : '',
    Object.keys(quoteSession.staffQuotes).join(','),
  ].join(':');
  useEffect(() => {
    const paneConfig = activePaneConfig;
    const registryStrategies = paneConfig?.salesStrategies ?? [];
    const source = quoteSession.staffSource;
    const binding = quoteSession.binding;
    const isQuote = quoteSession.analysis?.intent === 'quote' || quoteSession.analysis?.luna?.workflow === 'quote';
    if (
      isNonActionableMessage ||
      quoteSession.phase === 'analysing' ||
      !isQuote ||
      !source ||
      !binding ||
      !paneConfig ||
      binding.transportId !== paneConfig.transportId ||
      !registryStrategies.length ||
      staffQuoteQueueMode === 'checking'
    ) return;

    const staff = staffQuoteFromTrpc(trpcClient);
    const staffQuoteJob = staffQuoteQueueMode === 'on'
      ? trackRatesJob(staff.workstation.staffQuoteJob?.query, source)
      : undefined;
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = quoteSession.inputRevision;
    const header = quoteSession.staffHeader;
    const stayKeys = requestedQuoteKeys(quoteSession.groups);
    for (const stayKey of stayKeys) {
      const groups = quoteSession.groups.filter((group) => stayKeyForGroup(group) === stayKey);
      const stayRevision = quoteStrategyStayRevision(quoteSession, stayKey);
      const attemptKey = JSON.stringify([
        binding.transportId,
        source.messageId,
        source.sourceHash,
        selectionEpoch,
        inputRevision,
        stayKey,
        stayRevision,
        paneConfig.propertyCode,
        staffQuoteQueueMode,
        registryStrategies.map((strategy) => [strategy.code, strategy.requestValue]),
      ]);
      if (quoteStrategyBindAttempts.current.has(attemptKey)) continue;
      quoteStrategyBindAttempts.current.add(attemptKey);
      dispatchQuote({
        type: 'quote_strategy_comparison_started',
        stayKey,
        selectionEpoch,
        stayRevision,
        strategyCodes: registryStrategies.map((strategy) => strategy.code),
      });
      void bindStaffQuoteStrategies({
        staffQuoteJob,
        registryStrategies,
        source,
        selectionEpoch,
        inputRevision,
        groups,
        header,
        propertyCode: paneConfig.propertyCode,
        configuration: paneConfig,
        stayKey,
        onResult: ({ strategyCode, row, result }) => dispatchQuote({
          type: 'quote_strategy_comparison_result',
          stayKey,
          selectionEpoch,
          stayRevision,
          strategyCode,
          outcome: {
            strategyCode,
            row,
            ...(result ? {
              result: {
                offer: result.offer,
                staffQuote: result.staffQuote,
                ...(result.extrasReviewItems ? { extrasReviewItems: result.extrasReviewItems } : {}),
              },
            } : {}),
          },
        }),
      }).then((results) => {
        if (results.some(({ retryable, row }) => retryable || row.status === 'pending')) {
          quoteStrategyBindAttempts.current.delete(attemptKey);
        }
      });
    }
  }, [
    activePaneConfig?.propertyCode,
    activePaneConfig?.transportId,
    isNonActionableMessage,
    priorQuoteKey,
    quoteStrategyRegistryKey,
    staffQuoteQueueMode,
    quoteSession.phase,
  ]);

  useEffect(() => {
    if (isNonActionableMessage || quoteSession.phase === 'analysing') return;
    const luna = quoteSession.analysis?.luna;
    const source = quoteSession.staffSource;
    const binding = quoteSession.binding;
    // Each date option waits for its own earlier quote. An option that already has a run or a draft is left alone.
    // A single stay waits as one, dated or not, so its first accepted prior quote binds as it did before date options.
    const stayKeys = requestedQuoteKeys(quoteSession.groups);
    const singleStayKey = stayKeys.length <= 1 ? (stayKeys[0] ?? 'unknown:unknown') : null;
    const waiting = (singleStayKey ? [singleStayKey] : stayKeys).filter(
      (key) => !quoteSession.staffQuotes[key] && !quoteSession.bookingDrafts[key],
    );
    const isBooking = luna?.workflow === 'create_booking';
    const isQuote = quoteSession.analysis?.intent === 'quote' || luna?.workflow === 'quote';
    if ((!isBooking && !isQuote) || !source || !binding || waiting.length === 0) {
      return;
    }
    if (isQuote && !isBooking && staffQuoteQueueMode !== 'on') {
      return;
    }
    const generation = ++staffQuoteReadBackGeneration.current;
    const sourceIdentity = quoteSourceIdentity(quoteSession);
    const stepVersions = new Map(waiting.map((stayKey) => [stayKey,
      staffQuoteStepGenerations.current.get(`${sourceIdentity}:${stayKey}`) ?? 0]));
    const readBackCurrent = () => !cancelled && staffQuoteReadBackGeneration.current === generation &&
      quoteSourceIdentity(quoteSessionRef.current) === sourceIdentity &&
      [...stepVersions].every(([stayKey, version]) =>
        (staffQuoteStepGenerations.current.get(`${sourceIdentity}:${stayKey}`) ?? 0) === version);
    staffQuoteReadBackInFlight.current = true;
    const staff = staffQuoteFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = quoteSession.inputRevision;
    // A stay edit does not always move inputRevision, so the result is also tied to the rows it read.
    const stayRevision = quoteSession.stayRevision;
    const header = quoteSession.staffHeader;
    let cancelled = false;
    const pollController = new AbortController();
    const unquotedStayKey = waiting.length === 1 && stayKeys.length <= 1 ? waiting[0]! : null;
    const unquotedMutate = staff.workstation.prepareUnquotedBookingDraft?.mutate;
    if (
      isBooking &&
      unquotedStayKey &&
      luna &&
      unquotedMutate &&
      !(luna.flags ?? []).some((flag) => flag === 'conference_or_group' || flag === 'rooms_only_group')
    ) {
      const rateCode = quoteSession.groups.find((group) => stayKeyForGroup(group) === unquotedStayKey)?.rateCode;
      void unquotedMutate({
        messageId: source.messageId,
        selectionEpoch,
        inputRevision,
        analysis: { ...luna, groups: overlayLunaGroupsFromStaff(luna, quoteSession.groups) },
        groupIds: quoteSession.groups.map((group) => group.id),
        ...(rateCode ? { rateCode } : {}),
      })
        .then((result) => {
          if (
            !readBackCurrent() ||
            result?.status !== 'ready' ||
            result.revisionRef !== UNQUOTED_BOOKING_REVISION_REF ||
            result.selectionEpoch !== selectionEpoch ||
            result.inputRevision !== inputRevision ||
            result.messageId !== source.messageId ||
            !result.draft?.rooms ||
            !result.options ||
            !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })
          ) {
            return;
          }
          dispatchQuote({ type: 'booking_draft_ready', payload: result, sourceHash: source.sourceHash });
        })
        .catch(() => undefined);
    }
    const readBack = (async () => {
      const readBacks = await trackStaffQuoteRun(
        Promise.all(
          waiting.map(async (stayKey) => {
            const groups = quoteSession.groups.filter(
              (group) => stayKeyForGroup(group) === stayKey,
            );
            const result = await bindReadBackStaffQuote({
              query: trackRatesJob(staff.workstation.staffQuoteJob?.query, source),
              signal: pollController.signal,
              source,
              selectionEpoch,
              inputRevision,
              groups,
              header,
              propertyCode: activePaneConfig?.propertyCode,
              configuration: activePaneConfig,
              stayKey,
            });
            return { stayKey, result };
          }),
        ),
      );
      if (
        !readBackCurrent() ||
        !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })
      ) return;

      const unbound = new Set(waiting);
      type RestoredStaffQuote = Extract<
        Awaited<ReturnType<typeof bindReadBackStaffQuote>>,
        { status: 'ok' }
      >;
      const restored: Array<{ stayKey: string; result: RestoredStaffQuote }> = [];
      for (const row of readBacks) {
        if (!row.result) continue;
        if (row.result.status === 'ok') {
          unbound.delete(row.stayKey);
          restored.push({ stayKey: row.stayKey, result: row.result });
        } else if (row.result.detail) {
          // Business refusals are persisted as completed jobs; don't replace that exact answer with an older quote.
          unbound.delete(row.stayKey);
          toast.warning(row.result.reason);
        }
      }

      const reused: Array<{ stayKey: string; prior: UsePriorQuoteForBookingReady }> = [];
      const reasons: string[] = [];
      let expiredPrior: PriorStaffQuoteRequoteRow | null = null;
      if (unbound.size > 0 && isBooking && luna) {
        const revisions = await bindListThreadQuoteRevisions({
          query: staff.workstation.listThreadQuoteRevisions?.query,
          threadId: source.threadId,
        });
        for (const row of revisions) {
          if (!readBackCurrent() || unbound.size === 0) break;
          const candidate = await bindUsePriorQuoteForBooking({
            mutate: staff.workstation.usePriorQuoteForBooking?.mutate,
            source,
            workflowRunId: row.workflowRunId,
            revisionRef: row.revisionRef,
            threadId: source.threadId,
            messageId: source.messageId,
            selectionEpoch,
            inputRevision,
            analysis: {
              ...luna,
              groups: overlayLunaGroupsFromStaff(luna, quoteSession.groups),
            },
          });
          if (!readBackCurrent()) return;
          if (candidate.status !== 'ok') {
            reasons.push(candidate.reason);
            if (candidate.reason === 'expired' && !expiredPrior) {
              expiredPrior = { workflowRunId: row.workflowRunId, revisionRef: row.revisionRef };
            }
            continue;
          }
          // A candidate binds only to a stay that is still waiting for one. Other rows of that stay are skipped.
          const stayKey =
            singleStayKey ?? `${candidate.payload.arrivalDate}:${candidate.payload.departureDate}`;
          if (!unbound.has(stayKey)) continue;
          unbound.delete(stayKey);
          reused.push({ stayKey, prior: candidate.payload });
        }
      }
      if (
        !readBackCurrent() ||
        !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })
      ) return;

      for (const row of restored) {
        if (!readBackCurrent() || !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })) {
          toast.warning('Details changed while HMS was searching — search availability again.');
          return;
        }
        dispatchQuote({
          type: 'staff_quote_ready',
          offer: row.result.offer,
          staffQuote: row.result.staffQuote,
          selectionEpoch,
          inputRevision,
          stayRevision,
          extrasReviewItems: row.result.extrasReviewItems,
          approvedHeader: header,
        });
        for (const item of row.result.extrasReviewItems) toast.warning(item);
        if (isBooking && luna) {
          if (!readBackCurrent() || !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })) {
            toast.warning('Details changed while HMS was searching — search availability again.');
            return;
          }
          void bindPrepareBookingDraft({
            mutate: staff.workstation.prepareBookingDraft?.mutate,
            source,
            workflowRunId: row.result.staffQuote.workflowRunId,
            revisionRef: row.result.staffQuote.revisionRef,
            messageId: source.messageId,
            selectionEpoch,
            inputRevision,
            analysis: {
              ...luna,
              groups: overlayLunaGroupsFromStaff(luna, quoteSession.groups),
            },
          }).then((draftRemote) => {
            if (draftRemote.status !== 'ok') {
              toast.warning(draftRemote.reason);
              return;
            }
            if (!readBackCurrent() || !quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })) {
              toast.warning('Details changed while HMS was searching — search availability again.');
              return;
            }
            dispatchQuote({
              type: 'booking_draft_ready',
              payload: draftRemote.payload,
              sourceHash: source.sourceHash,
            });
          });
        }
      }

      for (const { stayKey, prior } of reused) {
        const stayRow = quoteSession.groups.find((group) => stayKeyForGroup(group) === stayKey);
        dispatchQuote({
          type: 'staff_quote_ready',
          offer: {
            id: prior.revisionRef,
            kind: 'allocation',
            roomCode: prior.roomCode,
            roomLabel: 'Selected allocation',
            mealPlan: offerBoardFromRevision(prior.mealPlan),
            rateCode: prior.rateCode,
            currency: 'ZAR',
            nightly: [],
            stayTotalMinor: prior.totalMinor,
            observedAt: '',
            sourceRef: prior.revisionRef,
            restrictions: [],
            combinable: true,
            quoteRequestKey: stayKey,
            coversGroupIds: stayRow ? [stayRow.id] : [],
            quantity: stayRow?.quantity,
          },
          staffQuote: {
            workflowRunId: prior.workflowRunId,
            revisionRef: prior.revisionRef,
            factRefs: [],
            messageId: source.messageId,
            threadId: source.threadId,
            sourceHash: source.sourceHash,
            selectionEpoch,
            inputRevision,
            inputDigest: prior.revisionRef,
            totalMinor: prior.totalMinor,
            currency: prior.currency,
            quoteRequestKey: stayKey,
            approvedHeader: header,
            // What the earlier run charged, not what the header asks now: a combined quote checks it on each stay.
            onceExtras: prior.onceExtras,
          },
          selectionEpoch,
          inputRevision,
          stayRevision,
        });
        dispatchQuote({
          type: 'booking_draft_ready',
          payload: {
            draft: prior.draft,
            options: prior.options,
            messageId: prior.messageId,
            selectionEpoch: prior.selectionEpoch,
            inputRevision: prior.inputRevision,
            revisionRef: prior.revisionRef,
          },
          sourceHash: source.sourceHash,
        });
      }

      if (unbound.size > 0) {
        const notice = expiredPriorQuoteNotice(reasons, expiredPrior);
        if (notice === 'requote' && expiredPrior) {
          toast.warning(expiredPriorQuoteToastMessage(), {
            action: {
              label: EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL,
              onClick: () => {
                requoteSameStayRef.current(expiredPrior);
              },
            },
          });
        } else if (notice === 'mismatch') {
          toast.warning('The dates no longer match the earlier quote. Run the search again.');
        }
      }
    })();
    void readBack.then(
      () => {
        if (staffQuoteReadBackGeneration.current === generation) {
          staffQuoteReadBackInFlight.current = false;
          if (isQuote && !isBooking) autoStartStaffQuoteStepRef.current();
        }
      },
      () => {
        if (staffQuoteReadBackGeneration.current === generation) {
          staffQuoteReadBackInFlight.current = false;
        }
      },
    );
    return () => {
      cancelled = true;
      pollController.abort();
      if (staffQuoteReadBackGeneration.current === generation) {
        staffQuoteReadBackGeneration.current += 1;
        staffQuoteReadBackInFlight.current = false;
      }
    };
  }, [priorQuoteKey, isNonActionableMessage, staffQuoteQueueMode, activePaneConfig?.transportId, quoteSession.phase]);

  useStaffQuoteAutostart({
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
    runQuoteStep: (stepId, autoStart, readBack) => runQuoteStepRef.current(stepId, autoStart, readBack),
    autoStaffQuoteSuppressed,
    staffQuoteAttemptKey,
  });

  // Onboarding & Screen State
  const [currentScreen, setCurrentScreen] = useState<PaneScreen>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('nava_onboarding_completed');
        if (saved === 'true') return 'tool';
      } catch {
        // Fall back gracefully if browser storage is restricted or throws
      }
    }
    return 'welcome';
  });
  // Preview starts on the quoting tool; the welcome, connection and tour screens never show there.
  const shownScreen: PaneScreen = preview && currentScreen !== 'needs-you' ? 'tool' : currentScreen;
  // One list for the header entry and the screen, so a dismiss on the screen moves the entry count at once.
  const needsYou = useNeedsYou(trpcClient);
  const selectedReadKind = storedWork.pane.state === 'ready' ? storedWork.pane.kind : null;
  const existingStayConfirmationNumbers =
    storedWork.pane.state === 'ready' && (storedWork.pane.confirmationNumbers ?? []).length > 0
      ? storedWork.pane.confirmationNumbers ?? []
      : selfSentPreStayBodyConfirmationNumbers(`${activeEmail?.subject ?? ''}\n${selfPreStayBodyText}`);
  const savedStays = storedWork.pane.state === 'ready' ? storedWork.pane.savedStays : undefined;
  const separateAsk = storedWork.pane.state === 'ready'
    ? storedWork.pane.separateAsk ?? null
    : null;
  // Without a stored read that explicitly verified no other ask, the card never reads as "no action": a missing or
  // non-self-prestay extraction verdict leaves the current mail for staff to review.
  const separateAskReview =
    isExistingStayInformation &&
    !separateAsk &&
    !(storedWork.pane.state === 'ready' &&
      storedWork.pane.existingStayInformation === true &&
      storedWork.pane.separateAskReview === false);
  const classifiedReadAs = isExistingStayInformation
    ? separateAsk || separateAskReview ? 'other_to_do' : 'not_for_nava'
    : readAsForAnalysis(quoteSession.analysis, {
        kind: selectedReadKind,
        treatAs: quoteSession.treatAs,
      });
  // Channel/system mail never opens the quote flow. A stored payment kind may still show its read-only voucher lookup.
  const readAs = isNonActionableMailSource && !isExistingStayInformation
    ? (classifiedReadAs === 'payment' ? 'payment' : 'not_for_nava')
    : classifiedReadAs;
  const contactInPeople =
    (readAs === 'quote' || readAs === 'group') &&
    !hideQuoteWorkspace(quoteSession.phase);
  const mailSourceNoActionNotice = nonActionableMailSource ? (
    <MailSourceNoActionCard
      kind={nonActionableMailSource.kind}
      source={nonActionableMailSource.source}
      voucherLookupOnly={readAs === 'payment'}
    />
  ) : null;
  const currentNeedsYouRow = needsYou.rows.find((row) => row.id === paneWorkItemId);
  const workState =
    currentNeedsYouRow
      ? currentNeedsYouRow.status === 'done' || currentNeedsYouRow.status === 'dismissed'
        ? null
        : currentNeedsYouRow.chip
      : workStateForStatus(storedWork.pane.state === 'ready' ? storedWork.pane.workItemStatus : null);
  const [tourSlideIndex, setTourSlideIndex] = useState(0);
  const [pingState, setPingState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [serverPingTimeStr, setServerPingTimeStr] = useState<string | null>(null);
  const [pingErrorMessage, setPingErrorMessage] = useState<string | null>(null);

  const mailboxLabel = activeConnection?.email || 'No mailbox connected';
  const mailboxDescription =
    activeConnection?.name && activeConnection.name !== activeConnection.email
      ? `${activeConnection.name} — ${activeConnection.email}`
      : mailboxLabel;

  const executeServerPing = async () => {
    setPingState('loading');
    setPingErrorMessage(null);
    try {
      const resp = await trpcClient.workstation.ping.mutate({
        workstationUser: 'unknown',
        outlookEmail: detectedEmail,
        outlookVersion: capabilities?.outlookVersion ?? 'unknown',
      });
      if (resp?.status === 'ok') {
        const d = resp.serverTime ? new Date(resp.serverTime) : new Date();
        const formatted = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} UTC`;
        setServerPingTimeStr(formatted);
        setPingState('success');
      } else {
        setPingState('error');
        setPingErrorMessage('Server ping returned non-OK status');
      }
    } catch (err) {
      setPingState('error');
      setPingErrorMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  // Retained staff-note text survives a trip off the tool screen (the ⋯ menu's Check connection).
  // The sent text is kept, so a note that was already re-read does not block reloads.
  const [staffNoteDraft, setStaffNoteDraft] = useState('');
  const [staffNoteSent, setStaffNoteSent] = useState('');
  const unsentStaffNote = staffNoteDraft.trim() !== '' && staffNoteDraft.trim() !== staffNoteSent.trim();
  // A note belongs to the email it was written for. Selecting another email starts a clean note. A bridge gap (no
  // email reported) and a return to the same email keep it.
  const noteEmailRef = useRef(selectedIdentity);
  useEffect(() => {
    if (selectedIdentity === null || selectedIdentity === noteEmailRef.current) return;
    noteEmailRef.current = selectedIdentity;
    setStaffNoteDraft('');
    setStaffNoteSent('');
  }, [selectedIdentity]);

  // Unsent quote-session work that a reload would discard. Local field edits are not tracked one by one:
  // any input in the pane resets the idle clock, and writes are counted, so no per-field checks are needed.
  const quoteSessionDirty =
    combinedEdit !== null ||
    Object.keys(quoteSession.bookingDrafts).length > 0 ||
    unsentStaffNote ||
    hasStaffStayEdits(quoteSession);
  // One Excel export at a time. A second click while one is being made does nothing, and the button
  // stays disabled until the export settles. The server call is a tRPC mutation, so it also counts as in flight.
  const [workbookPending, setWorkbookPending] = useState(false);
  const workbookInFlight = useRef(false);
  const { pdfPending, preparePdfFor } = useQuotePdfJob({
    quoteSession,
    quoteSessionRef,
    documentContact,
    documentContactRef,
    dispatchQuote,
    activeEmail,
    activeTransportId: activeConnection?.id ?? null,
    staffSignerName,
    activePaneConfig,
    replyGreetingName,
    workItemId: paneWorkItemId,
    transportId: paneTransportId,
  });
  const downloadWorkbook = () => {
    if (workbookInFlight.current) return;
    workbookInFlight.current = true;
    setWorkbookPending(true);
    const owner = currentPaneOwner();
    void downloadStaffQuoteWorkbook({
      session: quoteSessionRef.current,
      contact: documentContactRef.current,
      mutate: staffQuoteFromTrpc(trpcClient).workstation.quoteWorkbook?.mutate,
      notify: (message) => toast.warning(message),
    }).then((saved) => {
      if (saved) trackPaneAction({ type: 'excel.downloaded' }, owner);
    }).finally(() => {
      workbookInFlight.current = false;
      setWorkbookPending(false);
    });
  };
  // The build this page was served, read from its index.html at page load (never from a fetch).
  const [loadedBuild] = useState<string | null>(() => loadedPaneBuild());
  // A newer build is live but not loaded. It loads at the next safe boundary: an email switch, or 15 idle minutes.
  const [pendingBuild, setPendingBuild] = useState<PaneVersion | null>(null);
  const pendingBuildRef = useRef(pendingBuild);
  pendingBuildRef.current = pendingBuild;
  const quoteSessionDirtyRef = useRef(quoteSessionDirty);
  quoteSessionDirtyRef.current = quoteSessionDirty;
  // Input inside the pane (keys, typing, pointer) resets the idle clock.
  const lastInputAtRef = useRef(Date.now());
  const markInput = () => {
    lastInputAtRef.current = Date.now();
  };
  useEffect(() => {
    // Dev and test servers serve no release file, so only released builds check.
    if (!import.meta.env.PROD || loadedBuild === null) return;
    const watch = createPaneVersionWatch({
      loadedBuild,
      fetchServed: () => fetchPaneVersion(),
      onPending: (served) => setPendingBuild(served),
    });
    const poll = () => void watch.check();
    poll();
    const timer = window.setInterval(poll, PANE_RELEASE_POLL_MS);
    window.addEventListener('focus', poll);
    const idleTimer = window.setInterval(() => {
      if (
        reloadAtIdle({
          pending: pendingBuildRef.current !== null,
          mutationsInFlight: mutationsInFlight(),
          quoteSessionDirty: quoteSessionDirtyRef.current,
          idleMs: Date.now() - lastInputAtRef.current,
        })
      ) {
        reloadPane();
      }
    }, PANE_IDLE_CHECK_MS);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(idleTimer);
      window.removeEventListener('focus', poll);
    };
  }, [loadedBuild]);

  // Email switch. A pending build loads before the new email renders, because panels reset on switch anyway. A
  // mutation in flight keeps the pane on this build. Only a new email counts: a bridge gap (null) is not a switch,
  // so going to no email and back to the same one neither reloads nor clears the note.
  const renderedIdentityRef = useRef(selectedIdentity); // the last email that was actually shown
  const emailSwitched = selectedIdentity !== null && selectedIdentity !== renderedIdentityRef.current;
  const reloadForSwitch =
    emailSwitched && reloadAtEmailSwitch({ pending: pendingBuild !== null, mutationsInFlight: mutationsInFlight() });
  const reloadForSwitchRef = useRef(false);
  reloadForSwitchRef.current = reloadForSwitch;
  // Sticky: once the switch reload is requested, the placeholder stays until the page is replaced.
  const [switchReloading, setSwitchReloading] = useState(false);
  useLayoutEffect(() => {
    if (selectedIdentity === null) return;
    const switched = selectedIdentity !== renderedIdentityRef.current;
    renderedIdentityRef.current = selectedIdentity;
    if (!switched || !reloadForSwitchRef.current) return;
    setSwitchReloading(true);
    reloadPane();
  }, [selectedIdentity]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[#f1f3f6] font-sans text-slate-700">
        <p className="text-xs text-slate-500">Loading session…</p>
      </div>
    );
  }
  if (reloadForSwitch || switchReloading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[#f1f3f6] font-sans text-slate-700">
        <p className="text-xs text-slate-500">Loading the latest Nava pane…</p>
      </div>
    );
  }

  if (!session?.user || requiresRelogin) {
    return <OutlookPaneSignIn />;
  }

  requoteSameStayRef.current = (row) => {
    const session = quoteSessionRef.current;
    // Same as Get rates: a party lookup that still decides the pick would reset this run.
    const lookupWait = partyLookupWaitReason(session);
    if (lookupWait) {
      toast.warning(lookupWait);
      return;
    }
    const luna = session.analysis?.luna;
    const source = session.staffSource;
    const binding = session.binding;
    if (luna?.workflow !== 'create_booking' || !source || !binding) {
      toast.warning('Stay details are not ready to re-quote. Check the dates and rooms first.');
      return;
    }
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = session.inputRevision;
    const stayRevision = session.stayRevision;
    const sourceIdentity = quoteSourceIdentity(session);
    const startedVersions = new Map(requestedQuoteKeys(session.groups).map((key) => [key,
      staffQuoteStepGenerations.current.get(`${sourceIdentity}:${key}`) ?? 0]));
    const sourceCurrent = () => quoteSourceIdentity(quoteSessionRef.current) === sourceIdentity &&
      quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision });
    const staff = staffQuoteFromTrpc(trpcClient);
    void bindGetPriorStaffQuoteRequote({
      query: staff.workstation.getPriorStaffQuoteRequote?.query,
      threadId: source.threadId,
      row,
    }).then((loaded) => {
      if (!sourceCurrent()) return;
      if (loaded.status !== 'ok') {
        toast.warning(loaded.reason);
        return;
      }
      const { groups, header } = buildExpiredPriorRequoteBindArgs({
        stored: loaded.payload,
        sessionGroups: session.groups,
        sessionHeader: session.staffHeader,
        staffEdited: hasStaffStayEdits(session),
      });
      if (!groups.length) {
        toast.warning('The stays changed since this quote. Run the search for that stay again.');
        return;
      }
      const keys = requestedQuoteKeys(groups);
      if (keys.some((key) => (staffQuoteStepGenerations.current.get(`${sourceIdentity}:${key}`) ?? 0) !==
          (startedVersions.get(key) ?? 0))) return;
      const versions = new Map(keys.map((key) => {
        const next = (staffQuoteStepGenerations.current.get(`${sourceIdentity}:${key}`) ?? 0) + 1;
        staffQuoteStepGenerations.current.set(`${sourceIdentity}:${key}`, next);
        return [key, next];
      }));
      const current = () => sourceCurrent() && [...versions].every(([key, version]) =>
        staffQuoteStepGenerations.current.get(`${sourceIdentity}:${key}`) === version);
      // The prior quote loaded after the click, so a lookup may have started since. The run must not start under it.
      const lookupWaitNow = partyLookupWaitReason(quoteSessionRef.current);
      if (lookupWaitNow) {
        toast.warning(lookupWaitNow);
        return;
      }
      const run = bindExecuteStaffQuote({
        mutate: staff.workstation.executeStaffQuote?.mutate,
        queue: staff.workstation.queueStaffQuote?.mutate,
        staffQuoteJob: trackRatesJob(staff.workstation.staffQuoteJob?.query, source),
        source,
        selectionEpoch,
        inputRevision,
        groups,
        header,
        propertyCode: activePaneConfig?.propertyCode,
        configuration: activePaneConfig,
      });
      return trackStaffQuoteRun(run).then((remote) => {
        // The reducer drops this result when the selection, inputs or stay rows moved on while HMS searched. Say so.
        if (!current()) {
          toast.warning('Details changed while HMS was searching — search availability again.');
          return;
        }
        if (remote.status !== 'ok') {
          toast.warning(remote.reason);
          return;
        }
        dispatchQuote({
          type: 'staff_quote_ready',
          offer: remote.offer,
          staffQuote: remote.staffQuote,
          selectionEpoch,
          inputRevision,
          extrasReviewItems: remote.extrasReviewItems,
          approvedHeader: header,
          groups,
          // The run replaces the rows with the ones it read. A stay edit since then must not be overwritten.
          stayRevision,
        });
        for (const item of remote.extrasReviewItems) toast.warning(item);
        return bindPrepareBookingDraft({
          mutate: staff.workstation.prepareBookingDraft?.mutate,
          source,
          workflowRunId: remote.staffQuote.workflowRunId,
          revisionRef: remote.staffQuote.revisionRef,
          messageId: source.messageId,
          selectionEpoch,
          inputRevision,
          analysis: {
            ...luna,
            groups: overlayLunaGroupsFromStaff(luna, session.groups),
          },
        }).then((draftRemote) => {
          const accepted = quoteSessionRef.current;
          // The quote result updates its own rows and revision. Its accepted revision remains
          // present only while those inputs still describe this result.
          if (!current() && !(quoteSourceIdentity(accepted) === sourceIdentity &&
              quoteRunIsCurrent(accepted, { selectionEpoch, inputRevision }) &&
              [...versions].every(([key, version]) => staffQuoteStepGenerations.current.get(`${sourceIdentity}:${key}`) === version) &&
              accepted.staffQuotes[remote.offer.quoteRequestKey]?.revisionRef === remote.staffQuote.revisionRef)) return;
          if (draftRemote.status !== 'ok') {
            toast.warning(draftRemote.reason);
            return;
          }
          dispatchQuote({
            type: 'booking_draft_ready',
            payload: draftRemote.payload,
            sourceHash: source.sourceHash,
          });
        });
      });
    });
  };

  /** Inserts the thread's saved reply as it is now. Webmail may have replaced it since the button appeared. */
  const insertSavedReply = () =>
    trackedInsertSaved(async () => {
      const threadId = savedReplyThreadId;
      let current: Awaited<ReturnType<typeof savedReply.readCurrent>>;
      try {
        current = await savedReply.readCurrent();
      } catch {
        toast.error('Could not read the saved reply. Try again.');
        return null;
      }
      // The reply belongs to the thread it was read for. Staff may have moved to another email meanwhile.
      if (quoteSessionRef.current.staffSource?.threadId !== threadId) return null;
      if (!current) {
        toast.warning('This thread has no saved reply any more. Save it again in webmail.');
        return null;
      }
      return current;
    });

  const runQuoteStep = (stepId: string, autoStart = false, readBack = false) => {
    if (isNonActionableMessage) return;
    if ((autoStart || readBack) && (staffQuoteQueueMode !== 'on' || isQuoteFixturePreview())) return;
    const step = quoteSession.steps.find((item) => item.id === stepId);
    const maySearchAgain = step?.kind === 'quote_stay' && step.status === 'succeeded' && !quoteSession.runningStepId;
    if (!step || (!maySearchAgain && !canRunQuoteStep(step, quoteSession.steps, quoteSession.runningStepId))) return;
    const waiting = quoteRunBlockReason(quoteSession, step);
    if (waiting) {
      toast.warning(waiting);
      return;
    }
    dispatchQuote({ type: 'step_running', stepId: step.id });
    const selectionEpoch = quoteSession.binding?.selectionEpoch ?? 0;
    const inputRevision = quoteSession.inputRevision;
    if (isQuoteFixturePreview()) {
      const fixture = loadQuoteFixture(pickFixtureForSession(quoteSession.groups));
      dispatchQuote({
        type: 'results_ready',
        offers: fixture.offers,
        selectionEpoch,
        inputRevision,
        provenance: { kind: 'fixture', selectionEpoch, inputRevision },
        reviewedReplyHtml: fixtureReplyHtml(
          fixture,
          (activeEmail?.senderName ?? 'Guest').split(' ')[0] || 'Guest',
        ),
      });
      toast.warning('This is sample data, not live HMS rooms, so no draft can be made.');
      return;
    }
    if (step.kind === 'party_lookup') {
      dispatchQuote({
        type: 'results_unavailable',
        stepId: step.id,
        reason: 'The company lookup runs automatically with the quote. No need to run it separately.',
        selectionEpoch,
        inputRevision,
      });
      toast.warning('The company lookup runs automatically with the quote. No need to run it separately.');
      return;
    }
    const source = quoteSession.staffSource;
    if (!source) {
      dispatchQuote({
        type: 'results_unavailable',
        stepId: step.id,
        reason: 'The selected email is not ready yet. Wait a moment, then select it again.',
        selectionEpoch,
        inputRevision,
      });
      toast.warning('The selected email is not ready yet. Wait a moment, then select it again.');
      return;
    }
    if (!autoStart && !readBack) {
      if (step.kind === 'quote_stay' && step.shareKey && quoteSession.binding) {
        staffQuoteAutoAttempted.current.add(
          staffQuoteAttemptKey(
            quoteSession.binding.transportId,
            source.messageId,
            source.sourceHash,
            step.shareKey,
          ),
        );
      }
      suppressAutoStaffQuoteForCurrentEmail();
    }
    const stayGroups = groupsForQuoteStep(quoteSession, step);
    const staff = staffQuoteFromTrpc(trpcClient);
    const originalStaffQuoteJob = staff.workstation.staffQuoteJob?.query;
    let lastStaffQuoteRunId: string | null = null;
    let pollLostRunId: string | null = null;
    const trackedStaffQuoteJob = trackRatesJob(originalStaffQuoteJob, source);
    const observedStaffQuoteJob: StaffQuoteJobQuery | undefined = trackedStaffQuoteJob
      ? async (input, options) => {
          if ('runId' in input) lastStaffQuoteRunId = input.runId;
          return trackedStaffQuoteJob(input, options);
        }
      : undefined;
    // Auto-start and read-back use the session strategy, as the background prepare does (Government only when every
    // row is Dinner B&B), so a prepared run's price shape matches.
    const runHeader = autoStart || readBack ? autoRunHeader(quoteSession) : quoteSession.staffHeader;
    // Get rates is where she proceeds with the read as shown, so unedited AI fields are accepted (v5 B2).
    if (!autoStart && !readBack && !storedOverridden) storedWork.acceptUnedited(quoteSession.groups);
    const run = readBack
      ? bindReadBackStaffQuote({
          query: observedStaffQuoteJob,
          source,
          selectionEpoch,
          inputRevision,
          groups: stayGroups,
          header: runHeader,
          propertyCode: activePaneConfig?.propertyCode,
          configuration: activePaneConfig,
          stayKey: step.shareKey,
        })
      : autoStart
        ? bindAutoStartStaffQuote({
          queue: staff.workstation.queueStaffQuote?.mutate,
          staffQuoteJob: observedStaffQuoteJob,
          source,
          selectionEpoch,
          inputRevision,
          groups: stayGroups,
          header: runHeader,
          propertyCode: activePaneConfig?.propertyCode,
          configuration: activePaneConfig,
          stayKey: step.shareKey,
        })
        : bindExecuteStaffQuote({
          mutate: staff.workstation.executeStaffQuote?.mutate,
          queue: staff.workstation.queueStaffQuote?.mutate,
          staffQuoteJob: observedStaffQuoteJob,
          source,
          selectionEpoch,
          inputRevision,
          groups: stayGroups,
          header: runHeader,
          propertyCode: activePaneConfig?.propertyCode,
          configuration: activePaneConfig,
          stayKey: step.shareKey,
        });
    const noticeEmail = {
      emailKey: selectedEmailKey,
      emailSubject: activeEmail?.subject?.trim() || null,
    };
    const staffQuoteStep = step;
    const staffQuoteSource = source;
    const sourceIdentity = quoteSourceIdentity(quoteSession);
    const stepGenerationKey = `${sourceIdentity}:${step.shareKey ?? step.id}`;
    const retry = () => {
      const lostRunId = pollLostRunId;
      const retryRun = lostRunId && originalStaffQuoteJob
        ? bindReadBackStaffQuote({
            query: (input, options) =>
              originalStaffQuoteJob('input' in input ? { runId: lostRunId } : input, options),
            source,
            selectionEpoch,
            inputRevision,
            groups: stayGroups,
            header: runHeader,
            propertyCode: activePaneConfig?.propertyCode,
            configuration: activePaneConfig,
            stayKey: step.shareKey,
          })
        : bindExecuteStaffQuote({
            mutate: staff.workstation.executeStaffQuote?.mutate,
            queue: staff.workstation.queueStaffQuote?.mutate,
            staffQuoteJob: observedStaffQuoteJob,
            source,
            selectionEpoch,
            inputRevision,
            groups: stayGroups,
            header: runHeader,
            propertyCode: activePaneConfig?.propertyCode,
            configuration: activePaneConfig,
            stayKey: step.shareKey,
          });
      runNoticed(retryRun);
    };
    const runNoticed = (pendingRun: Promise<BoundExecuteStaffQuote | null>) => {
      const generation = (staffQuoteStepGenerations.current.get(stepGenerationKey) ?? 0) + 1;
      staffQuoteStepGenerations.current.set(stepGenerationKey, generation);
      const current = () => staffQuoteStepGenerations.current.get(stepGenerationKey) === generation &&
        quoteSourceIdentity(quoteSessionRef.current) === sourceIdentity &&
        quoteStayRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision,
          stepId: staffQuoteStep.id, stayKey: staffQuoteStep.shareKey ?? '', groups: stayGroups });
      void trackMainStaffQuoteRun(pendingRun, retry, noticeEmail).then((remote) => {
        if (!current()) return;
        pollLostRunId =
          remote?.status === 'unavailable' && remote.reason === STAFF_QUOTE_POLL_LOST_REASON
            ? lastStaffQuoteRunId
            : null;
        applyStaffQuoteResult(remote, current, generation);
      });
    };
    function applyStaffQuoteResult(remote: BoundExecuteStaffQuote | null, current: () => boolean, generation: number) {
      if (
        !quoteStayRunIsCurrent(quoteSessionRef.current, {
          selectionEpoch,
          inputRevision,
          stepId: staffQuoteStep.id,
          stayKey: staffQuoteStep.shareKey ?? '',
          groups: stayGroups,
        })
      ) {
        dispatchQuote({ type: 'step_stale', stepId: staffQuoteStep.id, selectionEpoch, inputRevision });
        if (remote !== null) {
          toast.warning('Details changed while HMS was searching — search availability again.');
        }
        return;
      }
      if (remote === null) {
        dispatchQuote({
          type: 'results_unavailable',
          stepId: staffQuoteStep.id,
          reason: 'The background HMS quote did not start. Run Get rates to try again.',
          selectionEpoch,
          inputRevision,
        });
        return;
      }
      if (remote.status !== 'ok') {
        dispatchQuote({
          type: 'results_unavailable',
          stepId: staffQuoteStep.id,
          reason: remote.reason,
          detail: remote.detail,
          alternatives: remote.alternatives,
          ...(!isMultiStay(quoteSession) && isStaffQuoteRefusal(remote)
            ? { declineReplyHtml: quoteDeclineReplyHtml() }
            : {}),
          selectionEpoch,
          inputRevision,
        });
        toast.warning(remote.reason);
        return;
      }
      dispatchQuote({
        type: 'staff_quote_ready',
        offer: remote.offer,
        staffQuote: remote.staffQuote,
        selectionEpoch,
        inputRevision,
        extrasReviewItems: remote.extrasReviewItems,
        approvedHeader: runHeader,
      });
      for (const item of remote.extrasReviewItems) toast.warning(item);
      const luna = quoteSession.analysis?.luna;
      if (luna?.workflow === 'create_booking') {
        void bindPrepareBookingDraft({
          mutate: staff.workstation.prepareBookingDraft?.mutate,
          source: staffQuoteSource,
          workflowRunId: remote.staffQuote.workflowRunId,
          revisionRef: remote.staffQuote.revisionRef,
          messageId: staffQuoteSource.messageId,
          selectionEpoch,
          inputRevision,
          analysis: { ...luna, groups: overlayLunaGroupsFromStaff(luna, quoteSession.groups) },
        }).then((draftRemote) => {
          const accepted = quoteSessionRef.current;
          // Applying the quote adds its prices to the groups, so the pre-search group
          // comparison no longer matches. A later edit to this stay removes its quote.
          if (!current() && !(staffQuoteStepGenerations.current.get(stepGenerationKey) === generation &&
              quoteSourceIdentity(accepted) === sourceIdentity &&
              quoteRunIsCurrent(accepted, { selectionEpoch, inputRevision }) &&
              accepted.staffQuotes[remote.offer.quoteRequestKey]?.revisionRef === remote.staffQuote.revisionRef)) return;
          if (draftRemote.status !== 'ok') {
            toast.warning(draftRemote.reason);
            return;
          }
          dispatchQuote({
            type: 'booking_draft_ready',
            payload: draftRemote.payload,
            sourceHash: staffQuoteSource.sourceHash,
          });
        });
      }
    }
    runNoticed(run);
  };
  runQuoteStepRef.current = runQuoteStep;

  // Only quote and booking mail gets Nava's suggestions and the numbered reply step. Other mail gets neither.
  const quoteOrBookingEmail =
    !isExistingStayInformation && quoteSession.analysis?.intent === 'quote';
  const draftStatusMessage = draftStatus && draftStatus.key === selectedKey ? draftStatus.message : null;
  const replyBody = (
    <ReplyBody
      activeEmail={activeEmail}
      supportsAction={supportsAction}
      quoteSession={quoteSession}
      combinedEdit={combinedEdit}
      onCombinedEditChange={setCombinedEdit}
      quoteOrBookingEmail={quoteOrBookingEmail}
      isDraftPending={isDraftPending}
      statusMessage={draftStatusMessage}
      onDraft={trackedDraft}
      onSaveReply={preview ? trackedSave : undefined}
      onInsertSaved={savedReply.available ? insertSavedReply : null}
      preview={preview}
      primaryAction={false}
    />
  );
  const mailboxWarnings = (
    <>
      {isConnected && capabilities && capabilities.mailboxSync !== 1 ? (
        <p className="text-[11px] text-slate-600">Update the Outlook add-in to enable automatic email copying.</p>
      ) : null}
      {isConnected && (updateRequired || workstationInfo?.bridgeProtocolVersion !== 4) ? (
        <div role="alert" className="rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
          Update the Outlook add-in to protocol v4. This installer cannot access mail.
        </div>
      ) : null}
      {isConnected && !updateRequired && workstationInfo?.paired === false ? (
        <div className="rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
          <p>Outlook device pairing requires a supervised operator code entered in a Windows-only dialog.</p>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void pairDevice?.().catch((error: unknown) => {
                toast.error(error instanceof Error ? error.message : 'Could not pair Outlook device');
              });
            }}
          >
            Pair Outlook Device
          </Button>
        </div>
      ) : null}
      {isConnected && workstationInfo?.paired && authorizationUnavailable && !requiresRelogin ? (
        <div role="status" className="rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
          <p>Nava is connecting to this mailbox. If this stays, open an email in your Inbox.</p>
          <Button type="button" size="sm" onClick={refreshAuthorization}>Try again</Button>
        </div>
      ) : null}
      {pendingBuild !== null ? (
        <div role="status" className="rounded-sm border border-sky-300 bg-sky-50 p-2.5 text-xs text-sky-800">
          <p>New version available — it will load when you open the next email.</p>
        </div>
      ) : null}
      {selectionOutsideMailbox ? (
        <div role="status" className="rounded-sm border border-slate-300 bg-slate-50 p-2.5 text-xs text-slate-700">
          <p>
            {activeConnection?.email
              ? `This email isn't in ${activeConnection.email}. Pick an email from the ${activeConnection.email} inbox.`
              : "This email isn't in the connected mailbox. Pick an email from its inbox."}
          </p>
        </div>
      ) : null}
    </>
  );

  const setReviewItemHandled = async (itemId: string, handled: boolean) => {
    const item = quoteSession.reviewItems.find((row) => row.id === itemId);
    if (item?.kind === 'staff_review') {
      const mutate = staffQuoteFromTrpc(trpcClient).drafts.setVoucherReviewHandled?.mutate;
      if (!mutate || !item.workItemId || !item.runId) {
        toast.warning('Voucher review acknowledgement unavailable. Refresh the selected email.');
        return;
      }
      preparedTaskGeneration.current++;
      try {
        await mutate({ workItemId: item.workItemId, runId: item.runId, reviewItemId: item.id, handled });
        if (quoteSessionRef.current.reviewItems.some((row) => row.id === item.id && row.runId === item.runId)) {
          dispatchQuote({ type: handled ? 'handle_review_item' : 'unhandle_review_item', itemId });
        }
      } catch {
        toast.warning(`Could not ${handled ? 'save' : 'undo'} the voucher review acknowledgement. Refresh and try again.`);
      } finally {
        preparedTaskGeneration.current++;
      }
      return;
    }
    dispatchQuote({ type: handled ? 'handle_review_item' : 'unhandle_review_item', itemId });
  };

  // Selection effects update the reducer after the bridge changes. Hide its previous
  // email's actions for that render instead of showing them under the new email.
  const pendingWebSelection = Boolean(
    preview && onOpenThread && currentScope && activeEmail && (
      quoteSession.binding?.transportId !== activeConnection?.id ||
      quoteSession.binding?.entryId !== activeEmail.entryId ||
      quoteSession.binding?.storeId !== (activeEmail.storeId ?? '') ||
      quoteSession.binding?.folderEntryId !== (activeEmail.folderEntryId ?? '') ||
      quoteSession.binding?.internetMessageId !== activeEmail.internetMessageId ||
      quoteSession.binding?.selectionEpoch !== contextRevision.current.selectionEpoch ||
      quoteSession.binding?.scopeEpoch !== contextRevision.current.scopeEpoch
    ),
  );
  if (pendingWebSelection) return <p role="status" className="p-4">Loading selected email…</p>;

  return (
    <HmsJobNoticeProvider
      emailKey={selectedEmailKey}
      emailSubject={activeEmail?.subject?.trim() || null}
      passthrough={hmsNoticesManagedByParent}
      onReporterReady={setNoticeReporter}
    >
      <div
        onKeyDownCapture={markInput}
        onInputCapture={markInput}
        onPointerDownCapture={markInput}
        className="flex h-screen w-full justify-center overflow-hidden bg-[#f1f3f6] font-['Segoe_UI',system-ui,sans-serif] text-sm"
      >
      {/* Fills the Outlook pane height, so the body below scrolls with a visible bar; never narrower than 320px. */}
      <div className="shadow-xs relative flex h-full w-full min-w-[320px] flex-col border-x border-[#cbd5e1] bg-white text-[#1e293b]">
        {/* Mailbox identity and copy progress are visible above the selected email, without a property-name fallback. */}
        <header aria-label="Nava mailbox" className="shrink-0 border-b border-[#e2e8f0] bg-white">
          <div className="flex h-10 min-w-0 items-center justify-between gap-2 px-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] bg-[#1a4332] text-[11px] font-extrabold text-white">
                N
              </span>
              <h1 className="truncate whitespace-nowrap text-[13px] font-bold text-[#1e293b]">Nava Reservationist</h1>
            </div>
            <NeedsYouEntry
              list={needsYou}
              compact
              onOpen={() => {
                needsYou.reload();
                setCurrentScreen('needs-you');
              }}
            />
          </div>
          <div className="flex h-8 min-w-0 items-center gap-1.5 border-t border-[#f1f5f9] bg-[#f8fafc] px-3.5 text-[11px] font-medium text-[#475569]">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${isConnected ? 'animate-pulse bg-emerald-600' : 'bg-rose-500'}`}
            />
            <span
              aria-label={`Connected mailbox: ${mailboxDescription}`}
              title={mailboxDescription}
              className="min-w-0 flex-1 truncate font-semibold"
            >
              {mailboxLabel}
            </span>
            {(activePaneConfig?.propertyCode === 'HRDAV' || activePaneConfig?.propertyCode === 'HRDAVS' || propertySwitch) && activeConnection?.id &&
              <label className="inline-flex items-center gap-1">Hotel<select value={propertySwitch ?? 'HRDAV'} onChange={event => setPropertySelection({
                transportId: activeConnection.id, propertySwitch: event.target.value === 'HRDAVS' ? 'HRDAVS' : 'HRDAV',
              })}><option value="HRDAV">Da Vinci</option><option value="HRDAVS">Da Vinci HRDAVS</option></select></label>}
            <span className="flex shrink-0 items-center gap-1.5 [&_button]:whitespace-nowrap">
              <HmsJobRunningChip />
              {activeConnection?.email && (sync.eligible || readOnlySyncStatus) ? (
                <OutlookSyncProgress
                  status={sync.status}
                  notApplicable={sync.notApplicable}
                  mailbox={activeConnection.email}
                  error={sync.error}
                  busy={sync.busy}
                  controlsEnabled={sync.eligible}
                  emptyLabel={readOnlySyncStatus && sync.statusLoaded ? 'No Outlook sync found' : undefined}
                  onControl={(operation) => { void sync.control(operation).catch(() => undefined); }}
                />
              ) : (
                <span className="max-w-[130px] truncate" title={activeConnection?.email ? undefined : 'Sync unavailable'}>
                  {activeConnection?.email ? outlookSyncLabel(sync.status, sync.error) : 'Sync unavailable'}
                </span>
              )}
            </span>
            <span className="sr-only">
              {isConnected
                ? `Connected to Classic Outlook (${capabilities?.outlookVersion ?? 'version unavailable'}; product/build unknown)`
                : 'Disconnected'}
            </span>
          </div>
        </header>

        <HmsJobNoticeBanner onReveal={() => setCurrentScreen('tool')} />
        <SelectedEmailBlock activeEmail={activeEmail} />
        {readAs ? (
          <div className="mx-3 mt-2 flex shrink-0 flex-col gap-1.5">
            <WorkflowBadge
              analysis={quoteSession.analysis}
              kind={selectedReadKind}
              readAs={readAs}
              treatAs={quoteSession.treatAs}
              workState={workState}
              goldLabel={goldLabelEnabled && activeEmail && !(storedWork.pane.state === 'ready' && storedWork.pane.staffManual) ? {
                messageKey: activeEmail.internetMessageId ?? activeEmail.entryId ?? 'selected',
                messageId:
                  activeEmail.internetMessageId &&
                  quoteSession.binding?.internetMessageId === activeEmail.internetMessageId
                    ? quoteSession.staffSource?.messageId ?? null
                    : null,
                internetMessageId: activeEmail.internetMessageId ?? null,
                initialAction: GOLD_ACTION_FOR_READ_AS[readAs],
              } : undefined}
              onIntentChange={isNonActionableMessage || (storedWork.pane.state === 'ready' && storedWork.pane.staffManual) ? undefined : (treatAs) => {
                suppressAutoStaffQuoteForCurrentEmail();
                if (contactMessageKey) rememberTreatAs(treatAsMailKey, treatAs);
                dispatchQuote({ type: 'treat_as', treatAs });
              }}
            />
            {storedWork.historyAvailable && paneWorkItemId ? (
              <WorkItemHistoryControls
                workItemId={paneWorkItemId}
                serverCursor={storedWork.historyCursor}
                onUndo={storedWork.undo}
                onRedo={storedWork.redo}
                pending={storedWork.historyPending || storedWork.historyNeedsReload || storedWork.saveFailed || amendWorkItem.pending || amendRefresh.pending || requestWorkItem.pending}
              />
            ) : null}
            {storedWork.historyError ? (
              <p role="status" className="flex flex-wrap items-center gap-1 px-1 text-[11px] text-[#64748b]">
                <span>{storedWork.historyError}</span>
                {storedWork.historyNeedsReload ? (
                  <button
                    type="button"
                    disabled={storedWork.historyPending || requestWorkItem.saving || amendWorkItem.saving || amendRefresh.pending}
                    onClick={() => { requestWorkItem.discard(); amendWorkItem.discard(); storedWork.reloadHistory(); }}
                    className="rounded-[3px] text-[11px] font-semibold text-[#64748b] hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:text-[#94a3b8]"
                  >
                    {hasCachedEdits || storedWork.saveFailed || requestWorkItem.pending || amendWorkItem.pending
                      ? 'Reload and discard unsaved changes' : 'Reload'}
                  </button>
                ) : null}
              </p>
            ) : null}
            {requestWorkItem.error ? <p role="status" className="px-1 text-[11px] text-amber-900">
              {requestWorkItem.error}{' '}{requestWorkItem.retryable && !storedWork.historyNeedsReload ? <button type="button" className="font-semibold underline"
                onClick={requestWorkItem.retry}>Retry save</button> : null}
            </p> : null}
          </div>
        ) : null}

        {shownScreen !== 'tool' && mailSourceNoActionNotice ? (
          <div className="mx-3 mt-2">{mailSourceNoActionNotice}</div>
        ) : null}
        {shownScreen !== 'tool' ? <div className="mx-3 mt-2 flex flex-col gap-2">{mailboxWarnings}</div> : null}

        {/* First-run steps only: the bar is gone once onboarding is done (replay from the ⋯ menu). Preview never shows it. */}
        {shownScreen !== 'tool' && shownScreen !== 'needs-you' && (
        <div className="flex w-full items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-3 py-1.5 text-xs">
          <div className="flex items-center gap-1 font-semibold text-[#1e293b]">
            <span className="text-[11px] text-[#64748b]">Step</span>
          </div>
          <div className="flex items-center gap-1">
            {(
              [
                { id: 'welcome', label: '1. Welcome' },
                { id: 'diagnostics', label: '2. Connection' },
                { id: 'tour', label: '3. Tour' },
                { id: 'tool', label: '4. Quote Tool' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setCurrentScreen(item.id);
                  if (item.id === 'diagnostics' && pingState === 'idle') {
                    void executeServerPing();
                  }
                }}
                className={`rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  currentScreen === item.id
                    ? 'bg-[#1a4332] font-semibold text-white'
                    : 'text-[#64748b] hover:bg-[#e2e8f0]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* SCREEN 1: WELCOME & MAILBOX DETECTION */}
        {shownScreen === 'welcome' && (
          <WelcomeScreen
            detectedEmail={detectedEmail}
            onConfirm={() => {
              setCurrentScreen('diagnostics');
              void executeServerPing();
            }}
          />
        )}

        {/* SCREEN 2: SYSTEM & NAVA AI SERVICES CHECK */}
        {shownScreen === 'diagnostics' && (
          <DiagnosticsScreen
            pingState={pingState}
            serverPingTimeStr={serverPingTimeStr}
            pingErrorMessage={pingErrorMessage}
            detectedEmail={detectedEmail}
            onRetry={() => void executeServerPing()}
            onNext={() => {
              setTourSlideIndex(0);
              setCurrentScreen('tour');
            }}
          />
        )}

        {/* SCREEN 3: 3-SLIDE QUICK TOUR PRIMER */}
        {shownScreen === 'tour' && (
          <TourScreen
            slideIndex={tourSlideIndex}
            setSlideIndex={setTourSlideIndex}
            onOpenTool={() => setCurrentScreen('tool')}
          />
        )}
        {/* SCREEN 5: NEEDS YOU (U24). Reached from the entry on the quoting tool, on both surfaces. */}
        {shownScreen === 'needs-you' && (
          <NeedsYouScreen
            list={needsYou}
            host={preview ? 'web' : 'outlook'}
            onBack={() => {
              needsYou.reload();
              setCurrentScreen('tool');
            }}
            onOpenThread={onOpenThread}
          />
        )}

        {/* Scrollable Body: SCREEN 4 QUOTING TOOL. Stays mounted, hidden, while the list is open, so its state survives. */}
        {(shownScreen === 'tool' || shownScreen === 'needs-you') && (
          <main
            style={shownScreen === 'tool' ? undefined : { display: 'none' }}
            className="nava-pane-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5"
          >
            {isExistingStayInformation ? (
              <div className="flex flex-col gap-3.5">
                {shownScreen === 'tool' ? (
                  <ExistingStayInformationCard confirmationNumbers={existingStayConfirmationNumbers} separateAsk={separateAsk} needsReview={separateAskReview} />
                ) : null}
              </div>
            ) : nonActionableMailSource ? (
              <div className="flex flex-col gap-3.5">
                {shownScreen === 'tool' ? mailSourceNoActionNotice : null}
                {readAs === 'payment' && activeEmail?.internetMessageId ? (
                  <VoucherFindCard
                    key={JSON.stringify([voucherMailboxScope, activeConnection?.id ?? null, activeEmail.internetMessageId, sourceSelection])}
                    internetMessageId={activeEmail.internetMessageId}
                    lookupSelection={sourceSelection}
                    transportId={voucherMailboxScope ? activeConnection?.id ?? null : null}
                    mailboxScope={voucherMailboxScope}
                    propertyCode={activePaneConfig?.propertyCode ?? null}
                    selectionEpoch={contextRevision.current.selectionEpoch}
                    filingCapability={activePaneConfig?.capabilities?.attach ?? null}
                    workItemId={storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : null}
                    trpc={trpcClient}
                    syncCommitted={sync.status?.committed ?? null}
                    syncPending={
                      sync.status
                        ? sync.status.discovered > sync.status.committed && !sync.status.userPaused
                        : false
                    }
                  />
                ) : null}
              </div>
            ) : (
              <>
            {/* Quote contact lives in People when that step is visible; other mail and hidden workspaces keep this pane fallback. */}
            {activeEmail && !contactInPeople ? (
              <ContactBlock
                // ContactBlock takes `contact` once, at mount. The key moves when the read or mailbox changes, so the
                // current request's contact fills the fields without carrying a correction across mailboxes.
                key={contactEditorKey}
                contact={documentContact}
                quote={readAs === 'quote' || readAs === 'group'}
                onEdit={recordContact}
                fieldProvenance={workItemPane?.fieldProvenance ?? null}
                onResetToAi={
                  workItemPane?.onResetContact &&
                  sectionHasStaffEdit(workItemPane.fieldProvenance, { type: 'contact' })
                    ? workItemPane.onResetContact
                    : undefined
                }
                resetPending={workItemPane?.resetPending}
              />
            ) : null}
            <div className="flex flex-col gap-2">{mailboxWarnings}</div>

            {storedWork.saveFailed ? (
              <p role="status" className="flex items-center gap-2 px-1 text-[11px] text-[#b45309]">
                Couldn&apos;t save change.
                <button type="button" disabled={storedWork.historyNeedsReload} className="font-semibold underline" onClick={storedWork.retrySave}>
                  Retry
                </button>
              </p>
            ) : null}

            {storedWork.pane.state === 'ready' && storedWork.pane.staffManual ? (
              <p className="px-1 text-[13px] text-[#92400e]">
                Nava could not read this email. Enter and check all booking details yourself. After reviewing all requests,
                dismiss it from Needs you.
              </p>
            ) : activeEmail && !quoteSession.staffQuote && quoteOrBookingEmail ? (
              <p className="px-1 text-[13px] text-[#64748b]">
                Nava filled these in from the email. Check them before getting rates.
              </p>
            ) : null}

            {/* HOOK(#79, #84; not on main): their picker props are added in StaffHeaderFields, quote-workflow-panel.tsx. */}
            <ConfirmationSourcesBridge
              userId={session?.user?.id ?? ''}
              userEmail={session?.user?.email ?? ''}
              mailbox={activeConnection?.email ?? ''}
            >
            {storedWork.retrySlow ? <p role="status">Nava is still reading this email. This is taking longer than usual.</p> : null}
            <QuoteWorkflowPanel
              session={quoteSession}
              bridge={bridge}
              workItemId={paneWorkItemId ?? undefined}
              savedStays={savedStays}
              screenshot={PANE_STAY_CLIENT.screenshot}
              quoteStrategyRows={quoteSession.quoteStrategyRows}
              onSelectQuoteStrategy={(stayKey, strategyCode) =>
                dispatchQuote({ type: 'quote_strategy_selected', stayKey, strategyCode })
              }
              rateCatalogue={activePaneConfig?.ratePlans ?? []}
              paneConfig={activePaneConfig}
              availabilityReader={PANE_STAY_CLIENT.readAvailability}
              paneSave={paneSaveOn ? PANE_STAY_CLIENT : null}
              contact={documentContact}
              contactEditorKey={contactEditorKey}
              onContactEdit={contactInPeople ? recordContact : undefined}
              workItemPane={workItemPane}
              findParty={PANE_PARTY_FINDER}
              partySuggestions={partySuggestions}
              onPartyLookupPending={(kind, pending) => dispatchQuote({ type: 'party_lookup_pending', kind, pending })}
              partyIndex={PANE_PARTY_INDEX}
              partyJobTransport={partyJobTransport}
              rates={PANE_SAVED_RATES}
              onPatchGroup={(groupId, patch) => editStayRows({ type: 'patch_group', groupId, patch })}
              // Shown only on a failed-read item, which stays listed after she starts typing in the form.
              onRetryRead={storedWork.retry}
              onStartManualCreate={storedWork.pane.state === 'failed' && storedWork.pane.canStartManualCreate
                ? storedWork.startManualCreate : undefined}
              onStayAction={(action) => {
                if (action.type !== 'remove_stay') {
                  editStayRows(action);
                  return;
                }
                // Undo restores this snapshot: the stay's rows, where they sat, and the rates still current for them.
                const removal = removedStayFor(quoteSessionRef.current, action.stayId);
                editStayRows(action);
                if (!removal) return;
                toast('Stay removed', {
                  action: { label: 'Undo', onClick: () => editStayRows({ type: 'restore_stay', removal }) },
                });
              }}
              onRunNext={() => {
                const nextStep = pickNextRunnableStep(quoteSession.steps, quoteSession.runningStepId);
                if (nextStep) runQuoteStep(nextStep.id);
              }}
              onRunStep={runQuoteStep}
              onSelectOffer={(offerId) =>
                dispatchQuote({ type: 'select_offers', offerIds: nextSelectedOfferIds(quoteSession, offerId) })
              }
              onReplyChange={(html) => dispatchQuote({ type: 'set_reviewed_reply', html, staffEdited: true })}
              onHandleReviewItem={(itemId) => setReviewItemHandled(itemId, true)}
              onUndoReviewItem={(itemId) => setReviewItemHandled(itemId, false)}
              onSetPreparedTaskHandled={async (task, handled) => {
                const mutate = staffQuoteFromTrpc(trpcClient).drafts.setRequestHandled?.mutate;
                if (!mutate || !task.workItemId || !task.runId) throw new Error('Request review unavailable');
                preparedTaskGeneration.current++;
                try {
                  await mutate({ workItemId: task.workItemId, runId: task.runId, taskId: task.id, handled });
                } finally {
                  preparedTaskGeneration.current++;
                }
                dispatchQuote({ type: 'prepared_task_handled', taskId: task.id, runId: task.runId, handled });
              }}
              onPatchStaffHeader={(header, options) => {
                if (options?.staffEdit) suppressAutoStaffQuoteForCurrentEmail();
                dispatchQuote({ type: 'patch_staff_header', header });
              }}
              onPatchStayExtras={(stayKey, extras) => {
                suppressAutoStaffQuoteForCurrentEmail();
                dispatchQuote({ type: 'patch_staff_stay_extras', stayKey, extras });
              }}
              onSelectStayKey={(stayKey) => dispatchQuote({ type: 'select_stay_key', stayKey })}
              onStaffNote={(staffNote) => {
                suppressAutoStaffQuoteForCurrentEmail();
                setStaffNoteSent(staffNote);
                dispatchQuote({ type: 'staff_note', staffNote });
              }}
              staffNoteDraft={staffNoteDraft}
              onStaffNoteDraftChange={setStaffNoteDraft}
              hmsQueue={{ pending: quoteRunPending, status: hmsQueue }}
              onLoadRunScreenshot={(input) =>
                bindQuoteRunScreenshot({
                  query: staffQuoteFromTrpc(trpcClient).workstation.quoteRunScreenshot?.query,
                  ...input,
                })
              }
              onEditReply={() => document.getElementById('quote-reviewed-reply')?.focus()}
              onViewSource={(item) => {
                document.getElementById('quote-selected-message')?.scrollIntoView({ block: 'nearest' });
                toast.message(
                  item.filename
                    ? `Nava found this in the selected email. It lists the file ${item.filename}. A file name does not show what is inside, so open the attachment in Outlook to read it.`
                    : 'The selected email is shown at the top of this pane. Open it in Outlook for the full text.',
                );
              }}
              onPreparePdf={() => preparePdfFor(null)}
              onDownloadWorkbook={downloadWorkbook}
              workbookPending={workbookPending}
              pdfPending={pdfPending}
              replyContent={quoteOrBookingEmail ? replyBody : undefined}
            />
            {/* Supporting tools follow the four-step quote flow and stay available without competing with its actions. */}
            {storedWork.pane.state === 'ready' ? (
              <TranslationBox
                key={`translation:${storedWork.pane.workItemId ?? activeEmail?.internetMessageId ?? ''}`}
                language={storedWork.pane.language}
                translation={storedWork.pane.translation}
                busy={storedWork.translationBusy}
                onRetry={storedWork.retryTranslation}
              />
            ) : null}
            <FollowUpCard
              key={`follow-up:${activeEmail?.internetMessageId ?? 'no-email'}`}
              bridge={bridge}
              preview={preview}
              trpc={trpcClient}
            />
            <BookingVoucherCard
              session={quoteSession}
              propertyCode={activePaneConfig?.propertyCode ?? null}
              filingCapability={activePaneConfig?.capabilities?.attach ?? null}
              transportId={voucherMailboxScope ? activeConnection?.id ?? null : null}
              mailboxScope={voucherMailboxScope}
              readAs={readAs}
              internetMessageId={activeEmail?.internetMessageId ?? null}
              lookupSelection={sourceSelection}
              senderEmail={activeEmail?.senderEmail ?? null}
              subject={activeEmail?.subject ?? null}
              bodyText={activeEmail?.bodyText ?? null}
              syncCommitted={sync.status?.committed ?? null}
              syncPending={
                sync.status
                  ? sync.status.discovered > sync.status.committed && !sync.status.userPaused
                  : false
              }
              workItemId={storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : null}
              writesEnabled={attachWritesEnabled}
              amendPropertyResolved={activePaneConfig !== null}
              readOnlyAmend={activePaneConfig?.propertyCode === 'HRCEN' ? {
                propertyCode: 'HRCEN',
                ratePlans: activePaneConfig.ratePlans,
                draft: amendWorkItem,
                requestDraft: requestWorkItem,
                historyEpoch: storedWork.historyEpoch,
                historyBusy: storedWork.historyPending || storedWork.historyNeedsReload || amendRefresh.pending,
                refreshPending: amendRefresh.pending,
                refreshMessage: amendRefresh.message,
                retryRefresh: amendRefresh.retry,
                requireDurableDraft: true,
                retryDraft: storedWork.rebindAmendDraft,
                draftLoading: storedWork.amendRebinding,
                sourceContentChanged: amendSourceChanged,
                sourceSelectionUnavailable: preview && (!webSelectedMessageId ||
                  webSelectedMessageId !== activeEmail?.entryId ||
                  Boolean(quoteSession.staffSource && webSelectedMessageId !== quoteSession.staffSource.messageId)),
                selectionCurrent: Boolean(!amendSourceChanged && activeEmail?.entryId && activeEmail.internetMessageId &&
                  (!preview || (webSelectedMessageId === activeEmail.entryId &&
                    (!quoteSession.staffSource || webSelectedMessageId === quoteSession.staffSource.messageId))) &&
                  quoteSession.binding?.transportId === activeConnection?.id &&
                  quoteSession.binding?.entryId === activeEmail.entryId &&
                  quoteSession.binding?.storeId === (activeEmail.storeId ?? '') &&
                  quoteSession.binding?.folderEntryId === (activeEmail.folderEntryId ?? '') &&
                  quoteSession.binding?.internetMessageId === activeEmail.internetMessageId &&
                  quoteSession.binding?.scopeEpoch === contextRevision.current.scopeEpoch &&
                  quoteSession.binding?.selectionEpoch === contextRevision.current.selectionEpoch),
              } : null}
            />
            </ConfirmationSourcesBridge>

            {/* Non-quote mail keeps its plain reply actions; quote mail's action is inside Step 5. */}
            {!quoteOrBookingEmail && !preview ? <div className="flex flex-col gap-2.5">{replyBody}</div> : null}

            {/* Outlook Email Draft Preview Box */}
            {showDraftPreview && draftedDetails && (
              <DraftPreviewBlock
                details={draftedDetails}
                reviewedReplyHtml={quoteSession.reviewedReplyHtml}
                onDismiss={dismissDraftedDetails}
              />
            )}
            {(testResults.bridge !== null || testResults.serverPing !== null) && (
              <SystemCheckResultsBlock results={testResults} />
            )}
              </>
            )}
          </main>
        )}

        {/* ⋯ menu: connection check, tour, feedback and build id. */}
        <footer className="mt-auto flex shrink-0 items-center justify-end border-t border-[#f1f5f9] px-3 py-1.5">
          <PaneMenu
            buildRelease={loadedBuild}
            onCheckConnection={() => {
              setCurrentScreen('diagnostics');
              if (pingState !== 'loading') void executeServerPing();
            }}
            systemCheckRunning={testing}
            onRunSystemCheck={() => void runComprehensiveTest()}
            onReplayTour={() => {
              setTourSlideIndex(0);
              setCurrentScreen('tour');
            }}
            preview={preview}
          />
        </footer>
      </div>
      </div>
    </HmsJobNoticeProvider>
  );
}

/** The reply greets the quote contact (a forwarded mail's sender is often our own staff), else a named sender. */
function replyGreetingName(
  contactName: string | null | undefined,
  email: { senderName: string; senderEmail: string } | null | undefined,
): string {
  const contact = contactName?.trim() ?? '';
  if (contact) return contact;
  const senderName = email?.senderName.trim() ?? '';
  return senderName.toLowerCase() === (email?.senderEmail.trim().toLowerCase() ?? '') ? '' : senderName;
}
