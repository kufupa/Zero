/**
 * Fixture/synthetic HMS reservation + stay-option read adapter.
 * Resolves opaque LookupCandidate IDs server-side. Never claims bookability.
 * Room Availability and Display Rates stay separate observations.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import type { LookupCandidate } from '../ai/thread-context.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import {
  centurionManifestSchema,
  reservationReadDataSchema,
  stayOptionReadDataSchema,
  type CenturionManifest,
  type QuoteNightObservation,
  type ReservationObservation,
  type ReservationReadData,
  type StayOptionReadData,
} from './contracts.js';
import type { HmsPage, HmsReadSession } from './runtime.js';
import { isSentinelGuestName } from '../ops/hms-find-match-compare.js';

export const HMS_FIND_RESERVATION_TOOL_ID = 'hms_find_reservation';
export const HMS_QUOTE_STAY_TOOL_ID = 'hms_quote_stay';
export const HMS_FIND_RESERVATION_TOOL_VERSION = '1.2.0';
export const HMS_QUOTE_STAY_TOOL_VERSION = '2.0.0';

export const RESERVATION_EVIDENCE_TTL_MS = 5 * 60_000;
export const QUOTE_EVIDENCE_TTL_MS = 15 * 60_000;
export const RESERVATION_MATCH_CAP = 20;

const ACTIVE_STATUSES = new Set([
  'reserved',
  'confirmed',
  'inhouse',
  'in-house',
  'arrived',
]);

const CANCELED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'no-show',
  'noshow',
  'no_show',
]);

export type ReservationLookupInput = { candidateId: string };

export type QuoteInput = {
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  rooms: number;
  roomType?: string;
  ratePlan?: string;
  boardBasis?: string;
  currency: string;
};

export interface HmsReadAdapter {
  findReservation(
    input: ReservationLookupInput,
    candidates: ReadonlyMap<string, LookupCandidate>,
    signal: AbortSignal,
  ): Promise<ToolResult<ReservationReadData>>;
  quoteStay(
    input: QuoteInput,
    signal: AbortSignal,
  ): Promise<ToolResult<StayOptionReadData>>;
}

export type HmsReadAdapterOptions = {
  session: Pick<HmsReadSession, 'page' | 'origin' | 'violation' | 'terminal'>;
  manifest: CenturionManifest;
  /** Override manifest binding origin with live session origin (fixture ports). */
  rebaseOrigin?: boolean;
  now?: () => Date;
  /** When set, record navigated pathnames (tests assert no detail on ambiguity). */
  onNavigate?: (path: string) => void;
};

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('HMS adapter aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function attrOrNull(
  el: { attr(name: string): string | undefined },
  attr: string,
): string | null {
  const raw = el.attr(attr);
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoDateOrNull(value: string | null): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function eachNight(arrivalDate: string, departureDate: string): string[] {
  const nights: string[] = [];
  let cursor = Date.parse(`${arrivalDate}T00:00:00.000Z`);
  const end = Date.parse(`${departureDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) {
    return nights;
  }
  while (cursor < end) {
    nights.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return nights;
}

function minimizeIdentities(
  matches: ReservationObservation[],
  status: ToolResult<ReservationReadData>['status'],
): ReservationObservation[] {
  if (status !== 'ambiguous' && status !== 'partial') {
    return matches;
  }
  // Ambiguous / partial: strip guest names so model never sees unrelated PII.
  return matches.map((row) => ({ ...row, guestName: null }));
}

function loadBundledManifest(): CenturionManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(
    readFileSync(join(here, 'centurion.manifest.json'), 'utf8'),
  ) as unknown;
  return centurionManifestSchema.parse(raw);
}

export function loadCenturionManifest(
  raw?: unknown,
): CenturionManifest {
  if (raw === undefined) return loadBundledManifest();
  return centurionManifestSchema.parse(raw);
}

/** Rebase every rule origin + binding.origin onto the session loopback origin. */
export function rebaseManifestOrigin(
  manifest: CenturionManifest,
  origin: string,
): CenturionManifest {
  return centurionManifestSchema.parse({
    ...manifest,
    binding: { ...manifest.binding, origin },
    rules: manifest.rules.map((rule) => ({ ...rule, origin })),
  });
}

function emptyReservationData(): ReservationReadData {
  return reservationReadDataSchema.parse({
    matches: [],
    matchCount: 0,
    capped: false,
  });
}

function emptyStayData(rooms: number): StayOptionReadData {
  return stayOptionReadDataSchema.parse({
    nightlyObservations: [],
    bookable: false as const,
    stayTotal: null,
    occupancyPriced: false,
    requestedRooms: rooms,
  });
}

export class InforReadAdapter implements HmsReadAdapter {
  readonly #page: HmsPage;
  readonly #origin: string;
  readonly #manifest: CenturionManifest;
  readonly #now: () => Date;
  readonly #onNavigate?: (path: string) => void;
  readonly #violation: () => ReturnType<HmsReadSession['violation']>;
  readonly #terminal: () => boolean;

  constructor(options: HmsReadAdapterOptions) {
    this.#page = options.session.page;
    this.#origin = options.session.origin;
    this.#manifest =
      options.rebaseOrigin === false
        ? options.manifest
        : rebaseManifestOrigin(options.manifest, options.session.origin);
    this.#now = options.now ?? (() => new Date());
    this.#onNavigate = options.onNavigate;
    this.#violation = () => options.session.violation();
    this.#terminal = () => options.session.terminal();
  }

  async findReservation(
    input: ReservationLookupInput,
    candidates: ReadonlyMap<string, LookupCandidate>,
    signal: AbortSignal,
  ): Promise<ToolResult<ReservationReadData>> {
    assertNotAborted(signal);
    const observedAt = this.#now();
    const candidate = candidates.get(input.candidateId);
    if (!candidate) {
      return this.#reservationResult({
        status: 'manual_required',
        data: emptyReservationData(),
        unresolvedFields: ['candidateId'],
        observedAt,
        claimKeys: [],
        sourceSeed: `missing:${input.candidateId}`,
      });
    }

    const binding = await this.#page.readPropertyBinding();
    if (
      binding.propertyCode !== this.#manifest.binding.propertyKey ||
      binding.tenant !== this.#manifest.binding.tenantId
    ) {
      return this.#reservationResult({
        status: 'manual_required',
        data: emptyReservationData(),
        unresolvedFields: ['property_binding'],
        observedAt,
        claimKeys: [],
        sourceSeed: `wrong-property:${binding.propertyCode ?? 'null'}`,
      });
    }

    const selectors = this.#manifest.selectors.reservation;
    await this.#goto(selectors.pagePath);
    assertNotAborted(signal);
    if (this.#terminal() || this.#violation()) {
      return this.#reservationResult({
        status: 'manual_required',
        data: emptyReservationData(),
        unresolvedFields: ['request_policy'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'policy-violation',
      });
    }

    const fields = this.#searchFields(candidate);
    await this.#page.postForm(
      new URL(selectors.searchPath, this.#origin).toString(),
      fields,
    );
    this.#onNavigate?.(selectors.searchPath);
    assertNotAborted(signal);

    if (this.#terminal() || this.#violation()) {
      return this.#reservationResult({
        status: 'manual_required',
        data: emptyReservationData(),
        unresolvedFields: ['request_policy'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'policy-violation-search',
      });
    }

    const html = await this.#page.content();
    const parsed = this.#parseReservationRows(html);
    const correlated =
      candidate.kind === 'confirmation'
        ? parsed.rows.filter(
            (row) =>
              (row.confirmationNumber ?? '').toUpperCase() ===
              candidate.value.toUpperCase(),
          )
        : candidate.kind === 'external_reference'
          ? parsed.rows.filter(
              (row) =>
                (row.externalReference ?? '').toUpperCase() ===
                candidate.value.toUpperCase(),
            )
          : parsed.rows;
    // Cap/ambiguity are correlation-scoped, not raw list length.
    const capped = correlated.length > RESERVATION_MATCH_CAP;
    const matches = correlated.slice(0, RESERVATION_MATCH_CAP);

    if (matches.length === 0) {
      return this.#reservationResult({
        status: 'unverified_negative',
        data: reservationReadDataSchema.parse({
          matches: [],
          matchCount: 0,
          capped: false,
        }),
        unresolvedFields: [],
        observedAt,
        claimKeys: [],
        sourceSeed: `none:${candidate.kind}`,
      });
    }

    if (matches.length > 1 || capped) {
      const status = 'ambiguous' as const;
      const minimized = minimizeIdentities(matches, status);
      return this.#reservationResult({
        status,
        data: reservationReadDataSchema.parse({
          matches: minimized,
          matchCount: correlated.length,
          capped,
        }),
        unresolvedFields: ['match_selection'],
        observedAt,
        claimKeys: minimized.flatMap((_, i) => [
          `matches.${i}.confirmationNumber`,
          `matches.${i}.arrivalDate`,
          `matches.${i}.departureDate`,
        ]),
        sourceSeed: `ambiguous:${matches.length}:${capped}`,
      });
      // Intentionally never open detail links on ambiguity.
    }

    // Exactly one list row — enrich from list attrs only (no forced detail nav).
    const single = matches[0]!;
    // Search-grid roomType optional; ratePlan never a find claim (session parity).
    const matchedRow = { ...single, ratePlan: null as string | null };
    const unresolvedFields: string[] = [];
    if (!matchedRow.confirmationNumber && !matchedRow.externalReference) {
      unresolvedFields.push('confirmationNumber');
    }
    if (!matchedRow.arrivalDate) unresolvedFields.push('arrivalDate');
    if (!matchedRow.departureDate) unresolvedFields.push('departureDate');
    if (!matchedRow.reservationStatus) unresolvedFields.push('reservationStatus');
    if (!matchedRow.guestName || isSentinelGuestName(matchedRow.guestName)) {
      unresolvedFields.push('guestName');
      matchedRow.guestName = isSentinelGuestName(matchedRow.guestName)
        ? null
        : matchedRow.guestName;
    }
    if (!matchedRow.roomType) unresolvedFields.push('roomType');
    if (
      matchedRow.arrivalDate === null &&
      matchedRow.departureDate === null &&
      (matchedRow.confirmationNumber || matchedRow.externalReference)
    ) {
      // Malformed date attrs present as empty
      if (!unresolvedFields.includes('arrivalDate')) {
        unresolvedFields.push('arrivalDate');
      }
    }

    // Detect malformed non-ISO dates on the correlated row only.
    const $ = cheerio.load(html);
    const matchedNode = $(selectors.resultRow)
      .toArray()
      .map((el) => $(el))
      .find((node) => {
        if (candidate.kind === 'confirmation') {
          return (
            (attrOrNull(node, selectors.confirmationAttr) ?? '').toUpperCase() ===
            candidate.value.toUpperCase()
          );
        }
        if (candidate.kind === 'external_reference') {
          return (
            (attrOrNull(node, selectors.externalRefAttr) ?? '').toUpperCase() ===
            candidate.value.toUpperCase()
          );
        }
        return false;
      });
    if (matchedNode) {
      const rawArrival = matchedNode.attr(selectors.arrivalAttr);
      const rawDeparture = matchedNode.attr(selectors.departureAttr);
      if (rawArrival && !matchedRow.arrivalDate) {
        unresolvedFields.push('arrivalDate');
      }
      if (rawDeparture && !matchedRow.departureDate) {
        unresolvedFields.push('departureDate');
      }
    }

    const statusLower = (matchedRow.reservationStatus ?? '').toLowerCase();
    const canceled = CANCELED_STATUSES.has(statusLower);
    const active = ACTIVE_STATUSES.has(statusLower);

    let status: ToolResult<ReservationReadData>['status'] = 'ok';
    if (unresolvedFields.length > 0) status = 'partial';
    if (canceled) {
      // Canceled/no-show is concrete but not active-stay draft-ready.
      if (!unresolvedFields.includes('reservationStatus.active')) {
        unresolvedFields.push('reservationStatus.active');
      }
      status = 'partial';
    } else if (matchedRow.reservationStatus && !active) {
      unresolvedFields.push('reservationStatus.active');
      status = 'partial';
    }

    const draftReady =
      status === 'ok' &&
      unresolvedFields.length === 0 &&
      !canceled &&
      active;

    const claimKeys: string[] = [];
    if (matchedRow.confirmationNumber) claimKeys.push('matches.0.confirmationNumber');
    if (matchedRow.externalReference) claimKeys.push('matches.0.externalReference');
    if (matchedRow.guestName) claimKeys.push('matches.0.guestName');
    if (matchedRow.reservationStatus) claimKeys.push('matches.0.reservationStatus');
    if (matchedRow.arrivalDate) claimKeys.push('matches.0.arrivalDate');
    if (matchedRow.departureDate) claimKeys.push('matches.0.departureDate');
    if (matchedRow.roomType) claimKeys.push('matches.0.roomType');
    // Never claim ratePlan on find — even if fixture invents rateplan.

    return this.#reservationResult({
      status,
      data: reservationReadDataSchema.parse({
        matches: [matchedRow],
        matchCount: 1,
        capped: false,
      }),
      unresolvedFields: [...new Set(unresolvedFields)],
      observedAt,
      claimKeys,
      sourceSeed: `one:${matchedRow.confirmationNumber ?? matchedRow.externalReference}`,
      draftReady,
    });
  }

  async quoteStay(
    input: QuoteInput,
    signal: AbortSignal,
  ): Promise<ToolResult<StayOptionReadData>> {
    assertNotAborted(signal);
    const observedAt = this.#now();
    const selectors = this.#manifest.selectors.quote;
    const nights = eachNight(input.arrivalDate, input.departureDate);

    if (
      nights.length === 0 ||
      nights.length > 30 ||
      input.rooms < 1 ||
      input.rooms > 4 ||
      input.adults < input.rooms ||
      input.adults + input.children > 16 ||
      !/^[A-Z]{3}$/.test(input.currency)
    ) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(Math.max(1, input.rooms || 1)),
        unresolvedFields: ['quote_input'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'invalid-quote-input',
        draftReady: false,
      });
    }

    const binding = await this.#page.readPropertyBinding();
    if (
      binding.propertyCode !== this.#manifest.binding.propertyKey ||
      binding.tenant !== this.#manifest.binding.tenantId
    ) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(input.rooms),
        unresolvedFields: ['property_binding'],
        observedAt,
        claimKeys: [],
        sourceSeed: `wrong-property-quote:${binding.propertyCode ?? 'null'}`,
        draftReady: false,
      });
    }

    const fields: Record<string, string> = {
      action: 'search',
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      adults: String(input.adults),
      children: String(input.children),
      rooms: String(input.rooms),
      roomType: input.roomType ?? '',
      ratePlan: input.ratePlan ?? '',
      currency: input.currency,
    };
    const html = await this.#page.postForm(
      new URL(selectors.searchPath, this.#origin).toString(),
      fields,
    );
    this.#onNavigate?.(selectors.searchPath);
    assertNotAborted(signal);

    if (this.#terminal() || this.#violation()) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(input.rooms),
        unresolvedFields: ['request_policy'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'policy-quote-search',
        draftReady: false,
      });
    }

    const parsed = this.#parseQuoteNights(html, observedAt, input);
    const nightSet = new Set(nights);
    const inWindowRows = parsed.rows.filter((row) => nightSet.has(row.date));
    if (!parsed.envelopeRecognized) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(input.rooms),
        unresolvedFields: ['quote_surface_envelope'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'quote-envelope-unrecognized',
        draftReady: false,
      });
    }
    if (inWindowRows.length === 0 && parsed.unresolvedFields.length === 0) {
      return this.#quoteResult({
        status: 'unverified_negative',
        data: emptyStayData(input.rooms),
        unresolvedFields: [],
        observedAt,
        claimKeys: [],
        sourceSeed: 'quote-empty-unverified',
        draftReady: false,
      });
    }
    const unresolvedFields: string[] = [];
    unresolvedFields.push(...parsed.unresolvedFields);
    if (parsed.rows.some((row) => !nightSet.has(row.date))) {
      unresolvedFields.push('nightly.out_of_window');
    }
    const byNight = new Map<string, QuoteNightObservation[]>();
    for (const row of inWindowRows) {
      const matches = byNight.get(row.date) ?? [];
      matches.push(row);
      byNight.set(row.date, matches);
    }
    for (const night of nights) {
      const rows = byNight.get(night) ?? [];
      if (rows.length === 0) unresolvedFields.push(`nightly.${night}`);
      if (rows.length > 1) unresolvedFields.push(`nightly.${night}.ambiguous`);
    }

    const uniqueUnresolved = [...new Set(unresolvedFields)];
    const draftReady = uniqueUnresolved.length === 0;
    const status: ToolResult<StayOptionReadData>['status'] = draftReady
      ? 'ok'
      : 'manual_required';

    const data = stayOptionReadDataSchema.parse({
      nightlyObservations: inWindowRows,
      bookable: false as const,
      stayTotal: null,
      occupancyPriced: false,
      requestedRooms: input.rooms,
    });

    return this.#quoteResult({
      status,
      data,
      unresolvedFields: uniqueUnresolved,
      observedAt,
      claimKeys: inWindowRows.flatMap((_, index) => [
        `nightlyObservations.${index}.date`,
        `nightlyObservations.${index}.roomType`,
        `nightlyObservations.${index}.availableCount`,
        `nightlyObservations.${index}.ratePlan`,
        `nightlyObservations.${index}.displayedAmount`,
        `nightlyObservations.${index}.currency`,
        `nightlyObservations.${index}.rateBasis`,
        `nightlyObservations.${index}.restrictions`,
      ]),
      sourceSeed: `quote-v2:${input.arrivalDate}:${input.departureDate}:${inWindowRows.length}`,
      draftReady,
    });
  }

  #searchFields(candidate: LookupCandidate): Record<string, string> {
    const base = {
      action: 'search',
      tenant: this.#manifest.binding.tenantId,
      property: this.#manifest.binding.propertyKey,
    };
    if (candidate.kind === 'confirmation') {
      return {
        ...base,
        confirmationNumber: candidate.value,
        surname: '',
      };
    }
    if (candidate.kind === 'external_reference') {
      return {
        ...base,
        externalReference: candidate.value,
        confirmationNumber: '',
        surname: '',
      };
    }
    return {
      ...base,
      surname: candidate.surname,
      arrivalDate: candidate.arrivalDate,
      departureDate: candidate.departureDate,
      confirmationNumber: '',
    };
  }

  #parseReservationRows(html: string): {
    rows: ReservationObservation[];
    totalFound: number;
  } {
    const selectors = this.#manifest.selectors.reservation;
    const $ = cheerio.load(html);
    if ($(selectors.noResults).length > 0) {
      return { rows: [], totalFound: 0 };
    }
    const elements = $(selectors.resultRow).toArray();
    const totalFound = elements.length;
    const rows: ReservationObservation[] = [];
    // Parse every list row before correlation; cap applies to correlated set.
    for (const el of elements) {
      const node = $(el);
      rows.push({
        confirmationNumber: attrOrNull(node, selectors.confirmationAttr),
        externalReference: attrOrNull(node, selectors.externalRefAttr),
        guestName: attrOrNull(node, selectors.guestNameAttr),
        arrivalDate: parseIsoDateOrNull(
          attrOrNull(node, selectors.arrivalAttr),
        ),
        departureDate: parseIsoDateOrNull(
          attrOrNull(node, selectors.departureAttr),
        ),
        reservationStatus: attrOrNull(node, selectors.statusAttr),
        roomType: attrOrNull(node, selectors.roomTypeAttr),
        ratePlan: attrOrNull(node, selectors.ratePlanAttr),
      });
    }
    return { rows, totalFound };
  }

  #parseQuoteNights(
    html: string,
    observedAt: Date,
    input: QuoteInput,
  ): {
    rows: QuoteNightObservation[];
    unresolvedFields: string[];
    envelopeRecognized: boolean;
  } {
    const selectors = this.#manifest.selectors.quote;
    const $ = cheerio.load(html);
    const envelopeRecognized =
      $(selectors.resultsTable).length > 0 ||
      $(selectors.noResults).length > 0 ||
      $(selectors.resultRow).length > 0;
    const rows: QuoteNightObservation[] = [];
    const unresolvedFields: string[] = [];
    for (const [index, el] of $(selectors.resultRow).toArray().entries()) {
      const node = $(el);
      const dateRaw = attrOrNull(node, selectors.dateAttr);
      const roomType = attrOrNull(node, selectors.roomTypeAttr);
      const countRaw = attrOrNull(node, selectors.availableCountAttr);
      const ratePlan = attrOrNull(node, selectors.ratePlanAttr);
      const amount = attrOrNull(node, selectors.displayedAmountAttr);
      const currency = attrOrNull(node, selectors.currencyAttr);
      const rateBasis = attrOrNull(node, selectors.rateBasisAttr);
      const restrictionsRaw = attrOrNull(node, selectors.restrictionsAttr);
      const date = parseIsoDateOrNull(dateRaw);
      const count =
        countRaw !== null && /^\d+$/.test(countRaw)
          ? Number.parseInt(countRaw, 10)
          : null;
      const restrictions = restrictionsRaw
        ? restrictionsRaw.split('|').map((value) => value.trim()).filter(Boolean)
        : [];
      const prefix = `nightly.row.${index}`;
      if (!date) unresolvedFields.push(`${prefix}.date`);
      if (!roomType) unresolvedFields.push(`${prefix}.roomType`);
      if (count === null) unresolvedFields.push(`${prefix}.availableCount`);
      if (!ratePlan) unresolvedFields.push(`${prefix}.ratePlan`);
      if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount)) {
        unresolvedFields.push(`${prefix}.displayedAmount`);
      }
      if (!currency || !/^[A-Z]{3}$/.test(currency)) {
        unresolvedFields.push(`${prefix}.currency`);
      }
      if (rateBasis !== 'nightly') {
        unresolvedFields.push(`nightly.${date ?? `row.${index}`}.rateBasis`);
      }
      if (restrictions.length === 0) {
        unresolvedFields.push(`${prefix}.restrictions`);
      }
      if (
        input.roomType &&
        roomType &&
        roomType.toLowerCase() !== input.roomType.toLowerCase()
      ) {
        unresolvedFields.push(`${prefix}.roomType`);
      }
      if (
        input.ratePlan &&
        ratePlan &&
        ratePlan.toLowerCase() !== input.ratePlan.toLowerCase()
      ) {
        unresolvedFields.push(`${prefix}.ratePlan`);
      }
      if (currency && currency !== input.currency) {
        unresolvedFields.push(`${prefix}.currency`);
      }
      if (
        date &&
        roomType &&
        count !== null &&
        ratePlan &&
        amount &&
        /^\d+(?:\.\d{1,2})?$/.test(amount) &&
        currency &&
        /^[A-Z]{3}$/.test(currency) &&
        rateBasis === 'nightly' &&
        restrictions.length > 0
      ) {
        rows.push({
          date,
          roomType,
          availableCount: count,
          ratePlan,
          displayedAmount: amount,
          currency,
          rateBasis,
          restrictions,
          observedAt: observedAt.toISOString(),
        });
      }
    }
    return {
      rows: rows.slice(0, 120),
      unresolvedFields,
      envelopeRecognized,
    };
  }

  async #goto(pathWithOptionalQuery: string): Promise<void> {
    const url = new URL(pathWithOptionalQuery, this.#origin).toString();
    this.#onNavigate?.(new URL(url).pathname);
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  #reservationResult(args: {
    status: ToolResult<ReservationReadData>['status'];
    data: ReservationReadData;
    unresolvedFields: string[];
    observedAt: Date;
    claimKeys: string[];
    sourceSeed: string;
    draftReady?: boolean;
  }): ToolResult<ReservationReadData> {
    const draftReady =
      args.draftReady ??
      (args.status === 'ok' && args.unresolvedFields.length === 0);
    return {
      status: args.status,
      draftReady,
      data: args.data,
      unresolvedFields: args.unresolvedFields,
      evidence: {
        kind: 'hms',
        id: randomUUID(),
        toolId: HMS_FIND_RESERVATION_TOOL_ID,
        toolVersion: HMS_FIND_RESERVATION_TOOL_VERSION,
        propertyCode: this.#manifest.binding.propertyKey,
        observedAt: args.observedAt.toISOString(),
        expiresAt: new Date(
          args.observedAt.getTime() + RESERVATION_EVIDENCE_TTL_MS,
        ).toISOString(),
        claimKeys: args.claimKeys,
        sourceHash: sha256Hex(args.sourceSeed),
      },
    };
  }

  #quoteResult(args: {
    status: ToolResult<StayOptionReadData>['status'];
    data: StayOptionReadData;
    unresolvedFields: string[];
    observedAt: Date;
    claimKeys: string[];
    sourceSeed: string;
    draftReady: boolean;
  }): ToolResult<StayOptionReadData> {
    // Invariants always hold even when draftReady true.
    if (args.data.bookable !== false) {
      throw new Error('stay option must set bookable:false');
    }
    if (args.data.stayTotal !== null) {
      throw new Error('stay option must set stayTotal:null');
    }
    if (args.data.occupancyPriced !== false) {
      throw new Error('stay option must set occupancyPriced:false');
    }
    return {
      status: args.status,
      draftReady: args.draftReady,
      data: args.data,
      unresolvedFields: args.unresolvedFields,
      evidence: {
        kind: 'hms',
        id: randomUUID(),
        toolId: HMS_QUOTE_STAY_TOOL_ID,
        toolVersion: HMS_QUOTE_STAY_TOOL_VERSION,
        propertyCode: this.#manifest.binding.propertyKey,
        observedAt: args.observedAt.toISOString(),
        expiresAt: new Date(
          args.observedAt.getTime() + QUOTE_EVIDENCE_TTL_MS,
        ).toISOString(),
        claimKeys: args.claimKeys,
        sourceHash: sha256Hex(args.sourceSeed),
      },
    };
  }
}
