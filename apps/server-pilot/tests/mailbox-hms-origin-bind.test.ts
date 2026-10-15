import { findParty, panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import { bindCenturionHmsMailboxProperty } from '../src/hms/mailbox-hms-origin-bind.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('bindCenturionHmsMailboxProperty', () => {
  it('refuses Da Vinci fromAddress before any HRCEN bind', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: { fromAddress: 'davinci@legacyhotels.co.za' },
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });

  it('refuses Da Vinci identity on To of a Centurion-stored forward', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: {
          fromAddress: 'guest@example.invalid',
          toAddresses: [
            'centurion@legacyhotels.co.za',
            'davinci@legacyhotels.co.za',
          ],
        },
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });

  it('refuses a display-name wrapped Da Vinci mailbox and X-Zero-Mailbox stamp', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: {
          fromAddress: 'DAVINCI Reservations <davinci@legacyhotels.co.za>',
        },
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: { ownerHeaderValue: 'davinci@legacyhotels.co.za' },
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });

  it('does not default missing propertyCode to HRCEN, even from env', () => {
    vi.stubEnv('HMS_EXPECTED_PROPERTY_CODE', 'HRCEN');
    expect(
      bindCenturionHmsMailboxProperty({
        origin: { fromAddress: 'guest@example.invalid' },
      }),
    ).toEqual({ ok: false, code: 'READ_PROPERTY_CODE_REQUIRED' });
    vi.unstubAllEnvs();
  });

  it('binds explicit HRCEN for Centurion-origin mail', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: {
          fromAddress: 'guest@example.invalid',
          toAddresses: ['centurion@legacyhotels.co.za'],
        },
      }),
    ).toEqual({ ok: true, propertyCode: 'HRCEN' });
  });
});

describe('findParty Da Vinci origin', () => {
  afterEach(() => {
    panePartyLookupLoaders.lock = null;
    panePartyLookupLoaders.spawn = null;
    panePartyLookupLoaders.enabled = null;
  });

  it('refuses before any lock or spawn', async () => {
    const seen: string[] = [];
    panePartyLookupLoaders.lock = {
      withLock: async (fn) => {
        seen.push('lock');
        return fn();
      },
    };
    panePartyLookupLoaders.spawn = vi.fn(async () => {
      seen.push('spawn');
      return { outcome: 'resolved', candidates: [], truncated: false };
    });
    panePartyLookupLoaders.enabled = () => true;
    await expect(
      findParty(
        { name: 'Tourvest' },
        {
          origin: {
            fromAddress: 'guest@example.invalid',
            toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
          },
        },
      ),
    ).resolves.toEqual({
      outcome: 'refused_origin_mismatch',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    expect(seen).toEqual([]);
    expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
  });
});
