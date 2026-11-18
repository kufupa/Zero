import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { attachment, mailThread, message } from '../db/schema/mail.js';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { resolvePropertyScope } from '../hms/property-registry.js';
import { toParsedMessage } from '../trpc/wire-compat.js';
import { loadConversationMetaForThread } from './conversation-group.js';
import { htmlToPlainText } from './inbound-reaction-parser.js';
import { paneAttachmentStatus } from './ingest/attachment-evidence.js';

const address = z.object({ name: z.string().nullable(), email: z.string() }).strict();
const paneImport = z.object({
  source: z.enum(['outlook', 'webmail']), mode: z.literal('live'), property_code: z.literal('HRCEN'),
  mailbox_id: z.string(), source_thread_id: z.string(), selected_message_id: z.string(),
  replay_id: z.string().uuid().optional(), input_cutoff: z.string().datetime({ offset: true }).optional(),
  messages: z.array(z.object({
    id: z.string(), rfc_message_id: z.string().nullable(), direction: z.enum(['inbound', 'outbound']),
    from: address, to: z.array(address), cc: z.array(address), received_at: z.string(),
    subject: z.string(), body_text: z.string(), body_html: z.string().nullable(),
    attachment_status: z.enum(['complete', 'unknown', 'has_unread']).optional(), attachments: z.array(z.never()),
  }).strict()).min(1),
}).strict().refine(input => Boolean(input.replay_id) === Boolean(input.input_cutoff));

function sourceAddress(value: { name?: string; email: string }) {
  const localPart = value.email.trim().split('@')[0];
  return { name: value.name === localPart ? null : value.name ?? null, email: value.email };
}

export async function canonicalCenturionPaneImport(payload: unknown, mailboxId: string) {
  const parsed = paneImport.safeParse(payload);
  if (!parsed.success || parsed.data.mailbox_id !== mailboxId) return null;
  try {
    if (resolvePropertyScope({ transportId: mailboxId }).propertyCode !== parsed.data.property_code) return null;
  } catch {
    return null;
  }
  const input = parsed.data;
  const imported = new Map(input.messages.map(item => [item.id, item]));
  if (imported.size !== input.messages.length || !imported.has(input.selected_message_id)) return null;

  return getDb().transaction(async tx => {
    const [selected] = await tx.select({ threadId: message.threadId, provenance: message.sourceProvenance })
      .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, mailboxId)))
      .where(and(eq(message.id, input.selected_message_id), eq(message.transportId, mailboxId),
        eq(message.direction, 'inbound'), eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.spamAt), isNull(mailThread.trashedAt))).limit(1);
    if (!selected || selected.provenance?.attention != null) return null;
    const scope = await loadConversationMetaForThread(tx, mailboxId, selected.threadId);
    if (scope.conversationId !== input.source_thread_id) return null;
    const conversation = await tx.select().from(message).where(and(eq(message.transportId, mailboxId),
      inArray(message.threadId, [selected.threadId, ...scope.linkedThreadIds])))
      .orderBy(asc(message.receivedAt), asc(message.id));
    const cutoff = input.input_cutoff;
    const rows = cutoff === undefined ? conversation : conversation.filter(row =>
      Date.parse(toParsedMessage(row).receivedOn) <= Date.parse(cutoff));
    if (cutoff !== undefined) {
      const inbound = rows.find(row => row.id === input.selected_message_id);
      if (!inbound || Date.parse(toParsedMessage(inbound).receivedOn) !== Date.parse(cutoff)) return null;
    }
    if (rows.length !== imported.size) return null;

    const files = await tx.select({ id: attachment.id, messageId: attachment.messageId, name: attachment.filename,
      mime: attachment.mimeType, size: attachment.sizeBytes }).from(attachment)
      .where(and(inArray(attachment.messageId, rows.map(row => row.id)), eq(attachment.isInline, false)))
      .orderBy(asc(attachment.id));
    const withFiles = new Set(files.map(file => file.messageId));
    const canonicalMessages = [];
    for (const row of rows) {
      const candidate = imported.get(row.id);
      if (!candidate || (row.direction === 'inbound' && isDaVinciMailboxOrigin(row))) return null;
      const canonical = toParsedMessage(row);
      const htmlOnly = canonical.body === canonical.processedHtml && /<[a-z][\s\S]*>/i.test(canonical.body);
      if (row.id === input.selected_message_id && input.source === 'webmail' && !canonical.messageId?.trim()) return null;
      const { attachment_status: _clientAttachmentStatus, ...fields } = candidate;
      const sourceFields = {
        id: canonical.id, rfc_message_id: canonical.messageId ?? null, direction: row.direction,
        from: sourceAddress(canonical.sender), to: canonical.to.map(sourceAddress), cc: (canonical.cc ?? []).map(sourceAddress),
        received_at: canonical.receivedOn, subject: canonical.subject,
        body_text: htmlOnly ? htmlToPlainText(canonical.body) : canonical.body, body_html: htmlOnly ? canonical.processedHtml : null,
        attachments: [],
      };
      const status = paneAttachmentStatus(withFiles.has(row.id), row.sourceProvenance);
      if (!isDeepStrictEqual(fields, sourceFields)) return null;
      canonicalMessages.push({ ...sourceFields, attachment_status: status });
    }
    const pdfs = files.filter(file => file.messageId === input.selected_message_id && file.id.length > 0 && file.name.length <= 150 &&
      file.name === file.name.replace(/\s+/g, ' ').trim() &&
      !/["\\/\p{Cc}]/u.test(file.name) && /\.pdf$/i.test(file.name) &&
      ['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(file.mime.split(';', 1)[0]?.trim().toLowerCase() ?? '') &&
      Number.isSafeInteger(file.size) && file.size > 5 && file.size <= 10 * 1024 * 1024)
      .map(file => ({ id: file.id, name: file.name, mime_type: 'application/pdf', size: file.size, handle: file.id, extracted_text: null }));
    // Both clients open the same synced mail and share its workflow identity.
    return { ...input, source: 'outlook' as const, messages: canonicalMessages.map(item =>
      item.id === input.selected_message_id ? { ...item, attachments: pdfs } : item) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function isCenturionFilingSource(input: { mailboxId: string; conversationId: string; messageId: string; attachmentId: string }): Promise<boolean> {
  try {
    if (resolvePropertyScope({ transportId: input.mailboxId }).propertyCode !== 'HRCEN') return false;
    return await getDb().transaction(async tx => {
      const [selected] = await tx.select({ mail: message }).from(message)
        .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, input.mailboxId)))
        .where(and(eq(message.id, input.messageId), eq(message.transportId, input.mailboxId),
          eq(message.direction, 'inbound'), eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
          isNull(mailThread.spamAt), isNull(mailThread.trashedAt))).limit(1);
      if (!selected || selected.mail.sourceProvenance?.attention != null || isDaVinciMailboxOrigin(selected.mail)) return false;
      const scope = await loadConversationMetaForThread(tx, input.mailboxId, selected.mail.threadId);
      if (scope.conversationId !== input.conversationId) return false;
      const rows = await tx.select().from(message).where(and(eq(message.transportId, input.mailboxId),
        inArray(message.threadId, [selected.mail.threadId, ...scope.linkedThreadIds])));
      if (rows.some(row => row.direction === 'inbound' && isDaVinciMailboxOrigin(row))) return false;
      const [file] = await tx.select({ id: attachment.id }).from(attachment).where(and(
        eq(attachment.id, input.attachmentId), eq(attachment.messageId, input.messageId), eq(attachment.isInline, false),
      )).limit(1);
      return Boolean(file);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  } catch {
    return false;
  }
}
