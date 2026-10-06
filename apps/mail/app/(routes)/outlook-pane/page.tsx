import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Send,
  ChevronLeft,
  ChevronRight,
  Moon,
  Plus,
  Minus,
  Search,
  X,
  Mail,
  Check,
  SlidersHorizontal,
  ChevronDown,
  Building2,
  Network,
  Sparkles,
  ArrowRight,
  Clock,
} from 'lucide-react';
import { createOperationId, type MailLocation, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { canCreatePaneProposal, type PaneProposalSelection } from '@/lib/quote-proposal/admission';
import { quoteWrapperHtml } from '@/lib/quote-proposal/copy';

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
import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useActiveConnection } from '@/hooks/use-connections';
import { OutlookPaneSignIn } from './outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { toast } from 'sonner';
import { useQueryState } from 'nuqs';
import { EmailComposer } from '@/components/create/email-composer';
import { ReservationistDraftCard } from '@/components/mail/reservationist-draft-card';
import { useDraftArtifactHydration } from '@/hooks/use-drafts';
import { buildThreadDraftViewModel } from '@/lib/mail/thread-draft-view-model';
type PaneDraft = Awaited<ReturnType<typeof trpcClient.drafts.get.query>>;

/** Existing draft ownership, artifact hydration and editor; native sends stay separate. */
function PaneSavedReply({draft,messageId,threadId}:{draft:PaneDraft;messageId:string;threadId:string}) {
  const [draftId,setDraftId]=useQueryState('draftId');
  const [queryThreadId,setQueryThreadId]=useQueryState('threadId');
  const [editable,setEditable]=useState<PaneDraft|null>(null);
  const [status,setStatus]=useState('');
  const [opening,setOpening]=useState(false);
  const live=useRef(true),owned=useRef<{draftId:string;threadId:string}|null>(null);
  const queryIdentity=useRef({draftId,threadId:queryThreadId});queryIdentity.current={draftId,threadId:queryThreadId};
  const hydrated=useDraftArtifactHydration(editable??draft);
  const model=buildThreadDraftViewModel(draft);
  const clearOwned=()=>{const value=owned.current;if(!value)return;owned.current=null;if(queryIdentity.current.draftId&&queryIdentity.current.draftId!==value.draftId)return;void setDraftId(current=>current===value.draftId?null:current);void setQueryThreadId(current=>current===value.threadId?null:current);};
  useEffect(()=>{live.current=true;return()=>{live.current=false;clearOwned();};},[]);
  const open=async()=>{
    if(opening)return;
    if(draftId&&draftId!==owned.current?.draftId||queryThreadId&&queryThreadId!==threadId){setStatus('Another draft is already open. Close it before reviewing this reply.');return;}
    if((draft.attachments??[]).length!==hydrated.entries.length||hydrated.entries.some(a=>a.state!=='available')){setStatus('Review attachments after their original bytes have been verified.');return;}
    setOpening(true);setStatus('');
    try{
      const promoted=await trpcClient.drafts.ensureEditableForReply.mutate({threadId,replyToMessageId:messageId});
      if(!live.current)return;
      if(promoted.threadId!==threadId||promoted.replyToMessageId!==messageId||promoted.status!=='active')throw Error('editable_reply_identity_changed');
      const current=await trpcClient.drafts.get.query({id:promoted.id});
      if(!live.current)return;
      if(current.threadId!==threadId||current.replyToMessageId!==messageId||current.status!=='active')throw Error('editable_reply_identity_changed');
      if(queryIdentity.current.draftId&&queryIdentity.current.draftId!==owned.current?.draftId||queryIdentity.current.threadId&&queryIdentity.current.threadId!==threadId)throw Error('another_editor_opened');
      owned.current={draftId:current.id,threadId};
      await setQueryThreadId(threadId);if(!live.current){clearOwned();return;}
      await setDraftId(current.id);if(!live.current){clearOwned();return;}
      setEditable(current);
    }catch{if(live.current)setStatus('Unable to open this saved draft. Refresh quote evidence and review the current reply before editing.');}
    finally{if(live.current)setOpening(false);}
  };
  return <section aria-label="Saved reply draft">
    {model&&<ReservationistDraftCard {...model} draftId={draft.id} savedAtLabel="Saved draft" draftBadge="Staff review" unsentNotice="Unsent" emptyPreviewLabel="Empty draft" editLabel={opening?'Opening saved draft…':'Review saved draft'} deleteLabel="Delete" moreLabel="More" isReadOnly onEdit={editable?undefined:open}/>}
    {status&&<p role="status">{status}</p>}
    {editable&&draftId===editable.id&&queryThreadId===threadId&&(hydrated.entries.length===editable.attachments.length&&hydrated.entries.every(a=>a.state==='available')?<EmailComposer key={editable.id} initialTo={editable.to} initialCc={editable.cc} initialBcc={editable.bcc} initialSubject={editable.subject??''} initialMessage={editable.content??''} initialAttachments={hydrated.files} hydratedAttachmentSnapshot={{key:hydrated.snapshotKey,files:hydrated.files}} syncReplyHeadersFromProps replyToMessageId={messageId} onClose={()=>{setEditable(null);clearOwned();}} onSendEmail={async()=>{toast.warning('Review and save this local draft. Send manually in Outlook.');return false;}} sendButtonLabel="Send manually in Outlook"/>:<p role="status">Verifying saved draft attachments before editing.</p>)}
  </section>;
}

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

type PendingReplyOperation = {
  operationId: string;
  startedAt: number;
  pdf?: { fileName: string; pdfBase64: string };
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
  attachmentPayload?: {
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    fileName: string;
    base64Data: string;
  };
};

type RatePlan = {
  code: string;
  name: string;
  subtext: string;
  singleNightly: number;
  twinNightly: number;
  avgNightly: number;
  mealPlanText: string;
  restricted?: boolean;
  restrictionReason?: string;
};

const RATE_TABLE: Record<string, RatePlan> = {
  NCOR: {
    code: 'NCOR1B',
    name: 'NCOR1B: Corporate Negotiated',
    subtext: 'CIDB Corporate Agreement · 2x EXKNG, 7x STWN',
    singleNightly: 2150.0,
    twinNightly: 2480.0,
    avgNightly: 2150.0,
    mealPlanText: 'Bed & Breakfast (CIDB Agreement)',
  },
  BAR: {
    code: 'BAR',
    name: 'BAR: Best Available Rate',
    subtext: 'Bed & Breakfast Included · Standard Rate',
    singleNightly: 2700.0,
    twinNightly: 2850.0,
    avgNightly: 2700.0,
    mealPlanText: 'Bed & Breakfast Included',
  },
  BARRO: {
    code: 'BARRO',
    name: 'BARRO: BAR Room Only',
    subtext: 'Room Only · No Meals Included',
    singleNightly: 2430.0,
    twinNightly: 2580.0,
    avgNightly: 2430.0,
    mealPlanText: 'Room Only (No Meals)',
  },
  BWKPB: {
    code: 'BWKPB',
    name: 'BWKPB: Weekend Promo Rate',
    subtext: 'Weekend promo rate only',
    singleNightly: 2430.0,
    twinNightly: 2430.0,
    avgNightly: 2430.0,
    mealPlanText: 'Room Only',
    restricted: true,
    restrictionReason: 'Closed to Arrival (Weekday)',
  },
};

export default function OutlookPanePage() {
  const {
    isConnected,
    activeEmail,
    workstationInfo,
    capabilities,
    updateRequired,
    requiresRelogin,
    authorizationUnavailable,
    supportsAction,
    sendCommand,
    pairDevice,
    refreshAuthorization,
  } = useOutlookBridge();
  const replyRetries = useRef(new Map<string, PendingReplyOperation>());
  const expiredReplyOutcomes = useRef(new Set<string>());
  const hasUntrackedExpiredReplyOutcomes = useRef(false);
  const expiredOutcomeConfirmationKey = useRef<string | null>(null);
  const unresolvedReplyConfirmationKey = useRef<string | null>(null);
  const replyMarkerBelongsToCurrentScope = useRef(false);
  const replyInFlight = useRef(false);
  const [isDraftPending, setIsDraftPending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<{ key: string; message: string } | null>(null);
  const selectedKey = activeEmail?.entryId
    ? `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`
    : null;
  const { data: session, isLoading } = useSession();
  const { data: activeConnection, isLoading: transportLoading } = useActiveConnection();
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

  // Quote Tool State
  const [propertyCode, setPropertyCode] = useState('HRCEN');
  const [arrivalDay, setArrivalDay] = useState(15);
  const [departureDay, setDepartureDay] = useState(17);
  const [nightsCount, setNightsCount] = useState(2);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [activeDateTab, setActiveDateTab] = useState<'arrival' | 'departure'>('arrival');
  const [mealPlan, setMealPlan] = useState('breakfast');
  const [salesStrategy, setSalesStrategy] = useState('Negotiated Contracted');
  const [singleRoomsCount, setSingleRoomsCount] = useState(2);
  const [twinRoomsCount, setTwinRoomsCount] = useState(7);
  const [orgAccount, setOrgAccount] = useState('CIDB');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [isSearching] = useState(false);
  const [hasSearched] = useState(true);
  const [selectedRateCode, setSelectedRateCode] = useState('NCOR');
  const [proofTab] = useState<'results' | 'criteria'>('results');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draftedDetails, setDraftedDetails] = useState<{
    entryId: string;
    subject: string;
    sender: string;
    senderEmail: string;
    agreementText: string;
    mealText: string;
    hotelName: string;
    hotelTeam: string;
  } | null>(null);

  const showDraftPreview = Boolean(
    draftedDetails && activeEmail?.entryId && draftedDetails.entryId === activeEmail.entryId,
  );

  // Automatically sync detected corporate account or room parameters when active email changes
  useEffect(() => {
    if (!activeEmail) return;
    const text = `${activeEmail.subject || ''} ${activeEmail.bodyText || ''}`;
    const orgMatch = text.match(/\b(CIDB|SARS|Gauteng|Eskom|Standard Bank|Nedbank)\b/i);
    setOrgAccount(orgMatch ? orgMatch[1].toUpperCase() : '');
  }, [activeEmail?.entryId, activeEmail?.subject, activeEmail?.bodyText]);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [proposalChoices,setProposalChoices]=useState<PaneProposalSelection[]>([]);
  const [selectedProposal,setSelectedProposal]=useState<PaneProposalSelection|null>(null);
  const [proposalThreadId,setProposalThreadId]=useState<string|null>(null);
  const [proposalReadStatus,setProposalReadStatus]=useState('Select a synced email and load its qualified proposals.');
  const [savedReply,setSavedReply]=useState<{draft:PaneDraft;messageId:string;threadId:string;key:string}|null>(null);
  const [savedReplyStatus,setSavedReplyStatus]=useState('');
  const savedReplyRead=useRef(0);
  useEffect(()=>{savedReplyRead.current++;setSavedReply(null);setSavedReplyStatus('');},[selectedIdentity,currentScope]);
  useEffect(()=>{setProposalChoices([]);setSelectedProposal(null);},[activeEmail?.entryId,currentScope]);

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
      toast.success('System Verification Complete!');
    } catch (err) {
      setTestResults(results);
      toast.error(`Verification error: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setTesting(false);
    }
  };

  const handleDayClick = (day: number) => {
    if (activeDateTab === 'arrival') {
      const newArrival = Math.max(1, Math.min(29, day));
      const newDeparture =
        departureDay <= newArrival ? Math.min(30, newArrival + 1) : Math.min(30, departureDay);
      setArrivalDay(newArrival);
      setDepartureDay(newDeparture);
      setNightsCount(newDeparture - newArrival);
    } else {
      const newDeparture = Math.max(2, Math.min(30, day));
      const newArrival =
        arrivalDay >= newDeparture ? Math.max(1, newDeparture - 1) : Math.max(1, arrivalDay);
      setArrivalDay(newArrival);
      setDepartureDay(newDeparture);
      setNightsCount(newDeparture - newArrival);
    }
  };

  const handleQuickNights = (n: number) => {
    const newDeparture = Math.min(30, arrivalDay + n);
    if (newDeparture - arrivalDay < n) {
      const newArrival = Math.max(1, 30 - n);
      setArrivalDay(newArrival);
      setDepartureDay(30);
      setNightsCount(30 - newArrival);
    } else {
      setDepartureDay(newDeparture);
      setNightsCount(n);
    }
  };

  const loadQualifiedProposals=async()=>{
    if(!activeEmail?.internetMessageId){setProposalReadStatus('The selected email has no message identity. Refresh the Outlook selection.');return;}
    const epoch=contextRevision.current.selectionEpoch,scopeEpoch=contextRevision.current.scopeEpoch,scope=currentScope;
    try{const result=await trpcClient.workstation.qualifiedProposalChoices.query({internetMessageId:activeEmail.internetMessageId});
      if(scopeRef.current!==scope||contextRevision.current.selectionEpoch!==epoch||contextRevision.current.scopeEpoch!==scopeEpoch)return;
      setProposalChoices(result.choices);setSelectedProposal(null);setProposalThreadId(result.threadId??null);
      setProposalReadStatus(result.status==='ready'?'Choose the offer to attach.':result.status==='message_not_synced'?'This email has not synced to the mailbox yet.':'No qualified quote is available yet. Refresh the quote read from this email.');
    }catch{setProposalReadStatus('Unable to load authorized quote evidence.');}
  };
  const loadSavedReply=async()=>{
    if(!activeEmail?.internetMessageId||!currentScope){setSavedReplyStatus('Select an authorized synced email before loading its draft.');return;}
    const operation=++savedReplyRead.current,context={...contextRevision.current},scope=currentScope;
    const current=()=>savedReplyRead.current===operation&&scopeRef.current===scope&&contextRevision.current.scopeEpoch===context.scopeEpoch&&contextRevision.current.selectionEpoch===context.selectionEpoch;
    try{
      const selected=await trpcClient.workstation.qualifiedProposalChoices.query({internetMessageId:activeEmail.internetMessageId});
      if(!current())return;
      if(!selected.threadId||!('messageId' in selected)||!selected.messageId){setSavedReplyStatus('This email has not synced to the authorized mailbox yet.');return;}
      const drafts=await trpcClient.drafts.list.query({threadId:selected.threadId,limit:20});if(!current())return;
      const candidate=drafts.threads.find(d=>d.threadId===selected.threadId&&d.replyToMessageId===selected.messageId&&(d.status==='active'||d.status==='candidate'));
      if(!candidate){setSavedReplyStatus('No saved reply draft is available for this email.');return;}
      const draft=await trpcClient.drafts.get.query({id:candidate.id});if(!current())return;
      if(draft.threadId!==selected.threadId||draft.replyToMessageId!==selected.messageId||!['active','candidate'].includes(draft.status))throw Error('saved_reply_identity_changed');
      setSavedReply({draft,messageId:selected.messageId,threadId:selected.threadId,key:`${scope}:${context.selectionEpoch}:${draft.id}`});setSavedReplyStatus('');
    }catch{if(current())setSavedReplyStatus('Unable to load the authorized saved draft.');}
  };
  const refreshNativeQuote=async()=>{
    if(!proposalThreadId){await loadQualifiedProposals();return;}
    try{await trpcClient.ai.enqueueHmsRead.mutate({threadId:proposalThreadId,toolId:'hms_quote_stay',detail:'detail'});setProposalReadStatus('Quote read queued. Load qualified proposals after it completes.');}catch{setProposalReadStatus('The quote read is unavailable or the selected email lacks a qualified stay request.');}
  };
  const handleExecuteSearch = () => {
    toast.warning('Demo availability and rates are not verified. Proposals unavailable until evidence-backed inputs are ready.');
  };

  const activePlan = RATE_TABLE[selectedRateCode] || RATE_TABLE.NCOR;
  const totalGuests = singleRoomsCount * 1 + twinRoomsCount * 2;

  const currentSubject = activeEmail?.subject || 'Suite Availability Request';
  const currentSender = activeEmail?.senderName || 'David Miller';
  const currentSenderEmail = activeEmail?.senderEmail || 'guest@example.com';

  const handleInsertAiDraft = async () => {
    if (!canCreatePaneProposal(selectedProposal)) {
      toast.error('Proposals unavailable until evidence-backed inputs are ready.');
      return;
    }
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
          `${replyLabel}The safe retry window has expired. Check Outlook Drafts before starting a new operation.`,
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
          `${replyLabel}The pane has more expired reply outcomes than it can safely track individually. Check Outlook Drafts before starting a new operation. Click again after checking to proceed.`,
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
          `${replyLabel}An earlier Outlook draft may have completed before the pane changed. Check Outlook Drafts; click again after checking to start a new draft.`,
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
        `${replyLabel}Too many replies have unresolved outcomes. Check Outlook Drafts before refreshing the pane or starting another reply.`,
      );
      return;
    }

    if (activePlan.restricted) {
      toast.error(
        `Cannot insert draft: ${activePlan.name} is restricted (${activePlan.restrictionReason}).`,
      );
      return;
    }

    if (!startedScope || transportLoading || !activeConnection?.email) {
      toast.error('Sign in and select an authorized mailbox before attaching a quotation.');
      return;
    }
    if (!activeEmail.storeId || !activeEmail.folderEntryId) {
      toast.error(
        'Outlook did not provide the selected message and source folder. Select it again.',
      );
      return;
    }

    if (!supportsAction('ADD_ATTACHMENT_TO_DRAFT')) {
      toast.error('This Outlook add-in cannot attach a quotation PDF. Update to protocol v4.');
      return;
    }

    replyInFlight.current = true;
    setIsDraftPending(true);
    setDraftStatus(null);
    const attempt = previousAttempt ?? { operationId: createOperationId(), startedAt: now };
    replyRetries.current.set(key, attempt);

    const guestFirstName = (currentSender.split(' ')[0] || 'Guest').trim();
    const quotationHtml = quoteWrapperHtml(guestFirstName);
    let draftCreated = false;

    try {
      if(!selectedProposal)throw new Error('Choose a qualified offer before attaching a proposal.');
      const pdfInput={workflowRunId:selectedProposal.workflowRunId,messageId:selectedProposal.messageId,revisionRef:selectedProposal.revisionRef,factRefs:selectedProposal.factRefs,outlookEmail:activeConnection.email,attention:currentSender,company:'',clientEmail:currentSenderEmail,clientTelephone:'',agency:'Quote'};
      const pdf=attempt.pdf??(selectedProposal.kind&&selectedProposal.kind!=='native'?await trpcClient.workstation.sourceQuoteProposalPdf.mutate({...pdfInput,kind:selectedProposal.kind}):await trpcClient.workstation.qualifiedQuoteProposalPdf.mutate(pdfInput));
      if (!sameStaffScope() || contextRevision.current.selectionEpoch !== startedSelectionEpoch) {
        // No new Outlook command has started for this click. A delayed quotation
        // cannot create or retry a reply for a selection that changed away
        // and back, even when its current EntryID and session string match.
        if (sameStaffScope() && !attempt.replyPayload) replyRetries.current.delete(key);
        return;
      }
      attempt.pdf = pdf;
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
          toast.error('Selected Outlook email changed while preparing the quotation. Select it again.');
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
      const attachmentPayload = attempt.attachmentPayload ?? {
        operationId: createOperationId(),
        entryId: replyResult.entryId,
        storeId: replyResult.storeId,
        folderEntryId: replyResult.folderEntryId,
        fileName: pdf.fileName,
        base64Data: pdf.pdfBase64,
      };
      attempt.attachmentPayload = attachmentPayload;
      await sendCommand('ADD_ATTACHMENT_TO_DRAFT', attachmentPayload);
      if (!sameStaffScope()) return;
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
        agreementText: selectedProposal.description,
        mealText: 'As stated in the selected offer',
        hotelName: 'The Centurion Hotel',
        hotelTeam: 'Centurion',
      });
      const opened = replyResult.displayed === true;
      const details = [
        replyResult?.composerWarning,
        replyResult?.draftPlacementWarning,
        replyResult?.folderPlacementWarning,
        replyResult?.locationUnverified ? 'Draft location is unverified.' : null,
      ].filter(Boolean);
      const summary = opened
        ? 'Outlook draft opened in composer.'
        : replyResult?.entryId
          ? 'Outlook draft saved but not opened in composer.'
          : 'Outlook accepted the reply request; draft and composer status unconfirmed.';
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
          'Outlook may have completed the operation, but did not confirm it. Check Outlook Drafts before retrying; any retry will reuse the same operation ID and PDF.';
        setDraftStatus({ key, message });
        toast.error(`${replyLabel}${message}`);
      } else {
        toast.error(
          `${replyLabel}Could not insert draft: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    } finally {
      if (sameStaffScope()) {
        replyInFlight.current = false;
        setIsDraftPending(false);
      }
    }
  };

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
            <span>Centurion</span>
            <span className="sr-only">
              {isConnected
                ? `Connected to Classic Outlook (${capabilities?.outlookVersion ?? 'version unavailable'}; product/build unknown)`
                : 'Disconnected'}
            </span>
          </div>
        </header>

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
            <p>Select an approved Outlook folder to continue. Nava will retry automatically.</p>
            <Button type="button" size="sm" onClick={refreshAuthorization}>
              Refresh Outlook authorization
            </Button>
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
            <div className="flex items-center justify-between rounded-sm border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2">
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

            <section><button onClick={loadQualifiedProposals}>Load qualified proposals</button><button onClick={refreshNativeQuote}>Refresh quote evidence</button><p role="note">{proposalReadStatus}</p>{proposalChoices.map(choice=><button key={choice.revisionRef} onClick={()=>setSelectedProposal(choice)} aria-pressed={selectedProposal?.revisionRef===choice.revisionRef}>{choice.arrivalDate} to {choice.departureDate} · {choice.currency} {(choice.totalMinor/100).toFixed(2)} · {choice.description}</button>)}</section>
            <section><button type="button" onClick={loadSavedReply}>Load saved reply draft</button>{savedReplyStatus&&<p role="status">{savedReplyStatus}</p>}{savedReply&&savedReply.key===`${currentScope}:${contextRevision.current.selectionEpoch}:${savedReply.draft.id}`&&<PaneSavedReply key={savedReply.key} draft={savedReply.draft} messageId={savedReply.messageId} threadId={savedReply.threadId}/>}</section>
            <details><summary>Demo layout preview</summary><p>Demo dates and prices cannot create a proposal.</p>
            {/* Search Criteria Card */}
            <div className="shadow-xs overflow-hidden rounded-sm border border-[#e2e8f0] bg-white">
              <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#475569]">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
                  Search Criteria
                </span>
              </div>

              <div className="flex flex-col gap-3 p-3">
                {/* 1. Property */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="propertySelect"
                    className="text-[11.5px] font-semibold text-[#475569]"
                  >
                    Property<span className="ml-0.5 text-rose-600">*</span>
                  </label>
                  <select
                    id="propertySelect"
                    value={propertyCode}
                    onChange={(e) => setPropertyCode(e.target.value)}
                    className="outline-hidden h-8 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
                  >
                    <option value="HRCEN">The Centurion Hotel (HRCEN)</option>
                    <option value="HRBAK" disabled>
                      The Bakubung Bush Lodge (HRBAK — Centurion pilot only)
                    </option>
                    <option value="HRKWA" disabled>
                      Kwa Maritane Bush Lodge (HRKWA — Centurion pilot only)
                    </option>
                  </select>
                </div>

                {/* 2. Dates of Stay */}
                <div className="flex flex-col gap-1">
                  <label className="text-[11.5px] font-semibold text-[#475569]">
                    Dates of Stay<span className="ml-0.5 text-rose-600">*</span>
                  </label>
                  <div className="overflow-hidden rounded-sm border border-[#cbd5e1]">
                    <div className="grid grid-cols-2 border-b border-[#e2e8f0] bg-white">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveDateTab('arrival');
                          setIsCalendarOpen(true);
                        }}
                        className={`flex flex-col gap-0.5 border-r border-[#e2e8f0] p-2 text-left transition-colors ${
                          activeDateTab === 'arrival' && isCalendarOpen
                            ? 'border-b-2 border-b-[#1a4332] bg-[#eaf4ee]'
                            : 'hover:bg-[#f8fafc]'
                        }`}
                      >
                        <span className="text-[9.5px] font-bold uppercase tracking-wider text-[#64748b]">
                          Arrival Date
                        </span>
                        <span className="text-[13px] font-bold text-[#1e293b]">
                          2026-09-{String(arrivalDay).padStart(2, '0')}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveDateTab('departure');
                          setIsCalendarOpen(true);
                        }}
                        className={`flex flex-col gap-0.5 p-2 text-left transition-colors ${
                          activeDateTab === 'departure' && isCalendarOpen
                            ? 'border-b-2 border-b-[#1a4332] bg-[#eaf4ee]'
                            : 'hover:bg-[#f8fafc]'
                        }`}
                      >
                        <span className="text-[9.5px] font-bold uppercase tracking-wider text-[#64748b]">
                          Departure Date
                        </span>
                        <span className="text-[13px] font-bold text-[#1e293b]">
                          2026-09-{String(departureDay).padStart(2, '0')}
                        </span>
                      </button>
                    </div>

                    <div className="flex items-center justify-between bg-[#f8fafc] px-2.5 py-1.5 text-[11.5px] text-[#475569]">
                      <span className="flex items-center gap-1">
                        <Moon className="h-3 w-3 text-slate-500" /> {nightsCount} Nights
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsCalendarOpen(!isCalendarOpen)}
                        className="font-semibold text-[#0066cc] hover:underline"
                      >
                        {isCalendarOpen ? 'Hide Calendar ▲' : 'Change Dates ▼'}
                      </button>
                    </div>

                    {/* In-Pane Calendar Widget */}
                    {isCalendarOpen && (
                      <div className="animate-in fade-in border-t border-[#e2e8f0] bg-white p-2.5 duration-150">
                        <div className="mb-2 flex items-center justify-between">
                          <button
                            type="button"
                            className="flex h-6 w-6 items-center justify-center rounded-sm border border-[#e2e8f0] bg-[#f8fafc] text-slate-600 hover:bg-[#e2e8f0]"
                          >
                            <ChevronLeft className="h-3 w-3" />
                          </button>
                          <span className="text-xs font-bold text-[#1e293b]">September 2026</span>
                          <button
                            type="button"
                            className="flex h-6 w-6 items-center justify-center rounded-sm border border-[#e2e8f0] bg-[#f8fafc] text-slate-600 hover:bg-[#e2e8f0]"
                          >
                            <ChevronRight className="h-3 w-3" />
                          </button>
                        </div>

                        <div className="grid grid-cols-7 gap-0.5 text-center">
                          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((dow) => (
                            <div key={dow} className="pb-1 text-[10px] font-bold text-[#64748b]">
                              {dow}
                            </div>
                          ))}
                          <div className="h-6" /> {/* Blank */}
                          {Array.from({ length: 30 }, (_, i) => i + 1).map((day) => {
                            const isArr = day === arrivalDay;
                            const isDep = day === departureDay;
                            const inStay = day > arrivalDay && day < departureDay;
                            return (
                              <button
                                key={day}
                                type="button"
                                onClick={() => handleDayClick(day)}
                                className={`flex h-6 items-center justify-center rounded-[2px] text-[11px] transition-colors ${
                                  isArr || isDep
                                    ? 'bg-[#1a4332] font-bold text-white'
                                    : inStay
                                      ? 'bg-[#eaf4ee] font-semibold text-[#1a4332]'
                                      : 'text-[#1e293b] hover:bg-slate-100'
                                }`}
                              >
                                {day}
                              </button>
                            );
                          })}
                        </div>

                        <div className="mt-2 flex gap-1 border-t border-[#e2e8f0] pt-2">
                          {[1, 2, 3, 7].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => handleQuickNights(n)}
                              className={`flex-1 rounded-sm border py-1 text-center text-[10.5px] transition-colors ${
                                nightsCount === n
                                  ? 'border-[#1a4332] bg-[#eaf4ee] font-bold text-[#1a4332]'
                                  : 'border-[#e2e8f0] bg-[#f8fafc] text-[#475569] hover:bg-slate-100'
                              }`}
                            >
                              {n} {n === 1 ? 'Night' : 'Nights'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 3. Meal Plan */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="mealPlanSelect"
                    className="text-[11.5px] font-semibold text-[#475569]"
                  >
                    Meal Plan<span className="ml-0.5 text-rose-600">*</span>
                  </label>
                  <select
                    id="mealPlanSelect"
                    value={mealPlan}
                    onChange={(e) => {
                      const next = e.target.value;
                      setMealPlan(next);
                      if (next === 'room_only') setSelectedRateCode('BARRO');
                      else setSelectedRateCode('NCOR');
                    }}
                    className="outline-hidden h-8 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
                  >
                    <option value="breakfast">Bed & Breakfast (BAR)</option>
                    <option value="room_only">Room Only (BARRO)</option>
                    <option value="dinner_bed_breakfast">Dinner, Bed & Breakfast (DBB)</option>
                  </select>
                </div>

                {/* 4. Room Types & Occupancy */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11.5px] font-semibold text-[#475569]">
                    <span>
                      Room Types & Occupancy<span className="ml-0.5 text-rose-600">*</span>
                    </span>
                    <span className="text-[11px] font-normal text-[#64748b]">
                      {totalGuests} Guests Total
                    </span>
                  </div>

                  <div className="overflow-hidden rounded-sm border border-[#cbd5e1]">
                    <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1.5 text-[11px] font-semibold text-[#64748b]">
                      <span>Room Type & Guest Count</span>
                      <span>Rooms</span>
                    </div>

                    <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-white px-2.5 py-2">
                      <div className="flex flex-col">
                        <strong className="text-xs text-[#1e293b]">EXKNG — Executive King</strong>
                        <span className="text-[11px] text-[#64748b]">1 Adult per room</span>
                      </div>
                      <div className="flex items-center rounded-sm border border-[#cbd5e1]">
                        <button
                          type="button"
                          onClick={() => setSingleRoomsCount(Math.max(1, singleRoomsCount - 1))}
                          className="flex h-6 w-6 items-center justify-center bg-[#f8fafc] text-xs font-bold text-slate-700 hover:bg-slate-200"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="w-8 text-center text-xs font-bold text-[#1e293b]">
                          {singleRoomsCount}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSingleRoomsCount(singleRoomsCount + 1)}
                          className="flex h-6 w-6 items-center justify-center bg-[#f8fafc] text-xs font-bold text-slate-700 hover:bg-slate-200"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between bg-white px-2.5 py-2">
                      <div className="flex flex-col">
                        <strong className="text-xs text-[#1e293b]">STWN — Standard Twin</strong>
                        <span className="text-[11px] text-[#64748b]">2 Adults per room</span>
                      </div>
                      <div className="flex items-center rounded-sm border border-[#cbd5e1]">
                        <button
                          type="button"
                          onClick={() => setTwinRoomsCount(Math.max(1, twinRoomsCount - 1))}
                          className="flex h-6 w-6 items-center justify-center bg-[#f8fafc] text-xs font-bold text-slate-700 hover:bg-slate-200"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="w-8 text-center text-xs font-bold text-[#1e293b]">
                          {twinRoomsCount}
                        </span>
                        <button
                          type="button"
                          onClick={() => setTwinRoomsCount(twinRoomsCount + 1)}
                          className="flex h-6 w-6 items-center justify-center bg-[#f8fafc] text-xs font-bold text-slate-700 hover:bg-slate-200"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Sales Strategy */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="salesStrategySelect"
                    className="text-[11.5px] font-semibold text-[#475569]"
                  >
                    Sales Strategy<span className="ml-0.5 text-rose-600">*</span>
                  </label>
                  <select
                    id="salesStrategySelect"
                    value={salesStrategy}
                    onChange={(e) => {
                      const next = e.target.value;
                      setSalesStrategy(next);
                      if (next === 'BAR') setSelectedRateCode('BAR');
                      else setSelectedRateCode('NCOR');
                    }}
                    className="outline-hidden h-8 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
                  >
                    <option value="Negotiated Contracted">
                      Negotiated Contracted (Corporate NCOR1B)
                    </option>
                    <option value="BAR">BAR — Best Available Rate</option>
                    <option value="Preset">Preset Corporate Rates</option>
                  </select>
                </div>

                {/* Organization & Advanced Details */}
                <details className="rounded-sm border border-[#e2e8f0]">
                  <summary className="flex cursor-pointer select-none items-center justify-between bg-[#f8fafc] px-2.5 py-1.5 text-[11.5px] font-semibold text-[#475569]">
                    <span>Organization & Advanced Search</span>
                    <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                  </summary>
                  <div className="flex flex-col gap-2 border-t border-[#e2e8f0] bg-white p-2.5">
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="orgAccountInput"
                        className="text-[11px] font-medium text-[#475569]"
                      >
                        Organization / Account
                      </label>
                      <input
                        id="orgAccountInput"
                        type="text"
                        value={orgAccount}
                        onChange={(e) => setOrgAccount(e.target.value)}
                        placeholder="e.g. CIDB"
                        className="outline-hidden h-7 w-full rounded-sm border border-[#cbd5e1] px-2 text-xs text-[#1e293b] focus:border-[#0066cc]"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="checkbox"
                        id="chkIncludeRestricted"
                        checked={showUnavailable}
                        onChange={(e) => setShowUnavailable(e.target.checked)}
                        className="h-3.5 w-3.5 rounded-sm border-slate-300 text-[#0066cc] focus:ring-0"
                      />
                      <label
                        htmlFor="chkIncludeRestricted"
                        className="cursor-pointer text-[11.5px] text-[#475569]"
                      >
                        Show Unavailable / Restricted Rates
                      </label>
                    </div>
                  </div>
                </details>

                {/* Search Availability Button */}
                {isSearching ? (
                  <div className="flex h-9 w-full items-center justify-center gap-2 rounded-sm border border-blue-200 bg-[#eff6ff] text-xs font-semibold text-[#0066cc]">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Querying Infor HMS availability grid...</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleExecuteSearch}
                    className="shadow-xs flex h-9 w-full items-center justify-center gap-2 rounded-sm bg-[#0066cc] text-xs font-bold text-white transition-colors hover:bg-[#0052a3]"
                  >
                    <Search className="h-3.5 w-3.5" />
                    <span>Search Availability</span>
                  </button>
                )}
              </div>
            </div>

            </details>
            {/* Results Section (Room Rates) */}
            {hasSearched && (
              <div className="animate-in fade-in flex flex-col gap-2.5 duration-200">
                <p>{selectedProposal?`${selectedProposal.arrivalDate} to ${selectedProposal.departureDate} · ${selectedProposal.currency} ${(selectedProposal.totalMinor/100).toFixed(2)} · ${selectedProposal.description}`:'Choose an authorized offer before creating a draft.'}</p>
                <p>Sample placeholder — not live AI output</p>
                <button type="button" onClick={()=>setIsModalOpen(true)}>Open Full-Screen (1000×800)</button>
                {/* Draft Quotation into Outlook Reply Button */}
                <Button
                  type="button"
                  aria-label="Insert Draft in Outlook"
                  onClick={handleInsertAiDraft}
                  disabled={!canCreatePaneProposal(selectedProposal) || !activeEmail || !supportsAction('CREATE_REPLY_DRAFT') || isDraftPending}
                  className="shadow-xs h-10 w-full rounded-sm bg-[#1a4332] text-xs font-bold text-white transition-colors hover:bg-[#123023] disabled:opacity-50"
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {isDraftPending ? 'Saving Outlook draft…' : 'Draft Quotation into Email Reply'}
                </Button>
                <p className="text-center text-[11px] text-[#64748b]">
                  Review the reply and PDF, then Send manually in Outlook. Nava never sends from
                  this pane.
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
                    <p>Good day {draftedDetails.sender.split(' ')[0] || 'Guest'},</p>
                    <p className="mt-1">Thank you for Choosing The Centurion Hotel.</p>
                    <p className="mt-1">Please see attached quotation.</p>
                    <p className="mt-1">
                      Should you wish to proceed, please sign and return the attached quotation so
                      that we can confirm and secure your reservation. Please note that no rooms are
                      currently being held, and bookings will only be confirmed once we have
                      received the signed quotation.
                    </p>
                    <p className="mt-1">
                      Please feel free to contact me should you require any further information
                    </p>
                    <p className="mt-2 text-[#475569]">Kind regards,</p>
                  </div>
                )}
              </div>
            )}

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
                Run System Verification
              </Button>
            </div>

            {(testResults.bridge !== null || testResults.serverPing !== null) && (
              <div className="flex flex-col gap-1.5 rounded-sm border border-[#e2e8f0] bg-[#f8fafc] p-2.5 text-xs">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#64748b]">
                  Diagnostic Verification
                </p>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>1. C# VSTO Bridge Handshake</span>
                  {testResults.bridge ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>2. Active Email Inspection</span>
                  {testResults.activeEmail ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>3. Folder Table Query</span>
                  {testResults.folderTable ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-500" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[#1e293b]">
                  <span>4. TRPC Server Ping</span>
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

      {/* 1000×800 Desktop Full-Screen Inspection Modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsModalOpen(false);
          }}
          className="backdrop-blur-xs animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 duration-150"
        >
          <div className="flex h-[800px] max-h-[92vh] w-[1000px] max-w-[95vw] flex-col overflow-hidden rounded-md bg-white shadow-2xl">
            <div className="flex h-9 shrink-0 items-center justify-between bg-slate-900 px-3 text-xs font-semibold text-white">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>
                  Infor HMS —{' '}
                  {proofTab === 'criteria' ? 'Search Criteria' : 'Hotel Availability Grid'}{' '}
                  [Centurion · Native 100% DPI]
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-slate-400">1000 × 800 Window</span>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-sm p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-1 items-start justify-center overflow-auto bg-[#0b0f19] p-3">
              <img
                src="/quote-rate-proof.png"
                alt="Infor HMS Full Resolution Availability Grid"
                className="max-w-full rounded-sm shadow-md"
              />
            </div>

            <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#e2e8f0] bg-[#f8fafc] px-3 text-[11px] text-[#475569]">
              <span>
                Green / White: Open Availability · ⊘ Red Circle: Stay Restriction / Closed to
                Arrival (BWKPB)
              </span>
              <span>
                Press <strong>Esc</strong> to close
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
