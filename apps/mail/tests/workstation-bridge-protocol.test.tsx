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
import { useState } from 'react';

describe('Workstation Bridge Protocol', () => {
  it('uses protocol v3 and exposes the reusable mail action set', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(3);
    const actions = [
      'GET_CAPABILITIES',
      'LIST_STORES',
      'LIST_FOLDERS',
      'UPDATE_DRAFT',
      'LIST_ACCOUNTS',
      'SEND_DRAFT',
      'DELETE_EMAIL',
      'DELETE_EMAIL_PERMANENTLY',
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

  it('parses legacy and explicit-truncation folder collection results', () => {
    const folder = {
      storeId: 'store-1',
      entryId: 'folder-1',
      parentEntryId: 'root-1',
      name: 'Inbox',
      path: '\\Reservations\\Inbox',
      depth: 1,
    };

    expect(FolderCollectionResultSchema.parse([folder])).toEqual([folder]);
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

  it('parses bounded store/account pages and backwards-compatible legacy arrays', () => {
    const store = { storeId: 'store-1', displayName: 'Reservations', isDefault: true };
    const account = { smtpAddress: 'help@example.com', displayName: 'Help' };
    expect(StoreCollectionResultSchema.parse([store])).toEqual([store]);
    expect(AccountCollectionResultSchema.parse([account])).toEqual([account]);
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

function BridgeProbe() {
  const { isConnected, activeEmail, workstationInfo, supportsAction, sendCommand } =
    useOutlookBridge();
  const [errorCode, setErrorCode] = useState('');
  return (
    <div>
      <span data-testid="connected">{isConnected ? 'yes' : 'no'}</span>
      <span data-testid="subject">{activeEmail?.subject ?? ''}</span>
      <span data-testid="protocol">{workstationInfo?.bridgeProtocolVersion ?? ''}</span>
      <span data-testid="send-supported">{supportsAction('SEND_DRAFT') ? 'yes' : 'no'}</span>
      <span data-testid="reply-supported">
        {supportsAction('CREATE_REPLY_DRAFT') ? 'yes' : 'no'}
      </span>
      <span data-testid="bridge-error-code">{errorCode}</span>
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

describe('useOutlookBridge selection events', () => {
  beforeEach(() => {
    listeners.clear();
    window.chrome = {
      webview: {
        postMessage: vi.fn(),
        addEventListener: (type, listener) => {
          const bucket = listeners.get(type) ?? [];
          bucket.push(listener);
          listeners.set(type, bucket);
        },
        removeEventListener: (type, listener) => {
          const bucket = listeners.get(type) ?? [];
          listeners.set(
            type,
            bucket.filter((item) => item !== listener),
          );
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete window.chrome;
  });

  it('discovers protocol v3 capabilities before exposing active Outlook data', async () => {
    render(<BridgeProbe />);

    const ping = await waitForBridgeRequest('PING');
    respondToBridgeRequest(ping, {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.11',
      bridgeProtocolVersion: 3,
    });

    const capabilitiesRequest = await waitForBridgeRequest('GET_CAPABILITIES');
    respondToBridgeRequest(capabilitiesRequest, {
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
      supportedActions: ['PING', 'GET_CAPABILITIES', 'SEND_DRAFT', 'CREATE_REPLY_DRAFT'],
    });

    const activeEmailRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    respondToBridgeRequest(activeEmailRequest, {
      entryId: 'mail-1',
      subject: 'Availability',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Can you host us?',
      bodyHtml: '<p>Can you host us?</p>',
    });

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('yes');
      expect(screen.getByTestId('protocol').textContent).toBe('3');
      expect(screen.getByTestId('send-supported').textContent).toBe('yes');
      expect(screen.getByTestId('reply-supported').textContent).toBe('yes');
    });
  });

  it('keeps protocol v2 connected but reports that v3 actions are unsupported', async () => {
    render(<BridgeProbe />);

    const ping = await waitForBridgeRequest('PING');
    respondToBridgeRequest(ping, {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.8',
      bridgeProtocolVersion: 2,
    });

    const capabilitiesRequest = await waitForBridgeRequest('GET_CAPABILITIES');
    respondToBridgeRequest(capabilitiesRequest, null, false);

    const activeEmailRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    respondToBridgeRequest(activeEmailRequest, {
      entryId: 'mail-1',
      subject: 'Availability',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Can you host us?',
      bodyHtml: '<p>Can you host us?</p>',
    });

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('yes');
      expect(screen.getByTestId('protocol').textContent).toBe('2');
      expect(screen.getByTestId('send-supported').textContent).toBe('no');
      expect(screen.getByTestId('reply-supported').textContent).toBe('no');
    });
  });

  it('recovers v3 capabilities after repeated transient failures without exposing mutations early', async () => {
    render(<BridgeProbe />);

    respondToBridgeRequest(await waitForBridgeRequest('PING'), {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.11',
      bridgeProtocolVersion: 3,
    });

    const firstCapabilitiesRequest = await waitForBridgeRequest('GET_CAPABILITIES');
    const postMessage = window.chrome?.webview?.postMessage as unknown as {
      mock: { calls: Array<[unknown]> };
    };
    const nextRequestIndex = postMessage.mock.calls.length;
    respondToBridgeRequest(firstCapabilitiesRequest, null, false);

    const activeEmailRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    respondToBridgeRequest(activeEmailRequest, {
      entryId: 'mail-1',
      subject: 'Availability',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Can you host us?',
      bodyHtml: '<p>Can you host us?</p>',
    });

    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('yes'));
    expect(screen.getByTestId('reply-supported').textContent).toBe('no');

    const retryRequest = await waitForBridgeRequest('GET_CAPABILITIES', nextRequestIndex);
    const recoveryRequestIndex = postMessage.mock.calls.length;
    respondToBridgeRequest(retryRequest, null, false);

    expect(screen.getByTestId('reply-supported').textContent).toBe('no');

    const recoveryRequest = await waitForBridgeRequest('GET_CAPABILITIES', recoveryRequestIndex);
    respondToBridgeRequest(recoveryRequest, {
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
      supportedActions: ['PING', 'GET_CAPABILITIES', 'CREATE_REPLY_DRAFT'],
    });

    await waitFor(() => expect(screen.getByTestId('reply-supported').textContent).toBe('yes'));
  });

  it('retries a transient initial email read without marking the bridge disconnected', async () => {
    render(<BridgeProbe />);
    respondToBridgeRequest(await waitForBridgeRequest('PING'), {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.11',
      bridgeProtocolVersion: 3,
    });

    const capabilitiesRequest = await waitForBridgeRequest('GET_CAPABILITIES');
    respondToBridgeRequest(capabilitiesRequest, {
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
      supportedActions: ['PING', 'GET_CAPABILITIES'],
    });

    const firstEmailRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    const postMessage = window.chrome?.webview?.postMessage as unknown as {
      mock: { calls: Array<[unknown]> };
    };
    const nextRequestIndex = postMessage.mock.calls.length;
    respondToBridgeRequest(firstEmailRequest, null, false);

    expect(screen.getByTestId('connected').textContent).toBe('yes');
    const retryRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL', nextRequestIndex);
    respondToBridgeRequest(retryRequest, {
      entryId: 'mail-1',
      subject: 'Availability',
      senderEmail: 'guest@example.com',
      senderName: 'Guest',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Can you host us?',
      bodyHtml: '<p>Can you host us?</p>',
    });

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('yes');
      expect(screen.getByTestId('subject').textContent).toBe('Availability');
    });
  });

  it('does not overwrite a newer selection with a delayed initial email read', async () => {
    render(<BridgeProbe />);
    respondToBridgeRequest(await waitForBridgeRequest('PING'), {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.11',
      bridgeProtocolVersion: 3,
    });
    respondToBridgeRequest(await waitForBridgeRequest('GET_CAPABILITIES'), {
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
      supportedActions: ['PING', 'GET_CAPABILITIES'],
    });

    const activeEmailRequest = await waitForBridgeRequest('GET_ACTIVE_EMAIL');
    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: 'evt_selection_newer',
            version: 1,
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: {
              entryId: 'message-b',
              storeId: 'store-b',
              subject: 'Message B',
              senderEmail: 'guest-b@example.com',
              senderName: 'Guest B',
              receivedTime: '2026-09-24T12:00:00Z',
              bodyText: 'Selected message B',
              bodyHtml: '<p>Selected message B</p>',
            } satisfies WorkstationEmailPayload,
          }),
        });
      }
    });

    await waitFor(() => expect(screen.getByTestId('subject').textContent).toBe('Message B'));

    respondToBridgeRequest(activeEmailRequest, {
      entryId: 'message-a',
      storeId: 'store-a',
      subject: 'Message A',
      senderEmail: 'guest-a@example.com',
      senderName: 'Guest A',
      receivedTime: '2026-09-24T11:00:00Z',
      bodyText: 'Stale initial read for A',
      bodyHtml: '<p>Stale initial read for A</p>',
    });

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('subject').textContent).toBe('Message B'));
  });

  it('propagates native operation error codes through sendCommand rejections', async () => {
    render(<BridgeProbe />);
    respondToBridgeRequest(await waitForBridgeRequest('PING'), {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
      version: '1.0.11',
      bridgeProtocolVersion: 3,
    });
    respondToBridgeRequest(await waitForBridgeRequest('GET_CAPABILITIES'), null, false);
    respondToBridgeRequest(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger bridge error' }));
    const mutationRequest = await waitForBridgeRequest('CREATE_REPLY_DRAFT');
    respondToBridgeRequest(mutationRequest, null, false, 'OPERATION_OUTCOME_UNKNOWN');

    await waitFor(() => {
      expect(screen.getByTestId('bridge-error-code').textContent).toBe('OPERATION_OUTCOME_UNKNOWN');
    });
  });

  it('retains connected legacy reads when PING omits protocol and capabilities fail', async () => {
    render(<BridgeProbe />);
    respondToBridgeRequest(await waitForBridgeRequest('PING'), {
      workstationUser: 'test-user',
      outlookEmail: 'test@example.com',
      outlookVersion: '16.0',
    });
    respondToBridgeRequest(await waitForBridgeRequest('GET_CAPABILITIES'), null, false);
    respondToBridgeRequest(await waitForBridgeRequest('GET_ACTIVE_EMAIL'), null);
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('yes');
      expect(screen.getByTestId('send-supported').textContent).toBe('no');
      expect(screen.getByTestId('reply-supported').textContent).toBe('no');
    });
  });

  it('updates active email on ON_SELECTION_CHANGED events with evt_ ids', async () => {
    render(<BridgeProbe />);

    const payload: WorkstationEmailPayload = {
      entryId: '001',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'We need 3 rooms for 4 nights.',
      bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
      internetMessageId: '<msg@guest.com>',
    };

    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: 'evt_selection_1',
            version: 1,
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: payload,
          }),
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject').textContent).toBe('Suite Availability Request');
    });

    act(() => {
      for (const listener of listeners.get('message') ?? []) {
        listener({
          data: JSON.stringify({
            requestId: 'evt_selection_cleared',
            version: 1,
            action: 'ON_SELECTION_CHANGED',
            success: true,
            data: null,
          }),
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject').textContent).toBe('');
    });
  });
});

type TestBridgeRequest = { requestId: string; action: string };

async function waitForBridgeRequest(
  action: string,
  afterCallIndex = 0,
): Promise<TestBridgeRequest> {
  let request: TestBridgeRequest | undefined;
  await waitFor(() => {
    const postMessage = window.chrome?.webview?.postMessage as unknown as {
      mock: { calls: Array<[unknown]> };
    };
    request = postMessage.mock.calls
      .slice(afterCallIndex)
      .map(([raw]) => JSON.parse(String(raw)) as TestBridgeRequest)
      .find((candidate) => candidate.action === action);
    expect(request).toBeDefined();
  });
  return request!;
}

function respondToBridgeRequest(
  request: TestBridgeRequest,
  data: unknown,
  success = true,
  errorCode?: string,
): void {
  const response = JSON.stringify({
    requestId: request.requestId,
    version: 1,
    action: request.action,
    success,
    data,
    ...(success ? {} : { error: 'Unknown action: ' + request.action }),
    ...(errorCode ? { errorCode } : {}),
  });
  act(() => {
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: response });
    }
  });
}
