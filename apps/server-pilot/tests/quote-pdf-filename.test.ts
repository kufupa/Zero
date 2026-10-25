import { describe, expect, it } from 'vitest';
import {
  quoteFollowUpBody,
  quotePdfFileName,
  quotePdfPartyName,
  quotePdfSenderDisplayName,
  quotePropertyIdentity,
  retargetQuotePdfFileName,
} from '../src/quote-proposal/filename.js';
import { proposalDescription } from '../src/quote-proposal/description.js';

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
        'Quote - Quote 26 October - 18 November 2026 (abcd1234).pdf',
        'Jane Guest',
        '',
      ),
    ).toBe('Quote - Jane Guest 26 October - 18 November 2026 (abcd1234).pdf');
    expect(
      retargetQuotePdfFileName('Quote - Quote 12-14 October 2026 (abcd1234).pdf', 'Jane Smith', ''),
    ).toBe('Quote - Jane Smith 12-14 October 2026 (abcd1234).pdf');
    expect(
      retargetQuotePdfFileName('Quote - Acme 5 Star 12-14 October 2026.pdf', 'Jane Smith', 'Acme 5 Star'),
    ).toBe('Quote - Jane Smith 12-14 October 2026.pdf');
    expect(retargetQuotePdfFileName('Quote - Quote 12 Oct.pdf', 'A $$ $& Co', '')).toBe(
      'Quote - A $$ $& Co 12 Oct.pdf',
    );
  });
});

describe('quote property identity', () => {
  it('keeps Centurion letterhead and phone', () => {
    expect(quotePropertyIdentity('HRCEN')).toMatchObject({
      name: 'The Centurion Hotel',
      telephone: '0126433600',
      letterhead: 'centurion-template',
      websiteLabel: 'The Centurion Hotel Website',
    });
  });

  it('uses Da Vinci name and Sandton only, with no logo or Centurion phone', () => {
    const identity = quotePropertyIdentity('HRDAV');
    expect(identity).toMatchObject({
      name: 'Da Vinci Hotel and Suites',
      addressLines: ['Sandton'],
      telephone: null,
      websiteLabel: null,
      letterhead: 'none',
    });
    expect(identity.name).not.toMatch(/Centurion/i);
  });

  it('refuses an unknown property instead of falling back to Centurion', () => {
    expect(() => quotePropertyIdentity('HRXXX')).toThrow(/unknown_quote_property/);
  });

  it('names STWN by property so a shared HMS code is not the other hotel product', () => {
    expect(proposalDescription('STWN', 'bb', 'HRCEN')).toBe('Twin room Bed & Breakfast');
    expect(proposalDescription('STWN', 'bb', 'HRDAV')).toBe('Standard Twin room Bed & Breakfast');
    expect(proposalDescription('STKNG', 'room_only', 'HRDAV')).toBe('Standard King room Room Only');
    expect(() => proposalDescription('STKNG', 'bb', 'HRCEN')).toThrow(/unknown room code/);
    expect(() => proposalDescription('STQN', 'bb', 'HRDAV')).toThrow(/unknown room code/);
  });

  it('refuses to label a quote when its property is missing', () => {
    expect(() => proposalDescription('STWN', 'bb', undefined as unknown as string)).toThrow(
      'quote_property_required',
    );
  });

  it('puts the sending hotel in the 66h follow-up and never names the other property', () => {
    const centurion = quoteFollowUpBody('9 October', 'Reservations', 'HRCEN');
    expect(centurion).toContain('from The Centurion Hotel');
    expect(centurion).not.toContain('Da Vinci');
    const davinci = quoteFollowUpBody('9 October', 'Reservations', 'HRDAV');
    expect(davinci).toContain('from Da Vinci Hotel and Suites');
    expect(davinci).not.toContain('Centurion');
  });
});
