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
    expect(proposalDescription('DLXKNG', 'bb')).toBe('Deluxe room Bed & Breakfast');
    expect(proposalDescription('STQN', 'dinner_bb')).toBe('Single room Dinner Bed & Breakfast');
    expect(proposalDescription('STWN', 'room_only')).toBe('Twin room Room Only');
    expect(proposalDescription('LUXKNG', 'bb')).toBe('Luxury room Bed & Breakfast');
    expect(proposalDescription('SUITE', 'bb')).toBe('Suite room Bed & Breakfast');
    expect(proposalDescription('EXKNG', 'bb')).toBe('Single room Bed & Breakfast');
    expect(occupancyRoomCode('single')).toBe('STQN');
    expect(occupancyRoomCode('twin')).toBe('STWN');
  });

  it('builds gold Quote filename and LINE TOTAL', () => {
    expect(quotePdfFileName('CIDB', '15-17 Sep')).toBe('Quote - CIDB 15-17 Sep.pdf');
    expect(lineTotal(2, 2, 2150)).toBe(8600);
  });

  it('uses gold wrapper copy and hotel telephone', () => {
    expect(HOTEL_TELEPHONE).toBe('0126433600');
    const html = quoteWrapperHtml('David');
    expect(html).toContain('Good day David,');
    expect(html).toContain('Thank you for Choosing The Centurion Hotel.');
    expect(html).toContain('Please see attached quotation.');
    expect(html).toContain('no rooms are currently being held');
    expect(html).toContain('Kind regards,');
    expect(html).not.toMatch(/ZAR/i);
    expect(html).not.toContain('<table');
  });
});
