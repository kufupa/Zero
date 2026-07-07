import { describe, expect, it } from 'vitest';
import { resolveMailListSearch } from '../lib/mail/search-filters';

describe('resolveMailListSearch', () => {
  it('maps is:unread to structured unread filter', () => {
    expect(resolveMailListSearch('is:unread', { labelIds: ['a'] })).toEqual({
      q: undefined,
      filters: { labelIds: ['a'], unread: true },
    });
  });

  it('maps read:no alias', () => {
    expect(resolveMailListSearch('read:no', {})).toEqual({
      q: undefined,
      filters: { unread: true },
    });
  });

  it('keeps compound queries in q', () => {
    expect(resolveMailListSearch('from:boss@corp.com is:unread', {})).toEqual({
      q: 'from:boss@corp.com is:unread',
      filters: {},
    });
  });

  it('passes has:attachment through q', () => {
    expect(resolveMailListSearch('has:attachment', {})).toEqual({
      q: 'has:attachment',
      filters: {},
    });
  });
});
