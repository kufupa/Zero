import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
  type PropertyReadLockAcquisitionOptions,
} from '../hms/property-read-lock.js';
import type { OsressDuplicateStatus, PaneStayLock } from './pane-stay-save.js';

const execFileAsync = promisify(execFile);
const STAY_LOOKUP = fileURLToPath(
  new URL('../../tooling/playwright-quote/stay-lookup.mjs', import.meta.url),
);
// A find opens one record and a search-guest reads one panel. Both finish well inside this.
const LOOKUP_TIMEOUT_MS = 5 * 60_000;

/** Fields of one Guest Stay as the lookup CLI reads them from the record form. Null when not shown. */
export type PaneStayFields = {
  status: string | null;
  confirmation: string | null;
  lastName: string | null;
  firstName: string | null;
  arrival: string | null;
  departure: string | null;
  nights: number | null;
  adults: number | null;
  children: number | null;
  roomType: string | null;
  ratePlan: string | null;
  mealPlan: string | null;
  averageRate: string | null;
  grandTotal: string | null;
  balance: string | null;
  sourceOfBusiness: string | null;
  guaranteeType: string | null;
  /** HMS deposit received. Null when the control is missing. Absent on older snapshots. */
  depositReceived?: string | null;
  bookingAgency: string | null;
  organization: string | null;
};

export type PaneStayPartyIdentity = { name?: string; nativeId?: string; iata?: string };

/** Optional commercial facts read from the same opened Guest Stay record. */
export type PaneStayCommercial = {
  company?: PaneStayPartyIdentity;
  agency?: PaneStayPartyIdentity;
  ratePlan?: string;
  mealPlan?: string;
  roomType?: string;
  marketSegment?: string;
  sourceOfBusiness?: string;
  averageRate?: string;
  status?: string;
  arrival?: string;
  departure?: string;
  guaranteeType?: string;
  depositReceived?: string;
};

/** One quick-search dropdown row. Dates are ISO; departure is null when the row shows none. */
export type PaneStayPanelRow = {
  confirmation: string;
  lastName: string;
  firstName: string;
  status: string;
  arrival: string | null;
  departure: string | null;
};

export type PaneStayFindOutcome = 'found' | 'not_found' | 'ambiguous' | 'execution_failure';

export type PaneStayFindInput = { confirmation: string; arrival?: string };

export type PaneStayFindResult = {
  outcome:
    | PaneStayFindOutcome
    | 'refused_flag_off'
    | 'refused_input_invalid'
    | 'refused_lock_unavailable'
    | 'refused_lock_busy';
  reason: string | null;
  stay: PaneStayFields | null;
  commercial?: PaneStayCommercial;
  /** The arrival is a hint: a different HMS arrival is reported with both dates, never refused. */
  arrivalMismatch: boolean;
  requestedArrival: string | null;
  hmsArrival: string | null;
  /** File names only. The files stay in the lookup run directory. */
  screenshots: string[];
  runId: string | null;
};

export type GuestDatesQuery = { lastName: string; arrival: string; departure: string };

/** A surname search on one arrival day, optionally narrowed to one departure day. */
export type GuestSearchQuery = { lastName: string; arrival: string; departure?: string };

export type PaneStayLookupSpawnInput =
  | { mode: 'find'; confirmation: string; arrival: string | null }
  | ({ mode: 'search-guest' } & GuestSearchQuery);

export type PaneStayGuestSearchOutcome = 'ok' | 'ambiguous_capped' | 'execution_failure';

export type PaneStayGuestSearchResult = {
  outcome:
    | PaneStayGuestSearchOutcome
    | 'refused_flag_off'
    | 'refused_input_invalid'
    | 'refused_lock_unavailable'
    | 'refused_lock_busy';
  /** Complete only for an ok read. A capped or failed read reports no rows, so nothing can be picked from a partial list. */
  rows: PaneStayPanelRow[];
  /** File names only. The files stay in the lookup run directory. */
  screenshots: string[];
  runId: string | null;
};

/** What one stay-lookup.mjs run reports in its result.json. Screenshots are absolute paths. */
export type PaneStayLookupSpawnResult = {
  outcome: string;
  reason: string | null;
  stay: PaneStayFields | null;
  commercial?: PaneStayCommercial | null;
  rows: PaneStayPanelRow[];
  arrivalMismatch?: boolean;
  requestedArrival?: string | null;
  hmsArrival?: string | null;
  screenshots: string[];
  runId?: string;
  runDir?: string;
};

export type PaneStayLookupDeps = {
  /** The session hotel's property lock, resolved per call. Null means no lock can be made, so the run is refused. */
  lock: () => PaneStayLock | null;
  /** Lock acquisition bounds. Absent means wait up to PANE_PROPERTY_LOCK_WAIT_MS. */
  acquisition?: PropertyReadLockAcquisitionOptions;
  /** Called for each run that wrote a directory, so the caller can register its screenshots for reads. */
  onRun?: (run: { runId: string; dir: string }) => void;
  /** Explicit HMS property/slot for the CLI env. Writes omit this and stay Centurion. */
  target?: HmsReadTarget | null;
};

export const paneStayLookupLoaders: {
  spawn:
    | ((
        input: PaneStayLookupSpawnInput,
        target?: HmsReadTarget | null,
      ) => Promise<PaneStayLookupSpawnResult>)
    | null;
  lock: PaneStayLock | null;
  enabled: (() => boolean) | null;
} = {
  spawn: null,
  lock: null,
  enabled: null,
};

// Read-only, so it is not gated by RESERVATIONIST_PANE_SAVE. On by default; PANE_STAY_LOOKUP=off turns it off.
export function paneStayLookupEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PANE_STAY_LOOKUP !== 'off';
}

export type AmendPaymentClass = 'unpaid' | 'paid' | 'guaranteed' | 'unknown';

export type AmendPaymentStay = {
  status?: string | null;
  guaranteeType?: string | null;
  depositReceived?: string | null;
};

function paymentText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Deposit amount from HMS text. Null when the field is missing or not a number. */
export function parseDepositReceived(value: unknown): number | null {
  const text = paymentText(value);
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function guaranteeKind(guaranteeType: unknown): 'non_paying' | 'paying' | 'missing' | 'unknown' {
  const text = paymentText(guaranteeType).toLowerCase();
  if (!text) return 'missing';
  if (/^non[-\s]?guaranteed/.test(text) || text === 'none') return 'non_paying';
  if (
    /guaranteed/.test(text) ||
    /confirmation received/.test(text) ||
    /awaiting voucher/.test(text) ||
    /deposit requested/.test(text) ||
    /group definite/.test(text) ||
    /credit card/.test(text)
  ) {
    return 'paying';
  }
  return 'unknown';
}

function isProvisionalStatus(status: unknown): boolean {
  const text = paymentText(status).toLowerCase();
  return text === 'reserved' || text === 'provisional';
}

/**
 * R7 unpaid amend: provisional + deposit received 0 + non-paying guarantee.
 * A confirmed empty string from a visible input is blank (counts as 0 then).
 * null from an unread or absent field stays unknown.
 */
export function classifyAmendPayment(stay: AmendPaymentStay | null | undefined): AmendPaymentClass {
  if (!stay) return 'unknown';
  if (!paymentText(stay.status) || !paymentText(stay.guaranteeType)) return 'unknown';
  const guarantee = guaranteeKind(stay.guaranteeType);
  if (guarantee === 'missing' || guarantee === 'unknown') return 'unknown';
  const depositRaw = stay.depositReceived;
  if (depositRaw == null) return guarantee === 'paying' ? 'guaranteed' : 'unknown';
  const depositText = paymentText(depositRaw);
  const confirmedBlank = typeof depositRaw === 'string' && depositText === '';
  const deposit = depositText ? parseDepositReceived(depositRaw) : null;
  if (depositText && deposit == null) return 'unknown';
  if (deposit != null && deposit > 0) return 'paid';
  if (guarantee === 'paying') return 'guaranteed';
  const depositIsZero = deposit === 0 || confirmedBlank;
  if (isProvisionalStatus(stay.status) && depositIsZero && guarantee === 'non_paying') return 'unpaid';
  return 'unknown';
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isConfirmation(value: string): boolean {
  return /^\d+-\d+$/.test(value);
}

/** Surname as the search takes it. Starts and ends on a letter, so it can never read as a CLI flag. */
export const GUEST_SURNAME_PATTERN = /^\p{L}[\p{L} '-]*\p{L}$/u;

export function isGuestSurname(value: string): boolean {
  return value.length >= 2 && value.length <= 40 && GUEST_SURNAME_PATTERN.test(value);
}

export function buildStayLookupArgs(input: PaneStayLookupSpawnInput, outDir: string): string[] {
  if (input.mode === 'find') {
    const args = [STAY_LOOKUP, '--mode', 'find', '--confirmation', input.confirmation, '--out', outDir];
    if (input.arrival) args.push('--arrival', input.arrival);
    return args;
  }
  const args = [
    STAY_LOOKUP,
    '--mode',
    'search-guest',
    '--last-name',
    input.lastName,
    '--arrival',
    input.arrival,
    '--out',
    outDir,
  ];
  if (input.departure) args.push('--departure', input.departure);
  return args;
}

function refused(outcome: PaneStayFindResult['outcome']): PaneStayFindResult {
  return {
    outcome,
    reason: null,
    stay: null,
    arrivalMismatch: false,
    requestedArrival: null,
    hmsArrival: null,
    screenshots: [],
    runId: null,
  };
}

const FIND_OUTCOMES: ReadonlySet<string> = new Set(['found', 'not_found', 'ambiguous', 'execution_failure']);

function toFindOutcome(raw: string): PaneStayFindOutcome {
  return FIND_OUTCOMES.has(raw) ? (raw as PaneStayFindOutcome) : 'execution_failure';
}

// Keeps only the fields the lookup reports, with the types the CLI writes. Anything else becomes null.
function toPaneStayFields(raw: Partial<PaneStayFields> | null | undefined): PaneStayFields | null {
  if (!raw) return null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;
  return {
    status: text(raw.status),
    confirmation: text(raw.confirmation),
    lastName: text(raw.lastName),
    firstName: text(raw.firstName),
    arrival: text(raw.arrival),
    departure: text(raw.departure),
    nights: count(raw.nights),
    adults: count(raw.adults),
    children: count(raw.children),
    roomType: text(raw.roomType),
    ratePlan: text(raw.ratePlan),
    mealPlan: text(raw.mealPlan),
    averageRate: text(raw.averageRate),
    grandTotal: text(raw.grandTotal),
    balance: text(raw.balance),
    sourceOfBusiness: text(raw.sourceOfBusiness),
    guaranteeType: text(raw.guaranteeType),
    depositReceived: text(raw.depositReceived),
    bookingAgency: text(raw.bookingAgency),
    organization: text(raw.organization),
  };
}

// A parser/runner can only contribute allowlisted non-empty commercial fields. A malformed optional object is ignored.
function toPaneStayCommercial(raw: unknown): PaneStayCommercial | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const party = (value: unknown): PaneStayPartyIdentity | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    const name = text(candidate.name);
    const nativeId = text(candidate.nativeId);
    const iata = text(candidate.iata);
    if (!name && !nativeId && !iata) return undefined;
    return {
      ...(name ? { name } : {}),
      ...(nativeId ? { nativeId } : {}),
      ...(iata ? { iata } : {}),
    };
  };
  const commercial: PaneStayCommercial = {};
  const company = party(source.company);
  const agency = party(source.agency);
  if (company) commercial.company = company;
  if (agency) commercial.agency = agency;
  for (const field of [
    'ratePlan', 'mealPlan', 'roomType', 'marketSegment', 'sourceOfBusiness', 'averageRate',
    'status', 'arrival', 'departure', 'guaranteeType', 'depositReceived',
  ] as const) {
    const value = text(source[field]);
    if (value) commercial[field] = value;
  }
  return Object.keys(commercial).length > 0 ? commercial : undefined;
}

async function defaultSpawn(
  input: PaneStayLookupSpawnInput,
  target?: HmsReadTarget | null,
): Promise<PaneStayLookupSpawnResult> {
  const runId = randomUUID();
  const dir = join(tmpdir(), `pane-lookup-${runId}`);
  await mkdir(dir, { mode: 0o700 });
  let runError: unknown = null;
  try {
    await execFileAsync('node', buildStayLookupArgs(input, dir), {
      timeout: LOOKUP_TIMEOUT_MS,
      env: paneStaySpawnEnv(process.env, undefined, target ?? null),
    });
  } catch (error) {
    // The CLI exits 1 or 2 on failures and refusals but still writes result.json. Read that first.
    runError = error;
  }
  let result: Partial<PaneStayLookupSpawnResult>;
  try {
    result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as Partial<PaneStayLookupSpawnResult>;
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw runError ?? new Error('pane_lookup_no_result');
  }
  if ((result.outcome ?? 'execution_failure') === 'execution_failure') {
    const cliError = (result as { error?: string }).error ?? 'pane_lookup_execution_failure';
    warnPaneStaySpawnFailed(input.mode, new Error(cliError));
  }
  return {
    outcome: result.outcome ?? 'execution_failure',
    reason: result.reason ?? null,
    stay: result.stay ?? null,
    ...(result.commercial ? { commercial: result.commercial } : {}),
    rows: result.rows ?? [],
    arrivalMismatch: result.arrivalMismatch,
    requestedArrival: result.requestedArrival,
    hmsArrival: result.hmsArrival,
    screenshots: result.screenshots ?? [],
    runId,
    runDir: dir,
  };
}

// Read-only find by confirmation, under the session hotel's property lock. A found stay carries its record fields;
// every other outcome carries no stay.
export async function findStay(input: PaneStayFindInput, deps: PaneStayLookupDeps): Promise<PaneStayFindResult> {
  const enabled = paneStayLookupLoaders.enabled ?? (() => paneStayLookupEnabled());
  if (!enabled()) return refused('refused_flag_off');
  if (!isConfirmation(input.confirmation)) return refused('refused_input_invalid');
  if (input.arrival !== undefined && !isRealIsoDate(input.arrival)) return refused('refused_input_invalid');
  const lock = deps.lock();
  if (!lock) return refused('refused_lock_unavailable');
  const spawn = paneStayLookupLoaders.spawn ?? ((spawnInput) => defaultSpawn(spawnInput, deps.target));
  let run: PaneStayLookupSpawnResult;
  try {
    run = await lock.withLock(
      () => spawn({ mode: 'find', confirmation: input.confirmation, arrival: input.arrival ?? null }),
      deps.acquisition ?? acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return refused('refused_lock_busy');
    warnPaneStaySpawnFailed('find', error);
    return refused('execution_failure');
  }
  if (run.runId && run.runDir) deps.onRun?.({ runId: run.runId, dir: run.runDir });
  const outcome = toFindOutcome(run.outcome);
  const stay = outcome === 'found' ? toPaneStayFields(run.stay) : null;
  const commercial = outcome === 'found' ? toPaneStayCommercial(run.commercial) : undefined;
  return {
    outcome,
    reason: run.reason,
    stay,
    ...(commercial ? { commercial } : {}),
    arrivalMismatch: run.arrivalMismatch === true,
    requestedArrival: run.requestedArrival ?? input.arrival ?? null,
    hmsArrival: run.hmsArrival ?? stay?.arrival ?? null,
    screenshots: run.screenshots.map((path) => basename(path)),
    runId: run.runId ?? null,
  };
}

function refusedSearch(outcome: PaneStayGuestSearchResult['outcome']): PaneStayGuestSearchResult {
  return { outcome, rows: [], screenshots: [], runId: null };
}

const SEARCH_OUTCOMES: ReadonlySet<string> = new Set(['ok', 'ambiguous_capped', 'execution_failure']);

function toSearchOutcome(raw: string): PaneStayGuestSearchOutcome {
  return SEARCH_OUTCOMES.has(raw) ? (raw as PaneStayGuestSearchOutcome) : 'execution_failure';
}

// Keeps the row fields the pane shows. A row with no confirmation number cannot be opened, so it is dropped.
function toPanelRows(raw: unknown): PaneStayPanelRow[] {
  if (!Array.isArray(raw)) return [];
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const day = (value: unknown): string | null =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  return raw.flatMap((row: Record<string, unknown> | null) => {
    const confirmation = text(row?.confirmation);
    if (!row || !confirmation) return [];
    return [
      {
        confirmation,
        lastName: text(row.lastName),
        firstName: text(row.firstName),
        status: text(row.status),
        arrival: day(row.arrival),
        departure: day(row.departure),
      },
    ];
  });
}

// Only rows on the requested arrival, and on the requested departure when one is given. A row whose departure is not
// shown cannot be confirmed for a departure search, so it is left out of that search.
function rowsOnRequestedDates(rows: PaneStayPanelRow[], query: GuestSearchQuery): PaneStayPanelRow[] {
  return rows.filter((row) => row.arrival === query.arrival
    && (query.departure === undefined || row.departure === query.departure));
}

// Read-only surname search on one arrival day (and optionally one departure), under the session hotel's property
// lock. Same lock, spawn and refusals as findStay. Rows come back only for an ok read.
export async function searchGuest(
  input: GuestSearchQuery,
  deps: PaneStayLookupDeps,
): Promise<PaneStayGuestSearchResult> {
  const enabled = paneStayLookupLoaders.enabled ?? (() => paneStayLookupEnabled());
  if (!enabled()) return refusedSearch('refused_flag_off');
  if (!isGuestSurname(input.lastName) || !isRealIsoDate(input.arrival)) return refusedSearch('refused_input_invalid');
  if (input.departure !== undefined && (!isRealIsoDate(input.departure) || input.departure <= input.arrival)) {
    return refusedSearch('refused_input_invalid');
  }
  const lock = deps.lock();
  if (!lock) return refusedSearch('refused_lock_unavailable');
  const spawn = paneStayLookupLoaders.spawn ?? ((spawnInput) => defaultSpawn(spawnInput, deps.target));
  let run: PaneStayLookupSpawnResult;
  try {
    run = await lock.withLock(
      () =>
        spawn({
          mode: 'search-guest',
          lastName: input.lastName,
          arrival: input.arrival,
          ...(input.departure !== undefined ? { departure: input.departure } : {}),
        }),
      deps.acquisition ?? acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return refusedSearch('refused_lock_busy');
    warnPaneStaySpawnFailed('search-guest', error);
    return refusedSearch('execution_failure');
  }
  if (run.runId && run.runDir) deps.onRun?.({ runId: run.runId, dir: run.runDir });
  const outcome = toSearchOutcome(run.outcome);
  return {
    outcome,
    rows: outcome === 'ok' ? rowsOnRequestedDates(toPanelRows(run.rows), input) : [],
    screenshots: run.screenshots.map((path) => basename(path)),
    runId: run.runId ?? null,
  };
}

function normalizeSurname(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isCancelledStatus(status: string): boolean {
  return /^cancel{1,2}ed$/i.test(status.trim());
}

// A non-cancelled row with the same surname, arrival and departure is a duplicate. A row whose departure is not
// shown cannot be ruled out, so it counts as a duplicate too.
function guestDatesQueryComplete(query: {
  lastName?: string;
  arrival?: string | null;
  departure?: string | null;
}): boolean {
  return Boolean(String(query.lastName ?? '').trim() && query.arrival && query.departure);
}

export function guestDatesVerdict(rows: PaneStayPanelRow[], query: GuestDatesQuery): OsressDuplicateStatus {
  if (!guestDatesQueryComplete(query)) return 'duplicate';
  const surname = normalizeSurname(query.lastName);
  const duplicate = rows.some((row) => normalizeSurname(row.lastName) === surname
    && row.arrival === query.arrival
    && (row.departure === null || row.departure === query.departure)
    && !isCancelledStatus(row.status));
  return duplicate ? 'duplicate' : 'clear';
}

// Duplicate reader for commit. It runs a search-guest CLI and takes no lock: the save holds the property lock across
// this read and the write, and a second acquisition here would wait on the first. Only a complete read that finds no
// duplicate is clear; a failed or incomplete read is a duplicate, so the save is refused.
export async function guestDatesDuplicateCheckViaCli(
  input: GuestDatesQuery,
  target?: HmsReadTarget | null,
): Promise<OsressDuplicateStatus> {
  if (!guestDatesQueryComplete(input)) return 'duplicate';
  const spawn = paneStayLookupLoaders.spawn ?? ((spawnInput) => defaultSpawn(spawnInput, target));
  let run: PaneStayLookupSpawnResult | null = null;
  try {
    run = await spawn({ mode: 'search-guest', ...input }, target);
    return run.outcome === 'ok' ? guestDatesVerdict(run.rows, input) : 'duplicate';
  } catch {
    return 'duplicate';
  } finally {
    // Panel screenshots show guest names, so this run's directory does not outlive the check.
    if (run?.runDir) await rm(run.runDir, { recursive: true, force: true }).catch(() => {});
  }
}
