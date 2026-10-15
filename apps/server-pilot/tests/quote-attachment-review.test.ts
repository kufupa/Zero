import { expect, it } from 'vitest';
import { unreadReasonWords } from '../src/ai/quote-attachment-review.js';

it('explains DOCX conversion failures and unavailable page breaks to staff', () => {
  expect(unreadReasonWords('office conversion failed')).toBe('Word file could not be read');
  expect(unreadReasonWords('page boundaries unavailable')).toBe('page breaks could not be read');
});
