import { z } from 'zod';
import {
  loadHmsNativeCatalog,
  nativeCatalogReadOptions,
  type NativeCatalog,
  type NativeCatalogReadOptions,
} from '../../tooling/hms-cloud/hms-native-catalog.mjs';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { CENTURION_RATE_PLANS } from '../hms/centurion-rate-catalogue.js';
import type { PropertyCode } from '../hms/property-registry.js';
import { indexRank, loadPartyIndex, partyIndexPath, PARTY_INDEX_CAP_PER_KIND } from './party-index.js';
import { matchKey } from './party-match.js';
import { ROOM_TYPE_NAMES } from './room-types.js';

export type CatalogEnvelope<T> = {
  propertyCode: PropertyCode;
  tenantId: string;
  capturedAt: string | null;
  expiresAt: string | null;
  sourceRevision: string | null;
  status: 'available' | 'partial_or_legacy' | 'unavailable';
  issue?: string;
  coverage: { scope: 'whole_catalog' | 'query' | 'static_fallback'; complete: boolean; loaded: number; total: number | null; truncated: boolean };
  items: T[];
};

type PartyKind = 'agency' | 'company' | 'ar';
type NativeProvenance = 'native_catalog_v2' | 'native_catalog_v1';
export type NativePartyRecord = {
  kind: PartyKind; nativeId: string; code: string | null; name: string; normalizedName: string;
  propertyCode: PropertyCode; capturedAt: string | null; provenance: NativeProvenance | 'party_index';
};
export type NativeRoomRecord = {
  nativeId: string | null; code: string; meaning: string; normalizedMeaning: string;
  propertyCode: PropertyCode; capturedAt: string | null; provenance: NativeProvenance | 'static_fallback';
};
export type NativeRateRecord = NativeRoomRecord;

export type PreloadedNativeCatalog = {
  readonly propertyCode: PropertyCode;
  readonly tenantId: string;
  readonly status: CatalogEnvelope<unknown>['status'];
  readonly issue?: string;
  partiesEnvelope(kind: PartyKind): CatalogEnvelope<NativePartyRecord>;
  roomsEnvelope(): CatalogEnvelope<NativeRoomRecord>;
  ratesEnvelope(): CatalogEnvelope<NativeRateRecord>;
  searchParties(kind: PartyKind, query: string, limit?: number): NativePartyRecord[];
  lookupVerifiedCode(kind: 'room' | 'rate', token: string): {
    status: 'unique' | 'not_found' | 'catalog_incomplete';
    record: NativeRoomRecord | NativeRateRecord | null;
    completeCatalog: boolean;
  };
};

type PreloadOptions = {
  propertyCode: PropertyCode; tenantId?: string; landingPropertyCode?: string; credentialRef?: string;
  credentialVersionHmacSha256?: string; sourceRevision?: string; catalogPath?: string; partyIndexPath?: string;
  env?: NodeJS.ProcessEnv; now?: Date; includeStaticFallback?: boolean;
};

// Use the authoritative loader for every call. It validates identity, contents and clock even on repeated reads.
export const loadNativeCatalogArtifact = (options: NativeCatalogReadOptions) => loadHmsNativeCatalog(options);

const rawRecord = z.object({
  nativeId: z.unknown().optional(), code: z.unknown().optional(), meaning: z.unknown().optional(),
  propertyCode: z.unknown().optional(),
}).passthrough();
const rawSection = z.object({
  records: z.array(z.unknown()),
  coverage: z.object({ complete: z.unknown().optional(), loaded: z.unknown().optional(), total: z.unknown().optional(), truncated: z.unknown().optional() }).passthrough().optional(),
  scope: z.object({ kind: z.unknown().optional(), wholeCatalogComplete: z.unknown().optional() }).passthrough().optional(),
}).passthrough();
const clean = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Extract catalog identity and label only; meal/availability observations are deliberately excluded. */
export function nativeCodeRecords(records: readonly unknown[]): Array<{ nativeId: string | null; code: string; meaning: string }> {
  return records.flatMap((raw) => {
    const parsed = rawRecord.safeParse(raw);
    if (!parsed.success) return [];
    const code = clean(parsed.data.code);
    if (!code) return [];
    return [{ nativeId: clean(parsed.data.nativeId), code, meaning: clean(parsed.data.meaning) ?? code }];
  });
}

function freezeEnvelope<T extends object>(envelope: CatalogEnvelope<T>): CatalogEnvelope<T> {
  for (const item of envelope.items) Object.freeze(item);
  Object.freeze(envelope.items);
  Object.freeze(envelope.coverage);
  return Object.freeze(envelope);
}

function nativeEnvelope<T extends object>(input: {
  propertyCode: PropertyCode; tenantId: string; catalog: NativeCatalog | null; sectionName: string;
  convert: (rows: unknown[], provenance: NativeProvenance, capturedAt: string) => T[];
  issue?: string;
}): CatalogEnvelope<T> {
  const { propertyCode, tenantId, catalog, sectionName, convert, issue } = input;
  const parsed = rawSection.safeParse(catalog?.catalogs?.[sectionName]);
  const section = parsed.success ? parsed.data : null;
  const provenance = catalog?.schemaVersion === 'hms-native-catalogs/v1' ? 'native_catalog_v1' : 'native_catalog_v2';
  const rows = section?.records ?? [];
  // V1 did not validate row bindings. Reject any explicitly foreign row and never claim complete coverage.
  const safeRows = rows.filter((row) => {
    const parsedRow = rawRecord.safeParse(row);
    return parsedRow.success && (parsedRow.data.propertyCode == null || parsedRow.data.propertyCode === propertyCode);
  });
  const items = catalog ? convert(safeRows, provenance, catalog.capturedAt) : [];
  const loaded = section?.coverage?.loaded;
  const total = section?.coverage?.total;
  const validLoaded = typeof loaded === 'number' && Number.isSafeInteger(loaded) && loaded >= 0;
  const validTotal = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0;
  const complete = section?.scope?.kind === 'unfiltered' && section.scope.wholeCatalogComplete === true &&
    section.coverage?.complete === true && validLoaded && validTotal && loaded === total &&
    loaded === rows.length && items.length === rows.length && section.coverage.truncated !== true;
  const whole = section?.scope?.kind === 'unfiltered';
  const truncated = section?.coverage?.truncated === true || (validTotal && total > items.length);
  const expiration = catalog?.schemaVersion === 'hms-native-catalogs/v2' && catalog.maxAgeMs
    ? new Date(Date.parse(catalog.capturedAt) + catalog.maxAgeMs) : null;
  const expiresAt = expiration && Number.isFinite(expiration.getTime()) ? expiration.toISOString() : null;
  return freezeEnvelope({ propertyCode, tenantId, capturedAt: catalog?.capturedAt ?? null, expiresAt,
    sourceRevision: provenance === 'native_catalog_v2' ? catalog?.sourceRevision ?? null : null,
    status: !catalog || !section ? 'unavailable' : provenance === 'native_catalog_v2' && complete ? 'available' : 'partial_or_legacy',
    ...(issue ? { issue } : {}), coverage: { scope: whole ? 'whole_catalog' : 'query', complete: Boolean(complete),
      loaded: items.length, total: validTotal ? total : null, truncated: Boolean(truncated) }, items });
}

export async function preloadNativeCatalogLookup(options: PreloadOptions): Promise<PreloadedNativeCatalog> {
  const { propertyCode } = options;
  const registration = getPropertyRegistration(propertyCode);
  const tenantId = registration?.expectedTenant ?? options.tenantId ?? '';
  const identityMismatch = !registration?.active ||
    (options.tenantId !== undefined && options.tenantId !== registration.expectedTenant) ||
    (options.landingPropertyCode !== undefined && options.landingPropertyCode !== registration.landingPropertyCode) ||
    (options.credentialRef !== undefined && options.credentialRef !== registration.credentialSecretRef);
  const env = options.env ?? process.env;
  const readOptions = nativeCatalogReadOptions({ propertyCode, env });
  const loaded = identityMismatch ? { status: 'unavailable' as const, issue: 'catalog_identity_unverified' } :
    await loadNativeCatalogArtifact({ ...readOptions, path: options.catalogPath ?? readOptions.path,
      tenantId: options.tenantId, landingPropertyCode: options.landingPropertyCode, credentialRef: options.credentialRef,
      credentialVersionHmacSha256: options.credentialVersionHmacSha256 ?? readOptions.credentialVersionHmacSha256,
      sourceRevision: options.sourceRevision ?? readOptions.sourceRevision, now: options.now });
  const lacksV2Binding = loaded.status === 'available' && loaded.catalog.schemaVersion === 'hms-native-catalogs/v2' &&
    (!(options.credentialVersionHmacSha256 ?? readOptions.credentialVersionHmacSha256) ||
      !(options.sourceRevision ?? readOptions.sourceRevision ?? readOptions.readerRevision));
  const catalog = loaded.status === 'available' && !lacksV2Binding ? loaded.catalog : null;
  // Invalid artifacts cannot establish the requested property's identity at this boundary.
  const issue = lacksV2Binding ? 'catalog_identity_unverified' : loaded.status === 'unavailable'
    ? loaded.issue === 'catalog_invalid' ? 'catalog_identity_unverified' : loaded.issue : undefined;
  const failClosed = Boolean(issue && !['catalog_path_or_property_missing', 'catalog_files_unavailable'].includes(issue));
  const index = !failClosed && registration?.active
    ? await loadPartyIndex(options.partyIndexPath ?? partyIndexPath(env, propertyCode), propertyCode) : null;
  const parties = {} as Record<PartyKind, CatalogEnvelope<NativePartyRecord>>;
  const sectionNames = { agency: 'agencies', company: 'organizations', ar: 'arAccounts' } as const;
  for (const kind of ['agency', 'company', 'ar'] as const) {
    const native = nativeEnvelope<NativePartyRecord>({ propertyCode, tenantId, catalog, sectionName: sectionNames[kind], issue,
      convert: (rows, provenance, capturedAt) => rows.flatMap((raw) => {
        const parsed = rawRecord.safeParse(raw);
        if (!parsed.success) return [];
        const nativeId = clean(parsed.data.nativeId), name = clean(parsed.data.meaning);
        if (!nativeId || !name) return [];
        return [{ kind, nativeId, code: clean(parsed.data.code), name, normalizedName: matchKey(name), propertyCode, capturedAt, provenance }];
      }) });
    const extra = index && kind !== 'ar' ? index.entries.filter((entry) => entry.kind === (kind === 'company' ? 'organization' : 'bookingAgency')) : [];
    const merged = new Map(native.items.map((item) => [item.nativeId, item]));
    for (const entry of extra) if (!merged.has(entry.nativeId)) merged.set(entry.nativeId, {
      kind, nativeId: entry.nativeId, code: null, name: entry.name, normalizedName: matchKey(entry.name),
      propertyCode, capturedAt: index?.generatedAt ?? null, provenance: 'party_index',
    });
    if (index && kind !== 'ar' && (native.status === 'unavailable' || merged.size > native.items.length)) {
      parties[kind] = freezeEnvelope({ propertyCode, tenantId, capturedAt: index.generatedAt, expiresAt: null, sourceRevision: null,
        status: 'partial_or_legacy', coverage: { scope: 'query', complete: false, loaded: merged.size, total: null, truncated: false },
        items: [...merged.values()] });
    } else parties[kind] = native;
  }
  const codes = (sectionName: 'roomTypes' | 'ratePlans'): CatalogEnvelope<NativeRoomRecord> => {
    const native = nativeEnvelope({ propertyCode, tenantId, catalog, sectionName, issue,
      convert: (rows, provenance, capturedAt) => nativeCodeRecords(rows).map((row) => ({ ...row,
        normalizedMeaning: matchKey(row.meaning), propertyCode, capturedAt, provenance })) });
    if (!failClosed && options.includeStaticFallback && propertyCode === 'HRCEN' && !catalog?.catalogs?.[sectionName]) {
      const fallback = sectionName === 'roomTypes'
        ? Object.entries(ROOM_TYPE_NAMES).map(([code, meaning]) => ({ code, meaning }))
        : CENTURION_RATE_PLANS.map(({ code, name }) => ({ code, meaning: name }));
      return freezeEnvelope({ propertyCode, tenantId, capturedAt: null, expiresAt: null, sourceRevision: null,
        status: 'partial_or_legacy', coverage: { scope: 'static_fallback', complete: false, loaded: fallback.length, total: null, truncated: false },
        items: fallback.map(({ code, meaning }) => ({ nativeId: null, code, meaning, normalizedMeaning: matchKey(meaning),
          propertyCode, capturedAt: null, provenance: 'static_fallback' })) });
    }
    return native;
  };
  const rooms = codes('roomTypes'), rates = codes('ratePlans');
  const all = [...Object.values(parties), rooms, rates];
  const status: PreloadedNativeCatalog['status'] = failClosed ? 'unavailable' : catalog?.schemaVersion === 'hms-native-catalogs/v2'
    ? 'available' : all.some((envelope) => envelope.status !== 'unavailable') ? 'partial_or_legacy' : 'unavailable';
  const snapshot: PreloadedNativeCatalog = {
    propertyCode, tenantId, status, ...(issue ? { issue } : {}),
    partiesEnvelope: (kind) => parties[kind], roomsEnvelope: () => rooms, ratesEnvelope: () => rates,
    searchParties: (kind, query, limit = PARTY_INDEX_CAP_PER_KIND) => {
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      const matches = parties[kind].items.map((record, position) => ({ record, position, rank: indexRank(query, record.name) }))
        .filter((row) => row.rank < 4)
        .sort((a, b) => a.rank - b.rank || a.record.name.localeCompare(b.record.name, 'en') || a.position - b.position)
        .slice(0, count).map((row) => row.record);
      Object.freeze(matches);
      return matches;
    },
    lookupVerifiedCode: (kind, token) => {
      const envelope = kind === 'room' ? rooms : rates;
      const completeCatalog = envelope.coverage.scope === 'whole_catalog' && envelope.coverage.complete &&
        envelope.items.every((item) => item.provenance === 'native_catalog_v2' || item.provenance === 'native_catalog_v1');
      if (!completeCatalog) return { status: 'catalog_incomplete', record: null, completeCatalog: false };
      const code = token.trim().toUpperCase();
      const matches = code ? envelope.items.filter((item) => item.code.toUpperCase() === code) : [];
      return matches.length === 1 ? { status: 'unique', record: matches[0]!, completeCatalog: true }
        : { status: 'not_found', record: null, completeCatalog: true };
    },
  };
  return Object.freeze(snapshot);
}
