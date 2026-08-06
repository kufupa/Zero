/**
 * CLI entry for atomic source + registry CAS.
 * Invoked by deploy-ec2 / ops-deploy when HMS_REGISTRY_CANDIDATE is set.
 * Incomplete restore → exit 20 (halt live lane).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  IncompleteRestoreError,
  SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT,
  readActiveSetFingerprint,
  runSourceRegistryTransaction,
  type SourceRegistryCrashPoint,
  type SourceRegistryPointers,
} from '../hms/source-registry-transaction.js';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

async function readPointers(path: string): Promise<SourceRegistryPointers> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as SourceRegistryPointers;
  if (
    typeof raw.sourceRevision !== 'string' ||
    typeof raw.registryPath !== 'string' ||
    typeof raw.activeSetFingerprint !== 'string'
  ) {
    throw new Error(`invalid pointers file: ${basename(path)}`);
  }
  return raw;
}

async function main(): Promise<void> {
  const candidateRegistry = requireEnv('HMS_REGISTRY_CANDIDATE');
  const activeRegistryPath =
    process.env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
    '/opt/nava/shared/hms-active-registry/active.json';
  const backupRoot =
    process.env.HMS_REGISTRY_BACKUP_ROOT?.trim() ||
    '/opt/nava/shared/hms-active-registry/backups';
  const currentPointersPath = requireEnv('HMS_SOURCE_REGISTRY_CURRENT');
  const candidatePointersPath = requireEnv('HMS_SOURCE_REGISTRY_CANDIDATE');
  const crashAt = (process.env.HMS_CAS_CRASH_AT?.trim() ||
    null) as SourceRegistryCrashPoint | null;

  const current = await readPointers(currentPointersPath);
  const candidate = await readPointers(candidatePointersPath);

  // Re-bind fingerprint from candidate registry file when omitted/stale.
  if (!candidate.activeSetFingerprint) {
    candidate.activeSetFingerprint =
      await readActiveSetFingerprint(candidateRegistry);
  }

  const switchSourceCmd = process.env.HMS_CAS_SWITCH_SOURCE_CMD?.trim();
  const restartCmd =
    process.env.HMS_CAS_RESTART_WORKER_CMD?.trim() ||
    'pm2 restart hms-ai-worker --update-env';
  const verifyCmd = process.env.HMS_CAS_VERIFY_HEALTH_CMD?.trim();

  const runShell = async (cmd: string): Promise<void> => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('bash', ['-lc', cmd], {
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
  };

  const result = await runSourceRegistryTransaction({
    current,
    candidate,
    candidateRegistryFile: candidateRegistry,
    activeRegistryPath,
    backupRoot,
    hooks: {
      crashAt,
      async switchSource(revision) {
        if (switchSourceCmd) {
          await runShell(
            switchSourceCmd.replaceAll('${SOURCE_REVISION}', revision),
          );
          return;
        }
        // Default: write active source pointer file under releases root.
        const root =
          process.env.HMS_RELEASES_POINTER_PATH?.trim() ||
          '/opt/nava/releases/current-revision';
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdir(dirname(root), { recursive: true });
        await writeFile(root, `${revision}\n`, { mode: 0o644 });
      },
      async restartWorker() {
        await runShell(restartCmd);
      },
      async verifyHealth(expected) {
        if (verifyCmd) {
          await runShell(
            verifyCmd
              .replaceAll('${SOURCE_REVISION}', expected.sourceRevision)
              .replaceAll(
                '${ACTIVE_SET_FINGERPRINT}',
                expected.activeSetFingerprint,
              ),
          );
          return;
        }
        const fp = await readActiveSetFingerprint(activeRegistryPath);
        if (fp !== expected.activeSetFingerprint) {
          throw new Error('activeSetFingerprint mismatch after CAS');
        }
      },
    },
  });

  process.stdout.write(
    `${JSON.stringify({ ok: true, status: result.status, pointers: result.pointers })}\n`,
  );
}

main().catch((error) => {
  if (error instanceof IncompleteRestoreError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT);
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
