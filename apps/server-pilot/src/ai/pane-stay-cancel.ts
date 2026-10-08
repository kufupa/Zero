import { paneStayPropertyLock, paneStaySaveEnabled, type PaneStayLock } from './pane-stay-save.js';
import { mkdtemp, readFile } from 'node:fs/promises';
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
export type PaneStayCancelCommitInput = PaneStayCancelPreviewInput & { reason: string };

export type PaneStayCancelResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  /** Operator-facing line for outcomes that need one (see PANE_CANCEL_MESSAGES), otherwise null. */
  message: string | null;
  /** File names only. The files stay in the CLI run directory. */
  screenshots: string[];
};

// Operator-facing text per outcome. cancel_unconfirmed: the status did not read Cancelled within 60 s after OK, but HMS
// may have applied the cancel, so the operator checks HMS before anything else.
export const PANE_CANCEL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['cancel_unconfirmed', 'HMS may have cancelled this booking. Check HMS before trying again.'],
]);

export function paneCancelMessage(outcome: string): string | null {
  return PANE_CANCEL_MESSAGES.get(outcome) ?? null;
}

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
    message: paneCancelMessage(outcome),
    screenshots: [],
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
  let raw: string;
  try {
    raw = await readFile(join(dir, 'result.json'), 'utf8');
  } catch {
    throw runError ?? new Error('pane_cancel_no_result');
  }
  const result = JSON.parse(raw) as Partial<PaneStayCancelSpawnResult>;
  return {
    outcome: result.outcome ?? 'execution_failure',
    statusBefore: result.statusBefore ?? null,
    statusAfter: result.statusAfter ?? null,
    reasons: result.reasons ?? [],
    penaltyText: result.penaltyText ?? null,
    screenshots: result.screenshots ?? [],
  };
}

async function runPaneStayCancel(
  mode: PaneStayCancelMode,
  input: PaneStayCancelPreviewInput & { reason?: string },
): Promise<PaneStayCancelResult> {
  const enabled = paneStayCancelLoaders.enabled ?? (() => paneStayCancelEnabled());
  if (!enabled()) return refused('refused_flag_off');
  const inputRefusal = checkCancelInput(input);
  if (inputRefusal) return refused(inputRefusal);
  const reason = mode === 'commit' ? (input.reason ?? '').replace(/\s+/g, ' ').trim() : null;
  if (mode === 'commit' && (!reason || reason.startsWith('-')))
    return refused('refused_reason_missing');
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
    const spawned = await lock.withLock(() => spawn(request));
    return {
      outcome: spawned.outcome,
      statusBefore: spawned.statusBefore,
      statusAfter: spawned.statusAfter,
      reasons: spawned.reasons,
      penaltyText: spawned.penaltyText,
      message: paneCancelMessage(spawned.outcome),
      screenshots: spawned.screenshots.map((path) => basename(path)),
    };
  } catch {
    return refused('execution_failure');
  }
}

export function previewCancel(input: PaneStayCancelPreviewInput): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('preview', input);
}

export function commitCancel(input: PaneStayCancelCommitInput): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('commit', input);
}
