import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import {
  PANE_SCREENSHOT_NAME_PATTERN,
  paneStayClock,
  paneStayPropertyLock,
  paneWriteMode,
  pruneExpiredPaneRuns,
  recordPanePreview,
  registerPaneRun,
  takePanePreview,
  type PaneSaveMode,
  type PaneStayLock,
  type PaneWriteMoneyState,
} from './pane-stay-save.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const CANCEL_STAY = fileURLToPath(
  new URL('../../tooling/playwright-quote/cancel-stay.mjs', import.meta.url),
);
const LAB_ARRIVAL_FLOOR = '2027-01-01';
const ALLOW_REAL_GUEST_FLAG = '--allow-real-guest';
const CANCEL_TIMEOUT_MS = 20 * 60_000;

export type PaneStayCancelMode = 'preview' | 'commit';

export type PaneStayCancelPreviewInput = { confirmation: string; arrival: string };
export type PaneStayCancelCommitInput = PaneStayCancelPreviewInput & {
  reason: string;
  /** Digest the preview returned for this same stay. Absent means no preview was run. */
  previewDigest?: string;
};
// Owner scope of runs and grants: `${userId}:${transportId}`, the same string the save path uses.
type OwnedInput<T> = T & { owner: string };

export type PaneStayCancelResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  /** Operator-facing line for outcomes that need one (see PANE_CANCEL_MESSAGES), otherwise null. */
  message: string | null;
  /** The arrival was a hint: HMS holds another date for this booking. Both dates are returned for the pane's text. */
  arrivalMismatch: boolean;
  requestedArrival: string | null;
  hmsArrival: string | null;
  /** PNG file names only. The files stay in the CLI run directory. Fetch the bytes with paneStayCancel.paneStayScreenshot({ runId, name }). */
  screenshots: string[];
  /** Screenshot directory id for paneStayScreenshot. Null when no CLI run wrote files. */
  runId: string | null;
  /** Set only when a preview finished as preview_ok. Commit sends it back with the same stay. */
  previewDigest: string | null;
};

// Operator-facing text per outcome. cancel_unconfirmed: the status did not read Cancelled within 60 s after OK, but HMS
// may have applied the cancel, so the operator checks HMS before anything else.
// cancel_penalty_pending: a charge opened after the OK. It is needs check, so the operator reads the charge in HMS first.
export const PANE_CANCEL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['cancel_unconfirmed', 'HMS may have cancelled this booking. Check HMS before trying again.'],
  [
    'cancel_penalty_pending',
    'A cancellation penalty is pending on this booking. Check HMS before anything else.',
  ],
]);

export function paneCancelMessage(outcome: string): string | null {
  return PANE_CANCEL_MESSAGES.get(outcome) ?? null;
}

export type PaneStayCancelSpawnInput = {
  mode: PaneStayCancelMode;
  confirmation: string;
  arrival: string;
  reason: string | null;
  /** True only in on mode. The CLI then drops the Labtest guard for this run. */
  allowRealGuest: boolean;
  /**
   * Commit only: the stay the write's approval was checked against. The CLI reads the record it opens again and refuses
   * (refused_stay_changed, nothing clicked) when any of these fields differ.
   */
  expectStay?: Record<string, unknown>;
};

/** The expected-stay file a commit run reads, inside its own output directory. */
const EXPECT_STAY_FILE = 'expect-stay.json';

/** What one cancel-stay.mjs run reports in its result.json. Screenshots are absolute paths. */
export type PaneStayCancelSpawnResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  arrivalMismatch?: boolean;
  requestedArrival?: string | null;
  hmsArrival?: string | null;
  screenshots: string[];
  /** Absolute directory the CLI wrote result.json and the PNGs to. Absent when no run wrote files. */
  runDir?: string;
  /** True once the reason dialog's OK was clicked. A failure after that leaves the cancel unconfirmed. */
  clickedOk?: boolean;
};

export const paneStayCancelLoaders: {
  spawn: ((input: PaneStayCancelSpawnInput) => Promise<PaneStayCancelSpawnResult>) | null;
  lock: PaneStayLock | null;
  mode: (() => PaneSaveMode) | null;
  moneyState: (() => PaneWriteMoneyState) | null;
} = {
  spawn: null,
  lock: null,
  mode: null,
  moneyState: null,
};

// Cancel uses PANE_WRITE_CANCEL_*; create mode never enables it. Legacy SAVE still opens cancel when all five are unset.
export function paneStayCancelEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (
    paneWriteMode('cancel', 'unpaid', env) !== 'off' || paneWriteMode('cancel', 'paid', env) !== 'off'
  );
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Server-side input checks. The cancel input has no guest name, so in lab mode the Labtest identity is enforced by the
// CLI on the stay it opens (refused_not_lab). The 2027 floor is enforced here, before any browser work. On mode
// (allowRealGuest) real guests are allowed, so the floor does not apply.
export function checkCancelInput(
  input: PaneStayCancelPreviewInput,
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): 'refused_input_invalid' | 'refused_not_lab' | null {
  if (!/^\d+-\d+$/.test(input.confirmation) || !isRealIsoDate(input.arrival)) {
    return 'refused_input_invalid';
  }
  if (!allowRealGuest && input.arrival < LAB_ARRIVAL_FLOOR) return 'refused_not_lab';
  return null;
}

// sha256 of the stay as canonical JSON, keys in fixed order: {"arrival":...,"confirmation":...}.
// A commit must send back the digest of its own confirmation and arrival.
export function paneCancelDigest(stay: PaneStayCancelPreviewInput): string {
  const canonical = JSON.stringify({ arrival: stay.arrival, confirmation: stay.confirmation });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildCancelStayArgs(input: PaneStayCancelSpawnInput, outDir: string): string[] {
  const args = [
    CANCEL_STAY,
    '--confirmation',
    input.confirmation,
    '--arrival',
    input.arrival,
    '--mode',
    input.mode,
    '--out',
    outDir,
  ];
  if (input.mode === 'commit' && input.reason) args.push('--reason', input.reason);
  if (input.mode === 'commit' && input.expectStay) args.push('--expect-stay', join(outDir, EXPECT_STAY_FILE));
  // Only an on-mode run passes the switch. Nothing else in the environment can lift the lab guard.
  if (input.allowRealGuest) args.push(ALLOW_REAL_GUEST_FLAG);
  return args;
}

function refused(outcome: string): PaneStayCancelResult {
  return {
    outcome,
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    penaltyText: null,
    message: paneCancelMessage(outcome),
    arrivalMismatch: false,
    requestedArrival: null,
    hmsArrival: null,
    screenshots: [],
    runId: null,
    previewDigest: null,
  };
}

export async function spawnPaneStayCancel(input: PaneStayCancelSpawnInput): Promise<PaneStayCancelSpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-cancel-'));
  let runError: unknown = null;
  try {
    if (input.mode === 'commit' && input.expectStay) {
      await writeFile(join(dir, EXPECT_STAY_FILE), JSON.stringify(input.expectStay), { mode: 0o600 });
    }
    await execFileAsync('node', buildCancelStayArgs(input, dir), {
      timeout: CANCEL_TIMEOUT_MS,
      env: paneStaySpawnEnv(),
    });
  } catch (error) {
    // The CLI exits 1 or 2 on failures and refusals but still writes result.json. Read that first.
    runError = error;
  }
  let result: Partial<PaneStayCancelSpawnResult>;
  try {
    result = JSON.parse(
      await readFile(join(dir, 'result.json'), 'utf8'),
    ) as Partial<PaneStayCancelSpawnResult>;
  } catch {
    // No result means no run to show, so the directory and any screenshots in it are removed now.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw runError ?? new Error('pane_cancel_no_result');
  }
  // A failed CLI run writes result.json and does not throw, so it is logged here, as the lookup spawner does.
  if ((result.outcome ?? 'execution_failure') === 'execution_failure') {
    const cliError = (result as { error?: string }).error ?? 'pane_cancel_execution_failure';
    warnPaneStaySpawnFailed(input.mode, new Error(cliError));
  }
  return {
    outcome: result.outcome ?? 'execution_failure',
    statusBefore: result.statusBefore ?? null,
    statusAfter: result.statusAfter ?? null,
    reasons: result.reasons ?? [],
    penaltyText: result.penaltyText ?? null,
    arrivalMismatch: result.arrivalMismatch,
    requestedArrival: result.requestedArrival,
    hmsArrival: result.hmsArrival,
    screenshots: result.screenshots ?? [],
    runDir: dir,
    clickedOk: result.clickedOk === true,
  };
}

async function runPaneStayCancel(
  mode: PaneStayCancelMode,
  input: OwnedInput<PaneStayCancelPreviewInput & { reason?: string; previewDigest?: string }>,
): Promise<PaneStayCancelResult> {
  // Unknown money uses the paid switch (fail closed). Prod preview/commit never inject a money
  // state, so --allow-real-guest waits until money is resolved and that mode is on.
  const injectedMode = paneStayCancelLoaders.mode?.();
  const moneyState = paneStayCancelLoaders.moneyState?.() ?? 'unknown';
  const saveMode = injectedMode ?? paneWriteMode('cancel', moneyState);
  if (saveMode === 'off') return refused('refused_flag_off');
  const moneyResolved = injectedMode != null || moneyState === 'unpaid' || moneyState === 'paid';
  const allowRealGuest = moneyResolved && saveMode === 'on';
  const inputRefusal = checkCancelInput(input, { allowRealGuest });
  if (inputRefusal) return refused(inputRefusal);
  const reason = mode === 'commit' ? (input.reason ?? '').replace(/\s+/g, ' ').trim() : null;
  if (mode === 'commit' && (!reason || reason.startsWith('-')))
    return refused('refused_reason_missing');
  // A commit needs the grant of a preview of this same stay. Both checks run before the lock and the browser.
  const digest = paneCancelDigest(input);
  if (mode === 'commit') {
    if (input.previewDigest === undefined) return refused('cancel_preview_required');
    if (input.previewDigest !== digest) return refused('cancel_digest_mismatch');
  }
  // The lock key is the session hotel. The input carries no propertyCode, so no caller can change the key.
  const lock = paneStayCancelLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return refused('refused_lock_unavailable');
  const spawn = paneStayCancelLoaders.spawn ?? spawnPaneStayCancel;
  const request: PaneStayCancelSpawnInput = {
    mode,
    confirmation: input.confirmation,
    arrival: input.arrival,
    reason,
    allowRealGuest,
  };
  try {
    await pruneExpiredPaneRuns(paneStayClock());
    const spawned = await lock.withLock(
      async () => {
        // The grant is taken under the lock, so two concurrent commits cannot both spawn.
        if (mode === 'commit' && !takePanePreview(input.owner, digest, paneStayClock())) return null;
        return spawn(request);
      },
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
    if (spawned === null) return refused('cancel_preview_required');
    // HMS refused the reason before it clicked cancel, so nothing was cancelled: the grant stays usable for another reason.
    if (mode === 'commit' && spawned.outcome === 'refused_reason_missing') {
      recordPanePreview(input.owner, digest, paneStayClock());
    }
    let runId: string | null = null;
    if (spawned.runDir) {
      runId = randomUUID();
      registerPaneRun({ runId, dir: spawned.runDir, owner: input.owner, now: paneStayClock() });
    }
    // Only a preview that finished as preview_ok grants a commit. already_cancelled grants nothing.
    const previewDigest = mode === 'preview' && spawned.outcome === 'preview_ok' ? digest : null;
    if (previewDigest) recordPanePreview(input.owner, previewDigest, paneStayClock());
    return {
      outcome: spawned.outcome,
      statusBefore: spawned.statusBefore,
      statusAfter: spawned.statusAfter,
      reasons: spawned.reasons,
      penaltyText: spawned.penaltyText,
      message: paneCancelMessage(spawned.outcome),
      arrivalMismatch: spawned.arrivalMismatch === true,
      requestedArrival: spawned.requestedArrival ?? input.arrival ?? null,
      hmsArrival: spawned.hmsArrival ?? null,
      screenshots: spawned.screenshots
        .map((path) => basename(path))
        .filter((name) => PANE_SCREENSHOT_NAME_PATTERN.test(name)),
      runId,
      previewDigest,
    };
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return refused('refused_lock_busy');
    warnPaneStaySpawnFailed('cancel', error);
    return refused('execution_failure');
  }
}

export function previewCancel(
  input: OwnedInput<PaneStayCancelPreviewInput>,
): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('preview', input);
}

export function commitCancel(
  input: OwnedInput<PaneStayCancelCommitInput>,
): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('commit', input);
}
