import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeAction,
  type WorkstationEmailPayload,
} from './bridge-protocol';
import type { IGetThreadResponse } from '@zero/server/driver/types';
import { useActiveConnection } from '@/hooks/use-connections';
import type { WorkstationInfo } from './use-outlook-bridge';
import type { PaneBridge } from './pane-bridge-types';
import { useThread } from '@/hooks/use-threads';
import { useMemo } from 'react';

/**
 * Web stand-in for the Outlook bridge, used by the /nava-preview viewer. It serves one
 * read-only selection: the thread's latest inbound message, as the pane would see it in
 * Outlook. Every write is refused, and the Outlook ticket path is never used.
 */

export const PREVIEW_ONLY_MESSAGE = 'Preview only: copy the reply or download the PDF.';
/** folderEntryId for a web selection. The server ignores it; the pane only echoes it. */
export const PREVIEW_FOLDER_ENTRY_ID = 'thread';
const PREVIEW_ADDIN_VERSION = 'web-preview';
/** The only actions the viewer answers. supportsAction() and sendCommand() share this list. */
const READ_ACTIONS: ReadonlySet<BridgeAction> = new Set<BridgeAction>(['PING', 'GET_ACTIVE_EMAIL']);

type ThreadMessage = IGetThreadResponse['messages'][number];
type MailAddress = { name?: string; email: string };

export type PreviewSelection =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unsynced'; reason: 'no_inbound' | 'no_message_id' }
  | { status: 'ready'; email: WorkstationEmailPayload };

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Whether a message is the guest's mail. The stored direction decides. Payloads without
 * it fall back to the sender: a message from the mailbox's own address is a reply.
 */
export function isInboundMessage(message: ThreadMessage, mailboxEmail: string): boolean {
  if (message.direction) return message.direction === 'inbound';
  if (!mailboxEmail.trim()) return false;
  return !sameAddress(message.sender.email, mailboxEmail);
}

/**
 * Latest inbound message of the thread. Not `latest`, which can be the mailbox's own
 * reply. Drafts are skipped. Ties keep the later message in the thread's order.
 */
export function latestInboundMessage(
  messages: readonly ThreadMessage[],
  mailboxEmail: string,
): ThreadMessage | undefined {
  let best: ThreadMessage | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (message.isDraft || !isInboundMessage(message, mailboxEmail)) continue;
    const parsed = Date.parse(message.receivedOn);
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (!best || time >= bestTime) {
      best = message;
      bestTime = time;
    }
  }
  return best;
}

function joinAddresses(addresses: readonly MailAddress[]): string {
  return addresses
    .map((address) => address.email)
    .filter(Boolean)
    .join('; ');
}

/** The payload the pane receives for one stored message. Needs its Message-ID to bind an analysis. */
export function activeEmailFromMessage(
  message: ThreadMessage,
  transportId: string,
): WorkstationEmailPayload | null {
  const internetMessageId = message.messageId?.trim();
  if (!internetMessageId) return null;
  const cc = joinAddresses(message.cc ?? []);
  return {
    entryId: message.id,
    storeId: transportId,
    folderEntryId: PREVIEW_FOLDER_ENTRY_ID,
    subject: message.subject ?? '',
    senderEmail: message.sender.email,
    senderName: message.sender.name?.trim() || message.sender.email,
    to: joinAddresses(message.to),
    ...(cc ? { cc } : {}),
    receivedTime: message.receivedOn,
    bodyText: message.body,
    bodyHtml: message.processedHtml,
    internetMessageId,
  };
}

/** Selects the latest inbound message, optionally pinned to a workflow row's source thread. */
export function selectPreviewMessage(
  messages: readonly ThreadMessage[],
  mailboxEmail: string,
  transportId: string,
  sourceThreadId?: string,
): PreviewSelection {
  const sourceMessages = sourceThreadId
    ? messages.filter((message) => message.threadId === sourceThreadId)
    : messages;
  const inbound = latestInboundMessage(sourceMessages, mailboxEmail);
  if (!inbound) return { status: 'unsynced', reason: 'no_inbound' };
  const email = activeEmailFromMessage(inbound, transportId);
  if (!email) return { status: 'unsynced', reason: 'no_message_id' };
  return { status: 'ready', email };
}

/**
 * The PaneBridge the pane reads. `activeEmail` is the selected message, or null. Writes
 * reject with PREVIEW_ONLY_MESSAGE; no other path reaches the native bridge or a ticket.
 */
export function buildPreviewBridge(activeEmail: WorkstationEmailPayload | null): PaneBridge {
  const workstationInfo: WorkstationInfo = {
    bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    addinVersion: PREVIEW_ADDIN_VERSION,
    paired: true,
    deviceId: null,
  };
  const sendCommand = async <TReq, TResp>(action: BridgeAction, _payload: TReq): Promise<TResp> => {
    if (action === 'PING') {
      return {
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        addinVersion: PREVIEW_ADDIN_VERSION,
      } as TResp;
    }
    if (action === 'GET_ACTIVE_EMAIL') return activeEmail as TResp;
    throw new Error(PREVIEW_ONLY_MESSAGE);
  };
  return {
    isConnected: true,
    authorizationUnavailable: false,
    selectionOutsideMailbox: false,
    consentInProgress: false,
    activeEmail,
    workstationInfo,
    capabilities: null,
    updateRequired: false,
    requiresRelogin: false,
    supportsAction: (action: BridgeAction) => READ_ACTIONS.has(action),
    sendCommand,
    refreshAuthorization: () => {},
    activateMailboxSync: async () => {},
    pairDevice: async () => {},
  };
}

/**
 * Loads the thread and returns the viewer's selection with its PaneBridge. The selected
 * message object keeps one identity while its content is unchanged, so the pane does not
 * re-run on every poll.
 */
export function useWebPreview({
  threadId,
  sourceThreadId,
}: {
  threadId: string;
  sourceThreadId?: string;
}): {
  selection: PreviewSelection;
  bridge: PaneBridge;
} {
  const thread = useThread(threadId);
  const { data: connection } = useActiveConnection();
  const mailboxEmail = connection?.email ?? '';
  const transportId = connection?.id ?? '';
  const threadMessages = thread.data?.messages;

  const selection = useMemo<PreviewSelection>(() => {
    if (thread.isError) return { status: 'error' };
    if (!connection || !threadMessages) return { status: 'loading' };
    return selectPreviewMessage(threadMessages, mailboxEmail, transportId, sourceThreadId);
  }, [connection, mailboxEmail, sourceThreadId, thread.isError, threadMessages, transportId]);

  const stableKey = selection.status === 'ready' ? JSON.stringify(selection.email) : '';
  const activeEmail = useMemo(
    () => (stableKey ? (JSON.parse(stableKey) as WorkstationEmailPayload) : null),
    [stableKey],
  );
  const bridge = useMemo(() => buildPreviewBridge(activeEmail), [activeEmail]);
  return { selection, bridge };
}

/** PaneBridge for one thread in the /nava-preview viewer. */
export function useWebPaneBridge({ threadId }: { threadId: string }): PaneBridge {
  return useWebPreview({ threadId }).bridge;
}
