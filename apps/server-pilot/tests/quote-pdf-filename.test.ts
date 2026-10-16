import { describe, expect, it } from 'vitest';
import {
  quotePdfFileName,
  quotePdfPartyName,
  quotePdfSenderDisplayName,
  retargetQuotePdfFileName,
} from '../src/quote-proposal/filename.js';

describe('quote PDF filename party', () => {
  it('uses agency, then company, then guest, then sender display name', () => {
    expect(quotePdfPartyName('CIDB', 'Treasury', 'Jane Guest', 'Jane From')).toBe('CIDB');
    expect(quotePdfPartyName('  ', 'Treasury', 'Jane Guest', 'Jane From')).toBe('Treasury');
    expect(quotePdfPartyName('', '', 'Jane Guest', 'Jane From')).toBe('Jane Guest');
    expect(quotePdfPartyName('', '', '', 'Jane From')).toBe('Jane From');
  });

  it('never falls back to Guest', () => {
    expect(quotePdfPartyName('', '  ', null, undefined)).toBe('Quote');
    expect(quotePdfFileName('', '12-14 Oct')).not.toContain('Guest');
    expect(quotePdfFileName('', '12-14 Oct')).toBe('Quote - Quote 12-14 Oct.pdf');
  });

  it('reads a sender display name from a From header and ignores a bare address', () => {
    expect(quotePdfSenderDisplayName('Jane Guest <jane@city.gov.za>')).toBe('Jane Guest');
    expect(quotePdfSenderDisplayName('"Acme Travel" <desk@acme.test>')).toBe('Acme Travel');
    expect(quotePdfSenderDisplayName('jane@city.gov.za')).toBe('');
  });

  it('retargets a built PDF name without changing the stay span or option id', () => {
    expect(
      retargetQuotePdfFileName(
        'Quote - Guest 26 October - 18 November 2026 (abcd1234).pdf',
        'Jane Guest',
      ),
    ).toBe('Quote - Jane Guest 26 October - 18 November 2026 (abcd1234).pdf');
  });
});
