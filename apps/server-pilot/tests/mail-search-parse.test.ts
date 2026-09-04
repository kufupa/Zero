import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/mail/search/parse.js';

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

  it('parses Outlook aliases', () => {
    expect(parseSearchQuery('hasattachments:yes')).toMatchObject({ hasAttachment: true });
    expect(parseSearchQuery('hasattachments:no')).toMatchObject({ hasAttachment: false });
    expect(parseSearchQuery('isread:no')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('isread:yes')).toMatchObject({ isRead: true });
  });

  it('accepts canonical is: and has: values', () => {
    expect(parseSearchQuery('is:unread')).toMatchObject({ isRead: false });
    expect(parseSearchQuery('has:attachment')).toMatchObject({ hasAttachment: true });
  });

  it('keeps bare text as freeText', () => {
    expect(parseSearchQuery('hotel invoice')).toMatchObject({ freeText: 'hotel invoice' });
  });

  it('treats unsupported operators as freeText instead of throwing', () => {
    expect(parseSearchQuery('kind:email')).toMatchObject({ freeText: 'kind:email' });
    expect(parseSearchQuery('is:flagged')).toMatchObject({ freeText: 'is:flagged' });
    expect(parseSearchQuery('ref:12345')).toMatchObject({ freeText: 'ref:12345' });
  });
});
