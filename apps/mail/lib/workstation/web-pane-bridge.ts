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
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

/**
 * Web stand-in for the Outlook bridge, used by the /nava-preview viewer. It serves one
 * read-only selection. The webmail pane requires an exact stored-message id; the separate
 * preview page may show the latest inbound message. Every bridge write is refused.
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
  | { status: 'unsynced'; reason: 'no_inbound' | 'no_message_id' | 'select_message' | 'source_message_unavailable' }
  | { status: 'ready'; email: WorkstationEmailPayload };

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Whether a message is the guest's mail. The stored direction decides. Payloads without
 * it fall back to the sender: a message from the mailbox's own address is a reply.
 */
export function isInboundMessage(
  message: Pick<ThreadMessage, 'direction' | 'sender'>,
  mailboxEmail: string,
): boolean {
  if (message.direction) return message.direction === 'inbound';
  if (!mailboxEmail.trim()) return false;
  return !sameAddress(message.sender.email, mailboxEmail);
}

/** A single inbound can be selected on open; multiple inbound messages require staff choice. */
export function singleInboundMessageId(
  messages: readonly Pick<ThreadMessage, 'id' | 'threadId' | 'isDraft' | 'direction' | 'sender'>[],
  mailboxEmail: string,
  threadId: string,
): string | null {
  if (!mailboxEmail.trim() || !threadId) return null;
  const inbound = messages.filter(
    (message) => message.threadId === threadId && !message.isDraft && isInboundMessage(message, mailboxEmail),
  );
  if (inbound.length !== 1 || !inbound[0]?.id.trim()) return null;
  return messages.filter((message) => message.id === inbound[0]!.id).length === 1
    ? inbound[0]!.id
    : null;
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

/** Select an explicit stored id without substituting another email when it cannot be resolved. */
export function selectPreviewMessage(
  messages: readonly ThreadMessage[],
  mailboxEmail: string,
  transportId: string,
  sourceThreadId?: string,
  sourceMessageId?: string | null,
  requireSelectedMessage = false,
): PreviewSelection {
  if (sourceMessageId != null) {
    const matches = messages.filter((message) => message.id === sourceMessageId);
    const match = matches[0];
    if (
      !sourceMessageId.trim() || !mailboxEmail.trim() || !transportId.trim() ||
      matches.length !== 1 || !match ||
      (sourceThreadId && match.threadId !== sourceThreadId) ||
      match.isDraft || !isInboundMessage(match, mailboxEmail)
    ) {
      return { status: 'unsynced', reason: 'source_message_unavailable' };
    }
    const email = activeEmailFromMessage(match, transportId);
    return email ? { status: 'ready', email } : { status: 'unsynced', reason: 'no_message_id' };
  }
  const sourceMessages = sourceThreadId
    ? messages.filter((message) => message.threadId === sourceThreadId)
    : messages;
  if (requireSelectedMessage) {
    // Do not mutate navigation state for an automatic default. Reuse the same
    // exact-selection checks, and never guess when there are multiple inbounds.
    const onlyInbound = sourceThreadId && singleInboundMessageId(messages, mailboxEmail, sourceThreadId);
    if (onlyInbound) return selectPreviewMessage(messages, mailboxEmail, transportId, sourceThreadId, onlyInbound, true);
    return { status: 'unsynced', reason: latestInboundMessage(sourceMessages, mailboxEmail) ? 'select_message' : 'no_inbound' };
  }
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
  sourceMessageId,
  requireSelectedMessage = false,
}: {
  threadId: string;
  sourceThreadId?: string;
  sourceMessageId?: string | null;
  requireSelectedMessage?: boolean;
}): {
  selection: PreviewSelection;
  bridge: PaneBridge;
} {
  const thread = useThread(threadId);
  const { data: connection } = useActiveConnection();
  const mailboxEmail = connection?.email ?? '';
  const transportId = connection?.id ?? '';
  const threadMessages = thread.data?.messages;
  const threadTransportId = (thread.data as (IGetThreadResponse & { transportId?: string }) | undefined)?.transportId;

  const selection = useMemo<PreviewSelection>(() => {
    if (thread.isError) return { status: 'error' };
    if (thread.isThreadDataMismatch || !connection || !threadMessages) return { status: 'loading' };
    if (requireSelectedMessage && !isFrontendOnlyDemo() && threadTransportId !== transportId)
      return { status: 'unsynced', reason: 'source_message_unavailable' };
    return selectPreviewMessage(
      threadMessages,
      mailboxEmail,
      transportId,
      sourceThreadId ?? (requireSelectedMessage || sourceMessageId != null ? threadId : undefined),
      sourceMessageId,
      requireSelectedMessage,
    );
  }, [connection, mailboxEmail, requireSelectedMessage, sourceMessageId, sourceThreadId, thread.isError, thread.isThreadDataMismatch, threadId, threadMessages, threadTransportId, transportId]);

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
