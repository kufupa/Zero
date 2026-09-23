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

export function useOutlookBridge() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeEmail, setActiveEmail] = useState<WorkstationEmailPayload | null>(null);
  const [workstationInfo, setWorkstationInfo] = useState<WorkstationInfo | null>(null);
  const [capabilities, setCapabilities] = useState<BridgeCapabilities | null>(null);
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
            reject(new Error(resp.error || `Bridge action ${action} failed`));
          }
        });

        window.chrome.webview.postMessage(JSON.stringify(req));
      });
    },
    [],
  );

  // v2 installers support reading selected messages; v3 mutations require negotiated capabilities.
  const supportsAction = useCallback(
    (action: BridgeAction) =>
      capabilities?.supportedActions.includes(action) ??
      (isConnected &&
        (action === 'PING' ||
          action === 'GET_ACTIVE_EMAIL' ||
          action === 'GET_FOLDER_EMAILS' ||
          action === 'GET_EMAIL_BY_ENTRY_ID' ||
          action === 'CREATE_REPLY_DRAFT')),
    [capabilities, isConnected],
  );

  useEffect(() => {
    const timeouts = pendingTimeouts.current;
    const requests = pendingRequests.current;
    if (!window.chrome?.webview) {
      setIsConnected(false);
      return;
    }

    const handler = (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      const parsed = parseBridgeMessage(raw);

      if (isSelectionChangedEvent(parsed)) {
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

    sendCommand<
      Record<string, never>,
      WorkstationInfo & { version?: string; bridgeProtocolVersion?: number }
    >('PING', {} as Record<string, never>)
      .then((info) => {
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
        return sendCommand<Record<string, never>, BridgeCapabilities>(
          'GET_CAPABILITIES',
          {} as Record<string, never>,
        )
          .then((raw) => {
            const negotiated = BridgeCapabilitiesSchema.safeParse(raw);
            if (negotiated.success && negotiated.data.bridgeProtocolVersion >= 3) {
              setCapabilities(negotiated.data);
            }
          })
          .catch(() => {
            // Unknown action on installed v2 bridge: retain legacy read connectivity.
            setCapabilities(null);
          });
      })
      .then(() =>
        sendCommand<Record<string, never>, WorkstationEmailPayload>(
          'GET_ACTIVE_EMAIL',
          {} as Record<string, never>,
        ),
      )
      .then((mail) => {
        const email = WorkstationEmailPayloadSchema.safeParse(mail);
        if (email.success) {
          setActiveEmail(email.data);
        }
      })
      .catch(() => {
        setIsConnected(false);
      });

    return () => {
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
