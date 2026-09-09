/**
 * FE ↔ pilot wire format helpers — ParsedMessage shape and send input coercion.
 */
import { sanitizeEmailHtml } from '../mail/sanitize-email-html.js';
import type { ParsedMessage } from '../lib/driver/types.js';
import type { message } from '../db/schema/mail.js';
import { z } from 'zod';

export type MessageRow = typeof message.$inferSelect;

export type MailDebugHeaderLine = { key: string; line: string };

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Recipient object or bare email string from FE send/reply composers. */
const recipientInput = z.union([
  z.string(),
  z.object({
    email: z.string(),
    name: z.string().optional(),
  }),
]);

export const serializedAttachmentInput = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  lastModified: z.number(),
  base64: z.string(),
});

/** Closed U6 approval token accepted only as an opaque, server-validated value. */
const draftApprovalInput = z
  .object({
    version: z.string(),
    purpose: z.string(),
    draftId: z.string(),
    generationId: z.string(),
    transportId: z.string(),
    threadId: z.string(),
    revisionId: z.string(),
    threadStateVersion: z.string(),
    policyVersion: z.string(),
    approvedByUserId: z.string(),
    approvedAt: z.string(),
    bodyDigest: z.string(),
    recipientDigest: z.string(),
    attachmentDigest: z.string(),
    evidenceDigest: z.string(),
    routeBinding: z
      .object({
        routeId: z.string(),
        modelId: z.string(),
        purpose: z.literal('draft'),
        protocol: z.literal('in_process'),
        access: z.literal('current_app'),
        egress: z.literal('none'),
        retention: z.literal('bounded'),
        usage: z.literal('reported'),
      })
      .strict()
      .optional(),
    fingerprint: z.string(),
    signature: z.string(),
  })
  .strict();

/** FE mail.send payload — mirrors create-email.tsx / reply-composer.tsx. */
export const sendInput = z
  .object({
    threadId: z.string().optional(),
    to: z.array(recipientInput),
    cc: z.array(recipientInput).default([]),
    bcc: z.array(recipientInput).default([]),
    subject: z.string().default(''),
    message: z.string().optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    attachments: z.array(serializedAttachmentInput).optional().default([]),
    fromEmail: z.string().optional(),
    draftId: z.string().optional(),
    confirmStaleDraft: z.boolean().optional().default(false),
    replyToMessageId: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.array(z.string()).optional(),
    /** FE schedule send — ISO string from create-email / reply-composer. */
    scheduleAt: z.string().optional(),
    /** Prior message HTML — appended when client html lacks quoted body. */
    originalMessage: z.string().optional(),
    /** Explicit human approval for an AI draft; never inferred from confirmStaleDraft. */
    draftApproval: draftApprovalInput.optional(),
    /** Compatibility alias for non-React/API callers; normalized to draftApproval. */
    approval: draftApprovalInput.optional(),
  })
  .transform((input) => {
    const baseHtml = input.message ?? input.html ?? '';
    const original = input.originalMessage?.trim() ?? '';
    const html =
      original && !baseHtml.includes(original.slice(0, Math.min(80, original.length)))
        ? `${baseHtml}${original}`
        : baseHtml;

    return {
      threadId: input.threadId,
      to: coerceRecipientEmails(input.to),
      cc: coerceRecipientEmails(input.cc),
      bcc: coerceRecipientEmails(input.bcc),
      subject: input.subject,
      html,
      text: input.text ?? '',
      attachments: input.attachments,
      fromEmail: input.fromEmail,
      draftId: input.draftId,
      confirmStaleDraft: input.confirmStaleDraft,
      replyToMessageId: input.replyToMessageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      scheduleAt: input.scheduleAt,
      draftApproval: input.draftApproval ?? input.approval,
    };
  });

export type SendInput = z.infer<typeof sendInput>;

/** ParsedMessage wire shape returned by mail.get (matches FE IGetThreadResponse.messages). */
export interface ParsedMessageWire extends ParsedMessage {
  id: string;
  title: string;
  subject: string;
  tags: { id: string; name: string; type: string }[];
  sender: { name?: string; email: string };
  to: { name?: string; email: string }[];
  cc: { name?: string; email: string }[] | null;
  bcc: { name?: string; email: string }[] | null;
  tls: boolean;
  receivedOn: string;
  unread: boolean;
  body: string;
  processedHtml: string;
  blobUrl: string;
  decodedBody?: string;
  references?: string;
  inReplyTo?: string;
  messageId?: string;
  threadId?: string;
  attachments?: {
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
    body: string;
    headers: { name: string | null; value: string | null }[];
  }[];
  isDraft?: boolean;
  debugHeaders?: MailDebugHeaderLine[];
}

/** Extract bare email from `Name <addr>` or return trimmed input. */
export function parseFromEmail(display: string): string {
  const trimmed = display.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  if (angle) return angle[1]!.trim();
  return trimmed;
}

export function coerceRecipientEmails(
  recipients: Array<string | { email: string; name?: string }>,
): string[] {
  return recipients.map((r) => (typeof r === 'string' ? r : r.email));
}

/** Comma-separated recipient string from FE draft composers → address list. */
export function splitAddresses(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(',')
    .map((part) => part.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);
}

/** FE drafts.create payload — email-composer.tsx / mailto-handler.ts. */
export const createDraftInput = z
  .object({
    to: z.string().optional().default(''),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().default(''),
    message: z.string().optional(),
    body: z.string().optional(),
    attachments: z.array(serializedAttachmentInput).optional().default([]),
    id: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
    fromEmail: z.string().nullable().optional(),
    replyToMessageId: z.string().nullable().optional(),
  })
  .transform((input) => ({
    to: splitAddresses(input.to ?? ''),
    cc: splitAddresses(input.cc ?? ''),
    bcc: splitAddresses(input.bcc ?? ''),
    subject: input.subject,
    html: input.message ?? input.body ?? '',
    attachments: input.attachments,
    id: input.id ?? null,
    threadId: input.threadId ?? null,
    fromEmail: input.fromEmail ?? null,
    replyToMessageId: input.replyToMessageId ?? null,
  }));

export type CreateDraftInput = z.infer<typeof createDraftInput>;

function parseAddress(address: string): { name?: string; email: string } {
  const trimmed = address.trim();
  const angle = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angle) {
    const name = angle[1]!.trim().replace(/^["']|["']$/g, '');
    const email = angle[2]!.trim();
    return name ? { name, email } : { email };
  }
  const local = trimmed.split('@')[0];
  return local ? { name: local, email: trimmed } : { email: trimmed };
}

function parseAddressList(addresses: string[]): { name?: string; email: string }[] {
  return addresses.map((addr) => parseAddress(addr));
}

function plainTextToDisplayHtml(text: string): string {
  if (!text) return text;
  const escaped = text
    .replace(/\r\n?/g, '\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<div>${escaped.replaceAll('\n', '<br />')}</div>`;
}

/** Map a DB message row (+ optional attachment metadata) to FE ParsedMessage. */
export function toParsedMessage(
  row: MessageRow,
  attachments: AttachmentMeta[] = [],
): ParsedMessageWire {
  const bodyText = row.textBody ?? '';
  const rawHtml = row.htmlBody?.trim() ? row.htmlBody : plainTextToDisplayHtml(bodyText);
  // XSS strip only — remotes kept; render trust gate lives in processEmailContent.
  const sanitized =
    rawHtml && rawHtml.includes('<')
      ? sanitizeEmailHtml(rawHtml, { shouldLoadImages: true }).html
      : rawHtml;
  const decodedBody = sanitized || bodyText;
  const receivedOn = row.receivedAt
    ? row.receivedAt.toISOString()
    : row.sentAt
      ? row.sentAt.toISOString()
      : '';

  return {
    id: row.id,
    title: row.subject ?? '',
    subject: row.subject ?? '',
    tags: [],
    sender: parseAddress(row.fromAddress),
    to: parseAddressList(row.toAddresses ?? []),
    cc: (row.ccAddresses?.length ?? 0) > 0 ? parseAddressList(row.ccAddresses!) : null,
    bcc: (row.bccAddresses?.length ?? 0) > 0 ? parseAddressList(row.bccAddresses!) : null,
    tls: true,
    receivedOn,
    unread: !row.isRead,
    body: bodyText || sanitized,
    processedHtml: sanitized,
    blobUrl: '',
    decodedBody,
    threadId: row.threadId,
    messageId: row.messageIdHeader ?? undefined,
    inReplyTo: row.inReplyTo ?? undefined,
    references: row.references && row.references.length > 0 ? row.references.join(' ') : undefined,
    isDraft: false,
    attachments: attachments.map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      body: '',
      headers: [],
    })),
  };
}

export function buildMetadataDebugHeaders(
  row: Pick<
    MessageRow,
    'direction' | 'ownerHeaderValue' | 'messageIdHeader' | 'inReplyTo' | 'references'
  >,
  transportEmail: string,
): MailDebugHeaderLine[] {
  const xZeroMailbox =
    row.direction === 'outbound' ? transportEmail : (row.ownerHeaderValue ?? '(missing)');

  const lines: MailDebugHeaderLine[] = [
    { key: 'x-zero-mailbox', line: `X-Zero-Mailbox: ${xZeroMailbox}` },
  ];

  if (row.messageIdHeader) {
    lines.push({ key: 'message-id', line: `Message-ID: ${row.messageIdHeader}` });
  }
  if (row.inReplyTo) {
    lines.push({ key: 'in-reply-to', line: `In-Reply-To: ${row.inReplyTo}` });
  }
  if (row.references?.length) {
    lines.push({ key: 'references', line: `References: ${row.references.join(' ')}` });
  }

  return lines;
}
