import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, sanitizeHtmlBodyForStorage } from '../src/mail/sanitize-email-html.js';

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
