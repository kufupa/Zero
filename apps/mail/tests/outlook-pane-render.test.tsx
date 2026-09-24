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
  bridgeMockState: { protocolVersion: 3 as number | undefined },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const v3Capabilities = {
  bridgeProtocolVersion: 3,
  addinVersion: '1.0.9',
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
      addinVersion: bridgeMockState.protocolVersion === 3 ? '1.0.9' : '1.0.8',
      bridgeProtocolVersion: bridgeMockState.protocolVersion,
    },
    capabilities: bridgeMockState.protocolVersion === 3 ? v3Capabilities : null,
    supportsAction: (action: string) =>
      bridgeMockState.protocolVersion === 3
        ? v3Capabilities.supportedActions.includes(action)
        : ['PING', 'GET_ACTIVE_EMAIL', 'GET_FOLDER_EMAILS', 'CREATE_REPLY_DRAFT'].includes(action),
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
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    bridgeMockState.protocolVersion = 3;
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
