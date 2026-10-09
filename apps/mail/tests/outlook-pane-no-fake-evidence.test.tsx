/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';

const sendCommandMock = vi.fn();

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      addinVersion: '1.0.12',
      bridgeProtocolVersion: 4,
      paired: true,
      outlookVersion: '16.0',
    },
    capabilities: {
      bridgeProtocolVersion: 4,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT', 'GET_ACTIVE_EMAIL'],
    },
    supportsAction: (action: string) =>
      action === 'CREATE_REPLY_DRAFT' || action === 'ADD_ATTACHMENT_TO_DRAFT',
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Need 3 rooms 12-14 November 2026.',
      bodyHtml: '<p>Need 3 rooms 12-14 November 2026.</p>',
    },
    sendCommand: sendCommandMock,
    pairDevice: vi.fn(),
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
    data: { id: 'transport-1', email: 'centurion@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: vi.fn() },
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

describe('production pane never synthesizes quote evidence', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue({
      entryId: 'draft-1',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      displayed: true,
    });
  });
  afterEach(() => cleanup());

  it('keeps integration unavailable and does not emit fixture offers, PDF, or native calls', async () => {
    render(<OutlookPanePage />);
    // Get rates waits for a room type on every row; the email gave none.
    fireEvent.change(await screen.findByLabelText('Room type'), { target: { value: 'STQN' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Get rates from HMS$/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/not available here|not owned by this quoting UI|integration unavailable|not ready yet|not connected to this pane/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Allocation/)).toBeNull();
    expect(screen.queryByText(/R2\s*720/)).toBeNull();
    expect(screen.queryByText(/Quote-fixture-not-live-hms/)).toBeNull();
    const pdfButton = screen.queryByRole('button', { name: /^Prepare PDF$/i });
    if (pdfButton) expect(pdfButton).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    expect(sendCommandMock.mock.calls.map((call) => call[0])).not.toContain('CREATE_REPLY_DRAFT');
    expect(sendCommandMock.mock.calls.map((call) => call[0])).not.toContain('ADD_ATTACHMENT_TO_DRAFT');
  });
});
