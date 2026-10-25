import { describe, expect, it } from 'vitest';
import { emailsMatch } from '../lib/quote-proposal/identity';
import { occupancyRoomCode, proposalDescription } from '../lib/quote-proposal/description';
import { lineTotal, quotePdfFileName } from '../lib/quote-proposal/filename';
import {
  HOTEL_TELEPHONE,
  missingQuoteDetailsWrapperHtml,
  quotePropertyCodeForTransport,
  quoteHotelName,
  quoteWrapperHtml,
} from '../lib/quote-proposal/copy';

describe('quote proposal helpers', () => {
  it('matches Nava and Outlook emails case-insensitively', () => {
    expect(emailsMatch('ROpperman@legacyhotels.co.za', 'ropperman@legacyhotels.co.za')).toBe(true);
    expect(emailsMatch('kdouglas@legacyhotels.co.za', 'centurion@legacyhotels.co.za')).toBe(false);
    expect(emailsMatch('', 'centurion@legacyhotels.co.za')).toBe(false);
  });

  it('maps HMS codes and quoted meals onto staff DESCRIPTION text', () => {
    const rooms = [
      ['STWN', 'Standard Twin'],
      ['STQN', 'Standard Queen'],
      ['SKNG', 'Standard King'],
      ['EXKNG', 'Executive King'],
      ['DLXTWN', 'Deluxe Twin'],
      ['DLXQN', 'Deluxe Queen'],
      ['DLXKNG', 'Deluxe King'],
      ['LUXKNG', 'Luxury King'],
      ['SUITE', 'Suite'],
    ] as const;
    for (const [code, name] of rooms) {
      expect(proposalDescription(code, 'bb')).toBe(`${name} room Bed & Breakfast`);
    }
    expect(proposalDescription('STQN', 'dinner_bb')).toBe('Standard Queen room Dinner Bed & Breakfast');
    expect(proposalDescription('STWN', 'room_only')).toBe('Standard Twin room Room Only');
    expect(occupancyRoomCode('single')).toBe('STQN');
    expect(occupancyRoomCode('twin')).toBe('STWN');
  });

  it('builds gold Quote filename and LINE TOTAL', () => {
    expect(quotePdfFileName('CIDB', '15-17 Sep')).toBe('Quote - CIDB 15-17 Sep.pdf');
    expect(lineTotal(2, 2, 2150)).toBe(8600);
  });

  it('maps known hotel transports and refuses empty or unknown transport IDs', () => {
    expect(quotePropertyCodeForTransport('transport-davinci')).toBe('HRDAV');
    expect(quotePropertyCodeForTransport('transport-kmgidi')).toBe('HRDAV');
    expect(quotePropertyCodeForTransport('transport-centurion')).toBe('HRCEN');
    expect(quotePropertyCodeForTransport(undefined)).toBeNull();
    expect(quotePropertyCodeForTransport('')).toBeNull();
    expect(quotePropertyCodeForTransport('transport-unknown')).toBeNull();
    expect(quoteHotelName(null)).toBe('the hotel');
  });

  it('uses Da Vinci name on the cover and never Centurion copy', () => {
    const html = quoteWrapperHtml('David Miller', 'R Opperman', { propertyCode: 'HRDAV' });
    expect(html).toContain('Thank you for Choosing Da Vinci Hotel and Suites.');
    expect(html).toContain('Reservations<br />Da Vinci Hotel and Suites');
    expect(html).not.toMatch(/Centurion/i);
  });

  it('uses gold wrapper copy and hotel telephone', () => {
    expect(HOTEL_TELEPHONE).toBe('0126433600');
    const html = quoteWrapperHtml('David Miller', 'R Opperman', { propertyCode: 'HRCEN' });
    expect(html).toContain('Good day David Miller,');
    expect(html).toContain('Thank you for Choosing The Centurion Hotel.');
    expect(html).toContain('Please see attached quotation.');
    expect(html).toContain(
      'Should you wish to proceed, please sign and return the attached quotation so that we can confirm and secure your reservation.',
    );
    expect(html).toContain('Kind regards,');
    expect(html).toContain('R Opperman<br />Reservations<br />The Centurion Hotel');
    expect(html).not.toMatch(/ZAR/i);
    expect(html).not.toContain('<table');
  });

  it('matches staff-sent quote cover wording without changing the editable reply', () => {
    const html = quoteWrapperHtml('Guest', 'Reservations Team', { propertyCode: 'HRCEN' });
    expect(html).toContain('Thank you for Choosing The Centurion Hotel.');
    expect(html).toContain('Should you wish to proceed, please sign and return the attached quotation so that we can confirm and secure your reservation.');
    expect(html).toContain('bookings will only be confirmed once we have received the signed quotation.');
    expect(html).toContain('Please feel free to contact me should you require any further information');
  });

  it('uses a safe fallback greeting when the email has no sender name', () => {
    const html = quoteWrapperHtml('', 'R Opperman', { propertyCode: 'HRCEN' });

    expect(html).toContain('Good day Guest,');
    expect(html).toContain('R Opperman<br />Reservations<br />The Centurion Hotel');
  });

  it('does not assume Centurion branding when the property is missing', () => {
    const html = quoteWrapperHtml('Guest', 'Reservations Team');

    expect(html).toContain('Thank you for Choosing the hotel.');
    expect(html).toContain('Reservations<br />the hotel');
    expect(html).not.toMatch(/Centurion/i);
  });

  it('keeps dinner pricing in the attachment, not the cover reply', () => {
    const html = quoteWrapperHtml('David Miller', 'R Opperman', {
      dinnerAddOn: {
        label: 'Set menu',
        amountMinor: 35_000,
        unit: 'per_person_per_night',
        totalMinor: 210_000,
      },
      totalMinor: 840_000,
    });

    expect(html).toContain('Please see attached quotation.');
    expect(html).not.toContain('Set menu');
    expect(html).not.toContain('R350.00');
    expect(html).not.toContain('R2100.00');
    expect(html).not.toContain('R8400.00');
  });

  it('asks only for missing quote details without claiming a quotation is attached', () => {
    const html = missingQuoteDetailsWrapperHtml(
      'David <Miller>',
      ['Arrival date for stay 1', 'Number of rooms and occupancy per room for stay 1'],
      'R Opperman & Co',
    );

    expect(html).toContain('Good day David &lt;Miller&gt;,');
    expect(html).toContain('Please confirm the following details so we can prepare your quotation');
    expect(html).toContain('<li>Arrival date for stay 1</li>');
    expect(html).toContain('<li>Number of rooms and occupancy per room for stay 1</li>');
    expect(html).toContain('R Opperman &amp; Co<br />Reservations');
    expect(html).not.toMatch(/attached quotation|quotation attached|PDF/i);
  });
});
