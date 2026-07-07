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

  it('maps read:no to unread', () => {
    expect(parseSearchQuery('read:no')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
  });

  it('maps hasattachment:yes', () => {
    expect(parseSearchQuery('hasattachment:yes')).toMatchObject({ hasAttachment: true });
    expect(parseSearchQuery('has:attachment')).toMatchObject({ hasAttachment: true });
  });

  it('keeps bare text as freeText', () => {
    expect(parseSearchQuery('hotel invoice')).toMatchObject({ freeText: 'hotel invoice' });
  });

  it('throws on unsupported operator', () => {
    expect(() => parseSearchQuery('kind:email')).toThrow(SearchParseError);
  });
});
