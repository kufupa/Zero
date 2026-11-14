import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailabilityRequest, RateContext } from './hms-availability.js';
import { buildCloudRateCandidates, orderRateCandidates, rateContextKey, type RateCandidate } from './rate-options.js';
import { isPropertyReadLockDeadline } from '../hms/property-read-lock.js';
import { classifyHmsLoginOutage } from '../hms/property-outage.js';
import type { AvailabilityProbeDeps } from './hms-availability.js';
import { hmsReadTargetForProperty, type HmsReadTarget } from '../hms/hms-read-target.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { withCloudReadSession } from '../../tooling/hms-cloud/cloud-session.mjs';

const PRIVATE_SNAPSHOT_PREFIX = 'nava-cloud-availability-';
// Prior HRCEN reads returned 496 rows; cap only unusually large views and expose any remaining cursor.
const MAX_OPTIONS_PER_GROUP = 1000;
const PAGE_SIZE = 50;

function supportedCloudTarget(target: HmsReadTarget): boolean {
  if (!target) return false;
  const property = getPropertyRegistration(target.propertyCode);
  if (!property?.active || target.origin !== property.origin) return false;
  const expected = hmsReadTargetForProperty(property.propertyCode);
  return target.propertyCode === expected.propertyCode && target.secretId === expected.secretId &&
    target.browserSlot === expected.browserSlot && target.origin === expected.origin &&
    target.installationEnvName === expected.installationEnvName;
}

type RecordValue = Record<string, unknown>;

export type CloudAvailabilityGroupRead = {
  outcome: 'ok' | 'criteria_unavailable' | 'input_gap' | 'execution_failure' | 'unsupported_context';
  issue?: string;
  view?: unknown;
};

export type CloudAvailabilityRunInput = {
  request: AvailabilityRequest;
  target: HmsReadTarget;
  signal?: AbortSignal;
  transportId?: string;
};

export type HmsCloudAvailabilityResult = ({
  outcome: 'read';
  source: 'hms_cloud_hotel_availability';
  roomScope: 'all_room_types' | 'selected_room_type';
  context?: RateContext;
  contextKey?: string;
  rateCandidates?: RateCandidate[];
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
      mealPlanLabel: string | null;
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
    candidateList: 'complete' | 'partial' | 'unknown';
    reason: string | null;
    groups: Array<Record<string, unknown>>;
  };
}) | { outcome: 'blocked'; error: string; contextKey: string | null; } | {
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
  if (reasons.includes('unknown')) return 'unknown';
  if (reasons.some((reason) => /restrict|closed/i.test(reason))) return 'restricted';
  // HMS conditions can include arrival closures and stay restrictions. Their applicability is not established here.
  if (reasons.includes('conditions_present')) return 'unknown';
  if (availableCount === 0) return 'sold';
  if (availableCount !== null && availableCount >= requestedCount) return 'available';
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
    room: { code: text(room?.code), label: text(room?.label ?? room?.name ?? room?.desc) },
    ratePlan: { code: text(rate?.code), label: text(rate?.label ?? rate?.name) },
    promotionCode: text(rate?.promotioncode),
    mealPlanLabel: text(source.mealPlan ?? rate?.mealPlan),
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

function unappliedStayContext(context: RateContext | undefined): string[] {
  if (!context) return [];
  return [context.guestProfileId ? 'GUEST_PROFILE_CONTEXT_UNAPPLIED' : null,
    context.sourceOfBusiness ? 'SOURCE_OF_BUSINESS_CONTEXT_UNAPPLIED' : null,
    context.track ? 'TRACK_CONTEXT_UNAPPLIED' : null,
    context.guaranteeType ? 'GUARANTEE_CONTEXT_UNAPPLIED' : null,
    context.retainRates === 'yes' ? 'RETAINED_PRICING_REQUIRES_PREPARE' : null]
    .filter((reason): reason is string => reason !== null);
}

/** Validate actual native IDs and scenario, not just a reader's aggregate match flag. */
function appliedContextMatches(request: AvailabilityRequest, view: RecordValue, unavailable: boolean): boolean {
  const context = request.rateContext;
  if (!context) return true;
  const applied = record(view.appliedCriteria);
  const coverage = record(view.coverage);
  const nights = record(coverage?.nights);
  if (!applied || !coverage || (!unavailable && nights?.matchesAppliedCriteria !== true) ||
      !['organizationID', 'travelAgencyID', 'groupID'].every(key => Object.hasOwn(applied, key))) return false;
  const codes = (value: unknown) => typeof value === 'string' ? value.split(',').map(item => item.trim()) : [];
  const expectedNights = (Date.parse(context.departure) - Date.parse(context.arrival)) / 86_400_000;
  const ages = applied.childAges ?? (Number(applied.childCount) === 0 ? [] : null);
  const start = String(applied.startDate).slice(0, 10);
  const nativeDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(start);
  const appliedArrival = nativeDate ? `${nativeDate[3]}-${nativeDate[1]}-${nativeDate[2]}` : start;
  return applied.propertyCodes === context.propertyCode && appliedArrival === context.arrival &&
    Number(applied.numberOfDays) === expectedNights && Number(applied.adultCount) === context.adults &&
    Number(applied.childCount) === context.childAges.length && JSON.stringify(ages) === JSON.stringify(context.childAges) &&
    String(applied.organizationID ?? '') === (context.organizationId ?? '') &&
    String(applied.travelAgencyID ?? '') === (context.bookingAgencyId ?? '') && String(applied.groupID ?? '') === '' &&
    codes(applied.roomTypeCodes).length === 1 && codes(applied.roomTypeCodes)[0] === context.roomCode &&
    (!context.typedRatePlan || (codes(applied.ratePlanCodes).length === 1 && codes(applied.ratePlanCodes)[0] === context.typedRatePlan));
}

/** Pure projector for the stable pane job result; never adds stay totals or rate entitlement. */
export function projectCloudAvailability(
  request: AvailabilityRequest,
  reads: CloudAvailabilityGroupRead[],
): HmsCloudAvailabilityResult {
  if (reads.some((read) => read.outcome === 'execution_failure' && classifyHmsLoginOutage(read.issue))) {
    return { outcome: 'execution_failure', error: 'AUTHENTICATED_SHELL_TIMEOUT' };
  }
  if (request.rateContext && (reads.some(read => read.outcome === 'unsupported_context' || read.outcome === 'input_gap') ||
      reads.some(read => ['ok', 'criteria_unavailable'].includes(read.outcome) &&
        (!record(read.view) || !appliedContextMatches(request, record(read.view)!, read.outcome === 'criteria_unavailable'))))) {
    return { outcome: 'blocked', error: reads.find(read => read.outcome === 'unsupported_context' || read.outcome === 'input_gap')?.issue ?? 'CLOUD_RATE_CONTEXT_UNVERIFIED', contextKey: rateContextKey(request.rateContext) };
  }
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
    const criteriaVerified = criteriaMatch?.property === true && criteriaMatch.dates === true &&
      criteriaMatch.occupancy === true && criteriaMatch.partyContext === true &&
      criteriaMatch.roomTypes === true && criteriaMatch.ratePlans === true;
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
  if (request.rateContext && groups.some((group, index) => group?.outcome === 'criteria_unavailable' &&
      reads[index]?.outcome !== 'criteria_unavailable')) {
    return { outcome: 'blocked', error: 'CLOUD_RATE_CONTEXT_UNVERIFIED', contextKey: rateContextKey(request.rateContext) };
  }
  if (groups.some((group) => group === null)) return { outcome: 'execution_failure', error: 'CLOUD_AVAILABILITY_VIEW_INVALID' };
  const validGroups = groups as NonNullable<(typeof groups)[number]>[];
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
  const truncated = validGroups.some((group) => completenessIncomplete(group.coverage));
  const filtered = Boolean(request.rateContext?.typedRatePlan);
  const complete = validGroups.every((group) => group.outcome === 'observed' && group.coverage.completeForRequestedScope === true);
  const unapplied = unappliedStayContext(request.rateContext);
  return {
    outcome: 'read',
    source: 'hms_cloud_hotel_availability',
    roomScope: request.rateContext ? 'selected_room_type' : 'all_room_types',
    ...(request.rateContext ? { context: request.rateContext, contextKey: rateContextKey(request.rateContext),
      rateCandidates: orderRateCandidates(request.rateContext, buildCloudRateCandidates(request.rateContext, validGroups))
        .map(candidate => ({ ...candidate, reasons: [...new Set([...candidate.reasons, ...unapplied])] })) } : {}),
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
    // Unverified search context is not evidence that rooms are unavailable.
    searchOutcome: 'partial',
    observedAt,
    groups: validGroups,
    coverage: {
      groupCount: request.rooms.length,
      readGroupCount: validGroups.filter((group) => group.outcome === 'observed').length,
      truncated,
      candidateList: truncated || filtered || unapplied.length ? 'partial' : complete ? 'complete' : 'unknown',
      reason: truncated ? 'NATIVE_RESULTS_TRUNCATED' : filtered ? 'TYPED_RATE_FILTER' : unapplied.length
        ? 'NATIVE_STAY_CONTEXT_PARTIAL' : complete ? null : 'NATIVE_COVERAGE_UNKNOWN',
      groups: flattenedCoverage,
    },
  };
}

/** Runs the Cloud Hotel Availability reader with private snapshots removed on exit. */
export async function runCloudAvailability(input: CloudAvailabilityRunInput): Promise<CloudAvailabilityGroupRead[]> {
  const property = input.target ? getPropertyRegistration(input.target.propertyCode) : null;
  if (!property || !supportedCloudTarget(input.target)) {
    return input.request.rooms.map((): CloudAvailabilityGroupRead => ({
      outcome: 'execution_failure', issue: 'CLOUD_READ_TARGET_UNSUPPORTED',
    }));
  }
  const { availabilityJobRequestSchema } = await import('./hms-availability.js');
  const parsed = availabilityJobRequestSchema.safeParse(input.request);
  if (!parsed.success) return input.request.rooms.map(() => ({ outcome: 'input_gap', issue: 'CLOUD_RATE_REQUEST_INVALID' }));
  const context = input.request.rateContext;
  if (context && context.propertyCode !== input.target.propertyCode) {
    return input.request.rooms.map(() => ({ outcome: 'unsupported_context', issue: 'CLOUD_RATE_CONTEXT_UNSUPPORTED' }));
  }
  const hotelAvailabilityUrl = new URL('../../tooling/hms-cloud/hotel-availability.mjs', import.meta.url);
  const quoteReadUrl = new URL('../../tooling/hms-cloud/quote-read.mjs', import.meta.url);
  const quoteViewUrl = new URL('../../tooling/hms-cloud/quote-view.mjs', import.meta.url);
  const guardUrl = new URL('../../tooling/hms-cloud/hms-read-only-guard.mjs', import.meta.url);
  const [quoteRead, quoteView, partyPicker, guard] = await Promise.all([
    import(quoteReadUrl.href) as Promise<{ readQuote: (page: unknown, input: Record<string, unknown>) => Promise<RecordValue> }> ,
    import(quoteViewUrl.href) as Promise<{ getQuoteView: (snapshot: unknown, filters: Record<string, unknown>) => RecordValue }> ,
    import(hotelAvailabilityUrl.href) as Promise<{
      searchHotelAvailabilityParty: (page: unknown, input: Record<string, unknown>) => Promise<RecordValue>;
      selectHotelAvailabilityParty: (page: unknown, input: Record<string, unknown>) => Promise<RecordValue>;
    }>,
    import(guardUrl.href) as Promise<{ installReadOnlyGuard: (context: unknown) => Promise<void> }>,
  ]);
  // /tmp itself is a Git worktree on this host; use the proven saved-stay quote location.
  const directory = await mkdtemp(join('/var/tmp', PRIVATE_SNAPSHOT_PREFIX));
  try {
    return await withCloudReadSession(async (page, identity) => {
      if (identity.propertyCode !== property.propertyCode || identity.tenantId !== property.expectedTenant ||
          identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin) {
        return input.request.rooms.map((): CloudAvailabilityGroupRead => ({
          outcome: 'execution_failure', issue: 'CLOUD_SESSION_IDENTITY_MISMATCH',
        }));
      }
      const groups: CloudAvailabilityGroupRead[] = [];
      for (const [kind, ref] of Object.entries(input.request.rateParties ?? {})) {
        if (!ref) continue;
        input.signal?.throwIfAborted();
        const nativeKind = kind === 'bookingAgency' ? 'bookingAgency' : 'organization';
        const search = await partyPicker.searchHotelAvailabilityParty(page, {
          kind: nativeKind, query: ref.name, propertyCode: input.target.propertyCode,
        });
        const candidates = Array.isArray(search.candidates) ? search.candidates.map(record).filter(candidate =>
          candidate?.nativeId === ref.nativeId && typeof candidate.name === 'string' &&
          candidate.name.trim().toLowerCase() === ref.name.trim().toLowerCase()) : [];
        if (search.outcome !== 'matches' || candidates.length !== 1 || typeof search.searchId !== 'string') {
          return input.request.rooms.map(() => ({ outcome: 'unsupported_context', issue: 'CLOUD_RATE_PARTY_NOT_VERIFIED' }));
        }
        const selected = await partyPicker.selectHotelAvailabilityParty(page, {
          kind: nativeKind, nativeId: ref.nativeId, searchId: search.searchId,
        });
        if (selected.outcome !== 'selected' || selected.nativeId !== ref.nativeId ||
            selected.evidence !== 'current_picker_and_field_readback') {
          return input.request.rooms.map(() => ({ outcome: 'unsupported_context', issue: 'CLOUD_RATE_PARTY_NOT_SELECTED' }));
        }
      }
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
          roomTypes: context ? [context.roomCode] : 'all',
          ratePlans: context?.typedRatePlan ? [context.typedRatePlan] : 'all',
          partyContext: context ? {
            ...(context.organizationId ? { organization: context.organizationId } : {}),
            ...(context.bookingAgencyId ? { bookingAgency: context.bookingAgencyId } : {}),
          } : {},
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
    }, { propertyCode: property.propertyCode, headless: true, signal: input.signal, startScreen: 'OSRESS',
      prepareContext: guard.installReadOnlyGuard, ...(input.transportId !== undefined && { transportId: input.transportId }) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Queued and direct availability reads share the same property lock and outage classification. */
export async function probeCloudRateAvailability(request: AvailabilityRequest, deps: AvailabilityProbeDeps & { signal?: AbortSignal }): Promise<HmsCloudAvailabilityResult> {
  const lock = deps.lock();
  if (!lock) return { outcome: 'refused_lock_unavailable' };
  try {
    const reads = await lock.withLock(() => runCloudAvailability({ request, target: deps.target, signal: deps.signal,
      ...(deps.transportId !== undefined && { transportId: deps.transportId }) }), deps.acquisition);
    return projectCloudAvailability(request, reads);
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { outcome: 'refused_lock_busy' };
    return { outcome: 'execution_failure', error: classifyHmsLoginOutage(error)
      ? 'AUTHENTICATED_SHELL_TIMEOUT' : 'CLOUD_RATE_READ_FAILED' };
  }
}
