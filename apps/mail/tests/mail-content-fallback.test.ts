import { describe, expect, it } from 'vitest';
import {
  UNSAFE_MAIL_CONTENT_PLACEHOLDER,
  resolveMailDisplayHtml,
} from '../lib/mail/resolve-mail-display-html';
import { isImageTrustedSender } from '../lib/mail/trust-sender';

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

  it('never passes through script tags when backend html is unavailable in non-demo mode', () => {
    const result = resolveMailDisplayHtml({
      frontendOnlyDemo: false,
      processedHtml: null,
      rawHtml: MALICIOUS_RAW_HTML,
    });

    expect(result).toBe(UNSAFE_MAIL_CONTENT_PLACEHOLDER);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('still uses client fallback in frontend-only demo mode', () => {
    const result = resolveMailDisplayHtml({
      frontendOnlyDemo: true,
      processedHtml: null,
      rawHtml: MALICIOUS_RAW_HTML,
    });

    expect(result).toBe('<p>visible</p>');
    expect(result).not.toContain('<script');
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
