import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { reportBridgeFailure } from '@/lib/workstation/use-outlook-bridge';
import { PaneMenu } from './pane-menu';
import { Section } from './pane-ui';
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
import { combinedDocumentRequest, downloadStaffQuoteWorkbook } from '@/lib/quote-workflow/quote-workbook-download';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { QuoteWorkflowPanel } from '@/components/quote-workflow/quote-workflow-panel';
import { savedRatesFromTrpc } from '@/components/quote-workflow/rate-controls';
import {
  fixtureReplyHtml,
  loadQuoteFixture,
  pickFixtureForSession,
} from '@/lib/quote-workflow/fixtures';
import { isQuoteFixturePreview } from '@/lib/quote-workflow/preview';
import type { CombinedReplyEdit } from '@/lib/quote-workflow/multi-option-draft';
import type { QuoteSessionAction } from '@/lib/quote-workflow/types';
import {
  bindAnalyseSelection,
  quoteWorkflowFromTrpc,
} from '@/lib/quote-workflow/backend-bind';
import { storedDecision, useStoredWork } from '@/lib/quote-workflow/use-work-item';
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
  type UsePriorQuoteForBookingReady,
} from '@/lib/quote-workflow/booking-draft-bind';
import { paneStayFromTrpc, readPaneSaveFlag } from '@/lib/quote-workflow/pane-stay-bind';
import { partyFinderFromTrpc, partyIndexFromTrpc } from '@/lib/quote-workflow/party-lookup';
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
  DRAFT_GROUP_ID,
  canCreatePdf,
  canRunQuoteStep,
  dinnerAllowanceStillRequired,
  evidenceMatchesSession,
  groupsForQuoteStep,
  isMultiStay,
  quoteRunIsCurrent,
  requestedQuoteKeys,
  stayKeyForGroup,
  hasStaffStayEdits,
  initialQuoteSession,
  nextSelectedOfferIds,
  pickNextRunnableStep,
  quoteRunBlockReason,
  reduceQuoteSession,
  removedStayFor,
  rowsTakeOnceExtras,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import { useActiveConnection } from '@/hooks/use-connections';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { toast } from 'sonner';
import { WelcomeScreen } from './screens/welcome';
import { DiagnosticsScreen } from './screens/diagnostics';
import { TourScreen } from './screens/tour';
import { NeedsYouEntry, NeedsYouView } from './screens/needs-you';
import { SelectedEmailBlock } from './blocks/selected-email';
import { ContactBlock } from './blocks/contact-block';
import { TranslationBox } from './blocks/translation-box';
import { BookingVoucherCard } from './blocks/booking-voucher-card';
import { FollowUpCard } from './blocks/follow-up-card';
import { DraftPreviewBlock } from './blocks/draft-preview';
import { SystemCheckResultsBlock } from './blocks/system-check-results';
import { ReplyBody } from './reply-body';
import { useInsertAiDraft } from './use-insert-ai-draft';
import { useSavedReply } from './use-saved-reply';
import { useSystemCheck } from './use-system-check';

type PaneScreen = 'welcome' | 'diagnostics' | 'tour' | 'tool' | 'needs-you';

// One client for the pane's life, so screenshot loaders keep their identity across renders.
const PANE_STAY_CLIENT = paneStayFromTrpc(trpcClient);
// One HMS party search for the quote header's Find in HMS picker. Null when the panePartyLookup route is missing.
const PANE_PARTY_FINDER = partyFinderFromTrpc(trpcClient);
// The same picker's typeahead: the HMS list and the listed parties, as staff type. Null when the route is missing.
const PANE_PARTY_INDEX = partyIndexFromTrpc(trpcClient);
// The saved rates for each row's price (R7). Null when the rates route is missing, so only one-off and override show.
const PANE_SAVED_RATES = savedRatesFromTrpc(trpcClient);

/**
 * Pane body. The route calls useOutlookBridge() once and passes the result in as `bridge`.
 * `preview` (the /nava-preview viewer) starts on the quoting tool, skipping the welcome, connection
 * and tour screens and their automatic ping. Analysis does not wait on the ping. Outlook passes nothing.
 */
export function NavaPane({
  bridge,
  preview = false,
  onOpenThread,
}: {
  bridge: PaneBridge;
  preview?: boolean;
  /** Webmail only: opens a Needs-you row's thread in the webmail. Outlook passes nothing. */
  onOpenThread?: (threadId: string) => void;
}) {
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
  const previousScope = useRef(currentScope);
  const detectedEmail = activeConnection?.email || 'Select an authorized mailbox';
  const {
    trackedDraft,
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
  const savedReplyThreadId = preview ? null : (quoteSession.staffSource?.threadId ?? null);
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
  // The stored read for the selected mail. A ready or failed read stands in for the live read. A treat-as or a staff
  // note asks for a fresh read, so the stored read is not used then, and it does not re-trigger the effect below.
  const storedWork = useStoredWork({
    trpc: trpcClient,
    internetMessageId: activeEmail?.internetMessageId ?? null,
    scope: currentScope,
  });
  const storedOverridden = Boolean(quoteSession.treatAs || quoteSession.staffNote);
  /** A staff edit to the stay rows. On a stored read it is logged against the work item, so it is there on reopen. */
  const editStayRows = (action: QuoteSessionAction) => {
    const before = quoteSessionRef.current;
    dispatchQuote(action);
    storedWork.recordGroups(before.groups, reduceQuoteSession(before, action).groups);
  };
  // With a treat-as or note the read is live, so only Retry read (its count) re-runs it, not a stored-read change.
  const storedGate = storedOverridden ? `override|${storedWork.retryCount}` : storedWork.key;
  useEffect(() => {
    const binding = quoteSession.binding;
    if (!binding || !quoteAdmissionKey) return;
    // The binding follows the selected mail one render later. Until then it names the previous mail.
    if ((binding.internetMessageId ?? null) !== (activeEmail?.internetMessageId ?? null)) return;
    dispatchQuote({ type: 'analysis_started' });
    const workflow = quoteWorkflowFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    const decision = storedDecision(storedWork.pane, storedOverridden);
    if (decision.kind === 'ready') {
      const ready = { type: 'analysis_ready', analysis: decision.analysis } as const;
      const before = reduceQuoteSession(quoteSessionRef.current, { type: 'analysis_started' });
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
          error instanceof Error && error.message.trim() ? error.message : 'Nava could not read this email. Select it again and try again.';
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
  }, [quoteAnalysisRetryKey, storedGate]);

  const priorQuoteKey = [
    quoteSession.analysis?.luna?.workflow ?? '',
    quoteSession.staffSource?.threadId ?? '',
    String(quoteSession.inputRevision),
    String(quoteSession.binding?.selectionEpoch ?? 0),
    quoteSession.groups
      .map((group) => `${group.arrivalDate ?? ''}:${group.departureDate ?? ''}:${group.quantity ?? ''}:${group.adults ?? ''}`)
      .join(','),
    quoteSession.staffQuote ? 'quoted' : '',
    Object.keys(quoteSession.staffQuotes).join(','),
    Object.keys(quoteSession.bookingDrafts).join(','),
  ].join(':');
  useEffect(() => {
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
    if (luna?.workflow !== 'create_booking' || !source || !binding || waiting.length === 0) {
      return;
    }
    const staff = staffQuoteFromTrpc(trpcClient);
    const selectionEpoch = binding.selectionEpoch;
    const inputRevision = quoteSession.inputRevision;
    // A stay edit does not always move inputRevision, so the result is also tied to the rows it read.
    const stayRevision = quoteSession.stayRevision;
    const header = quoteSession.staffHeader;
    // The earlier quote's run and draft belong to the stay it was made for, so its rows are that stay's rows.
    const bindPrior = (prior: UsePriorQuoteForBookingReady, stayKey: string) => {
      const stayRow = quoteSession.groups.find((group) => stayKeyForGroup(group) === stayKey);
      const groupId = stayRow?.id;
      const quantity = stayRow?.quantity;
      dispatchQuote({
        type: 'staff_quote_ready',
        offer: {
          id: prior.revisionRef,
          kind: 'allocation',
          roomCode: prior.roomCode,
          roomLabel: 'Selected allocation',
          board: offerBoardFromRevision(prior.board),
          rateCode: prior.rateCode,
          currency: 'ZAR',
          nightly: [],
          stayTotalMinor: prior.totalMinor,
          observedAt: '',
          sourceRef: prior.revisionRef,
          restrictions: [],
          combinable: true,
          quoteRequestKey: stayKey,
          coversGroupIds: groupId ? [groupId] : [],
          quantity,
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
    };
    let cancelled = false;
    void bindListThreadQuoteRevisions({
      query: staff.workstation.listThreadQuoteRevisions?.query,
      threadId: source.threadId,
    }).then(async (revisions) => {
      if (cancelled || !revisions[0]) return;
      const reasons: string[] = [];
      let expiredPrior: PriorStaffQuoteRequoteRow | null = null;
      const unbound = new Set(waiting);
      for (const row of revisions) {
        if (cancelled || unbound.size === 0) break;
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
        if (cancelled) return;
        if (candidate.status !== 'ok') {
          reasons.push(candidate.reason);
          if (candidate.reason === 'expired' && !expiredPrior) {
            expiredPrior = { workflowRunId: row.workflowRunId, revisionRef: row.revisionRef };
          }
          continue;
        }
        // A candidate binds only to a stay that is still waiting for one. Other rows of that stay are skipped.
        const stayKey = singleStayKey ?? `${candidate.payload.arrivalDate}:${candidate.payload.departureDate}`;
        if (!unbound.has(stayKey)) continue;
        unbound.delete(stayKey);
        bindPrior(candidate.payload, stayKey);
      }
      if (cancelled) return;
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
    });
    return () => {
      cancelled = true;
    };
  }, [priorQuoteKey]);

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
  // Bumped when the list closes, so the entry remounts and its count takes in any dismiss made on the list.
  const [needsYouVisit, setNeedsYouVisit] = useState(0);
  const [tourSlideIndex, setTourSlideIndex] = useState(0);
  const [pingState, setPingState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [serverPingTimeStr, setServerPingTimeStr] = useState<string | null>(null);
  const [pingErrorMessage, setPingErrorMessage] = useState<string | null>(null);

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

  // Unfinished Tell Nava text lives here, so it survives a trip off the tool screen (the ⋯ menu's
  // Check connection). The sent text is kept, so a note that was already re-read does not block reloads.
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
  // The combined quote for every stay. A second click while it is being made does nothing.
  const pdfInFlight = useRef(false);
  const downloadWorkbook = () => {
    if (workbookInFlight.current) return;
    workbookInFlight.current = true;
    setWorkbookPending(true);
    void downloadStaffQuoteWorkbook({
      session: quoteSessionRef.current,
      mutate: staffQuoteFromTrpc(trpcClient).workstation.quoteWorkbook?.mutate,
      notify: (message) => toast.warning(message),
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
      if (!groups.length) {
        toast.warning('The stays changed since this quote. Run the search for that stay again.');
        return;
      }
      const run = bindExecuteStaffQuote({
        mutate: staff.workstation.executeStaffQuote?.mutate,
        source,
        selectionEpoch,
        inputRevision,
        groups,
        header,
        onceExtras: rowsTakeOnceExtras(session, requestedQuoteKeys(groups)),
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
  const insertSavedReply = async () => {
    const threadId = savedReplyThreadId;
    let current: Awaited<ReturnType<typeof savedReply.readCurrent>>;
    try {
      current = await savedReply.readCurrent();
    } catch {
      toast.error('Could not read the saved reply. Try again.');
      return;
    }
    // The reply belongs to the thread it was read for. Staff may have moved to another email meanwhile.
    if (quoteSessionRef.current.staffSource?.threadId !== threadId) return;
    if (!current) {
      toast.warning('This thread has no saved reply any more. Save it again in webmail.');
      return;
    }
    trackedDraft('saved', current);
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
    const stayRevision = quoteSession.stayRevision;
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
      // A combined quote charges the shuttle and flat "other" charges once, on its first stay.
      onceExtras: rowsTakeOnceExtras(quoteSession, requestedQuoteKeys(stayGroups)),
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
                if (!quoteRunIsCurrent(quoteSessionRef.current, { selectionEpoch, inputRevision, stayRevision })) {
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
    if (isMultiStay(session)) {
      // One combined document for every stay. Until each stay is rated, the request says how many are.
      const request = combinedDocumentRequest(session);
      if (request.status === 'unavailable') {
        toast.warning(request.reason);
        return;
      }
      if (pdfInFlight.current) return;
      pdfInFlight.current = true;
      const selectionEpoch = session.binding?.selectionEpoch ?? 0;
      const inputRevision = session.inputRevision;
      // The combined PDF is bound to the stays' runs, not to the selected option, so selecting another option while it
      // builds keeps it.
      const selectedOfferIds = [
        request.input.revisionRef,
        ...(request.input.additionalStays ?? []).map((stay) => stay.revisionRef),
      ];
      const staff = staffQuoteFromTrpc(trpcClient);
      void bindQualifiedStaffProposalPdf({
        mutate: staff.workstation.qualifiedQuoteProposalPdf?.mutate,
        input: request.input,
        expectedTotalMinor: request.expectedTotalMinor,
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
      }).finally(() => {
        pdfInFlight.current = false;
      });
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

  // Only quote and booking mail gets Nava's suggestions and the numbered reply step. Other mail gets neither.
  const quoteOrBookingEmail = quoteSession.analysis?.intent === 'quote';
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
      onInsertSaved={savedReply.available ? () => void insertSavedReply() : null}
      preview={preview}
    />
  );

  return (
    <div
      onKeyDownCapture={markInput}
      onInputCapture={markInput}
      onPointerDownCapture={markInput}
      className="flex h-screen w-full justify-center overflow-hidden bg-[#f1f3f6] font-['Segoe_UI',system-ui,sans-serif] text-sm"
    >
      {/* Fills the Outlook pane height, so the body below scrolls with a visible bar; never narrower than 320px. */}
      <div className="shadow-xs relative flex h-full w-full min-w-[320px] flex-col border-x border-[#cbd5e1] bg-white text-[#1e293b]">
        {/* Outlook 2016 Header */}
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#e2e8f0] bg-white px-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-[3px] bg-[#1a4332] text-[11px] font-extrabold text-white">
              N
            </span>
            <div>
              <h1 className="text-[13px] font-bold text-[#1e293b]">Nava Reservationist</h1>
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
        {pendingBuild !== null && (
          <div role="status" className="m-3 mb-0 rounded-sm border border-sky-300 bg-sky-50 p-2.5 text-xs text-sky-800">
            <p>New version available — it will load when you open the next email.</p>
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
            detectedProperty={detectedProperty}
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
          <NeedsYouView
            trpc={trpcClient}
            host={preview ? 'web' : 'outlook'}
            onBack={() => {
              setNeedsYouVisit((visit) => visit + 1);
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
            {/* The open count from the Needs-you list. Shows "Needs you" alone until the list has loaded. */}
            <div className="flex justify-end">
              <NeedsYouEntry
                key={needsYouVisit}
                trpc={trpcClient}
                onOpen={() => setCurrentScreen('needs-you')}
              />
            </div>

            {/* Email context for the selected email; until one is selected, an empty state. */}
            <SelectedEmailBlock activeEmail={activeEmail} />

            {/* Contact block (U16): the core details, pre-filled. Then the translation, only for mail not in English. */}
            {activeEmail ? (
              <ContactBlock
                key={`${activeEmail.internetMessageId ?? ''}|${storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : ''}`}
                contact={storedWork.pane.state === 'ready' ? storedWork.pane.contact : null}
                onEdit={storedWork.recordContact}
              />
            ) : null}
            {storedWork.pane.state === 'ready' ? (
              <TranslationBox
                key={storedWork.pane.workItemId}
                language={storedWork.pane.language}
                translation={storedWork.pane.translation}
                busy={storedWork.translationBusy}
                onRetry={storedWork.retryTranslation}
              />
            ) : null}

            {/* The quote follow-up on this thread, when the server holds one (R10). Keyed by the email, like the voucher card. */}
            <FollowUpCard
              key={activeEmail?.internetMessageId ?? 'no-email'}
              bridge={bridge}
              preview={preview}
              trpc={trpcClient}
            />

            {/* Booking and voucher block: a change or cancellation card, then the Find the booking card. */}
            <BookingVoucherCard
              session={quoteSession}
              internetMessageId={activeEmail?.internetMessageId ?? null}
              syncCommitted={sync.status?.committed ?? null}
              syncPending={
                sync.status
                  ? sync.status.discovered > sync.status.committed && !sync.status.userPaused
                  : false
              }
              workItemId={storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : null}
              writesEnabled={paneSaveOn}
            />

            {storedWork.saveFailed ? (
              <p role="status" className="flex items-center gap-2 px-1 text-[11px] text-[#b45309]">
                Couldn&apos;t save change.
                <button type="button" className="font-semibold underline" onClick={storedWork.retrySave}>
                  Retry
                </button>
              </p>
            ) : null}

            {activeEmail && !quoteSession.staffQuote && quoteOrBookingEmail ? (
              <p className="px-1 text-[11px] text-[#64748b]">
                Nava filled these in from the email. Check them before getting rates.
              </p>
            ) : null}

            {/* HOOK(#79, #84; not on main): their picker props are added in StaffHeaderFields, quote-workflow-panel.tsx. */}
            <QuoteWorkflowPanel
              session={quoteSession}
              paneSave={paneSaveOn ? PANE_STAY_CLIENT : null}
              findParty={PANE_PARTY_FINDER}
              partyIndex={PANE_PARTY_INDEX}
              rates={PANE_SAVED_RATES}
              onPatchGroup={(groupId, patch) => editStayRows({ type: 'patch_group', groupId, patch })}
              // Shown only on a failed-read item, which stays listed after she starts typing in the form.
              onRetryRead={storedWork.retry}
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
              onReplyChange={(html) => dispatchQuote({ type: 'set_reviewed_reply', html })}
              onHandleReviewItem={(itemId) => dispatchQuote({ type: 'handle_review_item', itemId })}
              onUndoReviewItem={(itemId) => dispatchQuote({ type: 'unhandle_review_item', itemId })}
              onPatchStaffHeader={(header) => dispatchQuote({ type: 'patch_staff_header', header })}
              onSelectStayKey={(stayKey) => dispatchQuote({ type: 'select_stay_key', stayKey })}
              onTreatAs={(treatAs) => dispatchQuote({ type: 'treat_as', treatAs })}
              onStaffNote={(staffNote) => {
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
            />

            {/* Step 4: the reply. Quote and booking mail shows it as the numbered step; other mail keeps a plain button. */}
            {quoteOrBookingEmail ? (
              <Section step={4} title="Reply">
                {replyBody}
              </Section>
            ) : (
              <div className="flex flex-col gap-2.5">{replyBody}</div>
            )}

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
  );
}
