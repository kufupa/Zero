/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { toast } from 'sonner';

const { sendCommandMock, sessionState, COMBINED, OPTIONS } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  sessionState: { timeoutFirstCreate: false },
  // The one PDF that covers every date option (the server's combined document).
  COMBINED: {
    revisionId: 'quotes:both',
    pdfHash: '124dff05a6467fc826cdd3097cee8f35b69b85988fadeef713fb5a2ea072461d',
    fileName: 'Quote - Standard King.pdf',
    pdfBase64: 'JVBERi0xLjQgY29tYmluZWQ=',
    totalMinor: 408000,
  },
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

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
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
          mutate: async (input: { revisionRef: string; additionalStays?: unknown[] }) => {
            // Several date options come back as one combined document.
            if (input.additionalStays?.length) return { ...COMBINED, centsReconciled: true };
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

// A quote email's reply button reads "Draft quotation into email reply" (reply-body.tsx, quotationDraft). Multi-stay
// it still drafts the one combined reply, so this is the button under test.
const COMBINED_REPLY = 'Draft quotation into email reply';

/**
 * Runs one date option's staff search from its own stay card and waits for that card to show its rate
 * (the Available badge). The date options are stay cards now, not a separate picker.
 */
async function runOption(arrival: string): Promise<void> {
  const run = await screen.findByRole('button', { name: new RegExp(`^Run Search availability ${arrival}`) });
  const stayCard = run.closest('article') as HTMLElement;
  fireEvent.click(run);
  await waitFor(() => expect(within(stayCard).getByText('Available')).toBeDefined());
}

function topPrimaryButton(label: string): HTMLButtonElement {
  const button = screen
    .getAllByRole('button', { name: label })
    .find((candidate) => candidate.className.includes('bg-[#0066cc]'));
  if (!button) throw new Error(`Expected a primary "${label}" button.`);
  return button as HTMLButtonElement;
}

/** With every stay rated, one Make quote click makes the combined PDF for all of them. */
async function prepareCombinedQuote(): Promise<void> {
  await waitFor(() => expect(topPrimaryButton('Make quote').disabled).toBe(false));
  fireEvent.click(topPrimaryButton('Make quote'));
  await waitFor(() =>
    expect(screen.getByText(/Prepared quote Quote - Standard King\.pdf for all stays/)).toBeDefined(),
  );
}

async function draftCombinedReply(): Promise<void> {
  await waitFor(() =>
    expect((screen.getByRole('button', { name: COMBINED_REPLY }) as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: COMBINED_REPLY }));
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

  it('runs both date options, prepares one combined quote, and drafts one reply with it', async () => {
    render(<OutlookPanePage />);
    await runOption('2027-11-12');
    expect(screen.getAllByText('1 of 2 stays rated').length).toBeGreaterThan(0);
    await runOption('2027-12-01');
    await prepareCombinedQuote();
    await draftCombinedReply();
    expect(
      screen.getByText('Puts the quote for every date option into one email draft. Nothing is sent.'),
    ).toBeDefined();

    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(1));
    expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(1);
    const create = callsFor('CREATE_REPLY_DRAFT')[0]![1] as { htmlBody: string };
    expect(create.htmlBody).toContain('One quotation PDF covers all of them.');
    expect(create.htmlBody).toContain('Option A: 12–14 Nov 2027');
    expect(create.htmlBody).toContain('Option B: 1–3 Dec 2027');
    expect(create.htmlBody.match(/<table/g)).toHaveLength(2);
    expect(create.htmlBody).toMatch(/Option A total: R2\D*720\.00/);
    expect(create.htmlBody).toMatch(/Option B total: R1\D*360\.00/);
    expect(create.htmlBody).toMatch(/Total for all options: R4\D*080\.00/);

    const attachments = callsFor('ADD_ATTACHMENT_TO_DRAFT').map(
      ([, payload]) => payload as { fileName: string; base64Data: string; entryId: string },
    );
    expect(attachments.map((item) => item.fileName)).toEqual([COMBINED.fileName]);
    expect(attachments.map((item) => item.base64Data)).toEqual([COMBINED.pdfBase64]);
    expect(attachments.every((item) => item.entryId === 'draft-99')).toBe(true);

    const actions = new Set(sendCommandMock.mock.calls.map(([name]) => name));
    expect([...actions].every((name) => NATIVE_DRAFT_COMMANDS.has(name as string))).toBe(true);
    await waitFor(() => expect(screen.getByText(/Attached: Quote - Standard King\.pdf/)).toBeDefined());
  }, 30_000);

  it('has no per-option draft and sends the staff-edited combined reply', async () => {
    render(<OutlookPanePage />);
    await runOption('2027-11-12');
    await runOption('2027-12-01');
    await prepareCombinedQuote();
    expect(screen.queryByRole('button', { name: 'Draft option B only' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Combined reply'), {
      target: { value: '<p>Edited combined reply</p>' },
    });

    await draftCombinedReply();
    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(1));
    expect((callsFor('CREATE_REPLY_DRAFT')[0]![1] as { htmlBody: string }).htmlBody).toBe(
      '<p>Edited combined reply</p>',
    );
  }, 30_000);

  it('retries the same combined reply after an unknown outcome instead of starting a second draft', async () => {
    sessionState.timeoutFirstCreate = true;
    render(<OutlookPanePage />);
    await runOption('2027-11-12');
    await runOption('2027-12-01');
    await prepareCombinedQuote();

    await draftCombinedReply();
    await waitFor(() => expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(1));

    await draftCombinedReply();
    await waitFor(() => expect(callsFor('ADD_ATTACHMENT_TO_DRAFT')).toHaveLength(1));
    const [first, retry] = callsFor('CREATE_REPLY_DRAFT').map(
      ([, payload]) => payload as { operationId: string },
    );
    expect(callsFor('CREATE_REPLY_DRAFT')).toHaveLength(2);
    expect(retry!.operationId).toBe(first!.operationId);
    expect((callsFor('ADD_ATTACHMENT_TO_DRAFT')[0]![1] as { fileName: string }).fileName).toBe(
      COMBINED.fileName,
    );
  }, 30_000);
});
