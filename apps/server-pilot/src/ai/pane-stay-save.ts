import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import {
  acquisitionWithin,
  createPostgresPropertyReadLock,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
  type PropertyReadLockAcquisitionOptions,
} from '../hms/property-read-lock.js';
import { guestDatesDuplicateCheckViaCli } from './pane-stay-lookup.js';

const execFileAsync = promisify(execFile);
const CREATE_LAB_STAY = fileURLToPath(
  new URL('../../tooling/playwright-quote/create-lab-stay.mjs', import.meta.url),
);
// The hotel this HMS session runs on. The CLI never receives a propertyCode (paneStayRequestBody strips it),
// so every property lock is keyed on this value, whatever the stay asks for.
export const PANE_STAY_PROPERTY_CODE = 'HRCEN';
// A successful preview can be committed for this long, once, and only for the same stay.
export const PANE_PREVIEW_TTL_MS = 10 * 60_000;
// A run's screenshots stay fetchable for this long, then its directory is removed.
export const PANE_RUN_TTL_MS = 30 * 60_000;
export const PANE_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PANE_SCREENSHOT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}\.png$/;
// A commit that returns no booking number may still have booked the stay. Both outcomes reach the pane as
// pane_save_unconfirmed, never as a plain failure, so staff check HMS before they press Book again.
export const PANE_SAVE_UNCONFIRMED = 'pane_save_unconfirmed';
const UNCONFIRMED_SAVE_OUTCOMES = new Set(['save_unconfirmed', 'save_failed']);

export type PaneStay = {
  firstName: string;
  lastName: string;
  arrival: string;
  departure: string;
  adults: number;
  sourceOfBusiness: string;
  roomType: string;
  ratePlan: string;
  track: string;
  guaranteeType: string;
  childAges?: number[];
  propertyCode?: string;
};

export type PaneStayMode = 'preview' | 'commit';

/** busy: the check could not get the property lock within the pane wait, so nothing was checked. */
export type OsressDuplicateStatus = 'parked' | 'clear' | 'duplicate' | 'busy';

export type PaneStaySpawnInput = {
  stay: PaneStay;
  stopBefore: 'save' | null;
  paneCommit: boolean;
};

export type PaneStaySpawnResult = {
  outcome: string;
  clickedSave: boolean;
  confirmationNumber: string;
  /** Per-run directory that create-lab-stay.mjs wrote to. Absent when a test spawn never runs the CLI. */
  runId?: string;
  runDir?: string;
  /** PNG file names written by the run. */
  screenshots?: string[];
};

export type PaneStayResult = {
  status: 'ok' | 'refused';
  reason?: string;
  outcome?: string;
  confirmationNumber?: string;
  clickedSave?: boolean;
  /** Set only when a preview succeeded. Commit sends it back with the same stay. */
  previewDigest?: string | null;
  runId?: string;
  /** Screenshot file names. Fetch the bytes with readPaneStayScreenshot. */
  screenshots?: string[];
};

export type PaneStayLock = {
  /** Pane runs pass a bounded acquisition, so a busy lock refuses instead of waiting with no end. */
  withLock: <T>(fn: () => Promise<T>, acquisition?: PropertyReadLockAcquisitionOptions) => Promise<T>;
};

export const paneStaySaveLoaders: {
  spawn: ((input: PaneStaySpawnInput) => Promise<PaneStaySpawnResult>) | null;
  lock: PaneStayLock | null;
  osressGuestDatesSearch:
    | ((input: {
        lastName: string;
        arrival: string;
        departure: string;
      }) => Promise<OsressDuplicateStatus>)
    | null;
  enabled: (() => boolean) | null;
  now: (() => number) | null;
} = {
  spawn: null,
  lock: null,
  osressGuestDatesSearch: null,
  enabled: null,
  now: null,
};

// Shared with the cancel path, so tests drive one clock for both.
export function paneStayClock(): number {
  return paneStaySaveLoaders.now?.() ?? Date.now();
}

export function paneStaySaveEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.RESERVATIONIST_PANE_SAVE === 'on';
}

export function paneStayRequestBody(stay: PaneStay): Omit<PaneStay, 'propertyCode'> {
  const { propertyCode: _ignored, ...request } = stay;
  return request;
}

export function assertLabStayGuard(input: {
  lastName: string;
  arrivalDate?: string;
  arrival?: string;
}): void {
  const arrival = input.arrivalDate ?? input.arrival ?? '';
  if (!/^labtest$/i.test(input.lastName.trim())) {
    throw new Error('pane_save_labtest_required');
  }
  if (arrival < '2027-01-01') {
    throw new Error('pane_save_arrival_2027_required');
  }
}

// Canonical form of the stay: strings trimmed, undefined dropped, keys sorted. Equal stays give equal digests.
function canonicalStay(stay: PaneStay): string {
  const entries = Object.entries(stay)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

export function paneStayDigest(stay: PaneStay): string {
  return createHash('sha256').update(canonicalStay(stay), 'utf8').digest('hex');
}

// In-memory preview grants, keyed by owner and digest. One commit consumes a grant.
const panePreviews = new Map<string, number>();

function previewKey(owner: string, digest: string): string {
  return `${owner}\0${digest}`;
}

// Shared with the cancel path: owner-scoped, 10-minute TTL, one use. The two paths never hash the same input.
export function recordPanePreview(owner: string, digest: string, now: number): void {
  for (const [key, expiresAt] of panePreviews) {
    if (expiresAt <= now) panePreviews.delete(key);
  }
  panePreviews.set(previewKey(owner, digest), now + PANE_PREVIEW_TTL_MS);
}

// True only for an unexpired grant from the same owner. The grant is consumed either way.
export function takePanePreview(owner: string, digest: string, now: number): boolean {
  const key = previewKey(owner, digest);
  const expiresAt = panePreviews.get(key);
  panePreviews.delete(key);
  return expiresAt !== undefined && expiresAt > now;
}

// Run directories whose screenshots the owner can fetch. Expired runs are removed from disk.
type PaneRun = { dir: string; owner: string; expiresAt: number };
const paneRuns = new Map<string, PaneRun>();

export async function pruneExpiredPaneRuns(now: number): Promise<void> {
  for (const [runId, run] of paneRuns) {
    if (run.expiresAt > now) continue;
    paneRuns.delete(runId);
    await rm(run.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerPaneRun(input: {
  runId: string;
  dir: string;
  owner: string;
  now: number;
}): void {
  paneRuns.set(input.runId, {
    dir: input.dir,
    owner: input.owner,
    expiresAt: input.now + PANE_RUN_TTL_MS,
  });
}

// Owner-scoped screenshot bytes as a PNG data URL. Only names of PNG files inside a registered run directory.
export async function readPaneStayScreenshot(input: {
  runId: string;
  name: string;
  owner: string;
}): Promise<{ status: 'ok'; dataUrl: string } | { status: 'unavailable'; reason: string }> {
  await pruneExpiredPaneRuns(paneStayClock());
  if (!PANE_RUN_ID_PATTERN.test(input.runId) || !PANE_SCREENSHOT_NAME_PATTERN.test(input.name)) {
    return { status: 'unavailable', reason: 'screenshot_request_invalid' };
  }
  const run = paneRuns.get(input.runId);
  if (!run || run.owner !== input.owner) {
    return { status: 'unavailable', reason: 'screenshot_unavailable' };
  }
  try {
    const bytes = await readFile(join(run.dir, input.name));
    return { status: 'ok', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  } catch {
    return { status: 'unavailable', reason: 'screenshot_unavailable' };
  }
}

async function defaultSpawn(input: PaneStaySpawnInput): Promise<PaneStaySpawnResult> {
  const runId = randomUUID();
  const dir = join(tmpdir(), `pane-stay-${runId}`);
  await mkdir(dir, { mode: 0o700 });
  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, JSON.stringify(paneStayRequestBody(input.stay)), { mode: 0o600 });
  const args = [CREATE_LAB_STAY, '--request', requestPath, '--out', dir];
  if (input.stopBefore) args.push('--stop-before', input.stopBefore);
  if (input.paneCommit) args.push('--pane-commit');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('node', args, {
      timeout: 20 * 60_000,
      env: paneStaySpawnEnv(),
    }));
  } finally {
    await rm(requestPath, { force: true });
  }
  const line = stdout.trim().split('\n').at(-1) ?? '';
  const [outcome = '', confirmationNumber = ''] = line.split(/\s+/);
  const screenshots = (await readdir(dir)).filter((name) => PANE_SCREENSHOT_NAME_PATTERN.test(name)).sort();
  return {
    outcome,
    clickedSave: Boolean(input.paneCommit),
    confirmationNumber,
    runId,
    runDir: dir,
    screenshots,
  };
}

// Tenant of the worker's HMS reads (HMS_EXPECTED_TENANT), so save and cancel serialize with them on the
// shared browser. PANE_STAY_TENANT_ID overrides it.
export function paneStayTenantId(env: NodeJS.Dict<string> = process.env): string {
  const configured = [env.PANE_STAY_TENANT_ID, env.HMS_EXPECTED_TENANT].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  return configured ?? 'legacy';
}

// Production lock for the session's hotel. Cancel and save share this key, so they serialize with each other.
export function paneStayPropertyLock(): PaneStayLock | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  return createPostgresPropertyReadLock({
    tenantId: paneStayTenantId(),
    propertyCode: PANE_STAY_PROPERTY_CODE,
    databaseUrl,
  });
}

// An explicit propertyCode must name the session's hotel. Any other value would lock a key the session never
// uses, so the lock could be bypassed. Such requests are refused before any lock or spawn.
export function paneStayPropertyRefusal(propertyCode: string | undefined): string | null {
  return propertyCode === undefined || propertyCode === PANE_STAY_PROPERTY_CODE
    ? null
    : 'pane_save_property_mismatch';
}

// Preview: fill, check availability, screenshots, no save. A successful preview returns previewDigest.
// Commit: needs the previewDigest of a successful preview of this same stay (same owner, within 10 minutes,
// once). The duplicate reader stays fail-closed: while it is parked, commit refuses.
export async function runPaneStay(input: {
  mode: PaneStayMode;
  stay: PaneStay;
  owner: string;
  previewDigest?: string;
}): Promise<PaneStayResult> {
  // Runs that outlived their retention window are removed here too, not only when a screenshot is read.
  await pruneExpiredPaneRuns(paneStayClock());
  const enabled = paneStaySaveLoaders.enabled ?? (() => paneStaySaveEnabled());
  if (!enabled()) {
    return { status: 'refused', reason: 'pane_save_flag_off' };
  }
  try {
    assertLabStayGuard({ lastName: input.stay.lastName, arrival: input.stay.arrival });
  } catch (error) {
    return { status: 'refused', reason: (error as Error).message };
  }
  const propertyRefusal = paneStayPropertyRefusal(input.stay.propertyCode);
  if (propertyRefusal) {
    return { status: 'refused', reason: propertyRefusal };
  }
  const digest = paneStayDigest(input.stay);
  if (input.mode === 'commit') {
    if (!paneStaySaveLoaders.osressGuestDatesSearch) {
      return { status: 'refused', reason: 'osress_reader_parked' };
    }
    if (input.previewDigest === undefined) {
      return { status: 'refused', reason: 'pane_save_preview_required' };
    }
    if (input.previewDigest !== digest) {
      return { status: 'refused', reason: 'pane_save_digest_mismatch' };
    }
  }
  const lock = paneStaySaveLoaders.lock ?? paneStayPropertyLock();
  if (!lock) {
    return { status: 'refused', reason: 'pane_save_lock_unavailable' };
  }
  const reader = input.mode === 'commit' ? paneStaySaveLoaders.osressGuestDatesSearch : null;
  const spawn = paneStaySaveLoaders.spawn ?? defaultSpawn;
  // One lock covers the duplicate read, the grant and the save, so no other run can save this guest between the read
  // and the save. The reader takes no lock of its own: a second acquisition would wait on this one.
  type Gate = { refusal: string } | { spawned: PaneStaySpawnResult };
  let gate: Gate;
  try {
    gate = await lock.withLock(async (): Promise<Gate> => {
      if (reader) {
        const status = await reader({
          lastName: input.stay.lastName,
          arrival: input.stay.arrival,
          departure: input.stay.departure,
        });
        if (status === 'parked') return { refusal: 'osress_reader_parked' };
        if (status === 'busy') return { refusal: 'refused_lock_busy' };
        if (status === 'duplicate') return { refusal: 'osress_duplicate' };
        // The grant is taken under the lock, so two concurrent commits cannot both spawn.
        if (!takePanePreview(input.owner, digest, paneStayClock())) {
          return { refusal: 'pane_save_preview_required' };
        }
      }
      return {
        spawned: await spawn({
          stay: input.stay,
          stopBefore: input.mode === 'preview' ? 'save' : null,
          paneCommit: input.mode === 'commit',
        }),
      };
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { status: 'refused', reason: 'refused_lock_busy' };
    warnPaneStaySpawnFailed('save', error);
    throw error;
  }
  if ('refusal' in gate) return { status: 'refused', reason: gate.refusal };
  const spawned = gate.spawned;
  if (/^refused/i.test(spawned.outcome)) {
    return { status: 'refused', reason: spawned.outcome };
  }
  if (input.mode === 'commit' && UNCONFIRMED_SAVE_OUTCOMES.has(spawned.outcome)) {
    // HMS may have booked the stay. The run stays fetchable, so staff can see what HMS shows.
    if (spawned.runId && spawned.runDir) {
      registerPaneRun({
        runId: spawned.runId,
        dir: spawned.runDir,
        owner: input.owner,
        now: paneStayClock(),
      });
    }
    return {
      status: 'refused',
      reason: PANE_SAVE_UNCONFIRMED,
      runId: spawned.runId,
      screenshots: spawned.screenshots ?? [],
    };
  }
  const previewed = input.mode === 'preview' && spawned.outcome === 'previewed';
  if (previewed) recordPanePreview(input.owner, digest, paneStayClock());
  if (spawned.runId && spawned.runDir) {
    registerPaneRun({
      runId: spawned.runId,
      dir: spawned.runDir,
      owner: input.owner,
      now: paneStayClock(),
    });
  }
  return {
    status: 'ok',
    outcome: spawned.outcome,
    confirmationNumber: spawned.confirmationNumber,
    clickedSave: spawned.clickedSave,
    previewDigest: previewed ? digest : null,
    runId: spawned.runId,
    screenshots: spawned.screenshots ?? [],
  };
}

// PANE_STAY_DUP_CHECK=off keeps the commit duplicate reader parked (commit refused). Any other value runs the check.
export function paneStayDupCheckMode(env: NodeJS.Dict<string> = process.env): 'cli' | 'off' {
  return env.PANE_STAY_DUP_CHECK === 'off' ? 'off' : 'cli';
}

// Wired at module init. runPaneStay calls the reader while it holds the save's property lock, so the reader runs its
// CLI unlocked. A reader that cannot get the lock is reported by the save as refused_lock_busy.
paneStaySaveLoaders.osressGuestDatesSearch =
  paneStayDupCheckMode() === 'cli'
    ? (input) =>
        guestDatesDuplicateCheckViaCli(input)
    : null;
