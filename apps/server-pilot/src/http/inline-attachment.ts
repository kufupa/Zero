import { and, eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { DB } from '../db/client.js';
import {
  attachment,
  mailboxAccess,
  message,
} from '../db/schema/mail.js';
import { formatContentDispositionFilename } from '../mail/attachment-filename.js';
import {
  assertSafeInlineRaster,
  InlineImageTooLargeError,
  MAX_INLINE_IMAGE_BYTES,
} from '../mail/safe-inline-image.js';
import {
  S3ObjectTooLargeError,
  type S3GetResult,
} from '../storage/s3.js';

const ALLOWED_INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type AuthorizedInlineAttachment = {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
};

type AuthorizedAttachmentInput = {
  userId: string;
  messageId: string;
  attachmentId: string;
};

export type InlineAttachmentHandlerDependencies = {
  auth: {
    getSession(
      headers: Headers,
    ): Promise<{ user: { id: string } } | null>;
  };
  db: {
    findAuthorizedAttachment(
      input: AuthorizedAttachmentInput,
    ): Promise<AuthorizedInlineAttachment | null>;
  };
  storage: {
    getObjectBounded(
      key: string,
      maxBytes: number,
    ): Promise<S3GetResult | null>;
  };
};

function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function inlineContentDisposition(filename: string): string {
  const attachmentDisposition = formatContentDispositionFilename(filename);
  return `inline${attachmentDisposition.slice('attachment'.length)}`;
}

function emptyResponse(
  c: Parameters<Handler>[0],
  status: 401 | 404 | 413 | 415,
): Response {
  return c.body(null, status);
}

export function createInlineAttachmentHandler(
  dependencies: InlineAttachmentHandlerDependencies,
): Handler {
  return async (c) => {
    let session: { user: { id: string } } | null;
    try {
      session = await dependencies.auth.getSession(c.req.raw.headers);
    } catch {
      return emptyResponse(c, 401);
    }
    if (!session?.user.id) return emptyResponse(c, 401);

    const messageId = c.req.param('messageId');
    const attachmentId = c.req.param('attachmentId');
    let record: AuthorizedInlineAttachment | null;
    try {
      record = await dependencies.db.findAuthorizedAttachment({
        userId: session.user.id,
        messageId,
        attachmentId,
      });
    } catch {
      return emptyResponse(c, 404);
    }
    if (!record) return emptyResponse(c, 404);

    const mimeType = normalizeMimeType(record.mimeType);
    if (!ALLOWED_INLINE_MIME_TYPES.has(mimeType)) {
      return emptyResponse(c, 415);
    }
    if (
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < 0
    ) {
      return emptyResponse(c, 415);
    }
    if (record.sizeBytes > MAX_INLINE_IMAGE_BYTES) {
      return emptyResponse(c, 413);
    }

    let object: S3GetResult | null;
    try {
      object = await dependencies.storage.getObjectBounded(
        record.s3Key,
        MAX_INLINE_IMAGE_BYTES,
      );
    } catch (error) {
      if (error instanceof S3ObjectTooLargeError) {
        return emptyResponse(c, 413);
      }
      return emptyResponse(c, 404);
    }
    if (!object) return emptyResponse(c, 404);
    if (object.body.byteLength > MAX_INLINE_IMAGE_BYTES) {
      return emptyResponse(c, 413);
    }

    try {
      assertSafeInlineRaster(object.body, mimeType);
    } catch (error) {
      if (error instanceof InlineImageTooLargeError) {
        return emptyResponse(c, 413);
      }
      return emptyResponse(c, 415);
    }

    c.header('Content-Type', mimeType);
    c.header(
      'Content-Disposition',
      inlineContentDisposition(record.filename),
    );
    c.header('Content-Length', String(object.body.byteLength));
    c.header('Cache-Control', 'private, max-age=300');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(object.body);
  };
}

export async function findAuthorizedInlineAttachment(
  db: DB,
  input: AuthorizedAttachmentInput,
): Promise<AuthorizedInlineAttachment | null> {
  const rows = await db
    .select({
      id: attachment.id,
      messageId: attachment.messageId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      s3Key: attachment.s3Key,
    })
    .from(attachment)
    .innerJoin(message, eq(attachment.messageId, message.id))
    .innerJoin(
      mailboxAccess,
      and(
        eq(mailboxAccess.transportId, message.transportId),
        eq(mailboxAccess.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(attachment.id, input.attachmentId),
        eq(attachment.messageId, input.messageId),
        eq(message.id, input.messageId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
