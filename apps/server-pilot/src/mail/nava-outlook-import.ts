import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { attachment, mailThread, message } from '../db/schema/mail.js';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { resolvePropertyScope } from '../hms/property-registry.js';
import { toParsedMessage } from '../trpc/wire-compat.js';
import {
  buildConversationMetaAsOf,
  loadConversationEdgesForTransport,
  loadConversationMetaForThread,
  type ThreadStats,
} from './conversation-group.js';
import { htmlToPlainText } from './inbound-reaction-parser.js';
import { paneAttachmentStatus } from './ingest/attachment-evidence.js';
import {
  projectRequestTimeContext,
  type RequestTimeContextPacket,
  type RequestTimeContextResult,
} from './request-time-context.js';

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

function sourceMessage(row: typeof message.$inferSelect) {
  const canonical = toParsedMessage(row);
  const htmlOnly = canonical.body === canonical.processedHtml && /<[a-z][\s\S]*>/i.test(canonical.body);
  return {
    id: canonical.id, rfc_message_id: canonical.messageId ?? null, direction: row.direction,
    from: sourceAddress(canonical.sender), to: canonical.to.map(sourceAddress), cc: (canonical.cc ?? []).map(sourceAddress),
    received_at: canonical.receivedOn, subject: canonical.subject,
    body_text: htmlOnly ? htmlToPlainText(canonical.body) : canonical.body, body_html: htmlOnly ? canonical.processedHtml : null,
    attachments: [],
  };
}

/** Build the same input the webmail pane submits, from an admitted inbound message. */
export async function canonicalCenturionArrivalImport(mailboxId: string, messageId: string) {
  const payload = await getDb().transaction(async tx => {
    const [selected] = await tx.select({ threadId: message.threadId }).from(message)
      .where(and(eq(message.id, messageId), eq(message.transportId, mailboxId), eq(message.direction, 'inbound'))).limit(1);
    if (!selected) return null;
    const scope = await loadConversationMetaForThread(tx, mailboxId, selected.threadId);
    const rows = await tx.select().from(message).where(and(eq(message.transportId, mailboxId),
      inArray(message.threadId, [selected.threadId, ...scope.linkedThreadIds])))
      .orderBy(asc(message.receivedAt), asc(message.id));
    return { source: 'outlook', mode: 'live', property_code: 'HRCEN', mailbox_id: mailboxId,
      source_thread_id: scope.conversationId, selected_message_id: messageId, messages: rows.map(sourceMessage) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  return payload ? canonicalCenturionPaneImport(payload, mailboxId) : null;
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
        eq(message.direction, 'inbound'),
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
      if (row.id === input.selected_message_id && input.source === 'webmail' && !canonical.messageId?.trim()) return null;
      const { attachment_status: _clientAttachmentStatus, ...fields } = candidate;
      const sourceFields = sourceMessage(row);
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
    const selectedIndex = canonicalMessages.findIndex(item => item.id === input.selected_message_id);
    return { ...input, source: 'outlook' as const, messages: canonicalMessages.slice(0, selectedIndex + 1).map(item =>
      item.id === input.selected_message_id ? { ...item, attachments: pdfs } : item) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/**
 * After canonical identity validation: derive server-owned as-of context from
 * historically admissible bytes. Does not change message equality / filing grants.
 */
export async function deriveCenturionRequestTimeContext(
  canonical: NonNullable<Awaited<ReturnType<typeof canonicalCenturionPaneImport>>>,
  attestedBy: 'nava_gateway' | 'nava_arrival',
): Promise<RequestTimeContextResult> {
  const cutoff = canonical.input_cutoff
    ?? canonical.messages.find((item) => item.id === canonical.selected_message_id)?.received_at;
  if (!cutoff) {
    return {
      state: 'unobserved',
      reason: 'cutoff_unavailable',
      contextDigest: '0'.repeat(64),
    };
  }
  const cutoffMs = Date.parse(cutoff);
  return getDb().transaction(async (tx) => {
    const [selected] = await tx.select({
      threadId: message.threadId,
    }).from(message).where(and(
      eq(message.id, canonical.selected_message_id),
      eq(message.transportId, canonical.mailbox_id),
    )).limit(1);
    if (!selected) {
      return { state: 'unobserved' as const, reason: 'selected_unavailable', contextDigest: '0'.repeat(64) };
    }

    const edges = await loadConversationEdgesForTransport(tx, canonical.mailbox_id);
    const seedIds = [selected.threadId];
    const ufStats = new Map<string, ThreadStats>();
    // Expand candidate threads from edges that were visible at cutoff (includes later-superseded).
    // Never merge live/post-cutoff linkedThreadIds — those leak future conversation graph.
    const asOfMeta = buildConversationMetaAsOf(
      canonical.mailbox_id, seedIds, edges, ufStats, cutoffMs,
    );
    const candidateThreadIds = new Set<string>([
      selected.threadId,
      ...(asOfMeta.get(selected.threadId)?.linkedThreadIds ?? []),
    ]);
    // Also include both endpoints of every edge that touches the seed and is visible at cutoff.
    // Fail closed on unknown createdAt / bad cutoff.
    if (Number.isFinite(cutoffMs)) {
      for (const edge of edges) {
        const created = edge.createdAt instanceof Date ? edge.createdAt.getTime()
          : edge.createdAt ? Date.parse(String(edge.createdAt)) : NaN;
        if (!Number.isFinite(created) || created > cutoffMs) continue;
        const superseded = edge.supersededAt instanceof Date ? edge.supersededAt.getTime()
          : edge.supersededAt ? Date.parse(String(edge.supersededAt)) : NaN;
        if (Number.isFinite(superseded) && superseded <= cutoffMs) continue;
        if (edge.srcThreadId === selected.threadId || edge.dstThreadId === selected.threadId
          || candidateThreadIds.has(edge.srcThreadId) || candidateThreadIds.has(edge.dstThreadId)) {
          candidateThreadIds.add(edge.srcThreadId);
          candidateThreadIds.add(edge.dstThreadId);
        }
      }
    }

    const rows = await tx.select({
      id: message.id,
      threadId: message.threadId,
      direction: message.direction,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
      fromAddress: message.fromAddress,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
    }).from(message).where(and(
      eq(message.transportId, canonical.mailbox_id),
      inArray(message.threadId, [...candidateThreadIds]),
    )).orderBy(asc(message.receivedAt), asc(message.id));

    const authorized = rows.flatMap((row) => {
      const received = row.receivedAt ?? row.sentAt ?? row.createdAt;
      const receivedMs = received instanceof Date ? received.getTime() : Date.parse(String(received ?? ''));
      // Hard receipt-time bound: drop post-cutoff / unparseable timestamps before projection.
      if (!Number.isFinite(cutoffMs) || !Number.isFinite(receivedMs) || receivedMs > cutoffMs) return [];
      const receivedAt = received instanceof Date ? received.toISOString() : String(received ?? '');
      const body = row.textBody?.trim()
        ? row.textBody
        : row.htmlBody ? htmlToPlainText(row.htmlBody) : '';
      return [{
        id: row.id,
        threadId: row.threadId,
        rfcMessageId: row.messageIdHeader,
        inReplyTo: row.inReplyTo,
        references: row.references ?? [],
        direction: row.direction as 'inbound' | 'outbound',
        receivedAt,
        subject: row.subject ?? '',
        bodyText: body,
        fromEmail: (/<([^<>]+)>/.exec(row.fromAddress)?.[1] ?? row.fromAddress).trim().toLowerCase(),
      }];
    });

    return projectRequestTimeContext({
      scope: { property: canonical.property_code, mailbox: canonical.mailbox_id },
      selectedId: canonical.selected_message_id,
      cutoff,
      messages: authorized,
      recordedEdges: edges.map((edge) => ({
        srcThreadId: edge.srcThreadId,
        dstThreadId: edge.dstThreadId,
        srcMessageId: edge.srcMessageId,
        dstMessageId: edge.dstMessageId,
        linkType: edge.linkType,
        createdAt: edge.createdAt instanceof Date ? edge.createdAt.toISOString() : edge.createdAt ? String(edge.createdAt) : null,
        supersededAt: edge.supersededAt instanceof Date ? edge.supersededAt.toISOString()
          : edge.supersededAt ? String(edge.supersededAt) : null,
      })),
      attested_by: attestedBy,
    });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export type CenturionImportWithContext = NonNullable<Awaited<ReturnType<typeof canonicalCenturionPaneImport>>> & {
  request_time_context?: RequestTimeContextPacket | { state: 'unobserved'; reason: string; contextDigest: string };
};

export async function isCenturionFilingSource(input: { mailboxId: string; conversationId: string; messageId: string; attachmentId: string }): Promise<boolean> {
  try {
    if (resolvePropertyScope({ transportId: input.mailboxId }).propertyCode !== 'HRCEN') return false;
    return await getDb().transaction(async tx => {
      const [selected] = await tx.select({ mail: message }).from(message)
        .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, input.mailboxId)))
        .where(and(eq(message.id, input.messageId), eq(message.transportId, input.mailboxId),
          eq(message.direction, 'inbound'),
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
