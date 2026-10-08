import {
  PANE_SCREENSHOT_NAME_PATTERN,
  paneStayClock,
  paneStayPropertyLock,
  paneStaySaveEnabled,
  pruneExpiredPaneRuns,
  recordPanePreview,
  registerPaneRun,
  takePanePreview,
  type PaneStayLock,
} from './pane-stay-save.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const CANCEL_STAY = fileURLToPath(
  new URL('../../tooling/playwright-quote/cancel-stay.mjs', import.meta.url),
);
const LAB_ARRIVAL_FLOOR = '2027-01-01';
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
  /** PNG file names only. Fetch the bytes with paneStayCancel.paneStayScreenshot({ runId, name }). */
  screenshots: string[];
  /** Screenshot directory id for paneStayScreenshot. Null when no CLI run wrote files. */
  runId: string | null;
  /** Set only when a preview finished as preview_ok. Commit sends it back with the same stay. */
  previewDigest: string | null;
};

export type PaneStayCancelSpawnInput = {
  mode: PaneStayCancelMode;
  confirmation: string;
  arrival: string;
  reason: string | null;
};

/** What one cancel-stay.mjs run reports in its result.json. Screenshots are absolute paths. */
export type PaneStayCancelSpawnResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  screenshots: string[];
  /** Absolute directory the CLI wrote result.json and the PNGs to. Absent when no run wrote files. */
  runDir?: string;
};

export const paneStayCancelLoaders: {
  spawn: ((input: PaneStayCancelSpawnInput) => Promise<PaneStayCancelSpawnResult>) | null;
  lock: PaneStayLock | null;
  enabled: (() => boolean) | null;
} = {
  spawn: null,
  lock: null,
  enabled: null,
};

// Same gate as the save path: RESERVATIONIST_PANE_SAVE=on.
export function paneStayCancelEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return paneStaySaveEnabled(env);
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Server-side input checks. The cancel input has no guest name, so the Labtest identity is enforced by the
// CLI on the stay it opens (refused_not_lab). The 2027 floor is enforced here, before any browser work.
export function checkCancelInput(
  input: PaneStayCancelPreviewInput,
): 'refused_input_invalid' | 'refused_not_lab' | null {
  if (!/^\d+-\d+$/.test(input.confirmation) || !isRealIsoDate(input.arrival)) {
    return 'refused_input_invalid';
  }
  if (input.arrival < LAB_ARRIVAL_FLOOR) return 'refused_not_lab';
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
  return args;
}

function refused(outcome: string): PaneStayCancelResult {
  return {
    outcome,
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    penaltyText: null,
    screenshots: [],
    runId: null,
    previewDigest: null,
  };
}

async function defaultSpawn(input: PaneStayCancelSpawnInput): Promise<PaneStayCancelSpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-cancel-'));
  let runError: unknown = null;
  try {
    await execFileAsync('node', buildCancelStayArgs(input, dir), {
      timeout: CANCEL_TIMEOUT_MS,
      env: { ...process.env },
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
  return {
    outcome: result.outcome ?? 'execution_failure',
    statusBefore: result.statusBefore ?? null,
    statusAfter: result.statusAfter ?? null,
    reasons: result.reasons ?? [],
    penaltyText: result.penaltyText ?? null,
    screenshots: result.screenshots ?? [],
    runDir: dir,
  };
}

async function runPaneStayCancel(
  mode: PaneStayCancelMode,
  input: OwnedInput<PaneStayCancelPreviewInput & { reason?: string; previewDigest?: string }>,
): Promise<PaneStayCancelResult> {
  const enabled = paneStayCancelLoaders.enabled ?? (() => paneStayCancelEnabled());
  if (!enabled()) return refused('refused_flag_off');
  const inputRefusal = checkCancelInput(input);
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
  const spawn = paneStayCancelLoaders.spawn ?? defaultSpawn;
  const request: PaneStayCancelSpawnInput = {
    mode,
    confirmation: input.confirmation,
    arrival: input.arrival,
    reason,
  };
  try {
    await pruneExpiredPaneRuns(paneStayClock());
    const spawned = await lock.withLock(async () => {
      // The grant is taken under the lock, so two concurrent commits cannot both spawn.
      if (mode === 'commit' && !takePanePreview(input.owner, digest, paneStayClock())) return null;
      return spawn(request);
    });
    if (spawned === null) return refused('cancel_preview_required');
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
      screenshots: spawned.screenshots
        .map((path) => basename(path))
        .filter((name) => PANE_SCREENSHOT_NAME_PATTERN.test(name)),
      runId,
      previewDigest,
    };
  } catch {
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
