/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ReplyBody } from '../components/nava-pane/reply-body';
import { useInsertAiDraft } from '../components/nava-pane/use-insert-ai-draft';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import type { QuoteSession } from '../lib/quote-workflow/types';

const { saveReplyMutate, reviewedDraftRef } = vi.hoisted(() => ({
  saveReplyMutate: vi.fn(),
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
  trpcClient: { drafts: { saveReply: { mutate: saveReplyMutate } } },
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
  groups: [],
} as unknown as QuoteSession;

function outlookSendCommand() {
  return vi.fn(async (action: string) => {
    if (action === 'GET_ACTIVE_EMAIL') return activeEmail;
    if (action === 'CREATE_REPLY_DRAFT') {
      return { entryId: 'outlook-draft-1', storeId: 'store-1', folderEntryId: 'drafts', displayed: true };
    }
    return undefined;
  });
}

function renderInsertHook(sendCommand: ReturnType<typeof outlookSendCommand>) {
  const contextRevision = { current: { scopeEpoch: 1, selectionEpoch: 1 } };
  return renderHook(() =>
    useInsertAiDraft({
      activeEmail,
      mailboxEmail: 'centurion@legacyhotels.co.za',
      transportLoading: false,
      currentScope: 'scope-1',
      contextRevision,
      quoteSession,
      combinedEdit: null,
      sendCommand: sendCommand as unknown as PaneBridge['sendCommand'],
      supportsAction: () => true,
    }),
  );
}

beforeEach(() => {
  reviewedDraftRef.current = {
    html: '<p>Quote for you</p>',
    pdf: { fileName: 'Quotation.pdf', pdfBase64: 'JVBERi0xLjQ=' },
  };
  saveReplyMutate.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Save reply on the webmail panel', () => {
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
      attachments: [
        {
          name: 'Quotation.pdf',
          type: 'application/pdf',
          size: 8,
          lastModified: expect.any(Number),
          base64: 'JVBERi0xLjQ=',
        },
      ],
      replaceExisting: false,
    });
    expect(sendCommand).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.draftStatus?.message).toBe(
        'Saved the reply and PDF as this thread\'s draft. Nothing is sent.',
      ),
    );
  });

  it('asks Replace current draft? before overwriting, and overwrites only on confirm', async () => {
    const conflict = Object.assign(new Error('DRAFT_REPLACE_CONFIRM_REQUIRED'), {
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
    expect(saveReplyMutate.mock.calls[0]?.[0]).toMatchObject({ replaceExisting: false });
    expect(saveReplyMutate.mock.calls[1]?.[0]).toMatchObject({ replaceExisting: true });
    await waitFor(() =>
      expect(result.current.draftStatus?.message).toBe(
        'Replaced this thread\'s draft with the reply and PDF. Nothing is sent.',
      ),
    );
  });

  it('leaves the existing draft alone when staff cancel the replace prompt', async () => {
    const conflict = Object.assign(new Error('DRAFT_REPLACE_CONFIRM_REQUIRED'), {
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
      ),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      'CREATE_REPLY_DRAFT',
      expect.objectContaining({ entryId: 'entry-1', htmlBody: SAVED_HTML, replyAll: false }),
    );
    expect(saveReplyMutate).not.toHaveBeenCalled();
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
});
