/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { toast } from 'sonner';

const { sendCommandMock, quotePdfMutateMock, sessionState } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  quotePdfMutateMock: vi.fn(),
  sessionState: {
    userId: 'staff-1',
    email: 'ropperman@legacyhotels.co.za',
    outlookEmail: 'ropperman@legacyhotels.co.za',
    transportId: 'transport-shared',
    transportEmail: 'centurion@legacyhotels.co.za',
    requiresRelogin: false,
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
          session: { id: 'session-1' },
        }
      : null,
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: quotePdfMutateMock },
    },
  },
}));

describe('Outlook pane quote proposal PDF', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sessionState.userId = 'staff-1';
    sessionState.email = 'ropperman@legacyhotels.co.za';
    sessionState.outlookEmail = 'ropperman@legacyhotels.co.za';
    sessionState.transportId = 'transport-shared';
    sessionState.transportEmail = 'centurion@legacyhotels.co.za';
    sessionState.requiresRelogin = false;
    quotePdfMutateMock.mockReset();
    quotePdfMutateMock.mockResolvedValue({
      fileName: 'Quote - CIDB 15-17 Sep.pdf',
      pdfBase64: 'JVBERw0KGgo=',
    });
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue({
      entryId: 'draft-99',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      folderName: 'Drafts',
      displayed: true,
    });
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it('refuses convert and draft until a server-selected mailbox exists', async () => {
    sessionState.email = 'kdouglas@legacyhotels.co.za';
    sessionState.outlookEmail = 'centurion@legacyhotels.co.za';
    sessionState.transportId = '';
    render(<OutlookPanePage />);
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
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() =>
      expect(quotePdfMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ outlookEmail: 'centurion@legacyhotels.co.za' }),
      ),
    );
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

  it('attaches the Proposal PDF after a gold wrapper reply draft', async () => {
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() => {
      expect(quotePdfMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          outlookEmail: 'centurion@legacyhotels.co.za',
          agency: 'CIDB',
          lines: expect.arrayContaining([
            expect.objectContaining({ roomCode: 'STQN', meal: 'bb' }),
            expect.objectContaining({ roomCode: 'STWN', meal: 'bb' }),
          ]),
        }),
      );
    });

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith(
        'CREATE_REPLY_DRAFT',
        expect.objectContaining({
          htmlBody: expect.stringContaining('Please see attached quotation'),
        }),
      );
    });
    const createCall = sendCommandMock.mock.calls.find((call) => call[0] === 'CREATE_REPLY_DRAFT');
    expect(createCall).toBeDefined();
    if (!createCall) throw new Error('missing CREATE_REPLY_DRAFT');
    const htmlBody = (createCall[1] as { htmlBody: string }).htmlBody;
    expect(htmlBody).toContain('Thank you for Choosing The Centurion Hotel.');
    expect(htmlBody).not.toContain('<table');
    expect(htmlBody).not.toMatch(/ZAR/i);

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({
          entryId: 'draft-99',
          storeId: 'store-1',
          fileName: 'Quote - CIDB 15-17 Sep.pdf',
          base64Data: 'JVBERw0KGgo=',
        }),
      );
    });
  });

  it('retries only the attachment with its same operation and exact PDF after an attachment failure', async () => {
    sendCommandMock.mockImplementation(async (action: string) => {
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
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });
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
      expect(quotePdfMutateMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the exact PDF bytes and attachment operation after an ambiguous native timeout', async () => {
    let attachmentCount = 0;
    sendCommandMock.mockImplementation(async (action: string) => {
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
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });
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
        base64Data: 'JVBERw0KGgo=',
        folderEntryId: 'folder-drafts',
      }),
    );
    expect(
      sendCommandMock.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT'),
    ).toHaveLength(1);
    expect(quotePdfMutateMock).toHaveBeenCalledTimes(1);
  });

  it('does not create a reply or attach cached PDF after staff logs out during PDF generation', async () => {
    let finishPdf!: (value: { fileName: string; pdfBase64: string }) => void;
    quotePdfMutateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPdf = resolve;
        }),
    );
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalledTimes(1));
    sessionState.userId = '';
    sessionState.transportId = '';
    pane.rerender(<OutlookPanePage />);
    await act(async () => finishPdf({ fileName: 'private.pdf', pdfBase64: 'JVBERw==' }));
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('drops pending PDF bytes on 24-hour re-login even when Better Auth still caches the same session', async () => {
    let finishPdf!: (value: { fileName: string; pdfBase64: string }) => void;
    quotePdfMutateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPdf = resolve;
        }),
    );
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalledTimes(1));
    sessionState.requiresRelogin = true;
    pane.rerender(<OutlookPanePage />);
    expect(screen.queryByRole('button', { name: /Insert Draft in Outlook/i })).toBeNull();
    await act(async () => finishPdf({ fileName: 'old-private.pdf', pdfBase64: 'PRIVATE-BYTES' }));
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls.flat().join(' ')).not.toContain(
      'Suite Availability Request',
    );
    sessionState.requiresRelogin = false;
    pane.rerender(<OutlookPanePage />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(sendCommandMock).toHaveBeenCalledWith(
        'ADD_ATTACHMENT_TO_DRAFT',
        expect.objectContaining({ base64Data: 'JVBERw0KGgo=' }),
      ),
    );
  });

  it('clears draft preview and suppresses a pending native mutation toast on cached-session expiry', async () => {
    const pane = render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Please see attached quotation.')).toBeDefined());
    let rejectMutation!: (error: Error) => void;
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
    expect(screen.queryByText('Please see attached quotation.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutateMock).toHaveBeenCalledTimes(3));
  });
});
