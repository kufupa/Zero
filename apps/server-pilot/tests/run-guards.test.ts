import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const jobScript = join(here, '..', 'deploy', 'hms-job.sh');
const opsScript = join(here, '..', 'deploy', 'ops-deploy.sh');
const writerScript = join(here, '..', 'deploy', 'write-ec2-remote-env.sh');

const harnesses: string[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const root = harnesses.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  harnesses.push(root);
  return root;
}

describe('HOLD file stops hms-job.sh before systemd-run', () => {
  it('exits non-zero and never starts a unit', () => {
    const root = scratch('u12-hms-hold-');
    const hold = join(root, 'HOLD.txt');
    const units = join(root, 'units.log');
    writeFileSync(hold, 'pause\n');
    mkdirSync(join(root, 'server-pilot', 'src', 'ops'), { recursive: true });
    writeFileSync(join(root, 'server-pilot', 'src', 'ops', 'hms-proof-run.ts'), '// stub\n');
    writeFileSync(join(root, 'args.json'), '{"mode":"preview"}\n');
    writeFileSync(
      join(root, 'systemd-run'),
      '#!/usr/bin/env bash\nprintf started\\n >>"$HMS_JOB_STUB_UNITS"\nexit 0\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [
        jobScript,
        'start',
        '--property',
        'HRCEN',
        '--tool',
        'src/ops/hms-proof-run.ts',
        '--args-file',
        join(root, 'args.json'),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          NAVA_RUN_HOLD_FILE: hold,
          HMS_JOB_LOG_ROOT: join(root, 'hms-jobs'),
          HMS_JOB_SERVER_PILOT: join(root, 'server-pilot'),
          HMS_JOB_SYSTEMD_RUN: join(root, 'systemd-run'),
          HMS_JOB_STUB_UNITS: units,
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/HOLD file present/);
    expect(existsSync(units)).toBe(false);
  });
});

describe('HOLD file stops ops-deploy.sh before SSM', () => {
  it('exits non-zero and never calls ssm-run-command.sh', () => {
    const root = scratch('u12-ops-hold-');
    const hold = join(root, 'HOLD.txt');
    const deployDir = join(root, 'deploy');
    mkdirSync(deployDir);
    copyFileSync(opsScript, join(deployDir, 'ops-deploy.sh'));
    writeFileSync(hold, 'pause\n');
    writeFileSync(
      join(deployDir, 'ssm-run-command.sh'),
      '#!/usr/bin/env bash\nprintf ssm\\n >>"$SCRATCH/ssm.log"\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(deployDir, 'sync-ec2-git-bundle.sh'),
      '#!/usr/bin/env bash\nprintf sync\\n >>"$SCRATCH/ssm.log"\nexit 0\n',
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [join(deployDir, 'ops-deploy.sh')], {
      cwd: deployDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        SCRATCH: root,
        NAVA_RUN_HOLD_FILE: hold,
        REMOTE_TEST_REPO: root,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/HOLD file present/);
    expect(result.stdout).not.toMatch(/sync bundle/);
    expect(existsSync(join(root, 'ssm.log'))).toBe(false);
  });
});

describe('write-ec2-remote-env.sh canary SHA', () => {
  function runWriter(opts: {
    liveSha: string;
    canaryLine: string | null;
    quoteOn: boolean;
    existingOn?: boolean;
  }): SpawnSyncReturns<string> {
    const root = scratch('u12-canary-');
    const repoRoot = join(root, 'repo');
    const serverPilot = join(repoRoot, 'apps', 'server-pilot');
    const stubDir = join(root, 'bin');
    const awsMarker = join(root, 'aws-called');
    mkdirSync(serverPilot, { recursive: true });
    mkdirSync(stubDir);
    writeFileSync(
      join(serverPilot, '.env.production'),
      [
        "NODE_ENV='production'",
        "DATABASE_URL='postgres://example.invalid/zero'",
        "AWS_REGION='af-south-1'",
        "S3_BUCKET='nava-test-bucket'",
        ...(opts.quoteOn ? ["HMS_DAVINCI_MAKE_QUOTE='on'"] : []),
        '',
      ].join('\n'),
    );
    if (opts.existingOn) {
      writeFileSync(
        join(serverPilot, '.env.remote-common'),
        [
          "NODE_ENV='production'",
          "DATABASE_URL='postgres://example.invalid/zero'",
          "AWS_REGION='af-south-1'",
          "S3_BUCKET='nava-test-bucket'",
          "HMS_DAVINCI_MAKE_QUOTE='on'",
          '',
        ].join('\n'),
      );
    }
    const canary = join(root, 'CANARY.txt');
    if (opts.canaryLine !== null) writeFileSync(canary, `${opts.canaryLine}\n`);
    writeFileSync(join(stubDir, 'id'), '#!/usr/bin/env bash\nprintf "%s\\n" ubuntu\n', {
      mode: 0o755,
    });
    chmodSync(join(stubDir, 'id'), 0o755);
    writeFileSync(
      join(stubDir, 'stat'),
      `#!/usr/bin/env bash
printf '%s\\n' '600:ubuntu:ubuntu'
`,
      { mode: 0o755 },
    );
    chmodSync(join(stubDir, 'stat'), 0o755);
    writeFileSync(
      join(stubDir, 'aws'),
      `#!/usr/bin/env bash
printf called\\n >"$FAKE_AWS_MARKER"
printf '%s' '{"BETTER_AUTH_SECRET":"remote-signing-secret"}'
`,
      { mode: 0o755 },
    );
    chmodSync(join(stubDir, 'aws'), 0o755);
    return spawnSync('bash', [writerScript], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        REPO_ROOT: repoRoot,
        NAVA_LIVE_SHA: opts.liveSha,
        NAVA_CANARY_PASS_FILE: canary,
        FAKE_AWS_MARKER: awsMarker,
      },
    });
  }

  it('refuses flipping a workflow flag on when the canary SHA is not live', () => {
    const result = runWriter({
      liveSha: 'abcdef1234567890abcdef1234567890abcdef12',
      canaryLine: 'CANARY PASS quote HRDAV deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      quoteOn: true,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/CANARY PASS|stale/i);
    expect(result.stderr).toMatch(/HMS_DAVINCI_MAKE_QUOTE|quote/);
  });

  it('does not treat an already-on flag as a flip', () => {
    const result = runWriter({
      liveSha: 'abcdef1234567890abcdef1234567890abcdef12',
      canaryLine: null,
      quoteOn: true,
      existingOn: true,
    });
    expect(result.stderr).not.toMatch(/CANARY PASS|stale/i);
    expect(result.status, result.stderr).toBe(0);
  });
});
