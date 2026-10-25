import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profileFor, propertySecretRefusal } from '../tooling/playwright-quote/property-profile.mjs';
import {
  buildPreflightResult,
  collectBlockers,
  formatBlocker,
  preflightExitCode,
  requestedAvailability,
  runCreatePreflight,
  sanitizeDom,
  shouldAbortReadOnlyRequest,
} from '../tooling/playwright-quote/create-preflight.mjs';

function clearSnapshot(extra: Record<string, unknown> = {}) {
  return {
    propertyCode: 'HRCEN',
    arrival: '2027-10-12',
    departure: '2027-10-13',
    profile: profileFor('HRCEN'),
    fields: [
      { name: 'lastname', value: 'Labtest', required: true, blank: false },
      { name: 'reservationnote', value: '', required: false, blank: true },
    ],
    availability: {
      searched: true,
      restricted: false,
      rateAvailable: true,
      inventory: 4,
      rows: [{ roomType: 'STQN', code: 'BAR', name: 'Best Available' }],
      nights: [{ date: '2027-10-12', restricted: false, rateAvailable: true, restrictions: { combClosed: false } }],
    },
    nav: ['Front Desk', 'Guest Stay', 'Hotel Availability', 'New Record'].map((name) => ({
      name,
      visible: true,
      inViewport: true,
    })),
    messages: [],
    duplicateSearch: { outcome: 'ok', rows: [] },
    dump: '<form><input name="lastname" value="Labtest"></form>',
    ...extra,
  };
}

describe('create preflight', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not opt into pilot RDS', () => {
    expect(process.env.VITEST_ALLOW_PILOT_RDS).not.toBe('1');
    expect(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || '')).toBe(false);
  });

  it('mask_timeout snapshot still writes preflight.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'create-preflight-mask-'));
    dirs.push(dir);
    const result = await runCreatePreflight({
      stay: { arrival: '2027-10-12', departure: '2027-10-13', lastName: 'Labtest' },
      propertyCode: 'HRDAV',
      snapshot: clearSnapshot({ propertyCode: 'HRDAV', captureError: 'mask_timeout' }),
      outDir: dir,
    });
    expect(result.clickedSave).toBe(false);
    expect(result.captureError).toBe('mask_timeout');
    const written = JSON.parse(await readFile(join(dir, 'preflight.json'), 'utf8'));
    expect(written.captureError).toBe('mask_timeout');
    expect(written.clickedSave).toBe(false);
  });

  it('all-clear reports no blockers and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'create-preflight-'));
    dirs.push(dir);
    const result = await runCreatePreflight({
      stay: { arrival: '2027-10-12', departure: '2027-10-13', lastName: 'Labtest' },
      propertyCode: 'HRCEN',
      snapshot: clearSnapshot(),
      outDir: dir,
    });
    expect(result.blockers).toEqual([]);
    expect(preflightExitCode(result)).toBe(0);
    expect(result.clickedSave).toBe(false);
    const written = JSON.parse(await readFile(join(dir, 'preflight.json'), 'utf8'));
    expect(written.clickedSave).toBe(false);
    expect(await readFile(join(dir, 'dump.html'), 'utf8')).toMatch(/<form>/);
    expect(sanitizeDom('<input value="a@b.co" data-qtip="61143613-1"><script>x</script>')).not.toContain('a@b.co');
  });

  it('restricted date is blocker:availability', () => {
    const labels = collectBlockers(
      clearSnapshot({
        availability: {
          searched: true,
          restricted: true,
          rows: [],
          nights: [{ date: '2027-10-12', restricted: true, rateAvailable: false, restrictions: { combClosed: true } }],
        },
      }),
    ).map(formatBlocker);
    expect(labels).toEqual(['blocker:availability']);
    expect(
      preflightExitCode({ blockers: collectBlockers(clearSnapshot({ availability: { restricted: true } })) }),
    ).toBe(2);
    const shop = requestedAvailability(
      [
        { roomType: 'STWN', code: 'BAR', restricted: true, inventory: 0 },
        { roomType: 'STQN', code: 'BAR', restricted: false, inventory: 4 },
      ],
      { roomType: 'STQN', ratePlan: 'BAR' },
    );
    expect(shop.restricted).toBe(false);
    expect(shop.inventory).toBe(4);
    expect(
      collectBlockers(clearSnapshot({ availability: { error: 'timeout', searched: false, rows: [] } })).map(formatBlocker),
    ).toEqual(['blocker:availability']);
    expect(preflightExitCode(buildPreflightResult(clearSnapshot({ captureError: 'fields' })))).toBe(2);
  });

  it('DV note blank is blocker:required_field reservationnote', () => {
    const labels = collectBlockers(
      clearSnapshot({
        propertyCode: 'HRDAV',
        profile: profileFor('HRDAV'),
        fields: [{ name: 'reservationnote', value: '', required: false, blank: true }],
      }),
    ).map(formatBlocker);
    expect(labels).toEqual(['blocker:required_field reservationnote']);
  });

  it('required fields come from profile.requiredCreateFields, not an HRDAV special case', () => {
    const davEmpty = collectBlockers(
      clearSnapshot({
        propertyCode: 'HRDAV',
        profile: { requiredCreateFields: [] },
        fields: [{ name: 'reservationnote', value: '', required: false, blank: true }],
      }),
    ).map(formatBlocker);
    expect(davEmpty).toEqual([]);
    const cenNote = collectBlockers(
      clearSnapshot({
        propertyCode: 'HRCEN',
        profile: { requiredCreateFields: ['reservationnote'] },
        fields: [{ name: 'reservationnote', value: '', required: false, blank: true }],
      }),
    ).map(formatBlocker);
    expect(cenNote).toEqual(['blocker:required_field reservationnote']);
  });

  it('propertySecretRefusal names the requested hotel, never falls through to HRCEN', () => {
    expect(propertySecretRefusal({ expectedPropertyCode: 'HRDAV' }, 'HRDAV')).toBeNull();
    expect(propertySecretRefusal({ expectedPropertyCode: 'HRCEN' }, 'HRDAV')).toBe('PROPERTY_HRDAV_REQUIRED');
    expect(propertySecretRefusal({ expectedPropertyCode: 'HRDAV' }, 'HRCEN')).toBe('PROPERTY_HRCEN_REQUIRED');
    expect(propertySecretRefusal({ expectedPropertyCode: 'HRCEN' }, 'HRFAKE')).toBe('PROPERTY_HRFAKE_REQUIRED');
  });

  it('HRCEN with its live profile still ignores a blank reservation note', () => {
    const labels = collectBlockers(
      clearSnapshot({
        propertyCode: 'HRCEN',
        profile: profileFor('HRCEN'),
        fields: [{ name: 'reservationnote', value: '', required: false, blank: true }],
      }),
    ).map(formatBlocker);
    expect(labels).toEqual([]);
  });

  it('nav off-screen is blocker:nav', () => {
    const labels = collectBlockers(
      clearSnapshot({
        nav: [{ name: 'Guest Stay', visible: true, inViewport: false }],
      }),
    ).map(formatBlocker);
    expect(labels).toEqual(['blocker:nav']);
  });

  it('guard blocks any write request', async () => {
    expect(shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.example.test/web/base/OSRESV/save' })).toBe(true);
    expect(shouldAbortReadOnlyRequest({ method: 'DELETE', url: 'https://hms.example.test/web/base/OSRESV/list' })).toBe(true);
    expect(shouldAbortReadOnlyRequest({ method: 'GET', url: 'https://hms.example.test/web/base/OSRESV/save' })).toBe(false);
    const aborted: string[] = [];
    let handler: ((route: {
      request: () => { method: string; url: string };
      abort: () => Promise<void>;
      continue: () => Promise<void>;
    }) => Promise<void>) | undefined;
    const result = await runCreatePreflight({
      context: {
        route: async (_pattern: string, fn: NonNullable<typeof handler>) => {
          handler = fn;
        },
      },
      stay: { arrival: '2027-10-12', lastName: 'Labtest' },
      propertyCode: 'HRCEN',
      snapshot: clearSnapshot(),
    });
    expect(result.clickedSave).toBe(false);
    const route = (method: string, url: string) => ({
      request: () => ({
        method: () => method,
        url: () => url,
      }),
      abort: async () => {
        aborted.push(`${method} abort`);
      },
      continue: async () => {
        aborted.push(`${method} continue`);
      },
    });
    if (!handler) throw new Error('guard was not installed');
    await handler(route('POST', 'https://hms.example.test/web/base/OSRESV/save'));
    await handler(route('PUT', 'https://hms.example.test/web/base/OSRESV/record'));
    await handler(route('POST', 'https://hms.example.test/api/internalBooking/hotelAvail/inquiryForGrid'));
    expect(aborted).toEqual(['POST abort', 'PUT abort', 'POST continue']);
  });
});
