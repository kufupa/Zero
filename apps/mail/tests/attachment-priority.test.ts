import { describe, expect, it } from 'vitest';
import {
  attachmentPriorityRank,
  sortAttachmentsForDisplay,
} from '../lib/attachment-priority';

describe('attachmentPriorityRank', () => {
  it('ranks pdf/excel ahead of gif/png', () => {
    expect(attachmentPriorityRank('invoice.pdf')).toBe(0);
    expect(attachmentPriorityRank('sheet.xlsx')).toBe(0);
    expect(attachmentPriorityRank('image001.gif')).toBe(2);
    expect(attachmentPriorityRank('photo.png', 'image/png')).toBe(2);
  });

  it('ranks unknown types between docs and images', () => {
    expect(attachmentPriorityRank('archive.zip')).toBe(1);
  });
});

describe('sortAttachmentsForDisplay', () => {
  it('puts documents before images; stable by name within band', () => {
    const sorted = sortAttachmentsForDisplay([
      { filename: 'image002.png', mimeType: 'image/png' },
      { filename: 'b.pdf', mimeType: 'application/pdf' },
      { filename: 'RSImage.gif', mimeType: 'image/gif' },
      { filename: 'a.pdf', mimeType: 'application/pdf' },
      { filename: 'data.xlsx', mimeType: 'application/vnd.ms-excel' },
    ]);

    expect(sorted.map((a) => a.filename)).toEqual([
      'a.pdf',
      'b.pdf',
      'data.xlsx',
      'image002.png',
      'RSImage.gif',
    ]);
  });
});
