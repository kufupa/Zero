import { describe, expect, it } from 'vitest';
import {
  BLOCKED_IMAGE_PLACEHOLDER,
  sanitizeEmailHtml,
  sanitizeHtmlBodyForStorage,
} from '../src/mail/sanitize-email-html.js';

describe('sanitizeEmailHtml', () => {
  it('strips script tags and event handlers', () => {
    const { html } = sanitizeEmailHtml(
      '<p onclick="alert(1)">hi</p><script>alert(1)</script>',
      { shouldLoadImages: false },
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('blocks remote images when shouldLoadImages is false', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      '<img src="https://evil.example/x.png">',
      { shouldLoadImages: false },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).not.toContain('https://evil.example');
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
  });

  it('blocks protocol-relative images when shouldLoadImages is false', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      '<img src="//evil.example/x.png">',
      { shouldLoadImages: false },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).not.toContain('evil.example');
  });

  it('blocks scheme-less images when shouldLoadImages is false', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      '<img src="/images/tracking.png">',
      { shouldLoadImages: false },
    );
    expect(hasBlockedImages).toBe(true);
    expect(html).not.toContain('/images/tracking.png');
  });

  it('permits cid only for img src while stripping anchors and srcset', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      '<a href="cid:banner@hotel">open</a>' +
        '<img alt="banner" src="CID:banner@hotel" srcset="cid:second@hotel 2x">',
      { shouldLoadImages: false },
    );

    expect(hasBlockedImages).toBe(false);
    expect(html).toContain('src="CID:banner@hotel"');
    expect(html).toContain('alt="banner"');
    expect(html).not.toContain('href="cid:');
    expect(html).not.toContain('srcset');
  });

  it('blocks caller-provided data images while retaining generated placeholders', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      '<img alt="tracker" src="data:image/png;base64,AAAA">',
      { shouldLoadImages: false },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).toContain('alt="tracker"');
    expect(html).not.toContain('data:image/png');
  });

  it('blocks arbitrary data payloads even when image loading is enabled', () => {
    const payloads = [
      'data:image/png;base64,AAAA',
      ' \tdata:image/gif;base64,AAAA',
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E',
      'data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    ];
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      payloads
        .map((src, index) => `<img alt="unsafe-${index}" src="${src}">`)
        .join(''),
      { shouldLoadImages: true },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html.split(BLOCKED_IMAGE_PLACEHOLDER)).toHaveLength(payloads.length + 1);
    for (const payload of payloads) {
      expect(html).not.toContain(payload);
    }
  });

  it('keeps only the exact generated placeholder and remote images when enabled', () => {
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      `<img alt="blocked" src="${BLOCKED_IMAGE_PLACEHOLDER}">` +
        '<img alt="remote" src="https://images.example/banner.png">',
      { shouldLoadImages: true },
    );

    expect(hasBlockedImages).toBe(false);
    expect(html).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(html).toContain('src="https://images.example/banner.png"');
  });

  it('blocks comment-obfuscated data schemes before sanitizer normalization', () => {
    const obfuscated = [
      '<!--before-->data:image/png;base64,AAAA',
      'da<!--inside-->ta:image/png;base64,BBBB',
      'D&#x41;<!--mixed-->tA:image/svg+xml,CCCC',
      'd&#97;<!--entity-->TA:text/html,DDDD',
    ];
    const { html, hasBlockedImages } = sanitizeEmailHtml(
      obfuscated
        .map((src, index) => `<img alt="obfuscated-${index}" src="${src}">`)
        .join('') +
        `<img alt="safe-placeholder" src="${BLOCKED_IMAGE_PLACEHOLDER}">` +
        '<img alt="inline" src="CID:banner@hotel">',
      { shouldLoadImages: true },
    );

    expect(hasBlockedImages).toBe(true);
    expect(html.split(BLOCKED_IMAGE_PLACEHOLDER)).toHaveLength(
      obfuscated.length + 2,
    );
    expect(html).not.toContain('data:image/png;base64,AAAA');
    expect(html).not.toMatch(/BBBB|CCCC|DDDD|<!--/);
    expect(html).toContain('alt="safe-placeholder"');
    expect(html).toContain('src="CID:banner@hotel"');
  });
});

describe('sanitizeHtmlBodyForStorage', () => {
  it('returns null for null', () => {
    expect(sanitizeHtmlBodyForStorage(null)).toBeNull();
  });

  it('returns plain text unchanged when no angle brackets', () => {
    expect(sanitizeHtmlBodyForStorage('plain booking text')).toBe('plain booking text');
  });

  it('strips script and handlers from HTML', () => {
    const raw = '<img src=x onerror=alert(1)><script>alert(1)</script><p>ok</p>';
    const stored = sanitizeHtmlBodyForStorage(raw);
    expect(stored).not.toContain('<script');
    expect(stored).not.toMatch(/onerror/i);
    expect(stored).toContain('ok');
  });
});
