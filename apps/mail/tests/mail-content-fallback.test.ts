import { describe, expect, it } from 'vitest';
import {
  UNSAFE_MAIL_CONTENT_PLACEHOLDER,
  resolveMailDisplayHtml,
} from '../lib/mail/resolve-mail-display-html';
import * as mailContent from '../components/mail/mail-content';

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

type ImageErrorTarget = {
  src: string;
  style: { display: string };
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
};

function fakeImage(src: string, alt: string): {
  target: ImageErrorTarget;
  attributes: Map<string, string>;
} {
  const attributes = new Map([
    ['src', src],
    ['alt', alt],
  ]);
  return {
    target: {
      src,
      style: { display: '' },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
    },
    attributes,
  };
}

describe('mail content image failures', () => {
  const backendOrigin = 'https://mail.example.test';

  function handleImageError(
    target: ImageErrorTarget,
    imagesEnabled: boolean,
  ): boolean {
    const helper = (
      mailContent as typeof mailContent & {
        handleMailContentImageError?: (
          image: ImageErrorTarget,
          options: { imagesEnabled: boolean; backendUrl: string },
        ) => boolean;
      }
    ).handleMailContentImageError;

    if (!helper) {
      throw new Error('handleMailContentImageError is not implemented');
    }

    return helper(target, { imagesEnabled, backendUrl: backendOrigin });
  }

  it('removes a failed authenticated inline src while preserving the image and alt text', () => {
    const image = fakeImage(
      `${backendOrigin}/api/mail/messages/message-1/attachments/attachment-1/inline`,
      'Brand banner',
    );

    expect(handleImageError(image.target, false)).toBe(false);
    expect(image.attributes.has('src')).toBe(false);
    expect(image.attributes.get('alt')).toBe('Brand banner');
    expect(image.target.style.display).toBe('');
  });

  it('keeps remote image failure behavior, including warning while blocked', () => {
    const blocked = fakeImage(
      'https://remote.example.test/banner.png',
      'Remote banner',
    );
    const trusted = fakeImage(
      'https://remote.example.test/banner.png',
      'Remote banner',
    );

    expect(handleImageError(blocked.target, false)).toBe(true);
    expect(blocked.target.style.display).toBe('none');
    expect(handleImageError(trusted.target, true)).toBe(false);
    expect(trusted.target.style.display).toBe('none');
  });

  it('does not mistake a remote lookalike path for an authenticated inline route', () => {
    const image = fakeImage(
      'https://attacker.example.test/api/mail/messages/message-1/attachments/attachment-1/inline',
      'Lookalike banner',
    );

    expect(handleImageError(image.target, false)).toBe(true);
    expect(image.attributes.has('src')).toBe(true);
    expect(image.target.style.display).toBe('none');
  });
});
