import { expect, it } from 'vitest';
import { attachmentMattersForReview, unreadReasonWords } from '../src/ai/quote-attachment-review.js';

it('explains DOCX conversion failures and unavailable page breaks to staff', () => {
  expect(unreadReasonWords('office conversion failed')).toBe('Word file could not be read');
  expect(unreadReasonWords('page boundaries unavailable')).toBe('page breaks could not be read');
});

it('explains unsupported and bounded XLSX reads as visible staff review', () => {
  expect(unreadReasonWords('spreadsheet encrypted')).toBe('password-protected');
  expect(unreadReasonWords('spreadsheet row limit')).toBe('above the row reading limit');
  expect(unreadReasonWords('spreadsheet cell limit')).toBe('above the cell reading limit');
  expect(unreadReasonWords('spreadsheet formula cells')).toBe('contains formulas that Nava does not recalculate');
  expect(unreadReasonWords('spreadsheet hidden rows or columns')).toBe('contains hidden rows or columns');
  expect(unreadReasonWords('spreadsheet parse failed')).toBe('could not be read completely');
});

it('keeps small XLSX rooming sources in review instead of dropping them as tiny files', () => {
  expect(attachmentMattersForReview({
    filename: 'rooming.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: 1_000,
  })).toBe(true);
  expect(attachmentMattersForReview({
    filename: 'rooming.xlsx',
    mimeType: 'application/octet-stream',
    byteSize: 1_000,
  })).toBe(true);
});
