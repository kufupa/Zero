/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

const { sendCommandMock, quotePdfMutateMock, sessionState } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  quotePdfMutateMock: vi.fn(),
  sessionState: { email: 'ropperman@legacyhotels.co.za', outlookEmail: 'ropperman@legacyhotels.co.za' },
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
      bridgeProtocolVersion: 3,
    },
    capabilities: {
      bridgeProtocolVersion: 3,
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
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'We need 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    },
    sendCommand: sendCommandMock,
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: { user: { email: sessionState.email, name: 'R Opperman' } },
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
    sessionState.email = 'ropperman@legacyhotels.co.za';
    sessionState.outlookEmail = 'ropperman@legacyhotels.co.za';
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

  it('refuses convert and draft when Nava email does not match Outlook', async () => {
    sessionState.email = 'kdouglas@legacyhotels.co.za';
    sessionState.outlookEmail = 'centurion@legacyhotels.co.za';
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Nava login must match this Outlook mailbox/i),
      );
    });
    expect(quotePdfMutateMock).not.toHaveBeenCalled();
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('attaches the Proposal PDF after a gold wrapper reply draft', async () => {
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() => {
      expect(quotePdfMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          outlookEmail: 'ropperman@legacyhotels.co.za',
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

  it('keeps the reply operation when attaching the PDF fails', async () => {
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
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Outlook rejected the attachment'));
    });
    fireEvent.click(button);
    await waitFor(() => {
      const createCalls = sendCommandMock.mock.calls.filter((call) => call[0] === 'CREATE_REPLY_DRAFT');
      expect(createCalls).toHaveLength(2);
      const firstCreate = createCalls[0];
      const retryCreate = createCalls[1];
      if (!firstCreate || !retryCreate) throw new Error('missing CREATE_REPLY_DRAFT retry');
      expect((firstCreate[1] as { operationId: string }).operationId).toBe(
        (retryCreate[1] as { operationId: string }).operationId,
      );
    });
  });
});
