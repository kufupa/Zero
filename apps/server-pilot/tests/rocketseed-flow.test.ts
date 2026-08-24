import { createInlineAttachmentHandler } from '../src/http/inline-attachment.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';
import { processEmailHtmlForDisplay } from '../src/mail/process-email-html.js';
import { MAX_INLINE_IMAGE_BYTES } from '../src/mail/safe-inline-image.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { projectCidImages } from '../src/mail/cid-images.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { readFixture } from './helpers/fixtures.js';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://mail.zero.test';
const MESSAGE_ID = 'synthetic-message-1';
const INLINE_CID = 'banner@rocketseed.test';

describe('synthetic Rocketseed MIME flow', () => {
  it('parses, sanitizes, projects, and serves only an explicit-inline raster CID', async () => {
    const storage = new FakeS3Storage('synthetic-rocketseed');
    const parsed = await parseRawMessage(readFixture('rocketseed-task-4-related.eml'), {
      messageId: MESSAGE_ID,
      storage,
    });
    const banner = parsed.attachments.find((attachment) => attachment.contentId === INLINE_CID);
    const ordinary = parsed.attachments.find(
      (attachment) => attachment.contentId === 'ordinary@rocketseed.test',
    );

    expect(banner).toMatchObject({
      mimeType: 'image/gif',
      isInline: true,
    });
    expect(ordinary).toMatchObject({
      mimeType: 'application/pdf',
      isInline: false,
    });

    const display = processEmailHtmlForDisplay({
      html: parsed.htmlBody ?? '',
      messageId: MESSAGE_ID,
      shouldLoadImages: false,
      theme: 'light',
      origin: ORIGIN,
      attachments: parsed.attachments.map((attachment) => ({
        attachmentId: attachment.s3Key,
        contentId: attachment.contentId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        isInline: attachment.isInline,
      })),
    });

    expect(display.processedHtml).toContain(
      `${ORIGIN}/api/mail/messages/${MESSAGE_ID}/attachments/${encodeURIComponent(banner!.s3Key)}/inline`,
    );
    expect(display.processedHtml).not.toContain('tracker.invalid');
    expect(display.processedHtml).not.toContain('data:image/png;base64,AA==');
    expect(display.processedHtml).toContain(BLOCKED_IMAGE_PLACEHOLDER);
    expect(display.processedHtml).not.toContain('href="cid:banner@rocketseed.test"');

    const handler = createInlineAttachmentHandler({
      getSession: async (request) => {
        const userId = request.headers.get('x-test-user');
        return userId ? { user: { id: userId } } : null;
      },
      loadAuthorizedAttachment: async ({ userId, attachmentId }) => {
        if (userId !== 'allowed' || attachmentId !== banner!.s3Key) return null;
        return {
          s3Key: banner!.s3Key,
          mimeType: banner!.mimeType,
          sizeBytes: banner!.sizeBytes,
          isInline: banner!.isInline,
        };
      },
      getObjectBounded: (key, maxBytes) => storage.getObjectBounded(key, maxBytes),
    });

    const allowed = await handler(
      new Request(`${ORIGIN}/api/mail/messages/${MESSAGE_ID}/attachments/${banner!.s3Key}/inline`, {
        headers: { 'x-test-user': 'allowed' },
      }),
      { messageId: MESSAGE_ID, attachmentId: banner!.s3Key },
    );
    expect(allowed.status).toBe(200);
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(
      (await storage.getObject(banner!.s3Key))!.body,
    );

    const denied = await handler(
      new Request(`${ORIGIN}/api/mail/messages/${MESSAGE_ID}/attachments/${banner!.s3Key}/inline`, {
        headers: { 'x-test-user': 'denied' },
      }),
      { messageId: MESSAGE_ID, attachmentId: banner!.s3Key },
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('');
  });

  it.each([
    [
      'non-inline',
      [
        {
          attachmentId: 'banner',
          contentId: INLINE_CID,
          mimeType: 'image/gif',
          sizeBytes: 43,
          isInline: false,
        },
      ],
    ],
    [
      'non-raster',
      [
        {
          attachmentId: 'banner',
          contentId: INLINE_CID,
          mimeType: 'image/svg+xml',
          sizeBytes: 43,
          isInline: true,
        },
      ],
    ],
    [
      'ambiguous',
      [
        {
          attachmentId: 'banner',
          contentId: INLINE_CID,
          mimeType: 'image/gif',
          sizeBytes: 43,
          isInline: true,
        },
        {
          attachmentId: 'ordinary',
          contentId: INLINE_CID,
          mimeType: 'application/pdf',
          sizeBytes: 43,
          isInline: false,
        },
      ],
    ],
    [
      'oversize',
      [
        {
          attachmentId: 'banner',
          contentId: INLINE_CID,
          mimeType: 'image/gif',
          sizeBytes: MAX_INLINE_IMAGE_BYTES + 1,
          isInline: true,
        },
      ],
    ],
  ])('blocks %s synthetic CID metadata', (_caseName, attachments) => {
    const projected = projectCidImages('<img src="cid:banner@rocketseed.test">', attachments, {
      messageId: MESSAGE_ID,
      origin: ORIGIN,
    });

    expect(projected.hasBlockedImages).toBe(true);
    expect(projected.html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(projected.html).not.toContain('/attachments/banner/inline');
  });
});
