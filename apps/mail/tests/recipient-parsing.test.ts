import { describe, expect, it } from 'vitest';
import {
  canonicalizeEmail,
  parseRecipientToken,
  splitRecipientField,
} from '../lib/demo/recipient-parsing';

describe('recipient parsing utilities', () => {
  it('parses quoted display names without splitting display-name commas', () => {
    const field = `"Doe, John" <john@example.com>; "Smith; Jane" <jane@example.com>; plain@example.com`;
    const tokens = splitRecipientField(field);

    expect(tokens).toEqual([
      '"Doe, John" <john@example.com>',
      '"Smith; Jane" <jane@example.com>',
      'plain@example.com',
    ]);

    expect(parseRecipientToken(tokens[0])).toEqual({
      email: 'john@example.com',
      name: '"Doe, John"',
    });
  });

  it('splits on comma and semicolon separators', () => {
    const tokens = splitRecipientField('alice@example.com, bob@example.com; Carol <carol@example.com>');

    expect(tokens).toEqual([
      'alice@example.com',
      'bob@example.com',
      'Carol <carol@example.com>',
    ]);
  });

  it('returns null for malformed recipient tokens', () => {
    expect(parseRecipientToken('not-an-email')).toBeNull();
    expect(parseRecipientToken('nope@')).toBeNull();
    expect(parseRecipientToken('"Name <bad@"')).toBeNull();
    expect(parseRecipientToken('')).toBeNull();
    expect(parseRecipientToken('  ')).toBeNull();
  });

  it('canonicalizes email addresses consistently', () => {
    expect(canonicalizeEmail('  AlIcE@Example.COM  ')).toBe('alice@example.com');

    const tokens = splitRecipientField('AlIcE@Example.COM; bOb@Example.com');
    const parsed = tokens.map((token) => parseRecipientToken(token)).filter((token) => token !== null);

    expect(parsed).toEqual([
      { email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);
  });
});
