import { sanitizeHtmlBodyForStorage } from '../../mail/sanitize-email-html.js';
import type { ReservationistStaffAction } from './drafts.js';
import type { mailDraft } from '../../db/schema/mail.js';
import { createHash } from 'node:crypto';

export function toDraftWire(
  r: typeof mailDraft.$inferSelect,
  isStale = false,
  reviewSummary?: {
    readinessLabel: string;
    reason: string;
    tasks: { id: string; kind: string; label: string; state: string; details?: string[] }[];
    pricingProof: string[];
    staffActions?: ReservationistStaffAction[];
  },
) {
  return {
    id: r.id,
    revisionKey: createHash('sha256')
      .update(
        JSON.stringify({
          id: r.id,
          generation: r.generationId,
          attachments: r.attachments,
          updatedAt: r.updatedAt.toISOString(),
        }),
      )
      .digest('hex'),
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
    ...(reviewSummary ? { reviewSummary } : {}),
    attachments: r.attachments.map((item) => {
      const generated = item as typeof item & { artifactRef?: string; sourceHash?: string };
      return {
        artifactRef: generated.artifactRef ?? null,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        sourceHash: generated.sourceHash ?? null,
        state:
          generated.artifactRef && generated.sourceHash
            ? ('available' as const)
            : ('missing' as const),
      };
    }),
  };
}
