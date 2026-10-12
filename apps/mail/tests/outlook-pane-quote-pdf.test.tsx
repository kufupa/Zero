/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { toast } from 'sonner';
import { findReadStayArrival, prepareReviewedQuote } from './helpers/prepare-reviewed-quote';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';

const { sendCommandMock, quotePdfMutateMock, quoteWorkbookMutateMock, prepareDraftMutateMock, analyseOverride, sessionState } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  quotePdfMutateMock: vi.fn(),
  quoteWorkbookMutateMock: vi.fn(),
  prepareDraftMutateMock: vi.fn(),
  // Tests opt in to a Luna read-out (e.g. create_booking); null keeps the default analysis.
  analyseOverride: { current: null as ((input: unknown) => Promise<unknown>) | null },
  sessionState: {
    userId: 'staff-1',
    sessionId: 'session-1',
    email: 'ropperman@legacyhotels.co.za',
    outlookEmail: 'ropperman@legacyhotels.co.za',
    transportId: 'transport-shared',
    transportEmail: 'centurion@legacyhotels.co.za',
    requiresRelogin: false,
    nativeSelectedEntryId: '001',
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
      outlookEmail: sessionState.outlookEmail,
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
    requiresRelogin: sessionState.requiresRelogin,
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      internetMessageId: '<suite-availability@example.invalid>',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'CIDB needs 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    },
    sendCommand: sendCommandMock,
  }),
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: sessionState.transportId
      ? { id: sessionState.transportId, email: sessionState.transportEmail }
      : null,
    isLoading: false,
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: sessionState.userId
      ? {
          user: { id: sessionState.userId, email: sessionState.email, name: 'R Opperman' },
          session: { id: sessionState.sessionId },
        }
      : null,
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
      quoteProposalPdf: { mutate: quotePdfMutateMock },
      quoteWorkbook: { mutate: quoteWorkbookMutateMock },
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
          groups: Array<{ arrivalDate: string; departureDate: string }>;
        }) => ({
          status: 'ready' as const,
          workflowRunId: 'run-1',
          revisionRef: 'rev-auth',
          messageId: 'mail-1',
          threadId: 'thread-1',
          factRefs: [],
          selectionEpoch: input.selectionEpoch,
          inputRevision: input.inputRevision,
          inputDigest: 'digest',
          totalMinor: 272000,
          currency: 'ZAR',
          arrivalDate: input.groups[0]?.arrivalDate,
          departureDate: input.groups[0]?.departureDate,
          description: 'Selected allocation',
        }),
      },
      prepareBookingDraft: { mutate: prepareDraftMutateMock },
      qualifiedQuoteProposalPdf: {
        mutate: async () => AUTHORISED_QUOTE_PDF,
      },
    },
    drafts: {
      list: { query: async () => [] },
    },
    quoteWorkflow: {
      analyseSelection: {
        mutate: async (input: unknown) => analyseOverride.current?.(input) ?? ({
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
      runStep: {
        mutate: async () => ({
          status: 'ok',
          offers: AUTHORISED_QUOTE_OFFERS,
          reviewedReplyHtml: AUTHORISED_REPLY_HTML,
        }),
      },
      qualifiedProposalPdf: {
        mutate: async () => AUTHORISED_QUOTE_PDF,
      },
    },
  },
}));

describe('Outlook pane quote proposal PDF', () => {
  it('uses the current reviewed reply when revalidation failed before any native create was submitted', async () => {
    let reads = 0;
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') {
        if (reads++ === 0) throw new Error('Bridge revalidation timed out');
        return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      }
      return { entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts', displayed: true };
    });
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Reviewed reply'), { target: { value: '<p>Different quotation reply</p>' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledWith('CREATE_REPLY_DRAFT', expect.objectContaining({ htmlBody: '<p>Different quotation reply</p>' })));
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledWith('ADD_ATTACHMENT_TO_DRAFT', expect.objectContaining({ base64Data: AUTHORISED_QUOTE_PDF.pdfBase64 })));
  }, 15_000);
  it('requires a fresh quote after the staff session changes on the same selected message', async () => {
    const view = render(<OutlookPanePage />);
    await prepareReviewedQuote();
    expect(screen.getByRole('button', { name: /Draft quotation into email reply/i }).hasAttribute('disabled')).toBe(false);
    sessionState.sessionId = 'session-2';
    view.rerender(<OutlookPanePage />);
    await waitFor(() => expect(screen.queryByText(/Prepared PDF/i)).toBeNull());
    // The button is off until a PDF is prepared for this session, and says why.
    expect(screen.getByRole('button', { name: /Draft quotation into email reply/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Prepare the quote PDF first')).toBeDefined();
    expect(sendCommandMock.mock.calls.some(call => call[0] === 'CREATE_REPLY_DRAFT')).toBe(false);
  }, 15_000);
  it('prepares the booking draft from the staff-edited stay dates, not the raw Luna read-out', async () => {
    analyseOverride.current = async () => ({
      status: 'ready' as const,
      intent: 'quote' as const,
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 1,
          adults: 1,
          childrenAges: [],
          board: 'bb' as const,
          specialRequests: [],
          fields: { arrivalDate: 'extracted' as const, departureDate: 'extracted' as const, adults: 'extracted' as const },
        },
      ],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 1,
      luna: {
        workflow: 'create_booking',
        flags: [],
        groups: [
          {
            arrival: '2026-11-12',
            departure: '2026-11-14',
            rooms: 1,
            adultsPerRoom: 1,
            childAges: [],
            board: 'bb',
            roomPreference: null,
            guestNames: [],
          },
        ],
        party: { kind: null, name: null, reference: null },
        rateClaims: [],
        missing: [],
        evidence: [],
        tasks: [],
      },
    });
    render(<OutlookPanePage />);
    fireEvent.change(await findReadStayArrival(), { target: { value: '2026-11-13' } });
    // Get rates waits for a room type on every row; the email gave none.
    fireEvent.change(await screen.findByLabelText('Room type'), { target: { value: 'STQN' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
    await waitFor(() => expect(prepareDraftMutateMock).toHaveBeenCalledTimes(1));
    const sent = prepareDraftMutateMock.mock.calls[0]?.[0] as {
      analysis: { groups: Array<{ arrival: string | null; departure: string | null }> };
    };
    expect(sent.analysis.groups[0]).toEqual(expect.objectContaining({ arrival: '2026-11-13', departure: '2026-11-14' }));
  });

  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sessionState.userId = 'staff-1';
    sessionState.sessionId = 'session-1';
    sessionState.email = 'ropperman@legacyhotels.co.za';
    sessionState.outlookEmail = 'ropperman@legacyhotels.co.za';
    sessionState.transportId = 'transport-shared';
    sessionState.transportEmail = 'centurion@legacyhotels.co.za';
    sessionState.requiresRelogin = false;
    sessionState.nativeSelectedEntryId = '001';
    analyseOverride.current = null;
    prepareDraftMutateMock.mockReset();
    prepareDraftMutateMock.mockResolvedValue({ status: 'unavailable', reason: 'not under test' });
    quoteWorkbookMutateMock.mockReset();
    quotePdfMutateMock.mockReset();
    quotePdfMutateMock.mockResolvedValue({
      fileName: 'Quote - CIDB 15-17 Sep.pdf',
      pdfBase64: 'JVBERw0KGgo=',
    });
    sendCommandMock.mockReset();
    sendCommandMock.mockImplementation(async (action: string) =>
      action === 'GET_ACTIVE_EMAIL'
        ? { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' }
        : { entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts',
          folderName: 'Drafts', displayed: true });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    cleanup();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it('sends the approved quote to the server Excel route from Download Excel', async () => {
    quoteWorkbookMutateMock.mockRejectedValueOnce(new Error('workbook route reached'));
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const download = screen.getByRole('button', { name: 'Download Excel' });
    expect(download.hasAttribute('disabled')).toBe(false);
    fireEvent.click(download);
    await waitFor(() => expect(quoteWorkbookMutateMock).toHaveBeenCalledTimes(1));
    expect(quoteWorkbookMutateMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ workflowRunId: 'run-1', revisionRef: 'rev-auth' }),
    );
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('workbook route reached'));
  });

  it('makes one Excel export at a time and keeps Download Excel disabled until it settles', async () => {
    let settle!: (value: unknown) => void;
    quoteWorkbookMutateMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const download = screen.getByRole('button', { name: 'Download Excel' });
    fireEvent.click(download);
    await waitFor(() => expect(download.hasAttribute('disabled')).toBe(true));
    fireEvent.click(download);
    expect(quoteWorkbookMutateMock).toHaveBeenCalledTimes(1);

    settle({ fileName: 'Quote - CIDB - 2026-11-12.xlsx', xlsxBase64: '', totalMinor: 0, revisionId: 'rev-auth' });
    await waitFor(() => expect(download.hasAttribute('disabled')).toBe(false));
    expect(toast.warning).toHaveBeenCalled();
  });

  it('refuses convert and draft until a server-selected mailbox exists', async () => {
    sessionState.email = 'kdouglas@legacyhotels.co.za';
    sessionState.outlookEmail = 'centurion@legacyhotels.co.za';
    sessionState.transportId = '';
    render(<OutlookPanePage />);
    // Mailbox gate runs before HITL review. Search availability is absent until a transport binds.
    // No analysis is loaded yet, so the reply button keeps its plain label.
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/select.*mailbox/i));
    });
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('uses the server-selected shared mailbox even when staff login and native PING email differ', async () => {
    sessionState.email = 'kdouglas@legacyhotels.co.za';
    sessionState.outlookEmail = 'not-the-mailbox@legacyhotels.co.za';
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(sendCommandMock).toHaveBeenCalledWith(
        'CREATE_REPLY_DRAFT',
        expect.objectContaining({
          entryId: '001',
          folderEntryId: 'folder-inbox',
          operationId: expect.any(String),
        }),
      ),
    );
    await waitFor(() =>
      expect(sendCommandMock).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({
          entryId: 'draft-99',
          folderEntryId: 'folder-drafts',
          operationId: expect.any(String),
          fileName: AUTHORISED_QUOTE_PDF.fileName,
          base64Data: AUTHORISED_QUOTE_PDF.pdfBase64,
        }),
      ),
    );
    const replyId = sendCommandMock.mock.calls.find((call) => call[0] === 'CREATE_REPLY_DRAFT')?.[1]
      .operationId;
    const attachmentId = sendCommandMock.mock.calls.find(
      (call) => call[0] === 'ADD_ATTACHMENT_TO_DRAFT',
    )?.[1].operationId;
    expect(replyId).not.toEqual(attachmentId);
  });

  it('does not create a reply if Outlook selection changed unnoticed during native revalidation', async () => {
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') return {
        entryId: '002', storeId: 'store-1', folderEntryId: 'folder-inbox',
      };
      if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
      return { entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts' };
    });
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledWith('GET_ACTIVE_EMAIL', {}));
    expect(sendCommandMock.mock.calls.filter((call) => call[0] === 'CREATE_REPLY_DRAFT')).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/switched emails while the PDF/i));
  });

  it('checks the actual selection again before retrying an uncertain reply with its original operation ID', async () => {
    let createCount = 0;
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') return {
        entryId: sessionState.nativeSelectedEntryId, storeId: 'store-1', folderEntryId: 'folder-inbox',
      };
      if (action === 'CREATE_REPLY_DRAFT' && createCount++ === 0)
        throw new Error('Bridge command CREATE_REPLY_DRAFT timed out');
      if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
      return { entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts', displayed: true };
    });
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const button = screen.getByRole('button', { name: /Draft quotation into email reply/i });
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock.mock.calls.filter(([action]) =>
      action === 'CREATE_REPLY_DRAFT')).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    const firstPayload = sendCommandMock.mock.calls.find(([action]) =>
      action === 'CREATE_REPLY_DRAFT')?.[1];
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');

    sessionState.nativeSelectedEntryId = '002'; // The native selection event was missed during renewal.
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock.mock.calls.filter(([action]) =>
      action === 'GET_ACTIVE_EMAIL')).toHaveLength(2));
    expect(sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/switched emails while the PDF/i));
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');

    sessionState.nativeSelectedEntryId = '001';
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock.mock.calls.filter(([action]) =>
      action === 'CREATE_REPLY_DRAFT')).toHaveLength(2));
    expect(sendCommandMock.mock.calls.filter(([action]) =>
      action === 'CREATE_REPLY_DRAFT')[1]?.[1]).toEqual(firstPayload);
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
  });

  it('attaches the reviewed quotation PDF, not sample RATE_TABLE bytes', async () => {
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(quotePdfMutateMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith(
        'CREATE_REPLY_DRAFT',
        expect.objectContaining({
          htmlBody: expect.stringContaining('selected allocation only'),
        }),
      );
    });
    const createCall = sendCommandMock.mock.calls.find((call) => call[0] === 'CREATE_REPLY_DRAFT');
    expect(createCall).toBeDefined();
    if (!createCall) throw new Error('missing CREATE_REPLY_DRAFT');
    const htmlBody = (createCall[1] as { htmlBody: string }).htmlBody;
    expect(htmlBody).not.toContain('Thank you for Choosing The Centurion Hotel.');
    expect(htmlBody).not.toContain('<table');
    expect(htmlBody).not.toMatch(/ZAR/i);

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({
          entryId: 'draft-99',
          storeId: 'store-1',
          fileName: AUTHORISED_QUOTE_PDF.fileName,
          base64Data: AUTHORISED_QUOTE_PDF.pdfBase64,
        }),
      );
    });
  });

  it('retries only the attachment with its same operation and exact PDF after an attachment failure', async () => {
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      if (action === 'ADD_ATTACHMENT_TO_DRAFT') {
        throw new Error('Outlook rejected the attachment');
      }
      return {
        entryId: 'draft-99',
        storeId: 'store-1',
        folderEntryId: 'folder-drafts',
        folderName: 'Drafts',
        displayed: true,
      };
    });
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const button = screen.getByRole('button', { name: /Draft quotation into email reply/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Outlook rejected the attachment'),
      );
    });
    fireEvent.click(button);
    await waitFor(() => {
      const createCalls = sendCommandMock.mock.calls.filter(
        (call) => call[0] === 'CREATE_REPLY_DRAFT',
      );
      const attachCalls = sendCommandMock.mock.calls.filter(
        (call) => call[0] === 'ADD_ATTACHMENT_TO_DRAFT',
      );
      expect(createCalls).toHaveLength(1);
      expect(attachCalls).toHaveLength(2);
      expect(attachCalls[1]?.[1]).toEqual(attachCalls[0]?.[1]);
      expect(quotePdfMutateMock).not.toHaveBeenCalled();
    });
  });

  // These reply flows run close to the 5 s default in happy-dom under VPS load; 15 s matches party-index-typeahead.
  it('keeps the exact PDF bytes and attachment operation after an ambiguous native timeout', async () => {
    let attachmentCount = 0;
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      if (action === 'ADD_ATTACHMENT_TO_DRAFT' && attachmentCount++ === 0) {
        throw new Error('Bridge command ADD_ATTACHMENT_TO_DRAFT timed out');
      }
      return {
        entryId: 'draft-99',
        storeId: 'store-1',
        folderEntryId: 'folder-drafts',
        folderName: 'Drafts',
        displayed: true,
      };
    });
    render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const button = screen.getByRole('button', { name: /Draft quotation into email reply/i });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Check Outlook Drafts/i),
    );
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        sendCommandMock.mock.calls.filter(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT'),
      ).toHaveLength(2),
    );
    const attachments = sendCommandMock.mock.calls.filter(
      ([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT',
    );
    expect(attachments[1]?.[1]).toEqual(attachments[0]?.[1]);
    expect(attachments[0]?.[1]).toEqual(
      expect.objectContaining({
        operationId: expect.stringMatching(/^op_\d+_[0-9a-f]{32}$/),
        base64Data: AUTHORISED_QUOTE_PDF.pdfBase64,
        folderEntryId: 'folder-drafts',
      }),
    );
    expect(
      sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT'),
    ).toHaveLength(1);
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
  }, 15_000);

  it('does not create a reply or attach cached PDF after staff logs out during native revalidation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendCommandMock.mockImplementation(async (action: string) => {
      if (action === 'GET_ACTIVE_EMAIL') {
        await gate;
        return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      }
      return { entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts', displayed: true };
    });
    const pane = render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    sessionState.userId = '';
    sessionState.transportId = '';
    pane.rerender(<OutlookPanePage />);
    await act(async () => release());
    expect(sendCommandMock.mock.calls.filter((call) => call[0] === 'CREATE_REPLY_DRAFT')).toHaveLength(0);
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not attach RATE_TABLE PDF bytes after a 24-hour re-login', async () => {
    sessionState.requiresRelogin = true;
    const pane = render(<OutlookPanePage />);
    expect(screen.queryByRole('button', { name: /Insert Draft in Outlook|Draft quotation into email reply/i })).toBeNull();
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    sessionState.requiresRelogin = false;
    pane.rerender(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    await waitFor(() =>
      expect(sendCommandMock).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({ base64Data: AUTHORISED_QUOTE_PDF.pdfBase64 }),
      ),
    );
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
  }, 15_000);

  it('requires checking Drafts when a native reply completes after the staff scope changes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let finishNative!: (value: { entryId: string; storeId: string; folderEntryId: string }) => void;
    sendCommandMock.mockResolvedValueOnce({ entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' });
    sendCommandMock.mockImplementationOnce(() => new Promise((resolve) => { finishNative = resolve; }));
    const pane = render(<OutlookPanePage />);
    await prepareReviewedQuote();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledWith(
      'CREATE_REPLY_DRAFT', expect.anything(),
    ));
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain('JVBER');

    sessionState.requiresRelogin = true;
    pane.rerender(<OutlookPanePage />);
    pane.unmount();
    await act(async () => finishNative({ entryId: 'draft-99', storeId: 'store-1', folderEntryId: 'folder-drafts' }));
    sessionState.requiresRelogin = false;
    render(<OutlookPanePage />);
    await prepareReviewedQuote();

    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Check Outlook Drafts/i));
    expect(sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Check Outlook Drafts/i));
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    await waitFor(() => expect(sendCommandMock.mock.calls.filter(
      ([action]) => action === 'CREATE_REPLY_DRAFT',
    )).toHaveLength(2));
  }, 15_000);

  it('clears draft preview and suppresses a pending native mutation toast on cached-session expiry', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const pane = render(<OutlookPanePage />);
    await prepareReviewedQuote();
    const button = screen.getByRole('button', { name: /Draft quotation into email reply/i });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByText(/Attached: Quote-authorised\.pdf/)).toBeDefined(),
    );
    let rejectMutation!: (error: Error) => void;
    sendCommandMock.mockResolvedValueOnce({ entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' });
    sendCommandMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT'),
      ).toHaveLength(2),
    );
    sessionState.requiresRelogin = true;
    pane.rerender(<OutlookPanePage />);
    await act(async () => rejectMutation(new Error('Bridge unavailable')));
    expect(vi.mocked(toast.error).mock.calls.flat().join(' ')).not.toContain(
      'Suite Availability Request',
    );
    sessionState.requiresRelogin = false;
    pane.rerender(<OutlookPanePage />);
    expect(screen.queryByText(/Attached: Quote-authorised\.pdf/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Check Outlook Drafts/i));
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Draft quotation into email reply/i }));
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
  }, 15_000);
});
