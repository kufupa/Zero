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
  type InventoryObservation,
  type RateObservation,
  type ReservationObservation,
  type ReservationReadData,
  type StayOptionReadData,
} from './contracts.js';
import type { HmsPage, HmsReadSession } from './runtime.js';

export const HMS_FIND_RESERVATION_TOOL_ID = 'hms_find_reservation';
export const HMS_QUOTE_STAY_TOOL_ID = 'hms_quote_stay';
export const HMS_FIND_RESERVATION_TOOL_VERSION = '1.1.0';
export const HMS_QUOTE_STAY_TOOL_VERSION = '1';

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
    inventoryObservations: [],
    rateObservations: [],
    bookable: false as const,
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
        status: 'not_found',
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
    const capped = parsed.totalFound > RESERVATION_MATCH_CAP;
    const matches = parsed.rows.slice(0, RESERVATION_MATCH_CAP);

    if (matches.length === 0) {
      return this.#reservationResult({
        status: 'not_found',
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
          matchCount: capped ? parsed.totalFound : matches.length,
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
    const unresolvedFields: string[] = [];
    if (!single.confirmationNumber && !single.externalReference) {
      unresolvedFields.push('confirmationNumber');
    }
    if (!single.arrivalDate) unresolvedFields.push('arrivalDate');
    if (!single.departureDate) unresolvedFields.push('departureDate');
    if (!single.reservationStatus) unresolvedFields.push('reservationStatus');
    if (
      single.arrivalDate === null &&
      single.departureDate === null &&
      (single.confirmationNumber || single.externalReference)
    ) {
      // Malformed date attrs present as empty
      if (!unresolvedFields.includes('arrivalDate')) {
        unresolvedFields.push('arrivalDate');
      }
    }

    // Detect malformed non-ISO dates left as null while attr existed
    const $ = cheerio.load(html);
    const row = $(selectors.resultRow).first();
    const rawArrival = row.attr(selectors.arrivalAttr);
    const rawDeparture = row.attr(selectors.departureAttr);
    if (rawArrival && !single.arrivalDate) unresolvedFields.push('arrivalDate');
    if (rawDeparture && !single.departureDate) {
      unresolvedFields.push('departureDate');
    }

    const statusLower = (single.reservationStatus ?? '').toLowerCase();
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
    } else if (single.reservationStatus && !active) {
      unresolvedFields.push('reservationStatus.active');
      status = 'partial';
    }

    const draftReady =
      status === 'ok' &&
      unresolvedFields.length === 0 &&
      !canceled &&
      active;

    return this.#reservationResult({
      status,
      data: reservationReadDataSchema.parse({
        matches: [single],
        matchCount: 1,
        capped: false,
      }),
      unresolvedFields: [...new Set(unresolvedFields)],
      observedAt,
      claimKeys: [
        'matches.0.confirmationNumber',
        'matches.0.reservationStatus',
        'matches.0.arrivalDate',
        'matches.0.departureDate',
      ],
      sourceSeed: `one:${single.confirmationNumber ?? single.externalReference}`,
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

    if (nights.length === 0 || input.rooms < 1) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(Math.max(1, input.rooms || 1)),
        unresolvedFields: ['stay_dates'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'bad-dates',
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

    // Room Availability — inventory only (never CRS).
    const inventoryUrl = new URL(selectors.inventoryPagePath, this.#origin);
    inventoryUrl.searchParams.set('view', 'inventory');
    inventoryUrl.searchParams.set('startDate', input.arrivalDate);
    await this.#goto(inventoryUrl.pathname + inventoryUrl.search);
    assertNotAborted(signal);

    if (this.#terminal() || this.#violation()) {
      return this.#quoteResult({
        status: 'manual_required',
        data: emptyStayData(input.rooms),
        unresolvedFields: ['request_policy'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'policy-inventory',
        draftReady: false,
      });
    }

    const inventoryHtml = await this.#page.content();
    const inventoryObservations = this.#parseInventory(
      inventoryHtml,
      input.roomType,
    );

    // Display Rates — separate screen; never merge into a guaranteed offer.
    await this.#goto(selectors.ratesPagePath);
    assertNotAborted(signal);

    if (this.#terminal() || this.#violation()) {
      return this.#quoteResult({
        status: 'manual_required',
        data: stayOptionReadDataSchema.parse({
          inventoryObservations,
          rateObservations: [],
          bookable: false,
          requestedRooms: input.rooms,
        }),
        unresolvedFields: ['request_policy', 'displayed_rate'],
        observedAt,
        claimKeys: [],
        sourceSeed: 'policy-rates',
        draftReady: false,
      });
    }

    const ratesHtml = await this.#page.content();
    // Mismatched screens: rates page must not look like inventory-only, and vice versa
    const ratesHasInventoryOnly =
      cheerio.load(ratesHtml)('[data-testid="inventory"]').length > 0 &&
      cheerio.load(ratesHtml)('[data-testid="rates"]').length === 0;
    const inventoryHasRatesOnly =
      cheerio.load(inventoryHtml)('[data-testid="rates"]').length > 0 &&
      cheerio.load(inventoryHtml)('[data-testid="inventory"]').length === 0;

    const rateObservations = ratesHasInventoryOnly
      ? []
      : this.#parseRates(ratesHtml, input);

    const unresolvedFields: string[] = [];

    if (inventoryHasRatesOnly || ratesHasInventoryOnly) {
      unresolvedFields.push('screen_mismatch');
    }

    const inventoryByNight = new Map(
      inventoryObservations.map((row) => [row.date, row]),
    );
    let inventoryCoversEveryNight = true;
    let inventorySupportsRooms = true;
    for (const night of nights) {
      const row = inventoryByNight.get(night);
      if (!row) {
        inventoryCoversEveryNight = false;
        unresolvedFields.push(`inventory.${night}`);
        continue;
      }
      if (row.availableCount === null) {
        inventorySupportsRooms = false;
        unresolvedFields.push(`inventory.${night}.availableCount`);
      } else if (row.availableCount < input.rooms) {
        inventorySupportsRooms = false;
        unresolvedFields.push(`inventory.${night}.rooms`);
      }
      if (row.inventoryStatus === 'unknown') {
        unresolvedFields.push(`inventory.${night}.status`);
      }
      if (
        input.roomType &&
        row.roomType.toLowerCase() !== input.roomType.toLowerCase()
      ) {
        unresolvedFields.push(`inventory.${night}.roomType`);
        inventoryCoversEveryNight = false;
      }
    }

    // Gap detection across observed inventory dates for requested room type
    if (inventoryObservations.length > 0) {
      const sorted = [...inventoryObservations]
        .map((r) => r.date)
        .sort();
      for (let i = 1; i < sorted.length; i++) {
        const prev = Date.parse(`${sorted[i - 1]}T00:00:00.000Z`);
        const next = Date.parse(`${sorted[i]}T00:00:00.000Z`);
        if (next - prev > 86_400_000) {
          unresolvedFields.push('inventory.gap');
          inventoryCoversEveryNight = false;
        }
      }
    }

    let rateMatchesRequest = rateObservations.length > 0;
    if (rateObservations.length === 0) {
      unresolvedFields.push('displayed_rate');
      rateMatchesRequest = false;
    }

    for (const [index, rate] of rateObservations.entries()) {
      if (rate.amount === null || rate.amount === '' || Number.isNaN(Number(rate.amount))) {
        unresolvedFields.push(`rateObservations.${index}.amount`);
        rateMatchesRequest = false;
      }
      if (rate.amountBasis === 'unknown') {
        unresolvedFields.push(`rateObservations.${index}.amountBasis`);
      }
      if (rate.taxIncluded === null) {
        unresolvedFields.push(`rateObservations.${index}.tax_inclusion`);
      }
      if (rate.inclusions.length === 0) {
        unresolvedFields.push(`rateObservations.${index}.rate_inclusions`);
      }
      if (rate.restrictions.length === 0) {
        // Empty restrictions can mean "none listed" — still unresolved until explicit.
        unresolvedFields.push(`rateObservations.${index}.rate_restrictions`);
      }
      if (input.roomType && rate.roomType.toLowerCase() !== input.roomType.toLowerCase()) {
        unresolvedFields.push(`rateObservations.${index}.roomType`);
        rateMatchesRequest = false;
      }
      if (input.ratePlan && (rate.ratePlan ?? '').toLowerCase() !== input.ratePlan.toLowerCase()) {
        unresolvedFields.push(`rateObservations.${index}.ratePlan`);
        rateMatchesRequest = false;
      }
      if (
        rate.currency === null ||
        rate.currency.toUpperCase() !== input.currency.toUpperCase()
      ) {
        unresolvedFields.push(`rateObservations.${index}.currency`);
        rateMatchesRequest = false;
      }
      if (input.boardBasis) {
        if (
          !rate.boardBasis ||
          rate.boardBasis.toLowerCase() !== input.boardBasis.toLowerCase()
        ) {
          unresolvedFields.push(`rateObservations.${index}.board_basis`);
        }
      }
      if (rate.organizationEligibility === 'unresolved') {
        unresolvedFields.push(
          `rateObservations.${index}.organization_eligibility`,
        );
      }
    }

    const uniqueUnresolved = [...new Set(unresolvedFields)];
    const draftReady =
      inventoryCoversEveryNight &&
      inventorySupportsRooms &&
      rateMatchesRequest &&
      uniqueUnresolved.length === 0;

    let status: ToolResult<StayOptionReadData>['status'] = 'ok';
    if (
      inventoryObservations.length === 0 &&
      rateObservations.length === 0
    ) {
      status = 'not_found';
    } else if (!draftReady) {
      status = 'partial';
    }

    const data = stayOptionReadDataSchema.parse({
      inventoryObservations,
      rateObservations,
      bookable: false as const,
      requestedRooms: input.rooms,
    });

    return this.#quoteResult({
      status,
      data,
      unresolvedFields: uniqueUnresolved,
      observedAt,
      claimKeys: [
        ...inventoryObservations.flatMap((_, i) => [
          `inventoryObservations.${i}.date`,
          `inventoryObservations.${i}.availableCount`,
        ]),
        ...rateObservations.flatMap((_, i) => [
          `rateObservations.${i}.amount`,
          `rateObservations.${i}.currency`,
          `rateObservations.${i}.amountBasis`,
        ]),
      ],
      sourceSeed: `quote:${input.arrivalDate}:${input.departureDate}:${inventoryObservations.length}:${rateObservations.length}`,
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
    for (const el of elements.slice(0, RESERVATION_MATCH_CAP)) {
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

  #parseInventory(
    html: string,
    roomTypeFilter?: string,
  ): InventoryObservation[] {
    const selectors = this.#manifest.selectors.quote;
    const $ = cheerio.load(html);
    const out: InventoryObservation[] = [];
    for (const el of $(selectors.inventoryRow).toArray()) {
      const node = $(el);
      const roomType = attrOrNull(node, selectors.inventoryRoomTypeAttr) ?? '';
      if (
        roomTypeFilter &&
        roomType.toLowerCase() !== roomTypeFilter.toLowerCase()
      ) {
        continue;
      }
      const date =
        parseIsoDateOrNull(attrOrNull(node, selectors.inventoryDateAttr)) ??
        '';
      if (!date) continue;
      const rawCount = attrOrNull(node, selectors.inventoryAvailableAttr);
      const parsedCount =
        rawCount == null ? NaN : Number.parseInt(rawCount, 10);
      const availableCount = Number.isFinite(parsedCount) ? parsedCount : null;
      const inventoryStatus =
        availableCount === null
          ? 'unknown'
          : availableCount > 0
            ? 'available'
            : 'unavailable';
      out.push({
        date,
        roomType: roomType || 'UNKNOWN',
        inventoryStatus,
        availableCount,
      });
    }
    return out.slice(0, 100);
  }

  #parseRates(html: string, input: QuoteInput): RateObservation[] {
    const selectors = this.#manifest.selectors.quote;
    const $ = cheerio.load(html);
    const out: RateObservation[] = [];
    for (const el of $(selectors.rateRow).toArray()) {
      const node = $(el);
      const roomType =
        attrOrNull(node, selectors.rateRoomTypeAttr) ??
        input.roomType ??
        'UNKNOWN';
      const basisRaw = attrOrNull(node, selectors.amountBasisAttr);
      const amountBasis =
        basisRaw === 'nightly' ||
        basisRaw === 'weekly' ||
        basisRaw === 'monthly' ||
        basisRaw === 'stay_total'
          ? basisRaw
          : 'unknown';

      const taxRaw = attrOrNull(node, selectors.taxIncludedAttr);
      const taxIncluded =
        taxRaw === null
          ? null
          : taxRaw === 'true' || taxRaw === '1'
            ? true
            : taxRaw === 'false' || taxRaw === '0'
              ? false
              : null;

      const inclusionsRaw = attrOrNull(node, selectors.inclusionsAttr);
      const restrictionsRaw = attrOrNull(node, selectors.restrictionsAttr);
      const orgRaw = attrOrNull(node, selectors.orgEligibilityAttr);
      const organizationEligibility =
        orgRaw === 'confirmed' ||
        orgRaw === 'unresolved' ||
        orgRaw === 'not_requested'
          ? orgRaw
          : 'not_requested';

      out.push({
        roomType,
        ratePlan: attrOrNull(node, selectors.ratePlanAttr),
        amount: attrOrNull(node, selectors.amountAttr),
        amountBasis,
        currency: attrOrNull(node, selectors.currencyAttr),
        taxIncluded,
        inclusions: inclusionsRaw
          ? inclusionsRaw.split('|').map((s) => s.trim()).filter(Boolean)
          : [],
        restrictions: restrictionsRaw
          ? restrictionsRaw.split('|').map((s) => s.trim()).filter(Boolean)
          : [],
        boardBasis: attrOrNull(node, selectors.boardBasisAttr),
        organizationEligibility,
      });
    }
    return out.slice(0, 100);
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
    // bookable always false even when draftReady true
    if (args.data.bookable !== false) {
      throw new Error('stay option must set bookable:false');
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
