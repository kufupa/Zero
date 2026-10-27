import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const deployDir = join(testsDir, '../deploy');
const pruneScript = join(deployDir, 'prune-web-releases.sh');
const archiveScript = join(deployDir, 'archive-hms-evidence.sh');
const deployEc2Script = join(deployDir, 'deploy-ec2.sh');
const temporaryRoots: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-retention-'));
  temporaryRoots.push(root);
  return root;
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o755 });
}

function runScript(
  script: string,
  bin: string,
  args: string[] = [],
  environment: Record<string, string> = {},
) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ':/usr/bin:/bin'}`,
      ...environment,
    },
  });
}

function webFixture(root: string, activeRelease = 'live') {
  const webRoot = join(root, 'web');
  const bin = join(root, 'bin');
  const dump = join(root, 'nginx.dump');
  mkdirSync(join(webRoot, 'releases'), { recursive: true });
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    dump,
    `server {\n  alias ${webRoot}/releases/${activeRelease}/index.html;\n` +
      `  try_files /releases/${activeRelease}$uri /index.html;\n}\n`,
  );
  writeExecutable(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  writeExecutable(
    join(bin, 'nginx'),
    '#!/bin/sh\n[ "${1:-}" = "-T" ] || exit 2\ncat "$NGINX_DUMP_FILE"\n',
  );
  return { webRoot, bin, dump };
}

function addRelease(webRoot: string, id: string, ageDays: number) {
  const release = join(webRoot, 'releases', id);
  mkdirSync(release, { recursive: true });
  const index = join(release, 'index.html');
  writeFileSync(index, 'fixture');
  const mtime = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(index, mtime, mtime);
  utimesSync(release, mtime, mtime);
  return release;
}

function addEvidenceDir(root: string, name: string, ageDays: number, files: string[]) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const mtime = new Date(Date.now() - ageDays * DAY_MS);
  for (const file of files) {
    const path = join(directory, file);
    writeFileSync(path, 'synthetic evidence');
    utimesSync(path, mtime, mtime);
  }
  utimesSync(directory, mtime, mtime);
  return directory;
}

describe('deployment retention scripts', () => {
  it('keeps only the live release, honors dry-run, and leaves shared assets', () => {
    const root = tempRoot();
    const { webRoot, bin, dump } = webFixture(root);
    const live = addRelease(webRoot, 'live', 90);
    const newest = addRelease(webRoot, 'newest', 1);
    const second = addRelease(webRoot, 'second', 2);
    const older = addRelease(webRoot, 'older', 3);
    const oldest = addRelease(webRoot, 'oldest', 4);
    const sharedAsset = join(webRoot, 'assets', 'shared.js');
    writeFileSync(sharedAsset, 'shared');
    const environment = { WEB_ROOT: webRoot, NGINX_DUMP_FILE: dump };

    const dryRun = runScript(pruneScript, bin, ['--dry-run'], environment);
    expect(dryRun.status, dryRun.stderr || dryRun.stdout).toBe(0);
    expect(existsSync(older)).toBe(true);
    expect(existsSync(oldest)).toBe(true);

    const pruned = runScript(pruneScript, bin, [], environment);
    expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(newest)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(sharedAsset)).toBe(true);
  });

  it('refuses multiple live release references before deleting any release', () => {
    const root = tempRoot();
    const { webRoot, bin, dump } = webFixture(root, 'live');
    const live = addRelease(webRoot, 'live', 90);
    const alsoReferenced = addRelease(webRoot, 'also-live', 1);
    const stale = addRelease(webRoot, 'stale', 10);
    writeFileSync(
      dump,
      `server {\n  alias ${webRoot}/releases/live/index.html;\n` +
        '  try_files /releases/live$uri /releases/also-live$uri /index.html;\n}\n',
    );

    const result = runScript(pruneScript, bin, [], {
      WEB_ROOT: webRoot,
      NGINX_DUMP_FILE: dump,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(alsoReferenced)).toBe(true);
    expect(existsSync(stale)).toBe(true);
  });

  it('refuses a symlinked release path before deleting any release', () => {
    const root = tempRoot();
    const { webRoot, bin, dump } = webFixture(root);
    addRelease(webRoot, 'live', 90);
    const old = addRelease(webRoot, 'old', 30);
    const outside = join(root, 'outside-release');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside');
    symlinkSync(outside, join(webRoot, 'releases', 'escape'));

    const result = runScript(pruneScript, bin, [], {
      WEB_ROOT: webRoot,
      NGINX_DUMP_FILE: dump,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('archives stale leaf runs by file age and preserves fresh siblings and parents', () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const evidenceRoot = join(root, 'private', 'playwright-quote');
    const awsCalls = join(root, 'aws.calls');
    mkdirSync(bin, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const matched = addEvidenceDir(evidenceRoot, 'matched-run', 15, ['trace.zip', 'result.json']);
    const mismatch = addEvidenceDir(evidenceRoot, 'mismatch-run', 16, ['trace.zip', 'result.json']);
    const recent = addEvidenceDir(evidenceRoot, 'recent-run', 1, ['trace.zip']);
    const nestedContainer = join(evidenceRoot, 'nested-container');
    mkdirSync(nestedContainer);
    const nestedRun = addEvidenceDir(nestedContainer, 'nested-run', 15, ['trace.zip', 'result.json']);
    const nestedRecent = addEvidenceDir(nestedContainer, 'nested-recent', 1, ['trace.zip']);
    const oldLeafDirectoryMtime = new Date();
    utimesSync(nestedRun, oldLeafDirectoryMtime, oldLeafDirectoryMtime);
    const containerMtime = new Date(Date.now() - 30 * DAY_MS);
    utimesSync(nestedContainer, containerMtime, containerMtime);
    writeExecutable(
      join(bin, 'aws'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf "%s\\n" "$*" >> "$AWS_CALLS_FILE"',
        'if [[ "${4:-}" == sync ]]; then',
        '  [[ " $* " == *" --storage-class STANDARD_IA "* ]]',
        '  exit 0',
        'fi',
        'if [[ "${4:-}" == ls ]]; then',
        '  case "${5:-}" in',
        '    */matched-run/*/) printf "2026-01-01 00:00:00 1 a\\n2026-01-01 00:00:00 1 b\\n" ;;',
        '    */mismatch-run/*/) printf "2026-01-01 00:00:00 1 a\\n" ;;',
        '    */nested-run/*/) printf "2026-01-01 00:00:00 1 a\\n2026-01-01 00:00:00 1 b\\n" ;;',
        '    *) exit 3 ;;',
        '  esac',
        '  exit 0',
        'fi',
        'exit 2',
        '',
      ].join('\n'),
    );

    const environment = {
      EVIDENCE_ROOT: evidenceRoot,
      AWS_CALLS_FILE: awsCalls,
    };
    const result = runScript(archiveScript, bin, [], environment);
    expect(result.status).toBe(1);
    expect(existsSync(matched)).toBe(false);
    expect(existsSync(mismatch)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(nestedRun)).toBe(false);
    expect(existsSync(nestedRecent)).toBe(true);
    expect(existsSync(nestedContainer)).toBe(true);
    const output = result.stdout + result.stderr;
    expect(output).toContain('status=archived');
    expect(output).toContain('status=count_mismatch');
    expect(output).not.toContain('matched-run');
    expect(output).not.toContain('mismatch-run');
    expect(output).not.toContain('recent-run');
    expect(output).not.toContain('nested-run');
    const firstCalls = readFileSync(awsCalls, 'utf8');
    const firstNestedDestination = firstCalls
      .split('\n')
      .find((line) => line.startsWith('--region af-south-1 s3 ls ') && line.includes('/nested-container/nested-run/'))
      ?.split(' ')[4];
    expect(firstNestedDestination).toBeDefined();
    expect(firstCalls).toContain('--storage-class STANDARD_IA');
    expect(firstCalls).toContain(
      's3://nava-zero-mail-845242190536-af-south-1/ops-dumps/hms-evidence/matched-run/',
    );
    expect(firstCalls).not.toContain(`s3 sync ${nestedContainer} `);

    const recreatedRun = addEvidenceDir(nestedContainer, 'nested-run', 16, ['trace.zip', 'result.json']);
    utimesSync(nestedContainer, containerMtime, containerMtime);
    const repeated = runScript(archiveScript, bin, [], environment);
    expect(repeated.status).toBe(1);
    expect(existsSync(recreatedRun)).toBe(false);
    const calls = readFileSync(awsCalls, 'utf8');
    const nestedDestinations = calls
      .split('\n')
      .filter((line) => line.startsWith('--region af-south-1 s3 ls ') && line.includes('/nested-container/nested-run/'))
      .map((line) => line.split(' ')[4] ?? '');
    expect(nestedDestinations).toHaveLength(2);
    expect(new Set(nestedDestinations).size).toBe(2);
    expect(calls).toContain('--region af-south-1');
  });

  it('serializes deploys and prunes after nginx reload and rollback retirement', () => {
    const deploy = readFileSync(deployEc2Script, 'utf8');
    const lockPath = deploy.indexOf('DEPLOY_LOCK=/home/ubuntu/.nava-deploy.lock');
    const lockOpen = deploy.indexOf('exec 9>>"$DEPLOY_LOCK"');
    const lockAcquire = deploy.indexOf('flock -x 9');
    const install = deploy.indexOf('echo "== pnpm install =="');
    const stage = deploy.indexOf('echo "== stage immutable mail release =="');
    const reload = deploy.indexOf('sudo systemctl reload nginx');
    const start = deploy.indexOf('  finalize_nginx_release() {');
    const end = deploy.indexOf('\n  # All handlers exist', start);
    const finalize = deploy.slice(start, end);
    const transactionRetired = finalize.indexOf('NGINX_TRANSACTION_ACTIVE=0');
    const backupCleanup = finalize.indexOf('cleanup_nginx_backup');
    const prune = finalize.indexOf('prune-web-releases.sh');

    expect(lockPath).toBeGreaterThan(-1);
    expect(lockOpen).toBeGreaterThan(lockPath);
    expect(lockAcquire).toBeGreaterThan(lockOpen);
    expect(lockAcquire).toBeLessThan(install);
    expect(lockAcquire).toBeLessThan(stage);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(reload).toBeGreaterThan(-1);
    expect(transactionRetired).toBeGreaterThan(-1);
    expect(backupCleanup).toBeGreaterThan(transactionRetired);
    expect(prune).toBeGreaterThan(backupCleanup);
    expect(deploy.indexOf('prune-web-releases.sh')).toBeGreaterThan(reload);
    expect(deploy.match(/prune-web-releases\.sh/g)).toHaveLength(1);
  });

  it('never prunes all Docker images or runtime dependencies', () => {
    const deploy = readFileSync(deployEc2Script, 'utf8');
    const prune = readFileSync(pruneScript, 'utf8');

    expect(`${deploy}\n${prune}`).not.toMatch(/docker\s+image\s+prune\s+-a\b/);
    expect(prune).not.toMatch(/node_modules|playwright|chromium/i);
  });
});
