/**
 * Unit tests for the authenticated inline attachment HTTP handler.
 * Deps are injected — no real Better Auth / DB / S3.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInlineAttachmentHandler,
  createWiredInlineAttachmentHandler,
} from '../src/http/inline-attachment.js';

/** Minimal 1×1 GIF89a (logical screen descriptor). */
const GIF89A = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00', 'binary');

describe('inline attachment route', () => {
  it.each([
    'https://nava.legacyhotels.co.za',
    'https://nava-admin.trynava.io',
  ])('forwards same-origin cookie to wired session auth for %s', async (origin) => {
    const getSession = vi.fn(async (_input: { headers: Headers }) => null);
    const handler = createWiredInlineAttachmentHandler({
      api: { getSession },
    } as never);
    const request = new Request(
      `${origin}/api/mail/messages/m1/attachments/a1/inline`,
      {
        headers: { cookie: 'better-auth.session_token=host-scoped-session' },
      },
    );

    const res = await handler(request, { messageId: 'm1', attachmentId: 'a1' });

    expect(res.status).toBe(401);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession.mock.calls[0]?.[0]?.headers.get('cookie')).toBe(
      'better-auth.session_token=host-scoped-session',
    );
  });

  it('returns 401 without session', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => null,
      loadAuthorizedAttachment: async () => null,
      getObjectBounded: async () => null,
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 bytes for authorized gif', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => ({
        s3Key: 'attachments/m1/000-x.gif',
        mimeType: 'image/gif',
        sizeBytes: GIF89A.length,
      }),
      getObjectBounded: async () => ({ body: GIF89A, contentType: 'image/gif' }),
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
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
      loadAuthorizedAttachment: async () => ({
        s3Key: 'attachments/m1/000-x.pdf',
        mimeType: 'image/gif',
        sizeBytes: pdfBytes.length,
      }),
      getObjectBounded: async () => ({ body: pdfBytes, contentType: 'application/pdf' }),
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(415);
  });

  it('returns 413 when metadata sizeBytes exceeds max', async () => {
    const getObjectBounded = vi.fn();
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => ({
        s3Key: 'attachments/m1/000-huge.gif',
        mimeType: 'image/gif',
        sizeBytes: 5 * 1024 * 1024 + 1,
      }),
      getObjectBounded,
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(413);
    expect(getObjectBounded).not.toHaveBeenCalled();
  });

  it('returns 404 when S3 object missing', async () => {
    const handler = createInlineAttachmentHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      loadAuthorizedAttachment: async () => ({
        s3Key: 'attachments/m1/000-missing.gif',
        mimeType: 'image/gif',
        sizeBytes: GIF89A.length,
      }),
      getObjectBounded: async () => null,
    });
    const res = await handler(
      new Request('http://x/api/mail/messages/m1/attachments/a1/inline'),
      { messageId: 'm1', attachmentId: 'a1' },
    );
    expect(res.status).toBe(404);
  });
});
