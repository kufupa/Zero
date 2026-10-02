import {
  resolveMailDisplayContent,
  resolveMailDisplayHtml,
} from '../lib/mail/resolve-mail-display-html';
import { isImageTrustedSender } from '../lib/mail/trust-sender';
import { describe, expect, it } from 'vitest';

const MALICIOUS_RAW_HTML = '<body><p>visible</p><script>alert("xss")</script></body>';

describe('resolveMailDisplayHtml', () => {
  it('returns sanitized processed html when backend provides it', () => {
    const result = resolveMailDisplayHtml({
      frontendOnlyDemo: false,
      processedHtml: '<p>sanitized</p>',
      rawHtml: MALICIOUS_RAW_HTML,
    });

    expect(result).toBe('<p>sanitized</p>');
    expect(result).not.toContain('<script');
  });

  it('falls back to client-resolved raw html when backend html is unavailable', () => {
    const result = resolveMailDisplayHtml({
      frontendOnlyDemo: false,
      processedHtml: null,
      rawHtml: MALICIOUS_RAW_HTML,
    });

    expect(result).toContain('<p>visible</p>');
    expect(result).toContain('data-nava-mail-font="1"');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('still uses client fallback in frontend-only demo mode', () => {
    const result = resolveMailDisplayHtml({
      frontendOnlyDemo: true,
      processedHtml: null,
      rawHtml: MALICIOUS_RAW_HTML,
    });

    expect(result).toContain('<p>visible</p>');
    expect(result).toContain('data-nava-mail-font="1"');
    expect(result).not.toContain('<script');
  });

  it('blocks remote fallback images by default and reports that images were blocked', () => {
    const result = resolveMailDisplayContent({
      frontendOnlyDemo: false,
      rawHtml: '<p>Reservation</p><img src="https://tracker.example/pixel" alt="tracking" />',
      shouldLoadImages: false,
    });

    expect(result.hasBlockedImages).toBe(true);
    expect(result.html).not.toContain('https://tracker.example/pixel');
    expect(result.html).toContain('data:image/gif;base64,');
  });

  it('allows remote fallback images only after the user image setting permits them', () => {
    const result = resolveMailDisplayContent({
      frontendOnlyDemo: false,
      rawHtml: '<img src="https://images.example/hotel.jpg" alt="Hotel" />',
      shouldLoadImages: true,
    });

    expect(result.hasBlockedImages).toBe(false);
    expect(result.html).toContain('https://images.example/hotel.jpg');
  });
});

describe('isImageTrustedSender (FE twin)', () => {
  it('trusts hotel domains without trustedSenders entry', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'centurion@legacyhotels.co.za',
        externalImages: false,
        trustedSenders: [],
      }),
    ).toBe(true);
  });

  it('matches domain entries in trustedSenders', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'a@partner.test',
        externalImages: false,
        trustedSenders: ['partner.test'],
      }),
    ).toBe(true);
    expect(
      isImageTrustedSender({
        senderEmail: 'x@evil.test',
        externalImages: false,
        trustedSenders: [],
      }),
    ).toBe(false);
  });
});
