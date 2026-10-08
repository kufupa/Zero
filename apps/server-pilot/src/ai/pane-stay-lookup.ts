import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
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
  bookingAgency: string | null;
  organization: string | null;
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
  /** The arrival is a hint: a different HMS arrival is reported with both dates, never refused. */
  arrivalMismatch: boolean;
  requestedArrival: string | null;
  hmsArrival: string | null;
  /** File names only. The files stay in the lookup run directory. */
  screenshots: string[];
  runId: string | null;
};

export type GuestDatesQuery = { lastName: string; arrival: string; departure: string };

export type PaneStayLookupSpawnInput =
  | { mode: 'find'; confirmation: string; arrival: string | null }
  | ({ mode: 'search-guest' } & GuestDatesQuery);

/** What one stay-lookup.mjs run reports in its result.json. Screenshots are absolute paths. */
export type PaneStayLookupSpawnResult = {
  outcome: string;
  reason: string | null;
  stay: PaneStayFields | null;
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
  /** Called for each run that wrote a directory, so the caller can register its screenshots for reads. */
  onRun?: (run: { runId: string; dir: string }) => void;
};

export const paneStayLookupLoaders: {
  spawn: ((input: PaneStayLookupSpawnInput) => Promise<PaneStayLookupSpawnResult>) | null;
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

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isConfirmation(value: string): boolean {
  return /^\d+-\d+$/.test(value);
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
    bookingAgency: text(raw.bookingAgency),
    organization: text(raw.organization),
  };
}

async function defaultSpawn(input: PaneStayLookupSpawnInput): Promise<PaneStayLookupSpawnResult> {
  const runId = randomUUID();
  const dir = join(tmpdir(), `pane-lookup-${runId}`);
  await mkdir(dir, { mode: 0o700 });
  let runError: unknown = null;
  try {
    await execFileAsync('node', buildStayLookupArgs(input, dir), {
      timeout: LOOKUP_TIMEOUT_MS,
      env: { ...process.env },
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
  return {
    outcome: result.outcome ?? 'execution_failure',
    reason: result.reason ?? null,
    stay: result.stay ?? null,
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
  const spawn = paneStayLookupLoaders.spawn ?? defaultSpawn;
  let run: PaneStayLookupSpawnResult;
  try {
    run = await lock.withLock(
      () => spawn({ mode: 'find', confirmation: input.confirmation, arrival: input.arrival ?? null }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    return refused(isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'execution_failure');
  }
  if (run.runId && run.runDir) deps.onRun?.({ runId: run.runId, dir: run.runDir });
  const outcome = toFindOutcome(run.outcome);
  const stay = outcome === 'found' ? toPaneStayFields(run.stay) : null;
  return {
    outcome,
    reason: run.reason,
    stay,
    arrivalMismatch: run.arrivalMismatch === true,
    requestedArrival: run.requestedArrival ?? input.arrival ?? null,
    hmsArrival: run.hmsArrival ?? stay?.arrival ?? null,
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
export function guestDatesVerdict(rows: PaneStayPanelRow[], query: GuestDatesQuery): OsressDuplicateStatus {
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
): Promise<OsressDuplicateStatus> {
  const spawn = paneStayLookupLoaders.spawn ?? defaultSpawn;
  let run: PaneStayLookupSpawnResult | null = null;
  try {
    run = await spawn({ mode: 'search-guest', ...input });
    return run.outcome === 'ok' ? guestDatesVerdict(run.rows, input) : 'duplicate';
  } catch {
    return 'duplicate';
  } finally {
    // Panel screenshots show guest names, so this run's directory does not outlive the check.
    if (run?.runDir) await rm(run.runDir, { recursive: true, force: true }).catch(() => {});
  }
}
