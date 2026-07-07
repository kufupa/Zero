import type { mailDraft } from '../../db/schema/mail.js';
import { sanitizeHtmlBodyForStorage } from '../../mail/sanitize-email-html.js';

export function toDraftWire(r: typeof mailDraft.$inferSelect, isStale = false) {
  return {
    id: r.id,
    threadId: r.threadId,
    replyToMessageId: r.replyToMessageId,
    to: r.toAddresses,
    cc: r.ccAddresses,
    bcc: r.bccAddresses,
    subject: r.subject,
    content: r.textBody ?? sanitizeHtmlBodyForStorage(r.htmlBody),
    updatedAt: r.updatedAt.toISOString(),
    status: r.status,
    origin: r.origin,
    generationId: r.generationId,
    isStale,
  };
}
