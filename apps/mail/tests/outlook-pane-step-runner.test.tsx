/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';

const { sendCommandMock, executeStaffQuoteMutateMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  executeStaffQuoteMutateMock: vi.fn(),
}));

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
      internetMessageId: '<suite-availability@example.invalid>',
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

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-shared', email: 'centurion@legacyhotels.co.za' },
    isLoading: false,
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

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      staffQuoteSource: {
        query: async () => ({
          status: 'ready' as const,
          messageId: 'mail-1',
          threadId: 'thread-1',
          sourceHash: 'ab'.repeat(32),
        }),
      },
      executeStaffQuote: {
        mutate: (...args: unknown[]) => executeStaffQuoteMutateMock(...args),
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

type StaffQuoteRequest = {
  selectionEpoch: number;
  inputRevision: number;
  groups: Array<{ arrivalDate: string; departureDate: string }>;
};

/** A ready executeStaffQuote answer that echoes the request it answers. */
function readyStaffQuote(request: StaffQuoteRequest) {
  return {
    status: 'ready' as const,
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    messageId: 'mail-1',
    threadId: 'thread-1',
    factRefs: [],
    selectionEpoch: request.selectionEpoch,
    inputRevision: request.inputRevision,
    inputDigest: 'digest',
    totalMinor: 272000,
    currency: 'ZAR',
    arrivalDate: request.groups[0]?.arrivalDate,
    departureDate: request.groups[0]?.departureDate,
    description: 'Standard King',
  };
}

/** The stay facts executeStaffQuote needs: dates, a known board, quantity and adults. */
async function fillStayFacts(arrival: string, departure: string) {
  fireEvent.change(await screen.findByLabelText('Arrival'), { target: { value: arrival } });
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: departure } });
  fireEvent.change(screen.getByLabelText('Board'), { target: { value: 'bb' } });
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '1' } });
}

describe('mounted pane step runner and current inputs', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    executeStaffQuoteMutateMock.mockReset();
    executeStaffQuoteMutateMock.mockImplementation(async (request: StaffQuoteRequest) => readyStaffQuote(request));
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('runs the explicit step control with the current stay facts and revision', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    const perStep = await screen.findByRole('button', { name: /^Run Search availability 2026-11-12 → 2026-11-14/i });
    expect((perStep as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(perStep);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    expect(executeStaffQuoteMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mail-1',
        sourceHash: 'ab'.repeat(32),
        salesStrategy: 'BAR',
        inputRevision: expect.any(Number),
        groups: [
          expect.objectContaining({
            id: 'g1',
            arrivalDate: '2026-11-12',
            departureDate: '2026-11-14',
            quantity: 1,
            adults: 1,
            childrenAges: [],
            board: 'bb',
          }),
        ],
      }),
    );
  });

  it('replans the stay search after staff edit dates then sends the new stay', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-12-03' } });
    const perStep = await screen.findByRole('button', { name: /Run Search availability 2026-12-01 → 2026-12-03/i });
    fireEvent.click(perStep);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    const request = executeStaffQuoteMutateMock.mock.calls[0]?.[0] as {
      inputRevision: number;
      groups: Array<{ arrivalDate?: string; departureDate?: string; quantity?: number }>;
    };
    expect(request.inputRevision).toBeGreaterThan(1);
    expect(request.groups).toEqual([
      expect.objectContaining({ id: 'g1', arrivalDate: '2026-12-01', departureDate: '2026-12-03', quantity: 1 }),
    ]);
  });

  it('has no separate party lookup: the stay search runs from the stay facts alone', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    const stay = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((stay as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Look up organisation/i })).toBeNull();
    fireEvent.click(stay);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
  });

  it('releases a running step when executeStaffQuote rejects so retry works', async () => {
    executeStaffQuoteMutateMock.mockRejectedValueOnce(new Error('executeStaffQuote network down'));
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    fireEvent.click(await screen.findByRole('button', { name: /^Run Search availability/i }));
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    const retry = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(2));
  });
});
