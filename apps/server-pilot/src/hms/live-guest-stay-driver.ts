/**
 * Canonical Guest Stay live driver — login, binding, exact search, not-found canary.
 * Probe and worker share this surface; request policy uses exact candidate binding.
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import {
  liveGuestStayRowFingerprintV1Schema,
  type LiveGuestStayRowFingerprintV1,
  type ReservationObservation,
} from './contracts.js';
import {
  buildExactOsressSearchBody,
  buildExactOsressSearchManifest,
  liveNotFoundCanaryCandidate,
  LIVE_GUEST_STAY_SEARCH_PATH,
  LIVE_NOTFOUND_CANARY,
  type ExactReservationCandidate,
} from './live-read-manifest.js';
import {
  HmsRuntimeError,
  type HmsPage,
  type HmsReadSession,
  type HmsRuntime,
} from './runtime.js';

export type { ExactReservationCandidate };

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

export type GuestStaySearchResult =
  | { outcome: 'not_found'; observations: []; capped: false }
  | { outcome: 'matched'; observations: [ReservationObservation]; capped: false }
  | {
      outcome: 'ambiguous';
      observations: ReservationObservation[];
      capped: boolean;
    };

export interface LiveGuestStayDriver {
  loginAndVerifyBinding(signal: AbortSignal): Promise<void>;
  runNotFoundCanary(signal: AbortSignal): Promise<void>;
  searchExact(
    candidate: ExactReservationCandidate,
    signal: AbortSignal,
  ): Promise<GuestStaySearchResult>;
}

export type LiveGuestStayDriverOptions = {
  runtime: HmsRuntime;
  transportId: string;
  /** Optional hook after session open (tests). */
  onSession?: (session: HmsReadSession) => void;
};

const NO_RESULTS_RE =
  /no reservations found|no records|no results|no data to display|0 records|0 items|not found|no matching/i;

const RESERVATION_MATCH_CAP = 20;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseIsoDateOrNull(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('guest stay parse aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function rowMatchesCandidate(
  row: ReservationObservation,
  candidate: ExactReservationCandidate,
): boolean {
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
 * Parse Guest Stay HTML against structural fingerprint selectors.
 * Returns only rows correlated to the exact candidate. Never opens detail.
 */
export function parseAndCorrelateGuestStayHtml(
  html: string,
  candidate: ExactReservationCandidate,
  signal?: AbortSignal,
): GuestStaySearchResult {
  throwIfAborted(signal);
  const sel = LIVE_GUEST_STAY_ROW_SELECTORS;
  const $ = cheerio.load(html);
  if ($(sel.correlationFailed).length > 0) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'search correlation failed',
    );
  }

  const fresh = parseAllFreshRows(html).filter(
    (row) => row.confirmationNumber || row.externalReference,
  );
  const correlated = fresh.filter((row) => rowMatchesCandidate(row, candidate));

  if (
    correlated.length === 0 &&
    ($(sel.noResults).length > 0 || NO_RESULTS_RE.test(html) || fresh.length === 0)
  ) {
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
  return {
    outcome: 'ambiguous',
    observations: capped
      ? correlated.slice(0, RESERVATION_MATCH_CAP)
      : correlated,
    capped,
  };
}

function hasGuestStaySearch(html: string): boolean {
  return /name="search"|ff_confirmationnumber|data-testid="results"/i.test(
    html,
  );
}

async function clickMenuLabel(page: HmsPage, label: string): Promise<boolean> {
  try {
    await page.click(`text=${label}`);
    return true;
  } catch {
    return false;
  }
}

async function navigateGuestStay(page: HmsPage, origin: string): Promise<void> {
  let html = await page.content().catch(() => '');
  if (hasGuestStaySearch(html)) return;

  // Live post-login session is already on COMMON with the tree.
  // Never re-goto bare /web/base/COMMON — REQ_KEY is a required variable query
  // key, so empty-query COMMON documents are blocked (invalid_variable_query).
  if (/Front Desk/i.test(html)) {
    const urlBefore = page.url();
    await clickMenuLabel(page, 'Front Desk');
    await new Promise((r) => setTimeout(r, 800));
    await clickMenuLabel(page, 'Guest Stay');
    html = await page.content().catch(() => '');
    if (hasGuestStaySearch(html)) return;
    // Live ExtJS usually leaves COMMON; fixture menu spans are no-ops — fail fast.
    if (page.url() !== urlBefore || /OSRESV/i.test(page.url())) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        html = await page.content().catch(() => '');
        if (hasGuestStaySearch(html)) return;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  // Fixture live-infor: data-* attrs + direct OSRESV shell with search field.
  // Live: skip OSRESV document GET — after menu miss it has fired POST logindisp.
  const fixtureShell = /data-tenant=|data-property-code=/i.test(html);
  if (fixtureShell) {
    try {
      await page.goto(`${origin}/web/base/OSRESV`, { timeout: 8_000 });
    } catch {
      /* continue */
    }
    html = await page.content().catch(() => '');
    if (hasGuestStaySearch(html)) return;
  }

  // Fallback: reviewed OSRESV open POST (query + body). Must not setContent.
  try {
    await page.postForm(
      `${origin}/web/base/OSRESV?FUNCTION_CLASS=SCREEN&USER_FUNCTION_NAME=OSRESV`,
      {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'HDR',
        MENU_MODULE_KEY: '1',
        FUNCTION_CLASS: 'SCREEN',
        removescreenflows: 'false',
      },
    );
  } catch {
    /* continue wait loop */
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    html = await page.content().catch(() => '');
    if (hasGuestStaySearch(html)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function submitExactSearch(
  page: HmsPage,
  origin: string,
  candidate: ExactReservationCandidate,
): Promise<string> {
  const body = buildExactOsressSearchBody(candidate);
  // Optional UI priming only — policy-authoritative POST is exact scaffold.
  const html = await page.content();
  if (/name="search"/i.test(html)) {
    await page.fill('input[name="search"]', candidate.value).catch(() => undefined);
  } else if (/name="ff_confirmationnumber"/i.test(html)) {
    await page
      .fill('input[name="ff_confirmationnumber"]', candidate.value)
      .catch(() => undefined);
  }
  const waitCorrelation = page.waitForCorrelatedResponse
    ? page.waitForCorrelatedResponse(LIVE_GUEST_STAY_SEARCH_PATH)
    : Promise.resolve();
  const responseHtml = await page.postForm(
    `${origin}${LIVE_GUEST_STAY_SEARCH_PATH}`,
    body,
  );
  try {
    await waitCorrelation;
  } catch {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'search correlation failed');
  }
  // Prefer POST body (fixture + live XHR). Fall back to DOM for ExtJS-rendered grids.
  if (responseHtml && responseHtml.length > 0) return responseHtml;
  return page.content();
}

export function createLiveGuestStayDriver(
  options: LiveGuestStayDriverOptions,
): LiveGuestStayDriver {
  const { runtime, transportId } = options;

  async function withSession<T>(
    signal: AbortSignal,
    candidate: ExactReservationCandidate | null,
    fn: (session: HmsReadSession) => Promise<T>,
  ): Promise<T> {
    const session = await runtime.openReadSession({
      transportId,
      signal,
      exactSearchCandidate: candidate ?? undefined,
      // Allow driver to open before/without fixture startup canary.
      allowUnstarted: true,
    });
    options.onSession?.(session);
    try {
      return await fn(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  return {
    async loginAndVerifyBinding(signal) {
      await withSession(signal, null, async (session) => {
        const binding = await session.page.readPropertyBinding();
        if (!binding.tenant || !binding.propertyCode) {
          const title = await session.page.title();
          if (!/HRCEN|Centurion/i.test(title)) {
            throw new HmsRuntimeError(
              'PROPERTY_MISMATCH',
              'property binding missing after login',
            );
          }
        }
        const url = session.page.url();
        if (!url.startsWith(session.origin)) {
          throw new HmsRuntimeError('AUTH_FAILED', 'post-login origin mismatch');
        }
      });
    },

    async runNotFoundCanary(signal) {
      const canary = liveNotFoundCanaryCandidate();
      const result = await withSession(signal, canary, async (session) => {
        await navigateGuestStay(session.page, session.origin);
        const html = await submitExactSearch(
          session.page,
          session.origin,
          canary,
        );
        if (!NO_RESULTS_RE.test(html) && !/data-testid="no-results"/i.test(html)) {
          if (/Unable to retrieve text|success"\s*:\s*false/i.test(html)) {
            throw new HmsRuntimeError(
              'SCHEMA_DRIFT',
              'Guest Stay search component not ready',
            );
          }
          throw new HmsRuntimeError(
            'canary_reservation',
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
      });
      void result;
      void LIVE_NOTFOUND_CANARY;
    },

    async searchExact(candidate, signal) {
      if (!candidate.value || candidate.value.length > 64) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'candidate value invalid');
      }
      void buildExactOsressSearchManifest;
      return withSession(signal, candidate, async (session) => {
        await navigateGuestStay(session.page, session.origin);
        const html = await submitExactSearch(
          session.page,
          session.origin,
          candidate,
        );
        if (session.violation()?.action === 'block') {
          const v = session.violation();
          throw new HmsRuntimeError(
            'POLICY_BLOCK',
            v && v.action === 'block' ? v.code : 'policy_block',
          );
        }
        return parseAndCorrelateGuestStayHtml(html, candidate, signal);
      });
    },
  };
}
