import { describe, expect, it } from 'vitest';
import { normalizeContentId, projectCidImages } from '../src/mail/cid-images.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';

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

  it('placeholders missing cid and does not rewrite anchors', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<a href="cid:banner001@rocketseed">x</a><img src="cid:missing@x">',
      meta,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).toContain('href="cid:banner001@rocketseed"');
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
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
        },
        {
          attachmentId: 'a2',
          contentId: 'CID:dup@x',
          mimeType: 'image/png',
          sizeBytes: 10,
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
});
