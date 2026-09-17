import { useState, useEffect, useCallback, useRef } from 'react';
import {
  createBridgeRequest,
  isSelectionChangedEvent,
  parseBridgeMessage,
  WorkstationEmailPayloadSchema,
  type BridgeAction,
  type BridgeResponse,
  type WorkstationEmailPayload,
} from './bridge-protocol';

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
};

export function useOutlookBridge() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeEmail, setActiveEmail] = useState<WorkstationEmailPayload | null>(null);
  const [workstationInfo, setWorkstationInfo] = useState<WorkstationInfo | null>(null);
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

  useEffect(() => {
    if (!window.chrome?.webview) {
      setIsConnected(false);
      return;
    }

    const handler = (event: { data: unknown }) => {
      const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      const parsed = parseBridgeMessage(raw);

      if (isSelectionChangedEvent(parsed)) {
        const email = WorkstationEmailPayloadSchema.safeParse(parsed.data);
        if (email.success) {
          setActiveEmail(email.data);
        }
        return;
      }

      const callback = pendingRequests.current.get(parsed.requestId);
      if (callback) {
        pendingRequests.current.delete(parsed.requestId);
        callback(parsed);
      }
    };

    window.chrome.webview.addEventListener('message', handler);

    sendCommand<Record<string, never>, WorkstationInfo & { version?: string }>(
      'PING',
      {} as Record<string, never>,
    )
      .then((info) => {
        setIsConnected(true);
        if (info?.workstationUser) {
          setWorkstationInfo({
            workstationUser: info.workstationUser,
            outlookEmail: info.outlookEmail,
            outlookVersion: info.outlookVersion,
          });
        }
        return sendCommand<Record<string, never>, WorkstationEmailPayload>(
          'GET_ACTIVE_EMAIL',
          {} as Record<string, never>,
        );
      })
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
      for (const timeout of pendingTimeouts.current) {
        clearTimeout(timeout);
      }
      pendingTimeouts.current.clear();
      pendingRequests.current.clear();
      window.chrome?.webview?.removeEventListener('message', handler);
    };
  }, [sendCommand]);

  return {
    isConnected,
    activeEmail,
    workstationInfo,
    sendCommand,
  };
}
