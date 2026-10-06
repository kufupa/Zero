import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateDocumentPlan } from '../src/ai/reservationist-document-facts.js';

function validate(text: string, quote = text, arrival = '2026-09-30', departure = '2026-10-01') {
  const hash = createHash('sha256').update(text).digest('hex');
  const start = text.indexOf(quote);
  return validateDocumentPlan({
    facts: [{ id: 'dates', kind: 'dates', disclosure: 'guest', source: { attachmentId: 'document', sourceHash: hash, page: 1, quote, start, end: start + quote.length }, value: { arrival, departure } }],
    tasks: [], unresolvedAsks: [],
  }, [{ attachmentId: 'document', sourceHash: hash, pages: [text], pageCount: 1, disclosure: 'guest' }]);
}

it.each(['30TH SEPT – 1ST Oct 2026', '30 September – 1 October 2026', '30th Sept 2026 to 1st October 2026'])(
  'binds an explicit two-month ordinal range to its printed shared year: %s', quote => {
    expect(validate(`Accommodation from ${quote}.`, quote).facts[0].value).toEqual({ arrival: '2026-09-30', departure: '2026-10-01' });
  },
);

it('normalizes explicit ordinal check-in and check-out tokens', () => {
  expect(validate('CHECK IN: 30th SEPT 2026 CHECK OUT: 1st OCT 2026').facts[0].value).toEqual({ arrival: '2026-09-30', departure: '2026-10-01' });
});

it.each([
  '30TH SEPT – 1ST Oct',
  '30TH SEPT 2027 – 1ST Oct 2026',
  '31ST SEPT – 1ST Oct 2026',
  '1ST Oct – 30TH SEPT 2026',
  '30TH SEPT – 1ST Oct 2026 or 2ND Oct – 3RD Oct 2026',
])('rejects missing, contradictory, invalid or ambiguous ordinal range parts: %s', quote => {
  expect(() => validate(quote)).toThrow();
});

it.each(['Do not use:\n', 'Previous stay: ', 'If approved, '])('retains original ordinal-range exclusion outside a narrowed span: %s', prefix => {
  const quote = '30TH SEPT – 1ST Oct 2026';
  expect(() => validate(`${prefix}${quote}.`, quote)).toThrow();
});

it('rejects a conflicting labeled date when the model narrows to an ordinal range', () => {
  const quote = '30TH SEPT – 1ST Oct 2026';
  expect(() => validate(`CHECK IN 29th SEPT 2026 CHECK OUT 1st OCT 2026, requested ${quote}.`, quote)).toThrow();
});

it('does not borrow the year from another sentence or change a printed endpoint', () => {
  expect(() => validate('Issued 2026. Accommodation from 30TH SEPT – 1ST Oct.', '30TH SEPT – 1ST Oct')).toThrow();
  expect(() => validate('30TH SEPT – 1ST Oct 2026', undefined, '2026-09-29')).toThrow();
});
