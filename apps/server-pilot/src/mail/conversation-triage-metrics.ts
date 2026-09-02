import type { TriageMessageRow } from '../ai/triage-input.js';
import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  detectConversationSignals,
  isConversationResponded,
  type ConversationMessage,
  type ConversationSignal,
  type IndexableMessage,
} from './conversation-signals.js';

export type ConversationTriageMetrics = {
  conversationResponded: boolean;
  conversationSignalReasons: ConversationSignal[];
};

function messageTimestamp(row: TriageMessageRow): string {
  return (row.receivedAt ?? row.sentAt ?? row.createdAt).toISOString();
}

function toIndexableMessage(row: TriageMessageRow, threadId: string): IndexableMessage {
  return {
    id: row.id,
    threadId,
    direction: row.direction,
    from: row.from,
    to: (row.to ?? []).join(', '),
    cc: (row.cc ?? []).join(', '),
    subject: row.subject ?? '',
    receivedAt: messageTimestamp(row),
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references,
  };
}

function toConversationMessage(row: TriageMessageRow, threadId: string): ConversationMessage {
  return {
    ...toIndexableMessage(row, threadId),
    bodyText: row.body,
  };
}

/**
 * Layer B conversation overlay for triage run metrics only — not prompt/hash/spam refine.
 * Cross-thread indexes use transport-scoped rows when provided; otherwise best-effort from causal thread.
 */
export function computeConversationTriageMetrics(input: {
  threadId: string;
  triggerMessageId: string;
  causalMessages: readonly TriageMessageRow[];
  transportIndexMessages?: readonly IndexableMessage[];
}): ConversationTriageMetrics {
  const indexSource =
    input.transportIndexMessages ??
    input.causalMessages.map((row) => toIndexableMessage(row, input.threadId));
  const autoConfirmIndex = buildAutoConfirmIndex(indexSource);
  const orphanByGuest = buildOrphanOutboundIndex(indexSource);
  const messages = input.causalMessages.map((row) =>
    toConversationMessage(row, input.threadId),
  );
  const conversationSignalReasons = detectConversationSignals({
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    messages,
    autoConfirmIndex,
    orphanByGuest,
  });
  return {
    conversationResponded: isConversationResponded(conversationSignalReasons),
    conversationSignalReasons,
  };
}
