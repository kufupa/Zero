/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const defaultMockEmail = {
  entryId: '001',
  storeId: 'store-1',
  subject: 'Suite Availability Request',
  senderEmail: 'guest@example.com',
  senderName: 'David Miller',
  receivedTime: '2026-09-17T12:00:00Z',
  bodyText: 'CIDB needs 3 rooms for 4 nights.',
  bodyHtml: '<p>CIDB needs 3 rooms for 4 nights.</p>',
};

const { sendCommandMock, pingMutateMock, activeEmailState } = vi.hoisted(() => ({
  sendCommandMock: vi.fn().mockResolvedValue({ success: true }),
  pingMutateMock: vi.fn().mockResolvedValue({
    status: 'ok',
    receivedUser: 'ropperman',
    receivedEmail: 'ropperman@legacyhotels.co.za',
    serverTime: '2026-09-25T09:30:00.000Z',
  }),
  activeEmailState: {
    current: {
      entryId: '001',
      storeId: 'store-1',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'We need 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    } as any,
  },
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
    activeEmail: activeEmailState.current,
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
      quoteProposalPdf: {
        mutate: vi.fn().mockResolvedValue({
          fileName: 'Quote - CIDB 15-17 Sep.pdf',
          pdfBase64: 'JVBERw==',
        }),
      },
    },
  },
}));

describe('OutlookPane Onboarding Flow', () => {
  beforeEach(() => {
    localStorage.clear();
    activeEmailState.current = { ...defaultMockEmail };
    pingMutateMock.mockReset();
    pingMutateMock.mockResolvedValue({
      status: 'ok',
      receivedUser: 'ropperman',
      receivedEmail: 'ropperman@legacyhotels.co.za',
      serverTime: '2026-09-25T09:30:00.000Z',
    });
    sendCommandMock.mockClear();
  });

  afterEach(() => {
    cleanup();
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

    expect(screen.getByText(/Connecting to Nava AI Services/i)).toBeDefined();

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
      expect(screen.getByText(/Nava AI server connected/i)).toBeDefined();
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

  it('correctly updates arrival and departure based on activeDateTab and clamps stay within September', () => {
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));

    // Open calendar
    fireEvent.click(screen.getByText(/Change Dates/i));

    // By default activeDateTab is arrival (15)
    // Click day 20 -> arrival becomes 20, departure becomes at least 21
    fireEvent.click(screen.getByRole('button', { name: '20' }));
    expect(screen.getByText('2026-09-20')).toBeDefined();

    // Switch to departure tab
    fireEvent.click(screen.getByText(/Departure Date/i));
    // Click day 25 -> departure becomes 25, nights count is 5
    fireEvent.click(screen.getByRole('button', { name: '25' }));
    expect(screen.getByText('2026-09-25')).toBeDefined();
    expect(screen.getAllByText(/5 Nights/i).length).toBeGreaterThan(0);

    // Quick nights 7 when arrival is 20 -> should clamp departure to 27 or month-end (not 31)
    fireEvent.click(screen.getByRole('button', { name: /7 Nights/i }));
    expect(screen.getByText('2026-09-27')).toBeDefined();
  });

  it('displays Sample badge when no active email is present from bridge', () => {
    activeEmailState.current = null;
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    expect(screen.getByText('Sample')).toBeDefined();
    expect(screen.queryByText('Synced')).toBeNull();
  });
});


