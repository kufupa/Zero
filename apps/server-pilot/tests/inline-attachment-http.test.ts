import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createInlineAttachmentHandler,
  type InlineAttachmentHandlerDependencies,
} from '../src/http/inline-attachment.js';
import { MAX_INLINE_IMAGE_BYTES } from '../src/mail/safe-inline-image.js';
import { S3ObjectTooLargeError } from '../src/storage/s3.js';

const ROUTE =
  '/api/mail/messages/:messageId/attachments/:attachmentId/inline';
const URL =
  '/api/mail/messages/msg-1/attachments/att-1/inline';

function png(width = 1, height = 1): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
  );
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

const validAttachment = {
  id: 'att-1',
  messageId: 'msg-1',
  filename: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 33,
  s3Key: 'attachments/msg-1/000-photo.png',
};

type FixtureOptions = {
  session?: { user: { id: string } } | null;
  attachment?: typeof validAttachment | null;
  body?: Buffer | null;
  storageError?: Error;
};

function fixture(options: FixtureOptions = {}) {
  const getSession = vi.fn(async () =>
    options.session === undefined
      ? { user: { id: 'user-1' } }
      : options.session,
  );
  const findAuthorizedAttachment = vi.fn(async () =>
    options.attachment === undefined
      ? validAttachment
      : options.attachment,
  );
  const getObjectBounded = vi.fn(async () => {
    if (options.storageError) throw options.storageError;
    if (options.body === null) return null;
    return {
      body: options.body ?? png(),
      contentType: 'image/png',
    };
  });

  const dependencies: InlineAttachmentHandlerDependencies = {
    auth: { getSession },
    db: { findAuthorizedAttachment },
    storage: { getObjectBounded },
  };
  const app = new Hono();
  app.get(ROUTE, createInlineAttachmentHandler(dependencies));

  return {
    request: (headers?: HeadersInit) =>
      app.request(URL, { headers }),
    getSession,
    findAuthorizedAttachment,
    getObjectBounded,
  };
}

describe('inline attachment HTTP handler', () => {
  it('returns 401 before DB or storage access when session is missing', async () => {
    const test = fixture({ session: null });

    const response = await test.request();

    expect(response.status).toBe(401);
    expect(test.findAuthorizedAttachment).not.toHaveBeenCalled();
    expect(test.getObjectBounded).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'inaccessible', 'cross-message'])(
    'returns indistinguishable 404 for %s attachment',
    async () => {
      const test = fixture({ attachment: null });

      const response = await test.request({
        cookie: 'better-auth.session_token=opaque',
      });

      expect(response.status).toBe(404);
      expect(test.findAuthorizedAttachment).toHaveBeenCalledWith({
        userId: 'user-1',
        messageId: 'msg-1',
        attachmentId: 'att-1',
      });
      expect(test.getObjectBounded).not.toHaveBeenCalled();
      expect(test.getSession.mock.calls[0]?.[0].get('cookie')).toBe(
        'better-auth.session_token=opaque',
      );
    },
  );

  it('rejects disallowed metadata MIME before storage access', async () => {
    const test = fixture({
      attachment: {
        ...validAttachment,
        mimeType: 'image/svg+xml',
      },
    });

    const response = await test.request();

    expect(response.status).toBe(415);
    expect(test.getObjectBounded).not.toHaveBeenCalled();
  });

  it('rejects oversized metadata before storage access', async () => {
    const test = fixture({
      attachment: {
        ...validAttachment,
        sizeBytes: MAX_INLINE_IMAGE_BYTES + 1,
      },
    });

    const response = await test.request();

    expect(response.status).toBe(413);
    expect(test.getObjectBounded).not.toHaveBeenCalled();
  });

  it('returns 413 when bounded storage detects an oversized body', async () => {
    const test = fixture({
      storageError: new S3ObjectTooLargeError(
        MAX_INLINE_IMAGE_BYTES,
        MAX_INLINE_IMAGE_BYTES + 1,
      ),
    });

    const response = await test.request();

    expect(response.status).toBe(413);
  });

  it('returns 413 when storage violates its bound with an oversized body', async () => {
    const body = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
    png().copy(body);
    const test = fixture({ body });

    const response = await test.request();

    expect(response.status).toBe(413);
  });

  it.each([
    ['missing', null],
    ['expired', new Error('storage object expired')],
  ] as const)(
    'returns 404 for %s storage object',
    async (_label, storageResult) => {
      const test =
        storageResult instanceof Error
          ? fixture({ storageError: storageResult })
          : fixture({ body: storageResult });

      const response = await test.request();

      expect(response.status).toBe(404);
    },
  );

  it('returns 415 for metadata and raster signature mismatch', async () => {
    const test = fixture({ body: Buffer.from('not a png') });

    const response = await test.request();

    expect(response.status).toBe(415);
  });

  it('returns 415 for unsafe raster dimensions', async () => {
    const test = fixture({ body: png(10_001, 1) });

    const response = await test.request();

    expect(response.status).toBe(415);
  });

  it('returns exact authorized bytes with safe private inline headers', async () => {
    const body = png(2, 3);
    const test = fixture({
      attachment: {
        ...validAttachment,
        filename: 'evil"\r\n.png',
        mimeType: ' IMAGE/PNG; charset=binary ',
        sizeBytes: body.byteLength,
      },
      body,
    });

    const response = await test.request();

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe(
      'inline; filename="evil.png"',
    );
    expect(response.headers.get('content-length')).toBe(
      String(body.byteLength),
    );
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=300',
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(test.getObjectBounded).toHaveBeenCalledWith(
      validAttachment.s3Key,
      MAX_INLINE_IMAGE_BYTES,
    );
    expect(test.getSession.mock.calls[0]?.[0].has(
      'x-zero-active-transport',
    )).toBe(false);
  });
});
