/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { toast } from 'sonner';
import path from 'node:path';

const { sendCommandMock, pairDeviceMock, quotePdfMutate, bridgeMockState } = vi.hoisted(() => ({
  pairDeviceMock: vi.fn(async () => {}),
  quotePdfMutate: vi.fn().mockResolvedValue({
    fileName: 'Quote - CIDB 15-17 Sep.pdf',
    pdfBase64: 'JVBERw==',
  }),
  sendCommandMock: vi.fn(async (action: string, _payload?: unknown): Promise<unknown> => {
    void _payload;
    if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
    return {
      entryId: 'draft-default',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      folderName: 'Drafts',
      displayed: true,
    };
  }),
  bridgeMockState: {
    protocolVersion: 4 as number | undefined,
    paired: true,
    selectedEntryId: '001',
    userId: 'staff-1',
    sessionId: 'session-1',
    transportId: 'transport-1',
    legacyReplySupported: undefined as boolean | undefined,
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const draftFolder = { storeId: 'store-1', folderEntryId: 'folder-drafts', folderName: 'Drafts' };

const v4Capabilities = {
  bridgeProtocolVersion: 4,
  addinVersion: '1.0.12',
  outlookVersion: '16.0',
  runtime: 'Classic Outlook for Windows',
  newOutlookSupported: false,
  interactiveProfileRequired: true,
  maxPageSize: 200,
  maxFolderDepth: 64,
  maxFolderCount: 5000,
  maxFolderSnapshotItems: 5000,
  supportedActions: [
    'GET_CAPABILITIES',
    'GET_ACTIVE_EMAIL',
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
  ],
};

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      addinVersion: bridgeMockState.protocolVersion === 4 ? '1.0.12' : '1.0.8',
      bridgeProtocolVersion: bridgeMockState.protocolVersion,
      paired: bridgeMockState.paired,
    },
    capabilities: bridgeMockState.protocolVersion === 4 ? v4Capabilities : null,
    supportsAction: (action: string) =>
      bridgeMockState.protocolVersion === 4
        ? v4Capabilities.supportedActions.includes(action)
        : false,
    activeEmail: {
      entryId: bridgeMockState.selectedEntryId,
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject:
        bridgeMockState.selectedEntryId === '001'
          ? 'Suite Availability Request'
          : 'Different Guest Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'CIDB needs 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
    },
    sendCommand: sendCommandMock,
    pairDevice: pairDeviceMock,
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: bridgeMockState.userId, email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: bridgeMockState.sessionId },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: bridgeMockState.transportId, email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: quotePdfMutate },
    },
  },
}));

describe('OutlookPanePage', () => {
  const createReplyCalls = () =>
    sendCommandMock.mock.calls.filter((call) => call[0] === 'CREATE_REPLY_DRAFT');

  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    quotePdfMutate.mockReset();
    quotePdfMutate.mockResolvedValue({ fileName: 'Quote - CIDB 15-17 Sep.pdf', pdfBase64: 'JVBERw==' });
    sendCommandMock.mockReset();
    sendCommandMock.mockImplementation(
      async (action: string, _payload?: unknown): Promise<unknown> => {
        void _payload;
        if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
        return {
          entryId: 'draft-default',
          storeId: 'store-1',
          folderEntryId: 'folder-drafts',
          folderName: 'Drafts',
          displayed: true,
        };
      },
    );
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    cleanup();
    sendCommandMock.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.error).mockClear();
    bridgeMockState.protocolVersion = 4;
    bridgeMockState.paired = true;
    bridgeMockState.selectedEntryId = '001';
    bridgeMockState.userId = 'staff-1';
    bridgeMockState.sessionId = 'session-1';
    bridgeMockState.transportId = 'transport-1';
    bridgeMockState.legacyReplySupported = undefined;
  });

  it('renders Nava AI Reservationist title and connection status', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/Nava AI Reservationist/i)).toBeDefined();
    expect(
      screen.getByText(/Connected to Classic Outlook.*16\.0.*product\/build unknown/i),
    ).toBeDefined();
  });

  it('renders active email card with subject and sender', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/Suite Availability Request/i)).toBeDefined();
    expect(screen.getByText(/David Miller/i)).toBeDefined();
  });

  it('keeps manual Outlook Send instructions and the screenshot inspection control', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/Send manually in Outlook/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Open Full-Screen \(1000×800\)/i })).toBeDefined();
  });

  it('opens only the native pairing dialog when the installer is unpaired', () => {
    bridgeMockState.paired = false;
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Pair Outlook Device/i }));
    expect(pairDeviceMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('renders the Run System Test button', () => {
    render(<OutlookPanePage />);
    expect(screen.getByRole('button', { name: /Run System Verification/i })).toBeDefined();
  });

  it('labels the AI draft card as a sample placeholder', () => {
    render(<OutlookPanePage />);
    expect(screen.getByText(/not live AI output/i)).toBeDefined();
  });

  it('passes the selected store ID when creating a reply draft', async () => {
    render(<OutlookPanePage />);

    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith(
        'CREATE_REPLY_DRAFT',
        expect.objectContaining({
          entryId: '001',
          storeId: 'store-1',
          operationId: expect.any(String),
        }),
      );
    });
  });

  it('does not create an Outlook reply after switching A to B and back to A while PDF is pending', async () => {
    let finishPdf!: (value: { fileName: string; pdfBase64: string }) => void;
    quotePdfMutate.mockImplementationOnce(() => new Promise((resolve) => { finishPdf = resolve; }));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutate).toHaveBeenCalledTimes(1));

    bridgeMockState.userId = 'staff-2';
    bridgeMockState.sessionId = 'session-2';
    bridgeMockState.transportId = 'transport-2';
    pane.rerender(<OutlookPanePage />);
    bridgeMockState.userId = 'staff-1';
    bridgeMockState.sessionId = 'session-1';
    bridgeMockState.transportId = 'transport-1';
    pane.rerender(<OutlookPanePage />);

    await act(async () => finishPdf({ fileName: 'A-quote.pdf', pdfBase64: 'JVBERw==' }));
    expect(createReplyCalls()).toHaveLength(0);
    expect(sendCommandMock.mock.calls.filter(([action]) => action === 'ADD_ATTACHMENT_TO_DRAFT'))
      .toHaveLength(0);
  });

  it('does not create a reply if the selected message switches away and back during PDF generation', async () => {
    let finishPdf!: (value: { fileName: string; pdfBase64: string }) => void;
    quotePdfMutate.mockImplementationOnce(() => new Promise((resolve) => { finishPdf = resolve; }));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(quotePdfMutate).toHaveBeenCalledTimes(1));

    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    bridgeMockState.selectedEntryId = '001';
    pane.rerender(<OutlookPanePage />);

    await act(async () => finishPdf({ fileName: 'stale-quote.pdf', pdfBase64: 'JVBERw==' }));
    expect(createReplyCalls()).toHaveLength(0);
  });

  it('reuses the reply operation ID after a client timeout so retry cannot duplicate the draft', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-1' });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(2));

    const firstPayload = createReplyCalls()[0]?.[1] as { operationId: string };
    const retryPayload = createReplyCalls()[1]?.[1] as { operationId: string };
    expect(firstPayload.operationId).toBeTruthy();
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('retains the reply operation ID when navigation renewal interrupts an in-flight COM mutation', async () => {
    sendCommandMock
      .mockRejectedValueOnce(
        new Error('Outlook navigation changed; inspect Outlook before retrying'),
      )
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-1', displayed: true });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(2));
    expect(createReplyCalls()[1]?.[1]).toEqual(createReplyCalls()[0]?.[1]);
  });

  it('reuses the reply operation ID when Outlook reports an unknown outcome', async () => {
    const indeterminateError = Object.assign(new Error('Outlook outcome is unknown.'), {
      code: 'OPERATION_OUTCOME_UNKNOWN',
    });
    sendCommandMock
      .mockRejectedValueOnce(indeterminateError)
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-001', displayed: true });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('status').textContent).toMatch(
      /Outlook may have completed.*Check Outlook Drafts before retrying/i,
    );
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(2));

    const firstPayload = createReplyCalls()[0]?.[1] as { operationId: string };
    const retryPayload = createReplyCalls()[1]?.[1] as { operationId: string };
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('keeps an unresolved reply ID when another message reply succeeds', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-for-002', displayed: true })
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-for-001', displayed: true });
    const pane = render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(2));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    bridgeMockState.selectedEntryId = '001';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(3));

    const firstPayload = createReplyCalls()[0]?.[1] as { operationId: string };
    const secondPayload = createReplyCalls()[1]?.[1] as { operationId: string };
    const retryPayload = createReplyCalls()[2]?.[1] as { operationId: string };
    expect(firstPayload.operationId).not.toBe(secondPayload.operationId);
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('allows a fresh reply operation after warning about an expired retry ID', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const startedAt = Date.now();
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ ...draftFolder, entryId: 'draft-after-expiry', displayed: true });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 15 * 60 * 1000 + 1000);
    fireEvent.click(button);

    expect(createReplyCalls()).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/safe retry window.*expired.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    expect(createReplyCalls()).toHaveLength(1);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Check Outlook Drafts/i));
    confirmSpy.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(2));

    const firstPayload = createReplyCalls()[0]?.[1] as { operationId: string };
    const freshPayload = createReplyCalls()[1]?.[1] as { operationId: string };
    expect(freshPayload.operationId).not.toBe(firstPayload.operationId);
    vi.spyOn(Date, 'now').mockRestore();
  });

  it('keeps the prior uncertain draft warning if selection changes before the new reply reaches Outlook', async () => {
    sessionStorage.setItem('nava_outlook_unresolved_reply_v1', '1');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishPdf!: (value: { fileName: string; pdfBase64: string }) => void;
    quotePdfMutate.mockImplementationOnce(() => new Promise((resolve) => { finishPdf = resolve; }));
    const pane = render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button); // warn about the prior uncertain outcome
    fireEvent.click(button); // explicitly confirm, then wait for the new PDF
    await waitFor(() => expect(quotePdfMutate).toHaveBeenCalledTimes(1));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    await act(async () => finishPdf({ fileName: 'Quote.pdf', pdfBase64: 'JVBERw==' }));
    expect(createReplyCalls()).toHaveLength(0);

    bridgeMockState.selectedEntryId = '001';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);
    expect(quotePdfMutate).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Check Outlook Drafts/i));
  });

  it('bounds expired outcomes and warns before starting new replies after the limit', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sendCommandMock.mockRejectedValue(new Error('Bridge command CREATE_REPLY_DRAFT timed out'));
    const pane = render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });
    const operationIds = new Map<string, string>();

    for (let index = 0; index < 257; index += 1) {
      const entryId = `message-${index}`;
      bridgeMockState.selectedEntryId = entryId;
      pane.rerender(<OutlookPanePage />);

      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });

      expect(createReplyCalls()).toHaveLength(index + 1);
      const payload = createReplyCalls()[index]?.[1] as { operationId: string };
      operationIds.set(entryId, payload.operationId);
      now += 15 * 60 * 1000 + 1;
    }

    bridgeMockState.selectedEntryId = 'message-0';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);

    expect(createReplyCalls()).toHaveLength(257);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/safe retry window.*expired.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    expect(createReplyCalls()).toHaveLength(257);
    confirmSpy.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(258));

    const freshPayload = createReplyCalls()[257]?.[1] as { operationId: string };
    expect(freshPayload.operationId).not.toBe(operationIds.get('message-0'));

    bridgeMockState.selectedEntryId = 'message-999';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);

    expect(createReplyCalls()).toHaveLength(258);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/expired reply outcomes.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    expect(createReplyCalls()).toHaveLength(258);
    fireEvent.click(button);
    await waitFor(() => expect(createReplyCalls()).toHaveLength(259));
    vi.spyOn(Date, 'now').mockRestore();
  }, 20000);

  it('blocks overlapping reply clicks synchronously until the native request settles', async () => {
    let finish!: (value: unknown) => void;
    sendCommandMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toMatch(/saving/i);

    await act(async () => finish({ ...draftFolder, entryId: 'draft-1', displayed: true }));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('shows native composer and placement warnings without claiming the draft opened', async () => {
    sendCommandMock.mockResolvedValueOnce({
      ...draftFolder,
      entryId: 'draft-1',
      displayed: false,
      composerWarning: 'Outlook blocked the composer',
      draftPlacementWarning: 'Reply stayed in the original Drafts folder',
      locationUnverified: true,
    });
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/saved.*not opened/i);
      expect(screen.getByRole('status').textContent).toMatch(/Outlook blocked the composer/);
      expect(screen.getByRole('status').textContent).toMatch(/original Drafts folder/);
      expect(screen.getByRole('status').textContent).toMatch(/location.*unverified/i);
    });
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/opened/i));
  });

  it('disables draft creation with a protocol v2 installer', () => {
    bridgeMockState.protocolVersion = 2;
    bridgeMockState.legacyReplySupported = true;
    render(<OutlookPanePage />);
    expect(
      screen.getByRole('button', { name: /Insert Draft in Outlook/i }).hasAttribute('disabled'),
    ).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('never uses a protocol v2 fallback to create a reply', () => {
    bridgeMockState.protocolVersion = 2;
    bridgeMockState.legacyReplySupported = true;
    render(<OutlookPanePage />);
    expect(
      screen.getByRole('button', { name: /Insert Draft in Outlook/i }).hasAttribute('disabled'),
    ).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('shows a folder placement warning in both the reply status and toast', async () => {
    sendCommandMock.mockResolvedValueOnce({
      ...draftFolder,
      entryId: 'draft-1',
      displayed: true,
      folderPlacementWarning: 'Outlook placed the reply outside the requested folder',
    });
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Outlook placed the reply outside the requested folder',
      ),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Outlook placed the reply outside the requested folder'),
    );
  });

  it('does not show the reply result from a previous selected message', async () => {
    let finish!: (value: unknown) => void;
    sendCommandMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    await act(async () => finish({ ...draftFolder, entryId: 'draft-for-001', displayed: true }));

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('identifies the original message in a late reply success toast', async () => {
    let finish!: (value: unknown) => void;
    sendCommandMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);

    await act(async () => finish({ ...draftFolder, entryId: 'draft-for-001', displayed: true }));

    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Suite Availability Request'),
    );
    expect(toast.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Different Guest Request'),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('preserves warnings and identifies the original message in a late reply warning toast', async () => {
    let finish!: (value: unknown) => void;
    sendCommandMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);

    await act(async () =>
      finish({
        ...draftFolder,
        entryId: 'draft-for-001',
        displayed: false,
        composerWarning: 'Outlook blocked the composer',
      }),
    );

    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Suite Availability Request'),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Outlook blocked the composer'),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('identifies the original message in a late reply error toast', async () => {
    let fail!: (reason: Error) => void;
    sendCommandMock.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    await waitFor(() => expect(createReplyCalls()).toHaveLength(1));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);

    await act(async () => fail(new Error('Bridge unavailable')));

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Suite Availability Request'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Bridge unavailable'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns when connected but bridge capabilities and protocol version are unknown', () => {
    bridgeMockState.protocolVersion = undefined;
    render(<OutlookPanePage />);
    expect(screen.getByRole('alert').textContent).toMatch(/update the Outlook add-in/i);
    expect(screen.getByRole('alert').textContent).toMatch(/update the Outlook add-in/i);
  });

  it('warns when an older installed bridge cannot provide protocol v4 actions', () => {
    bridgeMockState.protocolVersion = 2;
    render(<OutlookPanePage />);

    expect(screen.getByRole('alert').textContent).toMatch(/update the Outlook add-in/i);
    expect(
      screen.getByRole('button', { name: /Insert Draft in Outlook/i }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('registers /outlook-pane as a top-level route', () => {
    const routesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/routes.ts');
    const source = readFileSync(routesPath, 'utf8');
    expect(source).toContain("route('/outlook-pane', '(routes)/outlook-pane/page.tsx')");
    const loginIndex = source.indexOf("route('/zero/login'");
    const paneIndex = source.indexOf("route('/outlook-pane'");
    const layoutIndex = source.indexOf("layout('(routes)/layout.tsx'");
    expect(paneIndex).toBeGreaterThan(loginIndex);
    expect(paneIndex).toBeLessThan(layoutIndex);
  });

  it('describes the installer for Classic Outlook without claiming Outlook 2016 is installed', () => {
    const settingsPagePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../app/(routes)/settings/outlook-addin/page.tsx',
    );
    const source = readFileSync(settingsPagePath, 'utf8');
    expect(source).toContain('Classic Outlook for Windows');
    expect(source).toContain('New Outlook');
    expect(source).not.toContain('Outlook 2016');
  });
});
