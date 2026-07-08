import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/mail/search/parse.js';
import { SearchParseError } from '../src/mail/search/types.js';

describe('parseSearchQuery', () => {
  it('parses from: operator', () => {
    expect(parseSearchQuery('from:alice@corp.com')).toMatchObject({
      from: ['alice@corp.com'],
      freeText: '',
    });
  });

  it('parses combined from: and free text', () => {
    expect(parseSearchQuery('from:alice@corp.com invoice')).toMatchObject({
      from: ['alice@corp.com'],
      freeText: 'invoice',
    });
  });

  it('parses quoted subject:', () => {
    expect(parseSearchQuery('subject:"Q2 report"')).toMatchObject({
      subject: 'Q2 report',
      freeText: '',
    });
  });

  it('parses multiple from: tokens', () => {
    expect(parseSearchQuery('from:alice@corp.com from:bob@corp.com')).toMatchObject({
      from: ['alice@corp.com', 'bob@corp.com'],
      freeText: '',
    });
  });

  it('rejects Outlook spellings', () => {
    for (const q of ['read:no', 'hasattachment:yes', 'importance:high', 'is:flagged']) {
      expect(() => parseSearchQuery(q)).toThrow(SearchParseError);
    }
  });

  it('accepts canonical is: and has: values only', () => {
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('has:attachment')).toMatchObject({ hasAttachment: true });
    expect(() => parseSearchQuery('is:flagged')).toThrow(SearchParseError);
  });

  it('keeps bare text as freeText', () => {
    expect(parseSearchQuery('hotel invoice')).toMatchObject({ freeText: 'hotel invoice' });
  });

  it('throws on unsupported operator', () => {
    expect(() => parseSearchQuery('kind:email')).toThrow(SearchParseError);
  });
});
