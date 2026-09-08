/**
 * Live Room Type and Rate Availability (OSRRAV) quote driver.
 * One exact search; never CRS / result-click / paging / save.
 * Production rejects fixture HTML data-testid fallback.
 */
import {
  isoDateToHmsDisplay,
  quoteStayNightDates,
  type QuoteStayCandidate,
} from './quote-stay-candidate.js';
import type { QuoteNightObservation, QuoteStayReadData } from './quote-stay-contract.js';
import { extractOsressPageData } from './live-guest-stay-driver.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { buildQuoteStayReadData } from './quote-stay-contract.js';
import type { HmsBrowserAuditSpec } from './browser-artifacts.js';
import { HmsRuntimeError, type HmsRuntime } from './runtime.js';
import { createQuoteStayFacade } from './quote-stay-facade.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';

export const LIVE_QUOTE_AVAILABILITY_ALIAS_KEYS = [
  'roomTypeCode',
  'ratePlanCode',
  'date',
  'numOfAvailable',
  'roomRate',
  'closed',
  'closedToArrival',
  'closedToDeparture',
  'restricted',
  'minLOSToArrival',
  'maxLOSToArrival',
] as const;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('quote observe aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/** Parse Infor mixed object-literal / JSON search envelopes. */
export function parseOsrravSearchEnvelope(text: string): Record<string, unknown> | null {
  const fromPageData = extractOsressPageData(text);
  if (fromPageData) return fromPageData;
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (parsed.pageData && typeof parsed.pageData === 'object') {
      return parsed.pageData as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isoFromHmsDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})/i.exec(t);
  if (!m) return null;
  const months: Record<string, string> = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12',
  };
  const mm = months[m[2]!.toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]}`;
}

/** Prefer stable decimal string matching quoteStay schema. */
function amountString(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw.toFixed(2);
  }
  if (typeof raw === 'string' && /^\d+(?:\.\d{1,2})?$/.test(raw.trim())) {
    return raw.trim();
  }
  return null;
}

function restrictionTokens(day: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (day.closed === true) out.push('closed');
  if (day.closedToArrival === true || day.combClosedToArrival === true) {
    out.push('closed-to-arrival');
  }
  if (day.closedToDeparture === true || day.combClosedToDeparture === true) {
    out.push('closed-to-departure');
  }
  if (day.restricted === true) out.push('restricted-rate');
  const minLos = day.minLOSToArrival ?? day.combMinLOSToArrival;
  if (typeof minLos === 'number' && minLos > 1) {
    out.push(`min-los-arrival-${minLos}`);
  }
  const maxLos = day.maxLOSToArrival;
  if (typeof maxLos === 'number' && maxLos > 0) {
    out.push(`max-los-arrival-${maxLos}`);
  }
  return out.length > 0 ? out.slice(0, 20) : ['none'];
}

/**
 * Map live OSRRAV availabilitydata → nightly observations.
 * Rejects fixture HTML (`data-testid="quote-night"`).
 */
export function parseLiveQuoteAvailability(
  text: string,
  candidate: QuoteStayCandidate,
  observedAt: Date,
): {
  envelopeRecognized: boolean;
  rows: QuoteNightObservation[];
  unresolvedFields: string[];
  currency: string | null;
} {
  if (/data-testid\s*=\s*["']quote-night["']/i.test(text)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML quote fallback rejected in live driver',
    );
  }
  const pageData = parseOsrravSearchEnvelope(text);
  if (!pageData) {
    return {
      envelopeRecognized: false,
      rows: [],
      unresolvedFields: ['quote_surface_envelope'],
      currency: null,
    };
  }
  if (pageData.success === false) {
    const messages = Array.isArray(pageData.messages) ? pageData.messages : [];
    const types = messages
      .map((m) => (m && typeof m === 'object' ? String((m as { type?: unknown }).type ?? '') : ''))
      .filter(Boolean);
    return {
      envelopeRecognized: true,
      rows: [],
      unresolvedFields: types.includes('error') ? ['quote_search_error'] : ['quote_search_failed'],
      currency: null,
    };
  }

  const values = pageData.values;
  if (!values || typeof values !== 'object') {
    return {
      envelopeRecognized: false,
      rows: [],
      unresolvedFields: ['quote_surface_envelope'],
      currency: null,
    };
  }
  const availability = (values as Record<string, unknown>).availabilitydata;
  if (!availability || typeof availability !== 'object') {
    return {
      envelopeRecognized: false,
      rows: [],
      unresolvedFields: ['quote_surface_envelope'],
      currency: null,
    };
  }
  const ad = availability as Record<string, unknown>;
  const currencyRaw = ad.uoc;
  const currency =
    typeof currencyRaw === 'string' && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : null;

  const roomTypes = Array.isArray(ad.roomTypeInvArray)
    ? (ad.roomTypeInvArray as Record<string, unknown>[])
    : [];
  const rows: QuoteNightObservation[] = [];
  const unresolvedFields: string[] = [];
  const observedAtIso = observedAt.toISOString();

  for (const [rti, rt] of roomTypes.entries()) {
    const roomType = String(rt.roomTypeCode ?? '').trim();
    const ratePlans = Array.isArray(rt.ratePlanInvArray)
      ? (rt.ratePlanInvArray as Record<string, unknown>[])
      : [];
    const dailyInv = Array.isArray(rt.roomTypeDailyInvArray)
      ? (rt.roomTypeDailyInvArray as Record<string, unknown>[])
      : [];
    const availByDate = new Map<string, number>();
    for (const day of dailyInv) {
      const date = isoFromHmsDate(day.date);
      if (!date) continue;
      const n = day.numOfAvailable;
      if (typeof n === 'number' && Number.isInteger(n)) {
        availByDate.set(date, n);
      }
    }
    for (const [rpi, rp] of ratePlans.entries()) {
      const ratePlan = String(rp.ratePlanCode ?? '').trim();
      const rateCurrency =
        typeof rp.uoc === 'string' && /^[A-Z]{3}$/.test(rp.uoc) ? rp.uoc : currency;
      const daily = Array.isArray(rp.ratePlanDailyInvArray)
        ? (rp.ratePlanDailyInvArray as Record<string, unknown>[])
        : [];
      for (const [di, day] of daily.entries()) {
        const prefix = `nightly.row.${rti}.${rpi}.${di}`;
        const date = isoFromHmsDate(day.date);
        const amount = amountString(day.roomRate);
        const availableCount =
          typeof day.combNumOfAvailable === 'number' && Number.isInteger(day.combNumOfAvailable)
            ? day.combNumOfAvailable
            : date
              ? (availByDate.get(date) ?? null)
              : null;
        if (!date) unresolvedFields.push(`${prefix}.date`);
        if (!roomType) unresolvedFields.push(`${prefix}.roomType`);
        if (availableCount === null) {
          unresolvedFields.push(`${prefix}.availableCount`);
        }
        if (!ratePlan) unresolvedFields.push(`${prefix}.ratePlan`);
        if (!amount) unresolvedFields.push(`${prefix}.displayedAmount`);
        if (!rateCurrency) unresolvedFields.push(`${prefix}.currency`);
        if (date && roomType && ratePlan && amount && rateCurrency && availableCount !== null) {
          rows.push({
            date,
            roomType,
            availableCount,
            ratePlan,
            displayedAmount: amount,
            currency: rateCurrency,
            rateBasis: 'nightly',
            restrictions: restrictionTokens(day),
            observedAt: observedAtIso,
          });
        }
      }
    }
  }

  return {
    envelopeRecognized: true,
    rows,
    unresolvedFields: [...new Set(unresolvedFields)],
    currency,
  };
}

function emptyQuoteData(
  candidate: QuoteStayCandidate,
  unresolvedInputs: readonly string[] = [],
): QuoteStayReadData {
  return buildQuoteStayReadData({
    nightlyObservations: [],
    requestedRooms: candidate.rooms,
    requestRef: candidate.quoteRequestRef,
    arrival: candidate.arrivalDate,
    departure: candidate.departureDate,
    rooms: candidate.normalizedRooms,
    currency: candidate.currency,
    unresolvedInputs,
  });
}

function quoteToolResult(input: {
  status: ToolResult<QuoteStayReadData>['status'];
  data: QuoteStayReadData;
  unresolvedFields: string[];
  observedAt: Date;
  sourceSeed: unknown;
  candidate: QuoteStayCandidate;
  draftReady: boolean;
  propertyCode?: string;
}): ToolResult<QuoteStayReadData> {
  const claimKeys = input.data.nightlyObservations.flatMap((_, index) => [
    `nightlyObservations.${index}.date`,
    `nightlyObservations.${index}.roomType`,
    `nightlyObservations.${index}.availableCount`,
    `nightlyObservations.${index}.ratePlan`,
    `nightlyObservations.${index}.displayedAmount`,
    `nightlyObservations.${index}.currency`,
    `nightlyObservations.${index}.rateBasis`,
    `nightlyObservations.${index}.restrictions`,
  ]);
  return {
    status: input.status,
    draftReady: input.draftReady,
    data: input.data,
    unresolvedFields: input.unresolvedFields,
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      propertyCode: input.propertyCode ?? 'HRCEN',
      observedAt: input.observedAt.toISOString(),
      expiresAt: new Date(input.observedAt.getTime() + 15 * 60_000).toISOString(),
      claimKeys,
      sourceHash: sha256Hex(
        canonicalJson({
          candidate: input.candidate,
          data: input.data,
          propertyCode: input.propertyCode ?? 'HRCEN',
          sourceSeed: input.sourceSeed,
          unresolvedFields: input.unresolvedFields,
        }),
      ),
    },
  };
}

async function observeQuoteWithinSession(input: {
  session: import('./runtime.js').HmsReadSession;
  candidate: QuoteStayCandidate;
  signal: AbortSignal;
  observedAt: Date;
}): Promise<ToolResult<QuoteStayReadData>> {
  const { session, candidate, signal, observedAt } = input;
  assertNotAborted(signal);
  const facade = createQuoteStayFacade(session);
  await facade.navigate();
  const chrome = await facade.collectChromeDefaults();
  const text = await facade.searchExact(candidate, chrome);
  if (session.terminal() || session.violation()) {
    return quoteToolResult({
      candidate,
      status: 'manual_required',
      data: emptyQuoteData(candidate, ['request_policy']),
      unresolvedFields: ['request_policy'],
      observedAt,
      sourceSeed: { stage: 'request_policy' },
      draftReady: false,
    });
  }

  assertNotAborted(signal);
  const parsed = parseLiveQuoteAvailability(text, candidate, observedAt);
  if (!parsed.envelopeRecognized) {
    return quoteToolResult({
      candidate,
      status: 'manual_required',
      data: emptyQuoteData(candidate, parsed.unresolvedFields),
      unresolvedFields: parsed.unresolvedFields,
      observedAt,
      sourceSeed: { stage: 'quote_envelope_unrecognized' },
      draftReady: false,
    });
  }

  const nights = quoteStayNightDates(candidate);
  const nightSet = new Set(nights);
  const inWindow = parsed.rows.filter((row) => nightSet.has(row.date));
  if (
    inWindow.length === 0 &&
    parsed.unresolvedFields.length === 0 &&
    !parsed.unresolvedFields.includes('quote_search_error')
  ) {
    return quoteToolResult({
      candidate,
      status: 'unverified_negative',
      data: emptyQuoteData(candidate, ['unverified_negative']),
      unresolvedFields: ['unverified_negative'],
      observedAt,
      sourceSeed: { stage: 'quote_empty_unverified' },
      draftReady: false,
    });
  }

  const unresolved = [...parsed.unresolvedFields];
  if (parsed.rows.some((row) => !nightSet.has(row.date))) {
    unresolved.push('nightly.out_of_window');
  }
  const byNight = new Map<string, QuoteNightObservation[]>();
  for (const row of inWindow) {
    const matches = byNight.get(row.date) ?? [];
    matches.push(row);
    byNight.set(row.date, matches);
  }
  for (const night of nights) {
    const rows = byNight.get(night) ?? [];
    if (rows.length === 0) unresolved.push(`nightly.${night}`);
    if (rows.length > 1) unresolved.push(`nightly.${night}.ambiguous`);
  }

  // Prefer rows matching authored room/rate when multiple; ambiguity remains
  // explicit and no alternate row is silently selected.
  const filtered = inWindow.filter(
    (row) =>
      row.roomType.toUpperCase() === candidate.roomType.toUpperCase() &&
      row.ratePlan.toUpperCase() === candidate.ratePlan.toUpperCase(),
  );
  const useRows = filtered;
  if (inWindow.length > 0 && filtered.length === 0) {
    unresolved.push('room_rate_scope_mismatch');
  }
  const uniqueUnresolved = [...new Set(unresolved)];
  const draftReady = uniqueUnresolved.length === 0 && useRows.length === nights.length;
  const data = buildQuoteStayReadData({
    nightlyObservations: useRows,
    requestedRooms: candidate.rooms,
    requestRef: candidate.quoteRequestRef,
    arrival: candidate.arrivalDate,
    departure: candidate.departureDate,
    rooms: candidate.normalizedRooms,
    currency: candidate.currency ?? parsed.currency ?? undefined,
    unresolvedInputs: uniqueUnresolved,
  });
  return quoteToolResult({
    candidate,
    status: draftReady ? 'ok' : 'manual_required',
    data,
    unresolvedFields: uniqueUnresolved,
    observedAt,
    sourceSeed: {
      stage: 'quote_live',
      requestRef: candidate.quoteRequestRef ?? null,
      rows: useRows,
    },
    draftReady,
  });
}

function attachFinalizedQuoteReceipt(
  result: ToolResult<QuoteStayReadData>,
  session: import('./runtime.js').HmsReadSession,
  auditSpec: HmsBrowserAuditSpec | undefined,
): ToolResult<QuoteStayReadData> {
  if (!auditSpec || result.evidence.kind !== 'hms') return result;
  const receipt = typeof session.lastReceipt === 'function' ? session.lastReceipt() : null;
  const receiptMatches = Boolean(
    receipt &&
      receipt.artifactState === 'complete' &&
      receipt.toolId === auditSpec.toolId &&
      receipt.operationId === auditSpec.operationId &&
      receipt.executionClass === auditSpec.executionClass &&
      receipt.inputClass === auditSpec.inputClass &&
      receipt.operationOutcome === 'succeeded' &&
      (!auditSpec.requestBranchId || receipt.requestBranchId === auditSpec.requestBranchId),
  );
  if (!receiptMatches) {
    return {
      ...result,
      status: 'manual_required',
      draftReady: false,
      unresolvedFields: [...new Set([...result.unresolvedFields, 'audit_capture_receipt'])],
    };
  }
  return {
    ...result,
    evidence: { ...result.evidence, artifactRef: receipt!.artifactId },
  };
}

export type LiveQuoteStayDriver = {
  observeExactQuote(
    authorization: HmsSessionAuthorization,
    candidate: QuoteStayCandidate,
    signal: AbortSignal,
  ): Promise<ToolResult<QuoteStayReadData>>;
};

export function createLiveQuoteStayDriver(input: {
  runtime: HmsRuntime;
  transportId: string;
  /** Normal read sessions require the same audited execution seam as find. */
  auditSpecFor?: (input: { candidate: QuoteStayCandidate }) => HmsBrowserAuditSpec | undefined;
}): LiveQuoteStayDriver {
  const { runtime, transportId } = input;

  return {
    async observeExactQuote(authorization, candidate, signal) {
      assertNotAborted(signal);
      if (authorization.toolId !== 'hms_quote_stay') {
        throw new HmsRuntimeError(
          'ROLE_SCOPE_INVALID',
          'authorization toolId must be hms_quote_stay',
        );
      }
      if (authorization.discoveryOperationId !== 'quote_availability_search') {
        throw new HmsRuntimeError(
          'ROLE_SCOPE_INVALID',
          'authorization discoveryOperationId mismatch',
        );
      }
      if (authorization.requestBranchId !== 'quote_availability_search') {
        throw new HmsRuntimeError(
          'ROLE_SCOPE_INVALID',
          'authorization requestBranchId denied for quote stay',
        );
      }
      if (Date.parse(authorization.expiresAt) <= Date.now()) {
        throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
      }

      const observedAt = new Date();
      const auditSpec = input.auditSpecFor?.({ candidate });
      const nights = quoteStayNightDates(candidate);
      if (nights.length === 0) {
        return quoteToolResult({
          candidate,
          status: 'manual_required',
          data: emptyQuoteData(candidate, ['quote_input']),
          unresolvedFields: ['quote_input'],
          observedAt,
          sourceSeed: 'invalid-quote-nights',
          draftReady: false,
        });
      }

      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        auditSpec,
        sessionAuthorization: authorization,
      });

      let result: ToolResult<QuoteStayReadData>;
      try {
        result = await observeQuoteWithinSession({
          session,
          candidate,
          signal,
          observedAt,
        });
      } finally {
        await session.close();
      }
      return attachFinalizedQuoteReceipt(result, session, auditSpec);
    },
  };
}

/** Brief interface — requires driver factory binding via closure. */
export function observeExactQuote(
  this: LiveQuoteStayDriver | void,
  authorization: HmsSessionAuthorization,
  candidate: QuoteStayCandidate,
  signal: AbortSignal,
): Promise<ToolResult<QuoteStayReadData>> {
  if (!this || typeof this.observeExactQuote !== 'function') {
    throw new Error(
      'observeExactQuote requires createLiveQuoteStayDriver(...).observeExactQuote binding',
    );
  }
  return this.observeExactQuote(authorization, candidate, signal);
}

void isoDateToHmsDisplay;
void LIVE_QUOTE_AVAILABILITY_ALIAS_KEYS;
