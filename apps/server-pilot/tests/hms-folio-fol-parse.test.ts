import { describe, expect, it } from 'vitest';
import { parseFolioFolTransport } from '../src/hms/folio-fol-parse.js';

describe('parseFolioFolTransport', () => {
  it('extracts balance + currency from pageData GRID row', () => {
    const text = JSON.stringify({
      pageData: {
        success: true,
        grid: {
          GRIDRESULT: {
            GRID: {
              DATA: [{ balance: '12.00', balancecurr: 'ZAR' }],
            },
          },
        },
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBe('12.00');
    expect(parsed.currency).toBe('ZAR');
  });

  it('returns unavailable money for key-only folio flags', () => {
    const text = JSON.stringify({
      pageData: {
        success: true,
        folio: true,
        fields: { guestname: 'X' },
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.totalBalance).toBeNull();
    expect(parsed.currency).toBeNull();
  });

  it('rejects 813 stub as unrecognized envelope', () => {
    const stub = 'x'.repeat(813);
    const parsed = parseFolioFolTransport(stub);
    expect(parsed.envelopeRecognized).toBe(false);
    expect(parsed.totalBalance).toBeNull();
  });

  it('flags card leak and still parses money when present', () => {
    const text = JSON.stringify({
      pageData: {
        foliobalance: '99.00',
        propertycurrency: 'USD',
        cardnumber: '4111111111111111',
      },
    });
    const parsed = parseFolioFolTransport(text);
    expect(parsed.hasCardLeak).toBe(true);
    expect(parsed.totalBalance).toBe('99.00');
    expect(parsed.currency).toBe('USD');
  });
});
