/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';

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
      addinVersion: '1.0.11',
      bridgeProtocolVersion: 4,
    },
    capabilities: null,
    supportsAction: () => true,
    activeEmail: activeEmailState.current,
    sendCommand: sendCommandMock,
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: 'session-1' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
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
    quoteWorkflow: {
      analyseSelection: {
        mutate: async () => ({
          status: 'ready' as const,
          intent: 'quote' as const,
          groups: [
            {
              id: 'g1',
              childrenAges: [],
              board: 'unknown' as const,
              quantity: 1,
              specialRequests: [],
              fields: { arrivalDate: 'missing' as const, departureDate: 'missing' as const, adults: 'missing' as const },
            },
          ],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
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

  it('keeps diagnostics server ping available when no approved Inbox folder is listed', async () => {
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'PING')
        return { version: '1.0.12', bridgeProtocolVersion: 4, paired: true, deviceId: 'device-1' };
      if (action === 'GET_ACTIVE_EMAIL') return { subject: 'Availability' };
      if (action === 'LIST_FOLDERS') return { items: [], truncated: false };
      throw new Error('GET_FOLDER_EMAILS must not guess the Inbox folder');
    });
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /Run system check/i }));
    await waitFor(() =>
      expect(pingMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          outlookEmail: 'ropperman@legacyhotels.co.za',
        }),
      ),
    );
    expect(sendCommandMock.mock.calls.some(([action]) => action === 'GET_FOLDER_EMAILS')).toBe(
      false,
    );
  });

  it('marks the folder diagnostic unavailable yet still checks the server when folder enumeration fails', async () => {
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'PING')
        return { version: '1.0.12', bridgeProtocolVersion: 4, paired: true, deviceId: 'device-1' };
      if (action === 'GET_ACTIVE_EMAIL') return { subject: 'Availability' };
      if (action === 'LIST_FOLDERS') throw new Error('No approved folder scope');
      throw new Error('GET_FOLDER_EMAILS must not infer the Inbox');
    });
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /Run system check/i }));
    await waitFor(() =>
      expect(pingMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          outlookEmail: 'ropperman@legacyhotels.co.za',
        }),
      ),
    );
    expect(sendCommandMock.mock.calls.some(([action]) => action === 'GET_FOLDER_EMAILS')).toBe(
      false,
    );
  });

  it('progresses to Screen 2 Diagnostics, pings server, and displays returned server UTC timestamp', async () => {
    render(<OutlookPanePage />);
    const confirmBtn = screen.getByRole('button', { name: /Confirm Account & Connect/i });
    fireEvent.click(confirmBtn);

    expect(screen.getByText(/Connecting to Nava AI Services/i)).toBeDefined();

    await waitFor(() => {
      expect(pingMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workstationUser: 'unknown',
          outlookEmail: 'ropperman@legacyhotels.co.za',
          outlookVersion: 'unknown',
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

  it('correctly opens the quote tool without a September RATE_TABLE calendar', async () => {
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    expect(screen.getByText(/Nava AI Reservationist/i)).toBeDefined();
    expect(screen.queryByText(/September 2026/i)).toBeNull();
    expect(screen.queryByText(/Change Dates/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Search Availability$/i })).toBeNull();
    expect(await screen.findByRole('button', { name: /^Run next$/i })).toBeDefined();
  });

  it('displays Sample badge when no active email is present from bridge', () => {
    activeEmailState.current = null;
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    expect(screen.getByText('Sample')).toBeDefined();
    expect(screen.queryByText('Synced')).toBeNull();
  });
});
