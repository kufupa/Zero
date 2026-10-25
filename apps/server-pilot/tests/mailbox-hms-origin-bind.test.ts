import { findParty, panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import {
  AYANDA_MAILBOX_IDENTITIES,
  bindCenturionHmsMailboxProperty,
  CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  EPICK_MAILBOX_IDENTITIES,
  FAITH_MAILBOX_IDENTITIES,
  guardCenturionHmsMailboxOrigin,
  KMGIDI_MAILBOX_IDENTITIES,
  mailboxHmsOriginBindLoaders,
} from '../src/hms/mailbox-hms-origin-bind.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DAVINCI_STAFF_TRANSPORT_ORIGIN = [
  { transportId: 'transport-faith', ownerHeaderValue: FAITH_MAILBOX_IDENTITIES[0] },
  { transportId: 'transport-ayanda', ownerHeaderValue: AYANDA_MAILBOX_IDENTITIES[0] },
  { transportId: 'transport-epick', ownerHeaderValue: EPICK_MAILBOX_IDENTITIES[0] },
  { transportId: 'transport-kmgidi', ownerHeaderValue: KMGIDI_MAILBOX_IDENTITIES[0] },
] as const;

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

  it('refuses a property code that is not registered', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRFAKE',
        origin: { toAddresses: ['centurion@legacyhotels.co.za'] },
      }),
    ).toEqual({ ok: false, code: 'READ_PROPERTY_UNKNOWN' });
  });
});

describe('guardCenturionHmsMailboxOrigin', () => {
  afterEach(() => {
    mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  });

  it('refuses Da Vinci-origin with the pane message', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
    });
    await expect(
      guardCenturionHmsMailboxOrigin({ transportId: 'transport-1', threadId: 'thread-dv' }),
    ).resolves.toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(CENTURION_HMS_ORIGIN_REFUSED_MESSAGE).toBe(
      'This mail is for Da Vinci — Centurion HMS not searched',
    );
  });

  it('allows Centurion-origin', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za'],
    });
    await expect(
      guardCenturionHmsMailboxOrigin({ transportId: 'transport-1', threadId: 'thread-cen' }),
    ).resolves.toEqual({ ok: true });
  });

  it('allows Centurion ownerHeaderValue even when From/To are external', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      ownerHeaderValue: 'centurion@legacyhotels.co.za',
      toAddresses: ['guest-desk@example.invalid'],
    });
    await expect(
      guardCenturionHmsMailboxOrigin({
        transportId: 'transport-centurion',
        threadId: 'thread-cen',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it.each([...DAVINCI_STAFF_TRANSPORT_ORIGIN])(
    'refuses $transportId when inbound From/To are external and ownerHeaderValue is the staff mailbox',
    async ({ transportId, ownerHeaderValue }) => {
      mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
        fromAddress: 'guest@example.invalid',
        ownerHeaderValue,
        toAddresses: ['guest-desk@example.invalid'],
      });
      await expect(
        guardCenturionHmsMailboxOrigin({ transportId, threadId: 'thread-staff' }),
      ).resolves.toEqual({
        ok: false,
        code: 'READ_DAVINCI_ORIGIN_REFUSED',
        message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
      });
    },
  );

  it('refuses when an older inbound is Da Vinci even if the newest inbound is Centurion', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
      selected: null,
      selectedFound: true,
      inbounds: [
        {
          fromAddress: 'guest@example.invalid',
          toAddresses: ['centurion@legacyhotels.co.za'],
        },
        {
          fromAddress: 'guest@example.invalid',
          toAddresses: ['davinci@legacyhotels.co.za'],
        },
      ],
    });
    await expect(
      guardCenturionHmsMailboxOrigin({ transportId: 'transport-1', threadId: 'thread-mixed' }),
    ).resolves.toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
  });

  it('refuses the selected message origin even when the newest inbound is Centurion', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async (input) => {
      expect(input.messageId).toBe('msg-older-dv');
      return {
        selected: {
          fromAddress: 'guest@example.invalid',
          toAddresses: ['davinci@legacyhotels.co.za'],
        },
        selectedFound: true,
        inbounds: [
          {
            fromAddress: 'guest@example.invalid',
            toAddresses: ['centurion@legacyhotels.co.za'],
          },
        ],
      };
    };
    await expect(
      guardCenturionHmsMailboxOrigin({
        transportId: 'transport-1',
        threadId: 'thread-mixed',
        messageId: 'msg-older-dv',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
  });

  it('refuses when the selected message id is missing from the thread', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
      selected: null,
      selectedFound: false,
      inbounds: [
        {
          fromAddress: 'guest@example.invalid',
          toAddresses: ['centurion@legacyhotels.co.za'],
        },
      ],
    });
    await expect(
      guardCenturionHmsMailboxOrigin({
        transportId: 'transport-1',
        threadId: 'thread-cen',
        messageId: 'msg-missing',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
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
