import { maskCardNumbers, maskContactDetails, maskMailText } from '../src/ai/card-mask.js';
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
    expect(maskCardNumbers('Security code\r\n\r\n 4567 ')).toBe(
      'Security code\r\n\r\n [code masked] ',
    );
    expect(maskCardNumbers('CVV:\n\n\n123')).toBe('CVV:\n\n\n123');
    expect(maskCardNumbers('CVV |\n| 123')).toBe('CVV |\n| [code masked]');
  });

  it('leaves a labelled number on the line after a blank security-code field alone', () => {
    expect(maskCardNumbers('CVV:\nConf# 1234')).toBe('CVV:\nConf# 1234');
    expect(maskCardNumbers('Security code:\nTel: 021 555 1234')).toBe(
      'Security code:\nTel: 021 555 1234',
    );
    expect(maskCardNumbers('CVV:\nArrival: 2026-10-12')).toBe('CVV:\nArrival: 2026-10-12');
  });

  it('leaves a bare number and a two-digit value after a security label alone', () => {
    expect(maskCardNumbers('room 123 for 2 nights')).toBe('room 123 for 2 nights');
    expect(maskCardNumbers('CVV 12')).toBe('CVV 12');
  });

  it('masks the card and the CVV in one string, and leaves a non-Luhn order number', () => {
    expect(maskCardNumbers('Card 4111 1111 1111 1111 CVV: 123, order 4111 1111 1111 1112')).toBe(
      'Card [card ••••1111] CVV: [code masked], order 4111 1111 1111 1112',
    );
  });

  it('keeps a masked card whole when a CVV label comes right before it', () => {
    expect(maskCardNumbers('CVV: 4111 1111 1111 1111')).toBe('CVV: [card ••••1111]');
  });
});

describe('maskContactDetails', () => {
  it('replaces addresses and phone numbers, and keeps amounts, dates and confirmation numbers', () => {
    expect(maskContactDetails('Mail jane.smith@example.co.za or call 082 555 1234.')).toBe(
      'Mail [email] or call [phone].',
    );
    expect(maskContactDetails('+27 82 555 1234 for the group')).toBe('[phone] for the group');
    expect(maskContactDetails('R 12 500 on 2027-10-26, confirmation 57291630-1, 2 rooms')).toBe(
      'R 12 500 on 2027-10-26, confirmation 57291630-1, 2 rooms',
    );
  });
});

describe('maskMailText', () => {
  it('applies the card, security code, address and phone masks together', () => {
    expect(maskMailText('card 4111111111111111 CVV: 123 jane@hotel.co.za 0825551234')).toBe(
      'card [card ••••1111] CVV: [code masked] [email] [phone]',
    );
  });
});
