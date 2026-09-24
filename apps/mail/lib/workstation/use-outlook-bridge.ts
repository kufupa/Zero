import {
  createBridgeRequest,
  isSelectionChangedEvent,
  parseBridgeMessage,
  BridgeCapabilitiesSchema,
  WorkstationEmailPayloadSchema,
  type BridgeAction,
  type BridgeCapabilities,
  type BridgeResponse,
  type WorkstationEmailPayload,
} from './bridge-protocol';
import { useState, useEffect, useCallback, useRef } from 'react';

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
  workstationUser: string;
  outlookEmail: string;
  outlookVersion: string;
  addinVersion?: string;
  bridgeProtocolVersion?: number;
};

const CAPABILITIES_RETRY_DELAY_MS = 250;
const CAPABILITIES_RETRY_MAX_DELAY_MS = 30_000;
const ACTIVE_EMAIL_RETRY_DELAY_MS = 250;

export function useOutlookBridge() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeEmail, setActiveEmail] = useState<WorkstationEmailPayload | null>(null);
  const [workstationInfo, setWorkstationInfo] = useState<WorkstationInfo | null>(null);
  const [capabilities, setCapabilities] = useState<BridgeCapabilities | null>(null);
  const activeEmailSelectionGeneration = useRef(0);
  const pendingRequests = useRef(new Map<string, (resp: BridgeResponse) => void>());
  const pendingTimeouts = useRef(new Set<ReturnType<typeof setTimeout>>());

  const sendCommand = useCallback(
    <TReq, TResp>(action: BridgeAction, payload: TReq): Promise<TResp> => {
      return new Promise((resolve, reject) => {
        if (!window.chrome?.webview) {
          reject(new Error('Outlook WebView2 bridge not detected'));
          return;
        }
        const req = createBridgeRequest(action, payload);
        const timeout = setTimeout(() => {
          pendingTimeouts.current.delete(timeout);
          pendingRequests.current.delete(req.requestId);
          reject(new Error(`Bridge command ${action} timed out`));
        }, 10000);
        pendingTimeouts.current.add(timeout);

        pendingRequests.current.set(req.requestId, (resp) => {
          clearTimeout(timeout);
          pendingTimeouts.current.delete(timeout);
          if (resp.success) {
            resolve(resp.data as TResp);
          } else {
            const error = new Error(resp.error || `Bridge action ${action} failed`) as Error & {
              code?: string;
            };
            if (resp.errorCode) error.code = resp.errorCode;
            reject(error);
          }
        });

        window.chrome.webview.postMessage(JSON.stringify(req));
      });
    },
    [],
  );

  // Without negotiated capabilities, the UI intentionally exposes legacy reads only. Mutations
  // require protocol v3 because v2 has no operation-ID cache for safe retry handling.
  const supportsAction = useCallback(
    (action: BridgeAction) =>
      capabilities?.supportedActions.includes(action) ??
      (isConnected &&
        (action === 'PING' ||
          action === 'GET_ACTIVE_EMAIL' ||
          action === 'GET_FOLDER_EMAILS' ||
          action === 'GET_EMAIL_BY_ENTRY_ID')),
    [capabilities, isConnected],
  );

  useEffect(() => {
    const timeouts = pendingTimeouts.current;
    const requests = pendingRequests.current;
    if (!window.chrome?.webview) {
      return;
    }

    let isActive = true;
    const handler = (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      const parsed = parseBridgeMessage(raw);

      if (isSelectionChangedEvent(parsed)) {
        activeEmailSelectionGeneration.current += 1;
        const email = WorkstationEmailPayloadSchema.safeParse(parsed.data);
        setActiveEmail(email.success ? email.data : null);
        return;
      }

      const callback = requests.get(parsed.requestId);
      if (callback) {
        requests.delete(parsed.requestId);
        callback(parsed);
      }
    };

    window.chrome.webview.addEventListener('message', handler);

    const scheduleCapabilitiesRetry = (attempt: number, protocolVersion?: number) => {
      const isKnownV3Bridge = protocolVersion !== undefined && protocolVersion >= 3;
      if (!isKnownV3Bridge && attempt >= 1) return;

      const delay = Math.min(
        CAPABILITIES_RETRY_DELAY_MS * 2 ** attempt,
        CAPABILITIES_RETRY_MAX_DELAY_MS,
      );
      const retryTimeout = setTimeout(() => {
        timeouts.delete(retryTimeout);
        if (isActive) requestCapabilities(attempt + 1, protocolVersion);
      }, delay);
      timeouts.add(retryTimeout);
    };

    const requestCapabilities = (attempt: number, protocolVersion?: number) => {
      void sendCommand<Record<string, never>, BridgeCapabilities>(
        'GET_CAPABILITIES',
        {} as Record<string, never>,
      )
        .then((raw) => {
          if (!isActive) return;
          const negotiated = BridgeCapabilitiesSchema.safeParse(raw);
          setCapabilities(
            negotiated.success && negotiated.data.bridgeProtocolVersion >= 3
              ? negotiated.data
              : null,
          );
          if (!negotiated.success) scheduleCapabilitiesRetry(attempt, protocolVersion);
        })
        .catch(() => {
          if (!isActive) return;
          // Keep v2 installations read-only, but recover if v3 negotiation hit a transient failure.
          setCapabilities(null);
          scheduleCapabilitiesRetry(attempt, protocolVersion);
        });
    };

    const requestActiveEmail = (attempt: number, selectionGeneration: number) => {
      void sendCommand<Record<string, never>, WorkstationEmailPayload>(
        'GET_ACTIVE_EMAIL',
        {} as Record<string, never>,
      )
        .then((mail) => {
          if (!isActive || activeEmailSelectionGeneration.current !== selectionGeneration) return;
          const email = WorkstationEmailPayloadSchema.safeParse(mail);
          setActiveEmail(email.success ? email.data : null);
        })
        .catch(() => {
          if (!isActive || activeEmailSelectionGeneration.current !== selectionGeneration) return;
          setActiveEmail(null);
          if (attempt >= 1) return;
          const retryTimeout = setTimeout(() => {
            timeouts.delete(retryTimeout);
            if (isActive && activeEmailSelectionGeneration.current === selectionGeneration) {
              requestActiveEmail(attempt + 1, selectionGeneration);
            }
          }, ACTIVE_EMAIL_RETRY_DELAY_MS);
          timeouts.add(retryTimeout);
        });
    };

    sendCommand<
      Record<string, never>,
      WorkstationInfo & { version?: string; bridgeProtocolVersion?: number }
    >('PING', {} as Record<string, never>)
      .then((info) => {
        if (!isActive) return;
        setIsConnected(true);
        if (info?.workstationUser) {
          setWorkstationInfo({
            workstationUser: info.workstationUser,
            outlookEmail: info.outlookEmail,
            outlookVersion: info.outlookVersion,
            addinVersion: info.version,
            bridgeProtocolVersion: info.bridgeProtocolVersion,
          });
        }
        requestCapabilities(0, info?.bridgeProtocolVersion);
        requestActiveEmail(0, activeEmailSelectionGeneration.current);
      })
      .catch(() => {
        if (isActive) setIsConnected(false);
      });

    return () => {
      isActive = false;
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.clear();
      requests.clear();
      window.chrome?.webview?.removeEventListener('message', handler);
    };
  }, [sendCommand]);

  return {
    isConnected,
    activeEmail,
    workstationInfo,
    capabilities,
    supportsAction,
    sendCommand,
  };
}
