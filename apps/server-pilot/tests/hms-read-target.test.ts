import { userPartyIdempotencyKey } from '../src/ai/hms-jobs.js';
import { bindCenturionHmsMailboxProperty } from '../src/hms/mailbox-hms-origin-bind.js';
import { findParty, panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  DAVINCI_ORIGIN_REFUSED_MESSAGE,
  DAVINCI_STAFF_TRANSPORT_IDS,
  hmsDavinciReadsEnabled,
  hmsReadTargetForTransport,
  hmsReadTargetJobMetrics,
  parseHmsReadTarget,
  readTargetForHmsJob,
} from '../src/hms/hms-read-target.js';
import { paneStaySpawnEnv } from '../src/ai/pane-stay-spawn-env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DAVINCI_ORIGIN = { toAddresses: ['davinci@legacyhotels.co.za'] } as const;
const CENTURION_ORIGIN = {
  fromAddress: 'guest@example.invalid',
  toAddresses: ['centurion@legacyhotels.co.za'],
} as const;
const EXTERNAL_GUEST_ORIGIN = { fromAddress: 'guest@example.invalid' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.enabled = null;
});

describe('hmsReadTargetForTransport', () => {
  it('resolves Centurion transport and origin to HRCEN and the existing read secret', () => {
    expect(hmsReadTargetForTransport('transport-centurion')).toEqual(CENTURION_HMS_READ_TARGET);
    expect(hmsReadTargetForTransport(CENTURION_ORIGIN)).toEqual(CENTURION_HMS_READ_TARGET);
    expect(CENTURION_HMS_READ_TARGET).toMatchObject({
      propertyCode: 'HRCEN',
      secretId: 'nava-zero/server-pilot/infor-hms-read',
      browserSlot: 'centurion',
    });
  });

  it('resolves every Da Vinci staff transport and origin to HRDAV', () => {
    for (const transportId of DAVINCI_STAFF_TRANSPORT_IDS) {
      expect(hmsReadTargetForTransport(transportId)).toEqual(DAVINCI_HMS_READ_TARGET);
    }
    expect(hmsReadTargetForTransport(DAVINCI_ORIGIN)).toEqual(DAVINCI_HMS_READ_TARGET);
    expect(hmsReadTargetForTransport({ fromAddress: 'davinci@legacyhotels.co.za' })).toEqual(
      DAVINCI_HMS_READ_TARGET,
    );
    expect(DAVINCI_HMS_READ_TARGET).toMatchObject({
      propertyCode: 'HRDAV',
      secretId: 'nava-zero/server-pilot/infor-hms-read-davinci',
      browserSlot: 'davinci',
    });
    expect(DAVINCI_HMS_READ_TARGET.browserSlot).not.toBe(CENTURION_HMS_READ_TARGET.browserSlot);
  });
});

describe('readTargetForHmsJob flag', () => {
  it('flag off (default) refuses Da Vinci origin the same way as #292', () => {
    expect(hmsDavinciReadsEnabled({})).toBe(false);
    expect(
      readTargetForHmsJob({ transportId: 'transport-centurion', origin: DAVINCI_ORIGIN }),
    ).toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: DAVINCI_ORIGIN_REFUSED_MESSAGE,
    });
    expect(
      readTargetForHmsJob({ transportId: 'transport-davinci', origin: CENTURION_ORIGIN }),
    ).toMatchObject({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: DAVINCI_ORIGIN,
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });

  it('flag on: Da Vinci job metrics carry the HRDAV target; Centurion stays the Centurion target', () => {
    const env = { HMS_DAVINCI_READS: 'on' };
    expect(hmsDavinciReadsEnabled(env)).toBe(true);
    const davinci = readTargetForHmsJob({
      transportId: 'transport-centurion',
      origin: DAVINCI_ORIGIN,
      env,
    });
    expect(davinci).toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
    expect(hmsReadTargetJobMetrics(davinci.ok ? davinci.target : CENTURION_HMS_READ_TARGET)).toEqual({
      hmsReadTarget: DAVINCI_HMS_READ_TARGET,
    });

    const centurion = readTargetForHmsJob({
      transportId: 'transport-centurion',
      origin: CENTURION_ORIGIN,
      env,
    });
    expect(centurion).toEqual({ ok: true, target: CENTURION_HMS_READ_TARGET });
    expect(hmsReadTargetJobMetrics(CENTURION_HMS_READ_TARGET)).toBeNull();

    expect(
      bindCenturionHmsMailboxProperty({
        propertyCode: 'HRCEN',
        origin: DAVINCI_ORIGIN,
      }),
    ).toEqual({ ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED' });
  });

  it('faith transport + external guest origin: flag on → HRDAV; flag off → refused', () => {
    expect(
      readTargetForHmsJob({ transportId: 'transport-faith', origin: EXTERNAL_GUEST_ORIGIN }),
    ).toEqual({
      ok: false,
      code: 'READ_DAVINCI_ORIGIN_REFUSED',
      message: DAVINCI_ORIGIN_REFUSED_MESSAGE,
    });
    expect(
      readTargetForHmsJob({
        transportId: 'transport-faith',
        origin: EXTERNAL_GUEST_ORIGIN,
        env: { HMS_DAVINCI_READS: 'on' },
      }),
    ).toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
  });
});

describe('parseHmsReadTarget', () => {
  it('accepts only the frozen Centurion and Da Vinci targets', () => {
    expect(parseHmsReadTarget(DAVINCI_HMS_READ_TARGET)).toEqual(DAVINCI_HMS_READ_TARGET);
    expect(parseHmsReadTarget(CENTURION_HMS_READ_TARGET)).toEqual(CENTURION_HMS_READ_TARGET);
    expect(
      parseHmsReadTarget({
        ...DAVINCI_HMS_READ_TARGET,
        secretId: 'nava-zero/server-pilot/infor-hms-read',
      }),
    ).toBeNull();
    expect(parseHmsReadTarget({ propertyCode: 'HRDAV' })).toBeNull();
  });
});

describe('worker secret resolution by target', () => {
  it('Da Vinci slot uses the HRDAV secret name and its own CDP, never Centurion CDP or the save gate', () => {
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        AWS_REGION: 'af-south-1',
        HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
        HMS_QUOTE_SECRET_PATH: '/repo/.private/owner/secret.json',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        HMS_STAGEHAND_CDP_URL_DAVINCI: 'http://127.0.0.1:19225',
        RESERVATIONIST_PANE_SAVE: 'on',
      },
      () => {
        throw new Error('centurion installation must not be read for HRDAV');
      },
      DAVINCI_HMS_READ_TARGET,
    );
    expect(env.HMS_READ_SECRET_ARN).toBe('nava-zero/server-pilot/infor-hms-read-davinci');
    expect(env.HMS_STAGEHAND_CDP_URL).toBe('http://127.0.0.1:19225');
    expect(env.HMS_STAGEHAND_BROWSER_OWNERSHIP).toBe('borrowed');
    expect(env.HMS_QUOTE_SECRET_PATH).toBeUndefined();
    expect(env.RESERVATIONIST_PANE_SAVE).toBeUndefined();
    expect(env.HMS_STAGEHAND_CDP_URL).not.toBe('http://127.0.0.1:19223');
  });

  it('Da Vinci with no HMS_STAGEHAND_CDP_URL_DAVINCI returns no CDP URL', () => {
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        HMS_QUOTE_SECRET_PATH: '/repo/.private/owner/secret.json',
      },
      () => {
        throw new Error('centurion installation must not be read for HRDAV');
      },
      DAVINCI_HMS_READ_TARGET,
    );
    expect(env.HMS_STAGEHAND_CDP_URL).toBeUndefined();
    expect(env.HMS_READ_SECRET_ARN).toBe('nava-zero/server-pilot/infor-hms-read-davinci');
    expect(env.HMS_QUOTE_SECRET_PATH).toBeUndefined();
  });

  it('Centurion spawn env is unchanged when no Da Vinci target is passed', () => {
    const env = paneStaySpawnEnv(
      { PATH: '/usr/bin', HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read' },
      () => ({
        tenantId: 'tenant-1',
        owner: {
          cdpUrl: 'http://127.0.0.1:19223',
          browserOwnership: 'borrowed',
          propertyCode: 'HRCEN',
          secretPath: '/repo/.private/owner/secret.json',
        },
        outputDir: '/repo/.private/playwright-quote/out',
        ratePolicyConfigurationPath: '/repo/.private/rate-policy.json',
      }),
      CENTURION_HMS_READ_TARGET,
    );
    expect(env).toMatchObject({
      HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
      HMS_QUOTE_SECRET_PATH: '/repo/.private/owner/secret.json',
    });
  });
});

describe('findParty flag', () => {
  it('flag off: Da Vinci origin still refuses before lock or spawn', async () => {
    const seen: string[] = [];
    panePartyLookupLoaders.lock = { withLock: async (fn) => { seen.push('lock'); return fn(); } };
    panePartyLookupLoaders.spawn = vi.fn(async () => {
      seen.push('spawn');
      return { outcome: 'resolved', candidates: [], truncated: false };
    });
    panePartyLookupLoaders.enabled = () => true;
    await expect(findParty({ name: 'Tourvest' }, { origin: DAVINCI_ORIGIN })).resolves.toMatchObject({
      outcome: 'refused_origin_mismatch',
    });
    expect(seen).toEqual([]);
  });

  it('flag on: Da Vinci origin is not refused so the HRDAV job can run', async () => {
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    const seen: string[] = [];
    panePartyLookupLoaders.lock = { withLock: async (fn) => { seen.push('lock'); return fn(); } };
    panePartyLookupLoaders.spawn = vi.fn(async () => {
      seen.push('spawn');
      return { outcome: 'no_match', candidates: [], truncated: false };
    });
    panePartyLookupLoaders.enabled = () => true;
    await expect(
      findParty({ name: 'Tourvest', kind: 'company' }, { origin: DAVINCI_ORIGIN }),
    ).resolves.toMatchObject({ outcome: 'no_match' });
    expect(seen[0]).toBe('lock');
    expect(panePartyLookupLoaders.spawn).toHaveBeenCalled();
  });

  it('overlapping Centurion and Da Vinci lookups keep distinct targets across a lock wait', async () => {
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    const captured: string[] = [];
    let waiting = 0;
    let bothWaiting!: () => void;
    const bothInside = new Promise<void>((resolve) => {
      bothWaiting = resolve;
    });
    let releaseLock!: () => void;
    const lockHold = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    panePartyLookupLoaders.lock = {
      withLock: async (fn) => {
        waiting += 1;
        if (waiting === 2) bothWaiting();
        await lockHold;
        return fn();
      },
    };
    panePartyLookupLoaders.spawn = vi.fn(async (input: { kind: string; name: string; target?: { propertyCode?: string } }) => {
      captured.push(input.target?.propertyCode ?? 'MISSING');
      return { outcome: 'no_match', candidates: [], truncated: false };
    });
    panePartyLookupLoaders.enabled = () => true;
    const davinci = findParty(
      { name: 'Tourvest', kind: 'company' },
      { origin: DAVINCI_ORIGIN, target: DAVINCI_HMS_READ_TARGET },
    );
    const centurion = findParty(
      { name: 'Tourvest', kind: 'company' },
      { origin: CENTURION_ORIGIN, target: CENTURION_HMS_READ_TARGET },
    );
    await bothInside;
    releaseLock();
    await Promise.all([davinci, centurion]);
    expect([...captured].sort()).toEqual(['HRDAV', 'HRCEN'].sort());
  });
});

describe('userPartyIdempotencyKey', () => {
  const request = { kind: 'party' as const, name: 'Tourvest', partyKind: 'company' as const };
  const day = '2026-10-18';

  it('same party name on two properties yields two keys', () => {
    const centurion = userPartyIdempotencyKey({
      transportId: 'transport-centurion',
      request,
      day,
      retry: false,
      propertyCode: 'HRCEN',
    });
    const davinci = userPartyIdempotencyKey({
      transportId: 'transport-faith',
      request,
      day,
      retry: false,
      propertyCode: 'HRDAV',
    });
    expect(centurion).not.toBe(davinci);
    expect(centurion).toContain('HRCEN');
    expect(davinci).toContain('HRDAV');
  });

  it('same property, same name, same day reuses one key', () => {
    const first = userPartyIdempotencyKey({
      transportId: 'transport-centurion',
      request: { kind: 'party', name: '  Tourvest  ', partyKind: 'company' },
      day,
      retry: false,
      propertyCode: 'HRCEN',
    });
    const second = userPartyIdempotencyKey({
      transportId: 'transport-centurion',
      request,
      day,
      retry: false,
      propertyCode: 'HRCEN',
    });
    expect(first).toBe(second);
  });
});
