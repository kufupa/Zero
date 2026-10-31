import { AMBIGUOUS_NUMBER_GROUPS, maskCardNumbers, maskContactDetails, maskIncomingCardNumbers, maskMailText } from '../src/ai/card-mask.js';
import { describe, expect, it } from 'vitest';

describe('maskCardNumbers', () => {
  it('masks overlapping wrapped cards and flags a longer ambiguous number', () => {
    expect(maskIncomingCardNumbers('Expiry year: 2026\n4111\n1111 1111 1111 CVV: 123')).toContain(AMBIGUOUS_NUMBER_GROUPS);
    expect(maskIncomingCardNumbers('Payment reference: 4111 1111 1111 1111 123')).toBe(`Payment reference: ${AMBIGUOUS_NUMBER_GROUPS} 123`);
  });
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

  it('masks a phone on the line after a date, and never joins the two across the newline', () => {
    expect(maskContactDetails('2027-05-12\n0825551234')).toBe('2027-05-12\n[phone]');
    expect(maskContactDetails('2027-05-12\r\n082 555 1234')).toBe('2027-05-12\r\n[phone]');
  });

  it('masks a phone beside a bracketed date, and keeps the date', () => {
    expect(maskContactDetails('Call 0825551234 (2027-11-13)')).toBe('Call [phone] (2027-11-13)');
    expect(maskContactDetails('Arrival 2027-05-12 0825551234')).toBe('Arrival 2027-05-12 [phone]');
    expect(maskContactDetails('Arrival 2027-05-12 082 555 1234')).toBe('Arrival 2027-05-12 [phone]');
  });

  it('masks a run of 7 or more digits, and a spaced or bracketed international number', () => {
    expect(maskContactDetails('line 5551234 today')).toBe('line [phone] today');
    expect(maskContactDetails('+27 (0)82 555 1234 for the group')).toBe('[phone] for the group');
    expect(maskContactDetails('(021) 555 1234 office')).toBe('[phone] office');
  });

  it('masks a phone with mixed separators, with or without a date beside it', () => {
    expect(maskContactDetails('082 555-1234')).toBe('[phone]');
    expect(maskContactDetails('(021) 555-1234')).toBe('[phone]');
    expect(maskContactDetails('+27 82 555-1234')).toBe('[phone]');
    expect(maskContactDetails('Call 082 555-1234 or +27 82 555-1234 today')).toBe(
      'Call [phone] or [phone] today',
    );
    expect(maskContactDetails('2027-05-12 082 555-1234')).toBe('2027-05-12 [phone]');
    expect(maskContactDetails('12.05.2027 082 555-1234')).toBe('12.05.2027 [phone]');
  });

  it('never joins a phone to the line above or below it', () => {
    expect(maskContactDetails('082\n0825551234')).toBe('082\n[phone]');
    expect(maskContactDetails('2027-05-12\n082 555-1234')).toBe('2027-05-12\n[phone]');
  });

  it('masks a dashed phone at 9 to 15 digits starting with 0, and keeps a dashed reference', () => {
    expect(maskContactDetails('call 082-555-1234 or 57291630-1')).toBe(
      'call [phone] or 57291630-1',
    );
  });
});

describe('maskMailText', () => {
  it('applies the card, security code, address and phone masks together', () => {
    expect(maskMailText('card 4111111111111111 CVV: 123 jane@hotel.co.za 0825551234')).toBe(
      'card [card ••••1111] CVV: [code masked] [email] [phone]',
    );
  });

  it('keeps every pair of dates, which reads as a Luhn-valid digit run without the date split', () => {
    const dates = Array.from({ length: 30 }, (_, day) => `2027-11-${String(day + 1).padStart(2, '0')}`);
    for (const first of dates) {
      for (const second of dates) {
        for (const separator of [' ', '-']) {
          const text = `${first}${separator}${second}`;
          expect(maskMailText(text)).toBe(text);
        }
      }
    }
    expect(maskMailText('Arrival 2027-11-01 Departure 2027-11-03')).toBe(
      'Arrival 2027-11-01 Departure 2027-11-03',
    );
  });

  it('masks a phone beside a date as a phone, and still masks a spaced or dashed card beside a date', () => {
    expect(maskMailText('0825551234 2027-11-13')).toBe('[phone] 2027-11-13');
    expect(maskMailText('Call 0825551234 (2027-11-13)')).toBe('Call [phone] (2027-11-13)');
    expect(maskMailText('4111 1111 1111 1111 2027-11-13')).toBe('[card ••••1111] 2027-11-13');
    expect(maskMailText('4111-1111-1111-1111')).toBe('[card ••••1111]');
    expect(maskMailText('card 5500 0000 0000 0004 exp 12/28')).toBe('card [card ••••0004] exp 12/28');
    expect(maskMailText('2027-11-13 5500-0000-0000-0004')).toBe('2027-11-13 [card ••••0004]');
  });
});
