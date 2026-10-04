import {
  findCanonicalCandidate,
  lockCanonicalMailbox,
  type CanonicalEvidence,
  corroboratedMessageId,
} from './canonical-identity.js';
import { attachment, mailboxTransport, mailThread, message } from '../../db/schema/mail.js';
import { canonicalMessageId, buildReferenceChain } from './message-id.js';
import { refreshThreadSearchVector } from '../search/search-vector.js';
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

export type OutlookHistoryInput = Omit<CanonicalEvidence, 'attachments'> & {
  transportId: string;
  sourceId?: string;
  sourceObservationId: string;
  semanticVersion: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string[];
  bccAddresses: string[];
  sentAt: Date | null;
  originalMsgKey: string;
  attachments: {
    sourceAttachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    s3Key: string;
    contentId: string | null;
    isInline: boolean;
  }[];
  sourceProvenance: Record<string, unknown>;
};
/** History only inserts/enriches searchable evidence; operational clocks/state and queues stay untouched. */
export async function persistOutlookHistory(
  db: DB,
  input: OutlookHistoryInput,
): Promise<{ messageId: string; threadId: string; linked: boolean; attention: boolean }> {
  if (
    !input.originalMsgKey.startsWith('outlook-sync-originals/v1/') ||
    input.attachments.some(
      (a) =>
        !Number.isSafeInteger(a.sizeBytes) ||
        a.sizeBytes < 0 ||
        !a.s3Key.startsWith('outlook-sync-originals/v1/'),
    )
  )
    throw new Error('Invalid sealed history artifact');
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DB;
    await lockCanonicalMailbox(scoped, input.transportId);
    const [transport] = await tx
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(and(eq(mailboxTransport.id, input.transportId), eq(mailboxTransport.isActive, true)))
      .limit(1);
    if (!transport) throw new Error('Inactive history mailbox');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          input.transportId,
          input.sourceId ?? input.originalMsgKey,
          input.sourceObservationId,
        ]),
      )
      .digest('hex');
    const observationMessageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const [prior] = await tx
      .select()
      .from(message)
      .where(and(eq(message.transportId, input.transportId), eq(message.id, observationMessageId)))
      .limit(1);
    const candidate = prior
      ? { kind: 'unique' as const, message: prior }
      : await findCanonicalCandidate(scoped, input.transportId, input);
    let messageId: string, threadId: string;
    const attention =
      candidate.kind === 'ambiguous' ||
      (candidate.kind === 'unique' &&
        candidate.message.sourceProvenance?.attention === 'AMBIGUOUS_IDENTITY');
    const linked = candidate.kind === 'unique';
    if (candidate.kind === 'unique') {
      messageId = candidate.message.id;
      threadId = candidate.message.threadId;
      const previousVersion = candidate.message.sourceProvenance?.canonicalContentVersion;
      const incomingVersion = /^\d+$/.test(input.semanticVersion)
        ? BigInt(input.semanticVersion)
        : null;
      const newerOwnedHistory = Boolean(
        prior &&
          prior.historyOnly &&
          incomingVersion !== null &&
          (typeof previousVersion !== 'string' ||
            (/^\d+$/.test(previousVersion) && incomingVersion > BigInt(previousVersion))),
      );
      await tx
        .update(message)
        .set({
          originalMsgS3Key: candidate.message.originalMsgS3Key ?? input.originalMsgKey,
          textBody:
            newerOwnedHistory && input.textBody !== null
              ? input.textBody
              : (candidate.message.textBody ?? input.textBody),
          htmlBody:
            newerOwnedHistory && input.htmlBody !== null
              ? sanitizeHtmlBodyForStorage(input.htmlBody)
              : (candidate.message.htmlBody ?? sanitizeHtmlBodyForStorage(input.htmlBody)),
          ...(newerOwnedHistory
            ? {
                sourceProvenance: {
                  ...candidate.message.sourceProvenance,
                  canonicalContentVersion: input.semanticVersion,
                },
              }
            : {}),
        })
        .where(eq(message.id, messageId));
    } else {
      messageId = observationMessageId;
      const chain = buildReferenceChain(input.inReplyTo, input.references);
      let parentThread: string | undefined;
      // Reused/missing references never force grouping. No subject fallback.
      for (const ref of [...chain].reverse()) {
        if (!corroboratedMessageId(ref)) continue;
        const parents = await tx
          .select({ threadId: message.threadId })
          .from(message)
          .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, ref)))
          .limit(2);
        if (parents.length === 1) {
          parentThread = parents[0]!.threadId;
          break;
        }
        if (parents.length > 1) break;
      }
      threadId = parentThread ?? randomUUID();
      if (!parentThread)
        await tx.insert(mailThread).values({
          id: threadId,
          transportId: input.transportId,
          threadRootId: `outlook:${messageId}`,
          subject: input.subject,
          snippet: input.textBody?.slice(0, 160),
          historyOnly: true,
          isRead: true,
          latestMessageAt: input.authoredAt,
        });
      await tx.insert(message).values({
        id: messageId,
        transportId: input.transportId,
        threadId,
        direction: input.direction,
        historyOnly: true,
        isRead: true,
        messageIdHeader: canonicalMessageId(input.internetMessageId),
        inReplyTo: canonicalMessageId(input.inReplyTo),
        references: chain,
        fromAddress: input.fromAddress,
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses,
        bccAddresses: input.bccAddresses,
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: sanitizeHtmlBodyForStorage(input.htmlBody),
        receivedAt: input.authoredAt,
        sentAt: input.sentAt,
        originalMsgS3Key: input.originalMsgKey,
        sourceProvenance: {
          ...input.sourceProvenance,
          canonicalContentVersion: input.semanticVersion,
          ...(attention ? { attention: 'AMBIGUOUS_IDENTITY' } : {}),
        },
      });
    }
    const existing = await tx
      .select({ s3Key: attachment.s3Key })
      .from(attachment)
      .where(eq(attachment.messageId, messageId));
    const keys = new Set(existing.map((a) => a.s3Key));
    for (let start = 0; start < input.attachments.length; start += 100) {
      const additions = input.attachments
        .slice(start, start + 100)
        .filter((a) => !keys.has(a.s3Key));
      if (additions.length)
        await tx
          .insert(attachment)
          .values(additions.map((a) => ({ id: randomUUID(), messageId, ...a })));
      for (const a of additions) keys.add(a.s3Key);
    }
    // Late parent arrival may repair only wholly historical child threads.
    const header = corroboratedMessageId(input.internetMessageId);
    if (header) {
      const parents = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, header)))
        .limit(2);
      if (parents.length === 1) {
        const children = await tx
          .select({ id: message.id, threadId: message.threadId, inReplyTo: message.inReplyTo })
          .from(message)
          .innerJoin(mailThread, eq(message.threadId, mailThread.id))
          .where(
            and(
              eq(message.transportId, input.transportId),
              eq(message.historyOnly, true),
              eq(mailThread.historyOnly, true),
              eq(message.inReplyTo, header),
            ),
          );
        for (const child of children)
          if (child.threadId !== threadId) {
            const members = await tx
              .select({ id: message.id, historyOnly: message.historyOnly })
              .from(message)
              .where(eq(message.threadId, child.threadId));
            if (members.every((m) => m.historyOnly)) {
              await tx
                .update(message)
                .set({ threadId })
                .where(
                  inArray(
                    message.id,
                    members.map((m) => m.id),
                  ),
                );
              await tx
                .delete(mailThread)
                .where(and(eq(mailThread.id, child.threadId), eq(mailThread.historyOnly, true)));
            }
          }
      }
    }
    await refreshThreadSearchVector(scoped, threadId);
    return { messageId, threadId, linked, attention };
  });
}
