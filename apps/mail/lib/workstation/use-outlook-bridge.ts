import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeCapabilitiesSchema,
  WorkstationEmailPayloadSchema,
  createBridgeRequest,
  isSelectionChangedEvent,
  parseBridgeMessage,
  type BridgeAction,
  type BridgeCapabilities,
  type BridgeResponse,
  type WorkstationEmailPayload,
} from './bridge-protocol';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useActiveConnection } from '@/hooks/use-connections';
import { publicBackendPath } from '@/lib/public-backend-url';
import { trpcClient } from '@/providers/query-provider';
import { useSession } from '@/lib/auth-client';

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: unknown) => void;
        addEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
        removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
      };
    };
  }
}

export type WorkstationInfo = {
  bridgeProtocolVersion: number;
  addinVersion: string;
  paired: boolean;
  deviceId: string | null;
};
type Navigation = {
  generation: number;
  scopeKey: string;
  userId: string;
  deviceId: string;
  paneChallenge: string;
  transportId: string;
  storeId?: string;
};
type Pending = {
  action: BridgeAction;
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};
const MUTATIONS = new Set<BridgeAction>([
  'CREATE_DRAFT',
  'UPDATE_DRAFT',
  'CREATE_REPLY_DRAFT',
  'ADD_ATTACHMENT_TO_DRAFT',
  'MOVE_EMAIL',
  'MOVE_TO_SPAM',
  'CREATE_FOLDER',
  'SET_EMAIL_CATEGORY',
  'SET_FOLLOW_UP_FLAG',
  'MARK_EMAIL_READ',
]);
const TARGETED = new Set<BridgeAction>([
  'GET_EMAIL_BY_ENTRY_ID',
  'GET_ATTACHMENT_METADATA',
  'READ_ATTACHMENT_BASE64',
  'GET_CONVERSATION_THREAD',
  'UPDATE_DRAFT',
  'CREATE_REPLY_DRAFT',
  'ADD_ATTACHMENT_TO_DRAFT',
  'SET_EMAIL_CATEGORY',
  'SET_FOLLOW_UP_FLAG',
  'MARK_EMAIL_READ',
  'MOVE_EMAIL',
  'MOVE_TO_SPAM',
]);

function ticketScope(action: BridgeAction, payload: Record<string, unknown>) {
  const resources = Array.isArray(payload.entryIds)
    ? payload.entryIds
    : typeof payload.entryId === 'string'
      ? [payload.entryId]
      : action === 'GET_TEMPLATE_CONTENT' && typeof payload.path === 'string'
        ? [payload.path]
        : undefined;
  if (
    TARGETED.has(action) &&
    (!resources?.length || !resources.every((id) => typeof id === 'string' && id))
  ) {
    throw new Error(`Bridge ${action} requires exact item EntryID(s)`);
  }
  const sourceFolderId =
    action === 'CREATE_FOLDER' ? payload.parentFolderEntryId : payload.folderEntryId;
  if (
    (TARGETED.has(action) || action === 'GET_FOLDER_EMAILS' || action === 'CREATE_FOLDER') &&
    (typeof sourceFolderId !== 'string' || !sourceFolderId)
  ) {
    throw new Error(`Bridge ${action} requires the observed source folder EntryID`);
  }
  if (action === 'GET_TEMPLATE_CONTENT' && !resources?.length)
    throw new Error('Template path required');
  if (MUTATIONS.has(action) && (typeof payload.operationId !== 'string' || !payload.operationId)) {
    throw new Error(`Bridge ${action} requires stable operation ID`);
  }
  const destinationFolderId = payload.targetFolderEntryId;
  if (
    (action === 'MOVE_EMAIL' || action === 'MOVE_TO_SPAM') &&
    (typeof destinationFolderId !== 'string' ||
      !destinationFolderId ||
      payload.targetStoreId !== payload.storeId)
  ) {
    throw new Error('Move requires an approved destination folder and exact store');
  }
  return {
    ...(resources ? { resources: resources as string[] } : {}),
    ...(typeof sourceFolderId === 'string' ? { sourceFolderId } : {}),
    ...(typeof destinationFolderId === 'string' ? { destinationFolderId } : {}),
    ...(typeof payload.operationId === 'string' ? { operationId: payload.operationId } : {}),
  };
}

export function useOutlookBridge() {
  const { data: session, isLoading: sessionLoading, refetch } = useSession();
  const { data: connection, isLoading: transportLoading } = useActiveConnection();
  const headerScope = useSyncExternalStore(
    subscribeMailCacheScope,
    getMailCacheScope,
    getMailCacheScope,
  );
  const createdAt = session?.session?.createdAt
    ? new Date(session.session.createdAt).getTime()
    : NaN;
  const sessionValid = Boolean(
    session?.user?.id &&
      Number.isFinite(createdAt) &&
      createdAt <= Date.now() &&
      Date.now() - createdAt < 24 * 60 * 60 * 1000,
  );
  const scopeKey =
    sessionValid &&
    !sessionLoading &&
    !transportLoading &&
    connection?.id &&
    headerScope.userId === session?.user?.id &&
    headerScope.activeTransportId === connection.id
      ? `${session!.user.id}:${session!.session!.id ?? createdAt}:${connection.id}`
      : null;
  const [isConnected, setIsConnected] = useState(false);
  const [activeEmail, setActiveEmail] = useState<WorkstationEmailPayload | null>(null);
  const [activeEmailOwner, setActiveEmailOwner] = useState<string | null>(null);
  const [workstationInfo, setWorkstationInfo] = useState<WorkstationInfo | null>(null);
  const [capabilities, setCapabilities] = useState<BridgeCapabilities | null>(null);
  const [capabilitiesOwner, setCapabilitiesOwner] = useState<string | null>(null);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [requiresRelogin, setRequiresRelogin] = useState(false);
  const pending = useRef(new Map<string, Pending>());
  const navigation = useRef<Navigation | null>(null);
  const epoch = useRef(0);
  const selection = useRef(0);
  const renewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRegistration = useRef<
    (generation: number, deviceId: string, transportId: string, attempt?: number) => void
  >(() => {});
  const firstTicket = useRef<Promise<void> | null>(null);
  const deniedTickets = useRef(0);
  const failedNativeAuthorizations = useRef(0);
  const currentScope = useRef<string | null>(null);
  const renderedScope = useRef<string | null>(scopeKey);
  renderedScope.current = scopeKey;
  const sessionExpiresAt = useRef(createdAt + 24 * 60 * 60 * 1000);
  sessionExpiresAt.current = createdAt + 24 * 60 * 60 * 1000;
  const updateRequiredRef = useRef(updateRequired);
  updateRequiredRef.current = updateRequired;
  const previousSetup = useRef<string | null>(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const loadMailRef = useRef<(generation: number) => Promise<void>>(async () => {});

  const clearPending = useCallback((includePing = true) => {
    for (const [, request] of pending.current) {
      if (!includePing && request.action === 'PING') continue;
      clearTimeout(request.timeout);
      request.reject(new Error('Outlook navigation changed; inspect Outlook before retrying'));
    }
    if (includePing) pending.current.clear();
    else
      for (const [requestId, request] of pending.current) {
        if (request.action !== 'PING') pending.current.delete(requestId);
      }
  }, []);

  const invalidateNavigation = useCallback(() => {
    const wasRegistered = navigation.current !== null;
    navigation.current = null;
    firstTicket.current = null;
    selection.current++;
    if (renewalTimer.current) clearTimeout(renewalTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    renewalTimer.current = null;
    retryTimer.current = null;
    if (wasRegistered) {
      window.chrome?.webview?.postMessage(JSON.stringify(createBridgeRequest('CLEAR_SESSION', {})));
    }
    clearPending(false);
    setActiveEmail(null);
    setCapabilities(null);
  }, [clearPending]);

  const nativeRequest = useCallback(
    <T>(
      action: BridgeAction,
      payload: Record<string, unknown>,
      grant?: { ticket: string; transportId: string },
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const webview = window.chrome?.webview;
        if (!webview) return reject(new Error('Outlook WebView2 bridge not detected'));
        const request = createBridgeRequest(action, payload, grant);
        const timeout = setTimeout(() => {
          pending.current.delete(request.requestId);
          reject(new Error(`Bridge command ${action} timed out`));
        }, 10_000);
        pending.current.set(request.requestId, {
          action,
          timeout,
          reject,
          resolve: (response) => {
            if (response.version !== BRIDGE_PROTOCOL_VERSION || response.action !== action) {
              if (action === 'PING') {
                setWorkstationInfo({
                  bridgeProtocolVersion: response.version ?? 0,
                  addinVersion: 'Older installer',
                  paired: false,
                  deviceId: null,
                });
                setIsConnected(true);
                setUpdateRequired(true);
              }
              const error = new Error('Outlook add-in update required (protocol v4)') as Error & {
                code?: string;
              };
              error.code = 'OUTLOOK_UPDATE_REQUIRED';
              reject(error);
            } else if (!response.success) {
              const error = new Error(
                response.error || `Bridge action ${action} failed`,
              ) as Error & { code?: string };
              error.code = response.errorCode;
              reject(error);
            } else resolve(response.data as T);
          },
        });
        webview.postMessage(JSON.stringify(request));
      }),
    [],
  );

  const refreshPairing = useCallback(async () => {
    const ping = await nativeRequest<{
      bridgeProtocolVersion: number;
      version: string;
      paired: boolean;
      deviceId: string | null;
    }>('PING', {});
    setWorkstationInfo({
      bridgeProtocolVersion: ping.bridgeProtocolVersion,
      addinVersion: ping.version,
      paired: ping.paired === true,
      deviceId: ping.deviceId || null,
    });
    setIsConnected(true);
    setUpdateRequired(ping.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION);
  }, [nativeRequest]);

  const registerNavigation = useCallback(
    async (generation: number, deviceId: string, transportId: string) => {
      if (epoch.current !== generation) return;
      const response = await fetch(publicBackendPath('/api/outlook/native/bootstrap'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          invalidateNavigation();
          setRequiresRelogin(true);
          void refetchRef.current?.();
          const denied = new Error('Outlook navigation denied') as Error & { code?: string };
          denied.code = 'NAVIGATION_DENIED';
          throw denied;
        }
        throw new Error('Outlook navigation bootstrap unavailable');
      }
      const bootstrap: unknown = await response.json();
      const challenge =
        bootstrap && typeof bootstrap === 'object' && 'paneChallenge' in bootstrap
          ? bootstrap.paneChallenge
          : undefined;
      if (typeof challenge !== 'string' || challenge.length !== 43)
        throw new Error('Invalid Outlook navigation challenge');
      if (epoch.current !== generation) return;
      clearPending();
      navigation.current = null;
      firstTicket.current = null;
      selection.current++;
      setActiveEmail(null);
      setCapabilities(null);
      await nativeRequest('REGISTER_NAVIGATION', { paneChallenge: challenge });
      if (epoch.current !== generation) return;
      navigation.current = {
        generation,
        scopeKey: currentScope.current!,
        userId: getMailCacheScope().userId!,
        deviceId,
        paneChallenge: challenge,
        transportId,
      };
      if (renewalTimer.current) clearTimeout(renewalTimer.current);
      renewalTimer.current = setTimeout(() => {
        startRegistration.current(generation, deviceId, transportId);
      }, 45_000);
    },
    [clearPending, invalidateNavigation, nativeRequest],
  );

  startRegistration.current = (generation, deviceId, transportId, attempt = 0) => {
    void registerNavigation(generation, deviceId, transportId)
      .then(() => loadMailRef.current(generation))
      .catch((error: unknown) => {
        if (
          epoch.current !== generation ||
          !currentScope.current ||
          updateRequiredRef.current ||
          Date.now() >= sessionExpiresAt.current
        )
          return;
        if (error instanceof Error && 'code' in error && error.code === 'NAVIGATION_DENIED') return;
        if (attempt >= 3) return;
        retryTimer.current = setTimeout(
          () => startRegistration.current(generation, deviceId, transportId, attempt + 1),
          5_000 * 2 ** attempt,
        );
      });
  };

  const sendCommand = useCallback(
    async <TReq, TResp>(action: BridgeAction, rawPayload: TReq): Promise<TResp> => {
      if (action === 'PING' || action === 'PAIR_DEVICE') {
        // Never forward a browser-supplied code or secret into the native pairing dialog.
        return nativeRequest<TResp>(action, {});
      }
      if (action === 'REGISTER_NAVIGATION' || action === 'CLEAR_SESSION')
        throw new Error('Native session controls are internal');
      const registered = navigation.current;
      if (
        !registered ||
        !currentScope.current ||
        currentScope.current !== renderedScope.current ||
        registered.scopeKey !== renderedScope.current ||
        epoch.current !== registered.generation
      ) {
        throw new Error('Sign in, select a mailbox and pair Outlook before reading mail');
      }
      if (Date.now() >= sessionExpiresAt.current) {
        setRequiresRelogin(true);
        void refetchRef.current?.();
        throw new Error('Staff session expired; sign in again');
      }
      const payload = { ...rawPayload } as Record<string, unknown>;
      if (
        (action === 'LIST_STORES' || action === 'LIST_ACCOUNTS') &&
        payload.pageSize === undefined
      ) {
        payload.pageSize = 200;
      }
      if (registered.storeId && payload.storeId && payload.storeId !== registered.storeId) {
        throw new Error('Selected Outlook store does not match the approved mailbox');
      }
      const fullPayload = {
        ...payload,
        ...(registered.storeId ? { storeId: registered.storeId } : {}),
      };
      const declaredScope = ticketScope(action, fullPayload);
      // Only one initial store-less ticket may exist for a fresh native navigation.
      if (firstTicket.current) await firstTicket.current;
      const header = getMailCacheScope();
      if (
        header.userId !== registered.userId ||
        header.activeTransportId !== registered.transportId
      ) {
        throw new Error('Mailbox transport header changed before Outlook authorization');
      }
      const issue = trpcClient.workstation.bridgeTicket.mutate({
        deviceId: registered.deviceId,
        paneChallenge: registered.paneChallenge,
        action,
        ...(registered.storeId ? { storeId: registered.storeId } : {}),
        ...declaredScope,
      });
      if (!firstTicket.current)
        firstTicket.current = issue.then(
          () => undefined,
          () => undefined,
        );
      let ticket: Awaited<typeof issue>;
      try {
        ticket = await issue;
        if (
          navigation.current !== registered ||
          epoch.current !== registered.generation ||
          !currentScope.current
        ) {
          throw new Error('Outlook navigation changed during authorization');
        }
        if (registered.storeId && registered.storeId !== ticket.storeId)
          throw new Error('Approved Outlook store changed');
        registered.storeId = ticket.storeId;
      } catch (error) {
        if (navigation.current === registered) {
          invalidateNavigation();
          void refetchRef.current?.();
          if (++deniedTickets.current <= 1) {
            startRegistration.current(
              registered.generation,
              registered.deviceId,
              registered.transportId,
            );
          }
        }
        throw error;
      }
      if (navigation.current !== registered || epoch.current !== registered.generation)
        throw new Error('Outlook navigation changed');
      try {
        const result = await nativeRequest<TResp>(
          action,
          { ...fullPayload, storeId: ticket.storeId },
          {
            ticket: ticket.ticket,
            transportId: registered.transportId,
          },
        );
        return result;
      } catch (error) {
        if (navigation.current === registered) {
          invalidateNavigation();
          if (++failedNativeAuthorizations.current <= 1) {
            startRegistration.current(
              registered.generation,
              registered.deviceId,
              registered.transportId,
            );
          }
        }
        throw error;
      }
    },
    [invalidateNavigation, nativeRequest, registerNavigation],
  );

  loadMailRef.current = async (generation: number) => {
    const registered = navigation.current;
    if (epoch.current !== generation || !registered) return;
    try {
      const raw = await sendCommand<Record<string, never>, BridgeCapabilities>(
        'GET_CAPABILITIES',
        {},
      );
      if (epoch.current !== generation || navigation.current !== registered) return;
      const parsed = BridgeCapabilitiesSchema.safeParse(raw);
      if (!parsed.success || parsed.data.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        setUpdateRequired(true);
        return;
      }
      setCapabilities(parsed.data);
      setCapabilitiesOwner(currentScope.current);
      const requestSelection = ++selection.current;
      const data = await sendCommand<Record<string, never>, WorkstationEmailPayload | null>(
        'GET_ACTIVE_EMAIL',
        {},
      );
      if (
        epoch.current === generation &&
        navigation.current === registered &&
        selection.current === requestSelection
      ) {
        const parsedEmail = WorkstationEmailPayloadSchema.safeParse(data);
        setActiveEmail(parsedEmail.success ? parsedEmail.data : null);
        setActiveEmailOwner(currentScope.current);
        deniedTickets.current = 0;
        failedNativeAuthorizations.current = 0;
      }
    } catch {
      /* Denied grants fail closed; the navigation renewal will recover if still signed in. */
    }
  };

  useEffect(() => {
    if (!window.chrome?.webview) return;
    let mounted = true;
    const onMessage = (event: { data: unknown }) => {
      const result = parseBridgeMessage(
        typeof event.data === 'string' ? event.data : JSON.stringify(event.data),
      );
      if (isSelectionChangedEvent(result)) {
        if (
          !currentScope.current ||
          currentScope.current !== renderedScope.current ||
          !navigation.current ||
          navigation.current.scopeKey !== renderedScope.current ||
          result.version !== BRIDGE_PROTOCOL_VERSION
        )
          return;
        const activeNavigation = navigation.current;
        const requestSelection = ++selection.current;
        setActiveEmail(null);
        void sendCommand<Record<string, never>, WorkstationEmailPayload | null>(
          'GET_ACTIVE_EMAIL',
          {},
        )
          .then((data) => {
            if (
              !mounted ||
              navigation.current !== activeNavigation ||
              selection.current !== requestSelection
            )
              return;
            const parsed = WorkstationEmailPayloadSchema.safeParse(data);
            setActiveEmail(parsed.success ? parsed.data : null);
            setActiveEmailOwner(currentScope.current);
          })
          .catch(() => undefined);
        return;
      }
      const request = pending.current.get(result.requestId);
      if (!request) return;
      pending.current.delete(result.requestId);
      clearTimeout(request.timeout);
      request.resolve(result);
    };
    window.chrome.webview.addEventListener('message', onMessage);
    void refreshPairing().catch((error: unknown) => {
      if (
        mounted &&
        !(error instanceof Error && 'code' in error && error.code === 'OUTLOOK_UPDATE_REQUIRED')
      ) {
        setIsConnected(false);
      }
    });
    return () => {
      mounted = false;
      epoch.current++;
      if (renewalTimer.current) clearTimeout(renewalTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (navigation.current)
        window.chrome?.webview?.postMessage(
          JSON.stringify(createBridgeRequest('CLEAR_SESSION', {})),
        );
      navigation.current = null;
      clearPending();
      window.chrome?.webview?.removeEventListener('message', onMessage);
    };
  }, [clearPending, refreshPairing, sendCommand]);

  useEffect(() => {
    const setup = `${scopeKey ?? ''}:${workstationInfo?.deviceId ?? ''}:${workstationInfo?.bridgeProtocolVersion ?? ''}`;
    if (previousSetup.current === setup) return;
    const hadSetup = previousSetup.current !== null;
    previousSetup.current = setup;
    currentScope.current = scopeKey;
    const generation = ++epoch.current;
    selection.current++;
    if (renewalTimer.current) clearTimeout(renewalTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (navigation.current)
      window.chrome?.webview?.postMessage(JSON.stringify(createBridgeRequest('CLEAR_SESSION', {})));
    navigation.current = null;
    firstTicket.current = null;
    deniedTickets.current = 0;
    failedNativeAuthorizations.current = 0;
    if (hadSetup) clearPending(false);
    setActiveEmail(null);
    setCapabilities(null);
    if (
      scopeKey &&
      workstationInfo?.paired &&
      workstationInfo.deviceId &&
      workstationInfo.bridgeProtocolVersion === BRIDGE_PROTOCOL_VERSION &&
      connection?.id
    ) {
      startRegistration.current(generation, workstationInfo.deviceId, connection.id);
    }
  }, [scopeKey, workstationInfo, connection?.id, registerNavigation, clearPending]);

  useEffect(() => {
    if (!session?.user || !Number.isFinite(createdAt)) return;
    const remaining = createdAt + 24 * 60 * 60 * 1000 - Date.now();
    if (remaining <= 0) {
      setRequiresRelogin(true);
      void refetchRef.current?.();
      return;
    }
    setRequiresRelogin(false);
    const timeout = setTimeout(() => {
      setRequiresRelogin(true);
      void refetchRef.current?.();
    }, remaining);
    return () => clearTimeout(timeout);
  }, [session?.user?.id, createdAt]);

  const supportsAction = useCallback(
    (action: BridgeAction) =>
      Boolean(
        currentScope.current &&
          currentScope.current === scopeKey &&
          navigation.current?.scopeKey === scopeKey &&
          capabilitiesOwner === scopeKey &&
          capabilities?.bridgeProtocolVersion === BRIDGE_PROTOCOL_VERSION &&
          capabilities.supportedActions.includes(action) &&
          action !== 'PING',
      ),
    [capabilities, capabilitiesOwner, scopeKey],
  );

  return {
    isConnected,
    activeEmail: activeEmailOwner === scopeKey ? activeEmail : null,
    workstationInfo,
    capabilities: capabilitiesOwner === scopeKey ? capabilities : null,
    updateRequired,
    requiresRelogin:
      requiresRelogin || Boolean(session?.user && Number.isFinite(createdAt) && !sessionValid),
    supportsAction,
    sendCommand,
    pairDevice: async () => {
      await nativeRequest('PAIR_DEVICE', {});
      await refreshPairing();
    },
  };
}
