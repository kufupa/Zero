/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useReducer, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ReplyBody } from '../components/nava-pane/reply-body';
import { useInsertAiDraft, useQuoteDraftRevision } from '../components/nava-pane/use-insert-ai-draft';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import type { QuoteSession } from '../lib/quote-workflow/types';

const { saveReplyMutate, recordQuoteOutcomeMutate, quoteDraftPreflight, reviewedDraftRef } = vi.hoisted(() => ({
  saveReplyMutate: vi.fn(),
  recordQuoteOutcomeMutate: vi.fn(),
  quoteDraftPreflight: vi.fn(),
  reviewedDraftRef: {
    current: {
      html: '<p>Quote for you</p>',
      pdf: { fileName: 'Quotation.pdf', pdfBase64: 'JVBERi0xLjQ=' },
    } as { html: string; pdf: { fileName: string; pdfBase64: string } } | null,
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    drafts: { saveReply: { mutate: saveReplyMutate } },
    workItems: { recordQuoteOutcome: { mutate: recordQuoteOutcomeMutate } },
    workstation: { quoteDraftPreflight: { mutate: quoteDraftPreflight } },
  },
}));

// The reviewed reply and PDF come from the quote workflow. This test checks what the save and insert send.
vi.mock('../lib/quote-workflow/native-draft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/quote-workflow/native-draft')>()),
  requireReviewedNativeDraft: () => reviewedDraftRef.current,
}));

const SAVED_HTML = '<p>Saved reply text</p>';
const SAVED_PDF = 'JVBERi0xLjQgc2F2ZWQ=';

const activeEmail = {
  entryId: 'entry-1',
  storeId: 'store-1',
  folderEntryId: 'folder-inbox',
  subject: 'Quote request',
  senderEmail: 'guest@example.com',
  senderName: 'David Miller',
  internetMessageId: '<quote@example.invalid>',
  receivedTime: '2026-10-08T12:00:00Z',
  bodyText: 'Could you quote 12-14 Nov?',
  bodyHtml: '<p>Could you quote 12-14 Nov?</p>',
} as unknown as PaneBridge['activeEmail'];

const quoteSession = {
  staffSource: { messageId: 'message-db-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) },
  staffQuote: { workflowRunId: 'run-1', revisionRef: 'revision-1' },
  reviewedReplyHtml: '',
  groups: [],
} as unknown as QuoteSession;

function outlookSendCommand() {
  return vi.fn(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
    if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
    beforeNative?.();
    if (action === 'CREATE_REPLY_DRAFT') {
      return { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true };
    }
    return undefined;
  });
}

function renderInsertHook(
  sendCommand: ReturnType<typeof outlookSendCommand>,
  session: QuoteSession = quoteSession,
  contextRevision = { current: { scopeEpoch: 1, selectionEpoch: 1 } },
) {
  const quoteSessionRef = { current: session };
  const quoteDraftRevision = { current: 0 };
  return renderHook(() =>
    useInsertAiDraft({
      activeEmail,
      mailboxEmail: 'centurion@legacyhotels.co.za',
      transportLoading: false,
      currentScope: 'scope-1',
      contextRevision,
      quoteSession: session,
      quoteSessionRef,
      quoteDraftRevision,
      quoteDraftRenderedRevision: 0,
      flushQuoteEdits: async () => true,
      combinedEdit: null,
      sendCommand: sendCommand as unknown as PaneBridge['sendCommand'],
      supportsAction: () => true,
    }),
  );
}

function renderEditableInsertHook(
  sendCommand: ReturnType<typeof outlookSendCommand>, session: QuoteSession,
  flushQuoteEdits: () => Promise<boolean> = async () => true,
) {
  const contextRevision = { current: { scopeEpoch: 1, selectionEpoch: 1 } };
  return renderHook(() => {
    const [currentSession, dispatch] = useReducer(reduceQuoteSession, session);
    const revision = useQuoteDraftRevision(dispatch, currentSession.pendingPartyKinds);
    const current = useRef(currentSession);
    current.current = currentSession;
    const insertion = useInsertAiDraft({
      activeEmail,
      mailboxEmail: 'centurion@legacyhotels.co.za',
      transportLoading: false,
      currentScope: 'scope-1',
      contextRevision,
      quoteSession: currentSession,
      quoteSessionRef: current,
      quoteDraftRevision: revision.live,
      quoteDraftRenderedRevision: revision.rendered,
      flushQuoteEdits,
      combinedEdit: null,
      sendCommand: sendCommand as unknown as PaneBridge['sendCommand'],
      supportsAction: () => true,
    });
    return { ...insertion, edit: revision.dispatch, currentSession };
  });
}

function editableQuotedSession(): QuoteSession {
  return {
    ...initialQuoteSession(),
    staffSource: quoteSession.staffSource,
    staffQuote: quoteSession.staffQuote,
    groups: [{
      id: 'room-1', arrivalDate: '2027-11-12', departureDate: '2027-11-14', quantity: 1,
      adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
    }],
  };
}

beforeEach(() => {
  reviewedDraftRef.current = {
    html: '<p>Quote for you</p>',
    pdf: { fileName: 'Quotation.pdf', pdfBase64: 'JVBERi0xLjQ=' },
  };
  saveReplyMutate.mockReset();
  quoteDraftPreflight.mockReset().mockResolvedValue({ ready: true });
  recordQuoteOutcomeMutate.mockReset().mockResolvedValue({ recorded: true });
  sessionStorage.removeItem('nava_outlook_unresolved_reply_v1');
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Save reply on the webmail panel', () => {
  it('flushes pending work-item edits before saving a quote draft', async () => {
    let release!: (saved: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    saveReplyMutate.mockResolvedValueOnce({ id: 'draft-1', replaced: false });
    const { result } = renderEditableInsertHook(outlookSendCommand(), editableQuotedSession(), flush);

    act(() => result.current.trackedSave('selected'));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(saveReplyMutate).not.toHaveBeenCalled();
    await act(async () => release(true));
    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
  });

  it('holds a webmail quote if its inputs change while pending edits flush', async () => {
    let release!: (saved: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const { result } = renderEditableInsertHook(outlookSendCommand(), editableQuotedSession(), flush);
    act(() => result.current.trackedSave('selected'));
    expect(flush).toHaveBeenCalledTimes(1);
    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release(true));

    expect(saveReplyMutate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('quote changed in the pane'));
  });

  it('does not save a quote if a pending work-item edit fails', async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const { result } = renderEditableInsertHook(outlookSendCommand(), editableQuotedSession(), flush);
    act(() => result.current.trackedSave('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('could not be saved')));
    expect(saveReplyMutate).not.toHaveBeenCalled();
  });

  it('does not replace an existing draft after the quote changes during the first save', async () => {
    let reject!: (error: Error) => void;
    saveReplyMutate.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderEditableInsertHook(outlookSendCommand(), editableQuotedSession());
    act(() => result.current.trackedSave('selected'));
    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => reject(Object.assign(new Error('DRAFT_REPLACE_CONFIRM_REQUIRED:draft-0:rev-3'), {
      data: { code: 'CONFLICT' },
    })));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(saveReplyMutate).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('quote changed in the pane'));
  });

  it('reports an already saved earlier draft if inputs change during the webmail save', async () => {
    let release!: (saved: { id: string; replaced: boolean }) => void;
    saveReplyMutate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { result } = renderEditableInsertHook(outlookSendCommand(), editableQuotedSession());
    act(() => result.current.trackedSave('selected'));
    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release({ id: 'draft-1', replaced: false }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));

    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('earlier quote was saved'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('saves the reviewed reply and PDF as the thread draft, not as an Outlook insert', async () => {
    saveReplyMutate.mockResolvedValueOnce({ id: 'draft-1', replaced: false });
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);

    await act(async () => {
      result.current.trackedSave('selected');
    });

    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
    expect(saveReplyMutate).toHaveBeenCalledWith({
      threadId: 'thread-1',
      replyToMessageId: 'message-db-1',
      to: ['guest@example.com'],
      subject: 'Re: Quote request',
      html: '<p>Quote for you</p>',
      replyKind: 'quote',
      preparedVersions: [{ workflowRunId: 'run-1', revisionRef: 'revision-1' }],
      attachments: [
        {
          name: 'Quotation.pdf',
          type: 'application/pdf',
          size: 8,
          lastModified: expect.any(Number),
          base64: 'JVBERi0xLjQ=',
        },
      ],
    });
    expect(sendCommand).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.draftStatus?.message).toBe(
        'Saved the reply and PDF as this thread\'s draft. Nothing is sent.',
      ),
    );
  });

  it('saves a missing-details reply without a PDF or Outlook draft', async () => {
    saveReplyMutate.mockResolvedValueOnce({ id: 'draft-1', replaced: false });
    const sendCommand = outlookSendCommand();
    const html = '<p>Please confirm the arrival date.</p>';
    const requestOnlySession = {
      ...quoteSession,
      analysis: { intent: 'quote', missingQuoteReplyFields: ['Arrival date for stay 1'] },
      groups: [{ arrivalDate: null, departureDate: '2026-11-14' }],
      reviewedReplyHtml: html,
    } as unknown as QuoteSession;
    const { result } = renderInsertHook(sendCommand, requestOnlySession);

    await act(async () => {
      result.current.trackedSave('selected');
    });

    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        replyToMessageId: 'message-db-1',
        html,
        replyKind: 'missing_details',
        preparedVersions: [],
        attachments: [],
      }),
    ));
    expect(sendCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.draftStatus?.message).toBe(
      'Saved the reply asking for the missing details. Nothing is sent.',
    ));
  });

  it('does not require quote-edit flushing for an unrelated missing-details reply', async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const session = {
      ...editableQuotedSession(),
      analysis: { intent: 'quote', missingQuoteReplyFields: ['Arrival date'] },
      groups: [{ arrivalDate: null, departureDate: '2027-11-14' }],
      reviewedReplyHtml: '<p>Please confirm the arrival date.</p>',
    } as unknown as QuoteSession;
    saveReplyMutate.mockResolvedValueOnce({ id: 'draft-1', replaced: false });
    const { result } = renderEditableInsertHook(outlookSendCommand(), session, flush);
    act(() => result.current.trackedSave('selected'));
    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
    expect(flush).not.toHaveBeenCalled();
  });

  it('asks Replace current draft? before overwriting, and replaces only the draft the prompt named', async () => {
    const conflict = Object.assign(new Error('DRAFT_REPLACE_CONFIRM_REQUIRED:draft-0:rev-3'), {
      data: { code: 'CONFLICT' },
    });
    saveReplyMutate
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: 'draft-1', replaced: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderInsertHook(outlookSendCommand());

    await act(async () => {
      result.current.trackedSave('selected');
    });

    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace current draft?'));
    expect(saveReplyMutate.mock.calls[0]?.[0]).not.toHaveProperty('replaceDraft');
    expect(saveReplyMutate.mock.calls[1]?.[0]).toMatchObject({ replaceDraft: 'draft-0:rev-3' });
    await waitFor(() =>
      expect(result.current.draftStatus?.message).toBe(
        'Replaced this thread\'s draft with the reply and PDF. Nothing is sent.',
      ),
    );
  });

  it('leaves the existing draft alone when staff cancel the replace prompt', async () => {
    const conflict = Object.assign(new Error('DRAFT_REPLACE_CONFIRM_REQUIRED:draft-0:rev-3'), {
      data: { code: 'CONFLICT' },
    });
    saveReplyMutate.mockRejectedValueOnce(conflict);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderInsertHook(outlookSendCommand());

    await act(async () => {
      result.current.trackedSave('selected');
    });

    await waitFor(() => expect(saveReplyMutate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(saveReplyMutate).toHaveBeenCalledTimes(1);
    expect(result.current.draftStatus).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('refuses to save while the reply has no reviewed PDF', async () => {
    reviewedDraftRef.current = null;
    const { result } = renderInsertHook(outlookSendCommand());

    await act(async () => {
      result.current.trackedSave('selected');
    });

    expect(saveReplyMutate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Make the PDF and finish the reply before saving it'),
    );
  });
});

describe('Insert saved reply in Outlook', () => {
  it('inserts the saved HTML and PDF through the normal Outlook insert flow', async () => {
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);

    await act(async () => {
      result.current.trackedDraft('saved', {
        html: SAVED_HTML,
        attachments: [{ fileName: 'Quotation.pdf', pdfBase64: SAVED_PDF }],
      });
    });

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({
          entryId: 'outlook-draft-1',
          fileName: 'Quotation.pdf',
          base64Data: SAVED_PDF,
        }),
        expect.any(Function),
      ),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      'CREATE_REPLY_DRAFT',
      expect.objectContaining({ entryId: 'entry-1', htmlBody: SAVED_HTML, replyAll: false }),
      expect.any(Function),
    );
    expect(saveReplyMutate).not.toHaveBeenCalled();
    expect(quoteDraftPreflight).toHaveBeenCalledTimes(2);
  });

  it('holds a stale quote before Outlook creates the draft', async () => {
    quoteDraftPreflight.mockRejectedValueOnce(new Error('stale'));
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('could not be verified')));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
  });

  it('rechecks before attaching and reports a partial Outlook draft if facts change', async () => {
    quoteDraftPreflight.mockResolvedValueOnce({ ready: true }).mockRejectedValueOnce(new Error('changed'));
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist')));
    expect(sendCommand.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
  });

  it('does not create an Outlook quote when the stay is edited while preflight is pending', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const session = editableQuotedSession();
    const { result } = renderEditableInsertHook(sendCommand, session);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(1));

    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release({ ready: true }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));

    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
  });

  it('does not hold an unchanged quote when the party picker repeats its idle status', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(1));
    act(() => result.current.edit({ type: 'party_lookup_pending', kind: 'company', pending: false }));
    await act(async () => release({ ready: true }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(true);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(true);
  });

  it('holds a quote when a party lookup starts while the Outlook ticket is pending', async () => {
    let release!: () => void;
    const nativeWrites: string[] = [];
    const sendCommand = outlookSendCommand();
    sendCommand.mockImplementation(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
      if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
      if (action === 'CREATE_REPLY_DRAFT') await new Promise<void>((resolve) => { release = resolve; });
      beforeNative?.();
      nativeWrites.push(action);
      return { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true };
    });
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => result.current.edit({ type: 'party_lookup_pending', kind: 'company', pending: true }));
    await act(async () => release());
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(nativeWrites).not.toContain('CREATE_REPLY_DRAFT');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('lookup to finish'));
  });

  it('waits for a party lookup already pending when staff insert the quote', async () => {
    const sendCommand = outlookSendCommand();
    const session = { ...editableQuotedSession(), pendingPartyKinds: ['company'] as const } as unknown as QuoteSession;
    const { result } = renderEditableInsertHook(sendCommand, session);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('lookup to finish'));
  });

  it('does not add the Centurion lookup hold to a Da Vinci quote', async () => {
    const sendCommand = outlookSendCommand();
    const session = { ...editableQuotedSession(), quotePropertyCode: 'HRDAV', pendingPartyKinds: ['company'] } as QuoteSession;
    const { result } = renderEditableInsertHook(sendCommand, session);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(true);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(true);
  });

  it('allows an unchanged reviewed draft when a background comparison result arrives', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const stayKey = '2027-11-12:2027-11-14';
    const session = { ...editableQuotedSession(),
      binding: { transportId: 'transport-centurion', mailboxEmail: 'centurion@legacyhotels.co.za',
        entryId: 'entry-1', storeId: 'store-1', folderEntryId: 'folder-inbox', selectionEpoch: 1, scopeEpoch: 1 },
      quoteStrategyRows: { [stayKey]: { WS: { status: 'pending' } } }, quoteStrategyResults: {},
      quoteStrategyRevisions: { [stayKey]: 1 }, quoteStrategySelections: {},
    } as unknown as QuoteSession;
    const { result } = renderEditableInsertHook(sendCommand, session);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(1));
    act(() => result.current.edit({ type: 'quote_strategy_comparison_result', stayKey, strategyCode: 'WS',
      selectionEpoch: 1, stayRevision: 1, outcome: { strategyCode: 'WS', row: { status: 'failed', message: 'Unavailable' } } }));
    await waitFor(() => expect((result.current.currentSession as unknown as {
      quoteStrategyRows: Record<string, { WS: { status: string } }>;
    }).quoteStrategyRows[stayKey]?.WS.status).toBe('failed'));
    await act(async () => release({ ready: true }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(true);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(true);
  });

  it.each(['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT'] as const)(
    'holds an Outlook %s when the quote changes while its ticket is pending', async (heldAction) => {
      let release!: () => void;
      const nativeWrites: string[] = [];
      const sendCommand = outlookSendCommand();
      sendCommand.mockImplementation(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
        if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
        if (action === heldAction) await new Promise<void>((resolve) => { release = resolve; });
        beforeNative?.();
        nativeWrites.push(action);
        return action === 'CREATE_REPLY_DRAFT'
          ? { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true }
          : undefined;
      });
      const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
      act(() => result.current.trackedDraft('selected'));
      await waitFor(() => expect(release).toBeTypeOf('function'));
      act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
      await act(async () => release());
      await waitFor(() => expect(result.current.isDraftPending).toBe(false));
      expect(nativeWrites).not.toContain(heldAction);
      if (heldAction === 'ADD_ATTACHMENT_TO_DRAFT') {
        expect(nativeWrites).toContain('CREATE_REPLY_DRAFT');
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist'));
        expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');
      } else {
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('quote changed in the pane'));
        expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('partial draft may exist'));
        expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBeNull();
      }
    },
  );

  it('retains an earlier unknown Outlook outcome when a retry is held before the native write', async () => {
    let release!: () => void;
    let creates = 0;
    const nativeWrites: string[] = [];
    const sendCommand = outlookSendCommand();
    sendCommand.mockImplementation(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
      if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
      if (action === 'CREATE_REPLY_DRAFT' && ++creates === 1) {
        beforeNative?.();
        throw Object.assign(new Error('Outlook outcome unknown'), { code: 'OPERATION_OUTCOME_UNKNOWN' });
      }
      if (action === 'CREATE_REPLY_DRAFT') await new Promise<void>((resolve) => { release = resolve; });
      beforeNative?.();
      nativeWrites.push(action);
      return { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true };
    });
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('did not confirm')));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release());
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(nativeWrites).not.toContain('CREATE_REPLY_DRAFT');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist'));
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');
  });

  it('warns that a quote draft may be stale if the edit lands after Outlook receives its attachment', async () => {
    let release!: () => void;
    const sendCommand = outlookSendCommand();
    sendCommand.mockImplementation(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
      if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
      beforeNative?.();
      if (action === 'ADD_ATTACHMENT_TO_DRAFT') await new Promise<void>((resolve) => { release = resolve; });
      return action === 'CREATE_REPLY_DRAFT'
        ? { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true }
        : undefined;
    });
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release());
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not attach the old PDF when the stay is edited during the second preflight', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockResolvedValueOnce({ ready: true })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const session = editableQuotedSession();
    const { result } = renderEditableInsertHook(sendCommand, session);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(2));

    act(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    await act(async () => release({ ready: true }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));

    expect(sendCommand.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist'));
  });

  it('holds a quote if the reviewed reply changes while preflight is pending', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(1));

    act(() => result.current.edit({ type: 'set_reviewed_reply', html: '<p>Updated reply</p>', staffEdited: true }));
    await act(async () => release({ ready: true }));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));

    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('quote changed in the pane'));
  });

  it('holds an edit dispatched before the old render starts a quote draft', async () => {
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => {
      result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } });
      result.current.trackedDraft('selected');
    });
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('quote changed in the pane'));
  });

  it('checks a queued edit again immediately before the Outlook create command', async () => {
    let release!: (value: { ready: boolean }) => void;
    quoteDraftPreflight.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession());
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(quoteDraftPreflight).toHaveBeenCalledTimes(1));

    await act(async () => {
      release({ ready: true });
      queueMicrotask(() => result.current.edit({ type: 'patch_group', groupId: 'room-1', patch: { quantity: 2 } }));
    });
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
  });

  it('holds a quote while a pending work-item reset or edit cannot be flushed', async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession(), flush);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('could not be saved')));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(quoteDraftPreflight).not.toHaveBeenCalled();
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
  });

  it('reports a partial draft if work-item edits cannot be flushed before attachment', async () => {
    const flush = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession(), flush);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist')));
    expect(sendCommand.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
  });

  it('does not flush quote edits for an unrelated saved reply', async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const sendCommand = outlookSendCommand();
    const { result } = renderEditableInsertHook(sendCommand, editableQuotedSession(), flush);
    act(() => result.current.trackedDraft('saved', { html: SAVED_HTML, quoteBound: false, attachments: [] }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('CREATE_REPLY_DRAFT', expect.anything()));
    expect(flush).not.toHaveBeenCalled();
  });

  it('holds the attachment and reports a partial quote draft after the selected email changes', async () => {
    type CreatedReply = { entryId: string; storeId: string; folderEntryId: string; displayed: boolean };
    let finish!: (value: CreatedReply) => void;
    const sendCommand = outlookSendCommand();
    sendCommand.mockImplementation(async (action: string, _payload?: unknown, beforeNative?: () => void) => {
      if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
      beforeNative?.();
      if (action === 'CREATE_REPLY_DRAFT') return await new Promise<CreatedReply>((resolve) => { finish = resolve; });
      return undefined;
    });
    const contextRevision = { current: { scopeEpoch: 1, selectionEpoch: 1 } };
    const { result } = renderInsertHook(sendCommand, quoteSession, contextRevision);
    act(() => result.current.trackedDraft('selected'));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('CREATE_REPLY_DRAFT', expect.anything(), expect.any(Function)));
    expect(sessionStorage.getItem('nava_outlook_unresolved_reply_v1')).toBe('1');
    contextRevision.current.selectionEpoch = 2;
    await act(async () => finish({ entryId: 'original-draft', storeId: 'store-1', folderEntryId: 'drafts', displayed: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('partial draft may exist')));
    expect(sendCommand.mock.calls.some(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT')).toBe(false);
    expect(quoteDraftPreflight).toHaveBeenCalledTimes(1);
  });

  it('keeps a saved non-quote reply available without quote preflight', async () => {
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);
    act(() => result.current.trackedDraft('saved', { html: SAVED_HTML, quoteBound: false,
      attachments: [{ fileName: 'document.pdf', pdfBase64: SAVED_PDF }] }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('ADD_ATTACHMENT_TO_DRAFT', expect.anything()));
    expect(quoteDraftPreflight).not.toHaveBeenCalled();
  });

  it('explains how to recover when an older saved attachment has unknown quote provenance', async () => {
    quoteDraftPreflight.mockRejectedValueOnce(new Error('unverified attachment'));
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);
    act(() => result.current.trackedDraft('saved', { html: SAVED_HTML,
      attachments: [{ fileName: 'supporting.pdf', pdfBase64: SAVED_PDF }] }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Remove it from the saved reply')));
    expect(sendCommand.mock.calls.some(([action]) => action === 'CREATE_REPLY_DRAFT')).toBe(false);
  });

  it('does not record a missing-details Outlook reply as a quote outcome', async () => {
    const sendCommand = outlookSendCommand();
    const requestOnlySession = {
      ...quoteSession,
      analysis: { intent: 'quote', missingQuoteReplyFields: ['Arrival date'] },
      groups: [{ arrivalDate: null, departureDate: '2026-11-14' }],
      reviewedReplyHtml: '<p>Please confirm the arrival date.</p>',
    } as unknown as QuoteSession;
    const { result } = renderInsertHook(sendCommand, requestOnlySession);

    act(() => result.current.trackedDraft('selected'));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('CREATE_REPLY_DRAFT', expect.anything()));
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(recordQuoteOutcomeMutate).not.toHaveBeenCalled();
  });

  it('records quote insert with the exact prepared run and revision', async () => {
    const { result } = renderInsertHook(outlookSendCommand());

    act(() => result.current.trackedDraft('selected'));

    await waitFor(() => expect(recordQuoteOutcomeMutate).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: 'message-db-1',
      replyHtml: '<p>Quote for you</p>',
      replyKind: 'quote',
      preparedVersions: [{ workflowRunId: 'run-1', revisionRef: 'revision-1' }],
      attachments: [expect.objectContaining({ fileName: 'Quotation.pdf', mimeType: 'application/pdf' })],
    })));
  });

  it('a double click reads and inserts the saved reply once, with the button off from the click', async () => {
    const sendCommand = outlookSendCommand();
    const { result } = renderInsertHook(sendCommand);
    let land: (reply: { html: string; attachments: { fileName: string; pdfBase64: string }[] }) => void = () => {};
    const read = vi.fn(() => new Promise<Parameters<typeof land>[0]>((resolve) => (land = resolve)));

    act(() => {
      result.current.trackedInsertSaved(read);
      result.current.trackedInsertSaved(read);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.isDraftPending).toBe(true);

    await act(async () => {
      land({ html: SAVED_HTML, attachments: [{ fileName: 'Quotation.pdf', pdfBase64: SAVED_PDF }] });
    });
    await waitFor(() => expect(result.current.isDraftPending).toBe(false));
    expect(sendCommand.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
  });

  it('shows the saved-reply button only when the thread has a saved reply', () => {
    const insertSaved = vi.fn();
    const shared = {
      activeEmail,
      supportsAction: () => true,
      quoteSession,
      combinedEdit: null,
      onCombinedEditChange: vi.fn(),
      quoteOrBookingEmail: true,
      isDraftPending: false,
      statusMessage: null,
      onDraft: vi.fn(),
    };
    const { unmount } = render(<ReplyBody {...shared} onInsertSaved={null} />);
    expect(screen.queryByRole('button', { name: 'Insert saved reply' })).toBeNull();
    unmount();

    render(<ReplyBody {...shared} onInsertSaved={insertSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert saved reply' }));
    expect(insertSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Insert draft in Outlook' })).toBeTruthy();
  });
});

describe('Save reply button on the webmail panel', () => {
  it('replaces the Outlook insert button with Save reply on the preview', () => {
    const onSaveReply = vi.fn();
    render(
      <ReplyBody
        activeEmail={activeEmail}
        supportsAction={() => false}
        quoteSession={quoteSession}
        combinedEdit={null}
        onCombinedEditChange={vi.fn()}
        quoteOrBookingEmail
        isDraftPending={false}
        statusMessage={null}
        onDraft={vi.fn()}
        onSaveReply={onSaveReply}
        preview
      />,
    );
    expect(screen.queryByRole('button', { name: 'Insert draft in Outlook' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save reply' }));
    expect(onSaveReply).toHaveBeenCalledWith('selected');
  });

  it('labels a webmail quote action Draft quotation into email reply and saves it', () => {
    const onSaveReply = vi.fn();
    const quotationSession = { ...quoteSession, treatAs: 'quote' } as QuoteSession;
    render(
      <ReplyBody
        activeEmail={activeEmail}
        supportsAction={() => false}
        quoteSession={quotationSession}
        combinedEdit={null}
        onCombinedEditChange={vi.fn()}
        quoteOrBookingEmail
        isDraftPending={false}
        statusMessage={null}
        onDraft={vi.fn()}
        onSaveReply={onSaveReply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft quotation into email reply' }));
    expect(onSaveReply).toHaveBeenCalledWith('selected');
  });
});
