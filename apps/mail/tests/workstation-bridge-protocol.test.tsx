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
  MailboxSyncControlSchema,
  ReadRootPolicyV1Schema,
  supportsMailboxSync,
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

const { security, ticketMutate, reportMutate } = vi.hoisted(() => ({
  security: {
    userId: null as string | null,
    createdAt: new Date().toISOString(),
    transportId: null as string | null,
    email: 'shared@example.com',
    isLoading: false,
  },
  ticketMutate: vi.fn(),
  reportMutate: vi.fn(),
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
  trpcClient: { workstation: { bridgeTicket: { mutate: ticketMutate }, reportBridgeFailure: { mutate: reportMutate } } },
}));

it('separates pane navigation cancellation from staff logout',()=>{expect(createBridgeRequest('CLEAR_NAVIGATION',{}).action).toBe('CLEAR_NAVIGATION');expect(createBridgeRequest('CLEAR_SESSION',{}).action).toBe('CLEAR_SESSION');});

describe('Workstation Bridge Protocol', () => {
  it('negotiates only mailboxSync version one and finite bounded controls', () => {
    expect(supportsMailboxSync({ mailboxSync: 1 })).toBe(true);
    expect(supportsMailboxSync({})).toBe(false);
    expect(supportsMailboxSync({ mailboxSync: 2 })).toBe(false);
    expect(supportsMailboxSync({ mailboxSync: '1' })).toBe(false);
    for (const operation of ['start', 'pause', 'resume', 'syncNow', 'retryMissing'])
      expect(MailboxSyncControlSchema.safeParse({ sourceId: 'source', operation }).success).toBe(true);
    expect(MailboxSyncControlSchema.safeParse({ sourceId: 'source', operation: 'evaluate' }).success).toBe(false);
    expect(MailboxSyncControlSchema.safeParse({ sourceId: 'source', operation: 'start', code: 'arbitrary' }).success).toBe(false);
    expect(MailboxSyncControlSchema.safeParse({ sourceId: 'source', operation: 'start', window: { from: '2026-10-04T00:00:00Z', to: '2026-10-03T00:00:00Z' } }).success).toBe(false);
    expect(ReadRootPolicyV1Schema.safeParse({ storeId: 'store', rootEntryId: 'root', policyVersion: 1, policyGeneration: 1 }).success).toBe(true);
    expect(ReadRootPolicyV1Schema.safeParse({ storeId: 'store', rootEntryId: 'root', policyVersion: 2, policyGeneration: 1 }).success).toBe(false);
    expect(ReadRootPolicyV1Schema.safeParse({
      storeId: 'A'.repeat(600), rootEntryId: 'root', policyVersion: 1, policyGeneration: 1,
    }).success).toBe(true);
  });

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
    refreshAuthorization,
    authorizationUnavailable,
    selectionOutsideMailbox,
  } = useOutlookBridge();
  const [errorCode, setErrorCode] = useState('');
  renderedSubjects.push(activeEmail?.subject ?? '');
  renderedReplyAvailability.push(supportsAction('CREATE_REPLY_DRAFT'));
  return (
    <div>
      <span data-testid="connected">{isConnected ? 'yes' : 'no'}</span>
      <span data-testid="subject">{activeEmail?.subject ?? ''}</span>
      <span data-testid="protocol">{workstationInfo?.bridgeProtocolVersion ?? ''}</span>
      <span data-testid="paired">{workstationInfo?.paired ? 'yes' : 'no'}</span>
      <span data-testid="device-id">{workstationInfo?.deviceId ?? ''}</span>
      <span data-testid="relogin">{requiresRelogin ? 'required' : 'ready'}</span>
      <span data-testid="send-supported">{supportsAction('LIST_FOLDERS') ? 'yes' : 'no'}</span>
      <span data-testid="reply-supported">
        {supportsAction('CREATE_REPLY_DRAFT') ? 'yes' : 'no'}
      </span>
      <span data-testid="bridge-error-code">{errorCode}</span>
      <span data-testid="auth-unavailable">{authorizationUnavailable ? 'yes' : 'no'}</span>
      <span data-testid="outside-mailbox">{selectionOutsideMailbox ? 'yes' : 'no'}</span>
      <button
        type="button"
        onClick={() => {
          void sendCommand('CREATE_REPLY_DRAFT', {
            entryIds: ['mail-1'],
            folderEntryId: 'folder-inbox',
            operationId: createOperationId(),
          }).then(
            () => setErrorCode('draft-succeeded'),
            () => setErrorCode('draft-failed'),
          );
        }}
      >
        Create reply draft
      </button>
      <button
        type="button"
        onClick={() => {
          void pairDevice().catch(() => undefined);
        }}
      >
        Pair native
      </button>
      <button type="button" onClick={refreshAuthorization}>Refresh approval</button>
      <button
        type="button"
        onClick={() => {
          void sendCommand('LIST_STORES', {}).then(
            () => setErrorCode('list-succeeded'),
            () => setErrorCode('list-canceled'),
          );
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
          }).then(
            () => setErrorCode('move-succeeded'),
            () => setErrorCode('move-denied'),
          );
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

type TestBridgeRequest = { requestId: string; action: string; payload?: unknown };

async function waitForBridgeRequest(
  action: string,
  afterCallIndex = 0,
  timeout = 5_000,
): Promise<TestBridgeRequest> {
  let request: TestBridgeRequest | undefined;
  await waitFor(
    () => {
      const postMessage = window.chrome?.webview?.postMessage as unknown as {
        mock: { calls: Array<[unknown]> };
      };
      const requests = postMessage.mock.calls
        .slice(afterCallIndex)
        .map(([raw]) => JSON.parse(String(raw)) as TestBridgeRequest);
      request = requests.find((candidate) => candidate.action === action);
      expect(request, `Expected ${action} after call ${afterCallIndex}; saw ${requests.map(
        (candidate) => candidate.action,
      ).join(', ') || 'no native messages'}`).toBeDefined();
    },
    { timeout },
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

function respondV4(request: TestBridgeRequest, data: unknown, success = true, error = 'Ticket denied') {
  act(() => {
    for (const listener of listeners.get('message') ?? []) {
      listener({
        data: JSON.stringify({
          version: 4,
          requestId: request.requestId,
          action: request.action,
          success,
          data,
          error: success ? null : error,
        }),
      });
    }
  });
}

function resolveNativeMoveConsent(consentRequestId: string, operationId: string, approved: boolean) {
  respondV4({ action: 'NATIVE_MOVE_CONSENT_RESOLVED', requestId: 'event' },
    { consentRequestId, operationId, approved });
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
    reportMutate.mockReset();
    reportMutate.mockResolvedValue(undefined);
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
    vi.useRealTimers();
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

  it('pane unmount clears only navigation while explicit staff scope loss clears capture',async()=>{
    security.userId='staff-1';security.transportId='transport-1';setMailCacheScope({userId:'staff-1',activeTransportId:'transport-1'});
    const pane=render(<BridgeProbe/>);await registerPane();respondV4(await waitForBridgeRequest('GET_CAPABILITIES'),{bridgeProtocolVersion:4,addinVersion:'1.0.12',outlookVersion:'16.0',runtime:'Classic Outlook',newOutlookSupported:false,interactiveProfileRequired:true,maxPageSize:200,maxFolderDepth:64,maxFolderCount:5000,maxFolderSnapshotItems:5000,supportedActions:['GET_ACTIVE_EMAIL']});respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'),null);const start=nativeMessages().length;pane.unmount();expect(nativeMessages().slice(start).map(x=>x.action)).toContain('CLEAR_NAVIGATION');expect(nativeMessages().slice(start).map(x=>x.action)).not.toContain('CLEAR_SESSION');
  });

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

  it('clears only interactive navigation on transient ticket failure while capture stays authorized', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    const start = nativeMessages().length;
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
      bridgeProtocolVersion: 4, addinVersion: '1.0.13', outlookVersion: '16.0',
      runtime: 'Classic Outlook', newOutlookSupported: false, interactiveProfileRequired: true,
      maxPageSize: 200, maxFolderDepth: 64, maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL'],
    });
    ticketMutate.mockRejectedValueOnce(new Error('Network temporarily unavailable'));
    await waitFor(() => expect(nativeMessages().slice(start).some(x => x.action.startsWith('CLEAR_'))).toBe(true));
    expect(nativeMessages().slice(start).map(x => x.action)).toContain('CLEAR_NAVIGATION');
    expect(nativeMessages().slice(start).map(x => x.action)).not.toContain('CLEAR_SESSION');
  });

  it('coalesces simultaneous navigation renewals into one native registration', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(1);
    let completeBootstrap!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => {
      completeBootstrap = resolve;
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approval' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => completeBootstrap({ ok: true,
      json: async () => ({ paneChallenge: 'b'.repeat(43) }) } as Response));
    const registrations = nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION');
    expect(registrations).toHaveLength(2);
    expect(registrations[1]?.payload).toEqual({ paneChallenge: 'b'.repeat(43) });
    respondV4(registrations[1]!, { registered: true });
    await act(async () => { await Promise.resolve(); });
    expect(nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION')).toHaveLength(2);
  });

  it('does not interrupt a pending Outlook move when the navigation renews', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    const firstRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    vi.useFakeTimers();
    respondV4(firstRegistration, { registered: true });
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_CAPABILITIES')!, {
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
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_ACTIVE_EMAIL')!, null);
    await act(async () => { await Promise.resolve(); });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'c'.repeat(43) }),
    } as Response);

    await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
    fireEvent.click(screen.getByRole('button', { name: 'Move approved batch' }));
    await act(async () => { await Promise.resolve(); });
    const move = nativeMessages().find((message) => message.action === 'MOVE_EMAIL');
    expect(move).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(1);
    expect(screen.getByTestId('bridge-error-code').textContent).toBe('');

    respondV4(move!, {
      entryId: 'mail-1',
      storeId: 'store-approved',
      folderEntryId: 'folder-archive',
      folderName: 'Archive',
      moved: true,
      moveStatus: 'confirmed',
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('bridge-error-code').textContent).toBe('move-succeeded');
    expect(fetch).toHaveBeenCalledTimes(3);
    const renewal = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION');
    expect(renewal).toHaveLength(2);
    expect(renewal[1]?.payload).toEqual({ paneChallenge: 'c'.repeat(43) });
    respondV4(renewal[1]!, { registered: true });
  });

  it('does not run a queued read when a move starts its native confirmation during renewal', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_STORES', 'MOVE_EMAIL'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);

    fireEvent.click(screen.getByRole('button', { name: 'Move approved batch' }));
    const move = await waitForBridgeRequest('MOVE_EMAIL');
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approval' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => { await Promise.resolve(); });
    expect(ticketMutate.mock.calls.filter(([request]) => request.action === 'LIST_STORES')).toHaveLength(0);

    respondV4(move, {
      consentRequired: true, consentRequestId: 'a'.repeat(32),
      operationId: (move.payload as { operationId: string }).operationId,
    });
    await waitFor(() => expect(nativeMessages().some((request) =>
      request.action === 'PREPARE_MOVE_CONSENT')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('bridge-error-code').textContent).toBe('list-canceled'));
    expect(ticketMutate.mock.calls.filter(([request]) => request.action === 'LIST_STORES')).toHaveLength(0);
    expect(nativeMessages().filter((request) => request.action === 'LIST_STORES')).toHaveLength(0);
  });

  it('does not replace navigation while a mail ticket is still being issued', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    const firstRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    vi.useFakeTimers();
    respondV4(firstRegistration, { registered: true });
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_CAPABILITIES')!, {
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
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_ACTIVE_EMAIL')!, null);
    await act(async () => { await Promise.resolve(); });
    let issueTicket!: (ticket: { ticket: string; storeId: string }) => void;
    ticketMutate.mockImplementationOnce(() => new Promise((resolve) => { issueTicket = resolve; }));
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'c'.repeat(43) }),
    } as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => { await Promise.resolve(); });
    expect(nativeMessages().filter((message) => message.action === 'LIST_STORES')).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(1);

    await act(async () => issueTicket({ ticket: 'one-use', storeId: 'store-approved' }));
    const stores = nativeMessages().find((message) => message.action === 'LIST_STORES');
    expect(stores).toBeDefined();
    respondV4(stores!, { items: [], totalItems: 0, continuationToken: null, truncated: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('bridge-error-code').textContent).toBe('list-succeeded');
    expect(fetch).toHaveBeenCalledTimes(3);
    const renewal = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION');
    expect(renewal).toHaveLength(2);
    expect(renewal[1]?.payload).toEqual({ paneChallenge: 'c'.repeat(43) });
    respondV4(renewal[1]!, { registered: true });
  });

  it('does not send a second command on an expired navigation while the first is finishing', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4, version: '1.0.12', paired: true, deviceId: 'device-1',
    });
    const firstRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    vi.useFakeTimers();
    respondV4(firstRegistration, { registered: true });
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_CAPABILITIES')!, {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_STORES'],
    });
    await act(async () => { await Promise.resolve(); });
    respondV4(nativeMessages().find((message) => message.action === 'GET_ACTIVE_EMAIL')!, null);
    await act(async () => { await Promise.resolve(); });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response).mockResolvedValueOnce({
      ok: true, json: async () => ({ paneChallenge: 'c'.repeat(43) }),
    } as Response);

    await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => { await Promise.resolve(); });
    const firstRead = nativeMessages().find((message) => message.action === 'LIST_STORES');
    expect(firstRead).toBeDefined();
    const ticketCount = ticketMutate.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(fetch).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => { await Promise.resolve(); });
    expect(ticketMutate).toHaveBeenCalledTimes(ticketCount);
    expect(nativeMessages().filter((message) => message.action === 'LIST_STORES')).toHaveLength(1);

    respondV4(firstRead!, { items: [], totalItems: 0, continuationToken: null, truncated: false });
    await act(async () => { await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledTimes(3);
    const renewal = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')[1];
    expect(renewal).toBeDefined();
    // A third command issued after clearPending, but before native accepts the
    // fresh challenge, must wait; it cannot consume a ticket for the old lease.
    const ticketsBeforeRegistration = ticketMutate.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => { await Promise.resolve(); });
    expect(ticketMutate).toHaveBeenCalledTimes(ticketsBeforeRegistration);
    respondV4(renewal!, { registered: true });
    await act(async () => { await Promise.resolve(); });
    expect(ticketMutate.mock.calls.length).toBeGreaterThan(ticketCount);
  });

  it('preserves the selected item during a successful renewal until Outlook verifies a new one', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    const firstRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    vi.useFakeTimers();
    respondV4(firstRegistration, { registered: true });
    await act(async () => { await Promise.resolve(); });
    const caps = {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'ADD_ATTACHMENT_TO_DRAFT'],
    };
    respondV4(nativeMessages().find((message) => message.action === 'GET_CAPABILITIES')!, caps);
    await act(async () => { await Promise.resolve(); });
    const selected = {
      entryId: 'entry-1', subject: 'Reservation inquiry', senderEmail: 'guest@example.com',
      senderName: 'Guest', receivedTime: '2026-09-29', bodyText: 'Quote please', bodyHtml: '',
    };
    respondV4(nativeMessages().find((message) => message.action === 'GET_ACTIVE_EMAIL')!, selected);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('subject').textContent).toBe('Reservation inquiry');
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response);

    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    const renewal = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')[1];
    expect(renewal).toBeDefined();
    // Quotation PDF generation can continue under the same staff and selection.
    expect(screen.getByTestId('subject').textContent).toBe('Reservation inquiry');
    respondV4(renewal!, { registered: true });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('subject').textContent).toBe('Reservation inquiry');
    const freshCaps = nativeMessages().filter((message) => message.action === 'GET_CAPABILITIES')[1];
    expect(freshCaps).toBeDefined();
    respondV4(freshCaps!, caps);
    await act(async () => { await Promise.resolve(); });
    const freshSelection = nativeMessages().filter((message) => message.action === 'GET_ACTIVE_EMAIL')[1];
    expect(freshSelection).toBeDefined();
    respondV4(freshSelection!, { ...selected, entryId: 'entry-2', subject: 'Different message' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('subject').textContent).toBe('Different message');
  });

  it('abandons a deferred successful renewal when staff or mailbox scope changes', async () => {
    security.userId = 'staff-A';
    security.transportId = 'transport-A';
    setMailCacheScope({ userId: 'staff-A', activeTransportId: 'transport-A' });
    const pane = render(<BridgeProbe />);
    await registerPane();
    const oldMailRead = await waitForBridgeRequest('GET_CAPABILITIES');
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paneChallenge: 'b'.repeat(43) }),
    } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approval' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(1);

    security.userId = 'staff-B';
    security.transportId = 'transport-B';
    act(() => setMailCacheScope({ userId: 'staff-B', activeTransportId: 'transport-B' }));
    pane.rerender(<BridgeProbe />);
    await waitFor(() => expect(nativeMessages().filter(
      (message) => message.action === 'REGISTER_NAVIGATION',
    )).toHaveLength(2));
    const replacement = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')[1];
    expect(replacement?.payload).toEqual({ paneChallenge });
    respondV4(oldMailRead, { bridgeProtocolVersion: 4 });
    await act(async () => { await Promise.resolve(); });
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(2);
    expect(screen.getByTestId('subject').textContent).toBe('');
    respondV4(replacement!, { registered: true });
  });

  it('registers replacement staff without waiting for an obsolete ticket request', async () => {
    security.userId = 'staff-A';
    security.transportId = 'transport-A';
    setMailCacheScope({ userId: 'staff-A', activeTransportId: 'transport-A' });
    const pane = render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_STORES'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    let finishOldTicket!: (ticket: { ticket: string; storeId: string }) => void;
    ticketMutate.mockImplementationOnce(() => new Promise((resolve) => { finishOldTicket = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledTimes(3));

    security.userId = 'staff-B';
    security.transportId = 'transport-B';
    act(() => setMailCacheScope({ userId: 'staff-B', activeTransportId: 'transport-B' }));
    pane.rerender(<BridgeProbe />);
    await waitFor(() => expect(nativeMessages().filter(
      (message) => message.action === 'REGISTER_NAVIGATION',
    )).toHaveLength(2), { timeout: 500 });
    await act(async () => finishOldTicket({ ticket: 'old', storeId: 'store-approved' }));
    expect(nativeMessages().filter((message) => message.action === 'LIST_STORES')).toHaveLength(0);
    const replacement = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')[1];
    respondV4(replacement!, { registered: true });
  });

  it('revokes native COM immediately on renewal 401 and discards a late non-selection success', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    const firstRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION');
    vi.useFakeTimers();
    respondV4(firstRegistration, { registered: true });
    await act(async () => {
      await Promise.resolve();
    });
    const cap = nativeMessages().find((request) => request.action === 'GET_CAPABILITIES');
    expect(cap).toBeDefined();
    respondV4(cap!, {
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
    await act(async () => {
      await Promise.resolve();
    });
    const selection = nativeMessages().find((request) => request.action === 'GET_ACTIVE_EMAIL');
    expect(selection).toBeDefined();
    respondV4(selection!, {
      entryId: 'selected',
      subject: 'Confidential selection',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Private',
      bodyHtml: '',
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('subject').textContent).toBe('Confidential selection');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(44_999);
    });
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await act(async () => {
      await Promise.resolve();
    });
    const inFlight = nativeMessages().find((request) => request.action === 'LIST_STORES');
    expect(inFlight).toBeDefined();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(nativeMessages().map((request) => request.action)).toContain('CLEAR_SESSION');
    expect(screen.getByTestId('subject').textContent).toBe('');
    expect(screen.getByTestId('send-supported').textContent).toBe('no');
    expect(screen.getByTestId('bridge-error-code').textContent).toBe('list-canceled');
    respondV4(inFlight!, { items: [{ storeId: 'store-approved', displayName: 'Secret' }] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('bridge-error-code').textContent).toBe('list-canceled');
    vi.useRealTimers();
  });

  it.each([401, 403])(
    'ignores delayed bootstrap %s from former staff without revoking the replacement session',
    async (status) => {
      let finishOldBootstrap!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOldBootstrap = resolve;
          }),
      );
      security.userId = 'staff-A';
      security.transportId = 'transport-A';
      setMailCacheScope({ userId: 'staff-A', activeTransportId: 'transport-A' });
      const pane = render(<BridgeProbe />);
      respondV4(await waitForBridgeRequest('PING'), {
        bridgeProtocolVersion: 4,
        version: '1.0.12',
        paired: true,
        deviceId: 'device-1',
      });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      security.userId = 'staff-B';
      security.transportId = 'transport-B';
      act(() => setMailCacheScope({ userId: 'staff-B', activeTransportId: 'transport-B' }));
      pane.rerender(<BridgeProbe />);
      respondV4(await waitForBridgeRequest('REGISTER_NAVIGATION'), { registered: true });
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
        supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_FOLDERS'],
      });
      respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), {
        entryId: 'entry-B',
        subject: 'Staff B current mail',
        senderEmail: 'guest@example.com',
        senderName: 'Guest',
        receivedTime: '2026-09-17',
        bodyText: 'Current',
        bodyHtml: '',
      });
      await waitFor(() =>
        expect(screen.getByTestId('subject').textContent).toBe('Staff B current mail'),
      );
      expect(screen.getByTestId('send-supported').textContent).toBe('yes');
      const clearBefore = nativeMessages().filter(
        (request) => request.action === 'CLEAR_SESSION',
      ).length;
      await act(async () => finishOldBootstrap({ ok: false, status } as Response));
      expect(screen.getByTestId('subject').textContent).toBe('Staff B current mail');
      expect(screen.getByTestId('send-supported').textContent).toBe('yes');
      expect(screen.getByTestId('relogin').textContent).toBe('ready');
      expect(nativeMessages().filter((request) => request.action === 'CLEAR_SESSION')).toHaveLength(
        clearBefore,
      );
    },
  );

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

  it.each(['native', 'ticket'] as const)(
    'stops %s selection denials even when every registration can read capabilities',
    async (denial) => {
      security.userId = 'staff-1';
      security.transportId = 'transport-1';
      setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
      if (denial === 'ticket') {
        ticketMutate.mockImplementation(async ({ action }: { action: string }) => {
          if (action === 'GET_ACTIVE_EMAIL') throw new Error('Active mail ticket denied');
          return { ticket: 'one-use', storeId: 'store-approved', expiresInSeconds: 60 };
        });
      }
      render(<BridgeProbe />);
      await registerPane();
      let afterRegistration = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const cap = await waitForBridgeRequest('GET_CAPABILITIES', afterRegistration);
        respondV4(cap, {
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
        if (denial === 'native') {
          const read = await waitForBridgeRequest('GET_ACTIVE_EMAIL', afterRegistration);
          respondV4(read, null, false);
        } else {
          await waitFor(() =>
            expect(
              ticketMutate.mock.calls.filter(([grant]) => grant.action === 'GET_ACTIVE_EMAIL'),
            ).toHaveLength(attempt + 1),
          );
        }
        await act(async () => {
          await Promise.resolve();
        });
        if (attempt === 0) {
          await waitFor(() =>
            expect(
              nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION'),
            ).toHaveLength(2),
          );
          afterRegistration = nativeMessages().length;
          respondV4(
            nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION')[1]!,
            { registered: true },
          );
        }
      }
      expect(
        nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION'),
      ).toHaveLength(2);
      expect(screen.getByTestId('subject').textContent).toBe('');
    },
  );

  it('recovers after selecting an approved folder without repeating a denied Outlook read in a tight loop', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    const capabilities = {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'LIST_FOLDERS'],
    };
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), capabilities);
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null, false);
    const secondRegistration = await waitForBridgeRequest('REGISTER_NAVIGATION', 3);
    const secondIndex = nativeMessages().length;
    respondV4(secondRegistration, { registered: true });
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES', secondIndex), capabilities);
    const secondRead = await waitForBridgeRequest('GET_ACTIVE_EMAIL', secondIndex);
    vi.useFakeTimers();
    respondV4(secondRead, null, false);
    await act(async () => { await Promise.resolve(); });
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(2);
    expect(screen.getByTestId('subject').textContent).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    vi.useRealTimers();
    const recoveryIndex = nativeMessages().length;
    const recovery = nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')[2];
    expect(recovery).toBeDefined();
    respondV4(recovery!, { registered: true });
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES', recoveryIndex), capabilities);
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL', recoveryIndex), {
      entryId: 'approved-mail', storeId: 'store-approved', folderEntryId: 'approved-inbox',
      subject: 'Approved Inbox', senderEmail: 'guest@example.com', senderName: 'Guest',
      receivedTime: '2026-09-17', bodyText: 'Safe', bodyHtml: '',
    });
    await waitFor(() => expect(screen.getByTestId('subject').textContent).toBe('Approved Inbox'));
  });

  it('allows more than ten seconds for native-only supervised device pairing', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4, version: '1.0.12', paired: false, deviceId: null,
    });
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('yes'));
    await act(async () => { await Promise.resolve(); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Pair native' }));
    const pair = nativeMessages().find((message) => message.action === 'PAIR_DEVICE');
    expect(pair).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    respondV4(pair!, { paired: true, deviceId: 'device-1' });
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });
    const refreshedPing = await waitForBridgeRequest('PING', 2);
    respondV4(refreshedPing, { bridgeProtocolVersion: 4, version: '1.0.12',
      paired: true, deviceId: 'device-1' });
    await waitFor(() => expect(screen.getByTestId('protocol').textContent).toBe('4'));
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
    const pairing = await waitForBridgeRequest('PAIR_DEVICE');
    // Let the initial unpaired PING's state update land while PAIR_DEVICE is
    // still pending. Merely discovering v4 must not cancel the pairing dialog.
    await act(async () => { await Promise.resolve(); });
    respondV4(pairing, { paired: true });
    const ping = await waitForBridgeRequest('PING', 2, 10_000);
    expect(nativeMessages().some((message) => message.action === 'REGISTER_NAVIGATION')).toBe(false);
    respondV4(ping, {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: true,
      deviceId: 'device-1',
    });
    expect((await waitForBridgeRequest('REGISTER_NAVIGATION', 0, 10_000)).action).toBe(
      'REGISTER_NAVIGATION',
    );
  }, 15_000);

  it('still cancels a pending pairing when the signed-in staff scope changes', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    const pane = render(<BridgeProbe />);
    respondV4(await waitForBridgeRequest('PING'), {
      bridgeProtocolVersion: 4,
      version: '1.0.12',
      paired: false,
      deviceId: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pair native' }));
    const pairing = await waitForBridgeRequest('PAIR_DEVICE');

    security.userId = 'staff-2';
    setMailCacheScope({ userId: 'staff-2', activeTransportId: 'transport-1' });
    pane.rerender(<BridgeProbe />);
    respondV4(pairing, { paired: true });
    await act(async () => { await Promise.resolve(); });
    expect(nativeMessages().filter((message) => message.action === 'PING')).toHaveLength(1);
    expect(nativeMessages().some((message) => message.action === 'REGISTER_NAVIGATION')).toBe(false);
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

  it('cannot restore a late selection after another ticket denial invalidates the same navigation', async () => {
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
    const pendingRead = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined));
    ticketMutate.mockRejectedValueOnce(Object.assign(new Error('Staff grant denied'), { data: { code: 'FORBIDDEN' } }));
    fireEvent.click(screen.getByRole('button', { name: 'List approved stores' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(nativeMessages().map((message) => message.action)).toContain('CLEAR_SESSION');
    respondV4(pendingRead, {
      entryId: 'late-entry',
      subject: 'Never display after ticket denial',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17',
      bodyText: 'Private',
      bodyHtml: '',
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('subject').textContent).toBe('');
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

  it('waits for native move consent without expiring its first ticket and uses a fresh exact-scope ticket afterward', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), {
      bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000,
      supportedActions: ['GET_ACTIVE_EMAIL', 'MOVE_EMAIL'],
    });
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    fireEvent.click(screen.getByRole('button', { name: 'Move approved batch' }));
    const move = (await waitForBridgeRequest('MOVE_EMAIL')) as TestBridgeRequest &
      Record<string, unknown>;
    const originalPayload = move.payload as Record<string, unknown>;
    const callsBeforeConsent = nativeMessages().length;
    respondV4(move, { consentRequired: true, consentRequestId: 'a'.repeat(32),
      operationId: originalPayload.operationId });
    const prepare = (await waitForBridgeRequest('PREPARE_MOVE_CONSENT', callsBeforeConsent)) as
      TestBridgeRequest & Record<string, unknown>;
    expect(prepare).toMatchObject({ payload: { consentRequestId: 'a'.repeat(32),
      operationId: originalPayload.operationId } });
    expect(prepare).not.toHaveProperty('ticket');
    respondV4(prepare, { status: 'pending', consentRequestId: 'a'.repeat(32),
      operationId: originalPayload.operationId });

    const registrationCount = nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION').length;
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });
    expect(nativeMessages().filter((request) => request.action === 'REGISTER_NAVIGATION')).toHaveLength(registrationCount);
    expect(nativeMessages().filter((request) => request.action === 'MOVE_EMAIL')).toHaveLength(1);
    vi.useRealTimers();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ paneChallenge: 'b'.repeat(43) }) } as Response);
    ticketMutate.mockResolvedValueOnce({ ticket: 'fresh-after-dialog', storeId: 'store-approved', expiresInSeconds: 60 });
    act(() => resolveNativeMoveConsent('a'.repeat(32), originalPayload.operationId as string, true));
    const renewed = (await waitForBridgeRequest('REGISTER_NAVIGATION', nativeMessages().length - 1)) as
      TestBridgeRequest & Record<string, unknown>;
    expect(renewed.payload).toEqual({ paneChallenge: 'b'.repeat(43) });
    respondV4(renewed, { registered: true });
    await waitFor(() => expect(ticketMutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MOVE_EMAIL', paneChallenge: 'b'.repeat(43), operationId: originalPayload.operationId,
      resources: originalPayload.entryIds,
    })));
    const movedAgain = nativeMessages().reverse().find((request) => request.action === 'MOVE_EMAIL')!;
    expect(movedAgain).toMatchObject({ ticket: 'fresh-after-dialog',
      consentRequestId: 'a'.repeat(32), payload: originalPayload });
    expect(movedAgain).not.toHaveProperty('nativeBatchConsent');
    respondV4(movedAgain, { moved: true });
    await waitFor(() => expect(screen.getByTestId('bridge-error-code').textContent).toBe('move-succeeded'));
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

  function capabilities(supportedActions: string[]) {
    return {
      bridgeProtocolVersion: 4, addinVersion: '1.0.15', outlookVersion: '16.0',
      runtime: 'Classic Outlook for Windows', newOutlookSupported: false,
      interactiveProfileRequired: true, maxPageSize: 200, maxFolderDepth: 64,
      maxFolderCount: 5000, maxFolderSnapshotItems: 5000, supportedActions,
    };
  }

  it('re-reads the selected email after a draft write so later clicks keep reaching the pane', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), capabilities(['GET_ACTIVE_EMAIL', 'CREATE_REPLY_DRAFT']));
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    const before = nativeMessages().length;
    fireEvent.click(screen.getByRole('button', { name: 'Create reply draft' }));
    respondV4(await waitForBridgeRequest('CREATE_REPLY_DRAFT', before), { draftId: 'draft-1' });
    await waitFor(() => expect(screen.getByTestId('bridge-error-code').textContent).toBe('draft-succeeded'));
    const createAt = nativeMessages().findIndex((message) => message.action === 'CREATE_REPLY_DRAFT');
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL', createAt + 1), {
      entryId: 'after-draft', storeId: 'store-approved', folderEntryId: 'folder-inbox',
      subject: 'Refreshed after draft', senderEmail: 'guest@example.com', senderName: 'Guest',
      receivedTime: '2026-09-17', bodyText: 'Approved', bodyHtml: '',
    });
    await waitFor(() => expect(screen.getByTestId('subject').textContent).toBe('Refreshed after draft'));
  });

  it('keeps navigation and flags a selection in another Outlook store instead of denying it', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), capabilities(['GET_ACTIVE_EMAIL']));
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null, false,
      'Selected email is unavailable. An explicit matching Outlook store is required. Reason: COMException: not found');
    await waitFor(() => expect(screen.getByTestId('outside-mailbox').textContent).toBe('yes'));
    expect(screen.getByTestId('auth-unavailable').textContent).toBe('no');
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(1);
    expect(nativeMessages().map((message) => message.action)).not.toContain('CLEAR_NAVIGATION');
    expect(reportMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'GET_ACTIVE_EMAIL' }));
  });

  it('still invalidates navigation and re-registers on other GET_ACTIVE_EMAIL native failures', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), capabilities(['GET_ACTIVE_EMAIL']));
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null, false, 'Outlook denied the read');
    await waitFor(() =>
      expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(2),
    );
    expect(nativeMessages().map((message) => message.action)).toContain('CLEAR_NAVIGATION');
    expect(screen.getByTestId('outside-mailbox').textContent).toBe('no');
  });

  it('reports an empty native selection as a diagnostic without denying navigation', async () => {
    security.userId = 'staff-1';
    security.transportId = 'transport-1';
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-1' });
    render(<BridgeProbe />);
    await registerPane();
    respondV4(await waitForBridgeRequest('GET_CAPABILITIES'), capabilities(['GET_ACTIVE_EMAIL']));
    respondV4(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    await waitFor(() =>
      expect(reportMutate).toHaveBeenCalledWith({ action: 'ACTIVE_EMAIL_EMPTY', message: 'native returned no selected email' }),
    );
    expect(nativeMessages().filter((message) => message.action === 'REGISTER_NAVIGATION')).toHaveLength(1);
  });
});
