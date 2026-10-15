import {
  dayFromText,
  extractVoucherGuest,
  isVoucherMail,
  pickVoucherFile,
  surnameFrom,
  voucherReadFiles,
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

  it('leaves a field null when labelled lines disagree, instead of picking one, and lists the values for staff', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nGuest: Jones\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({
      lastName: null,
      arrival: '2026-11-12',
      conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] },
    });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: 12 Nov 2026\n(earlier) Arrival: 08 Jun 2027',
        attachmentTexts: [],
      }),
    ).toEqual({
      lastName: 'Smith',
      arrival: null,
      conflicts: { lastNames: [], arrivals: ['2026-11-12', '2027-06-08'] },
    });
  });

  it('reads every labelled value on one line, so two guests or two arrivals on a line are a conflict', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith  Guest: Jones',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: null, arrival: null, conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] } });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith  Arrival: 12 Nov 2026  Arrival: 08 Jun 2027',
        attachmentTexts: [],
      }),
    ).toEqual({
      lastName: 'Smith',
      arrival: null,
      conflicts: { lastNames: [], arrivals: ['2026-11-12', '2027-06-08'] },
    });
  });

  it('a multi-word guest name keeps its surname when another label follows on the line', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Mary Smith  Arrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('a known field after the guest name ends the value, so the surname is kept', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith Meal plan: Breakfast\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('does not read an arrival phrase after a guest label as part of the surname', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: John Smith is arriving on 12 November\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('an unknown field after the guest name leaves the surname null, and never takes a word from the next field', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith Dietary requirement: vegetarian\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: null, arrival: '2026-11-12' });
  });

  it('a date after an unknown field is not read as the arrival', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: TBA Foo bar: 15 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('a company field on the same line does not hide the guest, because the exclusion is per field', () => {
    expect(
      extractVoucherGuest({ subject: 'Voucher', bodyText: 'Guest: Smith, John  Company: Acme', attachmentTexts: [] }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('a guest label that belongs to an agency phrase is skipped, and the next line still counts', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Agency guest: Travel Co\nArrival: 12 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: null, arrival: '2026-11-12' });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Agency guest: Travel Co\nGuest: Smith  Company: Acme',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('a departure label without a colon ends the arrival, so a departure date is never the arrival', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: TBA  Departure 15 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: TBA Departure 15 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('a known word after one space is part of the name when no colon or date follows it', () => {
    expect(
      extractVoucherGuest({ subject: 'Voucher', bodyText: 'Guest: Mary Price\nArrival: 12 Nov 2026', attachmentTexts: [] }),
    ).toEqual({ lastName: 'Price', arrival: '2026-11-12' });
  });

  it('a Surname or Last name label keeps the whole surname, not its last word', () => {
    expect(
      extractVoucherGuest({ subject: 'Voucher', bodyText: 'Surname: De la Rey\nArrival: 12 Nov 2026', attachmentTexts: [] }),
    ).toEqual({ lastName: 'De la Rey', arrival: '2026-11-12' });
    expect(
      extractVoucherGuest({ subject: 'Voucher', bodyText: 'Last name: Mr De la Rey', attachmentTexts: [] }),
    ).toEqual({ lastName: 'De la Rey', arrival: null });
  });

  it('a value stops at the next label, so a departure date is never read as the arrival', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith  Arrival: TBA  Departure: 15 Nov 2026',
        attachmentTexts: [],
      }),
    ).toEqual({ lastName: 'Smith', arrival: null });
  });

  it('a conflict across the email and the voucher PDF text is also left for staff', () => {
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: 12 Nov 2026',
        attachmentTexts: ['GUEST: Jones, Ann\nARRIVAL 2026-11-12'],
      }),
    ).toEqual({
      lastName: null,
      arrival: '2026-11-12',
      conflicts: { lastNames: ['Smith', 'Jones'], arrivals: [] },
    });
    // The same surname in another spelling is one guest, not a conflict.
    expect(
      extractVoucherGuest({
        subject: 'Voucher',
        bodyText: 'Guest: Smith\nArrival: 12 Nov 2026',
        attachmentTexts: ['GUEST: SMITH, John\nARRIVAL 2026-11-12'],
      }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
  });

  it('reads voucher files first, and only falls back to every PDF when no PDF is voucher-named', () => {
    const receipt1 = file('r1', 'receipt-1.pdf');
    const receipt2 = file('r2', 'receipt-2.pdf');
    const receipt3 = file('r3', 'receipt-3.pdf');
    const voucher = file('v', 'Smith_VCH_1879000.pdf');
    expect(voucherReadFiles([receipt1, receipt2, receipt3, voucher]).map((f) => f.id)).toEqual(['v']);
    expect(voucherReadFiles([receipt1, receipt2]).map((f) => f.id)).toEqual(['r1', 'r2']);
    expect(
      voucherReadFiles([file('i', 'Smith_VCH_1.pdf', { isInline: true }), file('p', 'logo.png'), receipt1]).map(
        (f) => f.id,
      ),
    ).toEqual(['r1']);
    expect(voucherReadFiles([])).toEqual([]);
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

describe('guest under a Client Details heading', () => {
  const read = (pdf: string) => extractVoucherGuest({ subject: 'Voucher', bodyText: 'Please find voucher attached', attachmentTexts: [pdf] });

  it('reads one guest on the line under the heading, with or without the hotel name first', () => {
    expect(read('Client Details\n   Proof Labtest (1 Pax) 0820000000\nCheck in: 12 Nov 2026')).toEqual({ lastName: 'Labtest', arrival: '2026-11-12' });
    expect(read('Client Details\nLABTEST/PROOF (1 Pax) 0820000000')).toEqual({ lastName: 'LABTEST', arrival: null });
    expect(read('Client Details\n\nThe Sample Hotel Proof Labtest Ms (1 Pax)')).toEqual({ lastName: 'Labtest', arrival: null });
  });

  it('gives no name without the pax anchor, or for more than one guest', () => {
    expect(read('Client Details\nProof Labtest 0820000000')).toEqual({ lastName: null, arrival: null });
    expect(read('Client Details\nProof Labtest (2 Pax)')).toEqual({ lastName: null, arrival: null });
    expect(read('Client Details\nProof Labtest & Mary Sample (1 Pax)')).toEqual({ lastName: null, arrival: null });
    expect(read('Client Details\nProof Mary Anne Jane Labtest Sample (1 Pax)')).toEqual({ lastName: null, arrival: null });
  });

  it('gives no name when the heading line itself carries text, such as an agency name', () => {
    expect(read('Client Details  Sample Travel\nProof Labtest (1 Pax)')).toEqual({ lastName: null, arrival: null });
  });

  it('lists both names for staff when the heading and a Guest label disagree', () => {
    expect(read('Client Details\nProof Labtest (1 Pax)\nGuest: Sample')).toEqual({
      lastName: null,
      arrival: null,
      conflicts: { lastNames: ['Labtest', 'Sample'], arrivals: [] },
    });
  });
});
