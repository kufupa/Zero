import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  DAVINCI_STAFF_TRANSPORT_IDS,
} from '../src/hms/hms-read-target.js';
import { bindCenturionHmsMailboxProperty } from '../src/hms/mailbox-hms-origin-bind.js';
import { hmsDavinciMakeQuoteEnabled } from '../src/env.js';
import { PropertyRefusalCause } from '../src/hms/property-refusal.js';
import {
  DAVINCI_QUOTE_REFUSED_MESSAGE,
  assertHmsQuoteOriginAllowed,
  quoteTargetForHmsJob,
  quoteTargetForTransport,
} from '../src/hms/hms-quote-target.js';

const DAVINCI_ORIGIN = { toAddresses: ['davinci@legacyhotels.co.za'] } as const;
const CENTURION_ORIGIN = {
  fromAddress: 'guest@example.invalid',
  toAddresses: ['centurion@legacyhotels.co.za'],
} as const;
const EXTERNAL_GUEST_ORIGIN = { fromAddress: 'guest@example.invalid' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hmsDavinciMakeQuoteEnabled', () => {
  it('is off unless the env is the exact value on', () => {
    expect(hmsDavinciMakeQuoteEnabled({})).toBe(false);
    expect(hmsDavinciMakeQuoteEnabled({ HMS_DAVINCI_MAKE_QUOTE: 'true' })).toBe(false);
    expect(hmsDavinciMakeQuoteEnabled({ HMS_DAVINCI_MAKE_QUOTE: '1' })).toBe(false);
    expect(hmsDavinciMakeQuoteEnabled({ HMS_DAVINCI_MAKE_QUOTE: 'off' })).toBe(false);
    expect(hmsDavinciMakeQuoteEnabled({ HMS_DAVINCI_READS: 'on' })).toBe(false);
    expect(hmsDavinciMakeQuoteEnabled({ HMS_DAVINCI_MAKE_QUOTE: 'on' })).toBe(true);
  });
});

describe('quoteTargetForTransport', () => {
  it('maps every Da Vinci staff transport to HRDAV only when the quote flag is on', () => {
    expect(DAVINCI_STAFF_TRANSPORT_IDS).toEqual([
      'transport-davinci',
      'transport-faith',
      'transport-ayanda',
      'transport-epick',
      'transport-kmgidi',
    ]);
    for (const transportId of DAVINCI_STAFF_TRANSPORT_IDS) {
      expect(quoteTargetForTransport(transportId, {})).toEqual({
        ok: false,
        code: 'QUOTE_DAVINCI_DISABLED',
        message: DAVINCI_QUOTE_REFUSED_MESSAGE,
      });
      expect(
        quoteTargetForTransport(transportId, { HMS_DAVINCI_MAKE_QUOTE: 'on' }),
      ).toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
    }
  });

  it('leaves Centurion on HRCEN whether the quote flag is on or off', () => {
    expect(quoteTargetForTransport('transport-centurion', {})).toEqual({
      ok: true,
      target: CENTURION_HMS_READ_TARGET,
    });
    expect(
      quoteTargetForTransport('transport-centurion', { HMS_DAVINCI_MAKE_QUOTE: 'on' }),
    ).toEqual({ ok: true, target: CENTURION_HMS_READ_TARGET });
  });

  it('refuses unknown and collector transports instead of treating them as Centurion', () => {
    for (const [transportId, code] of [
      ['transport-unknown', 'property_unknown'],
      ['transport-nava', 'collector_no_hotel'],
    ]) {
      let error: unknown;
      try {
        quoteTargetForTransport(transportId);
      } catch (caught) {
        error = caught;
      }
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(PropertyRefusalCause);
      expect(error).toMatchObject({ cause: { code } });
    }
    expect(() => quoteTargetForHmsJob({ transportId: 'transport-unknown' })).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ code: 'property_unknown' }) }),
    );
  });
});

describe('quoteTargetForHmsJob', () => {
  it('flag off blocks Da Vinci origin and Da Vinci transport', () => {
    expect(
      quoteTargetForHmsJob({ transportId: 'transport-centurion', origin: DAVINCI_ORIGIN }),
    ).toEqual({
      ok: false,
      code: 'QUOTE_DAVINCI_DISABLED',
      message: DAVINCI_QUOTE_REFUSED_MESSAGE,
    });
    expect(
      quoteTargetForHmsJob({ transportId: 'transport-davinci', origin: CENTURION_ORIGIN }),
    ).toMatchObject({ ok: false, code: 'QUOTE_DAVINCI_DISABLED' });
    expect(
      quoteTargetForHmsJob({ transportId: 'transport-faith', origin: EXTERNAL_GUEST_ORIGIN }),
    ).toMatchObject({ ok: false, code: 'QUOTE_DAVINCI_DISABLED' });
  });

  it('flag on: five DV transports and DV origin resolve HRDAV; Centurion stays HRCEN', () => {
    const env = { HMS_DAVINCI_MAKE_QUOTE: 'on' };
    for (const transportId of DAVINCI_STAFF_TRANSPORT_IDS) {
      expect(quoteTargetForHmsJob({ transportId, origin: EXTERNAL_GUEST_ORIGIN, env })).toEqual({
        ok: true,
        target: DAVINCI_HMS_READ_TARGET,
      });
    }
    expect(
      quoteTargetForHmsJob({
        transportId: 'transport-centurion',
        origin: DAVINCI_ORIGIN,
        env,
      }),
    ).toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
    expect(
      quoteTargetForHmsJob({
        transportId: 'transport-centurion',
        origin: CENTURION_ORIGIN,
        env,
      }),
    ).toEqual({ ok: true, target: CENTURION_HMS_READ_TARGET });
  });

  it('does not open Centurion write binds when the quote flag is on', () => {
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: DAVINCI_ORIGIN,
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: DAVINCI_ORIGIN,
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });
});

describe('assertHmsQuoteOriginAllowed', () => {
  it('throws the existing Da Vinci refuse when the quote flag is off', async () => {
    await expect(
      assertHmsQuoteOriginAllowed({
        transportId: 'transport-davinci',
        threadId: 'thread-dv',
        messageId: 'msg-dv',
        env: {},
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: DAVINCI_QUOTE_REFUSED_MESSAGE,
    });
  });

  it('returns HRDAV for a Da Vinci transport when the quote flag is on', async () => {
    await expect(
      assertHmsQuoteOriginAllowed({
        transportId: 'transport-ayanda',
        threadId: 'thread-dv',
        messageId: 'msg-dv',
        env: { HMS_DAVINCI_MAKE_QUOTE: 'on' },
      }),
    ).resolves.toEqual(DAVINCI_HMS_READ_TARGET);
  });
});
