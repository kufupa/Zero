import { describe, expect, it } from 'vitest';
import { emailsMatch } from '../lib/quote-proposal/identity';
import { occupancyRoomCode, proposalDescription } from '../lib/quote-proposal/description';
import { lineTotal, quotePdfFileName } from '../lib/quote-proposal/filename';
import { HOTEL_TELEPHONE, quoteWrapperHtml } from '../lib/quote-proposal/copy';

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

  it('uses gold wrapper copy and hotel telephone', () => {
    expect(HOTEL_TELEPHONE).toBe('0126433600');
    const html = quoteWrapperHtml('David Miller', 'R Opperman');
    expect(html).toContain('Good day David Miller,');
    expect(html).toContain('Thank you for choosing The Centurion Hotel.');
    expect(html).toContain('Please see attached quotation.');
    expect(html).toContain(
      'Kindly sign and return the quotation to confirm. Please note that no rooms are currently being held.',
    );
    expect(html).toContain('Kind regards,');
    expect(html).toContain('R Opperman<br />Reservations<br />The Centurion Hotel');
    expect(html).not.toMatch(/ZAR/i);
    expect(html).not.toContain('<table');
  });

  it('uses a safe fallback greeting when the email has no sender name', () => {
    const html = quoteWrapperHtml('', 'R Opperman');

    expect(html).toContain('Good day Guest,');
    expect(html).toContain('R Opperman<br />Reservations<br />The Centurion Hotel');
  });
});
