/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { toast } from 'sonner';

const { sendCommandMock, sessionState, OPTIONS } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  sessionState: { timeoutFirstCreate: false },
  OPTIONS: [
    {
      revisionRef: 'rev-a',
      arrivalDate: '2027-11-12',
      departureDate: '2027-11-14',
      totalMinor: 272000,
      fileName: 'Quote-rev-a.pdf',
      pdfBase64: 'JVBERi0xLjQgcmV2LWE=',
      pdfHash: '762314048df41a0a67232a709d31c5250ccb7c88841e594c93ad2d25edde199a',
    },
    {
      revisionRef: 'rev-b',
      arrivalDate: '2027-12-01',
      departureDate: '2027-12-03',
      totalMinor: 136000,
      fileName: 'Quote-rev-b.pdf',
      pdfBase64: 'JVBERi0xLjQgcmV2LWI=',
      pdfHash: '271b2a9c595e3c2188afb84b87ffbe407294502491c01f5c424e4c2986782df1',
    },
  ],
}));

const NATIVE_DRAFT_COMMANDS = new Set([
  'GET_ACTIVE_EMAIL',
  'CREATE_REPLY_DRAFT',
  'ADD_ATTACHMENT_TO_DRAFT',
]);

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
      subject: 'Two date options',
      internetMessageId: '<two-dates@example.invalid>',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-10-08T12:00:00Z',
      bodyText: 'Could you quote 12-14 Nov or 1-3 Dec?',
      bodyHtml: '<p>Could you quote 12-14 Nov or 1-3 Dec?</p>',
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

vi.mock('../providers/query-provider', () => {
  const optionFor = (groups: Array<{ arrivalDate: string }>) =>
    OPTIONS.find((option) => option.arrivalDate === groups[0]?.arrivalDate)!;
  return {
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
          mutate: async (input: {
            selectionEpoch: number;
            inputRevision: number;
            groups: Array<{ arrivalDate: string }>;
          }) => {
            const option = optionFor(input.groups);
            return {
              status: 'ready' as const,
              workflowRunId: `run-${option.revisionRef}`,
              revisionRef: option.revisionRef,
              messageId: 'mail-1',
              threadId: 'thread-1',
              factRefs: [],
              selectionEpoch: input.selectionEpoch,
              inputRevision: input.inputRevision,
              inputDigest: `digest-${option.revisionRef}`,
              totalMinor: option.totalMinor,
              currency: 'ZAR',
              arrivalDate: option.arrivalDate,
              departureDate: option.departureDate,
              description: 'Standard King',
            };
          },
        },
        qualifiedQuoteProposalPdf: {
          mutate: async (input: { revisionRef: string }) => {
            const option = OPTIONS.find((item) => item.revisionRef === input.revisionRef)!;
            return {
              revisionId: option.revisionRef,
              pdfHash: option.pdfHash,
              fileName: option.fileName,
              pdfBase64: option.pdfBase64,
              totalMinor: option.totalMinor,
              centsReconciled: true,
            };
          },
        },
      },
      drafts: {
        list: { query: async () => [] },
      },
      quoteWorkflow: {
        analyseSelection: {
          mutate: async () => ({
            status: 'ready' as const,
            intent: 'quote' as const,
            groups: OPTIONS.map((option, index) => ({
              id: `stay-${index === 0 ? 'a' : 'b'}`,
              arrivalDate: option.arrivalDate,
              departureDate: option.departureDate,
              quantity: 1,
              roomPreference: 'SKNG',
              adults: 1,
              childrenAges: [],
              board: 'bb' as const,
              specialRequests: [],
              fields: {
                arrivalDate: 'extracted' as const,
                departureDate: 'extracted' as const,
                adults: 'extracted' as const,
              },
            })),
            secondaryAsks: [],
            alternatives: [],
            sourceRevision: 1,
          }),
        },
      },
    },
  };
});

async function quoteOption(letter: 'A' | 'B', arrival: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(`^Run Search availability ${arrival}`) }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: `Prepare PDF for option ${letter}` })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole('button', { name: `Prepare PDF for option ${letter}` }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: new RegExp(`^Select date scope ${arrival}`) }).textContent,
    ).toMatch(/PDF ready/),
  );
}

function callsFor(action: string) {
  return sendCommandMock.mock.calls.filter(([name]) => name === action);
}

describe('Outlook pane: one reply for every completed date option', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sessionState.timeoutFirstCreate = false;
    sendCommandMock.mockReset();
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL')
        return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      if (
        action === 'CREATE_REPLY_DRAFT' &&
        sessionState.timeoutFirstCreate &&
        callsFor('CREATE_REPLY_DRAFT').length === 1
      ) {
        throw new Error('Bridge command CREATE_REPLY_DRAFT timed out');
      }
      if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
      return {
        entryId: 'draft-99',
        storeId: 'store-1',
        folderEntryId: 'folder-drafts',
        displayed: true,
      };
    });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    cleanup();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  it('keeps the single-option label until a second option has its PDF, then drafts all options together', async () => {
    render(<OutlookPanePage />);
    await quoteOption('A', '2027-11-12');
    expect(screen.getByRole('button', { name: /Insert Draft in Outlook/i })).toBeDefined();
    expect(
      screen.queryByRole('button', { name: /Create one reply with all date options/ }),
    ).toBeNull();

    await quoteOption('B', '2027-12-01');
    expect(screen.getByText('Use Draft option B only below for this option.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Draft option B only' })).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Create one reply with all date options (A, B)' }),
    );
    expect(
      screen.getByText('Puts every option you ran into one email draft. Nothing is sent.'),
    ).toBeDefined();

    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(2));
    expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(1);
    const create = callsFor('CREATE_REPLY_DRAFT')[0]![1] as { htmlBody: string };
    expect(create.htmlBody).toContain('Option A: 12–14 Nov 2027');
    expect(create.htmlBody).toContain('Option B: 1–3 Dec 2027');
    expect(create.htmlBody.match(/<table/g)).toHaveLength(2);
    expect(create.htmlBody).toMatch(/Option A total: R2\D*720\.00/);
    expect(create.htmlBody).toMatch(/Option B total: R1\D*360\.00/);

    const attachments = callsFor('ADD_ATTACHMENT_TO_DRAFT').map(
      ([, payload]) =>
        payload as {
          operationId: string;
          entryId: string;
          fileName: string;
          base64Data: string;
        },
    );
    expect(attachments.map((item) => item.fileName)).toEqual([
      'Quote-rev-a - Option A.pdf',
      'Quote-rev-b - Option B.pdf',
    ]);
    expect(attachments.map((item) => item.base64Data)).toEqual([
      OPTIONS[0]!.pdfBase64,
      OPTIONS[1]!.pdfBase64,
    ]);
    expect(new Set(attachments.map((item) => item.operationId)).size).toBe(2);
    expect(attachments.every((item) => item.entryId === 'draft-99')).toBe(true);

    const actions = new Set(sendCommandMock.mock.calls.map(([name]) => name));
    expect([...actions].every((name) => NATIVE_DRAFT_COMMANDS.has(name as string))).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByText(/Attached: Quote-rev-a - Option A\.pdf, Quote-rev-b - Option B\.pdf/),
      ).toBeDefined(),
    );
  });

  it('keeps a per-option draft for the selected option with only its own PDF', async () => {
    render(<OutlookPanePage />);
    await quoteOption('A', '2027-11-12');
    await quoteOption('B', '2027-12-01');
    fireEvent.change(screen.getByLabelText('Reviewed reply'), {
      target: { value: '<p>Option B only</p>' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Draft option B only' }));
    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(1));
    expect((callsFor('CREATE_REPLY_DRAFT')[0]![1] as { htmlBody: string }).htmlBody).toBe(
      '<p>Option B only</p>',
    );
    expect((callsFor('ADD_ATTACHMENT_TO_DRAFT')[0]![1] as { fileName: string }).fileName).toBe(
      'Quote-rev-b.pdf',
    );
    expect((callsFor('ADD_ATTACHMENT_TO_DRAFT')[0]![1] as { base64Data: string }).base64Data).toBe(
      OPTIONS[1]!.pdfBase64,
    );
  });

  it('will not start a different draft while an earlier reply may already be in Outlook Drafts', async () => {
    sessionState.timeoutFirstCreate = true;
    render(<OutlookPanePage />);
    await quoteOption('A', '2027-11-12');
    await quoteOption('B', '2027-12-01');
    fireEvent.change(screen.getByLabelText('Reviewed reply'), {
      target: { value: '<p>Option B only</p>' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Draft option B only' }));
    await waitFor(() => expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Draft option B only' }).hasAttribute('disabled'),
      ).toBe(false),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Create one reply with all date options (A, B)' }),
    );
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Retry it with its own button/));
    expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Draft option B only' }));
    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(1));
    const [first, retry] = callsFor('CREATE_REPLY_DRAFT').map(
      ([, payload]) => payload as { operationId: string },
    );
    expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(2);
    expect(retry!.operationId).toBe(first!.operationId);
    expect((callsFor('ADD_ATTACHMENT_TO_DRAFT')[0]![1] as { fileName: string }).fileName).toBe(
      'Quote-rev-b.pdf',
    );
  });
});
