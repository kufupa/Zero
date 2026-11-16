import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preloadNativeCatalogLookup } from '../src/ai/native-catalog-lookup.js';
import { loadNativeRatePlans, quotePaneConfigForProperty } from '../src/hms/rate-catalogue.js';
import { normalizeHmsNativeCatalog } from '../tooling/hms-cloud/hms-native-catalog.mjs';
import { getPropertyRegistration } from '../tooling/hms-cloud/property-registry.mjs';
import type { PropertyCode } from '../src/hms/property-registry.js';

const capturedAt = '2026-11-14T10:00:00.000Z';
const now = new Date('2026-11-14T10:00:30.000Z');
const hmac = 'a'.repeat(64);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'native-catalog-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function catalog(propertyCode: PropertyCode, complete = true) {
  const property = getPropertyRegistration(propertyCode)!;
  const section = (records: unknown[], scope = 'unfiltered') => ({
    criteria: { scope }, reportedLoaded: records.length, reportedTotal: records.length, complete, records,
  });
  return normalizeHmsNativeCatalog({ propertyCode, tenantId: property.expectedTenant,
    landingPropertyCode: property.landingPropertyCode, credentialRef: property.credentialSecretRef,
    credentialVersionHmacSha256: hmac, sourceRevision: 'revision-a', maxAgeMs: 60_000, capturedAt, source: 'test',
    catalogs: {
      agencies: section([{ nativeId: 'a1', name: 'Amber Agency' }]),
      organizations: section([{ nativeId: 'c1', name: 'Amber Company' }]),
      arAccounts: section([{ nativeId: 'ar1', accountNumber: '123', name: 'Amber Account' }]),
      roomTypes: section([{ nativeId: 'r1', code: 'KING', name: 'King Room' }]),
      ratePlans: section([{ nativeId: 'p1', code: 'RATE', name: 'Flexible Rate' }], 'property_master'),
    },
  });
}

async function writeJson(name: string, value: unknown) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

function options(propertyCode: PropertyCode, catalogPath?: string, partyIndexPath = join(dir, 'absent-index.json')) {
  return { propertyCode, catalogPath, partyIndexPath, env: {}, now, credentialVersionHmacSha256: hmac, sourceRevision: 'revision-a' };
}

describe('native catalog lookup', () => {
  it('loads complete v2 party, room and rate records for the selected property', async () => {
    const path = await writeJson('catalog.json', catalog('HRDAVS'));
    const snapshot = await preloadNativeCatalogLookup(options('HRDAVS', path));
    expect(snapshot).toMatchObject({ propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD', status: 'available' });
    expect(snapshot.partiesEnvelope('agency')).toMatchObject({ status: 'available', coverage: { scope: 'whole_catalog', complete: true, loaded: 1, total: 1 },
      items: [{ kind: 'agency', nativeId: 'a1', name: 'Amber Agency', normalizedName: 'amber agency', propertyCode: 'HRDAVS', provenance: 'native_catalog_v2' }] });
    expect(snapshot.partiesEnvelope('company').items).toMatchObject([{ kind: 'company', nativeId: 'c1', name: 'Amber Company' }]);
    expect(snapshot.partiesEnvelope('ar').items).toMatchObject([{ kind: 'ar', nativeId: 'ar1', code: '123', name: 'Amber Account' }]);
    expect(snapshot.roomsEnvelope()).toMatchObject({ expiresAt: '2026-11-14T10:01:00.000Z', sourceRevision: 'revision-a',
      items: [{ nativeId: 'r1', code: 'KING', meaning: 'King Room', normalizedMeaning: 'king room' }] });
    expect(snapshot.ratesEnvelope().items).toEqual([{ nativeId: 'p1', code: 'RATE', meaning: 'Flexible Rate', normalizedMeaning: 'flexible rate',
      propertyCode: 'HRDAVS', capturedAt, provenance: 'native_catalog_v2' }]);
    expect(snapshot.lookupVerifiedCode('room', 'king')).toMatchObject({ status: 'unique', completeCatalog: true, record: { code: 'KING' } });
    expect(snapshot.lookupVerifiedCode('rate', 'rate')).toMatchObject({ status: 'unique', completeCatalog: true, record: { code: 'RATE' } });
    expect(snapshot.lookupVerifiedCode('room', 'missing')).toEqual({ status: 'not_found', record: null, completeCatalog: true });
  });

  it('does not cross HRDAVS, HRDAV, tenant, landing property or credential boundaries', async () => {
    const path = await writeJson('catalog.json', catalog('HRDAVS'));
    for (const overrides of [
      { propertyCode: 'HRDAV' as const }, { tenantId: 'THECENTURION_PRD' },
      { landingPropertyCode: 'HRCEN' }, { credentialRef: 'other' },
    ]) {
      const snapshot = await preloadNativeCatalogLookup({ ...options('HRDAVS', path), ...overrides });
      expect(snapshot).toMatchObject({ status: 'unavailable', issue: 'catalog_identity_unverified' });
      expect(snapshot.roomsEnvelope().items).toEqual([]);
      expect(snapshot.searchParties('agency', 'amber')).toEqual([]);
    }
  });

  it('revalidates credentials, revision and the exact TTL boundary for unchanged files', async () => {
    const path = await writeJson('catalog.json', catalog('HRDAVS'));
    const indexPath = await writeJson('index.json', { generatedAt: capturedAt, propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD', entries: [
      { kind: 'bookingAgency', nativeId: 'a2', name: 'Amber Index' },
    ] });
    const before = await stat(path);
    expect((await preloadNativeCatalogLookup(options('HRDAVS', path, indexPath))).status).toBe('available');
    for (const [overrides, issue] of [
      [{ credentialVersionHmacSha256: 'b'.repeat(64) }, 'catalog_identity_unverified'],
      [{ sourceRevision: 'revision-b' }, 'catalog_identity_unverified'],
      [{ now: new Date('2026-11-14T10:01:00.000Z') }, 'catalog_stale'],
    ] as const) {
      const snapshot = await preloadNativeCatalogLookup({ ...options('HRDAVS', path, indexPath), ...overrides, includeStaticFallback: true });
      expect(snapshot).toMatchObject({ status: 'unavailable', issue });
      expect(snapshot.partiesEnvelope('agency').items).toEqual([]);
      expect(snapshot.searchParties('agency', 'amber')).toEqual([]);
      expect(snapshot.lookupVerifiedCode('rate', 'RATE')).toEqual({ status: 'catalog_incomplete', record: null, completeCatalog: false });
    }
    const after = await stat(path);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });

  it('requires independent credential and revision bindings for HRCEN v2 snapshots', async () => {
    const path = await writeJson('catalog.json', { ...catalog('HRCEN'), source: { reader: 'test' } });
    for (const overrides of [{ credentialVersionHmacSha256: undefined }, { sourceRevision: undefined }]) {
      const snapshot = await preloadNativeCatalogLookup({ ...options('HRCEN', path), ...overrides });
      expect(snapshot).toMatchObject({ status: 'unavailable', issue: 'catalog_identity_unverified' });
      expect(snapshot.lookupVerifiedCode('rate', 'RATE').status).toBe('catalog_incomplete');
    }
  });

  it('keeps Quote rate extraction and HRDAVS property checks compatible', async () => {
    const data = catalog('HRDAVS');
    data.capturedAt = new Date().toISOString();
    for (const section of Object.values(data.catalogs)) {
      for (const row of section.records) row.capturedAt = data.capturedAt;
    }
    const path = await writeJson('catalog.json', data);
    const env = { HMS_NATIVE_CATALOG_PATH_HRDAVS: path,
      HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS: hmac, NAVA_BUILD_COMMIT: 'revision-a' };
    expect(await loadNativeRatePlans('HRDAVS', env)).toEqual([{ code: 'RATE', name: 'Flexible Rate' }]);
    expect(await quotePaneConfigForProperty('HRDAVS', 'transport-davinci', env)).toMatchObject({
      propertyCode: 'HRDAVS', ratePlans: [{ code: 'RATE', name: 'Flexible Rate', mealPlan: 'unknown' }],
      roomTypes: [{ code: 'KING', label: 'King Room' }],
    });
    expect((await quotePaneConfigForProperty('HRDAVS', 'transport-davinci', { ...env, NAVA_BUILD_COMMIT: 'other' }))?.ratePlans)
      .toEqual([{ code: 'RATE', name: 'Flexible Rate', mealPlan: 'unknown' }]);
    expect(await quotePaneConfigForProperty('HRDAVS', 'transport-centurion', env)).toBeNull();
  });

  it('merges index records by native id, ranks names, and keeps query coverage honest', async () => {
    const path = await writeJson('catalog.json', catalog('HRCEN'));
    const entries = [
      { kind: 'bookingAgency', nativeId: 'a1', name: 'Amber Index Duplicate' },
      { kind: 'bookingAgency', nativeId: 'a2', name: 'Amber Agency' },
      ...Array.from({ length: 14 }, (_, i) => ({ kind: 'organization', nativeId: `extra-${i}`, name: `Amber Company ${String(i).padStart(2, '0')}` })),
    ];
    const indexPath = await writeJson('index.json', { generatedAt: capturedAt, entries });
    const snapshot = await preloadNativeCatalogLookup(options('HRCEN', path, indexPath));
    const agency = snapshot.partiesEnvelope('agency');
    expect(agency).toMatchObject({ status: 'partial_or_legacy', expiresAt: null, sourceRevision: null,
      coverage: { scope: 'query', complete: false, loaded: 2, total: null },
      items: [{ nativeId: 'a1', name: 'Amber Agency', provenance: 'native_catalog_v2' }, { nativeId: 'a2', provenance: 'party_index' }] });
    expect(snapshot.searchParties('agency', 'amber').map((row) => row.nativeId)).toEqual(['a1', 'a2']);
    expect(snapshot.searchParties('company', 'amber')).toHaveLength(10);
    expect(snapshot.searchParties('company', 'amber', 3)).toHaveLength(3);
    expect(snapshot.searchParties('company', '!!!')).toEqual([]);
    expect(snapshot.searchParties('ar', 'amber')).toMatchObject([{ nativeId: 'ar1', provenance: 'native_catalog_v2' }]);
  });

  it('loads an index without a native file and never supplies AR from it', async () => {
    const indexPath = await writeJson('index.json', { generatedAt: capturedAt, propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD', entries: [
      { kind: 'bookingAgency', nativeId: 'a1', name: 'Amber Agency' },
      { kind: 'organization', nativeId: 'c1', name: 'Amber Company' },
    ] });
    const snapshot = await preloadNativeCatalogLookup(options('HRDAVS', undefined, indexPath));
    expect(snapshot.status).toBe('partial_or_legacy');
    expect(snapshot.partiesEnvelope('company')).toMatchObject({ expiresAt: null, sourceRevision: null, coverage: { scope: 'query', complete: false },
      items: [{ kind: 'company', provenance: 'party_index' }] });
    expect(snapshot.partiesEnvelope('agency').items).toMatchObject([{ kind: 'agency', provenance: 'party_index' }]);
    expect(snapshot.partiesEnvelope('ar').items).toEqual([]);
    expect((await preloadNativeCatalogLookup(options('HRDAV', undefined, indexPath))).partiesEnvelope('agency').items).toEqual([]);
  });

  it('refuses code proof from partial and explicitly requested static fallback data', async () => {
    const path = await writeJson('partial.json', catalog('HRDAVS', false));
    const partial = await preloadNativeCatalogLookup(options('HRDAVS', path));
    expect(partial.roomsEnvelope()).toMatchObject({ status: 'partial_or_legacy', coverage: { complete: false } });
    for (const kind of ['room', 'rate'] as const) {
      expect(partial.lookupVerifiedCode(kind, kind === 'room' ? 'KING' : 'RATE')).toMatchObject({ status: 'catalog_incomplete', completeCatalog: false });
    }
    const fallback = await preloadNativeCatalogLookup({ ...options('HRCEN'), includeStaticFallback: true });
    expect(fallback.roomsEnvelope()).toMatchObject({ status: 'partial_or_legacy', coverage: { scope: 'static_fallback', complete: false } });
    expect(fallback.roomsEnvelope().items[0]?.provenance).toBe('static_fallback');
    expect(fallback.ratesEnvelope().items[0]?.provenance).toBe('static_fallback');
    expect(fallback.lookupVerifiedCode('room', fallback.roomsEnvelope().items[0]!.code).status).toBe('catalog_incomplete');
    expect(fallback.lookupVerifiedCode('rate', fallback.ratesEnvelope().items[0]!.code).status).toBe('catalog_incomplete');
    const noFallback = await preloadNativeCatalogLookup(options('HRCEN'));
    expect(noFallback.ratesEnvelope().items).toEqual([]);
    const stalePath = await writeJson('stale.json', catalog('HRCEN'));
    const stale = await preloadNativeCatalogLookup({ ...options('HRCEN', stalePath), now: new Date('2026-11-14T10:01:00.000Z'), includeStaticFallback: true });
    expect(stale).toMatchObject({ status: 'unavailable', issue: 'catalog_stale' });
    expect(stale.ratesEnvelope().items).toEqual([]);
  });

  it('accepts only complete HRCEN v1 native sections as code proof', async () => {
    const v1 = normalizeHmsNativeCatalog({ propertyCode: 'HRCEN', capturedAt, source: 'test', catalogs: {
      ratePlans: { criteria: { scope: 'property_master' }, reportedLoaded: 1, reportedTotal: 1, complete: true,
        records: [{ code: 'RATE', name: 'Flexible Rate' }] },
    } });
    const path = await writeJson('legacy.json', v1);
    const snapshot = await preloadNativeCatalogLookup(options('HRCEN', path));
    expect(snapshot.ratesEnvelope()).toMatchObject({ status: 'partial_or_legacy', expiresAt: null, sourceRevision: null,
      coverage: { scope: 'whole_catalog', complete: true }, items: [{ provenance: 'native_catalog_v1' }] });
    expect(snapshot.lookupVerifiedCode('rate', 'RATE').status).toBe('unique');
    const other = await preloadNativeCatalogLookup(options('HRDAVS', path));
    expect(other.lookupVerifiedCode('rate', 'RATE').status).toBe('catalog_incomplete');
  });

  it('rejects duplicate case-insensitive codes and freezes exposed snapshots', async () => {
    const data = catalog('HRDAVS');
    const section = data.catalogs.roomTypes!;
    section.records.push({ ...section.records[0]!, code: 'king' });
    section.coverage.loaded = 2;
    section.coverage.total = 2;
    const path = await writeJson('duplicate.json', data);
    const snapshot = await preloadNativeCatalogLookup(options('HRDAVS', path));
    expect(snapshot.lookupVerifiedCode('room', 'KING')).toEqual({ status: 'not_found', record: null, completeCatalog: true });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.roomsEnvelope())).toBe(true);
    expect(Object.isFrozen(snapshot.roomsEnvelope().coverage)).toBe(true);
    expect(Object.isFrozen(snapshot.roomsEnvelope().items)).toBe(true);
    expect(Object.isFrozen(snapshot.roomsEnvelope().items[0])).toBe(true);
    expect(Object.isFrozen(snapshot.searchParties('agency', 'amber'))).toBe(true);
  });
});
