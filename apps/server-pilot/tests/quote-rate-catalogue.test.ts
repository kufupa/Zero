import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRouter } from '../src/trpc/router.js';
import { propertyConfigurationForScope, quotePaneConfigForProperty, quoteSalesStrategiesFromRegistry } from '../src/hms/rate-catalogue.js';
import { resolvePropertyScope } from '../src/hms/property-registry.js';
import { loadHmsNativeCatalog, normalizeHmsNativeCatalog } from '../tooling/hms-cloud/hms-native-catalog.mjs';

function signedInCaller(transportId = 'transport-centurion') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'staff-1', email: 'staff@example.test', name: 'Staff' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: 'staff@example.test',
  } as never);
}

function anonymousCaller() {
  return appRouter.createCaller({
    auth: { api: { getSession: async () => null } } as never,
    reqHeaders: new Headers(),
  } as never);
}

describe('mailbox-scoped quote pane configuration', () => {
  it('uses HMS native rate plans when the catalog has rates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rate-catalogue-'));
    const path = join(directory, 'catalogs.json');
    try {
      await writeFile(path, JSON.stringify({
        schemaVersion: 'hms-native-catalogs/v1',
        propertyCode: 'HRCEN',
        capturedAt: '2026-11-14T00:00:00.000Z',
        source: { reader: 'test' },
        catalogs: {
          ratePlans: {
            status: 'matches',
            scope: { kind: 'rate_shop', query: null, wholeCatalogComplete: false },
            coverage: { complete: false },
            records: [
              { nativeId: null, code: 'GNC1B', meaning: 'Group Negotiated 1', capturedAt: '2026-11-14T00:00:00.000Z' },
              { nativeId: null, code: 'BAR', meaning: 'Native Best Available', capturedAt: '2026-11-14T00:00:00.000Z' },
            ],
          },
        },
      }));

      const config = await quotePaneConfigForProperty('HRCEN', 'transport-centurion', {
        HMS_NATIVE_CATALOG_PATH: path,
      } as NodeJS.ProcessEnv);

      expect(config?.ratePlans.map(({ code }) => code)).toEqual(['GNC1B', 'BAR']);
      expect(config?.ratePlans[0]).toMatchObject({ code: 'GNC1B', name: 'Group Negotiated 1' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps Centurion room, rate, and override choices unchanged', async () => {
    const config = await signedInCaller().quoteWorkflow.rateCatalogue();
    expect(config).toMatchObject({
      propertyCode: 'HRCEN',
      transportId: 'transport-centurion',
      roomTypes: [
        { code: 'STWN', label: 'Standard Twin' },
        { code: 'STQN', label: 'Standard Queen' },
        { code: 'SKNG', label: 'Standard King' },
        { code: 'EXKNG', label: 'Executive King' },
        { code: 'DLXTWN', label: 'Deluxe Twin' },
        { code: 'DLXQN', label: 'Deluxe Queen' },
        { code: 'DLXKNG', label: 'Deluxe King' },
        { code: 'LUXKNG', label: 'Luxury King' },
        { code: 'SUITE', label: 'Suite' },
      ],
      mealPlans: ['room_only', 'bb', 'dinner_bb'],
      salesStrategies: [
        { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
        { code: 'GOV', label: 'Government', requestValue: 'Government' },
      ],
      overrideRateCodes: ['NCOR1B', 'NCOR2B', 'BAR', 'GNC3B', 'GNC4B'],
      eventRateCodes: ['GNC3B', 'GNC4B'],
    });
    expect(config.ratePlans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'BAR', name: 'Best Available Rate', mealPlan: 'bed_breakfast' }),
        expect.objectContaining({ code: 'NCOR1B', mealPlan: 'unknown', contract: true }),
        expect.objectContaining({ code: 'GNC3B', event: true }),
        expect.objectContaining({ code: 'NGOVB', government: true }),
      ]),
    );
  });

  it('uses Da Vinci native choices only from its own valid catalogue', async () => {
    const empty = await quotePaneConfigForProperty('HRDAV', 'transport-davinci', {});
    expect(empty).toMatchObject({ propertyCode: 'HRDAV', roomTypes: [], ratePlans: [],
      catalogue: { coverage: { rates: 'unknown', roomTypes: 'unknown' } } });
    const directory = await mkdtemp(join(tmpdir(), 'davinci-catalogue-'));
    const path = join(directory, 'catalog.json');
    try {
      const catalog = normalizeHmsNativeCatalog({ propertyCode: 'HRDAV', tenantId: 'DAVINCI_PRD',
        landingPropertyCode: 'HRDAV', credentialRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
        credentialVersionHmacSha256: 'a'.repeat(64), sourceRevision: 'fixture', maxAgeMs: 60_000,
        capturedAt: new Date().toISOString(), source: 'test', catalogs: {
          ratePlans: { criteria: { scope: 'rate_shop' }, reportedLoaded: 1, reportedTotal: 1, complete: true,
            records: [{ property: 'HRDAV', rateplancode: 'BAR', rateplanname: 'Observed BAR' }] },
          roomTypes: { criteria: { scope: 'unfiltered' }, reportedLoaded: 1, reportedTotal: 1, complete: true,
            records: [{ property: 'HRDAV', roomtypecode: 'STKNG', roomtypename: 'Observed King' }] },
        }, form: { propertyCode: 'HRDAV', fields: [
          { name: 'guestoptin4', label: 'Terms and Conditions', xtype: 'checkboxfield', required: true, visible: false, value: false },
          { name: 'guaranteetype', label: 'Guarantee Type', xtype: 'uxcombobox', required: true, visible: false,
            rows: [{ value: 'AVOUCH', display: 'Awaiting Voucher' }] },
          { name: 'child1', label: 'Child 0 - 02', xtype: 'uxcombobox', required: false, visible: false },
          { name: 'child4', label: 'Child 4', xtype: 'uxcombobox', required: false, visible: false },
        ] }, availabilityForm: { propertyCode: 'HRDAV', fields: [
          { name: 'salesstrategy', label: 'Sales Strategy', xtype: 'uxcombobox', required: true, visible: false,
            rows: [{ value: 'BAR', display: 'BAR' }, { value: 'PRESET', display: 'Preset' }] },
        ] },
      });
      await writeFile(path, JSON.stringify(catalog));
      const env = { HMS_NATIVE_CATALOG_PATH_HRDAV: path,
        HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAV: 'a'.repeat(64), NAVA_BUILD_COMMIT: 'fixture' };
      expect(await quotePaneConfigForProperty('HRDAV', 'transport-davinci', { HMS_NATIVE_CATALOG_PATH_HRDAV: path }))
        .toMatchObject({ roomTypes: [], ratePlans: [] });
      const config = await quotePaneConfigForProperty('HRDAV', 'transport-davinci', env);
      expect(config).toMatchObject({ ratePlans: [{ code: 'BAR', name: 'Observed BAR' }],
        roomTypes: [{ code: 'STKNG', label: 'Observed King' }],
        formPolicy: { guestOptIn: 'required', requiredFields: ['guestoptin4', 'guaranteetype'],
          guaranteeChoices: [{ code: 'AVOUCH', meaning: 'Awaiting Voucher', ready: true }],
          childCategories: [{ field: 'child1', minimumAge: 0, maximumAge: 2, visible: false }] },
        catalogue: { coverage: { rates: 'partial', roomTypes: 'complete' } } });
      expect(config?.salesStrategies.map(({ code }) => code)).toEqual(['BAR', 'PRESET']);
      expect(config?.ratePlans[0]?.mealPlan).toBe('unknown');
      const scope = resolvePropertyScope({ transportId: 'transport-davinci', propertySwitch: 'HRDAV' });
      const enabled = { ...env, HMS_DAVINCI_ENABLED_PROPERTIES: 'HRDAV', HMS_DAVINCI_READS: 'on', HMS_DAVINCI_MAKE_QUOTE: 'on' };
      expect((await propertyConfigurationForScope(scope, enabled)).capabilities).toMatchObject({
        reads: { status: 'unavailable' }, quote: { status: 'unavailable' }, create: { status: 'prepare-only' } });
      expect((await propertyConfigurationForScope(scope, enabled, { reads: true, quote: true })).capabilities).toMatchObject({
        reads: { status: 'staff-enabled' }, quote: { status: 'staff-enabled' }, create: { status: 'prepare-only' } });
      expect((await propertyConfigurationForScope(scope, { ...enabled, NAVA_BUILD_COMMIT: 'other' }, { reads: true, quote: true })).capabilities)
        .toMatchObject({ reads: { status: 'staff-enabled' }, quote: { status: 'unavailable' } });
      expect((await quotePaneConfigForProperty('HRDAV', 'transport-davinci', { ...env, NAVA_BUILD_COMMIT: 'other' }))?.ratePlans).toEqual([]);
      expect((await quotePaneConfigForProperty('HRDAV', 'transport-davinci', { ...env,
        HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAV: 'b'.repeat(64) }))?.roomTypes).toEqual([]);
      expect(await loadHmsNativeCatalog({ path, propertyCode: 'HRDAV', credentialVersionHmacSha256: 'a'.repeat(64),
        sourceRevision: 'fixture', now: new Date(Date.now() + 120_000) }))
        .toMatchObject({ status: 'unavailable', issue: 'catalog_stale' });
      expect(() => normalizeHmsNativeCatalog({ propertyCode: 'HRDAVS', capturedAt: new Date().toISOString(),
        source: 'test', catalogs: { roomTypes: { records: [{ property: 'HRDAV', roomtypecode: 'STKNG' }] } } }))
        .toThrow(/record property/);
      catalog.catalogs.roomTypes!.coverage.total = 2;
      await writeFile(path, JSON.stringify(catalog));
      expect(await loadHmsNativeCatalog({ path, propertyCode: 'HRDAV', credentialVersionHmacSha256: 'a'.repeat(64), sourceRevision: 'fixture' }))
        .toMatchObject({ status: 'unavailable', issue: 'catalog_invalid' });
      const suites = await quotePaneConfigForProperty('HRDAVS', 'transport-davinci', { HMS_NATIVE_CATALOG_PATH_HRDAVS: path });
      expect(suites).toMatchObject({ propertyCode: 'HRDAVS', ratePlans: [], roomTypes: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exposes no Da Vinci strategy that is outside the supported registry codes', () => {
    expect(quoteSalesStrategiesFromRegistry('HRDAV', [
      { value: 'PROMO', display: 'Promotions' },
      { value: 'UNREGISTERED', display: 'Unregistered strategy' },
      { value: 'BAR', display: 'BAR' },
    ])).toEqual([
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
      { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
    ]);
  });

  it('refuses unknown and collector mailboxes instead of falling back to Centurion', async () => {
    for (const transportId of ['transport-unknown', 'transport-nava']) {
      await expect(signedInCaller(transportId).quoteWorkflow.rateCatalogue()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
  });

  it('requires an authenticated session', async () => {
    await expect(anonymousCaller().quoteWorkflow.rateCatalogue()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
