import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { mailThread, message } from '../db/schema/mail.js';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { resolvePropertyScope } from '../hms/property-registry.js';
import { toParsedMessage } from '../trpc/wire-compat.js';
import { loadConversationMetaForThread } from './conversation-group.js';

const address = z.object({ name: z.string().nullable(), email: z.string() }).strict();
const outlookImport = z.object({
  source: z.literal('outlook'), mode: z.literal('live'), property_code: z.literal('HRCEN'),
  mailbox_id: z.string(), source_thread_id: z.string(), selected_message_id: z.string(),
  messages: z.array(z.object({
    id: z.string(), rfc_message_id: z.string().nullable(), direction: z.enum(['inbound', 'outbound']),
    from: address, to: z.array(address), cc: z.array(address), received_at: z.string(),
    subject: z.string(), body_text: z.string(), body_html: z.null(),
    attachment_status: z.enum(['complete', 'unknown', 'has_unread']).optional(), attachments: z.array(z.never()),
  }).strict()).min(1),
}).strict();

function sourceAddress(value: { name?: string; email: string }) {
  const localPart = value.email.trim().split('@')[0];
  return { name: value.name === localPart ? null : value.name ?? null, email: value.email };
}

export async function isCenturionOutlookImport(payload: unknown, mailboxId: string): Promise<boolean> {
  const parsed = outlookImport.safeParse(payload);
  if (!parsed.success || parsed.data.mailbox_id !== mailboxId) return false;
  try {
    if (resolvePropertyScope({ transportId: mailboxId }).propertyCode !== parsed.data.property_code) return false;
  } catch {
    return false;
  }
  const input = parsed.data;
  const imported = new Map(input.messages.map(item => [item.id, item]));
  if (imported.size !== input.messages.length || !imported.has(input.selected_message_id)) return false;

  return getDb().transaction(async tx => {
    const [selected] = await tx.select({ threadId: message.threadId, provenance: message.sourceProvenance })
      .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, mailboxId)))
      .where(and(eq(message.id, input.selected_message_id), eq(message.transportId, mailboxId),
        eq(message.direction, 'inbound'), eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.spamAt), isNull(mailThread.trashedAt))).limit(1);
    if (!selected || selected.provenance?.attention != null) return false;
    const scope = await loadConversationMetaForThread(tx, mailboxId, selected.threadId);
    if (scope.conversationId !== input.source_thread_id) return false;
    const rows = await tx.select().from(message).where(and(eq(message.transportId, mailboxId),
      inArray(message.threadId, [selected.threadId, ...scope.linkedThreadIds])));
    if (rows.length !== imported.size) return false;
    return rows.every(row => {
      const candidate = imported.get(row.id);
      if (!candidate || (row.direction === 'inbound' && isDaVinciMailboxOrigin(row))) return false;
      const canonical = toParsedMessage(row);
      if (!canonical.body.trim() || (canonical.body === canonical.processedHtml && /<[a-z][\s\S]*>/i.test(canonical.body))) return false;
      return isDeepStrictEqual(candidate, {
        id: canonical.id, rfc_message_id: canonical.messageId ?? null, direction: row.direction,
        from: sourceAddress(canonical.sender), to: canonical.to.map(sourceAddress), cc: (canonical.cc ?? []).map(sourceAddress),
        received_at: canonical.receivedOn, subject: canonical.subject, body_text: canonical.body, body_html: null,
        ...(candidate.attachment_status === undefined ? {} : { attachment_status: candidate.attachment_status }), attachments: [],
      });
    });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
