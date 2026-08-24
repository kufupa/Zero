/**
 * Authenticated HTTP handler for CID-projected inline attachment bytes.
 *
 * Mounted at GET /api/mail/messages/:messageId/attachments/:attachmentId/inline
 * — cookie session required; mailbox access via join (no active-transport header).
 */
import {
  assertSafeInlineRaster,
  InlineImageTooLargeError,
  MAX_INLINE_IMAGE_BYTES,
} from '../mail/safe-inline-image.js';
import { findUniqueEligibleInlineAttachment, type CidAttachmentMeta } from '../mail/cid-images.js';
import { attachment, mailboxAccess, message } from '../db/schema/mail.js';
import { getS3Storage, S3ObjectTooLargeError } from '../storage/s3.js';
import type { Auth } from '../lib/auth.js';
import type { DB } from '../db/client.js';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../db/client.js';

export type InlineAttachmentMeta = CidAttachmentMeta & {
  s3Key: string;
  siblingAttachments: CidAttachmentMeta[];
};

export type InlineAttachmentDeps = {
  getSession: (req: Request) => Promise<{ user: { id: string } } | null>;
  loadAuthorizedAttachment: (args: {
    userId: string;
    messageId: string;
    attachmentId: string;
  }) => Promise<InlineAttachmentMeta | null>;
  getObjectBounded: (
    key: string,
    maxBytes: number,
  ) => Promise<{ body: Buffer; contentType?: string } | null>;
};

/**
 * Load attachment only when path messageId owns attachmentId AND session user
 * has mailbox_access on the message's transport. No active-transport header.
 */
export async function loadAuthorizedAttachment(
  db: DB,
  args: { userId: string; messageId: string; attachmentId: string },
): Promise<InlineAttachmentMeta | null> {
  const rows = await db
    .select({
      attachmentId: attachment.id,
      s3Key: attachment.s3Key,
      contentId: attachment.contentId,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      isInline: attachment.isInline,
    })
    .from(attachment)
    .innerJoin(message, eq(attachment.messageId, message.id))
    .innerJoin(mailboxAccess, eq(mailboxAccess.transportId, message.transportId))
    .where(
      and(
        eq(attachment.id, args.attachmentId),
        eq(attachment.messageId, args.messageId),
        eq(mailboxAccess.userId, args.userId),
      ),
    )
    .limit(1);
  const target = rows[0];
  if (!target) return null;

  const siblingAttachments = await db
    .select({
      attachmentId: attachment.id,
      contentId: attachment.contentId,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      isInline: attachment.isInline,
    })
    .from(attachment)
    .where(and(eq(attachment.messageId, args.messageId), ne(attachment.id, args.attachmentId)));

  return { ...target, siblingAttachments };
}

function opaque(status: number): Response {
  return new Response(null, { status });
}

export function createInlineAttachmentHandler(deps: InlineAttachmentDeps) {
  return async (
    req: Request,
    params: { messageId: string; attachmentId: string },
  ): Promise<Response> => {
    try {
      const session = await deps.getSession(req);
      if (!session?.user?.id) {
        return opaque(401);
      }

      const meta = await deps.loadAuthorizedAttachment({
        userId: session.user.id,
        messageId: params.messageId,
        attachmentId: params.attachmentId,
      });
      if (!meta) {
        return opaque(404);
      }

      const eligible = findUniqueEligibleInlineAttachment(meta.contentId, [
        meta,
        ...meta.siblingAttachments,
      ]);
      if (!eligible || eligible.attachmentId !== meta.attachmentId) {
        return opaque(404);
      }

      let obj: { body: Buffer; contentType?: string } | null;
      try {
        obj = await deps.getObjectBounded(meta.s3Key, MAX_INLINE_IMAGE_BYTES);
      } catch (error) {
        if (error instanceof S3ObjectTooLargeError) {
          return opaque(413);
        }
        return opaque(500);
      }
      if (!obj) {
        return opaque(404);
      }

      try {
        assertSafeInlineRaster(obj.body, meta.mimeType);
      } catch (error) {
        if (error instanceof InlineImageTooLargeError) {
          return opaque(413);
        }
        return opaque(415);
      }

      return new Response(obj.body, {
        status: 200,
        headers: {
          'Content-Type': meta.mimeType,
          'Content-Length': String(obj.body.length),
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=300',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return opaque(500);
    }
  };
}

/** Wire real auth / DB / S3 for production mount. */
export function createWiredInlineAttachmentHandler(auth: Auth) {
  return createInlineAttachmentHandler({
    getSession: async (req) => {
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session?.user?.id) return null;
      return { user: { id: session.user.id } };
    },
    loadAuthorizedAttachment: (args) => loadAuthorizedAttachment(getDb(), args),
    getObjectBounded: (key, maxBytes) => getS3Storage().getObjectBounded(key, maxBytes),
  });
}
