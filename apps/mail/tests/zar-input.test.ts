import { describe, expect, it } from 'vitest';
import { MAX_EXTRA_AMOUNT_MINOR, parseCountInput, parseZarInput } from '../lib/quote-workflow/zar-input';

describe('rand amounts typed by staff', () => {
  it.each([
    ['450', 45_000],
    ['450.00', 45_000],
    ['450.5', 45_050],
    ['R 450', 45_000],
    ['R450.00', 45_000],
    ['1,000', 100_000],
    ['R1,000.50', 100_050],
    ['1,250.75', 125_075],
    [' 450 ', 45_000],
  ])('reads %j as %i cents', (raw, minor) => {
    expect(parseZarInput(raw)).toEqual({ status: 'ok', minor });
  });

  it('treats a cleared field as empty and a half-typed amount as partial', () => {
    expect(parseZarInput('   ')).toEqual({ status: 'empty' });
    for (const raw of ['125.', '1,', '1,0', '1,000.']) expect(parseZarInput(raw)).toEqual({ status: 'partial' });
  });

  it('refuses text, negatives, zero and extra decimals instead of misreading them', () => {
    for (const raw of ['abc', '-5', '4e3', '1.234', 'NaN', 'Infinity']) {
      expect(parseZarInput(raw).status, raw).toBe('invalid');
    }
    expect(parseZarInput('0')).toMatchObject({ status: 'invalid' });
  });

  it('never commits a comma decimal; the pane refuses it on blur', () => {
    expect(parseZarInput('450,50')).toEqual({ status: 'partial' });
  });

  it('caps one amount at R1,000,000', () => {
    expect(parseZarInput('1,000,000')).toEqual({ status: 'ok', minor: MAX_EXTRA_AMOUNT_MINOR });
    expect(parseZarInput('1,000,000.01')).toMatchObject({ status: 'over_cap' });
    expect(parseZarInput('2000000')).toMatchObject({ status: 'over_cap' });
  });
});

describe('whole-number counts typed by staff', () => {
  it('accepts whole numbers up to the cap', () => {
    expect(parseCountInput('2', 50)).toEqual({ status: 'ok', count: 2 });
    expect(parseCountInput('50', 50)).toEqual({ status: 'ok', count: 50 });
    expect(parseCountInput('', 50)).toEqual({ status: 'empty' });
  });

  it('refuses fractions, zero, text, and counts over the cap', () => {
    expect(parseCountInput('1.5', 50).status).toBe('invalid');
    expect(parseCountInput('0', 50).status).toBe('invalid');
    expect(parseCountInput('two', 50).status).toBe('invalid');
    expect(parseCountInput('51', 50)).toEqual({ status: 'over_cap', message: 'Up to 50 allowed' });
  });
});
