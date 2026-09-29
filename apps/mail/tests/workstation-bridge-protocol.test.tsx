/**
 * @vitest-environment happy-dom
 */
import {
  parseBridgeMessage,
  createBridgeRequest,
  createOperationId,
  BRIDGE_PROTOCOL_VERSION,
  AccountSummarySchema,
  AccountCollectionResultSchema,
  BridgeCapabilitiesSchema,
  DeleteEmailResultSchema,
  FolderCollectionResultSchema,
  FolderEmailSummarySchema,
  FolderEmailPageSchema,
  FolderSummarySchema,
  MoveEmailResultSchema,
  SendDraftResultSchema,
  StoreSummarySchema,
  StoreCollectionResultSchema,
  StorePageSchema,
  AccountPageSchema,
  type WorkstationEmailPayload,
} from '../lib/workstation/bridge-protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useOutlookBridge } from '../lib/workstation/use-outlook-bridge';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import { useState } from 'react';

const { security, ticketMutate } = vi.hoisted(() => ({
  security: {
    userId: null as string | null,
    createdAt: new Date().toISOString(),
    transportId: null as string | null,
    email: 'shared@example.com',
    isLoading: false,
  },
  ticketMutate: vi.fn(),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: security.userId
      ? { user: { id: security.userId }, session: { createdAt: security.createdAt } }
      : null,
    isLoading: security.isLoading,
    refetch: vi.fn(),
  }),
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: security.transportId ? { id: security.transportId, email: security.email } : null,
    isLoading: security.isLoading,
  }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: { workstation: { bridgeTicket: { mutate: ticketMutate } } },
}));

describe('Workstation Bridge Protocol', () => {
  it('requires protocol v4 and retains only authorized native mail actions', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(4);
    const actions = [
      'GET_CAPABILITIES',
      'LIST_STORES',
      'LIST_FOLDERS',
      'UPDATE_DRAFT',
      'LIST_ACCOUNTS',
      'REGISTER_NAVIGATION',
      'CLEAR_SESSION',
    ] as const;

    for (const action of actions) {
      expect(createBridgeRequest(action, {}).action).toBe(action);
    }
  });

  it('parses store/folder/account records and IDs returned by the COM bridge', () => {
    expect(
      StoreSummarySchema.parse({ storeId: 'store-1', displayName: 'Reservations' }).storeId,
    ).toBe('store-1');
    expect(
      FolderSummarySchema.parse({
        storeId: 'store-1',
        entryId: 'folder-1',
        parentEntryId: 'root-1',
        name: 'Inbox',
        path: '\\Reservations\\Inbox',
        depth: 1,
      }).entryId,
    ).toBe('folder-1');
    expect(
      AccountSummarySchema.parse({
        smtpAddress: 'reservations@example.com',
        displayName: 'Reservations',
      }).smtpAddress,
    ).toBe('reservations@example.com');
    expect(
      FolderEmailSummarySchema.parse({
        entryId: 'mail-1',
        storeId: 'store-1',
        folderEntryId: 'folder-1',
        subject: 'Availability',
        senderName: 'Guest',
        receivedTime: '2026-09-17T12:00:00Z',
      }).storeId,
    ).toBe('store-1');
  });

  it('requires explicit truncation metadata for folder collections', () => {
    const folder = {
      storeId: 'store-1',
      entryId: 'folder-1',
      parentEntryId: 'root-1',
      name: 'Inbox',
      path: '\\Reservations\\Inbox',
      depth: 1,
    };

    expect(() => FolderCollectionResultSchema.parse([folder])).toThrow();
    expect(FolderCollectionResultSchema.parse({ items: [folder], truncated: true })).toEqual({
      items: [folder],
      truncated: true,
    });
    expect(() =>
      FolderCollectionResultSchema.parse({ items: Array(5001).fill(folder), truncated: true }),
    ).toThrow();
  });

  it('parses capabilities and the native send/delete result contracts', () => {
    const capabilities = BridgeCapabilitiesSchema.parse({
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
      supportedActions: ['SEND_DRAFT', 'DELETE_EMAIL'],
    });
    expect(capabilities.supportedActions).toContain('SEND_DRAFT');
    expect(capabilities.outlookVersion).toBe('16.0');
    expect(
      SendDraftResultSchema.parse({
        submitted: true,
        usedDefaultAccount: false,
        accountSmtpAddress: 'reservations@example.com',
      }).submitted,
    ).toBe(true);
    expect(
      SendDraftResultSchema.parse({
        submitted: true,
        usedDefaultAccount: true,
        accountSmtpAddress: null,
      }).usedDefaultAccount,
    ).toBe(true);
    expect(
      DeleteEmailResultSchema.parse({
        deleted: true,
        permanent: true,
        exchangeRetentionMayKeepRecoverableCopy: true,
      }).permanent,
    ).toBe(true);
  });

  it('distinguishes confirmed and unconfirmed move results', () => {
    const location = {
      entryId: 'mail-2',
      storeId: 'store-1',
      folderEntryId: 'target',
      folderName: 'Archive',
    };
    expect(
      MoveEmailResultSchema.parse({ ...location, moved: true, moveStatus: 'confirmed' }).moveStatus,
    ).toBe('confirmed');
    expect(
      MoveEmailResultSchema.parse({
        ...location,
        entryId: '',
        moveStatus: 'unconfirmed',
        locationUnverified: true,
        folderPlacementWarning: 'Could not verify whether the move completed.',
      }).moveStatus,
    ).toBe('unconfirmed');
    expect(() =>
      MoveEmailResultSchema.parse({
        ...location,
        moved: true,
        moveStatus: 'unconfirmed',
        locationUnverified: true,
        folderPlacementWarning: 'Unknown',
      }),
    ).toThrow();
  });

  it('serializes a GET_ACTIVE_EMAIL request with protocol version', () => {
    const req = createBridgeRequest('GET_ACTIVE_EMAIL', {});
    expect(req.action).toBe('GET_ACTIVE_EMAIL');
    expect(req.version).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.startsWith('req_')).toBe(true);
  });

  it('creates stable-operation identifiers distinct from transport request IDs', () => {
    const startedAt = Date.now();
    const operationId = createOperationId();
    const request = createBridgeRequest('CREATE_DRAFT', { operationId });
    expect(operationId).toBeTruthy();
    const [prefix, createdAt, uniqueId] = operationId.split('_');
    expect(prefix).toBe('op');
    expect(Number(createdAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Number(createdAt)).toBeLessThanOrEqual(Date.now());
    expect(uniqueId).toMatch(/^[0-9a-f]{32}$/i);
    expect(request.requestId).not.toBe(operationId);
    expect(request.payload.operationId).toBe(operationId);
  });

  it('parses folder pages with stable continuation tokens', () => {
    const page = FolderEmailPageSchema.parse({
      items: [
        {
          entryId: 'mail-1',
          storeId: 'store-1',
          folderEntryId: 'folder-1',
          subject: 'Availability',
          senderName: 'Guest',
          receivedTime: '2026-09-17T12:00:00Z',
        },
      ],
      continuationToken: 'snapshot-1:200',
      snapshotTruncated: false,
      totalItems: 450,
      storeId: 'store-1',
      folderEntryId: 'folder-1',
    });

    expect(page.items).toHaveLength(1);
    expect(page.continuationToken).toBe('snapshot-1:200');
    expect(page.storeId).toBe('store-1');
  });

  it('accepts bounded store/account pages but rejects legacy unscoped array responses', () => {
    const store = { storeId: 'store-1', displayName: 'Reservations', isDefault: true };
    const account = { smtpAddress: 'help@example.com', displayName: 'Help' };
    expect(() => StoreCollectionResultSchema.parse([store])).toThrow();
    expect(() => AccountCollectionResultSchema.parse([account])).toThrow();
    expect(
      StorePageSchema.parse({
        items: [store],
        totalItems: 400,
        continuationToken: 'stores:200',
        truncated: true,
      }).continuationToken,
    ).toBe('stores:200');
    expect(
      AccountPageSchema.parse({
        items: [account],
        totalItems: 400,
        continuationToken: 'accounts:200',
        truncated: true,
      }).items,
    ).toHaveLength(1);
    expect(() => StoreCollectionResultSchema.parse(Array(201).fill(store))).toThrow();
    expect(() =>
      AccountCollectionResultSchema.parse({
        items: Array(201).fill(account),
        totalItems: 201,
        continuationToken: null,
        truncated: false,
      }),
    ).toThrow();
  });

  it('parses a valid email payload from C# bridge with headers', () => {
    const raw = JSON.stringify({
      requestId: 'req-123',
      version: 1,
      success: true,
      data: {
        entryId: '000000001',
        subject: 'Reservation Inquiry for Oct 12-15',
        senderEmail: 'guest@example.com',
        senderName: 'John Smith',
        receivedTime: '2026-09-17T14:30:00Z',
        bodyText: 'Do you have 2 luxury suites available?',
        bodyHtml: '<p>Do you have 2 luxury suites available?</p>',
        conversationId: 'conv-99',
        internetMessageId: '<msg123@guest.com>',
      } satisfies WorkstationEmailPayload,
    });

    const parsed = parseBridgeMessage<WorkstationEmailPayload>(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.subject).toContain('Reservation Inquiry');
    expect(parsed.data?.internetMessageId).toBe('<msg123@guest.com>');
  });

  it('rejects malformed payloads gracefully without throwing', () => {
    const parsed = parseBridgeMessage('invalid-json');
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it('preserves structured native operation-outcome error codes', () => {
    const parsed = parseBridgeMessage(
      JSON.stringify({
        requestId: 'req-unknown-outcome',
        action: 'CREATE_REPLY_DRAFT',
        success: false,
        error: 'Outlook may have completed the operation.',
        errorCode: 'OPERATION_OUTCOME_UNKNOWN',
      }),
    );

    expect(parsed.errorCode).toBe('OPERATION_OUTCOME_UNKNOWN');
  });
});

const renderedSubjects: string[] = [];
const renderedReplyAvailability: boolean[] = [];
function BridgeProbe() {
  const {
    isConnected,
    activeEmail,
    workstationInfo,
    requiresRelogin,
    supportsAction,
    sendCommand,
    pairDevice,
  } = useOutlookBridge();
  const [errorCode, setErrorCode] = useState('');
  renderedSubjects.push(activeEmail?.subject ?? '');
  renderedReplyAvailability.push(supportsAction('CREATE_REPLY_DRAFT'));
  return (
    <div>
      <span data-testid="connected">{isConnected ? 'yes' : 'no'}</span>
      <span data-testid="subject">{activeEmail?.subject ?? ''}</span>
      <span data-testid="protocol">{workstationInfo?.bridgeProtocolVersion ?? ''}</span>
      <span data-testid="relogin">{requiresRelogin ? 'required' : 'ready'}</span>
      <span data-testid="send-supported">{supportsAction('LIST_FOLDERS') ? 'yes' : 'no'}</span>
      <span data-testid="reply-supported">
        {supportsAction('CREATE_REPLY_DRAFT') ? 'yes' : 'no'}
      </span>
      <span data-testid="bridge-error-code">{errorCode}</span>
      <button
        type="button"
        onClick={() => {
          void pairDevice().catch(() => undefined);
        }}
      >
        Pair native
      </button>
      <button
        type="button"
        onClick={() => {
          void sendCommand('LIST_STORES', {}).catch(() => undefined);
        }}
      >
        List approved stores
      </button>
      <button
        type="button"
        onClick={() => {
          void sendCommand('MOVE_EMAIL', {
            entryIds: Array.from({ length: 10 }, (_, index) => `mail-${index + 1}`),
            storeId: 'store-approved',
            folderEntryId: 'folder-inbox',
            targetStoreId: 'store-approved',
            targetFolderEntryId: 'folder-archive',
            operationId: createOperationId(),
          }).catch(() => undefined);
        }}
      >
        Move approved batch
      </button>
      <button
        type="button"
        onClick={() => {
          void sendCommand<Record<string, never>, unknown>(
            'CREATE_REPLY_DRAFT',
            {} as Record<string, never>,
          ).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
              setErrorCode(error.code);
            }
          });
        }}
      >
        Trigger bridge error
      </button>
    </div>
  );
}

const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

type TestBridgeRequest = { requestId: string; action: string };

async function waitForBridgeRequest(
  action: string,
  afterCallIndex = 0,
): Promise<TestBridgeRequest> {
  let request: TestBridgeRequest | undefined;
  await waitFor(
    () => {
      const postMessage = window.chrome?.webview?.postMessage as unknown as {
        mock: { calls: Array<[unknown]> };
      };
      request = postMessage.mock.calls
        .slice(afterCallIndex)
        .map(([raw]) => JSON.parse(String(raw)) as TestBridgeRequest)
        .find((candidate) => candidate.action === action);
      expect(request).toBeDefined();
    },
    { timeout: 5_000 },
  );
  return request!;
}

const paneChallenge = 'a'.repeat(43);
const nativeMessages = () => {
  if (!window.chrome?.webview) throw new Error('Outlook bridge unavailable in test');
  const calls = (window.chrome.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string]
  >;
  return calls.map(
    ([message]) => JSON.parse(message) as TestBridgeRequest & Record<string, unknown>,
  );
};

function respondV4(request: TestBridgeRequest, data: unknown, success = true) {
  act(() => {
    for (const listener of listeners.get('message') ?? []) {
      listener({
        data: JSON.stringify({
          version: 4,
          requestId: request.requestId,
          action: request.action,
          success,
          data,
          error: success ? null : 'Ticket denied',
        }),
      });
    }
  });
}

describe('v4 staff-authorized Outlook navigation', () => {
  beforeEach(() => {
    listeners.clear();
    security.userId = null;
    security.transportId = null;
    setMailCacheScope({ userId: null, activeTransportId: null });
    security.createdAt = new Date().toISOString();
    security.isLoading = false;
    ticketMutate.mockReset();
    ticketMutate.mockResolvedValue({
      ticket: 'one-use',
      storeId: 'store-approved',
      expiresInSeconds: 60,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          protocol: 'nava-outlook-v4',
          status: 'ready',
          paneChallenge,
          expiresInSeconds: 60,
        }),
      }),
    );
    window.chrome = {
      webview: {
        postMessage: vi.fn(),
        addEventListener: (type, listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type, listener) => {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((item) => item !== listener),
          );
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete window.chrome;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setMailCacheScope({ userId: null, activeTransportId: null });
  });

  async function registerPane() {
    const ping = await waitForBridgeRequest('PING');
    respondV4(ping, {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('yes'));
    const registration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    expect((registration as { payload?: unknown }).payload).toEqual({ paneChallenge });
    respondV4(registration, { registered: true });
  }

  it('never requests mail or a ticket until real session and selected transport are ready', async () => {
    const pane = render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    expect(ticketMutate).not.toHaveBeenCalled();
    expect(nativeMessages().some((message) => message.action === 'GET_ACTIVE_EMAIL')).toBe(false);
    security.userId = 'staff-1';
    pane.rerender(<BridgeProbe />);
    expect(ticketMutate).not.toHaveBeenCalled();
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    pane.rerender(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('REGISTER_NAVIGATION'), { registered: true });
    await waitFor(() =>
      expect(ticketMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-1',
          paneChallenge,
          action: 'GET_CAPABILITIES',
        }),
      ),
    );
  });

  it('rejects old add-ins without a legacy read or ticket', async () => {
    render(<BridgeProbe />);
    const request = await waitForBridgeRequest('PING');
    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: request.requestId,
            action: 'PING',
            version: 3,
            success: true,
            data: {
              bridgeProtocolVersion: 3,
              version: '1.0.11',
              workstationUser: 'must-not-display',
            },
          }),
        });
      }
    });
    await waitFor(() => expect(screen.getByTestId('protocol').textContent).toBe('3'));
    expect(screen.getByTestId('connected').textContent).toBe('yes');
    expect(ticketMutate).not.toHaveBeenCalled();
    expect(nativeMessages().map((message) => message.action)).toEqual(['PING']);
  });

  it('keeps a mailbox-neutral PING alive when staff and transport resolve while PING is pending', async () => {
    const pane = render(<BridgeProbe />);
    const ping = await waitForBridgeRequest('PING');
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    pane.rerender(<BridgeProbe />);
    respondV4(ping, {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    expect((await waitForBridgeRequest('REGISTER_NAVIGATION')).action).toBe('REGISTER_NAVIGATION');
  });

  it('waits for QueryProvider to install the exact active transport header before the first ticket', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: null });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('yes'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(ticketMutate).not.toHaveBeenCalled();
    expect(nativeMessages().map((message) => message.action)).toEqual(['PING']);
    act(() => setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' }));
    respondV4(await waitForBridgeRequest('REGISTER_NAVIGATION'), { registered: true });
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledTimes(1));
    expect(ticketMutate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ action: 'GET_CAPABILITIES' }),
    );
  });

  it('retries a transient bootstrap failure while signed in without needing a pane reload', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network temporarily unavailable'));
    render(<BridgeProbe />);
    const ping = await waitForBridgeRequest('PING');
    vi.useFakeTimers();
    respondV4(ping, {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ticketMutate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.useRealTimers();
    respondV4(await waitForBridgeRequest('REGISTER_NAVIGATION'), { registered: true });
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledTimes(1));
  });

  it('rechecks session and stops after a repeated denied ticket instead of looping navigation registrations', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    ticketMutate.mockRejectedValue(new Error('Bridge ticket denied'));
    render(<BridgeProbe />);
    await registerPane();
    await waitFor(() =>
      expect(
        nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION'),
      ).toHaveLength(2),
    );
    const second = nativeMessages().filter(
      (message) => message.action === 'REGISTER_NAVIGATION',
    )[1];
    respondV4(second!, { registered: true });
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION'),
    ).toHaveLength(2);
    expect(screen.getByTestId('subject').textContent).toBe('');
  });

  it('opens native-only pairing and rechecks PING before registering the staff navigation', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: false,
      deviceId: null,
    });
    expect(nativeMessages().map((message) => message.action)).toEqual(['PING']);
    fireEvent.click(screen.getByRole('button', { name: 'Pair native' }));
    respondV4(await waitForBridgeRequest('PAIR_DEVICE'), { paired: true });
    const ping = await waitForBridgeRequest('PING', 2);
    respondV4(ping, {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    expect((await waitForBridgeRequest('REGISTER_NAVIGATION')).action).toBe('REGISTER_NAVIGATION');
  });

  it('requires re-login after 24 hours and refuses to mint COM tickets even if the cached session still has a user', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    security.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    await waitFor(() => expect(screen.getByTestId('relogin').textContent).toBe('required'));
    expect(ticketMutate).not.toHaveBeenCalled();
    expect(nativeMessages().map((message) => message.action)).toEqual(['PING']);
  });

  it('revokes the current native navigation and drops pending email when the session expires', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    const pane = render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL'],
    });
    const read = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date(security.createdAt).getTime() + 24 * 60 * 60 * 1000 + 1,
    );
    pane.rerender(<BridgeProbe />);
    await waitFor(() => expect(screen.getByTestId('relogin').textContent).toBe('required'));
    respondV4(read, {
      entryId: 'late',
      subject: 'Sensitive',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Private',
      bodyHtml: '',
    });
    expect(screen.getByTestId('subject').textContent).toBe('');
    expect(nativeMessages().map((message) => message.action)).toContain('CLEAR_SESSION');
  });

  it('binds tickets and every COM command to the returned store and active transport', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    await waitForBridgeRequest('GET_CAPABILITIES');
    const firstTicket = ticketMutate.mock.calls[0]?.[0];
    expect(firstTicket).not.toHaveProperty('storeId');
    const capability = nativeMessages().find((message) => message.action === 'GET_CAPABILITIES');
    expect(capability).toMatchObject({
      version: 4,
      ticket: 'one-use',
      transportId: 'transport-1',
      payload: { storeId: 'store-approved' },
    });
    respondV4(capability!, {
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
      supportedActions: ['GET_ACTIVE_EMAIL', 'CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT'],
    });
    await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    expect(ticketMutate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ action: 'GET_ACTIVE_EMAIL', storeId: 'store-approved' }),
    );
    expect(nativeMessages().find((message) => message.action === 'GET_ACTIVE_EMAIL')).toMatchObject(
      { version: 4, payload: { storeId: 'store-approved' } },
    );
  });

  it('declares exact ordered batch resources and folder IDs without browser-supplied native consent', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL', 'MOVE_EMAIL'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    fireEvent.click(screen.getByRole('button', { name: 'Move approved batch' }));
    await waitFor(() =>
      expect(ticketMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MOVE_EMAIL',
          storeId: 'store-approved',
          resources: Array.from({ length: 10 }, (_, index) => `mail-${index + 1}`),
          sourceFolderId: 'folder-inbox',
          destinationFolderId: 'folder-archive',
          operationId: expect.stringMatching(/^op_\d+_[0-9a-f]{32}$/),
        }),
      ),
    );
    const move = (await waitForBridgeRequest('MOVE_EMAIL')) as TestBridgeRequest &
      Record<string, unknown>;
    expect(move).toMatchObject({
      ticket: 'one-use',
      transportId: 'transport-1',
      payload: {
        storeId: 'store-approved',
        folderEntryId: 'folder-inbox',
        targetFolderEntryId: 'folder-archive',
      },
    });
    expect(move).not.toHaveProperty('nativeBatchConsent');
  });

  it('requests bounded native store pages so v4 never receives the old unscoped array format', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_STORES'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    const stores = (await waitForBridgeRequest('LIST_STORES')) as TestBridgeRequest &
      Record<string, unknown>;
    expect(stores).toMatchObject({
      version: 4,
      payload: { storeId: 'store-approved', pageSize: 200 },
    });
  });

  it('clears outstanding mail and does not accept metadata-free stale selections on logout', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    const pane = render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL'],
    });
    const read = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    security.userId = null;
    pane.rerender(<BridgeProbe />);
    await waitFor(() => expect(screen.getByTestId('subject').textContent).toBe(''));
    respondV4(read, {
      entryId: 'late-mail',
      subject: 'Sensitive',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Private',
      bodyHtml: '',
    });
    respondV4({ action: 'ON_SELECTION_CHANGED', requestId: 'evt_selection_old' }, null);
    expect(screen.getByTestId('subject').textContent).toBe('');
    expect(nativeMessages().some((message) => message.action === 'CLEAR_SESSION')).toBe(true);
  });

  it('does not render the previous account email even for the first render after switching accounts', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    const pane = render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), {
      entryId: 'mail-1',
      storeId: 'store-approved',
      folderEntryId: 'inbox',
      subject: 'Private account 1',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Private',
      bodyHtml: '',
    });
    await waitFor(() =>
      expect(screen.getByTestId('subject').textContent).toBe('Private account 1'),
    );
    const renderedBeforeSwitch = renderedSubjects.length;
    security.userId = 'staff-2';
    pane.rerender(<BridgeProbe />);
    expect(renderedSubjects.slice(renderedBeforeSwitch)).not.toContain('Private account 1');
    expect(screen.getByTestId('subject').textContent).toBe('');
    expect(screen.getByTestId('reply-supported').textContent).toBe('no');
    expect(ticketMutate.mock.calls.every(([input]) => input.action !== 'CREATE_REPLY_DRAFT')).toBe(
      true,
    );
  });

  it('treats selection events as metadata-free hints and reads the new item only with a fresh ticket', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['GET_ACTIVE_EMAIL'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    const before = nativeMessages().length;
    act(() => {
      for (const listener of listeners.get('message') ?? [])
        listener({
          data: JSON.stringify({
            version: 4,
            requestId: 'evt_selection_changed',
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: { subject: 'Spoofed from event', bodyText: 'Untrusted content' },
          }),
        });
    });
    expect(screen.getByTestId('subject').textContent).toBe('');
    const freshRead = await waitForBridgeRequest('GET_ACTIVE_EMAIL', before);
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledTimes(3));
    respondV4(freshRead, {
      entryId: 'new-mail',
      storeId: 'store-approved',
      folderEntryId: 'folder-inbox',
      subject: 'Authorized selection',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Approved',
      bodyHtml: '',
    });
    await waitFor(() =>
      expect(screen.getByTestId('subject').textContent).toBe('Authorized selection'),
    );
  });
});
