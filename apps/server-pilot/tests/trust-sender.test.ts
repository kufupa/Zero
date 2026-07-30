import { describe, expect, it } from 'vitest';
import { isImageTrustedSender } from '../src/mail/trust-sender.js';

describe('isImageTrustedSender', () => {
  it('allows when externalImages true', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'x@evil.test',
        externalImages: true,
        trustedSenders: [],
      }),
    ).toBe(true);
  });

  it('matches exact email and domain entries', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'ops@partner.test',
        externalImages: false,
        trustedSenders: ['ops@partner.test'],
      }),
    ).toBe(true);
    expect(
      isImageTrustedSender({
        senderEmail: 'a@partner.test',
        externalImages: false,
        trustedSenders: ['partner.test'],
      }),
    ).toBe(true);
  });

  it('treats never-spam hotel domains as trusted', () => {
    expect(
      isImageTrustedSender({
        senderEmail: 'centurion@legacyhotels.co.za',
        externalImages: false,
        trustedSenders: [],
      }),
    ).toBe(true);
  });
});
