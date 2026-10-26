import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { hmsDavinciCreateMode } from '../env.js';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  hmsReadTargetForTransport,
  type HmsReadTarget,
} from '../hms/hms-read-target.js';
import { getPropertyRegistration, resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { profileFor, stayBookFieldRefusal } from '../../tooling/playwright-quote/property-profile.mjs';
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
// Compatibility name for the registered Centurion property code; target selection requires a mailbox or explicit code.
export const PANE_STAY_PROPERTY_CODE = CENTURION_HMS_READ_TARGET.propertyCode;
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
// HMS field limits: the maxlength of the live New Record inputs (fixtures/stay-lookup/record-form-live.html).
// create-tool.schema.json carries the same numbers, and a test keeps the two equal.
export const PANE_RESERVATION_NOTE_MAX = 2000; // reservationnote (textarea)
export const PANE_PARTY_NAME_MAX = 100; // ta1 Primary Booking Agency, company Organization
export const PANE_PARTY_NATIVE_ID_MAX = 40;
export const PANE_BOOKER_NAME_MAX = 50; // caller
export const PANE_BOOKER_EMAIL_MAX = 80; // udfchar06 Booker Contact
export const PANE_MARKET_SEGMENT_MAX = 80; // marketsegment

/** A party as the pane sends it. The runner types name into the lookup. nativeId is carried, not selected by. */
export type PaneStayParty = { nativeId?: string; name: string };

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
  bookingAgency?: PaneStayParty;
  organization?: PaneStayParty;
  reservationNote?: string;
  bookerName?: string;
  bookerEmail?: string;
  marketSegment?: string;
  guestoptin4?: boolean;
};

export type PaneStayMode = 'preview' | 'commit';

/** off: copy-only. lab: saves Labtest stays arriving 2027 or later. on: saves real guests. */
export type PaneSaveMode = 'off' | 'lab' | 'on';

export type PaneWriteWorkflow = 'create' | 'amend' | 'cancel';
/** unknown and paid both use the *_PAID switch (KTD2). */
export type PaneWriteMoneyState = 'unpaid' | 'paid' | 'unknown';

export type PaneWriteModes = {
  create: PaneSaveMode;
  amendUnpaid: PaneSaveMode;
  amendPaid: PaneSaveMode;
  cancelUnpaid: PaneSaveMode;
  cancelPaid: PaneSaveMode;
};

export const PANE_WRITE_CREATE = 'PANE_WRITE_CREATE';
export const PANE_WRITE_AMEND_UNPAID = 'PANE_WRITE_AMEND_UNPAID';
export const PANE_WRITE_AMEND_PAID = 'PANE_WRITE_AMEND_PAID';
export const PANE_WRITE_CANCEL_UNPAID = 'PANE_WRITE_CANCEL_UNPAID';
export const PANE_WRITE_CANCEL_PAID = 'PANE_WRITE_CANCEL_PAID';
export const PANE_WRITE_ATTACH = 'PANE_WRITE_ATTACH';

export const PANE_WRITE_ENV_NAMES = [
  PANE_WRITE_CREATE,
  PANE_WRITE_AMEND_UNPAID,
  PANE_WRITE_AMEND_PAID,
  PANE_WRITE_CANCEL_UNPAID,
  PANE_WRITE_CANCEL_PAID,
] as const;

const PANE_WRITE_OFF: PaneWriteModes = {
  create: 'off',
  amendUnpaid: 'off',
  amendPaid: 'off',
  cancelUnpaid: 'off',
  cancelPaid: 'off',
};

export function parseLabOn(value: string | undefined): PaneSaveMode {
  return value === 'lab' || value === 'on' ? value : 'off';
}

function anyPaneWriteEnvSet(env: NodeJS.Dict<string>): boolean {
  return PANE_WRITE_ENV_NAMES.some((name) => env[name] !== undefined);
}

function parsePaidWriteFlag(name: string, value: string | undefined): PaneSaveMode {
  const mode = parseLabOn(value);
  if (mode === 'on') {
    console.warn('pane_write_paid_on_ignored', { env: name });
    return 'off';
  }
  return mode;
}

/** busy: the check could not get the property lock within the pane wait, so nothing was checked. */
export type OsressDuplicateStatus = 'parked' | 'clear' | 'duplicate' | 'busy';

export type PaneStaySpawnInput = {
  stay: PaneStay;
  stopBefore: 'save' | null;
  paneCommit: boolean;
  /** Resolved HMS property/secret/slot. Da Vinci uses the HRDAV CDP and secret. */
  target?: HmsReadTarget;
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
        target?: HmsReadTarget;
      }) => Promise<OsressDuplicateStatus>)
    | null;
  mode: (() => PaneSaveMode) | null;
  now: (() => number) | null;
} = {
  spawn: null,
  lock: null,
  osressGuestDatesSearch: null,
  mode: null,
  now: null,
};

// Shared with the cancel path, so tests drive one clock for both.
export function paneStayClock(): number {
  return paneStaySaveLoaders.now?.() ?? Date.now();
}

/**
 * Per-workflow write switch (KTD1). Legacy RESERVATIONIST_PANE_SAVE is used only when all five
 * PANE_WRITE_* envs are unset. Once any new flag is set, an unset or invalid sibling is off.
 * Paid flags accept only off|lab; on is treated as off and logged. Create ignores moneyState.
 */
export function paneWriteMode(
  workflow: PaneWriteWorkflow,
  moneyState: PaneWriteMoneyState = 'unknown',
  env: NodeJS.Dict<string> = process.env,
): PaneSaveMode {
  return paneWriteModes(env)[writeModeKey(workflow, moneyState)];
}

export function paneWriteModes(env: NodeJS.Dict<string> = process.env): PaneWriteModes {
  if (anyPaneWriteEnvSet(env)) {
    return {
      create: parseLabOn(env[PANE_WRITE_CREATE]),
      amendUnpaid: parseLabOn(env[PANE_WRITE_AMEND_UNPAID]),
      amendPaid: parsePaidWriteFlag(PANE_WRITE_AMEND_PAID, env[PANE_WRITE_AMEND_PAID]),
      cancelUnpaid: parseLabOn(env[PANE_WRITE_CANCEL_UNPAID]),
      cancelPaid: parsePaidWriteFlag(PANE_WRITE_CANCEL_PAID, env[PANE_WRITE_CANCEL_PAID]),
    };
  }
  const legacy = parseLabOn(env.RESERVATIONIST_PANE_SAVE);
  if (legacy === 'off') return PANE_WRITE_OFF;
  return {
    create: legacy,
    // Amend stayed Labtest-only on SAVE=lab; SAVE=on never opened it.
    amendUnpaid: legacy === 'lab' ? 'lab' : 'off',
    amendPaid: legacy === 'lab' ? 'lab' : 'off',
    cancelUnpaid: legacy,
    cancelPaid: legacy === 'on' ? 'off' : legacy,
  };
}

function writeModeKey(
  workflow: PaneWriteWorkflow,
  moneyState: PaneWriteMoneyState,
): keyof PaneWriteModes {
  if (workflow === 'create') return 'create';
  const paid = moneyState !== 'unpaid';
  if (workflow === 'amend') return paid ? 'amendPaid' : 'amendUnpaid';
  return paid ? 'cancelPaid' : 'cancelUnpaid';
}

/** Alias of create mode. Keep the name: Outlook pane and webmail both call it. */
export function paneStaySaveMode(env: NodeJS.Dict<string> = process.env): PaneSaveMode {
  return paneWriteMode('create', 'unpaid', env);
}

// The save path is open in lab and on. Cancel uses its own PANE_WRITE_CANCEL_* switch.
export function paneStaySaveEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return paneStaySaveMode(env) !== 'off';
}

export function paneStayRequestBody(stay: PaneStay): Omit<PaneStay, 'propertyCode'> {
  const { propertyCode: _ignored, ...request } = stay;
  return request;
}

/** owner is `${userId}:${transportId}` on the live quoteWorkflow routes. */
export function paneStayTransportIdFromOwner(owner: string): string | undefined {
  const sep = owner.indexOf(':');
  if (sep < 0) return undefined;
  const transportId = owner.slice(sep + 1).trim();
  return transportId || undefined;
}

/**
 * A registered mailbox transport (or explicit property code) picks the HMS slot. No mailbox/property means refuse.
 * Da Vinci needs HMS_DAVINCI_CREATE=lab|on.
 */
export function paneStayCreateTarget(input: {
  transportId?: string;
  propertyCode?: string;
  env?: NodeJS.Dict<string>;
}): { ok: true; target: HmsReadTarget } | { ok: false; reason: string } {
  const env = input.env ?? process.env;
  let target: HmsReadTarget;
  if (input.transportId !== undefined) {
    const resolved = resolvePropertyTransport(input.transportId);
    if (resolved.kind === 'refusal') return { ok: false, reason: resolved.code };
    if (resolved.kind === 'collector') return { ok: false, reason: 'collector_no_hotel' };
    target = hmsReadTargetForTransport(input.transportId);
    if (input.propertyCode !== undefined && input.propertyCode !== target.propertyCode) {
      return { ok: false, reason: 'pane_save_property_mismatch' };
    }
  } else {
    if (!input.propertyCode) return { ok: false, reason: 'property_required' };
    const property = getPropertyRegistration(input.propertyCode);
    if (!property) return { ok: false, reason: 'property_unknown' };
    if (!property.active) return { ok: false, reason: 'property_inactive' };
    target = hmsReadTargetForTransport(property.mailboxTransportId);
  }
  if (target.browserSlot === 'davinci' && hmsDavinciCreateMode(env) === 'off') {
    return { ok: false, reason: 'pane_save_property_mismatch' };
  }
  return { ok: true, target };
}

/** Every target passes `--property`. The create CLI refuses an omitted code. */
export function paneStayCreatePropertyArgs(target?: HmsReadTarget | null): string[] {
  const code = typeof target?.propertyCode === 'string' ? target.propertyCode.trim() : '';
  return code ? ['--property', code] : [];
}

/** CDP + secret for create-lab-stay. HRDAV never inherits the Centurion slot. */
export function paneStayCreateSpawnEnv(
  target: HmsReadTarget,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return paneStaySpawnEnv(env, undefined, target);
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

// Refusals decided before the lock, in order: the mode, adults ≥1, children (copy-only for now), then the
// Labtest guard in lab mode.
export function paneStayModeRefusal(mode: PaneSaveMode, stay: PaneStay): string | null {
  if (mode === 'off') return 'pane_save_flag_off';
  if (!Number.isInteger(stay.adults) || stay.adults < 1) return 'pane_save_adults_required';
  if (stay.childAges?.length) return 'pane_save_children_unsupported';
  if (mode === 'lab') {
    try {
      assertLabStayGuard({ lastName: stay.lastName, arrival: stay.arrival });
    } catch (error) {
      return (error as Error).message;
    }
  }
  return null;
}

// Canonical form: strings trimmed, undefined and blank strings dropped, keys sorted at every level (so a party
// object's key order does not change the digest). Equal stays give equal digests.
function canonicalValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined && !(typeof item === 'string' && item.trim() === ''))
      .map(([key, item]) => [key, canonicalValue(item)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

function canonicalStay(stay: PaneStay): string {
  return JSON.stringify(canonicalValue(stay));
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
  if (!input.target) throw new Error('pane_stay_target_required');
  const target = input.target;
  const runId = randomUUID();
  const dir = join(tmpdir(), `pane-stay-${runId}`);
  await mkdir(dir, { mode: 0o700 });
  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, JSON.stringify(paneStayRequestBody(input.stay)), { mode: 0o600 });
  const args = [
    CREATE_LAB_STAY,
    '--request',
    requestPath,
    '--out',
    dir,
    ...paneStayCreatePropertyArgs(target),
  ];
  if (input.stopBefore) args.push('--stop-before', input.stopBefore);
  if (input.paneCommit) args.push('--pane-commit');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('node', args, {
      timeout: 20 * 60_000,
      env: paneStayCreateSpawnEnv(target),
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

// Production lock. The target is required: no HRCEN default, so a missing hotel cannot share Centurion's key.
export function paneStayPropertyLock(target: HmsReadTarget): PaneStayLock | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const code = target.propertyCode.trim();
  if (!code) return null;
  return createPostgresPropertyReadLock({
    tenantId: paneStayTenantId(),
    propertyCode: code,
    databaseUrl,
  });
}

// An explicit propertyCode must name the session's hotel. Any other value would lock a key the session never
// uses, so the lock could be bypassed. Such requests are refused before any lock or spawn.
export function paneStayPropertyRefusal(
  propertyCode: string | undefined,
  env: NodeJS.Dict<string> = process.env,
): string | null {
  if (propertyCode === undefined || propertyCode === PANE_STAY_PROPERTY_CODE) return null;
  if (propertyCode === DAVINCI_HMS_READ_TARGET.propertyCode) {
    return hmsDavinciCreateMode(env) === 'off' ? 'pane_save_property_mismatch' : null;
  }
  return 'pane_save_property_mismatch';
}

// Preview: fill, check availability, screenshots, no save. A successful preview returns previewDigest.
// Commit: needs the previewDigest of a successful preview of this same stay (same owner, within 10 minutes,
// once). The duplicate reader stays fail-closed: while it is parked, commit refuses.
export async function runPaneStay(input: {
  mode: PaneStayMode;
  stay: PaneStay;
  owner: string;
  previewDigest?: string;
  transportId?: string;
}): Promise<PaneStayResult> {
  // Runs that outlived their retention window are removed here too, not only when a screenshot is read.
  await pruneExpiredPaneRuns(paneStayClock());
  const mode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
  const modeRefusal = paneStayModeRefusal(mode, input.stay);
  if (modeRefusal) {
    return { status: 'refused', reason: modeRefusal };
  }
  const resolved = paneStayCreateTarget({
    transportId: input.transportId ?? paneStayTransportIdFromOwner(input.owner),
    propertyCode: input.stay.propertyCode,
  });
  if (!resolved.ok) {
    return { status: 'refused', reason: resolved.reason };
  }
  const target = resolved.target;
  if (target.browserSlot === 'davinci' && hmsDavinciCreateMode() === 'lab') {
    try {
      assertLabStayGuard({ lastName: input.stay.lastName, arrival: input.stay.arrival });
    } catch (error) {
      return { status: 'refused', reason: (error as Error).message };
    }
  }
  const bookRefusal = stayBookFieldRefusal(input.stay, profileFor(target.propertyCode));
  if (bookRefusal) {
    return { status: 'refused', reason: bookRefusal };
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
  const lock = paneStaySaveLoaders.lock ?? paneStayPropertyLock(target);
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
          target,
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
          target,
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
    ? (input) => guestDatesDuplicateCheckViaCli(input, input.target ?? null)
    : null;
