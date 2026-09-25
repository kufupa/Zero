# Real Outlook Side Pane Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 4-step onboarding flow (Welcome with auto-detected Outlook COM email, Diagnostics with real TRPC server ping handshake returning UTC timestamp, 3-Slide Feature Tour, and Quoting Tool) into the production Next.js Outlook Pane (`apps/mail/app/(routes)/outlook-pane/page.tsx`), verified with comprehensive unit tests and deployed live to EC2.

**Architecture:** Extend the existing Next.js React page with a typed screen state machine (`welcome` | `diagnostics` | `tour` | `tool`) and a top step switcher bar. Auto-detect the user's Outlook account from `useOutlookBridge().workstationInfo.outlookEmail` (fallback to Better Auth session), execute a real client-to-server handshake via `trpcClient.workstation.ping.mutate({ workstationUser, outlookEmail, outlookVersion })`, display the returned server UTC timestamp to turn green, run through the approved 3-slide tour, persist onboarding completion to `localStorage`, and seamlessly transition into the existing Infor HMS Quoting Tool.

**Tech Stack:** React 19 / Next.js 15 App Router, TypeScript, tRPC client & server router, Tailwind CSS, Lucide React icons, Vitest & Happy-DOM, AWS SSM deployment scripts to Ubuntu EC2.

## Global Constraints

- **Preserve Quoting Tool:** Do NOT modify the quoting tool UI calculation, rate table, calendar, or reply draft insertion logic. The user explicitly stated: *"don't worry about the quoting screen, just the onboarding"*.
- **Auto-detected Email:** Screen 1 must display the Outlook account detected via COM bridge (`workstationInfo.outlookEmail`), falling back to `session.user.email` or `'reservations@centurion.co.za'`.
- **Client-to-Server Ping Handshake:** Screen 2 must pipe `{ workstationUser, outlookEmail, outlookVersion }` to `trpcClient.workstation.ping.mutate()`.
- **Server Timestamp Verification:** Screen 2 must display the returned `serverTime` in UTC format (`Centurion Hotel · Server pinged at YYYY-MM-DD HH:mm:ss UTC · Active`) with loading state and only turn green once confirmed.
- **Tour Copy Fidelity:** Screen 3 must render the 3 slides with the exact wording requested:
  - Slide 1: Direct HMS pre-fill first, then check email vs AI auto-filled details.
  - Slide 2: Automated execution, then inspect live Infor HMS audit capture (full-screen 1000×800).
  - Slide 3: Drafted responses & actions, check details and tone before sending email, expanding capabilities.
- **Top Step Switcher & Persistence:** Provide top switcher pills (`1. Welcome`, `2. Connection`, `3. Tour`, `4. Quote Tool`) so users and testers can switch between screens at will; persist completion (`localStorage.getItem('nava_onboarding_completed')`) so returning users default to the quoting tool.
- **Discreet Footer:** Keep the minimalist contact footnote on all screens: `aroransh17@gmail.com · WhatsApp: +44 7505 014078`.
- **380px Strict Containment:** Light mode styling with Segoe UI typography, zero horizontal scrolling (`scrollWidth <= 380px`).

---

## File Structure

- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx`
  - Add screen state machine (`currentScreen`, `currentTourSlide`, `pingStatus`, `serverTimeText`, `pingError`).
  - Add top step navigation bar and Reset action.
  - Render Screen 1: Welcome & Mailbox Detection card with detected email & property.
  - Render Screen 2: System & Infor HMS Bridge Check with live TRPC `workstation.ping` call, loading spinner, returned UTC timestamp display, and green verification banner.
  - Render Screen 3: 3-Slide Quick Tour Primer with carousel dots, Prev/Next navigation, and completion trigger.
  - Render Screen 4: Existing Infor HMS Quoting Tool (unaltered).
- Modify: `apps/mail/tests/outlook-pane-render.test.tsx`
  - Ensure existing 23 quoting tool render tests continue to pass by setting `localStorage.setItem('nava_onboarding_completed', 'true')` in test setup or defaulting appropriately.
- Create: `apps/mail/tests/outlook-pane-onboarding.test.tsx`
  - Unit tests specifically validating the 4 onboarding screens, bridge email detection, tRPC ping mutation with returned UTC timestamp, tour slide transitions, and step switcher navigation.

---

## Task Decomposition

### Task 1: Write Unit Tests for the Complete Onboarding Journey

**Files:**
- Create: `apps/mail/tests/outlook-pane-onboarding.test.tsx`
- Modify: `apps/mail/tests/outlook-pane-render.test.tsx:90-102`

**Interfaces:**
- Consumes: `<OutlookPanePage />`, mocked `useOutlookBridge`, mocked `useSession`, mocked `trpcClient.workstation.ping.mutate`.
- Produces: Test suite validating Screen 1, Screen 2 (loading $\rightarrow$ server time $\rightarrow$ green), Screen 3 (slides 0, 1, 2), Screen 4 transition, and step navigation.

- [ ] **Step 1: Create the onboarding test file with comprehensive test cases**

```tsx
/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { sendCommandMock, pingMutateMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn().mockResolvedValue({ success: true }),
  pingMutateMock: vi.fn().mockResolvedValue({
    status: 'ok',
    receivedUser: 'ropperman',
    receivedEmail: 'ropperman@legacyhotels.co.za',
    serverTime: '2026-09-25T09:30:00.000Z',
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      workstationUser: 'ropperman',
      outlookEmail: 'ropperman@legacyhotels.co.za',
      outlookVersion: '16.0',
      addinVersion: '1.0.11',
      bridgeProtocolVersion: 3,
    },
    capabilities: null,
    supportsAction: () => true,
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'We need 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    },
    sendCommand: sendCommandMock,
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: { user: { email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' } },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: pingMutateMock },
    },
  },
}));

describe('OutlookPane Onboarding Flow', () => {
  beforeEach(() => {
    localStorage.clear();
    pingMutateMock.mockClear();
    sendCommandMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders Screen 1 Welcome with auto-detected Outlook email and property info', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/Welcome to Nava AI/i)).toBeDefined();
    expect(screen.getByText('ropperman@legacyhotels.co.za')).toBeDefined();
    expect(screen.getByText(/The Centurion Hotel/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Confirm Account & Connect/i })).toBeDefined();
  });

  it('progresses to Screen 2 Diagnostics, pings server, and displays returned server UTC timestamp', async () => {
    render(<OutlookPanePage />);
    const confirmBtn = screen.getByRole('button', { name: /Confirm Account & Connect/i });
    fireEvent.click(confirmBtn);

    expect(screen.getByText(/Connecting to Infor HMS/i)).toBeDefined();

    await waitFor(() => {
      expect(pingMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workstationUser: 'ropperman',
          outlookEmail: 'ropperman@legacyhotels.co.za',
          outlookVersion: '16.0',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Server pinged at 2026-09-25 09:30:00 UTC/i)).toBeDefined();
      expect(screen.getByText(/Connected to Centurion Hotel/i)).toBeDefined();
    });

    expect(screen.getByRole('button', { name: /Next: 60-Second Feature Tour/i })).toBeDefined();
  });

  it('navigates through the 3 tour slides with exact requested wording and dots', async () => {
    render(<OutlookPanePage />);
    // Navigate to step 3 via top switcher
    fireEvent.click(screen.getByRole('button', { name: /3\. Tour/i }));

    // Slide 1
    expect(screen.getByText(/1\. Automatic Email Sync/i)).toBeDefined();
    expect(screen.getByText(/Direct HMS pre-fill:/i)).toBeDefined();
    expect(screen.getByText(/Verify auto-filled details:/i)).toBeDefined();

    // Move to Slide 2
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(screen.getByText(/2\. Live Infor HMS Actions & Proof/i)).toBeDefined();
    expect(screen.getByText(/Automated execution:/i)).toBeDefined();
    expect(screen.getByText(/Inspect screenshot proof:/i)).toBeDefined();

    // Move to Slide 3
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(screen.getByText(/3\. Assisted Responses & Actions/i)).toBeDefined();
    expect(screen.getByText(/Drafted responses & actions:/i)).toBeDefined();
    expect(screen.getByText(/Check details & tone:/i)).toBeDefined();
    expect(screen.getByText(/Expanding capabilities:/i)).toBeDefined();

    // Click "Open Nava AI" to reach tool
    const openBtn = screen.getByRole('button', { name: /Open Nava AI/i });
    fireEvent.click(openBtn);

    expect(screen.getByText(/Nava AI Reservationist/i)).toBeDefined();
    expect(localStorage.getItem('nava_onboarding_completed')).toBe('true');
  });

  it('supports direct switching between steps via top switcher bar', () => {
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    expect(screen.getByText(/Nava AI Reservationist/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /1\. Welcome/i }));
    expect(screen.getByText(/Welcome to Nava AI/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Update existing `tests/outlook-pane-render.test.tsx` test setup**

In `apps/mail/tests/outlook-pane-render.test.tsx`, ensure `localStorage.setItem('nava_onboarding_completed', 'true')` is set in `beforeEach` so all existing 23 quoting tool render tests run directly against the Tool screen without requiring manual step traversal.

- [ ] **Step 3: Run the new test to verify failure**

Run: `pnpm --filter @zero/mail exec vitest run tests/outlook-pane-onboarding.test.tsx`
Expected: FAIL (because `page.tsx` does not yet render the onboarding screens or top switcher).

---

### Task 2: Implement Onboarding Flow State Machine in `OutlookPanePage`

**Files:**
- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx`

**Interfaces:**
- Consumes:
  - `workstationInfo = useOutlookBridge().workstationInfo`
  - `session = useSession().data`
  - `trpcClient.workstation.ping.mutate({ workstationUser, outlookEmail, outlookVersion })`
- Produces:
  - `currentScreen`: `'welcome' | 'diagnostics' | 'tour' | 'tool'`
  - Top switcher navigation bar with active highlights
  - Screen 1 (Welcome & Detected Email Card)
  - Screen 2 (HMS Bridge Check & Live TRPC Server Time)
  - Screen 3 (3-Slide Tour with dynamic dots and copy)
  - Screen 4 (Preserved Quoting Tool)
  - Persistent completion in `localStorage`

- [ ] **Step 1: Add state and types for Onboarding**

Add:
```tsx
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
```

- [ ] **Step 2: Add screen controller and handshake logic**

In `OutlookPanePage`:
- Initialize `currentScreen` state:
  ```tsx
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
  ```
- Compute detected email:
  ```tsx
  const detectedEmail =
    workstationInfo?.outlookEmail || session?.user?.email || 'reservations@centurion.co.za';
  const detectedProperty = workstationInfo?.workstationUser
    ? `${workstationInfo.workstationUser} · The Centurion Hotel`
    : 'The Centurion Hotel';
  ```
- Implement `executeServerPing`:
  ```tsx
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
  ```

- [ ] **Step 3: Implement the Views (Screen 1, 2, 3, 4) with Top Switcher**

Render the top bar:
```tsx
<div className="flex w-full items-center justify-between border-b border-[#e2e8f0] bg-white px-3 py-1.5 text-xs">
  <div className="flex items-center gap-1 font-semibold text-[#1e293b]">
    <span className="h-2 w-2 rounded-full bg-emerald-500" />
    <span>Nava AI</span>
  </div>
  <div className="flex items-center gap-1">
    {(['welcome', 'diagnostics', 'tour', 'tool'] as const).map((s, idx) => {
      const labels = ['1. Welcome', '2. Connection', '3. Tour', '4. Quote Tool'];
      return (
        <button
          key={s}
          type="button"
          onClick={() => {
            setCurrentScreen(s);
            if (s === 'diagnostics' && pingState === 'idle') {
              void executeServerPing();
            }
          }}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            currentScreen === s
              ? 'bg-[#1a4332] text-white font-semibold'
              : 'text-[#64748b] hover:bg-[#f1f3f6]'
          }`}
        >
          {labels[idx]}
        </button>
      );
    })}
  </div>
</div>
```

Render Screen 1: Welcome & Mailbox Detection
```tsx
{currentScreen === 'welcome' && (
  <div className="flex flex-1 flex-col p-4 animate-in fade-in duration-150">
    <div className="mb-4 flex flex-col items-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eaf4ee] text-[#1a4332]">
        <Building2 className="h-6 w-6" />
      </div>
      <h1 className="text-base font-bold text-[#1e293b]">Welcome to Nava AI</h1>
      <p className="mt-1 text-xs text-[#64748b]">
        Your intelligent assistant for Infor HMS quoting and reservations, built directly into Outlook.
      </p>
    </div>

    <div className="mb-6 rounded border border-[#e2e8f0] bg-[#f8fafc] p-3">
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
)}
```

Render Screen 2: System & Infor HMS Bridge Check
```tsx
{currentScreen === 'diagnostics' && (
  <div className="flex flex-1 flex-col p-4 animate-in fade-in duration-150">
    <div className="mb-4 flex flex-col items-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eff6ff] text-[#0066cc]">
        <Network className="h-6 w-6" />
      </div>
      <h1 className="text-base font-bold text-[#1e293b]">Connecting to Infor HMS</h1>
      <p className="mt-1 text-xs text-[#64748b]">
        Verifying connection and live hotel property status.
      </p>
    </div>

    <div className="mb-4 space-y-2">
      <div
        className={`flex items-start gap-2.5 rounded border p-3 ${
          pingState === 'success'
            ? 'border-emerald-200 bg-emerald-50/50'
            : pingState === 'error'
              ? 'border-rose-200 bg-rose-50/50'
              : 'border-[#e2e8f0] bg-white'
        }`}
      >
        {pingState === 'loading' && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[#0066cc]" />}
        {pingState === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
        {pingState === 'error' && <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />}
        {pingState === 'idle' && <Clock className="h-4 w-4 shrink-0 text-slate-400" />}

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
              `Centurion Hotel · Server pinged at ${serverPingTimeStr} · Active`}
            {pingState === 'loading' && `Pinging server from ${detectedEmail}…`}
            {pingState === 'error' && (pingErrorMessage || 'Failed to connect to server')}
            {pingState === 'idle' && 'Waiting to initiate handshake…'}
          </div>
        </div>
      </div>
    </div>

    {pingState === 'success' && (
      <div className="mb-4 flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] font-medium text-emerald-800">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <span>Connected to Centurion Hotel. Ready for live operations.</span>
      </div>
    )}

    {pingState === 'error' && (
      <Button
        type="button"
        onClick={() => void executeServerPing()}
        className="mb-3 w-full bg-rose-600 text-xs text-white hover:bg-rose-700"
      >
        Retry Connection
      </Button>
    )}

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
)}
```

Render Screen 3: 3-Slide Quick Tour Primer
```tsx
{currentScreen === 'tour' && (
  <div className="flex flex-1 flex-col p-3 animate-in fade-in duration-150">
    <div className="flex flex-1 flex-col items-center justify-center rounded border border-[#e2e8f0] bg-white p-4 text-center">
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
        {TOUR_SLIDES[tourSlideIndex]?.bullets.map((b, i) => (
          <div key={i} className="flex items-start gap-2 rounded bg-[#f8fafc] p-2 text-xs">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <div>
              <strong className="text-[#1e293b]">{b.title}</strong>{' '}
              <span className="text-[#475569]">{b.desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>

    {/* Dots */}
    <div className="my-3 flex justify-center gap-1.5">
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
    <div className="flex items-center gap-2">
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
)}
```

Render Screen 4: Existing Quoting Tool
Wrap the existing Quoting Tool JSX in `{currentScreen === 'tool' && (...) }`.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @zero/mail exec vitest run tests/outlook-pane-onboarding.test.tsx`
Expected: PASS (4/4 tests pass).

- [ ] **Step 5: Run existing render and auth tests**

Run: `pnpm --filter @zero/mail exec vitest run tests/outlook-pane-render.test.tsx tests/outlook-pane-auth.test.tsx`
Expected: PASS (24/24 tests pass).

- [ ] **Step 6: Commit changes**

```bash
git add apps/mail/app/\(routes\)/outlook-pane/page.tsx apps/mail/tests/outlook-pane-onboarding.test.tsx apps/mail/tests/outlook-pane-render.test.tsx
git commit -m "feat(outlook-pane): wire real client-to-server onboarding flow with COM email detection and ping handshake"
```

---

### Task 3: Local Build & Verification

**Files:**
- None (verification of full `@zero/mail` workspace build).

- [ ] **Step 1: Run typecheck and build**

Run: `pnpm --filter @zero/mail build`
Expected: Next.js build succeeds with zero TypeScript errors and compiles `/outlook-pane`.

- [ ] **Step 2: Commit if any build adjustments needed**

---

### Task 4: EC2 Deployment & Live Verification

**Files:**
- Target Server: `i-008f737974a9ba9b3` (`172.31.12.112`, `https://nava.legacyhotels.co.za/outlook-pane`)

- [ ] **Step 1: Sync Git bundle to EC2**

Run:
```bash
GIT_BRANCH=feat/centurion-dashboard-tools bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```
Expected: Git bundle transfers to EC2 and unbundles to `origin/feat/centurion-dashboard-tools`.

- [ ] **Step 2: Execute `--quiesced` deployment on EC2 via SSM**

Run:
```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo -u ubuntu -i bash -c "cd /home/ubuntu/zero && git checkout feat/centurion-dashboard-tools && git pull && bash apps/server-pilot/deploy/deploy-ec2.sh --quiesced"'
```
Expected: Deploys Next.js SPA bundle, restarts PM2/systemd gracefully, and logs HTTP 200 health check.

- [ ] **Step 3: Verify live URL**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://nava.legacyhotels.co.za/outlook-pane
```
Expected: `200`
Fetch page HTML to ensure Next.js assets load and contain `outlook-pane` markup.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-25-outlook-pane-onboarding-real-wiring.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
