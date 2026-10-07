import { maskCardNumbers } from '../src/ai/card-mask.js';
import { describe, expect, it } from 'vitest';

describe('maskCardNumbers', () => {
  it('masks a Luhn-valid PAN and keeps the last four digits', () => {
    expect(maskCardNumbers('pay with 4111 1111 1111 1111 please')).toBe(
      'pay with [card ••••1111] please',
    );
    expect(maskCardNumbers('4111111111111111')).toBe('[card ••••1111]');
  });

  it('leaves a non-Luhn 16-digit run unmasked', () => {
    expect(maskCardNumbers('ref 4111 1111 1111 1112 stays')).toBe('ref 4111 1111 1111 1112 stays');
  });

  it('preserves a trailing separator after a masked PAN', () => {
    expect(maskCardNumbers('4111 1111 1111 1111.')).toBe('[card ••••1111].');
    expect(maskCardNumbers('4111 1111 1111 1111 ')).toBe('[card ••••1111] ');
  });
});
