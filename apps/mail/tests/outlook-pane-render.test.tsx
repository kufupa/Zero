/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { toast } from 'sonner';
import path from 'node:path';

const { sendCommandMock, bridgeMockState } = vi.hoisted(() => ({
  sendCommandMock: vi.fn().mockResolvedValue({ success: true }),
  bridgeMockState: {
    protocolVersion: 3 as number | undefined,
    selectedEntryId: '001',
    legacyReplySupported: undefined as boolean | undefined,
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const v3Capabilities = {
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
  supportedActions: ['GET_CAPABILITIES', 'GET_ACTIVE_EMAIL', 'CREATE_REPLY_DRAFT', 'SEND_DRAFT'],
};

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      workstationUser: 'ropperman',
      outlookEmail: 'ropperman@legacyhotels.co.za',
      outlookVersion: '16.0',
      addinVersion: bridgeMockState.protocolVersion === 3 ? '1.0.11' : '1.0.8',
      bridgeProtocolVersion: bridgeMockState.protocolVersion,
    },
    capabilities: bridgeMockState.protocolVersion === 3 ? v3Capabilities : null,
    supportsAction: (action: string) =>
      bridgeMockState.protocolVersion === 3
        ? v3Capabilities.supportedActions.includes(action)
        : (action === 'CREATE_REPLY_DRAFT' && bridgeMockState.legacyReplySupported === true) ||
          ['PING', 'GET_ACTIVE_EMAIL', 'GET_FOLDER_EMAILS', 'GET_EMAIL_BY_ENTRY_ID'].includes(
            action,
          ),
    activeEmail: {
      entryId: bridgeMockState.selectedEntryId,
      storeId: 'store-1',
      subject:
        bridgeMockState.selectedEntryId === '001'
          ? 'Suite Availability Request'
          : 'Different Guest Request',
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
    data: { user: { email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' } },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
    },
  },
}));

describe('OutlookPanePage', () => {
  afterEach(() => {
    cleanup();
    sendCommandMock.mockClear();
    vi.restoreAllMocks();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.error).mockClear();
    bridgeMockState.protocolVersion = 3;
    bridgeMockState.selectedEntryId = '001';
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

  it('reuses the reply operation ID after a client timeout so retry cannot duplicate the draft', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ entryId: 'draft-1' });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(2));

    const firstPayload = sendCommandMock.mock.calls[0]?.[1] as { operationId: string };
    const retryPayload = sendCommandMock.mock.calls[1]?.[1] as { operationId: string };
    expect(firstPayload.operationId).toBeTruthy();
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('reuses the reply operation ID when Outlook reports an unknown outcome', async () => {
    const indeterminateError = Object.assign(new Error('Outlook outcome is unknown.'), {
      code: 'OPERATION_OUTCOME_UNKNOWN',
    });
    sendCommandMock
      .mockRejectedValueOnce(indeterminateError)
      .mockResolvedValueOnce({ entryId: 'draft-001', displayed: true });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('status').textContent).toMatch(
      /Outlook may have completed.*Check Outlook Drafts before retrying/i,
    );
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(2));

    const firstPayload = sendCommandMock.mock.calls[0]?.[1] as { operationId: string };
    const retryPayload = sendCommandMock.mock.calls[1]?.[1] as { operationId: string };
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('keeps an unresolved reply ID when another message reply succeeds', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ entryId: 'draft-for-002', displayed: true })
      .mockResolvedValueOnce({ entryId: 'draft-for-001', displayed: true });
    const pane = render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    bridgeMockState.selectedEntryId = '001';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(3));

    const firstPayload = sendCommandMock.mock.calls[0]?.[1] as { operationId: string };
    const secondPayload = sendCommandMock.mock.calls[1]?.[1] as { operationId: string };
    const retryPayload = sendCommandMock.mock.calls[2]?.[1] as { operationId: string };
    expect(firstPayload.operationId).not.toBe(secondPayload.operationId);
    expect(retryPayload.operationId).toBe(firstPayload.operationId);
  });

  it('allows a fresh reply operation after warning about an expired retry ID', async () => {
    const startedAt = Date.now();
    sendCommandMock
      .mockRejectedValueOnce(new Error('Bridge command CREATE_REPLY_DRAFT timed out'))
      .mockResolvedValueOnce({ entryId: 'draft-after-expiry', displayed: true });
    render(<OutlookPanePage />);
    const button = screen.getByRole('button', { name: /Insert Draft in Outlook/i });

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));

    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 15 * 60 * 1000 + 1000);
    fireEvent.click(button);

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/safe retry window.*expired.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(2));

    const firstPayload = sendCommandMock.mock.calls[0]?.[1] as { operationId: string };
    const freshPayload = sendCommandMock.mock.calls[1]?.[1] as { operationId: string };
    expect(freshPayload.operationId).not.toBe(firstPayload.operationId);
  });

  it('bounds expired outcomes and warns before starting new replies after the limit', async () => {
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

      expect(sendCommandMock).toHaveBeenCalledTimes(index + 1);
      const payload = sendCommandMock.mock.calls[index]?.[1] as { operationId: string };
      operationIds.set(entryId, payload.operationId);
      now += 15 * 60 * 1000 + 1;
    }

    bridgeMockState.selectedEntryId = 'message-0';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);

    expect(sendCommandMock).toHaveBeenCalledTimes(257);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/safe retry window.*expired.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(258));

    const freshPayload = sendCommandMock.mock.calls[257]?.[1] as { operationId: string };
    expect(freshPayload.operationId).not.toBe(operationIds.get('message-0'));

    bridgeMockState.selectedEntryId = 'message-999';
    pane.rerender(<OutlookPanePage />);
    fireEvent.click(button);

    expect(sendCommandMock).toHaveBeenCalledTimes(258);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/expired reply outcomes.*check Outlook Drafts.*new operation/i),
    );

    fireEvent.click(button);
    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(259));
  });

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
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toMatch(/saving/i);

    await act(async () => finish({ entryId: 'draft-1', displayed: true }));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('shows native composer and placement warnings without claiming the draft opened', async () => {
    sendCommandMock.mockResolvedValueOnce({
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

  it('maps a legacy true reply result to an opened composer with unknown save status', async () => {
    bridgeMockState.protocolVersion = 2;
    bridgeMockState.legacyReplySupported = true;
    sendCommandMock.mockResolvedValueOnce(true);
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /opened the reply composer.*save status is unconfirmed/i,
      ),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/opened the reply composer.*save status is unconfirmed/i),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a legacy false reply result as a failure', async () => {
    bridgeMockState.protocolVersion = 2;
    bridgeMockState.legacyReplySupported = true;
    sendCommandMock.mockResolvedValueOnce(false);
    render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Outlook could not create the reply draft'),
      ),
    );
  });

  it('shows a folder placement warning in both the reply status and toast', async () => {
    sendCommandMock.mockResolvedValueOnce({
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
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);
    await act(async () => finish({ entryId: 'draft-for-001', displayed: true }));

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('identifies the original message in a late reply success toast', async () => {
    let finish!: (value: unknown) => void;
    sendCommandMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pane = render(<OutlookPanePage />);
    fireEvent.click(screen.getByRole('button', { name: /Insert Draft in Outlook/i }));
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);

    await act(async () => finish({ entryId: 'draft-for-001', displayed: true }));

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
    bridgeMockState.selectedEntryId = '002';
    pane.rerender(<OutlookPanePage />);

    await act(async () =>
      finish({
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
    expect(screen.getByRole('alert').textContent).toMatch(/protocol v3 not confirmed/i);
    expect(screen.getByRole('alert').textContent).toMatch(/update the Outlook add-in/i);
  });

  it('warns when an older installed bridge cannot provide protocol v3 actions', () => {
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
