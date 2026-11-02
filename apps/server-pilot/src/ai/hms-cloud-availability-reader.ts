import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AvailabilityRequest } from './hms-availability.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';

const PRIVATE_SNAPSHOT_PREFIX = 'nava-cloud-availability-';
// Prior HRCEN reads returned 496 rows; cap only unusually large views and expose any remaining cursor.
const MAX_OPTIONS_PER_GROUP = 1000;
const PAGE_SIZE = 50;

type RecordValue = Record<string, unknown>;

export type CloudAvailabilityGroupRead = {
  outcome: 'ok' | 'criteria_unavailable' | 'input_gap' | 'execution_failure';
  issue?: string;
  view?: unknown;
};

export type CloudAvailabilityRunInput = {
  request: AvailabilityRequest;
  target: HmsReadTarget;
  signal?: AbortSignal;
};

export type HmsCloudAvailabilityResult = ({
  outcome: 'read';
  source: 'hms_cloud_hotel_availability';
  roomScope: 'all_room_types';
  priceEvidence: {
    label: 'estimate';
    priceBasis: 'unknown';
    quantityBasis: 'unknown';
    comparisonBasis: 'one_room_type_per_night';
    combinedAvailability: 'unknown';
    tax: 'unknown';
    officialTotal: 'unknown';
    contractRate: 'unknown';
  };
  searchOutcome: 'partial' | 'unavailable';
  observedAt: string | null;
  groups: Array<{
    /** Stable 1-based mapping to the room group in the request. */
    id: string;
    requestedRoomType: string;
    requestedCount: number;
    requestedAdults: number;
    requestedChildAges: number[];
    outcome: 'observed' | 'criteria_unavailable';
    observedAt: string | null;
    coverage: Record<string, unknown>;
    options: Array<{
      room: { code: string | null; label: string | null };
      ratePlan: { code: string | null; label: string | null };
      /** HMS promotion identifier keeps same-code promotional options distinct. */
      promotionCode: string | null;
      rateScope: 'unknown';
      eligibility: 'unknown';
      availability: 'unknown';
      category: string;
      reasons: string[];
      nightly: Array<{
        date: string;
        availableCount: number | null;
        requestedCount: number;
        stockStatus: 'available' | 'sold' | 'restricted' | 'unknown';
        price: { status: 'known' | 'unknown'; amount: string | null; currency: string | null };
        reasons: string[];
      }>;
    }>;
  }>;
  coverage: {
    groupCount: number;
    readGroupCount: number;
    truncated: boolean;
    groups: Array<Record<string, unknown>>;
  };
}) | {
  outcome: 'execution_failure' | 'refused_lock_busy' | 'refused_lock_unavailable' |
    'refused_input_invalid' | 'refused_unknown_transport';
  error?: string;
};

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function realDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function observationTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source) ||
      !realDay(source.slice(0, 10))) return null;
  const time = Date.parse(source);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function amountString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const candidate = String(value).trim();
  return /^-?\d{1,15}(?:\.\d{1,4})?$/.test(candidate) ? candidate : null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim()) ? value.trim() : null;
}

function stockStatus(
  reasons: string[],
  availableCount: number | null,
  requestedCount: number,
): 'available' | 'sold' | 'restricted' | 'unknown' {
  if (reasons.some((reason) => /restrict|closed/i.test(reason))) return 'restricted';
  if (availableCount === 0) return 'sold';
  if (availableCount !== null && availableCount >= requestedCount && !reasons.includes('unknown')) return 'available';
  return 'unknown';
}

function mappedNight(value: unknown, requestedCount: number) {
  const source = record(value);
  if (!source || !realDay(source.date)) return null;
  const availableCount = Number.isSafeInteger(source.roomsAvailable) && Number(source.roomsAvailable) >= 0
    ? Number(source.roomsAvailable)
    : null;
  const reasons = Array.isArray(source.reasons) ? source.reasons.map(text).filter((item): item is string => item !== null).slice(0, 20) : [];
  const priceSource = record(source.price);
  const observedAmount = amountString(priceSource?.responseValue);
  const observedCurrency = currencyCode(priceSource?.currency);
  const priceCaptured = priceSource?.displayedTextStatus === 'captured' && observedAmount !== null && observedCurrency !== null;
  return {
    date: source.date,
    availableCount,
    requestedCount,
    stockStatus: stockStatus(reasons, availableCount, requestedCount),
    price: {
      status: priceCaptured ? 'known' as const : 'unknown' as const,
      amount: priceCaptured ? observedAmount : null,
      currency: priceCaptured ? observedCurrency : null,
    },
    reasons,
  };
}

function mapOption(value: unknown, requestedCount: number) {
  const source = record(value);
  if (!source) return null;
  const room = record(source.room);
  const rate = record(source.rate);
  const category = text(source.category) ?? 'unknown';
  const reasons = Array.isArray(source.reasons) ? source.reasons.map(text).filter((item): item is string => item !== null).slice(0, 30) : [];
  const nightly = Array.isArray(source.nights)
    ? source.nights.map((night) => mappedNight(night, requestedCount)).filter((night) => night !== null)
    : [];
  return {
    room: { code: text(room?.code), label: text(room?.label ?? room?.name) },
    ratePlan: { code: text(rate?.code), label: text(rate?.label ?? rate?.name) },
    promotionCode: text(rate?.promotioncode),
    rateScope: 'unknown' as const,
    eligibility: 'unknown' as const,
    // Per-night counts do not prove a room can be held across the whole stay.
    availability: 'unknown' as const,
    category,
    reasons,
    nightly,
  };
}

function coverageFor(view: RecordValue): Record<string, unknown> {
  const coverage = record(view.coverage) ?? {};
  const page = record(coverage.page) ?? {};
  const nights = record(coverage.nights) ?? {};
  const roomCatalog = record(coverage.roomCatalog) ?? {};
  const rateCatalog = record(coverage.rateCatalog) ?? {};
  return {
    ...coverage,
    page: { ...page },
    nights: { ...nights },
    roomCatalog: { ...roomCatalog },
    rateCatalog: { ...rateCatalog },
  };
}

function completenessIncomplete(coverage: Record<string, unknown>): boolean {
  const roomCatalog = record(coverage.roomCatalog);
  const rateCatalog = record(coverage.rateCatalog);
  const page = record(coverage.page);
  const nights = record(coverage.nights);
  return roomCatalog?.complete === false || rateCatalog?.complete === false ||
    page?.nextOffset != null || nights?.nextOffset != null;
}

/** Pure projector for the stable pane job result; never adds stay totals or rate entitlement. */
export function projectCloudAvailability(
  request: AvailabilityRequest,
  reads: CloudAvailabilityGroupRead[],
): HmsCloudAvailabilityResult {
  if (reads.length !== request.rooms.length || reads.some((read) => !['ok', 'criteria_unavailable'].includes(read.outcome))) {
    return { outcome: 'execution_failure', error: 'CLOUD_AVAILABILITY_READ_INCOMPLETE' };
  }
  const groups = reads.map((read, index) => {
    const requested = request.rooms[index]!;
    const view = record(read.view);
    if (!view || !Array.isArray(view.options) || record(view.coverage) === null) return null;
    const roomQuantity = record(view.roomQuantity);
    if (roomQuantity?.requested !== requested.quantity || roomQuantity.basis !== 'one_room_type_per_night' ||
        roomQuantity.combinedAvailability !== 'unknown') return null;
    const coverage = coverageFor(view);
    const criteriaMatch = record(coverage.checkedCriteriaMatch);
    const criteriaVerified = criteriaMatch?.propertyCode === true && criteriaMatch.dates === true &&
      criteriaMatch.occupancy === true;
    const groupOutcome = read.outcome === 'criteria_unavailable' || !criteriaVerified
      ? 'criteria_unavailable' as const
      : 'observed' as const;
    const options = view.options.map((option) => mapOption(option, requested.quantity)).filter((option) => option !== null);
    return {
      id: `group-${index + 1}`,
      requestedRoomType: requested.roomType,
      requestedCount: requested.quantity,
      requestedAdults: requested.adults,
      requestedChildAges: [...requested.childAges],
      outcome: groupOutcome,
      observedAt: observationTimestamp(view.observedAt),
      coverage,
      // An unverified/mismatched search cannot safely contribute room candidates.
      options: groupOutcome === 'observed' ? options : [],
    };
  });
  if (groups.some((group) => group === null)) return { outcome: 'execution_failure', error: 'CLOUD_AVAILABILITY_VIEW_INVALID' };
  const validGroups = groups as NonNullable<(typeof groups)[number]>[];
  const allUnavailable = validGroups.every((group) => group.outcome === 'criteria_unavailable');
  const flattenedCoverage = validGroups.map((group) => ({
    id: group.id,
    requestedRoomType: group.requestedRoomType,
    requestedCount: group.requestedCount,
    outcome: group.outcome,
    observedAt: group.observedAt,
    ...group.coverage,
  }));
  const observedGroups = validGroups.filter((group) => group.outcome === 'observed');
  const timestamps = observedGroups.map((group) => group.observedAt === null ? null : Date.parse(group.observedAt));
  const validTimestamps = timestamps.filter((value): value is number => value !== null && Number.isFinite(value));
  const observedAt = observedGroups.length > 0 && validTimestamps.length === observedGroups.length
    ? new Date(Math.min(...validTimestamps)).toISOString()
    : null;
  return {
    outcome: 'read',
    source: 'hms_cloud_hotel_availability',
    roomScope: 'all_room_types',
    priceEvidence: {
      label: 'estimate',
      priceBasis: 'unknown',
      quantityBasis: 'unknown',
      comparisonBasis: 'one_room_type_per_night',
      combinedAvailability: 'unknown',
      tax: 'unknown',
      officialTotal: 'unknown',
      contractRate: 'unknown',
    },
    searchOutcome: allUnavailable ? 'unavailable' : 'partial',
    observedAt,
    groups: validGroups,
    coverage: {
      groupCount: request.rooms.length,
      readGroupCount: validGroups.filter((group) => group.outcome === 'observed').length,
      truncated: validGroups.some((group) => completenessIncomplete(group.coverage)),
      groups: flattenedCoverage,
    },
  };
}

/** Runs the Cloud Hotel Availability reader with private snapshots removed on exit. */
export async function runCloudAvailability(input: CloudAvailabilityRunInput): Promise<CloudAvailabilityGroupRead[]> {
  const bootstrapUrl = new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url);
  const quoteReadUrl = new URL('../../tooling/hms-cloud/quote-read.mjs', import.meta.url);
  const quoteViewUrl = new URL('../../tooling/hms-cloud/quote-view.mjs', import.meta.url);
  const [bootstrap, quoteRead, quoteView] = await Promise.all([
    import(bootstrapUrl.href) as Promise<{ withCenturionStay360Page: <T>(operation: (page: unknown) => Promise<T>, options?: Record<string, unknown>) => Promise<T> }> ,
    import(quoteReadUrl.href) as Promise<{ readQuote: (page: unknown, input: Record<string, unknown>) => Promise<RecordValue> }> ,
    import(quoteViewUrl.href) as Promise<{ getQuoteView: (snapshot: unknown, filters: Record<string, unknown>) => RecordValue }> ,
  ]);
  const directory = await mkdtemp(join(tmpdir(), PRIVATE_SNAPSHOT_PREFIX));
  try {
    return await bootstrap.withCenturionStay360Page(async (page) => {
      const groups: CloudAvailabilityGroupRead[] = [];
      for (const [index, requested] of input.request.rooms.entries()) {
        input.signal?.throwIfAborted();
        const snapshotPath = join(directory, `room-group-${index}.json`);
        const criteria = {
          propertyCode: input.target.propertyCode,
          arrivalDate: input.request.arrival,
          departureDate: input.request.departure,
          adults: requested.adults,
          childCount: requested.childAges.length,
          childAges: [...requested.childAges],
          roomTypes: 'all',
          ratePlans: 'all',
          partyContext: {},
        };
        const quote = await quoteRead.readQuote(page, {
          criteria,
          roomQuantity: requested.quantity,
          snapshotPath,
          view: { limit: PAGE_SIZE, nightLimit: 31 },
        });
        if (quote.outcome !== 'ok' && quote.outcome !== 'criteria_unavailable') {
          groups.push({
            outcome: quote.outcome === 'input_gap' ? 'input_gap' : 'execution_failure',
            ...(typeof quote.issue === 'string' ? { issue: quote.issue } : {}),
          });
          continue;
        }
        if (!quote.view || typeof quote.snapshotPath !== 'string') {
          groups.push({ outcome: 'execution_failure', issue: 'CLOUD_QUOTE_VIEW_MISSING' });
          continue;
        }
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
        const firstView = record(quote.view);
        const firstCoverage = record(firstView?.coverage);
        const firstPage = record(firstCoverage?.page);
        const options = Array.isArray(firstView?.options) ? [...firstView.options] : [];
        let nextOffset = firstPage?.nextOffset;
        while (typeof nextOffset === 'number' && options.length < MAX_OPTIONS_PER_GROUP) {
          input.signal?.throwIfAborted();
          const limit = Math.min(PAGE_SIZE, MAX_OPTIONS_PER_GROUP - options.length);
          const next = quoteView.getQuoteView(snapshot, {
            roomQuantity: requested.quantity,
            offset: nextOffset,
            limit,
            nightLimit: 31,
          });
          if (!Array.isArray(next.options) || next.options.length === 0) break;
          options.push(...next.options);
          const nextPage = record(record(next.coverage)?.page);
          nextOffset = nextPage?.nextOffset;
        }
        const coverage = record(firstView?.coverage) ?? {};
        const pageInfo = record(coverage.page) ?? {};
        const coverageWithAllOptions = {
          ...coverage,
          page: { ...pageInfo, returned: options.length, nextOffset: typeof nextOffset === 'number' ? nextOffset : null },
        };
        groups.push({
          outcome: quote.outcome,
          view: { ...firstView, options: options.slice(0, MAX_OPTIONS_PER_GROUP), coverage: coverageWithAllOptions },
        });
      }
      return groups;
    }, { headless: true, signal: input.signal, blockServiceWorkers: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
