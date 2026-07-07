import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/mail/search/parse.js';
import type { ParsedSearchQuery } from '../src/mail/search/types.js';

type ParityCase = {
  name: string;
  query: string;
  expected: Partial<ParsedSearchQuery>;
};

const parityCases: ParityCase[] = [
  { name: 'from', query: 'from:alice@corp.com', expected: { from: ['alice@corp.com'], freeText: '' } },
  { name: 'to', query: 'to:bob@corp.com', expected: { to: ['bob@corp.com'], freeText: '' } },
  { name: 'cc', query: 'cc:cc@corp.com', expected: { cc: ['cc@corp.com'], freeText: '' } },
  { name: 'bcc', query: 'bcc:bcc@corp.com', expected: { bcc: ['bcc@corp.com'], freeText: '' } },
  {
    name: 'subject',
    query: 'subject:"Q2 report"',
    expected: { subject: 'Q2 report', freeText: '' },
  },
  {
    name: 'has:attachment',
    query: 'has:attachment',
    expected: { hasAttachment: true, freeText: '' },
  },
  {
    name: 'hasattachment:yes',
    query: 'hasattachment:yes',
    expected: { hasAttachment: true, freeText: '' },
  },
  {
    name: 'hasattachment:true',
    query: 'hasattachment:true',
    expected: { hasAttachment: true, freeText: '' },
  },
  { name: 'read:no', query: 'read:no', expected: { isRead: false, freeText: '' } },
  { name: 'is:unread', query: 'is:unread', expected: { isRead: false, freeText: '' } },
  { name: 'is:starred', query: 'is:starred', expected: { isStarred: true, freeText: '' } },
  { name: 'is:flagged', query: 'is:flagged', expected: { isStarred: true, freeText: '' } },
  {
    name: 'importance:high',
    query: 'importance:high',
    expected: { isImportant: true, freeText: '' },
  },
  {
    name: 'is:important',
    query: 'is:important',
    expected: { isImportant: true, freeText: '' },
  },
  { name: 'after', query: 'after:2024/01/01', expected: { after: '2024/01/01', freeText: '' } },
  { name: 'before', query: 'before:2024/12/31', expected: { before: '2024/12/31', freeText: '' } },
  { name: 'label', query: 'label:work', expected: { labelIds: ['work'], freeText: '' } },
  {
    name: 'category',
    query: 'category:travel-agents',
    expected: { categorySlugs: ['travel-agents'], freeText: '' },
  },
  {
    name: 'combined query',
    query: 'from:boss@company.com is:unread has:attachment invoice',
    expected: {
      from: ['boss@company.com'],
      isRead: false,
      hasAttachment: true,
      freeText: 'invoice',
    },
  },
];

describe('mail search operator parity matrix', () => {
  it.each(parityCases)('$name', ({ query, expected }) => {
    expect(parseSearchQuery(query)).toMatchObject(expected);
  });
});
