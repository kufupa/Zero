import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROPERTY_REGISTRY } from '../tooling/playwright-quote/property-registry.mjs';
import { profileFor } from '../tooling/playwright-quote/property-profile.mjs';
import {
  bookingCodeDefaults,
  defaultsFromCrosstabRow,
  loadNativeBookingCodes,
  PARTY_CLASSES,
} from '../src/ai/booking-code-rules.js';
import { normalizeHmsNativeCatalog } from '../tooling/hms-cloud/hms-native-catalog.mjs';

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../tooling/playwright-quote/create-tool.schema.json', import.meta.url)),
    'utf8',
  ),
) as {
  $defs: {
    request: {
      properties: {
        track: { enum: string[] };
        sourceOfBusiness: { enum: string[] };
      };
    };
  };
};

const trackEnum = schema.$defs.request.properties.track.enum;
const sourceEnum = schema.$defs.request.properties.sourceOfBusiness.enum;
const guaranteeLabels = PROPERTY_REGISTRY.properties
  .filter((property) => property.active && property.profileFile)
  .flatMap((property) => profileFor(property.propertyCode)?.createForm?.options?.guaranteetype?.choices?.map((choice) => choice.display) ?? []);

describe('bookingCodeDefaults', () => {
  it('loads booking codes only from the selected property with matching trusted identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booking-code-catalogue-'));
    const path = join(directory, 'catalog.json');
    try {
      const catalog = normalizeHmsNativeCatalog({ propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD',
        landingPropertyCode: 'HRDAV', credentialRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
        credentialVersionHmacSha256: 'a'.repeat(64), sourceRevision: 'fixture', maxAgeMs: 60_000,
        capturedAt: new Date().toISOString(), source: 'test', catalogs: {
          guaranteeTypes: { criteria: { scope: 'unfiltered' }, coverage: { complete: true, loaded: 1, total: 1 },
            options: [{ value: 'AVOUCH', label: 'Awaiting Voucher' }] },
        } });
      await writeFile(path, JSON.stringify(catalog));
      const env = { HMS_NATIVE_CATALOG_PATH_HRDAVS: path,
        HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS: 'a'.repeat(64), NAVA_BUILD_COMMIT: 'fixture' };
      expect(await loadNativeBookingCodes({ propertyCode: 'HRDAVS', kind: 'guaranteeTypes', env }))
        .toMatchObject({ status: 'available', records: [{ code: 'AVOUCH', meaning: 'Awaiting Voucher' }] });
      expect(await loadNativeBookingCodes({ propertyCode: 'HRDAVS', kind: 'guaranteeTypes', env: { ...env, NAVA_BUILD_COMMIT: 'other' } }))
        .toMatchObject({ status: 'unavailable' });
      expect(await loadNativeBookingCodes({ propertyCode: 'HRDAV', kind: 'guaranteeTypes', env }))
        .toMatchObject({ status: 'unavailable' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('every non-null default is a valid create-tool.schema.json enum value', () => {
    for (const kind of PARTY_CLASSES) {
      const defaults = bookingCodeDefaults(kind);
      if (defaults.track !== null) expect(trackEnum).toContain(defaults.track);
      if (defaults.sourceOfBusiness !== null) expect(sourceEnum).toContain(defaults.sourceOfBusiness);
      if (defaults.guaranteeType !== null) expect(guaranteeLabels).toContain(defaults.guaranteeType);
    }
  });

  it('accepts a guarantee from either property profile and rejects unknown labels', () => {
    const row = {
      n: 5,
      track: { value: 'BAR', support: 1 },
      sourceOfBusiness: { value: 'E-Mail', support: 1 },
      guaranteeType: { value: 'Guaranteed By Credit Card and Agent', support: 1 },
    };
    expect(defaultsFromCrosstabRow(row)).toEqual({ track: 'BAR', sourceOfBusiness: 'E-Mail', guaranteeType: row.guaranteeType.value });
    expect(defaultsFromCrosstabRow({ ...row, guaranteeType: { value: 'Unknown Guarantee', support: 1 } }).guaranteeType).toBeNull();
  });

  it('returns all nulls for an unknown kind', () => {
    expect(bookingCodeDefaults('unknown')).toEqual({
      track: null,
      sourceOfBusiness: null,
      guaranteeType: null,
    });
  });

  it('returns nulls for private when n<3', () => {
    expect(
      defaultsFromCrosstabRow({
        n: 2,
        track: { value: 'BAR', support: 1 },
        sourceOfBusiness: { value: 'E-Mail', support: 1 },
        guaranteeType: { value: 'Non-Guaranteed Individual', support: 1 },
      }),
    ).toEqual({
      track: null,
      sourceOfBusiness: null,
      guaranteeType: null,
    });
  });
});
