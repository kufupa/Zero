/**
 * Atomic source + registry compare-and-swap with crash-injection restore.
 * Incomplete restore exits 20 and halts the live lane.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT = 20;

export type SourceRegistryPointers = {
  sourceRevision: string;
  registryPath: string;
  activeSetFingerprint: string;
};

export type SourceRegistryCrashPoint =
  | 'before_source_switch'
  | 'after_source_switch'
  | 'before_registry_rename'
  | 'after_registry_rename'
  | 'before_pm2_restart'
  | 'after_pm2_restart'
  | 'before_health_verdict'
  | 'after_health_verdict';

export type SourceRegistryTransactionHooks = {
  /** Switch active app pointer to candidate source revision. */
  switchSource: (revision: string) => Promise<void>;
  /** Restart HMS worker after pointers land. */
  restartWorker: () => Promise<void>;
  /** Health check returning exact release IDs + active-set fingerprint. */
  verifyHealth: (expected: SourceRegistryPointers) => Promise<void>;
  /** Injected crash for tests — throw to simulate failure at boundary. */
  crashAt?: SourceRegistryCrashPoint | null;
};

export type SourceRegistryTransactionInput = {
  current: SourceRegistryPointers;
  candidate: SourceRegistryPointers;
  /** Absolute path to candidate registry JSON already prevalidated. */
  candidateRegistryFile: string;
  /** Directory holding active registry symlink/file named `active.json`. */
  activeRegistryPath: string;
  /** Backup directory for prior source+registry pair. */
  backupRoot: string;
  hooks: SourceRegistryTransactionHooks;
};

export class IncompleteRestoreError extends Error {
  readonly exitCode = SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT;
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteRestoreError';
  }
}

async function atomicReplace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const temporary = `${to}.${process.pid}.tmp`;
  await copyFile(from, temporary);
  await rename(temporary, to);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function maybeCrash(
  hooks: SourceRegistryTransactionHooks,
  point: SourceRegistryCrashPoint,
): void {
  if (hooks.crashAt === point) {
    throw new Error(`injected crash at ${point}`);
  }
}

/**
 * One promotion/rollback transaction:
 * prevalidate → quiesce (caller) → preserve prior → CAS source+registry →
 * restart → verify. Failure restores both and re-verifies prior IDs.
 */
export async function runSourceRegistryTransaction(
  input: SourceRegistryTransactionInput,
): Promise<{ status: 'applied' | 'restored'; pointers: SourceRegistryPointers }> {
  // Fail-closed: empty/sparse candidates cannot wipe live actives on source cutover.
  const currentActive = await readRegistryActiveMap(input.activeRegistryPath);
  const candidateActive = await readRegistryActiveMap(input.candidateRegistryFile);
  assertCandidatePreservesActiveTools({ currentActive, candidateActive });

  const backupDir = join(
    input.backupRoot,
    `pre-${input.candidate.sourceRevision}-${Date.now()}`,
  );
  await mkdir(backupDir, { recursive: true });
  const backupRegistry = join(backupDir, 'active.json');
  const backupPointers = join(backupDir, 'pointers.json');

  await copyFile(input.activeRegistryPath, backupRegistry);
  await writeJson(backupPointers, input.current);

  let sourceSwitched = false;
  let registrySwitched = false;
  let workerRestarted = false;

  const restore = async (): Promise<SourceRegistryPointers> => {
    let restoreFailed = false;
    try {
      await input.hooks.switchSource(input.current.sourceRevision);
    } catch {
      restoreFailed = true;
    }
    try {
      await atomicReplace(backupRegistry, input.activeRegistryPath);
    } catch {
      restoreFailed = true;
    }
    try {
      await input.hooks.restartWorker();
    } catch {
      restoreFailed = true;
    }
    try {
      await input.hooks.verifyHealth(input.current);
    } catch {
      restoreFailed = true;
    }
    if (restoreFailed) {
      throw new IncompleteRestoreError(
        'incomplete source+registry restore; halt live lane',
      );
    }
    return input.current;
  };

  try {
    maybeCrash(input.hooks, 'before_source_switch');
    await input.hooks.switchSource(input.candidate.sourceRevision);
    sourceSwitched = true;
    maybeCrash(input.hooks, 'after_source_switch');

    maybeCrash(input.hooks, 'before_registry_rename');
    await atomicReplace(input.candidateRegistryFile, input.activeRegistryPath);
    registrySwitched = true;
    maybeCrash(input.hooks, 'after_registry_rename');

    maybeCrash(input.hooks, 'before_pm2_restart');
    await input.hooks.restartWorker();
    workerRestarted = true;
    maybeCrash(input.hooks, 'after_pm2_restart');

    maybeCrash(input.hooks, 'before_health_verdict');
    await input.hooks.verifyHealth(input.candidate);
    maybeCrash(input.hooks, 'after_health_verdict');

    await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    return { status: 'applied', pointers: input.candidate };
  } catch (error) {
    if (error instanceof IncompleteRestoreError) throw error;
    // Any failure after partial progress restores both pointers.
    if (sourceSwitched || registrySwitched || workerRestarted) {
      const restored = await restore();
      return { status: 'restored', pointers: restored };
    }
    // Crash before any switch — still verify prior pair intact.
    await input.hooks.verifyHealth(input.current);
    return { status: 'restored', pointers: input.current };
  }
}

/**
 * Candidate deploy gate: refuse CAS that would drop currently-active tools.
 * Per-tool disable must go through rollback, never an empty/sparse candidate swap.
 */
export function assertCandidatePreservesActiveTools(input: {
  currentActive: Readonly<Record<string, string>>;
  candidateActive: Readonly<Record<string, string>>;
}): void {
  for (const [toolId, releaseId] of Object.entries(input.currentActive)) {
    if (!input.candidateActive[toolId]) {
      throw new Error(
        `candidate deploy would drop active tool ${toolId} (release ${releaseId})`,
      );
    }
  }
}

async function readRegistryActiveMap(
  path: string,
): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      active?: Record<string, unknown>;
    };
    if (!raw.active || typeof raw.active !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [toolId, releaseId] of Object.entries(raw.active)) {
      if (typeof releaseId === 'string' && releaseId.length > 0) {
        out[toolId] = releaseId;
      }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Candidate deploy gate: refuse restart if any active/immediate-predecessor
 * release would become unloadable under the candidate digests.
 */
export function assertCandidateDoesNotOrphanReleases(input: {
  requiredDigests: ReadonlyMap<string, ReadonlySet<string>>; // toolId -> digests
  availableDigests: ReadonlyMap<string, ReadonlySet<string>>;
}): void {
  for (const [toolId, required] of input.requiredDigests) {
    const available = input.availableDigests.get(toolId) ?? new Set();
    for (const digest of required) {
      if (!available.has(digest)) {
        throw new Error(
          `candidate deploy would orphan ${toolId} implementation ${digest}`,
        );
      }
    }
  }
}

export async function readActiveSetFingerprint(
  registryPath: string,
): Promise<string> {
  const raw = JSON.parse(await readFile(registryPath, 'utf8')) as {
    activeSetFingerprint?: string;
  };
  if (
    typeof raw.activeSetFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.activeSetFingerprint)
  ) {
    throw new Error('activeSetFingerprint missing');
  }
  return raw.activeSetFingerprint;
}
