/**
 * Commit-time duplicate check for the pane stay save (F9 section c).
 *
 * One OSRESS.search by surname + arrival + departure through the production
 * read path hms_find_reservation uses: runtime, Guest Stay driver, find-scoped
 * session authorization and the tenant/property read lock (same key as the
 * worker). The session manifest is the reviewed OSRESS.search rule, so
 * request-policy blocks writes. Every failure path reports a possible
 * duplicate (fail closed).
 */
import { randomUUID } from 'node:crypto';
import { paneStaySaveLoaders, type OsressDuplicateStatus } from '../ai/pane-stay-save.js';
import type { ReservationObservation } from './contracts.js';
import type { GuestStaySearchResult, LiveGuestStayDriver } from './live-guest-stay-driver.js';
import type { SurnameDatesReservationCandidate } from './live-read-manifest.js';

export type GuestDatesSearchInput = { lastName: string; arrival: string; departure: string };

export type GuestDatesMatch = {
  confirmation: string | null;
  lastName: string | null;
  firstName: string | null;
  arrival: string | null;
  departure: string | null;
  status: string | null;
};

export type GuestDatesVerdict =
  | { verdict: 'clear'; matches: []; reason: 'no_match' }
  | { verdict: 'duplicate'; matches: GuestDatesMatch[]; reason: 'exact_match' }
  | {
      verdict: 'possible_duplicate';
      matches: GuestDatesMatch[];
      reason:
        | 'ambiguous'
        | 'capped'
        | 'unexpected_result'
        | 'invalid_input'
        | 'outside_search_window'
        | 'timeout'
        | `search_error:${string}`;
    };

export type GuestDatesDriverHandle = {
  driver: Pick<LiveGuestStayDriver, 'searchExact'>;
  dispose: () => Promise<void>;
};

export type GuestDatesSearchDeps = {
  /** Opens one read-only Guest Stay driver. Default: production runtime built from env. */
  openDriver?: (input: {
    candidate: SurnameDatesReservationCandidate;
    signal: AbortSignal;
  }) => Promise<GuestDatesDriverHandle>;
  /** Env for the production driver. Default: process.env. */
  env?: NodeJS.Dict<string>;
  now?: () => Date;
  /** Budget for open + property lock + search, in ms. */
  deadlineMs?: number;
};

/** Matches HMS_RUN_DEADLINE_MS default (env.ts). */
const DEFAULT_DEADLINE_MS = 150_000;
/** Upper bound on closing the per-check runtime; a stuck close must not hang Commit. */
const DISPOSE_BUDGET_MS = 15_000;
const DAY_MS = 86_400_000;
/**
 * OSRESS.search (live-read-manifest.ts buildExactOsressSearchBody) filters
 * arrivaldate <= today+365 and departuredate >= today-365 on HMS server time.
 * Stays outside that window could be missed, so they fail closed.
 */
const OSRESS_WINDOW_DAYS = 365;
const WINDOW_MARGIN_DAYS = 30;
/** Same audit identity the worker's find driver uses. */
const FIND_TOOL_VERSION = '1.2.0';
const DEPENDENCY_REVISION = 'playwright-1.52.0-chromium-1169';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day number for a strict YYYY-MM-DD string, else null. */
function isoDay(iso: unknown): number | null {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return ms / DAY_MS;
}

function withinSearchWindow(arrivalDay: number, departureDay: number, now: Date): boolean {
  const today = Math.floor(now.getTime() / DAY_MS);
  const span = OSRESS_WINDOW_DAYS - WINDOW_MARGIN_DAYS;
  return [arrivalDay, departureDay].every((day) => day >= today - span && day <= today + span);
}

function guestNameParts(
  guestName: string | null,
  surname: string,
): Pick<GuestDatesMatch, 'lastName' | 'firstName'> {
  const name = guestName?.trim() ?? '';
  if (!name) return { lastName: null, firstName: null };
  const comma = name.indexOf(',');
  if (comma >= 0) {
    return {
      lastName: name.slice(0, comma).trim() || null,
      firstName: name.slice(comma + 1).trim() || null,
    };
  }
  // Driver only correlates rows whose name is the surname or starts with "SURNAME ".
  return { lastName: surname, firstName: name.slice(surname.length).trim() || null };
}

function toMatch(row: ReservationObservation, surname: string): GuestDatesMatch {
  return {
    confirmation: row.confirmationNumber ?? row.externalReference,
    ...guestNameParts(row.guestName, surname),
    arrival: row.arrivalDate,
    departure: row.departureDate,
    status: row.reservationStatus,
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z_]{1,40}$/.test(code) ? code : 'unknown';
}

/** Map one driver search result to a verdict. Only a clean not_found or a single exact row is decided. */
export function classifyGuestDatesSearch(
  result: GuestStaySearchResult,
  surname: string,
): GuestDatesVerdict {
  if (result.outcome === 'not_found') return { verdict: 'clear', matches: [], reason: 'no_match' };
  const rows: ReservationObservation[] = result.observations;
  const matches = rows.map((row) => toMatch(row, surname));
  if (result.outcome === 'matched') {
    return matches.length === 1
      ? { verdict: 'duplicate', matches, reason: 'exact_match' }
      : { verdict: 'possible_duplicate', matches, reason: 'unexpected_result' };
  }
  return {
    verdict: 'possible_duplicate',
    matches,
    reason: result.capped ? 'capped' : 'ambiguous',
  };
}

/** Production open: same runtime, lock key, and find lease the worker uses for hms_find_reservation. */
async function openProductionGuestDatesDriver(
  candidate: SurnameDatesReservationCandidate,
  signal: AbortSignal,
  env: NodeJS.Dict<string>,
): Promise<GuestDatesDriverHandle> {
  const { requireHmsEvidenceHmacChildKey, requireHmsReadRuntimeConfig } = await import('../env.js');
  const config = requireHmsReadRuntimeConfig(env);
  const evidenceKey = requireHmsEvidenceHmacChildKey(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('database_url_missing');
  const { CENTURION_HMS_PRODUCTION_ORIGIN, createProductionHmsRuntime, resolveHmsSourceRevision } =
    await import('./production-runtime.js');
  const { runtimeFingerprintSha256 } = await import('./evidence-runtime.js');
  const {
    assertFindHandlerBound,
    buildHmsFindSessionAuthorization,
    loadWorkerActiveReadSet,
    placeholderDigest,
  } = await import('./active-read-runtime.js');
  const { buildExactOsressSearchManifest } = await import('./live-read-manifest.js');
  const { createLiveGuestStayDriver } = await import('./live-guest-stay-driver.js');
  const { createPostgresPropertyReadLock } = await import('./property-read-lock.js');

  const propertyReadLock = createPostgresPropertyReadLock({
    tenantId: config.expectedTenant,
    propertyCode: config.expectedPropertyCode,
    databaseUrl,
  });
  const sourceRevision = resolveHmsSourceRevision();
  const runtimeFp = runtimeFingerprintSha256({
    sourceRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
  });
  const active = await loadWorkerActiveReadSet({
    registryPath: config.activeRegistryPath,
    releaseRoot: config.releaseRoot,
    runtimeFingerprintSha256: runtimeFp,
  });
  const findRaw = active.releases.get('hms_find_reservation') ?? null;
  const findRelease = findRaw && findRaw.evidenceKind === 'hms' ? findRaw : null;

  const runtime = await createProductionHmsRuntime(config, {
    evidenceHmac: {
      secretArn: config.evidenceHmacSecretArn,
      keyVersion: config.evidenceHmacKeyVersion,
      key: evidenceKey.key,
    },
    sourceRevision,
  });
  try {
    await runtime.start(signal);
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }

  const driver = createLiveGuestStayDriver({
    runtime,
    transportId: config.expectedTransportId,
    auditSpecFor: ({ inputClass }) => ({
      operationId: candidate.id,
      toolId: 'hms_find_reservation',
      toolVersion: FIND_TOOL_VERSION,
      dependencyRevision: DEPENDENCY_REVISION,
      executionClass: 'normal',
      inputClass,
    }),
    sessionAuthorizationFor: ({ candidate: searched }) => {
      if (!searched) throw new Error('surname_dates candidate required');
      const auth = buildHmsFindSessionAuthorization({
        operationId: candidate.id,
        requestBranchId: 'guest_stay_search',
        manifest: buildExactOsressSearchManifest(CENTURION_HMS_PRODUCTION_ORIGIN, searched),
        roleProofPath: config.roleProofPath,
        roleProofSha256: findRelease?.roleProofSha256 ?? placeholderDigest('role-proof'),
        credentialVersionHmacSha256:
          findRelease?.credentialVersionHmacSha256 ?? placeholderDigest('credential'),
        runtimeFingerprintSha256: findRelease?.runtimeFingerprintSha256 ?? runtimeFp,
        privateDigestKeyVersion: findRelease?.privateDigestKeyVersion ?? 'v1',
        sourceRevision: findRelease?.sourceRevision ?? sourceRevision,
        release: findRelease,
      });
      if (findRelease) assertFindHandlerBound(findRelease, auth);
      return auth;
    },
    propertyReadLock,
  });

  return {
    driver,
    dispose: () => runtime.close(),
  };
}

/**
 * Rejects when the deadline fires, even if the underlying call ignores its
 * signal (HMS navigation uses fixed sleeps that never check abort).
 */
function untilDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('guest_dates_deadline'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, expired]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

async function disposeWithin(dispose: () => Promise<void>): Promise<void> {
  const closing = Promise.resolve()
    .then(dispose)
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DISPOSE_BUDGET_MS);
  });
  await Promise.race([closing, budget]);
  clearTimeout(timer);
}

export function createGuestDatesDuplicateVerdict(
  deps: GuestDatesSearchDeps = {},
): (input: GuestDatesSearchInput) => Promise<GuestDatesVerdict> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = deps.now ?? (() => new Date());
  const openDriver =
    deps.openDriver ??
    ((input) =>
      openProductionGuestDatesDriver(input.candidate, input.signal, deps.env ?? process.env));

  return async function guestDatesDuplicateVerdict(input) {
    const surname = typeof input.lastName === 'string' ? input.lastName.trim() : '';
    const arrivalDay = isoDay(input.arrival);
    const departureDay = isoDay(input.departure);
    if (
      !surname ||
      surname.length > 64 ||
      arrivalDay === null ||
      departureDay === null ||
      departureDay <= arrivalDay
    ) {
      return { verdict: 'possible_duplicate', matches: [], reason: 'invalid_input' };
    }
    if (!withinSearchWindow(arrivalDay, departureDay, now())) {
      return { verdict: 'possible_duplicate', matches: [], reason: 'outside_search_window' };
    }

    const candidate: SurnameDatesReservationCandidate = {
      id: randomUUID(),
      kind: 'surname_dates',
      surname,
      arrivalDate: input.arrival,
      departureDate: input.departure,
    };
    const signal = AbortSignal.timeout(deadlineMs);
    const opening = Promise.resolve().then(() => openDriver({ candidate, signal }));
    let handle: GuestDatesDriverHandle | null = null;
    try {
      handle = await untilDeadline(opening, signal);
      const result = await untilDeadline(handle.driver.searchExact(candidate, signal), signal);
      return classifyGuestDatesSearch(result, surname);
    } catch (error) {
      return {
        verdict: 'possible_duplicate',
        matches: [],
        reason: signal.aborted ? 'timeout' : `search_error:${errorCode(error)}`,
      };
    } finally {
      if (handle) {
        const open = handle;
        await disposeWithin(() => open.dispose());
      } else {
        // An open that completes after the deadline must not leak a browser.
        opening.then(
          (late) => disposeWithin(() => late.dispose()),
          () => undefined,
        );
      }
    }
  };
}

/** Exact reader type paneStaySaveLoaders.osressGuestDatesSearch expects. Any failure reads as duplicate. */
export function createGuestDatesDuplicateStatus(
  deps: GuestDatesSearchDeps = {},
): (input: GuestDatesSearchInput) => Promise<OsressDuplicateStatus> {
  const verdict = createGuestDatesDuplicateVerdict(deps);
  return async (input) => {
    try {
      return (await verdict(input)).verdict === 'clear' ? 'clear' : 'duplicate';
    } catch {
      return 'duplicate';
    }
  };
}

/** Production reader (default deps). */
export const guestDatesDuplicateStatus = createGuestDatesDuplicateStatus();

/**
 * Assigns the Commit duplicate reader. Call once at server startup; idempotent.
 * Commit still requires RESERVATIONIST_PANE_SAVE=on and the Labtest/2027 guard.
 */
export function wirePaneStayDuplicateCheck(deps?: GuestDatesSearchDeps): void {
  paneStaySaveLoaders.osressGuestDatesSearch = createGuestDatesDuplicateStatus(deps);
}
