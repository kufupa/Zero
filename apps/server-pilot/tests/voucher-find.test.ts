import {
  dayFromText,
  extractVoucherGuest,
  isVoucherMail,
  pickVoucherFile,
  surnameFrom,
} from '../src/ai/voucher-find.js';
import { describe, expect, it } from 'vitest';

const none = { subject: 'Booking', bodyText: '', attachmentNames: [] as string[] };

function file(id: string, filename: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename,
    mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/png',
    sizeBytes: 100,
    isInline: false,
    s3Key: `k/${id}`,
    messageId: 'm1',
    ...extra,
  };
}

describe('voucher and proof-of-payment detection', () => {
  it('matches the subject, the start of the body, or a voucher-named attachment', () => {
    expect(isVoucherMail({ ...none, subject: 'Voucher for Smith 12 Nov' })).toBe(true);
    expect(isVoucherMail({ ...none, subject: 'Proof of payment attached' })).toBe(true);
    expect(isVoucherMail({ ...none, subject: 'Remittance advice' })).toBe(true);
    expect(isVoucherMail({ ...none, bodyText: 'Attached is the POP for the stay.' })).toBe(true);
    expect(isVoucherMail({ ...none, attachmentNames: ['Smith_VCH_1879000.pdf'] })).toBe(true);
    expect(isVoucherMail({ ...none, attachmentNames: ['Voucher-Smith.pdf'] })).toBe(true);
  });

  it('does not match ordinary mail, lowercase pop, POP3 or a keyword only in old quoted history', () => {
    expect(isVoucherMail({ ...none, bodyText: 'Please quote two rooms for 12 Nov.' })).toBe(false);
    expect(isVoucherMail({ ...none, bodyText: 'The pop-up blocker is on.' })).toBe(false);
    expect(isVoucherMail({ ...none, bodyText: 'Check your POP3 settings.' })).toBe(false);
    expect(isVoucherMail({ ...none, bodyText: `${'x'.repeat(2100)} voucher from last year` })).toBe(
      false,
    );
    expect(isVoucherMail({ ...none, attachmentNames: ['Booking.pdf'] })).toBe(false);
  });
});

describe('voucher file choice', () => {
  it('prefers a voucher-named file, then a PDF, then the first file, never an inline part', () => {
    const named = file('a', 'logo.png');
    const pdf = file('b', 'receipt.pdf');
    const voucher = file('c', 'Smith_VCH_1.pdf');
    expect(pickVoucherFile([named, pdf, voucher])?.id).toBe('c');
    expect(pickVoucherFile([named, pdf])?.id).toBe('b');
    expect(pickVoucherFile([named])?.id).toBe('a');
    expect(pickVoucherFile([file('i', 'Smith_VCH_1.pdf', { isInline: true }), pdf])?.id).toBe('b');
    expect(pickVoucherFile([])).toBeNull();
  });
});

describe('arrival dates', () => {
  it('reads ISO, day-first and month-name dates as real days', () => {
    expect(dayFromText('2026-11-12')).toBe('2026-11-12');
    expect(dayFromText('12/11/2026')).toBe('2026-11-12');
    expect(dayFromText('12.11.2026')).toBe('2026-11-12');
    expect(dayFromText('12 Nov 2026')).toBe('2026-11-12');
    expect(dayFromText('Thursday 12th November, 2026')).toBe('2026-11-12');
    expect(dayFromText('November 12, 2026')).toBe('2026-11-12');
  });

  it('refuses dates that do not exist, dates without a year, and text with no date', () => {
    expect(dayFromText('31/02/2026')).toBeNull();
    expect(dayFromText('12 Nov')).toBeNull();
    expect(dayFromText('14:00 by the desk')).toBeNull();
  });
});

describe('guest surname', () => {
  it('takes the surname from the usual voucher forms', () => {
    expect(surnameFrom('Smith, John')).toBe('Smith');
    expect(surnameFrom('SMITH/JOHN MR')).toBe('SMITH');
    expect(surnameFrom('Mr John Smith')).toBe('Smith');
    expect(surnameFrom("Mrs Ann O'Neil-Brown")).toBe("O'Neil-Brown");
  });

  it('refuses values that are not a surname', () => {
    expect(surnameFrom('1879000')).toBeNull();
    expect(surnameFrom('J')).toBeNull();
    expect(surnameFrom('')).toBeNull();
  });
});

describe('guest and arrival from the voucher text', () => {
  it('reads both from the body', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest name: Smith, John\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Passenger: SMITH/JOHN MR\nCheck in: 12/11/2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'SMITH', arrival: '2026-11-12' });
  });

  it('uses the voucher PDF text when the body only says it is attached', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Please find the voucher attached.',
        attachmentTexts: ['GUEST: Smith, John\nARRIVAL DATE 2026-11-12\nROOMS 1'],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('leaves a field null when labelled lines disagree, instead of picking one', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nGuest: Jones\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: null, arrival: '2026-11-12' });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: 12 Nov 2026\n(earlier) Arrival: 08 Jun 2027',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('ignores company, agency and sender lines, and never returns a reference number', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText:
          'Company name: Tourvest Ltd\nAgency guest: Travel Co\nYour name: Shaun\nVoucher 1879000\nGuest: Smith\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
    const result = extractVoucherGuest({
      subject: 'Voucher 1879000',
      bodyText: 'Reference 1879000. Guest: Smith. Arrival: 12 Nov 2026',
      attachmentTexts: ['Billing ref 1879000'],
    });
    expect(result).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
    expect(Object.keys(result).sort()).toEqual(['arrival', 'lastName']);
  });

  it('returns nulls when the email gives nothing labelled', () => {
    expect(
      extractVoucherGuest({
        subject: 'POP',
        bodyText: 'Please see attached.',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: null, arrival: null });
  });
});
