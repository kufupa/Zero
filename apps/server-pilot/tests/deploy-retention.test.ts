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
  it('keeps the live release and two newest others, honors dry-run, and leaves shared assets', () => {
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
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(sharedAsset)).toBe(true);
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

  it('deletes evidence only when S3 object count matches and skips recent evidence', () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const evidenceRoot = join(root, 'private', 'playwright-quote');
    const awsCalls = join(root, 'aws.calls');
    mkdirSync(bin, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const matched = addEvidenceDir(evidenceRoot, 'matched-run', 15, ['trace.zip', 'result.json']);
    const mismatch = addEvidenceDir(evidenceRoot, 'mismatch-run', 16, ['trace.zip', 'result.json']);
    const recent = addEvidenceDir(evidenceRoot, 'recent-run', 1, ['trace.zip']);
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
        '    */matched-run/) printf "2026-01-01 00:00:00 1 a\\n2026-01-01 00:00:00 1 b\\n" ;;',
        '    */mismatch-run/) printf "2026-01-01 00:00:00 1 a\\n" ;;',
        '    *) exit 3 ;;',
        '  esac',
        '  exit 0',
        'fi',
        'exit 2',
        '',
      ].join('\n'),
    );

    const result = runScript(archiveScript, bin, [], {
      EVIDENCE_ROOT: evidenceRoot,
      AWS_CALLS_FILE: awsCalls,
    });
    expect(result.status).toBe(1);
    expect(existsSync(matched)).toBe(false);
    expect(existsSync(mismatch)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    const output = result.stdout + result.stderr;
    expect(output).toContain('status=archived');
    expect(output).toContain('status=count_mismatch');
    expect(output).not.toContain('matched-run');
    expect(output).not.toContain('mismatch-run');
    expect(output).not.toContain('recent-run');
    const calls = readFileSync(awsCalls, 'utf8');
    expect(calls).toContain('--region af-south-1');
    expect(calls).toContain('--storage-class STANDARD_IA');
    expect(calls).toContain(
      's3://nava-zero-mail-845242190536-af-south-1/ops-dumps/hms-evidence/matched-run/',
    );
  });

  it('runs web-release pruning after nginx reload in deploy activation', () => {
    const deploy = readFileSync(deployEc2Script, 'utf8');
    const start = deploy.indexOf('  activate_nginx() {');
    const end = deploy.indexOf('\n  finalize_nginx_release()', start);
    const activation = deploy.slice(start, end);
    const reload = activation.indexOf('sudo systemctl reload nginx');
    const prune = activation.indexOf('prune-web-releases.sh');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(reload).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(reload);
    expect(deploy.match(/prune-web-releases\.sh/g)).toHaveLength(1);
  });
});
