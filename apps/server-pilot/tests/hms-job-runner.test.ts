import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const jobScript = join(here, '..', 'deploy', 'hms-job.sh');
const opsScript = join(here, '..', 'deploy', 'ops-deploy.sh');

const harnesses: string[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const root = harnesses.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'hms-job-runner-'));
  harnesses.push(root);
  const bin = join(root, 'bin');
  const logRoot = join(root, 'hms-jobs');
  const server = join(root, 'server-pilot');
  mkdirSync(bin);
  mkdirSync(logRoot);
  mkdirSync(join(server, 'src', 'ops'), { recursive: true });
  writeFileSync(join(server, 'src', 'ops', 'hms-proof-run.ts'), '// U0 stub path\n');
  writeFileSync(join(root, 'args.json'), '{"mode":"preview"}\n');

  writeFileSync(
    join(bin, 'systemd-run'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'unit=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --unit) unit="$2"; shift 2 ;;',
      '    --uid|--gid|-p|-E|--working-directory) shift 2 ;;',
      '    --quiet) shift ;;',
      '    *) break ;;',
      '  esac',
      'done',
      'id="${unit#hms-job-}"',
      'printf "%s\\n" "$unit" >> "$HMS_JOB_STUB_UNITS"',
      'nohup "$@" </dev/null >/dev/null 2>&1 &',
      'echo $! > "$HMS_JOB_LOG_ROOT/$id/pid"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'systemd-run'), 0o755);

  writeFileSync(
    join(bin, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  show)',
      '    prop=""; unit=""',
      '    while [ $# -gt 0 ]; do',
      '      case "$1" in',
      '        -p) prop="$2"; shift 2 ;;',
      '        --value) shift ;;',
      '        *) unit="$1"; shift ;;',
      '      esac',
      '    done',
      '    id="${unit#hms-job-}"',
      '    if [ ! -d "$HMS_JOB_LOG_ROOT/$id" ]; then',
      '      [ "$prop" = LoadState ] && echo not-found',
      '      [ "$prop" = ActiveState ] && echo inactive',
      '      exit 0',
      '    fi',
      '    if [ "$prop" = LoadState ]; then echo loaded; exit 0; fi',
      '    if [ -f "$HMS_JOB_LOG_ROOT/$id/pid" ] && kill -0 "$(cat "$HMS_JOB_LOG_ROOT/$id/pid")" 2>/dev/null; then',
      '      echo active',
      '    elif [ -f "$HMS_JOB_LOG_ROOT/$id/result.json" ]; then',
      '      echo inactive',
      '    else',
      '      echo inactive',
      '    fi',
      '    ;;',
      '  is-active)',
      '    [ "${1:-}" = --quiet ] && shift',
      '    unit="${1:-}"',
      '    id="${unit#hms-job-}"',
      '    if [ -f "$HMS_JOB_LOG_ROOT/$id/pid" ] && kill -0 "$(cat "$HMS_JOB_LOG_ROOT/$id/pid")" 2>/dev/null; then',
      '      exit 0',
      '    fi',
      '    exit 3',
      '    ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'systemctl'), 0o755);

  writeFileSync(
    join(bin, 'u0'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'out=""; prop=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --out) out="$2"; shift 2 ;;',
      '    --property) prop="$2"; shift 2 ;;',
      '    --args-file) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'echo "start $prop $(date +%s%N)" >> "$HMS_JOB_U0_LOG"',
      'sleep "${HMS_JOB_U0_SLEEP:-0.4}"',
      'mkdir -p "$out"',
      'echo "end $prop $(date +%s%N)" >> "$HMS_JOB_U0_LOG"',
      'echo "{\"ok\":true,\"property\":\"$prop\"}" > "$out/result.json"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'u0'), 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: root,
    HMS_JOB_LOG_ROOT: logRoot,
    HMS_JOB_SERVER_PILOT: server,
    HMS_JOB_SYSTEMD_RUN: join(bin, 'systemd-run'),
    HMS_JOB_SYSTEMCTL: join(bin, 'systemctl'),
    HMS_JOB_PROOF_CMD: join(bin, 'u0'),
    HMS_JOB_WAIT_SECS: '0.05',
    HMS_JOB_U0_SLEEP: '0.4',
    HMS_JOB_U0_LOG: join(root, 'u0.log'),
    HMS_JOB_STUB_UNITS: join(root, 'units.log'),
  };
  return { root, bin, logRoot, server, env, argsFile: join(root, 'args.json') };
}

function runJob(
  harness: ReturnType<typeof makeHarness>,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [jobScript, ...args], {
    encoding: 'utf8',
    env: { ...harness.env, ...extraEnv },
    timeout: 15_000,
  });
}

function waitForResult(logRoot: string, id: string, timeoutMs = 8_000) {
  const started = Date.now();
  const path = join(logRoot, id, 'result.json');
  while (Date.now() - started < timeoutMs) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      spawnSync('sleep', ['0.05']);
    }
  }
  throw new Error(`no result.json for ${id}`);
}

function parseNsLog(log: string) {
  return log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [kind, property, ns] = line.split(' ');
      return { kind, property, ns: BigInt(ns) };
    });
}

describe('hms-job.sh shell contract', () => {
  it('refuses a tool outside the allowed dir', () => {
    const harness = makeHarness();
    const outside = join(harness.root, 'evil.ts');
    writeFileSync(outside, 'export {}\n');
    const result = runJob(harness, [
      'start',
      '--property',
      'HRCEN',
      '--tool',
      outside,
      '--args-file',
      harness.argsFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/outside allowed dir/);
    expect(result.stdout.trim()).toBe('');
  });

  it('refuses a raw .mjs even under src/ops', () => {
    const harness = makeHarness();
    const mjs = join(harness.server, 'src', 'ops', 'create-lab-stay.mjs');
    writeFileSync(mjs, 'export {}\n');
    const result = runJob(harness, [
      'start',
      '--property',
      'HRCEN',
      '--tool',
      mjs,
      '--args-file',
      harness.argsFile,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/raw \.mjs/);
  });

  it('poll on an unknown id returns unknown', () => {
    const harness = makeHarness();
    const result = runJob(harness, ['poll', 'no-such-job']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('state=unknown');
  });

  it('poll reports done from result.json when the unit is unloaded', () => {
    const harness = makeHarness();
    const started = runJob(harness, [
      'start',
      '--property',
      'HRCEN',
      '--tool',
      'src/ops/hms-proof-run.ts',
      '--args-file',
      harness.argsFile,
    ]);
    expect(started.status, started.stderr).toBe(0);
    const id = started.stdout.trim();
    waitForResult(harness.logRoot, id);
    writeFileSync(
      join(harness.bin, 'systemctl-gone'),
      [
        '#!/usr/bin/env bash',
        'echo not-found',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const polled = runJob(harness, ['poll', id], {
      HMS_JOB_SYSTEMCTL: join(harness.bin, 'systemctl-gone'),
    });
    expect(polled.status, polled.stderr).toBe(0);
    expect(polled.stdout).toMatch(/^state=done$/m);
    expect(polled.stdout).toMatch(/result=/);
  });

  it('two starts on the same property: the second waits', () => {
    const harness = makeHarness();
    const first = runJob(harness, [
      'start',
      '--property',
      'HRCEN',
      '--tool',
      'src/ops/hms-proof-run.ts',
      '--args-file',
      harness.argsFile,
    ]);
    expect(first.status, first.stderr).toBe(0);
    const id1 = first.stdout.trim();
    const second = runJob(harness, [
      'start',
      '--property',
      'HRCEN',
      '--tool',
      'src/ops/hms-proof-run.ts',
      '--args-file',
      harness.argsFile,
    ]);
    expect(second.status, second.stderr).toBe(0);
    const id2 = second.stdout.trim();
    expect(id1).not.toBe(id2);
    waitForResult(harness.logRoot, id1);
    waitForResult(harness.logRoot, id2);
    const events = parseNsLog(readFileSync(harness.env.HMS_JOB_U0_LOG!, 'utf8'));
    const start1 = events.find((e) => e.kind === 'start' && e.property === 'HRCEN');
    const end1 = events.find((e) => e.kind === 'end' && e.property === 'HRCEN');
    const starts = events.filter((e) => e.kind === 'start');
    const ends = events.filter((e) => e.kind === 'end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(start1).toBeTruthy();
    expect(end1).toBeTruthy();
    expect(starts[1]!.ns >= end1!.ns).toBe(true);
  });

  it('HRCEN and HRDAV run together only when HMS_LOCK_SCOPE=property', () => {
    const harness = makeHarness();
    const startPair = (lockScope?: string) => {
      writeFileSync(harness.env.HMS_JOB_U0_LOG!, '');
      const extra: NodeJS.ProcessEnv = lockScope
        ? { HMS_LOCK_SCOPE: lockScope }
        : { HMS_LOCK_SCOPE: '' };
      const a = runJob(
        harness,
        [
          'start',
          '--property',
          'HRCEN',
          '--tool',
          'src/ops/hms-proof-run.ts',
          '--args-file',
          harness.argsFile,
        ],
        extra,
      );
      const b = runJob(
        harness,
        [
          'start',
          '--property',
          'HRDAV',
          '--tool',
          'src/ops/hms-proof-run.ts',
          '--args-file',
          harness.argsFile,
        ],
        extra,
      );
      expect(a.status, a.stderr).toBe(0);
      expect(b.status, b.stderr).toBe(0);
      waitForResult(harness.logRoot, a.stdout.trim());
      waitForResult(harness.logRoot, b.stdout.trim());
      const events = parseNsLog(readFileSync(harness.env.HMS_JOB_U0_LOG!, 'utf8'));
      const hrcenStart = events.find((e) => e.kind === 'start' && e.property === 'HRCEN')!;
      const hrcenEnd = events.find((e) => e.kind === 'end' && e.property === 'HRCEN')!;
      const hrdavStart = events.find((e) => e.kind === 'start' && e.property === 'HRDAV')!;
      const overlapped = hrdavStart.ns < hrcenEnd.ns && hrcenStart.ns < events.find((e) => e.kind === 'end' && e.property === 'HRDAV')!.ns;
      return overlapped;
    };

    expect(startPair('property')).toBe(true);
    expect(startPair(undefined)).toBe(false);
  });
});

describe('ops-deploy.sh worktree guard', () => {
  function runGuard(worktreeLeaf: string) {
    const root = mkdtempSync(join(tmpdir(), 'ops-deploy-guard-'));
    harnesses.push(root);
    const wt = join(root, '.worktrees', worktreeLeaf);
    mkdirSync(join(wt, 'apps/server-pilot/deploy'), { recursive: true });
    execFileSync('git', ['init', '-q', wt]);
    copyFileSync(opsScript, join(wt, 'apps/server-pilot/deploy/ops-deploy.sh'));
    writeFileSync(
      join(wt, 'apps/server-pilot/deploy/sync-ec2-git-bundle.sh'),
      '#!/usr/bin/env bash\necho stub-sync\nexit 0\n',
      { mode: 0o755 },
    );
    return spawnSync('bash', [join(wt, 'apps/server-pilot/deploy/ops-deploy.sh')], {
      cwd: wt,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
      },
    });
  }

  it('refuses unless cwd is .worktrees/recover-parse-failure', () => {
    const refused = runGuard('lane-U6');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/recover-parse-failure/);
    expect(refused.stdout).not.toMatch(/sync bundle/);
  });

  it('allows cwd .worktrees/recover-parse-failure past the guard', () => {
    const allowed = runGuard('recover-parse-failure');
    expect(allowed.stderr).not.toMatch(/refuse: cwd must be/);
    expect(allowed.stdout).toMatch(/sync bundle/);
  });

  it('refuses a lane script even when cwd is recover-parse-failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'ops-deploy-guard-'));
    harnesses.push(root);
    const recover = join(root, '.worktrees', 'recover-parse-failure');
    const lane = join(root, '.worktrees', 'lane-U6');
    for (const wt of [recover, lane]) {
      mkdirSync(join(wt, 'apps/server-pilot/deploy'), { recursive: true });
      execFileSync('git', ['init', '-q', wt]);
      copyFileSync(opsScript, join(wt, 'apps/server-pilot/deploy/ops-deploy.sh'));
    }
    const refused = spawnSync('bash', [join(lane, 'apps/server-pilot/deploy/ops-deploy.sh')], {
      cwd: recover,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
      },
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/script checkout must be/);
  });
});
