import { describe, expect, it } from 'vitest';
import {
  normalizeContentId,
  projectCidImages,
  type CidAttachmentMeta,
} from '../src/mail/cid-images.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function inlineImage(
  overrides: Partial<CidAttachmentMeta> = {},
): CidAttachmentMeta {
  return {
    attachmentId: 'att-1',
    contentId: '<banner001@rocketseed>',
    mimeType: 'image/gif',
    sizeBytes: 1_200,
    isInline: true,
    ...overrides,
  };
}

describe('normalizeContentId', () => {
  it('normalizes in prefix, decode, trim, angle-pair, lowercase order', () => {
    expect(normalizeContentId('CID:%20%3CBanner%2Egif%40Host%3E%20')).toBe(
      'banner.gif@host',
    );
    expect(normalizeContentId('<banner001@rocketseed>')).toBe(
      'banner001@rocketseed',
    );
  });

  it('decodes exactly once after checking the raw prefix', () => {
    expect(normalizeContentId('cid:%2561%2540Host')).toBe('%61%40host');
    expect(normalizeContentId('%63id:Photo@Host')).toBe('cid:photo@host');
    expect(normalizeContentId(' CID:Photo@Host ')).toBe('cid:photo@host');
  });

  it('rejects decoded controls before trimming or angle normalization', () => {
    for (const raw of [
      'cid:%0Afoo',
      'cid:foo%0D',
      'cid:%09%3Cfoo%3E%09',
      'cid:\nfoo',
      'cid:foo\t',
    ]) {
      expect(normalizeContentId(raw), raw).toBeNull();
    }
  });

  it('rejects invalid percent escapes, controls, empty ids, and forbidden delimiters', () => {
    for (const raw of [
      'cid:%',
      'cid:%GG',
      'cid:',
      'cid:<>',
      'cid:a\u0000b',
      'cid:a\u007fb',
      'cid:a/b',
      'cid:a\\b',
      'cid:a?b',
      'cid:a#b',
      'cid:a%2Fb',
    ]) {
      expect(normalizeContentId(raw), raw).toBeNull();
    }
  });
});

describe('projectCidImages', () => {
  it('rewrites a matching sanitized img CID to an encoded absolute inline URL', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<p><img alt="Hotel banner" class="hero" src="CID:%3Cbanner001%40rocketseed%3E" width="100"></p>',
      [inlineImage()],
      {
        messageId: 'msg/1',
        origin: 'https://nava.legacy.local/',
      },
    );

    expect(hasBlockedImages).toBe(false);
    expect(html).toContain(
      'src="https://nava.legacy.local/api/mail/messages/msg%2F1/attachments/att-1/inline"',
    );
    expect(html).toContain('alt="Hotel banner"');
    expect(html).toContain('class="hero"');
    expect(html).toContain('width="100"');
    expect(html.toLowerCase()).not.toMatch(/<(?:html|head|body)(?:\s|>)/);
  });

  it('never rewrites anchors, CSS URLs, srcset, or non-CID img sources', () => {
    const html =
      '<a href="cid:banner001@rocketseed">open</a>' +
      '<div style="background:url(cid:banner001@rocketseed)"></div>' +
      '<img src="https://images.example/banner.gif" srcset="cid:banner001@rocketseed 2x">';
    const projected = projectCidImages(html, [inlineImage()], {
      messageId: 'msg-1',
      origin: 'https://nava.legacy.local',
    });

    expect(projected.hasBlockedImages).toBe(false);
    expect(projected.html).toContain('href="cid:banner001@rocketseed"');
    expect(projected.html).toContain('url(cid:banner001@rocketseed)');
    expect(projected.html).toContain('srcset="cid:banner001@rocketseed 2x"');
    expect(projected.html).toContain('src="https://images.example/banner.gif"');
    expect(projected.html).not.toContain('/inline');
  });

  it.each([
    ['missing', 'cid:missing@x', []],
    ['malformed', 'cid:%GG', [inlineImage()]],
    [
      'oversized',
      'cid:banner001@rocketseed',
      [inlineImage({ sizeBytes: MAX_INLINE_IMAGE_BYTES + 1 })],
    ],
    [
      'non-image',
      'cid:banner001@rocketseed',
      [inlineImage({ mimeType: 'application/pdf' })],
    ],
    [
      'non-inline',
      'cid:banner001@rocketseed',
      [inlineImage({ isInline: false })],
    ],
  ])('blocks %s CID while preserving useful alt text', (_case, src, attachments) => {
    const { html, hasBlockedImages } = projectCidImages(
      `<img alt="Brand artwork" src="${src}">`,
      attachments,
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).toContain('alt="Brand artwork"');
  });

  it('blocks duplicate normalized Content-IDs as ambiguous', () => {
    const { html, hasBlockedImages } = projectCidImages(
      '<img src="cid:banner.gif@host">',
      [
        inlineImage({
          attachmentId: 'att-1',
          contentId: '<Banner%2Egif@Host>',
        }),
        inlineImage({
          attachmentId: 'att-2',
          contentId: 'CID:banner.gif@host',
          mimeType: 'image/png',
        }),
      ],
      { messageId: 'msg-1', origin: 'https://nava.legacy.local' },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).not.toContain('/attachments/att-1/inline');
    expect(html).not.toContain('/attachments/att-2/inline');
  });
});
