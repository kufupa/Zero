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

  it('masks a CVV, CVC or security code, and keeps its label', () => {
    expect(maskCardNumbers('CVV: 123')).toBe('CVV: [code masked]');
    expect(maskCardNumbers('cvv2 4567')).toBe('cvv2 [code masked]');
    expect(maskCardNumbers('CVC 1234 expires 12/28')).toBe('CVC [code masked] expires 12/28');
    expect(maskCardNumbers('Security code: 321')).toBe('Security code: [code masked]');
  });

  it('masks a security code on the line after its label, as extracted PDF text splits them', () => {
    expect(maskCardNumbers('CVV:\n123')).toBe('CVV:\n[code masked]');
    expect(maskCardNumbers('Security code\r\n\r\n 4567 ')).toBe('Security code\r\n\r\n [code masked] ');
    expect(maskCardNumbers('CVV:\n\n\n123')).toBe('CVV:\n\n\n123');
  });

  it('leaves a bare number and a two-digit value after a security label alone', () => {
    expect(maskCardNumbers('room 123 for 2 nights')).toBe('room 123 for 2 nights');
    expect(maskCardNumbers('CVV 12')).toBe('CVV 12');
  });

  it('masks the card and the CVV in one string, and leaves a non-Luhn order number', () => {
    expect(
      maskCardNumbers('Card 4111 1111 1111 1111 CVV: 123, order 4111 1111 1111 1112'),
    ).toBe('Card [card ••••1111] CVV: [code masked], order 4111 1111 1111 1112');
  });

  it('keeps a masked card whole when a CVV label comes right before it', () => {
    expect(maskCardNumbers('CVV: 4111 1111 1111 1111')).toBe('CVV: [card ••••1111]');
  });
});
