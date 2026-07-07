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

  it('maps read:no to unread', () => {
    expect(parseSearchQuery('read:no')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
  });

  it('maps hasattachment:yes and hasattachment:true', () => {
    expect(parseSearchQuery('hasattachment:yes')).toMatchObject({ hasAttachment: true });
    expect(parseSearchQuery('hasattachment:true')).toMatchObject({ hasAttachment: true });
    expect(parseSearchQuery('has:attachment')).toMatchObject({ hasAttachment: true });
  });

  it('maps hasattachment:false', () => {
    expect(parseSearchQuery('hasattachment:false')).toMatchObject({ hasAttachment: false });
    expect(parseSearchQuery('hasattachment:no')).toMatchObject({ hasAttachment: false });
  });

  it('maps importance:high to isImportant', () => {
    expect(parseSearchQuery('importance:high')).toMatchObject({ isImportant: true });
    expect(parseSearchQuery('is:important')).toMatchObject({ isImportant: true });
  });

  it('maps is:flagged to isStarred', () => {
    expect(parseSearchQuery('is:flagged')).toMatchObject({ isStarred: true });
    expect(parseSearchQuery('is:starred')).toMatchObject({ isStarred: true });
  });

  it('keeps bare text as freeText', () => {
    expect(parseSearchQuery('hotel invoice')).toMatchObject({ freeText: 'hotel invoice' });
  });

  it('throws on unsupported operator', () => {
    expect(() => parseSearchQuery('kind:email')).toThrow(SearchParseError);
  });
});
