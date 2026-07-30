import {
  generateMessageId,
  parseRawMessage,
  type ParsedAttachment,
} from '../src/mail/ingest/parse-message.js';
import { BLOCKED_IMAGE_PLACEHOLDER, sanitizeEmailHtml } from '../src/mail/sanitize-email-html.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { createInlineAttachmentHandler } from '../src/http/inline-attachment.js';
import { assertSafeInlineRaster } from '../src/mail/safe-inline-image.js';
import { projectCidImages } from '../src/mail/cid-images.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readFixture } from './helpers/fixtures.js';
import { load } from 'cheerio';
import { Hono } from 'hono';

const FIXTURE_NAME = 'rocketseed-branded-sent-copy.eml';
const MESSAGE_ID = 'a0b1c2d3-e4f5-4a67-8b90-abcdef123456';
const INLINE_ORIGIN = 'https://mail.example.invalid';
const REMOTE_TRACKER = 'https://tracker.example.invalid/open.gif';
const INLINE_ROUTE = '/api/mail/messages/:messageId/attachments/:attachmentId/inline';

async function parseFixture(): Promise<{
  parsed: Awaited<ReturnType<typeof parseRawMessage>>;
  storage: FakeS3Storage;
}> {
  const storage = new FakeS3Storage('synthetic-rocketseed-fixture');
  resetS3Storage();
  setS3Storage(storage);
  const parsed = await parseRawMessage(readFixture(FIXTURE_NAME), {
    messageId: generateMessageId(),
    storage,
  });
  return { parsed, storage };
}

function imageAttachments(attachments: readonly ParsedAttachment[]): ParsedAttachment[] {
  return attachments.filter((part) => part.mimeType.startsWith('image/'));
}

afterEach(() => {
  resetS3Storage();
});

describe('Rocketseed network-free fixture flow', () => {
  it('parses representative branded MIME with valid CID rasters and PDF', async () => {
    const { parsed, storage } = await parseFixture();

    expect(parsed.ownerHeaderValue).toBe('sender@hotel.example.invalid');
    expect(parsed.outboundMessageId).toBe(MESSAGE_ID);
    expect(parsed.htmlBody).toContain('Rocketseed synthetic marker');
    expect(parsed.htmlBody).toContain('cid:image-banner@localhost');
    expect(parsed.htmlBody).toContain('cid:image-footer@localhost');
    expect(parsed.htmlBody).toContain(REMOTE_TRACKER);
    expect(parsed.attachments).toHaveLength(3);

    const images = imageAttachments(parsed.attachments);
    expect(images).toEqual([
      expect.objectContaining({
        filename: 'synthetic-banner.png',
        mimeType: 'image/png',
        contentId: 'image-banner@localhost',
        isInline: true,
      }),
      expect.objectContaining({
        filename: 'synthetic-footer.jpg',
        mimeType: 'image/jpeg',
        contentId: 'image-footer@localhost',
        isInline: true,
      }),
    ]);
    for (const image of images) {
      const stored = storage.stored.get(image.s3Key);
      expect(stored).toBeDefined();
      expect(() => assertSafeInlineRaster(stored!.body, image.mimeType)).not.toThrow();
    }

    const pdf = parsed.attachments.find((part) => part.mimeType === 'application/pdf');
    expect(pdf).toMatchObject({
      filename: 'synthetic-itinerary.pdf',
      contentId: null,
      isInline: false,
    });
    expect(storage.stored.get(pdf!.s3Key)?.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('projects CID routes, blocks tracker, serves authorized bytes, and hides foreign access', async () => {
    const { parsed, storage } = await parseFixture();
    const images = imageAttachments(parsed.attachments);
    const attachmentById = new Map<string, ParsedAttachment>(
      images.map((part, index) => [`inline-${index + 1}`, part] as const),
    );
    const sanitized = sanitizeEmailHtml(parsed.htmlBody ?? '', {
      shouldLoadImages: false,
    });
    const projected = projectCidImages(
      sanitized.html,
      [...attachmentById].map(([attachmentId, part]) => ({
        attachmentId,
        contentId: part.contentId,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes,
        isInline: part.isInline,
      })),
      { messageId: MESSAGE_ID, origin: INLINE_ORIGIN },
    );

    expect(sanitized.hasBlockedImages).toBe(true);
    expect(projected.hasBlockedImages).toBe(false);
    expect(projected.html).not.toMatch(/\bcid:/i);
    expect(projected.html).not.toContain(REMOTE_TRACKER);
    expect(projected.html).toContain(BLOCKED_IMAGE_PLACEHOLDER);

    const $ = load(projected.html, null, false);
    const routes = $('img[alt^="Synthetic Rocketseed"]')
      .map((_index, node) => $(node).attr('src'))
      .get();
    expect(routes).toEqual([
      `${INLINE_ORIGIN}/api/mail/messages/${MESSAGE_ID}/attachments/inline-1/inline`,
      `${INLINE_ORIGIN}/api/mail/messages/${MESSAGE_ID}/attachments/inline-2/inline`,
    ]);

    const app = new Hono();
    app.get(
      INLINE_ROUTE,
      createInlineAttachmentHandler({
        auth: {
          getSession: async (headers) => {
            const userId = headers.get('x-synthetic-user');
            return userId ? { user: { id: userId } } : null;
          },
        },
        db: {
          findAuthorizedAttachment: async (input) => {
            if (input.userId !== 'user-authorized' || input.messageId !== MESSAGE_ID) {
              return null;
            }
            const part = attachmentById.get(input.attachmentId);
            return part
              ? {
                  id: input.attachmentId,
                  messageId: MESSAGE_ID,
                  filename: part.filename,
                  mimeType: part.mimeType,
                  sizeBytes: part.sizeBytes,
                  s3Key: part.s3Key,
                }
              : null;
          },
        },
        storage,
      }),
    );

    for (const [index, route] of routes.entries()) {
      const response = await app.request(route!, {
        headers: { 'x-synthetic-user': 'user-authorized' },
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        storage.stored.get(images[index]!.s3Key)?.body,
      );
    }

    const unauthorized = await app.request(routes[0]!, {
      headers: { 'x-synthetic-user': 'user-foreign-mailbox' },
    });
    expect(unauthorized.status).toBe(404);
  });
});
