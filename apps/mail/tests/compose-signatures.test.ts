import { describe, expect, it } from 'vitest';
import { emailListSignature } from '../lib/mail/compose-signatures';

describe('emailListSignature', () => {
  it('joins emails in order for stable comparison', () => {
    expect(emailListSignature(['a@x.com', 'b@x.com'])).toBe('a@x.com\nb@x.com');
  });

  it('is stable for empty list', () => {
    expect(emailListSignature([])).toBe('');
  });
});
