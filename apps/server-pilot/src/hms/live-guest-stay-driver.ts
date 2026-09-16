/**
 * Canonical Guest Stay live driver — login, binding, exact search, not-found canary.
 * Probe and worker share this surface; request policy uses exact candidate binding.
 */
import {
  liveGuestStayRowFingerprintV2Schema,
  liveGuestStayRowFingerprintV1Schema,
  type LiveGuestStayRowFingerprintV2,
  type LiveGuestStayRowFingerprintV1,
  type ReservationObservation,
} from './contracts.js';
import {
  buildExactOsressSearchManifest,
  liveNotFoundCanaryCandidate,
  LIVE_NOTFOUND_CANARY,
  type ExactReservationCandidate,
  type ReservationSearchCandidate,
} from './live-read-manifest.js';
import {
  createFindReservationFacade,
  type FindReservationFacade,
} from './find-reservation-facade.js';
import { createReservationDetailFacade } from './reservation-detail-facade.js';
import { HmsRuntimeError, type HmsReadSession, type HmsRuntime } from './runtime.js';
import type { PropertyReadLock } from './property-read-lock.js';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

export type { ExactReservationCandidate, ReservationSearchCandidate };

/** Frozen live Guest Stay list-row selectors (structure; not guest values). */
export const LIVE_GUEST_STAY_ROW_SELECTORS = {
  resultsTable: '[data-testid="results"]',
  resultRow: '[data-testid="result-row"]',
  noResults: '[data-testid="no-results"]',
  confirmationAttr: 'data-confirmation',
  externalRefAttr: 'data-external',
  guestNameAttr: 'data-guest-name',
  arrivalAttr: 'data-arrival',
  departureAttr: 'data-departure',
  statusAttr: 'data-status',
  roomTypeAttr: 'data-room-type',
  ratePlanAttr: 'data-rate-plan',
  staleRowAttr: 'data-stale-row',
  correlationFailed: '[data-testid="search-correlation-failed"]',
} as const;

export const LIVE_GUEST_STAY_COLUMN_KEYS = [
  'confirmationNumber',
  'externalReference',
  'guestName',
  'arrivalDate',
  'departureDate',
  'reservationStatus',
  'roomType',
  'ratePlan',
] as const;

/** Exact live OSRESS GRIDRESULT keys reviewed for reservation list evidence. */
export const LIVE_GUEST_STAY_ROW_ALIAS_KEYS = [
  'arrivaldate',
  'confirmationnumber',
  'departuredate',
  'externalconfirmation',
  'firstname',
  'lastname',
  'primaryguest',
  'rateplan',
  'roomtype',
  'status',
] as const;

export type GuestStaySearchResult =
  | { outcome: 'not_found'; observations: []; capped: false }
  | { outcome: 'matched'; observations: [ReservationObservation]; capped: false }
  | {
      outcome: 'ambiguous';
      observations: ReservationObservation[];
      capped: boolean;
    };

export type AuditedSearchMapper<T> = (result: GuestStaySearchResult) => T | Promise<T>;

export interface LiveGuestStayDriver {
  loginAndVerifyBinding(signal: AbortSignal): Promise<void>;
  runNotFoundCanary(signal: AbortSignal): Promise<void>;
  searchExact(
    candidate: ReservationSearchCandidate,
    signal: AbortSignal,
  ): Promise<GuestStaySearchResult>;
  searchExactAndMap<T>(
    candidate: ReservationSearchCandidate,
    signal: AbortSignal,
    mapResult: AuditedSearchMapper<T>,
  ): Promise<T>;
  /**
   * Wave A1: exact search then inert open of matched grid row; return search +
   * detail form-key dump. Never save.
   */
  searchExactThenDetailDump(
    candidate: ReservationSearchCandidate,
    signal: AbortSignal,
  ): Promise<{
    search: GuestStaySearchResult;
    dump: import('./reservation-detail-projection.js').ReservationDetailDumpV1;
  }>;
  /** Digests-only receipt from most recent audited session close. */
  lastAuditReceipt(): import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1 | null;
}

export type LiveGuestStayDriverOptions = {
  runtime: HmsRuntime;
  transportId: string;
  /** Optional hook after session open (tests). */
  onSession?: (session: HmsReadSession) => void;
  /** When set, every session is audited (operationId from run / synthetic). */
  auditSpecFor?: (input: {
    candidate: ReservationSearchCandidate | null;
    inputClass: 'authorized_exact' | 'synthetic_not_found';
  }) => import('./browser-artifacts.js').HmsBrowserAuditSpec | undefined;
  /**
   * Per-tool plan-scoped lease. Production live path MUST supply this —
   * openReadSession never falls back to process-wide Guest Stay union alone.
   */
  sessionAuthorizationFor?: (input: {
    candidate: ReservationSearchCandidate | null;
    inputClass: 'authorized_exact' | 'synthetic_not_found';
  }) => import('./release-kernel.js').HmsSessionAuthorization;
  /** Dedicated tenant/property advisory lock held before session admission. */
  propertyReadLock?: PropertyReadLock;
};

const NO_RESULTS_RE =
  /no reservations found|no records|no results|no data to display|0 records|0 items|not found|no matching|"RECORDS"\s*:\s*"?0"?/i;

const RESERVATION_MATCH_CAP = 20;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const HMS_MON: Record<string, string> = {
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

function parseIsoDateOrNull(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const mon = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
  if (!mon) return null;
  const mm = HMS_MON[mon[2]!.toUpperCase()];
  if (!mm) return null;
  return `${mon[3]}-${mm}-${mon[1]}`;
}

function attrOrNull(el: { attr(name: string): string | undefined }, attr: string): string | null {
  const raw = el.attr(attr);
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function strOrNull(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Infor OSRESS.search returns `{ pageData: { ...json... } }` (unquoted key)
 * or standard JSON `{ "pageData": { ... } }`. Extract / parse the pageData
 * object; null when not a grid envelope.
 */
export function extractOsressPageData(text: string): Record<string, unknown> | null {
  const markers = ['pageData:', '"pageData":', "'pageData':"] as const;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx < 0) continue;
    let i = text.indexOf('{', idx + marker.length - 1);
    if (i < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let quote = '';
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.includes('pageData')) {
    try {
      const parsed = JSON.parse(trimmed) as { pageData?: unknown };
      if (parsed.pageData && typeof parsed.pageData === 'object') {
        return parsed.pageData as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function extractOsressDetailOpenHints(html: string): {
  confirmationNumber: string | null;
  externalReference: string | null;
  reservationStayId: string | null;
} {
  const empty = {
    confirmationNumber: null as string | null,
    externalReference: null as string | null,
    reservationStayId: null as string | null,
  };
  const pageData = extractOsressPageData(html);
  if (!pageData) return empty;
  const gridWrap = pageData.grid;
  if (gridWrap == null || typeof gridWrap !== 'object') return empty;
  const gridResult = (gridWrap as Record<string, unknown>).GRIDRESULT;
  if (gridResult == null || typeof gridResult !== 'object') return empty;
  const inner = (gridResult as Record<string, unknown>).GRID;
  if (inner == null || typeof inner !== 'object') return empty;
  const data = (inner as Record<string, unknown>).DATA;
  if (!Array.isArray(data) || data.length < 1) return empty;
  const row = data[0];
  if (!row || typeof row !== 'object') return empty;
  const rec = row as Record<string, unknown>;
  return {
    confirmationNumber: strOrNull(rec.confirmationnumber),
    externalReference: strOrNull(rec.externalconfirmation),
    reservationStayId: strOrNull(rec.id) ?? strOrNull(rec.reservationstayid),
  };
}

function isUsableGuestDisplayName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Infor dataspy 1941 often fills primaryguest with numeric sentinels like "-1".
  if (/^-?\d+$/.test(trimmed)) return false;
  return true;
}

function guestNameFromGridRow(row: Record<string, unknown>): string | null {
  const primary = strOrNull(row.primaryguest);
  if (primary && isUsableGuestDisplayName(primary)) return primary;
  const last = strOrNull(row.lastname);
  const first = strOrNull(row.firstname);
  if (last && first) return `${last}, ${first}`;
  return last ?? first;
}

/**
 * Map live GRIDRESULT.GRID.DATA objects → observations.
 * Returns null when envelope is not a GRIDRESULT list response.
 */
export function parseLiveOsressGridRows(
  pageData: Record<string, unknown>,
): ReservationObservation[] | null {
  const schemaDrift = (): never => {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'OSRESS grid schema drift');
  };
  if ('success' in pageData && pageData.success !== true) schemaDrift();
  if (pageData.fromCome !== true) schemaDrift();
  const gridWrap = pageData.grid;
  if (gridWrap === null) {
    if (pageData.messages === null) return [];
    schemaDrift();
  }
  if (gridWrap == null || typeof gridWrap !== 'object') return null;
  const gridResult = (gridWrap as Record<string, unknown>).GRIDRESULT;
  if (gridResult == null || typeof gridResult !== 'object') return null;
  const result = gridResult as Record<string, unknown>;
  if (result.type !== 'LIST.DATA_ONLY.STORED') schemaDrift();
  const dataspy = result.DATASPY;
  if (
    dataspy == null ||
    typeof dataspy !== 'object' ||
    (dataspy as Record<string, unknown>).id !== '1941' ||
    (dataspy as Record<string, unknown>).label !== 'All'
  ) {
    schemaDrift();
  }
  const inner = result.GRID;
  if (inner == null || typeof inner !== 'object') return null;
  const grid = inner as Record<string, unknown>;
  const metadata = grid.METADATA;
  if (
    metadata == null ||
    typeof metadata !== 'object' ||
    (metadata as Record<string, unknown>).GRIDNAME !== 'OSRESS'
  ) {
    schemaDrift();
  }
  const records = (metadata as Record<string, unknown>).RECORDS;
  const data = grid.DATA;
  if (!Array.isArray(data)) return null;
  if (typeof records !== 'string' || !/^\d+$/.test(records) || Number(records) !== data.length) {
    schemaDrift();
  }

  const rows: ReservationObservation[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') schemaDrift();
    const row = item as Record<string, unknown>;
    const confirmationNumber = strOrNull(row.confirmationnumber);
    const externalReference = strOrNull(row.externalconfirmation);
    if (!confirmationNumber && !externalReference) schemaDrift();
    rows.push({
      confirmationNumber,
      externalReference,
      guestName: guestNameFromGridRow(row),
      arrivalDate: parseIsoDateOrNull(strOrNull(row.arrivaldate)),
      departureDate: parseIsoDateOrNull(strOrNull(row.departuredate)),
      reservationStatus: strOrNull(row.status),
      roomType: strOrNull(row.roomtype),
      ratePlan: strOrNull(row.rateplan),
    });
  }
  return rows;
}

/** Exactly one correlated Guest Stay list row may become matched evidence. */
function correlateObservations(
  fresh: ReservationObservation[],
  candidate: ReservationSearchCandidate,
  emptySignal: boolean,
): GuestStaySearchResult {
  const correlated = fresh.filter((row) => rowMatchesCandidate(row, candidate));
  if (correlated.length === 0 && (emptySignal || fresh.length === 0)) {
    return { outcome: 'not_found', observations: [], capped: false };
  }
  if (correlated.length === 0) {
    return { outcome: 'not_found', observations: [], capped: false };
  }
  if (correlated.length === 1) {
    return {
      outcome: 'matched',
      observations: [correlated[0]!],
      capped: false,
    };
  }

  const capped = correlated.length > RESERVATION_MATCH_CAP;
  const minimized = correlated.map((row) => ({ ...row, guestName: null }));
  return {
    outcome: 'ambiguous',
    observations: capped ? minimized.slice(0, RESERVATION_MATCH_CAP) : minimized,
    capped,
  };
}

/** Structural fingerprint — selector/column keys + structure hash; never values. */
export function buildLiveGuestStayRowFingerprintV1(): LiveGuestStayRowFingerprintV1 {
  const selectorKeys = Object.keys(LIVE_GUEST_STAY_ROW_SELECTORS).sort();
  const columnKeys = [...LIVE_GUEST_STAY_COLUMN_KEYS];
  const structurePayload = JSON.stringify({
    schemaVersion: 1,
    selectors: Object.fromEntries(
      selectorKeys.map((k) => [
        k,
        LIVE_GUEST_STAY_ROW_SELECTORS[k as keyof typeof LIVE_GUEST_STAY_ROW_SELECTORS],
      ]),
    ),
    columnKeys,
    valuesCaptured: false,
  });
  return liveGuestStayRowFingerprintV1Schema.parse({
    schemaVersion: 1,
    selectorKeys,
    columnKeys,
    manifestSha256: sha256Hex(structurePayload),
    valuesCaptured: false,
  });
}

/** V2 structural fingerprint: selectors, output columns, and reviewed row keys. */
export function buildLiveGuestStayRowFingerprintV2(): LiveGuestStayRowFingerprintV2 {
  const selectorKeys = Object.keys(LIVE_GUEST_STAY_ROW_SELECTORS).sort();
  const columnKeys = [...LIVE_GUEST_STAY_COLUMN_KEYS];
  const rowAliasKeys = [...LIVE_GUEST_STAY_ROW_ALIAS_KEYS];
  const structurePayload = JSON.stringify({
    schemaVersion: 2,
    selectors: Object.fromEntries(
      selectorKeys.map((k) => [
        k,
        LIVE_GUEST_STAY_ROW_SELECTORS[k as keyof typeof LIVE_GUEST_STAY_ROW_SELECTORS],
      ]),
    ),
    columnKeys,
    rowAliasKeys,
    valuesCaptured: false,
  });
  return liveGuestStayRowFingerprintV2Schema.parse({
    schemaVersion: 2,
    selectorKeys,
    columnKeys,
    rowAliasKeys,
    manifestSha256: sha256Hex(structurePayload),
    valuesCaptured: false,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('guest stay parse aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function surnameMatchesGuestName(guestName: string | null, surname: string): boolean {
  const target = surname.trim().toUpperCase();
  if (!target || !guestName) return false;
  const name = guestName.trim().toUpperCase();
  if (name === target) return true;
  if (name.startsWith(`${target},`)) return true;
  if (name.startsWith(`${target} `)) return true;
  return false;
}

function rowMatchesCandidate(
  row: ReservationObservation,
  candidate: ReservationSearchCandidate,
): boolean {
  if (candidate.kind === 'surname_dates') {
    return (
      surnameMatchesGuestName(row.guestName, candidate.surname) &&
      row.arrivalDate === candidate.arrivalDate &&
      row.departureDate === candidate.departureDate
    );
  }
  const target = candidate.value.toUpperCase();
  if (candidate.kind === 'confirmation') {
    return (row.confirmationNumber ?? '').toUpperCase() === target;
  }
  return (row.externalReference ?? '').toUpperCase() === target;
}

function parseAllFreshRows(html: string): ReservationObservation[] {
  const sel = LIVE_GUEST_STAY_ROW_SELECTORS;
  const $ = cheerio.load(html);
  const rows: ReservationObservation[] = [];
  for (const el of $(sel.resultRow).toArray()) {
    const node = $(el);
    if (node.attr(sel.staleRowAttr) === 'prior') continue;
    rows.push({
      confirmationNumber: attrOrNull(node, sel.confirmationAttr),
      externalReference: attrOrNull(node, sel.externalRefAttr),
      guestName: attrOrNull(node, sel.guestNameAttr),
      arrivalDate: parseIsoDateOrNull(attrOrNull(node, sel.arrivalAttr)),
      departureDate: parseIsoDateOrNull(attrOrNull(node, sel.departureAttr)),
      reservationStatus: attrOrNull(node, sel.statusAttr),
      roomType: attrOrNull(node, sel.roomTypeAttr),
      ratePlan: attrOrNull(node, sel.ratePlanAttr),
    });
  }
  return rows;
}

/**
 * Parse Guest Stay search response against structural fingerprint.
 * Prefer live OSRESS GRIDRESULT JSON; fall back to fixture HTML selectors.
 * Returns only rows correlated to the exact candidate. Never opens detail.
 */
export function parseAndCorrelateGuestStayHtml(
  html: string,
  candidate: ReservationSearchCandidate,
  signal?: AbortSignal,
  options: { requireLiveEnvelope?: boolean } = {},
): GuestStaySearchResult {
  throwIfAborted(signal);

  const pageData = extractOsressPageData(html);
  if (pageData) {
    const gridRows = parseLiveOsressGridRows(pageData);
    if (gridRows !== null) {
      return correlateObservations(
        gridRows,
        candidate,
        gridRows.length === 0 || NO_RESULTS_RE.test(html),
      );
    }
    if (options.requireLiveEnvelope) {
      throw new HmsRuntimeError(
        'SCHEMA_DRIFT',
        'live OSRESS grid structure unmapped',
      );
    }
  }
  if (options.requireLiveEnvelope) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'live OSRESS pageData marker missing');
  }

  const sel = LIVE_GUEST_STAY_ROW_SELECTORS;
  const $ = cheerio.load(html);
  if ($(sel.correlationFailed).length > 0) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'search correlation failed');
  }

  const fresh = parseAllFreshRows(html).filter(
    (row) => row.confirmationNumber || row.externalReference,
  );
  return correlateObservations(
    fresh,
    candidate,
    $(sel.noResults).length > 0 || NO_RESULTS_RE.test(html) || fresh.length === 0,
  );
}

export function createLiveGuestStayDriver(
  options: LiveGuestStayDriverOptions,
): LiveGuestStayDriver {
  const { runtime, transportId } = options;
  let lastAuditReceipt: import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1 | null = null;

  async function withSession<T>(
    signal: AbortSignal,
    candidate: ReservationSearchCandidate | null,
    fn: (facade: FindReservationFacade, session: HmsReadSession) => Promise<T>,
    receiptForResult?: (result: T) => {
      outcome: 'succeeded' | 'unverified_negative';
      terminalCode: 'OK' | 'UNVERIFIED_NEGATIVE';
    },
    lockHeld = false,
  ): Promise<T> {
    if (!lockHeld && options.propertyReadLock) {
      return options.propertyReadLock.withLock(
        () => withSession(signal, candidate, fn, receiptForResult, true),
        { signal },
      );
    }
    const canary = liveNotFoundCanaryCandidate();
    const inputClass =
      candidate &&
      candidate.kind !== 'surname_dates' &&
      candidate.kind === canary.kind &&
      candidate.value === canary.value
        ? 'synthetic_not_found'
        : 'authorized_exact';
    const auditSpec = options.auditSpecFor?.({ candidate, inputClass });
    const sessionAuthorization = options.sessionAuthorizationFor?.({
      candidate,
      inputClass,
    });
    const session = await runtime.openReadSession({
      transportId,
      signal,
      exactSearchCandidate: candidate ?? undefined,
      // Allow driver to open before/without fixture startup canary.
      allowUnstarted: true,
      auditSpec,
      sessionAuthorization,
    });
    options.onSession?.(session);
    let fnError: unknown;
    let result: T | undefined;
    try {
      result = await fn(createFindReservationFacade(session), session);
    } catch (err) {
      fnError = err;
    }
    const expectedReceipt =
      !fnError && receiptForResult
        ? receiptForResult(result as T)
        : { outcome: 'succeeded' as const, terminalCode: 'OK' as const };
    // A blocked request outranks any tool-level receipt, success included.
    const blocked = session.violation()?.action === 'block';
    let closeError: unknown;
    try {
      if (fnError || blocked) {
        await session.close({
          outcome: blocked ? 'policy_blocked' : 'failed',
          terminalCode: blocked ? 'POLICY_BLOCK' : 'TOOL_ERROR',
          complete: true,
        });
      } else if (receiptForResult) {
        await session.close({ ...expectedReceipt, complete: true });
      } else {
        await session.close();
      }
    } catch (err) {
      closeError = err;
    }
    lastAuditReceipt = session.lastReceipt();
    if (fnError && closeError) {
      throw new AggregateError([fnError, closeError], 'HMS session tool and close failed');
    }
    if (fnError) throw fnError;
    if (closeError) {
      const softTrace =
        process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1' &&
        closeError instanceof HmsRuntimeError &&
        closeError.code === 'AUDIT_CAPTURE' &&
        (/TRACE_FINALIZE_FAILED/i.test(closeError.message) ||
          /TRACE_SKIPPED_SOFT/i.test(closeError.message) ||
          /UNVERIFIED_NEGATIVE/i.test(closeError.message));
      if (!softTrace) throw closeError;
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
        process.stderr.write(
          `${JSON.stringify({
            type: 'HMS_PROOF_DIAGNOSTIC',
            stage: 'session_close',
            code: 'TRACE_FINALIZE_SOFT',
            message: 'tool ok; trace sanitize failed — video remains proof gate',
          })}\n`,
        );
      }
    }
    if (blocked) {
      throw new HmsRuntimeError('POLICY_BLOCK', 'request policy blocked during read session');
    }
    if (lastAuditReceipt) {
      const unsafe =
        lastAuditReceipt.operationOutcome === 'policy_blocked' ||
        lastAuditReceipt.terminalCode === 'POLICY_BLOCK' ||
        lastAuditReceipt.blockedRequests > 0 ||
        lastAuditReceipt.mutationRequests > 0 ||
        lastAuditReceipt.popupCount > 0 ||
        lastAuditReceipt.downloadCount > 0 ||
        lastAuditReceipt.webSocketCount > 0;
      if (unsafe) {
        throw new HmsRuntimeError('POLICY_BLOCK', 'unsafe browser event in audit receipt');
      }
      const softTraceReceipt =
        process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1' &&
        lastAuditReceipt.terminalCode === 'TRACE_FINALIZE_FAILED';
      if (
        !softTraceReceipt &&
        (lastAuditReceipt.operationOutcome !== expectedReceipt.outcome ||
          lastAuditReceipt.terminalCode !== expectedReceipt.terminalCode)
      ) {
        throw new HmsRuntimeError('AUDIT_CAPTURE', 'audit receipt terminal state invalid');
      }
    }
    return result as T;
  }

  return {
    async loginAndVerifyBinding(signal) {
      await withSession(signal, null, async (facade) => {
        await facade.verifyBinding();
      });
    },

    async runNotFoundCanary(signal) {
      const canary = liveNotFoundCanaryCandidate();
      const result = await withSession(
        signal,
        canary,
        async (facade) => {
          const html = await facade.searchExact(canary);
          if (
            /Unable to retrieve text|success"\s*:\s*false|loadLocalizedPage|allcookies/i.test(html)
          ) {
            throw new HmsRuntimeError('SCHEMA_DRIFT', 'Guest Stay search component not ready');
          }
          const search = parseAndCorrelateGuestStayHtml(html, canary, signal, {
            requireLiveEnvelope: facade.requireLiveEnvelope,
          });
          if (search.outcome !== 'not_found') {
            throw new HmsRuntimeError(
              'SCHEMA_DRIFT',
              'not-found canary expected empty Guest Stay result',
            );
          }
          if (/hasNewRecord|new record/i.test(html) && /data-has-new-record="true"/i.test(html)) {
            throw new HmsRuntimeError(
              'ROLE_SCOPE_INVALID',
              'New Record control present during canary',
            );
          }
          return html;
        },
        () => ({
          outcome: 'unverified_negative',
          terminalCode: 'UNVERIFIED_NEGATIVE',
        }),
      );
      void result;
      void LIVE_NOTFOUND_CANARY;
    },

    async searchExact(candidate, signal) {
      assertSearchCandidate(candidate);
      void buildExactOsressSearchManifest;
      return withSession(
        signal,
        candidate,
        async (facade) => {
          const html = await facade.searchExact(candidate);
          return parseAndCorrelateGuestStayHtml(html, candidate, signal, {
            requireLiveEnvelope: facade.requireLiveEnvelope,
          });
        },
        (search) =>
          search.outcome === 'not_found'
            ? {
                outcome: 'unverified_negative',
                terminalCode: 'UNVERIFIED_NEGATIVE',
              }
            : { outcome: 'succeeded', terminalCode: 'OK' },
      );
    },

    async searchExactAndMap(candidate, signal, mapResult) {
      assertSearchCandidate(candidate);
      const wrapped = await withSession(
        signal,
        candidate,
        async (facade) => {
          const html = await facade.searchExact(candidate);
          const search = await parseAndCorrelateGuestStayHtml(html, candidate, signal, {
            requireLiveEnvelope: facade.requireLiveEnvelope,
          });
          return { search, mapped: await mapResult(search) };
        },
        ({ search }) =>
          search.outcome === 'not_found'
            ? {
                outcome: 'unverified_negative',
                terminalCode: 'UNVERIFIED_NEGATIVE',
              }
            : { outcome: 'succeeded', terminalCode: 'OK' },
      );
      return wrapped.mapped;
    },

    async searchExactThenDetailDump(candidate, signal) {
      assertSearchCandidate(candidate);
      return withSession(
        signal,
        candidate,
        async (facade, session) => {
          const html = await facade.searchExact(candidate);
          const search = parseAndCorrelateGuestStayHtml(html, candidate, signal, {
            requireLiveEnvelope: facade.requireLiveEnvelope,
          });
          if (search.outcome !== 'matched' || search.observations.length !== 1) {
            throw new HmsRuntimeError(
              'SCHEMA_DRIFT',
              'detail dump requires a unique matched search row',
            );
          }
          // XHR pageData match does not always hydrate ExtJS grid. The
          // tool-specific facade owns the reviewed DOM refresh before the
          // detail facade attempts an inert row open.
          const rowCount = await facade.ensureSearchResultRows(candidate);
          const obs = search.observations[0]!;
          const hints = extractOsressDetailOpenHints(html);
          const matchToken =
            (obs.confirmationNumber ||
              obs.externalReference ||
              hints.confirmationNumber ||
              hints.externalReference ||
              '').trim();
          if (rowCount < 1 && !matchToken && !hints.reservationStayId) {
            throw new HmsRuntimeError(
              'SCHEMA_DRIFT',
              'detail dump: matched pageData but grid row not rendered',
            );
          }
          const detail = createReservationDetailFacade({ session });
          const dump = await detail.openMatchedRowAndDump({
            captureValues: true,
            matchToken: matchToken || undefined,
            reservationStayId: hints.reservationStayId,
          });
          return { search, dump };
        },
        () => ({ outcome: 'succeeded', terminalCode: 'OK' }),
      );
    },

    lastAuditReceipt() {
      return lastAuditReceipt;
    },
  };
}

function assertSearchCandidate(candidate: ReservationSearchCandidate): void {
  if (candidate.kind === 'surname_dates') {
    const surname = candidate.surname.trim();
    if (
      !surname ||
      surname.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.arrivalDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.departureDate)
    ) {
      throw new HmsRuntimeError('SCHEMA_DRIFT', 'surname_dates candidate invalid');
    }
    return;
  }
  if (!candidate.value || candidate.value.length > 64) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'candidate value invalid');
  }
}
