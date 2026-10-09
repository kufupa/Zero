import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Send,
  Mail,
  Check,
  Building2,
  ChevronLeft,
  ChevronRight,
  Network,
  Sparkles,
  ArrowRight,
  Clock,
} from 'lucide-react';
import { createOperationId, type MailLocation, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { reportBridgeFailure } from '@/lib/workstation/use-outlook-bridge';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { QuoteWorkflowPanel } from '@/components/quote-workflow/quote-workflow-panel';
import { AmendLookupPanel } from '@/components/quote-workflow/amend-lookup-panel';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import {
  fixtureReplyHtml,
  loadQuoteFixture,
  pickFixtureForSession,
} from '@/lib/quote-workflow/fixtures';
import { isQuoteFixturePreview } from '@/lib/quote-workflow/preview';
import { requireReviewedNativeDraft } from '@/lib/quote-workflow/native-draft';
import {
  completedDateOptions,
  requireMultiOptionDraft,
  multiOptionSignature,
  type CombinedReplyEdit,
} from '@/lib/quote-workflow/multi-option-draft';
import {
  bindAnalyseSelection,
  quoteWorkflowFromTrpc,
} from '@/lib/quote-workflow/backend-bind';
import {
  bindGetPriorStaffQuoteRequote,
  bindListThreadQuoteRevisions,
  bindPrepareBookingDraft,
  bindUsePriorQuoteForBooking,
  buildExpiredPriorRequoteBindArgs,
  EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL,
  expiredPriorQuoteNotice,
  expiredPriorQuoteToastMessage,
  offerBoardFromRevision,
  overlayLunaGroupsFromStaff,
  type PriorStaffQuoteRequoteRow,
} from '@/lib/quote-workflow/booking-draft-bind';
import { paneStayFromTrpc, readPaneSaveFlag } from '@/lib/quote-workflow/pane-stay-bind';
import {
  bindExecuteStaffQuote,
  bindHmsQueueStatus,
  bindQuoteRunScreenshot,
  bindQualifiedStaffProposalPdf,
  bindStaffActions,
  bindStaffQuoteSource,
  staffQuoteFromTrpc,
} from '@/lib/quote-workflow/staff-quote-bind';
import { useHmsQueueStatus } from '@/lib/quote-workflow/use-hms-queue-status';
import {
  admissionKey,
  analysisRetryKey,
  canCreateNativeDraft,
  canCreatePdf,
  canRunQuoteStep,
  dinnerAllowanceStillRequired,
  evidenceMatchesSession,
  groupsForQuoteStep,
  quoteRunIsCurrent,
  hasStaffStayEdits,
  initialQuoteSession,
  nextSelectedOfferIds,
  optionLetter,
  pickNextRunnableStep,
  quoteRunBlockReason,
  reduceQuoteSession,
  requestedQuoteKeys,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import { useActiveConnection } from '@/hooks/use-connections';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { toast } from 'sonner';

type PaneScreen = 'welcome' | 'diagnostics' | 'tour' | 'tool';

type TourSlide = {
  title: string;
  subtitle: string;
  bullets: Array<{ title: string; desc: string }>;
};

const TOUR_SLIDES: TourSlide[] = [
  {
    title: '1. Automatic Email Sync',
    subtitle:
      'When an inquiry arrives, key parameters are detected directly from the email thread.',
    bullets: [
      {
        title: 'Direct HMS pre-fill:',
        desc: 'Extracted details automatically populate your fields with zero manual re-typing.',
      },
      {
        title: 'Verify auto-filled details:',
        desc: 'During the pilot, please check the email vs the AI auto-filled details to make sure everything is correct.',
      },
    ],
  },
  {
    title: '2. Live Infor HMS Actions & Proof',
    subtitle:
      'Execute live PMS tasks directly without switching windows or navigating Infor HMS manually.',
    bullets: [
      {
        title: 'Automated execution:',
        desc: 'Simply hit run and Nava AI performs the task directly inside Infor HMS for you.',
      },
      {
        title: 'Inspect screenshot proof:',
        desc: 'Please inspect the live Infor HMS audit capture (full-screen 1000×800) to verify live PMS details.',
      },
    ],
  },
  {
    title: '3. Assisted Responses & Actions',
    subtitle: 'Accelerate daily reservation workflows with AI-assisted drafting.',
    bullets: [
      {
        title: 'Drafted responses & actions:',
        desc: 'Nava AI prepares suggested replies and action cards directly in your Outlook window.',
      },
      {
        title: 'Check details & tone:',
        desc: 'Always check both the details and the tone of the drafted response before sending the email.',
      },
      {
        title: 'Expanding capabilities:',
        desc: 'Availability quoting is active now; guest lookups, folios, and reservation changes will roll out throughout the pilot.',
      },
    ],
  },
];

const MAX_UNRESOLVED_REPLY_OPERATIONS = 256;
const MAX_EXPIRED_REPLY_OUTCOMES = 256;
const REPLY_OPERATION_CACHE_TTL_MS = 15 * 60 * 1000;
const UNRESOLVED_REPLY_MARKER = 'nava_outlook_unresolved_reply_v1';

// A generic marker survives re-login/reload without storing mail IDs or PDF bytes.
// A fresh pane cannot replay the old native operation ID, so ask staff to check
// Drafts before intentionally starting another operation.
function hasUnresolvedReplyMarker(): boolean {
  try { return sessionStorage.getItem(UNRESOLVED_REPLY_MARKER) === '1'; }
  catch { return false; }
}

function setUnresolvedReplyMarker(unresolved: boolean): void {
  try {
    if (unresolved) sessionStorage.setItem(UNRESOLVED_REPLY_MARKER, '1');
    else sessionStorage.removeItem(UNRESOLVED_REPLY_MARKER);
  } catch { /* Restricted WebView storage: in-memory retries still work. */ }
}

function confirmNewReplyAfterUncertainOutcome(): boolean {
  try {
    // Intentional blocking acknowledgment: unlike a toast, another click
    // cannot silently create a second Outlook draft after an unknown outcome.
    // oxlint-disable-next-line no-alert
    return window.confirm(
      'Check Outlook Drafts for the earlier reply. Have you checked Drafts and do you want to start a new draft?',
    );
  } catch { return false; }
}

/** 'selected' is one date option's reply; 'all' is one reply carrying every completed option. */
type ReplyDraftScope = 'selected' | 'all';

type PendingReplyOperation = {
  operationId: string;
  startedAt: number;
  scope: ReplyDraftScope;
  pdfs?: Array<{ fileName: string; pdfBase64: string }>;
  reviewedHtml?: string;
  replyPayload?: {
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    htmlBody: string;
    replyAll: boolean;
    openInComposer: boolean;
  };
  draftLocation?: MailLocation;
  attachmentPayloads?: Array<{
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    fileName: string;
    base64Data: string;
  }>;
  attachmentsAdded?: number;
};

// One client for the pane's life, so screenshot loaders keep their identity across renders.
const PANE_STAY_CLIENT = paneStayFromTrpc(trpcClient);

function singleReplyDraft(draft: ReturnType<typeof requireReviewedNativeDraft>) {
  return draft
    ? {
        html: draft.html,
        attachments: [{ fileName: draft.pdf.fileName, pdfBase64: draft.pdf.pdfBase64 }],
      }
    : null;
}

/** Pane body. The route calls useOutlookBridge() once and passes the result in as `bridge`. */
export function NavaPane({ bridge }: { bridge: PaneBridge }) {
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
  const replyRetries = useRef(new Map<string, PendingReplyOperation>());
  const expiredReplyOutcomes = useRef(new Set<string>());
  const hasUntrackedExpiredReplyOutcomes = useRef(false);
  const expiredOutcomeConfirmationKey = useRef<string | null>(null);
  const unresolvedReplyConfirmationKey = useRef<string | null>(null);
  const replyMarkerBelongsToCurrentScope = useRef(false);
  const replyInFlight = useRef(false);
  const [isDraftPending, setIsDraftPending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<{ key: string; message: string } | null>(null);
  const [quoteSession, dispatchQuote] = useReducer(reduceQuoteSession, undefined, initialQuoteSession);
  // Preview/Book in HMS show only when the server flag is on. Until the read answers, the card stays copy-only.
  const [paneSaveOn, setPaneSaveOn] = useState(false);
  // Staff's edit of the combined reply. It is used only while the completed options are the same ones.
  const [combinedEdit, setCombinedEdit] = useState<CombinedReplyEdit | null>(null);
  useEffect(() => {
    let alive = true;
    void readPaneSaveFlag(trpcClient).then((on) => {
      if (alive) setPaneSaveOn(on);
    });
    return () => {
      alive = false;
    };
  }, []);
  const quoteSessionRef = useRef(quoteSession);
  quoteSessionRef.current = quoteSession;
  // True from the executeStaffQuote call until it settles. Drives the HMS queue poller.
  const [quoteRunPending, setQuoteRunPending] = useState(false);
  const hmsQueue = useHmsQueueStatus({
    pending: quoteRunPending,
    fetchStatus: () =>
      bindHmsQueueStatus(staffQuoteFromTrpc(trpcClient).workstation.hmsQueueStatus?.query),
  });
  const trackStaffQuoteRun = <T,>(run: Promise<T>): Promise<T> => {
    setQuoteRunPending(true);
    return run.finally(() => setQuoteRunPending(false));
  };
  const requoteSameStayRef = useRef<(row: PriorStaffQuoteRequoteRow) => void>(() => {});
  const selectedKey = activeEmail?.entryId
    ? `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`
    : null;
  const { data: session, isLoading } = useSession();
  const { data: activeConnection, isLoading: transportLoading } = useActiveConnection();
  const sync = useOutlookSync({userId:session?.user?.id??null,sessionId:session?.session?.id??null,transportId:activeConnection?.id??null,mailbox:activeConnection?.email??'',deviceId:workstationInfo?.deviceId??null,capabilityVersion:capabilities?.mailboxSync,readRoots:capabilities?.readRoots??[],authorized:Boolean(isConnected&&!requiresRelogin&&!authorizationUnavailable),activateNative:activateMailboxSync});
  const currentScope =
    !requiresRelogin && session?.user?.id && activeConnection?.id
      ? `${session.user.id}:${session.session?.id ?? ''}:${activeConnection.id}`
      : null;
  const selectedIdentity = activeEmail?.entryId
    ? `${activeEmail.storeId ?? ''}:${activeEmail.folderEntryId ?? ''}:${activeEmail.entryId}` : null;
  const contextRevision = useRef({ scope: currentScope, selection: selectedIdentity, scopeEpoch: 0, selectionEpoch: 0 });
  if (contextRevision.current.scope !== currentScope) {
    contextRevision.current = { scope: currentScope, selection: selectedIdentity,
      scopeEpoch: contextRevision.current.scopeEpoch + 1, selectionEpoch: contextRevision.current.selectionEpoch + 1 };
  } else if (contextRevision.current.selection !== selectedIdentity) {
    contextRevision.current = { ...contextRevision.current, selection: selectedIdentity,
      selectionEpoch: contextRevision.current.selectionEpoch + 1 };
  }
  const scopeRef = useRef(currentScope);
  const previousScope = useRef(currentScope);
  scopeRef.current = currentScope;
  useLayoutEffect(() => {
    if (previousScope.current === currentScope) return;
    previousScope.current = currentScope;
    dispatchQuote({ type: 'reset' });
    replyRetries.current.clear();
    expiredReplyOutcomes.current.clear();
    hasUntrackedExpiredReplyOutcomes.current = false;
    expiredOutcomeConfirmationKey.current = null;
    unresolvedReplyConfirmationKey.current = null;
    replyMarkerBelongsToCurrentScope.current = false;
    replyInFlight.current = false;
    setIsDraftPending(false);
    setDraftedDetails(null);
    setDraftStatus(null);
    setTestResults({ bridge: null, activeEmail: null, folderTable: null, serverPing: null });
  }, [currentScope]);

  const [draftedDetails, setDraftedDetails] = useState<{
    entryId: string;
    subject: string;
    sender: string;
    senderEmail: string;
    planName: string;
    previewHtml?: string;
  } | null>(null);

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
  useEffect(() => {
    const binding = quoteSession.binding;
    if (!binding || !quoteAdmissionKey) return;
    dispatchQuote({ type: 'analysis_started' });
    const workflow = quoteWorkflowFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    let cancelled = false;
    void bindAnalyseSelection({
      mutate: workflow.analyseSelection?.mutate,
      input: {
        internetMessageId: binding.internetMessageId,
        storeId: binding.storeId,
        entryId: binding.entryId,
        folderEntryId: binding.folderEntryId,
        selectionEpoch,
        ...(quoteSession.treatAs ? { treatAs: quoteSession.treatAs } : {}),
        ...(quoteSession.staffNote ? { staffNote: quoteSession.staffNote } : {}),
      },
    })
      .then((remote) => {
        if (cancelled) return;
        if (remote.kind === 'ready') {
          dispatchQuote({ type: 'mailbox_status', status: 'ready' });
          dispatchQuote({ type: 'analysis_ready', analysis: remote.analysis });
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
        if (cancelled) return;
        const message =
          error instanceof Error && error.message.trim() ? error.message : 'Luna could not read this email. Select it again and try again.';
        dispatchQuote({ type: 'mailbox_status', status: 'unavailable' });
        dispatchQuote({ type: 'analysis_failed', message });
      });
    const staff = staffQuoteFromTrpc(trpcClient);
    void bindStaffQuoteSource({
      query: staff.workstation.staffQuoteSource?.query,
      internetMessageId: binding.internetMessageId,
    }).then((source) => {
      if (cancelled) return;
      if (source.kind === 'message_not_synced') {
        dispatchQuote({ type: 'mailbox_status', status: 'unsynced' });
        return;
      }
      if (source.kind !== 'ready') return;
      dispatchQuote({ type: 'staff_source_ready', source: source.source });
      void bindStaffActions({
        list: staff.drafts.list?.query,
        get: staff.drafts.get?.query,
        threadId: source.source.threadId,
      }).then((actions) => {
        if (cancelled || actions.kind !== 'ready') return;
        dispatchQuote({ type: 'staff_actions_ready', actions: actions.actions });
      });
    });
    return () => {
      cancelled = true;
    };
    // Admission key is the selection identity. Body/subject are no longer read on the client.
    // Unsynced retries when mailbox committed count advances (sync finished ingesting this mail).
  }, [quoteAnalysisRetryKey]);

  const priorQuoteKey = [
    quoteSession.analysis?.luna?.workflow ?? '',
    quoteSession.staffSource?.threadId ?? '',
    String(quoteSession.inputRevision),
    String(quoteSession.binding?.selectionEpoch ?? 0),
    quoteSession.groups
      .map((group) => `${group.arrivalDate ?? ''}:${group.departureDate ?? ''}:${group.quantity ?? ''}:${group.adults ?? ''}`)
      .join(','),
    quoteSession.staffQuote ? 'quoted' : '',
    quoteSession.bookingDraft ? 'drafted' : '',
  ].join(':');
  useEffect(() => {
    const luna = quoteSession.analysis?.luna;
    const source = quoteSession.staffSource;
    const binding = quoteSession.binding;
    if (
      luna?.workflow !== 'create_booking' ||
      !source ||
      !binding ||
      quoteSession.staffQuote ||
      quoteSession.bookingDraft
    ) {
      return;
    }
    const staff = staffQuoteFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = quoteSession.inputRevision;
    const header = quoteSession.staffHeader;
    const groupId = quoteSession.groups[0]?.id;
    const quantity = quoteSession.groups[0]?.quantity;
    let cancelled = false;
    void bindListThreadQuoteRevisions({
      query: staff.workstation.listThreadQuoteRevisions?.query,
      threadId: source.threadId,
    }).then(async (revisions) => {
      if (cancelled || !revisions[0]) return;
      const reasons: string[] = [];
      let prior: Awaited<ReturnType<typeof bindUsePriorQuoteForBooking>> | null = null;
      let expiredPrior: PriorStaffQuoteRequoteRow | null = null;
      for (const row of revisions) {
        if (cancelled) return;
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
        if (candidate.status === 'ok') {
          prior = candidate;
          break;
        }
        reasons.push(candidate.reason);
        if (candidate.reason === 'expired' && !expiredPrior) {
          expiredPrior = { workflowRunId: row.workflowRunId, revisionRef: row.revisionRef };
        }
      }
      if (cancelled) return;
      if (!prior || prior.status !== 'ok') {
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
        return;
      }
      const stayKey = `${prior.payload.arrivalDate}:${prior.payload.departureDate}`;
      dispatchQuote({
        type: 'staff_quote_ready',
        offer: {
          id: prior.payload.revisionRef,
          kind: 'allocation',
          roomCode: prior.payload.roomCode,
          roomLabel: 'Selected allocation',
          board: offerBoardFromRevision(prior.payload.board),
          rateCode: prior.payload.rateCode,
          currency: 'ZAR',
          nightly: [],
          stayTotalMinor: prior.payload.totalMinor,
          observedAt: '',
          sourceRef: prior.payload.revisionRef,
          restrictions: [],
          combinable: true,
          quoteRequestKey: stayKey,
          coversGroupIds: groupId ? [groupId] : [],
          quantity,
        },
        staffQuote: {
          workflowRunId: prior.payload.workflowRunId,
          revisionRef: prior.payload.revisionRef,
          factRefs: [],
          messageId: source.messageId,
          threadId: source.threadId,
          sourceHash: source.sourceHash,
          selectionEpoch,
          inputRevision,
          inputDigest: prior.payload.revisionRef,
          totalMinor: prior.payload.totalMinor,
          currency: prior.payload.currency,
          quoteRequestKey: stayKey,
          approvedHeader: header,
        },
        selectionEpoch,
        inputRevision,
      });
      dispatchQuote({
        type: 'booking_draft_ready',
        payload: {
          draft: prior.payload.draft,
          options: prior.payload.options,
          messageId: prior.payload.messageId,
          selectionEpoch: prior.payload.selectionEpoch,
          inputRevision: prior.payload.inputRevision,
          revisionRef: prior.payload.revisionRef,
        },
        sourceHash: source.sourceHash,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [priorQuoteKey]);

  // Diagnostic state
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<{
    bridge: boolean | null;
    activeEmail: boolean | null;
    folderTable: boolean | null;
    serverPing: boolean | null;
  }>({
    bridge: null,
    activeEmail: null,
    folderTable: null,
    serverPing: null,
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
  const [tourSlideIndex, setTourSlideIndex] = useState(0);
  const [pingState, setPingState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [serverPingTimeStr, setServerPingTimeStr] = useState<string | null>(null);
  const [pingErrorMessage, setPingErrorMessage] = useState<string | null>(null);

  const detectedEmail = activeConnection?.email || 'Select an authorized mailbox';
  const detectedProperty = 'The Centurion Hotel';

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

  // Hooks stay above the early returns below; the re-run only fires after a user-clicked fallback.
  const pendingDinnerFallbackStepRef = useRef<string | null>(null);
  useEffect(() => {
    const stepId = pendingDinnerFallbackStepRef.current;
    if (!stepId) return;
    pendingDinnerFallbackStepRef.current = null;
    runQuoteStep(stepId);
  }, [quoteSession.inputRevision]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[#f1f3f6] font-sans text-slate-700">
        <p className="text-xs text-slate-500">Loading session…</p>
      </div>
    );
  }

  if (!session?.user || requiresRelogin) {
    return <OutlookPaneSignIn />;
  }

  const runComprehensiveTest = async () => {
    setTesting(true);
    const results = {
      bridge: false,
      activeEmail: false,
      folderTable: false,
      serverPing: false,
    };

    try {
      const pingResp = await sendCommand<
        Record<string, never>,
        { version?: string; bridgeProtocolVersion?: number }
      >('PING', {} as Record<string, never>);
      results.bridge = pingResp?.bridgeProtocolVersion === 4;

      const activeResp = await sendCommand<Record<string, never>, { subject?: string }>(
        'GET_ACTIVE_EMAIL',
        {} as Record<string, never>,
      );
      results.activeEmail = Boolean(activeResp?.subject || activeEmail?.subject);

      try {
        const folders = await sendCommand<
          Record<string, never>,
          {
            items: Array<{ entryId: string; defaultFolderType?: number }>;
            truncated: boolean;
          }
        >('LIST_FOLDERS', {});
        const inbox = folders.items.find((folder) => folder.defaultFolderType === 6);
        if (inbox) {
          const folderResp = await sendCommand<
            { folderEntryId: string; count: number; offset: number },
            { items: unknown[] }
          >('GET_FOLDER_EMAILS', { folderEntryId: inbox.entryId, count: 5, offset: 0 });
          results.folderTable = Array.isArray(folderResp.items);
        }
      } catch {
        // No approved Inbox ID: never fall back to a name-based or arbitrary folder read.
        results.folderTable = false;
      }

      const srv = await trpcClient.workstation.ping.mutate({
        workstationUser: 'unknown',
        outlookEmail: detectedEmail,
        outlookVersion: capabilities?.outlookVersion ?? 'unknown',
      });
      results.serverPing = srv?.status === 'ok';

      setTestResults(results);
      toast.success('System check complete.');
    } catch (err) {
      setTestResults(results);
      toast.error(`System check failed: ${err instanceof Error ? err.message : 'unknown error'}. Try again.`);
    } finally {
      setTesting(false);
    }
  };

  const currentSubject = activeEmail?.subject || 'Suite Availability Request';
  const currentSender = activeEmail?.senderName || 'David Miller';
  const currentSenderEmail = activeEmail?.senderEmail || 'guest@example.com';

  const handleInsertAiDraft = async (scope: ReplyDraftScope = 'selected') => {
    if (replyInFlight.current || !activeEmail?.entryId) return;
    const startedScope = currentScope;
    const startedScopeEpoch = contextRevision.current.scopeEpoch;
    const startedSelectionEpoch = contextRevision.current.selectionEpoch;
    const sameStaffScope = () => scopeRef.current === startedScope &&
      contextRevision.current.scopeEpoch === startedScopeEpoch;
    const key = `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`;
    const subject =
      activeEmail.subject.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled email';
    const replyLabel = `Reply to “${subject}”: `;
    let previousAttempt = replyRetries.current.get(key);
    const now = Date.now();
    const rememberExpiredOutcome = (expiredKey: string) => {
      if (expiredReplyOutcomes.current.has(expiredKey)) return;
      if (expiredReplyOutcomes.current.size >= MAX_EXPIRED_REPLY_OUTCOMES) {
        hasUntrackedExpiredReplyOutcomes.current = true;
        return;
      }
      expiredReplyOutcomes.current.add(expiredKey);
    };

    if (previousAttempt && now - previousAttempt.startedAt >= REPLY_OPERATION_CACHE_TTL_MS) {
      replyRetries.current.delete(key);
      rememberExpiredOutcome(key);
      // Even after staff acknowledges an expired outcome, its old operation
      // ID must never be retried against a server window that has closed.
      previousAttempt = undefined;
    }
    for (const [retryKey, attempt] of replyRetries.current) {
      if (now - attempt.startedAt >= REPLY_OPERATION_CACHE_TTL_MS) {
        replyRetries.current.delete(retryKey);
        rememberExpiredOutcome(retryKey);
      }
    }
    let acknowledgedExpiredOutcome = false;
    if (expiredReplyOutcomes.current.has(key)) {
      if (expiredOutcomeConfirmationKey.current !== key) {
        expiredOutcomeConfirmationKey.current = key;
        toast.error(
          `${replyLabel}The retry window has closed. Check Outlook Drafts, then click again to continue.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      expiredReplyOutcomes.current.delete(key);
      expiredOutcomeConfirmationKey.current = null;
      acknowledgedExpiredOutcome = true;
    }
    if (hasUntrackedExpiredReplyOutcomes.current && !acknowledgedExpiredOutcome) {
      if (expiredOutcomeConfirmationKey.current !== key) {
        expiredOutcomeConfirmationKey.current = key;
        toast.error(
          `${replyLabel}Too many earlier replies have an unknown result. Check Outlook Drafts, then click again to continue.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      expiredOutcomeConfirmationKey.current = null;
    }
    // In a live pane another message may have an unresolved, safely retryable
    // operation. The generic reload marker only gates a fresh pane with no IDs.
    if (!previousAttempt && replyRetries.current.size === 0 &&
      !replyMarkerBelongsToCurrentScope.current && hasUnresolvedReplyMarker()) {
      if (unresolvedReplyConfirmationKey.current !== key) {
        unresolvedReplyConfirmationKey.current = key;
        toast.error(
          `${replyLabel}An earlier draft may have been created before the pane changed. Check Outlook Drafts, then click again to start a new draft.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      unresolvedReplyConfirmationKey.current = null;
      // Keep the prior unknown outcome recorded until this attempt actually
      // reaches native Outlook and succeeds. PDF generation may still abort.
    }
    if (!previousAttempt && replyRetries.current.size >= MAX_UNRESOLVED_REPLY_OPERATIONS) {
      toast.error(
        `${replyLabel}Too many replies have an unknown result. Check Outlook Drafts before refreshing the pane or starting another reply.`,
      );
      return;
    }

    if (!startedScope || transportLoading || !activeConnection?.email) {
      toast.error('Sign in and select your mailbox before creating the draft.');
      return;
    }
    if (!activeEmail.storeId || !activeEmail.folderEntryId) {
      toast.error(
        'Outlook did not provide the selected message and source folder. Select it again.',
      );
      return;
    }

    if (!supportsAction('ADD_ATTACHMENT_TO_DRAFT')) {
      toast.error('This Outlook add-in is too old to attach the PDF. Update the Nava Outlook add-in, then try again.');
      return;
    }

    if (previousAttempt && previousAttempt.scope !== scope) {
      // An attempt that may already have reached Outlook is retried with its own button only.
      if (previousAttempt.replyPayload) {
        toast.error(
          `${replyLabel}An earlier reply for this email may already be in Outlook Drafts. Retry it with its own button, or check Drafts first.`,
        );
        return;
      }
      replyRetries.current.delete(key);
      previousAttempt = undefined;
    }
    const reviewedDraft =
      scope === 'all'
        ? requireMultiOptionDraft(quoteSession, combinedEdit)
        : singleReplyDraft(requireReviewedNativeDraft(quoteSession));
    if (!reviewedDraft) {
      toast.error(
        scope === 'all'
          ? `${replyLabel}Prepare a PDF for each date option first. Each PDF must match its own run.`
          : 'Make the PDF and finish the reply before creating the draft. Sample rates are never used.',
      );
      return;
    }

    replyInFlight.current = true;
    setIsDraftPending(true);
    setDraftStatus(null);
    const attempt: PendingReplyOperation = previousAttempt ?? {
      operationId: createOperationId(),
      startedAt: now,
      scope,
    };
    replyRetries.current.set(key, attempt);

    // Before CREATE is submitted, staff may update the review. Once it may
    // have reached Outlook, retries must replay the exact original pair.
    if (!attempt.replyPayload) {
      attempt.reviewedHtml = reviewedDraft.html;
      attempt.pdfs = reviewedDraft.attachments.map((item) => ({
        fileName: item.fileName,
        pdfBase64: item.pdfBase64,
      }));
    }
    const quotationHtml = attempt.reviewedHtml ?? reviewedDraft.html;
    let draftCreated = false;

    try {
      const pdfs = attempt.pdfs ?? reviewedDraft.attachments;
      if (!sameStaffScope() || contextRevision.current.selectionEpoch !== startedSelectionEpoch) {
        // No new Outlook command has started for this click. A delayed quotation
        // cannot create or retry a reply for a selection that changed away
        // and back, even when its current EntryID and session string match.
        if (sameStaffScope() && !attempt.replyPayload) replyRetries.current.delete(key);
        return;
      }
      attempt.pdfs = pdfs;
      if (!attempt.draftLocation) {
        // Renewal may suppress selection events while Outlook is busy. A PDF
        // generated for A must not turn into a reply to A after staff select B.
        const selected = await sendCommand<Record<string, never>, WorkstationEmailPayload | null>(
          'GET_ACTIVE_EMAIL', {},
        );
        if (!sameStaffScope() || contextRevision.current.selectionEpoch !== startedSelectionEpoch) {
          if (sameStaffScope() && !attempt.replyPayload) replyRetries.current.delete(key);
          return;
        }
        if (!selected || selected.entryId !== activeEmail.entryId ||
          selected.storeId !== activeEmail.storeId ||
          selected.folderEntryId !== activeEmail.folderEntryId) {
          if (!attempt.replyPayload) replyRetries.current.delete(key);
          toast.error('You switched emails while the PDF was being made. Select the email again, then retry.');
          return;
        }
      }
      const replyPayload = attempt.replyPayload ?? {
        operationId: attempt.operationId,
        entryId: activeEmail.entryId,
        storeId: activeEmail.storeId,
        folderEntryId: activeEmail.folderEntryId,
        htmlBody: quotationHtml,
        replyAll: false,
        openInComposer: false,
      };
      attempt.replyPayload = replyPayload;
      if (!attempt.draftLocation) {
        replyMarkerBelongsToCurrentScope.current = true;
        setUnresolvedReplyMarker(true);
      }
      const result =
        attempt.draftLocation ??
        (await sendCommand<typeof replyPayload, MailLocation>('CREATE_REPLY_DRAFT', replyPayload));
      if (!sameStaffScope()) return;
      if (!result || typeof result !== 'object')
        throw new Error('Outlook did not confirm the reply draft.');
      draftCreated = true;
      const replyResult = result;
      if (!replyResult.entryId || !replyResult.storeId || !replyResult.folderEntryId) {
        throw new Error(
          'Outlook did not confirm the draft and its source folder. Inspect Drafts before retrying.',
        );
      }
      attempt.draftLocation = replyResult;
      const attachmentPayloads =
        attempt.attachmentPayloads ??
        pdfs.map((item) => ({
          operationId: createOperationId(),
          entryId: replyResult.entryId,
          storeId: replyResult.storeId,
          folderEntryId: replyResult.folderEntryId,
          fileName: item.fileName,
          base64Data: item.pdfBase64,
        }));
      attempt.attachmentPayloads = attachmentPayloads;
      // Each PDF keeps its own operation ID. A retry resumes at the first PDF Outlook has not confirmed.
      const alreadyAdded = attempt.attachmentsAdded ?? 0;
      for (const [index, payload] of attachmentPayloads.entries()) {
        if (index < alreadyAdded) continue;
        await sendCommand('ADD_ATTACHMENT_TO_DRAFT', payload);
        attempt.attachmentsAdded = index + 1;
        if (!sameStaffScope()) return;
      }
      replyRetries.current.delete(key);
      // A successful draft for B does not resolve an expired or unknown
      // outcome for A. Those per-message sets are in memory only; preserve
      // the generic warning across reloads until every outcome is resolved.
      if (!expiredReplyOutcomes.current.size && !hasUntrackedExpiredReplyOutcomes.current &&
        ![...replyRetries.current.values()].some((pending) => pending.replyPayload)) {
        setUnresolvedReplyMarker(false);
      }
      setDraftedDetails({
        entryId: activeEmail.entryId,
        subject: currentSubject,
        sender: currentSender,
        senderEmail: currentSenderEmail,
        planName: pdfs.map((item) => item.fileName).join(', '),
        ...(attempt.scope === 'all' ? { previewHtml: quotationHtml } : {}),
      });
      const opened = replyResult.displayed === true;
      const details = [
        replyResult?.composerWarning,
        replyResult?.draftPlacementWarning,
        replyResult?.folderPlacementWarning,
        replyResult?.locationUnverified ? 'Could not confirm which folder the draft is in.' : null,
      ].filter(Boolean);
      const summary = opened
        ? 'Draft opened in Outlook. Check it, then send it yourself.'
        : replyResult?.entryId
          ? 'Draft saved in Outlook but did not open. Find it in Outlook Drafts.'
          : 'Outlook accepted the request, but could not confirm the draft. Check Outlook Drafts before trying again.';
      const message = [summary, ...details].join(' ');
      setDraftStatus({ key, message });
      if (details.length || !opened) toast.warning(`${replyLabel}${message}`);
      else toast.success(`${replyLabel}${message}`);
    } catch (err) {
      if (!sameStaffScope()) return;
      if (contextRevision.current.selectionEpoch !== startedSelectionEpoch && !attempt.replyPayload) {
        replyRetries.current.delete(key);
        return;
      }
      const errorCode =
        err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
      const hasUnknownOutcome = errorCode === 'OPERATION_OUTCOME_UNKNOWN';
      const timedOut = err instanceof Error && err.message.includes('timed out');
      const navigationInterrupted =
        err instanceof Error && err.message.includes('Outlook navigation changed');
      const mayHaveReachedOutlook = Boolean(attempt.replyPayload);
      if (!timedOut && !hasUnknownOutcome && !draftCreated && !mayHaveReachedOutlook) {
        replyRetries.current.delete(key);
      }
      if (
        hasUnknownOutcome ||
        (timedOut && draftCreated) ||
        ((timedOut || navigationInterrupted) && mayHaveReachedOutlook)
      ) {
        const message =
          'Outlook may have created the draft but did not confirm it. Check Outlook Drafts before retrying. A retry reuses the same PDF.';
        setDraftStatus({ key, message });
        toast.error(`${replyLabel}${message}`);
      } else {
        toast.error(
          `${replyLabel}Could not create the draft: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    } finally {
      if (sameStaffScope()) {
        replyInFlight.current = false;
        setIsDraftPending(false);
      }
    }
  };

  requoteSameStayRef.current = (row) => {
    const session = quoteSessionRef.current;
    const luna = session.analysis?.luna;
    const source = session.staffSource;
    const binding = session.binding;
    if (luna?.workflow !== 'create_booking' || !source || !binding) {
      toast.warning('Stay details are not ready to re-quote. Check the dates and rooms first.');
      return;
    }
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = session.inputRevision;
    const staff = staffQuoteFromTrpc(trpcClient);
    void bindGetPriorStaffQuoteRequote({
      query: staff.workstation.getPriorStaffQuoteRequote?.query,
      threadId: source.threadId,
      row,
    }).then((loaded) => {
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
      const run = bindExecuteStaffQuote({
        mutate: staff.workstation.executeStaffQuote?.mutate,
        source,
        selectionEpoch,
        inputRevision,
        groups,
        header,
      });
      return trackStaffQuoteRun(run).then((remote) => {
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

  const runQuoteStep = (stepId: string) => {
    const step = quoteSession.steps.find((item) => item.id === stepId);
    if (!step || !canRunQuoteStep(step, quoteSession.steps, quoteSession.runningStepId)) return;
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
    const stayGroups = groupsForQuoteStep(quoteSession, step);
    const staff = staffQuoteFromTrpc(trpcClient);
    const run = bindExecuteStaffQuote({
      mutate: staff.workstation.executeStaffQuote?.mutate,
      source,
      selectionEpoch,
      inputRevision,
      groups: stayGroups,
      header: quoteSession.staffHeader,
    });
    void trackStaffQuoteRun(run).then((remote) => {
      if (remote.status !== 'ok') {
        dispatchQuote({
          type: 'results_unavailable',
          stepId: step.id,
          reason: remote.reason,
          selectionEpoch,
          inputRevision,
        });
        const dinnerGroupIds = stayGroups
          .filter((group) => group.board === 'dinner_bb')
          .map((group) => group.id);
        if (remote.noMatchingRate && dinnerGroupIds.length) {
          toast.warning(remote.reason, {
            duration: 60_000,
            action: {
              label: 'Quote as B&B + dinner allowance',
              onClick: () => {
                // The offer belongs to the run that made it. If staff have since moved to another email or edited
                // the inputs, it is stale and must not patch the current quote.
                if (!quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision })) {
                  toast.warning('That quote has changed. Run the quote again to quote as B&B.');
                  return;
                }
                quoteAsBbWithDinnerAllowance(step.id, dinnerGroupIds);
              },
            },
          });
        } else {
          toast.warning(remote.reason);
        }
        return;
      }
      dispatchQuote({
        type: 'staff_quote_ready',
        offer: remote.offer,
        staffQuote: remote.staffQuote,
        selectionEpoch,
        inputRevision,
        extrasReviewItems: remote.extrasReviewItems,
        approvedHeader: quoteSession.staffHeader,
      });
      for (const item of remote.extrasReviewItems) toast.warning(item);
      const luna = quoteSession.analysis?.luna;
      if (luna?.workflow === 'create_booking') {
        void bindPrepareBookingDraft({
          mutate: staff.workstation.prepareBookingDraft?.mutate,
          source,
          workflowRunId: remote.staffQuote.workflowRunId,
          revisionRef: remote.staffQuote.revisionRef,
          messageId: source.messageId,
          selectionEpoch,
          inputRevision,
          analysis: { ...luna, groups: overlayLunaGroupsFromStaff(luna, quoteSession.groups) },
        }).then((draftRemote) => {
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
      }
    });
  };

  /**
   * One-click dinner fallback after a clean HMS no-match: switch the dinner groups to B&B, mark the
   * dinner allowance as staff-entered (never priced here), then re-run the same quote step once the
   * patched session has rendered (see pendingDinnerFallbackStepRef).
   */
  const quoteAsBbWithDinnerAllowance = (stepId: string, groupIds: string[]) => {
    if (!groupIds.length) return;
    pendingDinnerFallbackStepRef.current = stepId;
    dispatchQuote({ type: 'staff_dinner_bb_fallback', groupIds });
    toast.warning('Quoting as Bed & Breakfast. Enter the dinner allowance per person per night before preparing the PDF.');
  };

  /**
   * Builds the quotation PDF for one date option from that option's own run.
   * A null stayKey means the selected option (the "Prepare quotation PDF" button).
   */
  const preparePdfFor = (stayKey: string | null) => {
    const session = quoteSessionRef.current;
    if (dinnerAllowanceStillRequired(session.staffHeader)) {
      toast.warning('Enter the dinner allowance per person per night before preparing the PDF.');
      return;
    }
    const key = stayKey ?? session.selectedStayKey;
    const quote = key ? (session.staffQuotes[key] ?? null) : null;
    const source = session.staffSource;
    const authorised =
      staffSourceReady(session) &&
      session.evidence?.kind === 'authorised' &&
      evidenceMatchesSession(session);
    if (!quote || !key) {
      toast.warning('The quote is not ready for a PDF yet. Run the search again, then prepare the PDF.');
      return;
    }
    if (isQuoteFixturePreview() || !authorised) {
      toast.warning('This is sample data, so no PDF can be made. Open a live email to continue.');
      return;
    }
    if (key === session.selectedStayKey && !canCreatePdf(session)) {
      toast.warning('Pick a room option from the HMS results before making the PDF.');
      return;
    }
    if (!source || quote.totalMinor <= 0) {
      toast.warning('The quote is not ready for a PDF yet. Run the search again, then prepare the PDF.');
      return;
    }
    const header = quote.approvedHeader;
    if (!header) {
      toast.warning('The quote header was not saved with this quote. Run the search again, then prepare the PDF.');
      return;
    }
    if (key !== session.selectedStayKey) dispatchQuote({ type: 'select_stay_key', stayKey: key });
    const selectionEpoch = session.binding?.selectionEpoch ?? 0;
    const inputRevision = session.inputRevision;
    const selectedOfferIds = [quote.revisionRef];
    const staff = staffQuoteFromTrpc(trpcClient);
    void bindQualifiedStaffProposalPdf({
      mutate: staff.workstation.qualifiedQuoteProposalPdf?.mutate,
      input: {
        workflowRunId: quote.workflowRunId,
        revisionRef: quote.revisionRef,
        messageId: source.messageId,
        outlookEmail: session.binding?.mailboxEmail ?? '',
        factRefs: quote.factRefs,
        company: header.company,
        agency: header.agency,
        attention: header.attention,
        clientEmail: header.clientEmail,
        clientTelephone: header.clientTelephone,
      },
      expectedTotalMinor: quote.totalMinor,
    }).then((remote) => {
      if (remote.status === 'unavailable') {
        toast.warning(remote.reason);
        return;
      }
      dispatchQuote({
        type: 'pdf_ready',
        pdf: {
          fileName: remote.pdf.fileName,
          bytesBase64: remote.pdf.pdfBase64,
          pdfHash: remote.pdf.pdfHash,
          revisionId: remote.pdf.revisionId,
          totalMinor: remote.pdf.totalMinor,
        },
        selectionEpoch,
        inputRevision,
        selectedOfferIds,
      });
    });
  };

  // One reply for every completed date option (two or more PDFs); per-option Draft stays available.
  const dateOptionLetters = completedDateOptions(quoteSession).map((option) => option.letter);
  const allOptionsDraft = dateOptionLetters.length >= 2;
  const allOptionsLabel = `Create one reply with all date options (${dateOptionLetters.join(', ')})`;
  const selectedIndex = quoteSession.selectedStayKey
    ? requestedQuoteKeys(quoteSession.groups).indexOf(quoteSession.selectedStayKey)
    : -1;
  const selectedOptionLabel =
    selectedIndex >= 0
      ? `Draft option ${optionLetter(selectedIndex)} only`
      : 'Draft the selected option only';

  return (
    <div className="flex min-h-screen w-full justify-center bg-[#f1f3f6] font-['Segoe_UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif]">
      {/* Strict 380px pane container */}
      <div className="shadow-xs relative flex min-h-screen w-[380px] min-w-[360px] max-w-[400px] flex-col border-x border-[#cbd5e1] bg-white text-[#1e293b]">
        {/* Outlook 2016 Header */}
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#e2e8f0] bg-white px-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-[3px] bg-[#1a4332] text-[11px] font-extrabold text-white">
              N
            </span>
            <div>
              <h1 className="text-[13px] font-bold text-[#1e293b]">Nava AI Reservationist</h1>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#475569]">
            <span
              className={`h-2 w-2 rounded-full ${
                isConnected ? 'animate-pulse bg-emerald-600' : 'bg-rose-500'
              }`}
            />
            {sync.eligible ? <OutlookSyncProgress status={sync.status} mailbox={activeConnection?.email??''} error={sync.error} busy={sync.busy} onControl={(operation)=>{void sync.control(operation).catch(()=>undefined);}}/> : <span>Centurion</span>}
            <span className="sr-only">
              {isConnected
                ? `Connected to Classic Outlook (${capabilities?.outlookVersion ?? 'version unavailable'}; product/build unknown)`
                : 'Disconnected'}
            </span>
          </div>
        </header>

        {isConnected && capabilities && capabilities.mailboxSync !== 1 && <p className="mx-3 mt-2 text-[11px] text-slate-600">Update the Outlook add-in to enable automatic email copying.</p>}
        {/* An old installer cannot perform even read-only COM actions. */}
        {isConnected && (updateRequired || workstationInfo?.bridgeProtocolVersion !== 4) && (
          <div
            role="alert"
            className="m-3 mb-0 rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800"
          >
            Update the Outlook add-in to protocol v4. This installer cannot access mail.
          </div>
        )}
        {isConnected && !updateRequired && workstationInfo?.paired === false && (
          <div className="m-3 mb-0 rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
            <p>
              Outlook device pairing requires a supervised operator code entered in a Windows-only
              dialog.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void pairDevice?.().catch((error: unknown) => {
                  toast.error(
                    error instanceof Error ? error.message : 'Could not pair Outlook device',
                  );
                });
              }}
            >
              Pair Outlook Device
            </Button>
          </div>
        )}
        {isConnected && workstationInfo?.paired && authorizationUnavailable && !requiresRelogin && (
          <div role="status" className="m-3 mb-0 rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800">
            <p>Nava is connecting to this mailbox. If this stays, open an email in your Inbox.</p>
            <Button type="button" size="sm" onClick={refreshAuthorization}>
              Try again
            </Button>
          </div>
        )}
        {selectionOutsideMailbox && (
          <div role="status" className="m-3 mb-0 rounded-sm border border-slate-300 bg-slate-50 p-2.5 text-xs text-slate-700">
            <p>
              {activeConnection?.email
                ? `This email isn't in ${activeConnection.email}. Pick an email from the ${activeConnection.email} inbox.`
                : "This email isn't in the connected mailbox. Pick an email from its inbox."}
            </p>
          </div>
        )}

        {/* Top Step Switcher Navigation Bar */}
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

        {/* SCREEN 1: WELCOME & MAILBOX DETECTION */}
        {currentScreen === 'welcome' && (
          <div className="animate-in fade-in flex flex-1 flex-col p-4 duration-150">
            <div className="my-auto flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eaf4ee] text-[#1a4332]">
                <Building2 className="h-6 w-6" />
              </div>
              <h1 className="text-base font-bold text-[#1e293b]">Welcome to Nava AI</h1>
              <p className="mt-1 text-xs leading-relaxed text-[#64748b]">
                Your intelligent assistant for Infor HMS quoting and reservations, built directly
                into Outlook.
              </p>

              <div className="my-5 w-full rounded-sm border border-[#e2e8f0] bg-[#f8fafc] p-3 text-left">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">
                  Detected Outlook Account
                </span>
                <div className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-[#1e293b]">
                  <Mail className="h-4 w-4 text-[#64748b]" />
                  <span>{detectedEmail}</span>
                </div>
                <span className="mt-1 block text-[11px] text-[#64748b]">{detectedProperty}</span>
              </div>

              <Button
                type="button"
                onClick={() => {
                  setCurrentScreen('diagnostics');
                  void executeServerPing();
                }}
                className="flex w-full items-center justify-center gap-2 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023]"
              >
                <span>Confirm Account & Connect</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* SCREEN 2: SYSTEM & NAVA AI SERVICES CHECK */}
        {currentScreen === 'diagnostics' && (
          <div className="animate-in fade-in flex flex-1 flex-col p-4 duration-150">
            <div className="my-auto flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eff6ff] text-[#0066cc]">
                <Network className="h-6 w-6" />
              </div>
              <h1 className="text-base font-bold text-[#1e293b]">Connecting to Nava AI Services</h1>
              <p className="mt-1 text-xs text-[#64748b]">
                Verifying connection to Nava AI server and workstation environment.
              </p>

              <div className="my-5 w-full space-y-3 text-left">
                <div
                  className={`flex items-start gap-2.5 rounded-sm border p-3 ${
                    pingState === 'success'
                      ? 'border-emerald-200 bg-emerald-50/50'
                      : pingState === 'error'
                        ? 'border-rose-200 bg-rose-50/50'
                        : 'border-[#e2e8f0] bg-white'
                  }`}
                >
                  {pingState === 'loading' && (
                    <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[#0066cc]" />
                  )}
                  {pingState === 'success' && (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  )}
                  {pingState === 'error' && (
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                  )}
                  {pingState === 'idle' && <Clock className="h-4 w-4 shrink-0 text-slate-400" />}

                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#1e293b]">
                        Nava AI Server Connection
                      </span>
                      {pingState === 'success' && (
                        <span className="text-[10px] font-bold text-emerald-700">CONNECTED</span>
                      )}
                      {pingState === 'loading' && (
                        <span className="text-[10px] font-bold text-blue-700">CONNECTING…</span>
                      )}
                      {pingState === 'error' && (
                        <span className="text-[10px] font-bold text-rose-700">ERROR</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#64748b]">
                      {pingState === 'success' &&
                        `Centurion Hotel · API server pinged at ${serverPingTimeStr} · Active`}
                      {pingState === 'loading' && `Pinging server from ${detectedEmail}…`}
                      {pingState === 'error' && (pingErrorMessage || 'Failed to connect to server')}
                      {pingState === 'idle' && 'Waiting to initiate handshake…'}
                    </div>
                  </div>
                </div>

                {pingState === 'success' && (
                  <div className="flex items-center gap-2 rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] font-medium text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>Nava AI server connected · Workstation API ping verified.</span>
                  </div>
                )}

                {pingState === 'error' && (
                  <Button
                    type="button"
                    onClick={() => void executeServerPing()}
                    className="w-full bg-rose-600 text-xs text-white hover:bg-rose-700"
                  >
                    Retry Connection
                  </Button>
                )}
              </div>

              <Button
                type="button"
                disabled={pingState !== 'success'}
                onClick={() => {
                  setTourSlideIndex(0);
                  setCurrentScreen('tour');
                }}
                className="flex w-full items-center justify-center gap-2 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023] disabled:opacity-50"
              >
                <span>Next: 60-Second Feature Tour</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* SCREEN 3: 3-SLIDE QUICK TOUR PRIMER */}
        {currentScreen === 'tour' && (
          <div className="animate-in fade-in flex flex-1 flex-col p-3 duration-150">
            <div className="my-auto flex flex-col items-center rounded-sm border border-[#e2e8f0] bg-white p-4 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f1f3f6] text-[#1a4332]">
                {tourSlideIndex === 0 && <Mail className="h-5 w-5" />}
                {tourSlideIndex === 1 && <Building2 className="h-5 w-5" />}
                {tourSlideIndex === 2 && <Sparkles className="h-5 w-5" />}
              </div>
              <h2 className="text-sm font-bold text-[#1e293b]">
                {TOUR_SLIDES[tourSlideIndex]?.title}
              </h2>
              <p className="mt-1 text-xs text-[#64748b]">{TOUR_SLIDES[tourSlideIndex]?.subtitle}</p>

              <div className="mt-4 w-full space-y-2 text-left">
                {TOUR_SLIDES[tourSlideIndex]?.bullets.map((b) => (
                  <div
                    key={b.title}
                    className="flex items-start gap-2 rounded-sm bg-[#f8fafc] p-2 text-xs"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    <div>
                      <strong className="text-[#1e293b]">{b.title}</strong>{' '}
                      <span className="text-[#475569]">{b.desc}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Dots */}
              <div className="my-4 flex justify-center gap-1.5">
                {[0, 1, 2].map((idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setTourSlideIndex(idx)}
                    className={`h-2 rounded-full transition-all ${
                      idx === tourSlideIndex ? 'w-5 bg-[#1a4332]' : 'w-2 bg-[#cbd5e1]'
                    }`}
                    aria-label={`Slide ${idx + 1}`}
                  />
                ))}
              </div>

              {/* Prev/Next buttons */}
              <div className="flex w-full items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={tourSlideIndex === 0}
                  onClick={() => setTourSlideIndex((i) => Math.max(0, i - 1))}
                  className="flex-1 text-xs"
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    if (tourSlideIndex < TOUR_SLIDES.length - 1) {
                      setTourSlideIndex((i) => i + 1);
                    } else {
                      if (typeof window !== 'undefined') {
                        try {
                          localStorage.setItem('nava_onboarding_completed', 'true');
                        } catch {
                          // Non-fatal if storage write fails
                        }
                      }
                      setCurrentScreen('tool');
                      toast.success('Onboarding complete! Opened Infor HMS Quoting Tool');
                    }
                  }}
                  className="flex-1 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023]"
                >
                  {tourSlideIndex === TOUR_SLIDES.length - 1 ? (
                    <>
                      <span>Open Nava AI</span> <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </>
                  ) : (
                    <>
                      <span>Next</span> <ChevronRight className="ml-1 h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Scrollable Body: SCREEN 4 QUOTING TOOL */}
        {currentScreen === 'tool' && (
          <main className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
            {/* Email Context Bar */}
            <div id="quote-selected-message" className="flex items-center justify-between rounded-sm border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Mail className="h-4 w-4 shrink-0 text-[#64748b]" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-semibold text-[#1e293b]">
                    {currentSubject}
                  </span>
                  <span className="truncate text-[11px] text-[#64748b]">
                    {currentSender} &lt;{currentSenderEmail}&gt;
                  </span>
                </div>
              </div>
              {activeEmail ? (
                <span className="flex shrink-0 items-center gap-1 rounded-sm bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                  <Check className="h-3 w-3" /> Synced
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                  Sample
                </span>
              )}
            </div>

            <AmendLookupPanel session={quoteSession} trpc={trpcClient} />
            <VoucherFindCard
              key={activeEmail?.internetMessageId ?? 'no-email'}
              internetMessageId={activeEmail?.internetMessageId ?? null}
              trpc={trpcClient}
            />

            {!quoteSession.staffQuote && <p className="px-1 text-[10px] uppercase tracking-wider text-amber-700/80">
              {activeEmail
                ? "Luna's suggestions from this email. Check and correct them before running searches."
                : 'Sample data, not from a live email.'}
            </p>}

            <QuoteWorkflowPanel
              session={quoteSession}
              paneSave={paneSaveOn ? PANE_STAY_CLIENT : null}
              onPatchGroup={(groupId, patch) => dispatchQuote({ type: 'patch_group', groupId, patch })}
              onRunNext={() => {
                const nextStep = pickNextRunnableStep(quoteSession.steps, quoteSession.runningStepId);
                if (nextStep) runQuoteStep(nextStep.id);
              }}
              onRunStep={runQuoteStep}
              onSelectOffer={(offerId) =>
                dispatchQuote({ type: 'select_offers', offerIds: nextSelectedOfferIds(quoteSession, offerId) })
              }
              onReplyChange={(html) => dispatchQuote({ type: 'set_reviewed_reply', html })}
              onHandleReviewItem={(itemId) => dispatchQuote({ type: 'handle_review_item', itemId })}
              onUndoReviewItem={(itemId) => dispatchQuote({ type: 'unhandle_review_item', itemId })}
              onPatchStaffHeader={(header) => dispatchQuote({ type: 'patch_staff_header', header })}
              onSelectStayKey={(stayKey) => dispatchQuote({ type: 'select_stay_key', stayKey })}
              onTreatAs={(treatAs) => dispatchQuote({ type: 'treat_as', treatAs })}
              onStaffNote={(staffNote) => dispatchQuote({ type: 'staff_note', staffNote })}
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
                    ? `Luna found this in the selected email. It lists the file ${item.filename}. A file name does not show what is inside, so open the attachment in Outlook to read it.`
                    : 'The selected email is shown at the top of this pane. Open it in Outlook for the full text.',
                );
              }}
              onPreparePdf={() => preparePdfFor(null)}
              onPreparePdfFor={(stayKey) => preparePdfFor(stayKey)}
            />

            <div className="flex flex-col gap-2.5">
                {/* Draft Quotation into Outlook Reply Button */}
                <Button
                  type="button"
                  aria-label={allOptionsDraft ? allOptionsLabel : 'Insert Draft in Outlook'}
                  onClick={() => handleInsertAiDraft(allOptionsDraft ? 'all' : 'selected')}
                  disabled={!activeEmail || !supportsAction('CREATE_REPLY_DRAFT') || isDraftPending}
                  className="shadow-xs h-10 w-full rounded-sm bg-[#1a4332] text-xs font-bold text-white transition-colors hover:bg-[#123023] disabled:opacity-50"
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {isDraftPending
                    ? 'Creating the Outlook draft. Please wait…'
                    : allOptionsDraft
                      ? allOptionsLabel
                      : 'Insert draft in Outlook'}
                </Button>
                {allOptionsDraft ? (
                  <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
                    Combined reply (you can edit it)
                    <textarea
                      aria-label="Combined reply"
                      className="outline-hidden min-h-28 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
                      value={requireMultiOptionDraft(quoteSession, combinedEdit)?.html ?? ''}
                      onChange={(event) =>
                        setCombinedEdit({
                          signature: multiOptionSignature(quoteSession) ?? '',
                          html: event.target.value,
                        })
                      }
                    />
                  </label>
                ) : null}
                {allOptionsDraft ? (
                  <p className="text-center text-[11px] text-[#64748b]">
                    Puts every option you ran into one email draft. Nothing is sent.
                  </p>
                ) : null}
                {allOptionsDraft ? (
                  <Button
                    type="button"
                    aria-label={selectedOptionLabel}
                    onClick={() => handleInsertAiDraft('selected')}
                    disabled={
                      !activeEmail ||
                      !supportsAction('CREATE_REPLY_DRAFT') ||
                      isDraftPending ||
                      !canCreateNativeDraft(quoteSession)
                    }
                    className="shadow-xs h-9 w-full rounded-sm border border-[#1a4332] bg-white text-xs font-semibold text-[#1a4332] transition-colors hover:bg-[#eaf4ee] disabled:opacity-50"
                  >
                    {selectedOptionLabel}
                  </Button>
                ) : null}
                <p className="text-center text-[11px] text-[#64748b]">
                  Creates an unsent reply with the PDF attached. Review it, then Send manually in Outlook.
                  Nava never sends from this pane.
                </p>

                {/* Status Message */}
                {draftStatus && draftStatus.key === selectedKey && (
                  <p role="status" className="text-xs text-amber-700">
                    {draftStatus.message}
                  </p>
                )}

                {/* Outlook Email Draft Preview Box */}
                {showDraftPreview && draftedDetails && (
                  <div className="animate-in fade-in rounded-sm border border-[#cbd5e1] bg-white p-3 text-xs leading-relaxed text-[#1e293b] duration-200">
                    <div className="mb-2 flex items-start justify-between border-b border-[#e2e8f0] pb-2 text-[11px] text-[#64748b]">
                      <div>
                        <strong>To:</strong> {draftedDetails.sender} &lt;
                        {draftedDetails.senderEmail}&gt;
                        <br />
                        <strong>Subject:</strong> RE: {draftedDetails.subject} — Quotation
                      </div>
                      <button
                        type="button"
                        onClick={() => setDraftedDetails(null)}
                        className="text-[10px] text-slate-400 hover:text-slate-600"
                      >
                        Dismiss
                      </button>
                    </div>
                    {draftedDetails.previewHtml ? (
                      <div dangerouslySetInnerHTML={{ __html: draftedDetails.previewHtml }} />
                    ) : quoteSession.reviewedReplyHtml ? (
                      <div dangerouslySetInnerHTML={{ __html: quoteSession.reviewedReplyHtml }} />
                    ) : (
                      <p>No reviewed reply HTML. Insert uses only a staff-reviewed reply.</p>
                    )}
                    {draftedDetails.planName ? (
                      <p className="mt-2 text-[11px] text-[#64748b]">Attached: {draftedDetails.planName}</p>
                    ) : null}
                  </div>
                )}
            </div>

            {/* System Diagnostics Drawer */}
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={runComprehensiveTest}
                disabled={testing}
                className="h-8 w-full border-[#cbd5e1] text-xs font-medium text-[#475569] hover:bg-[#f8fafc]"
              >
                <RefreshCw className={`mr-2 h-3.5 w-3.5 ${testing ? 'animate-spin' : ''}`} />
                {testing ? 'Checking Outlook and the Nava server…' : 'Run system check'}
              </Button>
              <p className="mt-1 text-center text-[11px] text-[#64748b]">
                Checks that Outlook, the selected email and the Nava server all respond.
              </p>
            </div>

            {(testResults.bridge !== null || testResults.serverPing !== null) && (
              <div className="flex flex-col gap-1.5 rounded-sm border border-[#e2e8f0] bg-[#f8fafc] p-2.5 text-xs">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#64748b]">
                  System check results
                </p>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>1. Outlook add-in connected</span>
                  {testResults.bridge ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>2. Selected email readable</span>
                  {testResults.activeEmail ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>3. Outlook folders readable</span>
                  {testResults.folderTable ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>4. Nava server reachable</span>
                  {testResults.serverPing ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
              </div>
            )}
          </main>
        )}

        {/* Minimal Pilot Footer */}
        <footer className="mt-auto flex shrink-0 items-center justify-center border-t border-[#f1f5f9] px-3 py-2 text-center">
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10.5px] text-[#94a3b8]">
            <span>
              Pilot feedback:{' '}
              <a href="mailto:aroransh17@gmail.com" className="text-[#64748b] hover:underline">
                aroransh17@gmail.com
              </a>
            </span>
            <span className="text-[#cbd5e1]">·</span>
            <span>
              WhatsApp:{' '}
              <a
                href="https://wa.me/447505014078"
                target="_blank"
                rel="noreferrer"
                className="text-[#64748b] hover:underline"
              >
                +44 7505 014078
              </a>
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
