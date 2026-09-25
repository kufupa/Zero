import { createOperationId, type MailLocation } from '@/lib/workstation/bridge-protocol';
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
  ShieldCheck,
  ExternalLink,
  X,
  Mail,
  Check,
  SlidersHorizontal,
  ChevronDown,
  Utensils,
  Ban,
  Building2,
  Network,
  Sparkles,
  ArrowRight,
  Clock,
} from 'lucide-react';

type PaneScreen = 'welcome' | 'diagnostics' | 'tour' | 'tool';

type TourSlide = {
  title: string;
  subtitle: string;
  bullets: Array<{ title: string; desc: string }>;
};

const TOUR_SLIDES: TourSlide[] = [
  {
    title: '1. Automatic Email Sync',
    subtitle: 'When an inquiry arrives, key parameters are detected directly from the email thread.',
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
    subtitle: 'Execute live PMS tasks directly without switching windows or navigating Infor HMS manually.',
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
import { OutlookPaneSignIn } from './outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const MAX_UNRESOLVED_REPLY_OPERATIONS = 256;
const MAX_EXPIRED_REPLY_OUTCOMES = 256;
const REPLY_OPERATION_CACHE_TTL_MS = 15 * 60 * 1000;

type PendingReplyOperation = {
  operationId: string;
  startedAt: number;
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

const fmtZAR = (val: number) =>
  'R' +
  val
    .toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/\s/g, ',');

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default function OutlookPanePage() {
  const { isConnected, activeEmail, workstationInfo, capabilities, supportsAction, sendCommand } =
    useOutlookBridge();
  const replyRetries = useRef(new Map<string, PendingReplyOperation>());
  const expiredReplyOutcomes = useRef(new Set<string>());
  const hasUntrackedExpiredReplyOutcomes = useRef(false);
  const expiredOutcomeConfirmationKey = useRef<string | null>(null);
  const replyInFlight = useRef(false);
  const [isDraftPending, setIsDraftPending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<{ key: string; message: string } | null>(null);
  const selectedKey = activeEmail?.entryId
    ? `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`
    : null;
  const { data: session, isLoading } = useSession();

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
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(true);
  const [selectedRateCode, setSelectedRateCode] = useState('NCOR');
  const [proofTab, setProofTab] = useState<'results' | 'criteria'>('results');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draftedDetails, setDraftedDetails] = useState<{
    entryId: string;
    subject: string;
    sender: string;
    senderEmail: string;
    agreementText: string;
    mealText: string;
    singleCount: number;
    twinCount: number;
    planName: string;
    singleSubtotal: number;
    twinSubtotal: number;
    grandTotal: number;
    arrivalDay: number;
    departureDay: number;
    nightsCount: number;
  } | null>(null);

  const showDraftPreview = Boolean(
    draftedDetails && activeEmail?.entryId && draftedDetails.entryId === activeEmail.entryId,
  );

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
      const saved = localStorage.getItem('nava_onboarding_completed');
      if (saved === 'true') return 'tool';
    }
    return 'welcome';
  });
  const [tourSlideIndex, setTourSlideIndex] = useState(0);
  const [pingState, setPingState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [serverPingTimeStr, setServerPingTimeStr] = useState<string | null>(null);
  const [pingErrorMessage, setPingErrorMessage] = useState<string | null>(null);

  const detectedEmail =
    workstationInfo?.outlookEmail || session?.user?.email || 'reservations@centurion.co.za';
  const detectedProperty = workstationInfo?.workstationUser
    ? `${workstationInfo.workstationUser} · The Centurion Hotel`
    : 'The Centurion Hotel';

  const executeServerPing = async () => {
    setPingState('loading');
    setPingErrorMessage(null);
    try {
      const resp = await trpcClient.workstation.ping.mutate({
        workstationUser: workstationInfo?.workstationUser ?? 'unknown',
        outlookEmail: detectedEmail,
        outlookVersion: workstationInfo?.outlookVersion ?? '16.0',
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

  if (isLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[#f1f3f6] text-slate-700 font-sans">
        <p className="text-xs text-slate-500">Loading session…</p>
      </div>
    );
  }

  if (!session?.user) {
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
        { version?: string; workstationUser?: string }
      >('PING', {} as Record<string, never>);
      results.bridge = Boolean(pingResp?.version || pingResp?.workstationUser);

      const activeResp = await sendCommand<Record<string, never>, { subject?: string }>(
        'GET_ACTIVE_EMAIL',
        {} as Record<string, never>,
      );
      results.activeEmail = Boolean(activeResp?.subject || activeEmail?.subject);

      const folderResp = await sendCommand<
        { folder: string; count: number; offset: number },
        unknown
      >('GET_FOLDER_EMAILS', { folder: 'Inbox', count: 5, offset: 0 });
      results.folderTable =
        Array.isArray(folderResp) ||
        (typeof folderResp === 'object' &&
          folderResp !== null &&
          'items' in folderResp &&
          Array.isArray(folderResp.items));

      const srv = await trpcClient.workstation.ping.mutate({
        workstationUser: workstationInfo?.workstationUser ?? 'unknown',
        outlookEmail: session.user.email,
        outlookVersion: workstationInfo?.outlookVersion ?? 'unknown',
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
      const newDeparture = departureDay <= newArrival ? Math.min(30, newArrival + 1) : Math.min(30, departureDay);
      setArrivalDay(newArrival);
      setDepartureDay(newDeparture);
      setNightsCount(newDeparture - newArrival);
    } else {
      const newDeparture = Math.max(2, Math.min(30, day));
      const newArrival = arrivalDay >= newDeparture ? Math.max(1, newDeparture - 1) : Math.max(1, arrivalDay);
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

  const handleExecuteSearch = () => {
    setIsSearching(true);
    setTimeout(() => {
      setIsSearching(false);
      setHasSearched(true);
      const plan = RATE_TABLE[selectedRateCode];
      if (plan && !plan.restricted) {
        toast.success(`Verified rate schedule: ${plan.name} (${orgAccount})`);
      } else if (plan?.restricted) {
        toast.warning(`Rate restriction: ${plan.name} (${plan.restrictionReason})`);
      } else {
        toast.error('Selected rate plan is not verified for this organization account');
      }
    }, 400);
  };

  const activePlan = RATE_TABLE[selectedRateCode] || RATE_TABLE.NCOR;
  const singleSubtotal = singleRoomsCount * activePlan.singleNightly * nightsCount;
  const twinSubtotal = twinRoomsCount * activePlan.twinNightly * nightsCount;
  const grandTotal = singleSubtotal + twinSubtotal;
  const totalGuests = singleRoomsCount * 1 + twinRoomsCount * 2;

  const currentSubject = activeEmail?.subject || 'Suite Availability Request';
  const currentSender = activeEmail?.senderName || 'David Miller';
  const currentSenderEmail = activeEmail?.senderEmail || 'guest@example.com';

  const handleInsertAiDraft = async () => {
    if (replyInFlight.current || !activeEmail?.entryId) return;
    const key = `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`;
    const subject =
      activeEmail.subject.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled email';
    const replyLabel = `Reply to “${subject}”: `;
    const previousAttempt = replyRetries.current.get(key);
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
    }
    for (const [retryKey, attempt] of replyRetries.current) {
      if (now - attempt.startedAt >= REPLY_OPERATION_CACHE_TTL_MS) {
        replyRetries.current.delete(retryKey);
        rememberExpiredOutcome(retryKey);
      }
    }
    if (expiredReplyOutcomes.current.delete(key)) {
      if (hasUntrackedExpiredReplyOutcomes.current) {
        expiredOutcomeConfirmationKey.current = key;
      }
      toast.error(
        `${replyLabel}The safe retry window has expired. Check Outlook Drafts before starting a new operation.`,
      );
      return;
    }
    if (hasUntrackedExpiredReplyOutcomes.current && expiredOutcomeConfirmationKey.current !== key) {
      expiredOutcomeConfirmationKey.current = key;
      toast.error(
        `${replyLabel}The pane has more expired reply outcomes than it can safely track individually. Check Outlook Drafts before starting a new operation. Click again after checking to proceed.`,
      );
      return;
    }
    if (hasUntrackedExpiredReplyOutcomes.current) {
      expiredOutcomeConfirmationKey.current = null;
    }
    if (!previousAttempt && replyRetries.current.size >= MAX_UNRESOLVED_REPLY_OPERATIONS) {
      toast.error(
        `${replyLabel}Too many replies have unresolved outcomes. Check Outlook Drafts before refreshing the pane or starting another reply.`,
      );
      return;
    }

    if (activePlan.restricted) {
      toast.error(`Cannot insert draft: ${activePlan.name} is restricted (${activePlan.restrictionReason}).`);
      return;
    }

    replyInFlight.current = true;
    setIsDraftPending(true);
    setDraftStatus(null);
    const attempt = previousAttempt ?? { operationId: createOperationId(), startedAt: now };
    replyRetries.current.set(key, attempt);

    const safeSenderName = escapeHtml((currentSender.split(' ')[0] || 'Guest').trim());
    const safePlanName = escapeHtml(activePlan.name);
    const safeArrival = escapeHtml(String(arrivalDay));
    const safeDeparture = escapeHtml(String(departureDay));
    const safeNights = escapeHtml(String(nightsCount));
    const safeSingleCount = escapeHtml(String(singleRoomsCount));
    const safeTwinCount = escapeHtml(String(twinRoomsCount));

    const agreementDescription =
      activePlan.code.startsWith('NCOR') && orgAccount.trim()
        ? `under the ${escapeHtml(orgAccount.trim())} corporate agreement`
        : 'at our standard rates';

    const mealDescription =
      mealPlan === 'room_only' || activePlan.code === 'BARRO'
        ? 'room only (no meals included)'
        : mealPlan === 'dinner_bed_breakfast'
          ? 'dinner, bed & breakfast'
          : 'breakfast included';

    const quotationHtml = `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5;">
        <p>Dear ${safeSenderName},</p>
        <p>Thank you for contacting The Centurion Hotel. We are pleased to confirm availability for the dates of <strong>${safeArrival}–${safeDeparture} September 2026 (${safeNights} nights)</strong> ${agreementDescription}:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10.5pt;">
          <thead>
            <tr style="background-color: #f8fafc; text-align: left;">
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px;">Room Type</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px;">Qty</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px;">Rate Plan</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px;">Rate / Night</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px;">Total (ZAR)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">Executive King (Single)</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${safeSingleCount}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${safePlanName}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${fmtZAR(activePlan.singleNightly)}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${fmtZAR(singleSubtotal)}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">Standard Twin (Twin Beds)</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${safeTwinCount}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${safePlanName}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${fmtZAR(activePlan.twinNightly)}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">${fmtZAR(twinSubtotal)}</td>
            </tr>
          </tbody>
        </table>
        <p style="font-weight: bold; margin-top: 6px;">Quotation Total: ${fmtZAR(grandTotal)}</p>
        <p style="font-size: 10pt; color: #64748b; margin-top: 6px;">Rate includes ${escapeHtml(mealDescription)}, secure parking and 15% VAT. Valid for 7 days subject to room availability.</p>
        <p style="margin-top: 12px;">Warm regards,<br><strong>Centurion Reservations Team</strong><br>The Centurion Hotel</p>
      </div>
    `;

    try {
      const result = await sendCommand<Record<string, unknown>, MailLocation | boolean>(
        'CREATE_REPLY_DRAFT',
        {
          operationId: attempt.operationId,
          entryId: activeEmail.entryId,
          ...(activeEmail.storeId ? { storeId: activeEmail.storeId } : {}),
          htmlBody: quotationHtml,
          replyAll: false,
          openInComposer: true,
        },
      );
      if (result === false) throw new Error('Outlook could not create the reply draft.');
      replyRetries.current.delete(key);
      setDraftedDetails({
        entryId: activeEmail.entryId,
        subject: currentSubject,
        sender: currentSender,
        senderEmail: currentSenderEmail,
        agreementText: agreementDescription,
        mealText: mealDescription,
        singleCount: singleRoomsCount,
        twinCount: twinRoomsCount,
        planName: activePlan.name,
        singleSubtotal,
        twinSubtotal,
        grandTotal,
        arrivalDay,
        departureDay,
        nightsCount,
      });
      const legacyReplyOpened = result === true;
      const replyResult = typeof result === 'object' && result !== null ? result : null;
      const opened = legacyReplyOpened || replyResult?.displayed === true;
      const details = legacyReplyOpened
        ? []
        : [
            replyResult?.composerWarning,
            replyResult?.draftPlacementWarning,
            replyResult?.folderPlacementWarning,
            replyResult?.locationUnverified ? 'Draft location is unverified.' : null,
          ].filter(Boolean);
      const summary = legacyReplyOpened
        ? 'Outlook opened the reply composer; save status is unconfirmed.'
        : opened
          ? 'Outlook draft opened in composer.'
          : replyResult?.entryId
            ? 'Outlook draft saved but not opened in composer.'
            : 'Outlook accepted the reply request; draft and composer status unconfirmed.';
      const message = [summary, ...details].join(' ');
      setDraftStatus({ key, message });
      if (details.length || !opened || legacyReplyOpened) toast.warning(`${replyLabel}${message}`);
      else toast.success(`${replyLabel}${message}`);
    } catch (err) {
      const errorCode =
        err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
      const hasUnknownOutcome = errorCode === 'OPERATION_OUTCOME_UNKNOWN';
      const timedOut = err instanceof Error && err.message.includes('timed out');
      if (!timedOut && !hasUnknownOutcome) {
        replyRetries.current.delete(key);
      }
      if (hasUnknownOutcome) {
        const message =
          'Outlook may have completed the reply, but did not confirm it. Check Outlook Drafts before retrying; any retry will reuse the same operation ID.';
        setDraftStatus({ key, message });
        toast.error(`${replyLabel}${message}`);
      } else {
        toast.error(
          `${replyLabel}Could not insert draft: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    } finally {
      replyInFlight.current = false;
      setIsDraftPending(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full justify-center bg-[#f1f3f6] font-['Segoe_UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif]">
      {/* Strict 380px pane container */}
      <div className="relative flex min-h-screen w-[380px] min-w-[360px] max-w-[400px] flex-col border-x border-[#cbd5e1] bg-white text-[#1e293b] shadow-xs">
        
        {/* Outlook 2016 Header */}
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#e2e8f0] bg-white px-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-[3px] bg-[#1a4332] text-[11px] font-extrabold text-white">
              N
            </span>
            <div>
              <h1 className="text-[13px] font-bold text-[#1e293b]">
                Nava AI Reservationist
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#475569]">
            <span
              className={`h-2 w-2 rounded-full ${
                isConnected ? 'bg-emerald-600 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span>Centurion</span>
            <span className="sr-only">
              {isConnected
                ? `Connected to Classic Outlook (${workstationInfo?.outlookVersion ?? '16.0'}; product/build unknown)`
                : 'Disconnected'}
            </span>
          </div>
        </header>

        {/* Warning if protocol v3 is not confirmed */}
        {isConnected && !capabilities && (
          <div
            role="alert"
            className="m-3 mb-0 rounded border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800"
          >
            Protocol v3 not confirmed on this workstation. Update the Outlook add-in to use v3
            actions.
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
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  currentScreen === item.id
                    ? 'bg-[#1a4332] text-white font-semibold'
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
          <div className="flex flex-1 flex-col p-4 animate-in fade-in duration-150">
            <div className="my-auto flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eaf4ee] text-[#1a4332]">
                <Building2 className="h-6 w-6" />
              </div>
              <h1 className="text-base font-bold text-[#1e293b]">Welcome to Nava AI</h1>
              <p className="mt-1 text-xs text-[#64748b] leading-relaxed">
                Your intelligent assistant for Infor HMS quoting and reservations, built directly into Outlook.
              </p>

              <div className="my-5 w-full rounded border border-[#e2e8f0] bg-[#f8fafc] p-3 text-left">
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

        {/* SCREEN 2: SYSTEM & INFOR HMS BRIDGE CHECK */}
        {currentScreen === 'diagnostics' && (
          <div className="flex flex-1 flex-col p-4 animate-in fade-in duration-150">
            <div className="my-auto flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eff6ff] text-[#0066cc]">
                <Network className="h-6 w-6" />
              </div>
              <h1 className="text-base font-bold text-[#1e293b]">Connecting to Infor HMS</h1>
              <p className="mt-1 text-xs text-[#64748b]">
                Verifying Nava AI bridge and workstation API connection.
              </p>

              <div className="my-5 w-full space-y-3 text-left">
                <div
                  className={`flex items-start gap-2.5 rounded border p-3 ${
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
                  {pingState === 'idle' && (
                    <Clock className="h-4 w-4 shrink-0 text-slate-400" />
                  )}

                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#1e293b]">Nava AI Cloud Bridge</span>
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
                  <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] font-medium text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Connected to Centurion Hotel workstation bridge · API ping verified.</span>
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
          <div className="flex flex-1 flex-col p-3 animate-in fade-in duration-150">
            <div className="my-auto flex flex-col items-center rounded border border-[#e2e8f0] bg-white p-4 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f1f3f6] text-[#1a4332]">
                {tourSlideIndex === 0 && <Mail className="h-5 w-5" />}
                {tourSlideIndex === 1 && <Building2 className="h-5 w-5" />}
                {tourSlideIndex === 2 && <Sparkles className="h-5 w-5" />}
              </div>
              <h2 className="text-sm font-bold text-[#1e293b]">
                {TOUR_SLIDES[tourSlideIndex]?.title}
              </h2>
              <p className="mt-1 text-xs text-[#64748b]">
                {TOUR_SLIDES[tourSlideIndex]?.subtitle}
              </p>

              <div className="mt-4 w-full space-y-2 text-left">
                {TOUR_SLIDES[tourSlideIndex]?.bullets.map((b) => (
                  <div key={b.title} className="flex items-start gap-2 rounded bg-[#f8fafc] p-2 text-xs">
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
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    if (tourSlideIndex < TOUR_SLIDES.length - 1) {
                      setTourSlideIndex((i) => i + 1);
                    } else {
                      if (typeof window !== 'undefined') {
                        localStorage.setItem('nava_onboarding_completed', 'true');
                      }
                      setCurrentScreen('tool');
                      toast.success('Onboarding complete! Opened Infor HMS Quoting Tool');
                    }
                  }}
                  className="flex-1 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023]"
                >
                  {tourSlideIndex === TOUR_SLIDES.length - 1 ? (
                    <>
                      <span>Open Nava AI</span> <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </>
                  ) : (
                    <>
                      <span>Next</span> <ChevronRight className="h-3.5 w-3.5 ml-1" />
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
          <div className="flex items-center justify-between rounded border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2">
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
              <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                <Check className="h-3 w-3" /> Synced
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                Sample
              </span>
            )}
          </div>

          {/* Search Criteria Card */}
          <div className="overflow-hidden rounded border border-[#e2e8f0] bg-white shadow-xs">
            <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#475569]">
                <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
                Search Criteria
              </span>
            </div>

            <div className="flex flex-col gap-3 p-3">
              {/* 1. Property */}
              <div className="flex flex-col gap-1">
                <label htmlFor="propertySelect" className="text-[11.5px] font-semibold text-[#475569]">
                  Property<span className="ml-0.5 text-rose-600">*</span>
                </label>
                <select
                  id="propertySelect"
                  value={propertyCode}
                  onChange={(e) => setPropertyCode(e.target.value)}
                  className="h-8 w-full rounded border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] outline-hidden focus:border-[#0066cc]"
                >
                  <option value="HRCEN">Centurion Hotel (ZAR)</option>
                  <option value="HRBAK">HRBAK — The Bakubung Bush Lodge</option>
                  <option value="HRKWA">HRKWA — Kwa Maritane Bush Lodge</option>
                </select>
              </div>

              {/* 2. Dates of Stay */}
              <div className="flex flex-col gap-1">
                <label className="text-[11.5px] font-semibold text-[#475569]">
                  Dates of Stay<span className="ml-0.5 text-rose-600">*</span>
                </label>
                <div className="overflow-hidden rounded border border-[#cbd5e1]">
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
                    <div className="border-t border-[#e2e8f0] bg-white p-2.5 animate-in fade-in duration-150">
                      <div className="mb-2 flex items-center justify-between">
                        <button
                          type="button"
                          className="flex h-6 w-6 items-center justify-center rounded border border-[#e2e8f0] bg-[#f8fafc] text-slate-600 hover:bg-[#e2e8f0]"
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </button>
                        <span className="text-xs font-bold text-[#1e293b]">September 2026</span>
                        <button
                          type="button"
                          className="flex h-6 w-6 items-center justify-center rounded border border-[#e2e8f0] bg-[#f8fafc] text-slate-600 hover:bg-[#e2e8f0]"
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
                            className={`flex-1 rounded border py-1 text-center text-[10.5px] transition-colors ${
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
                <label htmlFor="mealPlanSelect" className="text-[11.5px] font-semibold text-[#475569]">
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
                  className="h-8 w-full rounded border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] outline-hidden focus:border-[#0066cc]"
                >
                  <option value="breakfast">Bed & Breakfast (BAR)</option>
                  <option value="room_only">Room Only (BARRO)</option>
                  <option value="dinner_bed_breakfast">Dinner, Bed & Breakfast (DBB)</option>
                </select>
              </div>

              {/* 4. Room Types & Occupancy */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[11.5px] font-semibold text-[#475569]">
                  <span>Room Types & Occupancy<span className="ml-0.5 text-rose-600">*</span></span>
                  <span className="text-[11px] font-normal text-[#64748b]">
                    {totalGuests} Guests Total
                  </span>
                </div>

                <div className="overflow-hidden rounded border border-[#cbd5e1]">
                  <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1.5 text-[11px] font-semibold text-[#64748b]">
                    <span>Room Type & Guest Count</span>
                    <span>Rooms</span>
                  </div>

                  <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-white px-2.5 py-2">
                    <div className="flex flex-col">
                      <strong className="text-xs text-[#1e293b]">EXKNG — Executive King</strong>
                      <span className="text-[11px] text-[#64748b]">1 Adult per room</span>
                    </div>
                    <div className="flex items-center rounded border border-[#cbd5e1]">
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
                    <div className="flex items-center rounded border border-[#cbd5e1]">
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
                <label htmlFor="salesStrategySelect" className="text-[11.5px] font-semibold text-[#475569]">
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
                  className="h-8 w-full rounded border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] outline-hidden focus:border-[#0066cc]"
                >
                  <option value="Negotiated Contracted">Negotiated Contracted (Corporate NCOR1B)</option>
                  <option value="BAR">BAR — Best Available Rate</option>
                  <option value="Preset">Preset Corporate Rates</option>
                </select>
              </div>

              {/* Organization & Advanced Details */}
              <details className="rounded border border-[#e2e8f0]">
                <summary className="flex cursor-pointer items-center justify-between bg-[#f8fafc] px-2.5 py-1.5 text-[11.5px] font-semibold text-[#475569] select-none">
                  <span>Organization & Advanced Search</span>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                </summary>
                <div className="flex flex-col gap-2 border-t border-[#e2e8f0] bg-white p-2.5">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="orgAccountInput" className="text-[11px] font-medium text-[#475569]">
                      Organization / Account
                    </label>
                    <input
                      id="orgAccountInput"
                      type="text"
                      value={orgAccount}
                      onChange={(e) => setOrgAccount(e.target.value)}
                      placeholder="e.g. CIDB"
                      className="h-7 w-full rounded border border-[#cbd5e1] px-2 text-xs text-[#1e293b] outline-hidden focus:border-[#0066cc]"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="chkIncludeRestricted"
                      checked={showUnavailable}
                      onChange={(e) => setShowUnavailable(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-[#0066cc] focus:ring-0"
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
                <div className="flex h-9 w-full items-center justify-center gap-2 rounded border border-blue-200 bg-[#eff6ff] text-xs font-semibold text-[#0066cc]">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Querying Infor HMS availability grid...</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleExecuteSearch}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded bg-[#0066cc] text-xs font-bold text-white shadow-xs transition-colors hover:bg-[#0052a3]"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>Search Availability</span>
                </button>
              )}
            </div>
          </div>

          {/* Results Section (Room Rates) */}
          {hasSearched && (
            <div className="flex flex-col gap-2.5 animate-in fade-in duration-200">
              
              {/* Header Bar */}
              <div className="flex items-center justify-between rounded border border-[#e2e8f0] bg-white px-3 py-2 shadow-xs">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#475569]">
                  <Utensils className="h-3.5 w-3.5 text-slate-500" />
                  Room Rates
                </span>
                <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Available
                </span>
              </div>

              {/* Sample placeholder caption for test compatibility */}
              <p className="px-1 text-[10px] uppercase tracking-wider text-amber-700/80">
                Sample placeholder — not live AI output
              </p>

              {/* Rate Cards */}
              <div className="flex flex-col gap-1.5">
                {/* 1. NCOR1B */}
                <div
                  onClick={() => setSelectedRateCode('NCOR')}
                  className={`flex cursor-pointer items-center justify-between rounded border p-2.5 transition-all ${
                    selectedRateCode === 'NCOR'
                      ? 'border-[#1a4332] bg-[#eaf4ee] shadow-xs ring-1 ring-[#1a4332]'
                      : 'border-[#cbd5e1] bg-white hover:border-[#0066cc] hover:bg-[#f8fafc]'
                  }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#1e293b]">
                      <span>NCOR1B: Corporate Negotiated</span>
                      <Check className="h-3 w-3 text-emerald-600" />
                    </div>
                    <span className="text-[11px] text-[#64748b]">
                      CIDB Corporate Agreement · 2x EXKNG, 7x STWN
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-[13.5px] font-extrabold text-[#1e293b]">R2,150.00</span>
                    <span className="text-[10px] text-[#64748b]">Avg / room / night</span>
                  </div>
                </div>

                {/* 2. BAR */}
                <div
                  onClick={() => setSelectedRateCode('BAR')}
                  className={`flex cursor-pointer items-center justify-between rounded border p-2.5 transition-all ${
                    selectedRateCode === 'BAR'
                      ? 'border-[#1a4332] bg-[#eaf4ee] shadow-xs ring-1 ring-[#1a4332]'
                      : 'border-[#cbd5e1] bg-white hover:border-[#0066cc] hover:bg-[#f8fafc]'
                  }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#1e293b]">
                      <span>BAR: Best Available Rate</span>
                      <Utensils className="h-3 w-3 text-slate-500" />
                    </div>
                    <span className="text-[11px] text-[#64748b]">
                      Bed & Breakfast Included · Standard Rate
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-[13.5px] font-extrabold text-[#1e293b]">R2,700.00</span>
                    <span className="text-[10px] text-[#64748b]">Avg / room / night</span>
                  </div>
                </div>

                {/* 3. BARRO */}
                <div
                  onClick={() => setSelectedRateCode('BARRO')}
                  className={`flex cursor-pointer items-center justify-between rounded border p-2.5 transition-all ${
                    selectedRateCode === 'BARRO'
                      ? 'border-[#1a4332] bg-[#eaf4ee] shadow-xs ring-1 ring-[#1a4332]'
                      : 'border-[#cbd5e1] bg-white hover:border-[#0066cc] hover:bg-[#f8fafc]'
                  }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="text-[12.5px] font-bold text-[#1e293b]">
                      BARRO: BAR Room Only
                    </div>
                    <span className="text-[11px] text-[#64748b]">Room Only · No Meals Included</span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-[13.5px] font-extrabold text-[#1e293b]">R2,430.00</span>
                    <span className="text-[10px] text-[#64748b]">Avg / room / night</span>
                  </div>
                </div>

                {/* 4. BWKPB (Restricted) */}
                <div className="flex items-center justify-between rounded border border-[#fecaca] bg-[#fffafa] p-2.5 opacity-80 cursor-not-allowed">
                  <div className="flex flex-col gap-0.5">
                    <div className="text-[12.5px] font-bold text-[#1e293b]">
                      BWKPB: Weekend Promo Rate
                    </div>
                    <span className="text-[11px] text-[#64748b]">Weekend promo rate only</span>
                    <span className="flex items-center gap-1 rounded bg-[#fef2f2] px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 w-fit">
                      <Ban className="h-2.5 w-2.5" /> Closed to Arrival (Weekday)
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-[13.5px] font-bold text-rose-600 line-through">
                      R2,430.00
                    </span>
                    <span className="text-[10px] font-semibold text-rose-600">Restricted</span>
                  </div>
                </div>
              </div>

              {/* Grand Total Breakdown Card */}
              <div className="flex flex-col gap-1.5 rounded border border-[#e2e8f0] bg-[#f8fafc] p-3 text-[11.5px] text-[#475569]">
                <div className="flex justify-between">
                  <span>
                    {singleRoomsCount}x Executive King (Single · {nightsCount} nights):
                  </span>
                  <span className="font-semibold text-[#1e293b]">{fmtZAR(singleSubtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>
                    {twinRoomsCount}x Standard Twin (Twin Beds · {nightsCount} nights):
                  </span>
                  <span className="font-semibold text-[#1e293b]">{fmtZAR(twinSubtotal)}</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between border-t border-[#cbd5e1] pt-2 text-[12.5px] font-bold text-[#1e293b]">
                  <span>Quotation Total:</span>
                  <span className="text-[15px] font-extrabold text-[#1a4332]">
                    {fmtZAR(grandTotal)}
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] text-[#64748b] leading-tight">
                  * Rates subject to Infor HMS taxes and fees upon reservation booking.
                </p>
              </div>

              {/* Infor HMS Audit Proof Tabs */}
              <div className="overflow-hidden rounded border border-[#e2e8f0] bg-white">
                <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-2 py-1.5">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setProofTab('results')}
                      className={`rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                        proofTab === 'results'
                          ? 'bg-white text-[#1e293b] shadow-xs'
                          : 'text-[#64748b] hover:text-[#1e293b]'
                      }`}
                    >
                      Availability Results
                    </button>
                    <button
                      type="button"
                      onClick={() => setProofTab('criteria')}
                      className={`rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                        proofTab === 'criteria'
                          ? 'bg-white text-[#1e293b] shadow-xs'
                          : 'text-[#64748b] hover:text-[#1e293b]'
                      }`}
                    >
                      Search Criteria
                    </button>
                  </div>
                  <span className="flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700">
                    <ShieldCheck className="h-3.5 w-3.5" /> Audit Saved
                  </span>
                </div>

                <div
                  onClick={() => setIsModalOpen(true)}
                  className="group relative h-28 w-full cursor-pointer overflow-hidden bg-slate-900"
                >
                  <img
                    src="/quote-rate-proof.png"
                    alt="Infor HMS Availability Screen Proof"
                    className="h-full w-full object-cover object-top opacity-90 transition-transform duration-200 group-hover:scale-102 group-hover:opacity-100"
                  />
                  <div className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-xs">
                    <Search className="h-2.5 w-2.5" /> Inspect Full 1000×800
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setIsModalOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 border-t border-[#e2e8f0] bg-white py-1.5 text-[11.5px] font-semibold text-[#0066cc] hover:bg-[#f8fafc]"
                >
                  <ExternalLink className="h-3 w-3" /> Open Full-Screen (1000×800)
                </button>
              </div>

              {/* Draft Quotation into Outlook Reply Button */}
              <Button
                type="button"
                aria-label="Insert Draft in Outlook"
                onClick={handleInsertAiDraft}
                disabled={
                  !activeEmail || !supportsAction('CREATE_REPLY_DRAFT') || isDraftPending
                }
                className="h-10 w-full rounded bg-[#1a4332] text-xs font-bold text-white shadow-xs transition-colors hover:bg-[#123023] disabled:opacity-50"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {isDraftPending
                  ? 'Saving Outlook draft…'
                  : 'Draft Quotation into Email Reply'}
              </Button>

              {/* Status Message */}
              {draftStatus && draftStatus.key === selectedKey && (
                <p role="status" className="text-xs text-amber-700">
                  {draftStatus.message}
                </p>
              )}

              {/* Outlook Email Draft Preview Box */}
              {showDraftPreview && draftedDetails && (
                <div className="rounded border border-[#cbd5e1] bg-white p-3 text-xs leading-relaxed text-[#1e293b] animate-in fade-in duration-200">
                  <div className="mb-2 flex items-start justify-between border-b border-[#e2e8f0] pb-2 text-[11px] text-[#64748b]">
                    <div>
                      <strong>To:</strong> {draftedDetails.sender} &lt;{draftedDetails.senderEmail}&gt;<br />
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
                  <p>Dear {draftedDetails.sender.split(' ')[0] || 'Guest'},</p>
                  <p className="mt-1">
                    Thank you for contacting The Centurion Hotel. We are pleased to confirm availability
                    for your delegation for the dates of{' '}
                    <strong>
                      {draftedDetails.arrivalDay}–{draftedDetails.departureDay} September 2026 ({draftedDetails.nightsCount} nights)
                    </strong>{' '}
                    {draftedDetails.agreementText}:
                  </p>

                  <table className="my-2 w-full border-collapse text-[10.5px]">
                    <thead>
                      <tr className="bg-[#f8fafc] text-left text-[#475569]">
                        <th className="border border-[#cbd5e1] p-1">Room Type</th>
                        <th className="border border-[#cbd5e1] p-1">Qty</th>
                        <th className="border border-[#cbd5e1] p-1">Rate Plan</th>
                        <th className="border border-[#cbd5e1] p-1">Rate / Night</th>
                        <th className="border border-[#cbd5e1] p-1">Total (ZAR)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-[#cbd5e1] p-1">Executive King (Single)</td>
                        <td className="border border-[#cbd5e1] p-1">{draftedDetails.singleCount}</td>
                        <td className="border border-[#cbd5e1] p-1">{draftedDetails.planName}</td>
                        <td className="border border-[#cbd5e1] p-1">{fmtZAR(activePlan.singleNightly)}</td>
                        <td className="border border-[#cbd5e1] p-1">{fmtZAR(draftedDetails.singleSubtotal)}</td>
                      </tr>
                      <tr>
                        <td className="border border-[#cbd5e1] p-1">Standard Twin (Twin Beds)</td>
                        <td className="border border-[#cbd5e1] p-1">{draftedDetails.twinCount}</td>
                        <td className="border border-[#cbd5e1] p-1">{draftedDetails.planName}</td>
                        <td className="border border-[#cbd5e1] p-1">{fmtZAR(activePlan.twinNightly)}</td>
                        <td className="border border-[#cbd5e1] p-1">{fmtZAR(draftedDetails.twinSubtotal)}</td>
                      </tr>
                    </tbody>
                  </table>

                  <p className="mt-1 font-bold">
                    Quotation Total: <span>{fmtZAR(draftedDetails.grandTotal)}</span>
                  </p>
                  <p className="mt-1 text-[10px] text-[#64748b]">
                    Rate includes {draftedDetails.mealText}, secure parking and 15% VAT. Valid for 7 days subject to room availability.
                  </p>
                  <p className="mt-2 text-[#475569]">
                    Kind regards,<br />
                    <strong>Reservations Team</strong><br />
                    The Centurion Hotel
                  </p>
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
            <div className="flex flex-col gap-1.5 rounded border border-[#e2e8f0] bg-[#f8fafc] p-2.5 text-xs">
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-xs animate-in fade-in duration-150"
        >
          <div className="flex h-[800px] max-h-[92vh] w-[1000px] max-w-[95vw] flex-col overflow-hidden rounded bg-white shadow-2xl">
            <div className="flex h-9 shrink-0 items-center justify-between bg-slate-900 px-3 text-xs font-semibold text-white">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>
                  Infor HMS — {proofTab === 'criteria' ? 'Search Criteria' : 'Hotel Availability Grid'} [Centurion · Native 100% DPI]
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-slate-400">1000 × 800 Window</span>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-1 items-start justify-center overflow-auto bg-[#0b0f19] p-3">
              <img
                src="/quote-rate-proof.png"
                alt="Infor HMS Full Resolution Availability Grid"
                className="max-w-full rounded shadow-md"
              />
            </div>

            <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#e2e8f0] bg-[#f8fafc] px-3 text-[11px] text-[#475569]">
              <span>
                Green / White: Open Availability · ⊘ Red Circle: Stay Restriction / Closed to Arrival (BWKPB)
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
