import { normalizeContentId, projectCidImages } from '../src/mail/cid-images.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';
import { MAX_INLINE_IMAGE_BYTES } from '../src/mail/safe-inline-image.js';
import { describe, expect, it } from 'vitest';

describe('normalizeContentId', () => {
  it('strips cid:, brackets, and lowercases', () => {
    expect(normalizeContentId('CID:Banner%2Egif@Host')).toBe('banner.gif@host');
    expect(normalizeContentId('<banner001@rocketseed>')).toBe('banner001@rocketseed');
  });

  it('rejects path-like ids', () => {
    expect(normalizeContentId('cid:../../etc/passwd')).toBeNull();
    expect(normalizeContentId('cid:a?b')).toBeNull();
  });
});

describe('projectCidImages', () => {
  const meta = [
    {
      attachmentId: 'att-1',
      contentId: '<banner001@rocketseed>',
      mimeType: 'image/gif',
      sizeBytes: 1200,
      isInline: true,
    },
  ];

  it('rewrites img cid to absolute inline URL', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<p><img alt="b" src="cid:banner001@rocketseed" width="100"></p>',
      meta,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(false);
    expect(html).toContain(
      'src="https://nava.legacy.local/api/mail/messages/msg-1/attachments/att-1/inline"',
    );
    expect(html).toContain('alt="b"');
  });

  it.each(['https://nava.legacyhotels.co.za', 'https://nava-admin.trynava.io'])(
    'keeps CID inline URLs on requesting origin %s',
    (origin) => {
      const { html, hasBlockedImages } = projectCidImages(
        '<img src="cid:banner001@rocketseed">',
        meta,
        { messageId: 'msg-1', origin },
      );

      expect(hasBlockedImages).toBe(false);
      expect(html).toContain(`${origin}/api/mail/messages/msg-1/attachments/att-1/inline`);
    },
  );

  it('placeholders missing cid and does not rewrite anchors', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<a href="cid:banner001@rocketseed">x</a><img src="cid:missing@x" width="650" height="168">',
      meta,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).toContain('href="cid:banner001@rocketseed"');
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).not.toMatch(/\bwidth=/i);
    expect(html).not.toMatch(/\bheight=/i);
  });

  it('blocks ambiguous duplicate content ids', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<img src="cid:dup@x">',
      [
        {
          attachmentId: 'a1',
          contentId: '<dup@x>',
          mimeType: 'image/gif',
          sizeBytes: 10,
          isInline: true,
        },
        {
          attachmentId: 'a2',
          contentId: 'CID:dup@x',
          mimeType: 'image/png',
          sizeBytes: 10,
          isInline: true,
        },
      ],
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).not.toContain('/attachments/a1/inline');
    expect(html).not.toContain('/attachments/a2/inline');
  });

  it('serializes as fragment without html/head/body wrapper', () => {
    const { html } = projectCidImages('<img src="cid:banner001@rocketseed">', meta, {
      messageId: 'msg-1',
      origin: 'https://nava.legacy.local',
    });
    expect(html.toLowerCase()).not.toContain('<html');
    expect(html.toLowerCase()).not.toContain('<head');
    expect(html.toLowerCase()).not.toContain('<body');
  });

  it.each([
    ['not explicitly inline', { isInline: false }],
    ['non-raster declared MIME', { mimeType: 'image/svg+xml' }],
    ['zero stored bytes', { sizeBytes: 0 }],
    ['fractional stored bytes', { sizeBytes: 1.5 }],
    ['oversize stored bytes', { sizeBytes: MAX_INLINE_IMAGE_BYTES + 1 }],
  ])('blocks CID attachment with %s', (_label, patch) => {
    const { html, hasBlockedImages } = projectCidImages(
      '<img src="cid:banner001@rocketseed">',
      [{ ...meta[0]!, ...patch }],
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).not.toContain('/attachments/att-1/inline');
  });

  it('blocks a CID duplicated by a non-inline non-raster attachment', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<img src="cid:banner001@rocketseed">',
      [
        meta[0]!,
        {
          attachmentId: 'att-2',
          contentId: '<banner001@rocketseed>',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          isInline: false,
        },
      ],
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).not.toContain('/attachments/att-1/inline');
  });
});
