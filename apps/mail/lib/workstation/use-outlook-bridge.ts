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
type PendingMoveConsent = {
  consentRequestId: string;
  operationId: string;
  navigation: Navigation;
  phase: 'dialog' | 'finalizing';
  resolve: (result: 'approved' | 'declined' | 'expired' | 'navigation-changed') => void;
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
  const [authorizationUnavailable, setAuthorizationUnavailable] = useState(false);
  const [consentInProgress, setConsentInProgress] = useState(false);
  const pending = useRef(new Map<string, Pending>());
  const activeMailRequests = useRef(0);
  const idleWaiters = useRef(new Set<() => void>());
  const moveConsent = useRef<PendingMoveConsent | null>(null);
  const navigation = useRef<Navigation | null>(null);
  const epoch = useRef(0);
  const navigationRevision = useRef(0);
  const registrationFlight = useRef<{
    generation: number;
    revision: number;
    promise: Promise<void>;
  } | null>(null);
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

  const wakeIdleWaiters = useCallback(() => {
    for (const wake of idleWaiters.current) wake();
    idleWaiters.current.clear();
  }, []);

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

  const cancelMoveConsent = useCallback(() => {
    const consent = moveConsent.current;
    moveConsent.current = null;
    setConsentInProgress(false);
    if (consent) {
      clearTimeout(consent.timeout);
      consent.resolve('navigation-changed');
    }
  }, []);

  const invalidateNavigation = useCallback(() => {
    navigationRevision.current++;
    wakeIdleWaiters();
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
    cancelMoveConsent();
    clearPending(false);
    setActiveEmail(null);
    setCapabilities(null);
  }, [cancelMoveConsent, clearPending, wakeIdleWaiters]);

  const nativeRequest = useCallback(
    <T>(
      action: BridgeAction,
      payload: Record<string, unknown>,
      grant?: { ticket: string; transportId: string; consentRequestId?: string },
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const webview = window.chrome?.webview;
        if (!webview) return reject(new Error('Outlook WebView2 bridge not detected'));
        const request = createBridgeRequest(action, payload, grant);
        // Native signs a separate one-use challenge before the Outlook scope
        // authorization, so a 10s browser timeout would declare a legitimate
        // request failed while native may still be working. Never auto-retry a
        // mutation on timeout; callers must inspect Outlook's actual result.
        const deadline = action === 'PAIR_DEVICE' ? 12 * 60_000
          : action === 'REGISTER_NAVIGATION' ? 30_000
          : MUTATIONS.has(action) ? 45_000
          : action === 'PREPARE_MOVE_CONSENT' || action === 'PING' ? 10_000 : 30_000;
        const timeout = setTimeout(() => {
          pending.current.delete(request.requestId);
          reject(new Error(`Bridge command ${action} timed out`));
        }, deadline);
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
    (generation: number, deviceId: string, transportId: string, allowDuringConsent = false): Promise<void> => {
      const revision = navigationRevision.current;
      const isCurrent = () => epoch.current === generation && navigationRevision.current === revision &&
        currentScope.current === renderedScope.current && Boolean(currentScope.current) &&
        (!moveConsent.current || allowDuringConsent);
      if (!isCurrent()) return Promise.resolve();
      const activeFlight = registrationFlight.current;
      if (activeFlight?.generation === generation && activeFlight.revision === revision)
        return activeFlight.promise;
      const promise = (async () => {
      let challenge: string;
      for (;;) {
        const response = await fetch(publicBackendPath('/api/outlook/native/bootstrap'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!isCurrent()) return;
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
        challenge = bootstrap && typeof bootstrap === 'object' && 'paneChallenge' in bootstrap
          ? bootstrap.paneChallenge as string : '';
        if (typeof challenge !== 'string' || challenge.length !== 43)
          throw new Error('Invalid Outlook navigation challenge');
        if (!isCurrent()) return;
        if (activeMailRequests.current === 0) break;
        // A successful renewal must not clear or supersede a ticket/native COM
        // request. A denied renewal above must still revoke immediately.
        await new Promise<void>((resolve) => idleWaiters.current.add(resolve));
        if (!isCurrent()) return;
        // The challenge may have expired while Outlook was working; fetch a fresh one.
      }
      clearPending();
      navigation.current = null;
      firstTicket.current = null;
      selection.current++;
      setActiveEmail(null);
      setCapabilities(null);
      await nativeRequest('REGISTER_NAVIGATION', { paneChallenge: challenge });
      if (!isCurrent()) return;
      navigation.current = {
        generation,
        scopeKey: currentScope.current!,
        userId: getMailCacheScope().userId!,
        deviceId,
        paneChallenge: challenge,
        transportId,
      };
      if (renewalTimer.current) clearTimeout(renewalTimer.current);
      const renew = () => {
        if (!isCurrent()) return;
        if (moveConsent.current) {
          renewalTimer.current = setTimeout(renew, 5_000);
          return;
        }
        renewalTimer.current = null;
        startRegistration.current(generation, deviceId, transportId);
      };
      renewalTimer.current = setTimeout(renew, 45_000);
      })();
      const flight = { generation, revision, promise };
      registrationFlight.current = flight;
      void promise.then(
        () => { if (registrationFlight.current === flight) registrationFlight.current = null; },
        () => { if (registrationFlight.current === flight) registrationFlight.current = null; },
      );
      return promise;
    },
    [clearPending, invalidateNavigation, nativeRequest],
  );

  startRegistration.current = (generation, deviceId, transportId, attempt = 0) => {
    if (epoch.current !== generation || moveConsent.current ||
      registrationFlight.current?.generation === generation &&
      registrationFlight.current.revision === navigationRevision.current) return;
    void registerNavigation(generation, deviceId, transportId)
      .then(() => { if (!moveConsent.current) return loadMailRef.current(generation); })
      .catch((error: unknown) => {
        if (
          epoch.current !== generation ||
          !currentScope.current ||
          moveConsent.current ||
          updateRequiredRef.current ||
          Date.now() >= sessionExpiresAt.current
        )
          return;
        if (error instanceof Error && 'code' in error && error.code === 'NAVIGATION_DENIED') return;
        // A longer transient outage must not strand a signed-in, paired pane
        // permanently; keep only one slow retry and never retry mutations.
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(
          () => startRegistration.current(generation, deviceId, transportId, attempt + 1),
          attempt >= 3 ? 45_000 : 5_000 * 2 ** attempt,
        );
      });
  };

  const sendCommand = useCallback(
    async <TReq, TResp>(action: BridgeAction, rawPayload: TReq): Promise<TResp> => {
      const execute = async (consentRequestId?: string): Promise<TResp> => {
      if (moveConsent.current && (moveConsent.current.phase !== 'finalizing' ||
        consentRequestId !== moveConsent.current.consentRequestId ||
        action !== 'MOVE_EMAIL' && action !== 'MOVE_TO_SPAM' ||
        (rawPayload as Record<string, unknown>)?.operationId !== moveConsent.current.operationId))
        throw new Error('Finish the Outlook move confirmation before making another request');
      if (action === 'PING' || action === 'PAIR_DEVICE') {
        // Never forward a browser-supplied code or secret into the native pairing dialog.
        return nativeRequest<TResp>(action, {});
      }
      if (action === 'REGISTER_NAVIGATION' || action === 'CLEAR_SESSION' ||
        action === 'PREPARE_MOVE_CONSENT' || action === 'NATIVE_MOVE_CONSENT_RESOLVED')
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
      activeMailRequests.current++;
      let waitingForMail = true;
      try {
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
      let result: TResp;
      try {
        result = await nativeRequest<TResp>(
          action,
          { ...fullPayload, storeId: ticket.storeId },
          {
            ticket: ticket.ticket,
            transportId: registered.transportId,
            ...(consentRequestId ? { consentRequestId } : {}),
          },
        );
      } catch (error) {
        if (navigation.current === registered) {
          invalidateNavigation();
          if (++failedNativeAuthorizations.current <= 1) {
            startRegistration.current(
              registered.generation,
              registered.deviceId,
              registered.transportId,
            );
          } else if (
            epoch.current === registered.generation &&
            currentScope.current === registered.scopeKey &&
            !updateRequiredRef.current &&
            Date.now() < sessionExpiresAt.current
          ) {
            setAuthorizationUnavailable(true);
            // A denied folder clears the native selection-event lease. Without
            // a slow re-read, returning to Inbox cannot wake the pane. Retry
            // fresh navigation/read tickets only while this staff scope lives.
            retryTimer.current = setTimeout(() => {
              if (
                epoch.current === registered.generation &&
                currentScope.current === registered.scopeKey &&
                Date.now() < sessionExpiresAt.current
              ) startRegistration.current(registered.generation, registered.deviceId, registered.transportId);
            }, 45_000);
          }
        }
        throw error;
      }
      if (action === 'MOVE_EMAIL' || action === 'MOVE_TO_SPAM') {
        const offered = result as { consentRequired?: unknown; consentRequestId?: unknown;
          operationId?: unknown } | null;
        if (offered && offered.consentRequired === true) {
          // The first native request has finished; the user may now spend
          // minutes in the native consent dialog without blocking registration.
          waitingForMail = false;
          if (--activeMailRequests.current === 0) wakeIdleWaiters();
          if (consentRequestId || !/^[0-9a-f]{32}$/.test(String(offered.consentRequestId)) ||
            offered.operationId !== payload.operationId || moveConsent.current)
            throw new Error('Invalid or repeated native Outlook move confirmation');
          // The native add-in has already checked the staff, device, and exact
          // COM scope with a signed server preflight. No COM move occurs yet.
          if (renewalTimer.current) clearTimeout(renewalTimer.current);
          if (retryTimer.current) clearTimeout(retryTimer.current);
          renewalTimer.current = null;
          retryTimer.current = null;
          let resolveOutcome!: PendingMoveConsent['resolve'];
          const outcome = new Promise<Parameters<PendingMoveConsent['resolve']>[0]>((resolve) => {
            resolveOutcome = resolve;
          });
          const consent: PendingMoveConsent = {
            consentRequestId: offered.consentRequestId as string,
            operationId: payload.operationId as string,
            navigation: registered,
            phase: 'dialog',
            resolve: resolveOutcome,
            timeout: setTimeout(() => {
              if (moveConsent.current !== consent) return;
              // A person may take longer than the first 60s browser ticket.
              // Four minutes leaves time for a new ticket before the native
              // server-side five-minute one-use consent expires.
              invalidateNavigation();
              if (epoch.current === registered.generation &&
                currentScope.current === registered.scopeKey &&
                Date.now() < sessionExpiresAt.current)
                startRegistration.current(registered.generation, registered.deviceId, registered.transportId);
            }, 4 * 60_000),
          };
          moveConsent.current = consent;
          setConsentInProgress(true);
          let completed = false;
          try {
            const prepared = await nativeRequest<{ status: string; consentRequestId: string;
              operationId: string }>('PREPARE_MOVE_CONSENT', {
              consentRequestId: consent.consentRequestId, operationId: consent.operationId,
            });
            if (prepared.status !== 'pending' || prepared.consentRequestId !== consent.consentRequestId ||
              prepared.operationId !== consent.operationId)
              throw new Error('Native Outlook move confirmation did not start');
            if (await outcome !== 'approved')
              throw new Error('Outlook move confirmation was declined, expired, or interrupted; no move was requested');
            if (moveConsent.current !== consent ||
              epoch.current !== registered.generation ||
              currentScope.current !== registered.scopeKey ||
              getMailCacheScope().activeTransportId !== registered.transportId ||
              Date.now() >= sessionExpiresAt.current)
              throw new Error('Outlook staff or mailbox changed during move confirmation');
            // A renewal that began just before the dialog must settle before
            // we register a new challenge for this confirmed exact-scope move.
            const previousFlight = registrationFlight.current;
            if (previousFlight?.generation === registered.generation) {
              try { await previousFlight.promise; } catch { /* Fresh registration is still required. */ }
            }
            await registerNavigation(registered.generation, registered.deviceId, registered.transportId, true);
            if (!navigation.current || navigation.current === registered)
              throw new Error('A fresh Outlook navigation was not registered after confirmation');
            const finalMove = await execute(consent.consentRequestId);
            completed = true;
            return finalMove;
          } catch (error) {
            if (navigation.current === registered && epoch.current === registered.generation) {
              invalidateNavigation();
              if (currentScope.current === registered.scopeKey &&
                Date.now() < sessionExpiresAt.current)
                startRegistration.current(registered.generation, registered.deviceId, registered.transportId);
            }
            throw error;
          } finally {
            if (moveConsent.current === consent) {
              clearTimeout(consent.timeout);
              moveConsent.current = null;
              setConsentInProgress(false);
            }
            if (completed && epoch.current === registered.generation)
              void loadMailRef.current(registered.generation);
          }
        }
      }
      return result;
      } finally {
        if (waitingForMail && --activeMailRequests.current === 0) wakeIdleWaiters();
      }
      };
      return execute();
    },
    [invalidateNavigation, nativeRequest, registerNavigation, wakeIdleWaiters],
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
        setAuthorizationUnavailable(false);
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
      if (result.version === BRIDGE_PROTOCOL_VERSION &&
        result.action === 'NATIVE_MOVE_CONSENT_RESOLVED' && result.requestId === 'event') {
        const consent = moveConsent.current;
        const data = result.data as { consentRequestId?: unknown; operationId?: unknown;
          approved?: unknown } | null;
        if (consent?.phase === 'dialog' && consent.navigation === navigation.current &&
          result.success && data?.consentRequestId === consent.consentRequestId &&
          data.operationId === consent.operationId && typeof data.approved === 'boolean') {
          consent.phase = 'finalizing';
          clearTimeout(consent.timeout);
          consent.resolve(data.approved ? 'approved' : 'declined');
        }
        return;
      }
      if (isSelectionChangedEvent(result)) {
        if (
          moveConsent.current ||
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
      wakeIdleWaiters();
      cancelMoveConsent();
      clearPending();
      window.chrome?.webview?.removeEventListener('message', onMessage);
    };
  }, [cancelMoveConsent, clearPending, refreshPairing, sendCommand, wakeIdleWaiters]);

  useEffect(() => {
    // Learning the protocol version from an unpaired PING does not establish
    // a new native identity. Do not cancel an in-flight native-only pairing
    // dialog merely because its initial PING completed after staff clicked.
    const nativeIdentity = workstationInfo?.paired && workstationInfo.deviceId
      ? `${workstationInfo.deviceId}:${workstationInfo.bridgeProtocolVersion ?? ''}`
      : 'unpaired';
    const setup = `${scopeKey ?? ''}:${nativeIdentity}`;
    if (previousSetup.current === setup) return;
    const hadSetup = previousSetup.current !== null;
    previousSetup.current = setup;
    cancelMoveConsent();
    navigationRevision.current++;
    wakeIdleWaiters();
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
    setAuthorizationUnavailable(false);
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
  }, [scopeKey, workstationInfo, connection?.id, registerNavigation, cancelMoveConsent, clearPending, wakeIdleWaiters]);

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
          !consentInProgress &&
          currentScope.current === scopeKey &&
          navigation.current?.scopeKey === scopeKey &&
          capabilitiesOwner === scopeKey &&
          capabilities?.bridgeProtocolVersion === BRIDGE_PROTOCOL_VERSION &&
          capabilities.supportedActions.includes(action) &&
          action !== 'PING',
      ),
    [capabilities, capabilitiesOwner, consentInProgress, scopeKey],
  );

  return {
    isConnected,
    authorizationUnavailable,
    consentInProgress,
    activeEmail: activeEmailOwner === scopeKey ? activeEmail : null,
    workstationInfo,
    capabilities: capabilitiesOwner === scopeKey ? capabilities : null,
    updateRequired,
    requiresRelogin:
      requiresRelogin || Boolean(session?.user && Number.isFinite(createdAt) && !sessionValid),
    supportsAction,
    sendCommand,
    refreshAuthorization: () => {
      if (moveConsent.current) return;
      if (!currentScope.current || !scopeKey || currentScope.current !== scopeKey ||
        !workstationInfo?.paired || !workstationInfo.deviceId || !connection?.id ||
        updateRequired || Date.now() >= sessionExpiresAt.current) return;
      deniedTickets.current = 0;
      failedNativeAuthorizations.current = 0;
      setAuthorizationUnavailable(false);
      startRegistration.current(epoch.current, workstationInfo.deviceId, connection.id);
    },
    pairDevice: async () => {
      await nativeRequest('PAIR_DEVICE', {});
      await refreshPairing();
    },
  };
}
