/**
 * Unit tests for the authenticated inline attachment HTTP handler.
 * Deps are injected — no real Better Auth / DB / S3.
 */
import {
  createInlineAttachmentHandler,
  createWiredInlineAttachmentHandler,
} from '../src/http/inline-attachment.js';
import { MAX_INLINE_IMAGE_BYTES } from '../src/mail/safe-inline-image.js';
import { S3ObjectTooLargeError } from '../src/storage/s3.js';
import { describe, expect, it, vi } from 'vitest';

/** Minimal 1×1 GIF89a (logical screen descriptor). */
const GIF89A = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00', 'binary');

type TestCidAttachment = {
  attachmentId: string;
  contentId: string | null;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
};

type TestInlineAttachmentMeta = TestCidAttachment & {
  s3Key: string;
  siblingAttachments: TestCidAttachment[];
};

function inlineMeta(overrides: Partial<TestInlineAttachmentMeta> = {}): TestInlineAttachmentMeta {
  return {
    attachmentId: 'a1',
    s3Key: 'attachments/m1/000-banner.gif',
    contentId: '<banner@rocketseed.test>',
    mimeType: 'image/gif',
    sizeBytes: GIF89A.length,
    isInline: true,
    siblingAttachments: [],
    ...overrides,
  };
}

describe('inline attachment route', () => {
  it.each(['https://nava.legacyhotels.co.za', 'https://nava-admin.trynava.io'])(
    'forwards same-origin cookie to wired session auth for %s',
    async (origin) => {
      const getSession = vi.fn(async (_input: { headers: Headers }) => null);
      const handler = createWiredInlineAttachmentHandler({
        api: { getSession },
      } as never);
      const request = new Request(`${origin}/api/mail/messages/m1/attachments/a1/inline`, {
        headers: { cookie: 'better-auth.session_token=host-scoped-session' },
      });

      const res = await handler(request, { messageId: 'm1', attachmentId: 'a1' });

      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(getSession.mock.calls[0]?.[0]?.headers.get('cookie')).toBe(
        'better-auth.session_token=host-scoped-session',
      );
    },
  );

  it('returns 401 without session', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => null,
      loadAuthorizedAttachment: async () => null,
      getObjectBounded: async () => null,
    });
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('returns 200 bytes for authorized gif', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => inlineMeta(),
      getObjectBounded: async () => ({ body: GIF89A, contentType: 'image/gif' }),
    });
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/gif');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Length')).toBe(String(GIF89A.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(GIF89A);
  });

  it('returns 404 for cross-mailbox (unauthorized attachment)', async () => {
    const loadAuthorizedAttachment = vi.fn(async () => null);
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u-frontdesk' } }),
      loadAuthorizedAttachment,
      getObjectBounded: async () => ({ body: GIF89A, contentType: 'image/gif' }),
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/msg-centurion/attachments/att-c1/inline'),
      { messageId: 'msg-centurion', attachmentId: 'att-c1' },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(loadAuthorizedAttachment).toHaveBeenCalledWith({
      userId: 'u-frontdesk',
      messageId: 'msg-centurion',
      attachmentId: 'att-c1',
    });
  });

  it('returns 415 for bad magic / MIME mismatch', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake');
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () =>
        inlineMeta({
          s3Key: 'attachments/m1/000-x.pdf',
          mimeType: 'image/gif',
          sizeBytes: pdfBytes.length,
        }),
      getObjectBounded: async () => ({ body: pdfBytes, contentType: 'application/pdf' }),
    });
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(res.status).toBe(415);
    expect(await res.text()).toBe('');
  });

  const ineligibleMetadata: Array<[string, Partial<TestInlineAttachmentMeta>]> = [
    ['non-raster MIME', { mimeType: 'image/svg+xml' }],
    ['zero size', { sizeBytes: 0 }],
    ['fractional size', { sizeBytes: 1.5 }],
    ['unsafe integer size', { sizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['oversized size', { sizeBytes: MAX_INLINE_IMAGE_BYTES + 1 }],
  ];

  it.each(ineligibleMetadata)('returns opaque 404 before storage for $0', async (_label, patch) => {
    const getObjectBounded = vi.fn();
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => inlineMeta(patch),
      getObjectBounded,
    });
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(getObjectBounded).not.toHaveBeenCalled();
  });

  it('returns 404 when S3 object missing', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => inlineMeta({ s3Key: 'attachments/m1/000-missing.gif' }),
      getObjectBounded: async () => null,
    });
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('returns opaque 404 before storage for non-inline metadata', async () => {
    const getObjectBounded = vi.fn();
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () =>
        inlineMeta({
          s3Key: 'attachments/m1/ordinary.gif',
          isInline: false,
        }),
      getObjectBounded,
    });

    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(getObjectBounded).not.toHaveBeenCalled();
  });

  it.each([
    [
      'duplicate normalized CID',
      inlineMeta({
        siblingAttachments: [
          {
            attachmentId: 'a2',
            contentId: 'CID:banner%40rocketseed.test',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            isInline: false,
          },
        ],
      }),
    ],
    ['null CID', inlineMeta({ contentId: null })],
    ['empty CID', inlineMeta({ contentId: ' < > ' })],
    ['malformed CID', inlineMeta({ contentId: 'cid:../../etc/passwd' })],
  ])('returns opaque 404 before storage for $0', async (_label, meta) => {
    const getObjectBounded = vi.fn();
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => meta,
      getObjectBounded,
    });

    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(getObjectBounded).not.toHaveBeenCalled();
  });

  it('returns opaque 413 when bounded storage rejects an oversized object', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => inlineMeta({ s3Key: 'attachments/m1/oversized.gif' }),
      getObjectBounded: async () => {
        throw new S3ObjectTooLargeError(5 * 1024 * 1024, 5 * 1024 * 1024 + 1);
      },
    });

    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('');
  });

  it.each([
    {
      label: 'session lookup fails',
      deps: {
        getSession: async () => {
          throw new Error('synthetic session failure');
        },
        loadAuthorizedAttachment: async () => null,
        getObjectBounded: async () => null,
      },
    },
    {
      label: 'attachment lookup fails',
      deps: {
        getSession: async () => ({ user: { id: 'u1' } }),
        loadAuthorizedAttachment: async () => {
          throw new Error('synthetic lookup failure');
        },
        getObjectBounded: async () => null,
      },
    },
    {
      label: 'object storage fails',
      deps: {
        getSession: async () => ({ user: { id: 'u1' } }),
        loadAuthorizedAttachment: async () => inlineMeta({ s3Key: 'attachments/m1/failure.gif' }),
        getObjectBounded: async () => {
          throw new Error('synthetic storage failure');
        },
      },
    },
  ])('returns opaque 500 when $label', async ({ deps }) => {
    const handler = createInlineAttachmentHandler(deps);
    const res = await handler(new Request('http://x/api/mail/messages/m1/attachments/a1/inline'), {
      messageId: 'm1',
      attachmentId: 'a1',
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('');
  });
});
