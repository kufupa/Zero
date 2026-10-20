/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';
import { fillStayFactsMatchingAuthorisedOffer, setReviewedReply } from './helpers/prepare-reviewed-quote';

const { sendCommandMock, quotePdfMutateMock, executeStaffQuoteMutateMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  quotePdfMutateMock: vi.fn(),
  executeStaffQuoteMutateMock: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

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
      bridgeProtocolVersion: 4,
    },
    capabilities: {
      bridgeProtocolVersion: 4,
      addinVersion: '1.0.11',
      outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows',
      newOutlookSupported: false,
      interactiveProfileRequired: true,
      maxPageSize: 200,
      maxFolderDepth: 64,
      maxFolderCount: 5000,
      maxFolderSnapshotItems: 5000,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT'],
    },
    supportsAction: (action: string) =>
      action === 'CREATE_REPLY_DRAFT' || action === 'ADD_ATTACHMENT_TO_DRAFT',
    requiresRelogin: false,
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      internetMessageId: '<suite-availability@example.invalid>',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Need 3 rooms 2026-11-12 to 2026-11-14.',
      bodyHtml: '<p>Need 3 rooms 2026-11-12 to 2026-11-14.</p>',
    },
    sendCommand: sendCommandMock,
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

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
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
      qualifiedQuoteProposalPdf: {
        mutate: (...args: unknown[]) => quotePdfMutateMock(...args),
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
              board: 'bb' as const,
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

/** A ready executeStaffQuote answer for one selected allocation, echoing the request it answers. */
function readyStaffQuote(request: StaffQuoteRequest) {
  return {
    status: 'ready' as const,
    workflowRunId: 'run-auth',
    revisionRef: 'rev-auth',
    messageId: 'mail-1',
    threadId: 'thread-1',
    factRefs: [],
    selectionEpoch: request.selectionEpoch,
    inputRevision: request.inputRevision,
    inputDigest: 'digest',
    totalMinor: AUTHORISED_QUOTE_PDF.totalMinor,
    currency: 'ZAR',
    arrivalDate: request.groups[0]?.arrivalDate,
    departureDate: request.groups[0]?.departureDate,
    description: 'Standard King',
  };
}

async function waitForAllocation(label: string) {
  return waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => (element.textContent ?? '').includes(label));
    if (!match) throw new Error(`expected allocation ${label}`);
    return match;
  });
}

async function startPendingPdf({ doubleClick = false }: { doubleClick?: boolean } = {}) {
  render(<OutlookPanePage />);
  await fillStayFactsMatchingAuthorisedOffer();
  fireEvent.click(await screen.findByRole('button', { name: /^Search availability$/i }));
  // A successful run selects its allocation already; clicking again would deselect it.
  const allocation = await waitForAllocation('Standard King');
  if (allocation.getAttribute('aria-pressed') !== 'true') fireEvent.click(allocation);
  // A draft needs a reviewed reply as well as a PDF, so a stale PDF would show up as a draft attempt.
  setReviewedReply(AUTHORISED_REPLY_HTML);
  const prepare = screen.getByRole('button', { name: 'Prepare PDF + reply' }) as HTMLButtonElement;
  if (doubleClick) {
    act(() => {
      fireEvent.click(prepare);
      fireEvent.click(prepare);
    });
  } else {
    fireEvent.click(prepare);
  }
  await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalled());
}

async function assertNoNativeDraft() {
  expect(screen.queryByText(/Prepared PDF/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
  const commands = sendCommandMock.mock.calls.map((call) => call[0]);
  expect(commands).not.toContain('CREATE_REPLY_DRAFT');
  expect(commands).not.toContain('ADD_ATTACHMENT_TO_DRAFT');
}

describe('deferred quote PDF / unavailable cannot mutate a newer session', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue({
      entryId: 'draft-1',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      displayed: true,
    });
    quotePdfMutateMock.mockReset();
    executeStaffQuoteMutateMock.mockReset();
    executeStaffQuoteMutateMock.mockImplementation(async (request: StaffQuoteRequest) => readyStaffQuote(request));
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  it('sends one single-stay PDF request when staff double-click the top action', async () => {
    const pending = deferred<typeof AUTHORISED_QUOTE_PDF>();
    quotePdfMutateMock.mockReturnValue(pending.promise);
    await startPendingPdf({ doubleClick: true });

    expect(quotePdfMutateMock).toHaveBeenCalledTimes(1);
    const pendingButtons = screen.getAllByRole('button', { name: 'Preparing PDF…' }) as HTMLButtonElement[];
    expect(pendingButtons).toHaveLength(2);
    expect(pendingButtons.every((button) => button.disabled)).toBe(true);

    await act(async () => {
      pending.resolve(AUTHORISED_QUOTE_PDF);
      await pending.promise;
    });
  });

  it('rejects a PDF that returns after the stay group is edited', async () => {
    const pending = deferred<typeof AUTHORISED_QUOTE_PDF>();
    quotePdfMutateMock.mockReturnValue(pending.promise);
    await startPendingPdf();
    // Adults per room is a stepper that the fill left at 1. Three + presses make 4.
    for (let press = 0; press < 3; press += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    }
    await act(async () => {
      pending.resolve(AUTHORISED_QUOTE_PDF);
      await pending.promise;
    });
    await assertNoNativeDraft();
  });

  it('rejects a PDF that returns after the sales strategy changes', async () => {
    const pending = deferred<typeof AUTHORISED_QUOTE_PDF>();
    quotePdfMutateMock.mockReturnValue(pending.promise);
    await startPendingPdf();
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'government' } });
    await act(async () => {
      pending.resolve(AUTHORISED_QUOTE_PDF);
      await pending.promise;
    });
    await assertNoNativeDraft();
  });

  it('rejects a late executeStaffQuote result after the stay group is edited', async () => {
    const pending = deferred<{ status: 'pending' }>();
    executeStaffQuoteMutateMock.mockReturnValue(pending.promise);
    render(<OutlookPanePage />);
    await fillStayFactsMatchingAuthorisedOffer();
    fireEvent.click(await screen.findByRole('button', { name: /^Search availability$/i }));
    // Adults per room is a stepper that the fill left at 1. Three + presses make 4.
    for (let press = 0; press < 3; press += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    }
    await act(async () => {
      pending.resolve({ status: 'pending' });
      await pending.promise;
    });
    expect(screen.queryByText('executeStaffQuote did not return a ready selected allocation.')).toBeNull();
    expect(screen.queryByText(/Prepared PDF/i)).toBeNull();
  });
});
