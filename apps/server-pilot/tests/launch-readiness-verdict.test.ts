import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

// Everything above the marker only collects AWS and host facts. The marker starts the report builder, the verdict
// and the exit code, so this test runs that part on fixture facts and never calls AWS or the remote host.
const script = readFileSync(
  fileURLToPath(new URL('../deploy/launch-readiness.sh', import.meta.url)),
  'utf8',
);
const opsDeployScript = readFileSync(
  fileURLToPath(new URL('../deploy/ops-deploy.sh', import.meta.url)),
  'utf8',
);
const verdict = script.slice(script.indexOf('# BEGIN_READINESS_REPORT_BUILDER'));
// Run the shipped transaction and SQL against a controlled adapter or disposable DB.
const workflowQuerySource = script.slice(
  script.indexOf("const [workflow] = await sql.begin('read only', async (tx) => {"),
  script.indexOf('  const [outbound]'),
);
const runWorkflowSql = new Function(
  'sql', 'deadLetterWindowAt',
  `return (async () => { ${workflowQuerySource}\nreturn workflow; })();`,
) as (sql: any, boundary: string | null) => Promise<any>;
const markerValidatorSource = script.slice(
  script.indexOf('const rawLastGoodDeployAt ='),
  script.indexOf('const empty = {'),
);
const markerReadBlock = opsDeployScript.slice(
  opsDeployScript.indexOf('  echo "== ops-deploy: read last-good deploy marker =="'),
  // Ends before the host-clock boundary block, which the stubbed deploy-flow tests below run for real.
  opsDeployScript.indexOf('  # Boundary for the marker written after every gate passes'),
);

const SG = 'sg-0123456789abcdef0';
const pm2 = { present: true, online: true, restarts: 0 };

// Every check passes. Each case moves one fact away from this baseline.
function baselineRemote() {
  return {
    health: { http: true, https: true, tls: true },
    pm2: { required: { http: pm2, worker: pm2, 'ai-worker': pm2 }, allOnline: true },
    hotelProbe: true,
    firewall: {
      statusRead: true,
      rulesRead: true,
      active: true,
      defaultDeny: true,
      tunnel443: true,
      broad443Absent: true,
      listenerSafe: true,
    },
    config: {
      envLoaded: true,
      mailTransportModeReal: true,
      betterAuthUrlCorrect: true,
      undoSendSecondsCorrect: true,
      aiWriteGateEnabled: true,
      aiDraftsDisabled: true,
    },
    db: {
      connected: true,
      centurionActiveTransportCount: 1,
      centurionActiveCategoryCount: 12,
      workflowCategoryMissingCount: 0,
      workflowNonterminalCount: 0,
      workflowDeadLetterCount: 0,
      workflowDeadLetterRecentCount: 0,
      workflowDeadLetterWindowStart: null,
      workflowLastGoodDeployRejected: false,
      outboundNonterminalCount: 0,
      counts: {},
    },
    disk: { safe: true, usedPercent: 40, freeMB: 10000 },
  };
}

type Remote = ReturnType<typeof baselineRemote>;

function runVerdict(patch: (remote: Remote) => void = () => {}, allowBacklog = '') {
  const remote = baselineRemote();
  patch(remote);
  const env = {
    ...process.env,
    REMOTE_JSON: JSON.stringify(remote),
    RDS_JSON: JSON.stringify({
      status: 'available',
      backupRetentionDays: 7,
      backupLatestRestorableAt: '2026-10-09T00:00:00Z',
      deletionProtection: true,
      multiAZ: true,
    }),
    S3_AVAILABLE: 'true',
    S3_VERSIONING: 'Enabled',
    S3_LIFECYCLE: '[]',
    CLOUDWATCH_ALARM_COUNT: '1',
    SNS_TOPIC_COUNT: '1',
    S3_CORS: JSON.stringify({
      CORSRules: [
        { AllowedOrigins: ['https://nava.legacyhotels.co.za'], AllowedMethods: ['GET', 'HEAD'] },
      ],
    }),
    S3_CORS_OK: 'true',
    S3_PUBLIC_ACCESS: JSON.stringify({
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    }),
    S3_PUBLIC_ACCESS_OK: 'true',
    INSTANCE_NETWORK: JSON.stringify({
      securityGroups: [{ GroupId: SG }],
      publicIpv4: [],
      ipv6: [],
      networkInterfaces: [
        {
          id: 'eni-0123456789abcdef0',
          deviceIndex: 0,
          publicIpv4: null,
          ipv6: [],
          securityGroups: [{ GroupId: SG }],
        },
      ],
    }),
    INSTANCE_NETWORK_OK: 'true',
    SG_STATE: JSON.stringify([{ id: SG, ingress: [] }]),
    SG_QUERY_OK: 'true',
    REMOTE_ADMIN_MODE: '0',
    REMOTE_TARGET_HEALTH_REQUIRED: '0',
    REMOTE_ADMIN_LIFECYCLE_MODE: '',
    REMOTE_ADMIN_FACTS: '{}',
    NAVA_ALLOW_PREEXISTING_NONTERMINAL_BACKLOG: allowBacklog,
  };
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${verdict}`], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const stdout = result.stdout.trim();
  return {
    status: result.status,
    stderr: result.stderr,
    report: stdout ? (JSON.parse(stdout) as Record<string, any>) : null,
  };
}

describe('owner waiver for the existing workflow backlog', () => {
  it('leaves the measured backlog visible as a warning', () => {
    const run = runVerdict((remote) => { remote.db.workflowNonterminalCount = 54; }, '1');
    expect(run.status).toBe(0);
    expect(run.report).toMatchObject({
      status: 'READY',
      checks: { workflowNonterminalBacklogEmpty: false },
      failures: [],
      warnings: ['workflowNonterminalBacklogEmpty'],
      observations: { workflowNonterminalCount: 54, workflowNonterminalBacklogWaived: true },
    });
    expect(run.stderr).toContain('owner waived workflowNonterminalBacklogEmpty');
  });

  it('keeps all other failures blocking when the backlog is waived', () => {
    const run = runVerdict((remote) => {
      remote.db.workflowNonterminalCount = 54;
      remote.db.workflowDeadLetterRecentCount = 1;
    }, '1');
    expect(run.status).toBe(1);
    expect(run.report?.failures).toEqual(['workflowDeadLetterBacklogEmpty']);
    expect(run.report?.warnings).toEqual(['workflowNonterminalBacklogEmpty']);
  });

  it.each(['', '0', 'true'])('requires an explicit 1 for the waiver (%s)', (value) => {
    const run = runVerdict((remote) => { remote.db.workflowNonterminalCount = 54; }, value);
    expect(run.status).toBe(1);
    expect(run.report?.failures).toEqual(['workflowNonterminalBacklogEmpty']);
  });
});

describe('last-good deploy marker validation in launch-readiness', () => {
  it.each([
    ['2026-10-09T12:34:56Z', '2026-10-09T12:34:56.000Z'],
    ['2026-10-09T14:34:56+02:00', '2026-10-09T12:34:56.000Z'],
    ['2026-10-09T12:34:56.5Z', '2026-10-09T12:34:56.500Z'],
    ['2026-02-30T00:00:00Z', 'null'],
    ['yesterday', 'null'],
    ["2026-10-09T00:00:00Z'); DROP TABLE ai_workflow_run; --", 'null'],
    ['', 'null'],
  ])('accepts only strict ISO timestamps before SQL binds them (%s)', (input, expected) => {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: `${markerValidatorSource}\nprocess.stdout.write(String(lastGoodDeployAt));\n`,
      encoding: 'utf8',
      env: { LAST_GOOD_DEPLOY_AT: input },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });
});

describe('deploy restart dead-letter boundary', () => {
  it('runs the workflow query in a UTC read-only transaction', async () => {
    const calls: string[] = [];
    const transaction = async (parts: TemplateStringsArray) => {
      const statement = parts.join('?').replace(/\s+/g, ' ').trim();
      calls.push(statement);
      return statement.startsWith('SELECT') ? [{ dead_letter_recent: 1 }] : [];
    };
    const sql = {
      begin: async (mode: string, callback: (tx: typeof transaction) => Promise<unknown>) => {
        expect(mode).toBe('read only');
        return callback(transaction);
      },
    };
    const row = await runWorkflowSql(sql, '2026-11-03T10:00:00.500Z');
    expect(row.dead_letter_recent).toBe(1);
    expect(calls[0]).toBe("SET LOCAL TIME ZONE 'UTC'");
    expect(calls[1]).toContain('FROM ai_workflow_run');
  });

  it('uses the current restart before the last-good marker', () => {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: `${markerValidatorSource}\nprocess.stdout.write(String(deadLetterWindowAt));\n`,
      encoding: 'utf8',
      env: { LAST_GOOD_DEPLOY_AT: '2026-11-02T10:00:00Z', DEPLOY_STARTED_AT: '2026-11-03T10:00:00Z' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('2026-11-03T10:00:00.000Z');
  });

  it('refuses an invalid explicit restart boundary', () => {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: `${markerValidatorSource}\nprocess.stdout.write(String(deadLetterWindowAt));\n`,
      encoding: 'utf8',
      env: { LAST_GOOD_DEPLOY_AT: '2026-11-02T10:00:00Z', DEPLOY_STARTED_AT: 'invalid' },
    });
    expect(result.status).not.toBe(0);
  });
});

describe('last-good deploy marker read in ops-deploy', () => {
  function markerInvocation(marker: unknown) {
    const encoded = Buffer.from(JSON.stringify(marker)).toString('base64');
    return JSON.stringify({ Stdout: `NAVA_LAST_GOOD_DEPLOY_B64=${encoded}\n` });
  }
  // Runs the real marker-read block from ops-deploy.sh with a fake ssm-run-command.sh that replays `invocation`.
  function runMarkerRead(invocation: string, ssmExit: number) {
    const dir = mkdtempSync(join(tmpdir(), 'l3-marker-read-'));
    try {
      writeFileSync(join(dir, 'invocation.json'), invocation);
      writeFileSync(
        join(dir, 'ssm-run-command.sh'),
        `#!/usr/bin/env bash\ncat "$(dirname "$0")/invocation.json"\nexit ${ssmExit}\n`,
      );
      return spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\nSCRIPT_DIR='${dir}'\nstep_mark() { :; }\n${markerReadBlock}\nprintf 'AT=%s\\n' "\${LAST_GOOD_DEPLOY_AT:-}"`,
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 60_000 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes a valid marker timestamp through to the readiness window', () => {
    const run = runMarkerRead(markerInvocation({ commit: 'a'.repeat(40), at: '2026-10-09T12:34:56Z' }), 0);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('ops-deploy: last-good marker 2026-10-09T12:34:56Z passed to readiness');
    expect(run.stdout).toMatch(/^AT=2026-10-09T12:34:56Z$/m);
  });

  it.each<[string, string, number]>([
    ['the SSM read fails', '', 70],
    ['the marker file is missing', JSON.stringify({ Stdout: 'NAVA_LAST_GOOD_DEPLOY_B64=\n' }), 0],
    ['the marker timestamp is not ISO', markerInvocation({ commit: 'a'.repeat(40), at: 'yesterday' }), 0],
  ])('falls back to the 24-hour window with one note when %s', (_label, invocation, ssmExit) => {
    const run = runMarkerRead(invocation, ssmExit);

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^AT=$/m);
    expect(run.stdout.match(/using 24-hour readiness window/g)).toHaveLength(1);
  });
});

describe('capture-deploy-ec2', () => {
  it.each([0, 17])('places the restart boundary before long output and preserves exit %s', (status) => {
    const root = mkdtempSync(join(tmpdir(), 'nava-capture-deploy-'));
    try {
      const deployDir = join(root, 'apps', 'server-pilot', 'deploy');
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(join(deployDir, 'deploy-ec2.sh'), [
        '#!/usr/bin/env bash',
        'if [ "${2:-}" = --help ]; then exit 0; fi',
        'printf "%040000d\\n" 0',
        'printf "NAVA_PM2_RESTART_STARTED_AT=2026-11-03T10:00:00.500Z\\n"',
        'printf "distinctive late failure\\n" >&2',
        `exit ${status}`,
      ].join('\n'));
      const capture = fileURLToPath(new URL('../deploy/capture-deploy-ec2.sh', import.meta.url));
      const result = spawnSync('bash', [capture], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(status);
      expect(result.stdout.startsWith('NAVA_PM2_RESTART_STARTED_AT=2026-11-03T10:00:00.500Z\n')).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(40_000);
      expect(result.stderr.slice(0, 8_000)).toContain('distinctive late failure');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Runs the shipped ops-deploy.sh from a scratch directory with stub helpers, so the marker read and write run for real.
// The SSM stub executes only the marker payloads (with /home/ubuntu rewritten into the scratch tree) and logs every
// other payload by kind. Readiness, VPN and CAS failures are switched on with FAIL_* variables.
describe('ops-deploy last-good marker write (stubbed deploy flow)', () => {
  const ssmStub = String.raw`#!/usr/bin/env bash
set -euo pipefail
payload="$1"
case "$payload" in
  *'base64 -w0'*) kind=marker-read ;;
  *'mv -f "$tmp" "$marker_path"'*) kind=marker-write ;;
  *capture-deploy-ec2.sh*) kind=deploy ;;
  *vpn-health-assert*) kind=vpn ;;
  *source-registry-cas.sh*) kind=cas ;;
  *NAVA_HOST_CLOCK_UTC*) kind=host-clock ;;
  *) kind=other ;;
esac
printf '%s\n' "$kind" >>"$SCRATCH/calls.log"
case "$kind" in
  marker-read|marker-write)
    out="$(printf '%s\n' "$payload" | sed "s#/home/ubuntu#$SCRATCH/home#g" | bash)"
    if [ "$kind" = marker-read ]; then
      "$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ Stdout: process.argv[1] }))' "$out"
    fi
    ;;
  host-clock)
    if [ "$FAIL_HOST_CLOCK" = 1 ]; then exit 70; fi
    "$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ Stdout: process.argv[1] }))' "$HOST_CLOCK_STDOUT"
    ;;
  deploy)
    "$NODE_BIN" -e 'process.stdout.write(JSON.stringify({ Stdout: process.argv[1] }))' "$RESTART_STDOUT"
    ;;
  vpn) sleep "$VPN_DELAY"; exit "$FAIL_VPN" ;;
  cas) exit "$FAIL_CAS" ;;
esac
`;
  const readinessStub = String.raw`#!/usr/bin/env bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ >"$SCRATCH/readiness-started-at"
printf '%s\n' "$DEPLOY_STARTED_AT" >"$SCRATCH/deploy-started-at"
printf '%s\n' readiness >>"$SCRATCH/calls.log"
exit "$FAIL_READINESS"
`;
  function runOpsDeploy(options: { args?: string[]; env?: Record<string, string> } = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'l3-ops-deploy-'));
    try {
      const deployDir = join(scratch, 'deploy');
      mkdirSync(deployDir);
      copyFileSync(
        fileURLToPath(new URL('../deploy/ops-deploy.sh', import.meta.url)),
        join(deployDir, 'ops-deploy.sh'),
      );
      writeFileSync(join(deployDir, 'ssm-run-command.sh'), ssmStub, { mode: 0o755 });
      writeFileSync(join(deployDir, 'launch-readiness.sh'), readinessStub, { mode: 0o755 });
      writeFileSync(join(deployDir, 'sync-ec2-git-bundle.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      // `git -C /home/ubuntu/repos/zero rev-parse HEAD` resolves against this scratch repo, so the commit is real.
      const repo = join(scratch, 'home', 'repos', 'zero');
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', [
        '-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.test',
        'commit', '-q', '--allow-empty', '-m', 'test',
      ]);
      // The deploy script itself runs from a separate real clean fixture tree.
      writeFileSync(join(scratch, '.gitignore'), '*\n!.gitignore\n');
      execFileSync('git', ['init', '-q', '-b', 'main', scratch]);
      execFileSync('git', ['-C', scratch, 'add', '.gitignore']);
      execFileSync('git', [
        '-C', scratch, '-c', 'user.name=test', '-c', 'user.email=test@example.test',
        'commit', '-qm', 'deploy fixture',
      ]);
      execFileSync('git', ['-C', scratch, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
      execFileSync('git', ['-C', repo, 'fetch', '-q', scratch, 'HEAD']);
      execFileSync('git', ['-C', repo, 'reset', '-q', '--hard', 'FETCH_HEAD']);
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const run = spawnSync('bash', [join(deployDir, 'ops-deploy.sh'), ...(options.args ?? [])], {
        cwd: deployDir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          SCRATCH: scratch,
          REMOTE_TEST_REPO: scratch,
          NODE_BIN: process.execPath,
          FAIL_READINESS: '0',
          FAIL_VPN: '0',
          FAIL_CAS: '0',
          VPN_DELAY: '0',
          FAIL_HOST_CLOCK: '0',
          HOST_CLOCK_STDOUT: `NAVA_HOST_CLOCK_UTC=${new Date().toISOString().slice(0, 19)}Z`,
          RESTART_STDOUT: `NAVA_PM2_RESTART_STARTED_AT=${new Date().toISOString()}`,
          ...options.env,
        },
      });
      const callsPath = join(scratch, 'calls.log');
      const markerPath = join(scratch, 'home', '.nava-deploy', 'last-good.json');
      const readinessPath = join(scratch, 'readiness-started-at');
      const deployStartedPath = join(scratch, 'deploy-started-at');
      return {
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        head,
        calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n') : [],
        marker: existsSync(markerPath)
          ? (JSON.parse(readFileSync(markerPath, 'utf8')) as { commit: string; at: string })
          : null,
        readinessStartedAt: existsSync(readinessPath) ? readFileSync(readinessPath, 'utf8').trim() : null,
        deployStartedAt: existsSync(deployStartedPath) ? readFileSync(deployStartedPath, 'utf8').trim() : null,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('stamps the marker with the boundary captured before readiness, not the later write time', () => {
    const run = runOpsDeploy({ env: { VPN_DELAY: '2' } });

    expect(run.status).toBe(0);
    expect(run.readinessStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(run.marker).toEqual({ commit: run.head, at: expect.any(String) });
    // The write happens about two seconds after readiness starts, so a stamp taken at write time fails this check.
    expect(run.marker!.at <= run.readinessStartedAt!).toBe(true);
    expect(run.calls.at(-1)).toBe('marker-write');
  });

  it('passes the actual restart boundary into readiness', () => {
    const run = runOpsDeploy({ env: { RESTART_STDOUT: 'NAVA_PM2_RESTART_STARTED_AT=2026-11-03T10:00:00.500Z' } });
    expect(run.status).toBe(0);
    expect(run.deployStartedAt).toBe('2026-11-03T10:00:00.500Z');
  });

  it.each(['', 'NAVA_PM2_RESTART_STARTED_AT=yesterday', 'NAVA_PM2_RESTART_STARTED_AT=2026-11-03T10:00:00Z'])(
    'fails closed before readiness when the restart boundary is unavailable or invalid',
    (RESTART_STDOUT) => {
      const run = runOpsDeploy({ env: { RESTART_STDOUT } });
      expect(run.status).toBe(20);
      expect(run.stderr).toContain('deploy may have occurred, readiness not verified');
      expect(run.calls).not.toContain('readiness');
      expect(run.marker).toBeNull();
    },
  );

  it('takes the readiness boundary from the EC2 host clock minus a 5-minute margin, right before readiness', () => {
    const run = runOpsDeploy({ env: { HOST_CLOCK_STDOUT: 'NAVA_HOST_CLOCK_UTC=2026-10-12T10:00:00Z' } });

    expect(run.status).toBe(0);
    expect(run.marker).toEqual({ commit: run.head, at: '2026-10-12T09:55:00Z' });
    expect(run.calls.slice(-5)).toEqual(['marker-read', 'host-clock', 'readiness', 'vpn', 'marker-write']);
    expect(run.stdout).not.toContain('host clock unavailable');
  });

  it.each<[string, Record<string, string>]>([
    ['the SSM read fails', { FAIL_HOST_CLOCK: '1' }],
    ['the host clock line is missing', { HOST_CLOCK_STDOUT: 'unrelated output' }],
    ['the host clock is not a timestamp', { HOST_CLOCK_STDOUT: 'NAVA_HOST_CLOCK_UTC=yesterday' }],
  ])('falls back to the operator clock minus 15 minutes with one note when %s', (_label, env) => {
    const before = Date.now();
    const run = runOpsDeploy({ env });
    const after = Date.now();

    expect(run.status).toBe(0);
    expect(run.calls).toContain('readiness');
    expect(run.calls.at(-1)).toBe('marker-write');
    expect(run.stdout.match(/host clock unavailable/g)).toHaveLength(1);
    // Whole seconds, rounded down, so the stamp can sit up to one second below the window start.
    const at = Date.parse(run.marker!.at);
    expect(at).toBeGreaterThanOrEqual(before - 15 * 60_000 - 1_000);
    expect(at).toBeLessThanOrEqual(after - 15 * 60_000);
  });

  it('writes no marker when readiness fails', () => {
    const run = runOpsDeploy({ env: { FAIL_READINESS: '1' } });

    expect(run.status).not.toBe(0);
    expect(run.calls).not.toContain('marker-write');
    expect(run.marker).toBeNull();
  });

  it('writes no marker when the VPN assert fails', () => {
    const run = runOpsDeploy({ env: { FAIL_VPN: '1' } });

    expect(run.status).not.toBe(0);
    expect(run.calls).not.toContain('marker-write');
    expect(run.marker).toBeNull();
  });

  it('writes no marker when the source and registry CAS fails', () => {
    const run = runOpsDeploy({
      env: {
        FAIL_CAS: '1',
        HMS_REGISTRY_CANDIDATE: 'candidate',
        HMS_SOURCE_REGISTRY_CURRENT: 'current',
        HMS_SOURCE_REGISTRY_CANDIDATE: 'source-candidate',
      },
    });

    expect(run.status).not.toBe(0);
    expect(run.calls).not.toContain('marker-write');
    expect(run.marker).toBeNull();
  });

  it('runs no readiness and writes no marker in quiesced mode', () => {
    const run = runOpsDeploy({ args: ['--quiesced'] });

    expect(run.status).toBe(0);
    expect(run.calls).not.toContain('readiness');
    expect(run.calls).not.toContain('marker-write');
    expect(run.marker).toBeNull();
  });
});

// Needs the disposable lane DB (CONFIRM_DISPOSABLE_TEST_DB=1, TEST_DATABASE_URL on localhost). Runs the shipped
// dead-letter window SQL, so a regression to coalesce() or a wider window fails here.
const testDbUrl = process.env.TEST_DATABASE_URL ?? '';
// Without the disposable lane DB these tests report as skipped instead of disappearing from discovery.
const dbConfigured = process.env.CONFIRM_DISPOSABLE_TEST_DB === '1' && /127\.0\.0\.1|localhost/.test(testDbUrl);
describe.skipIf(!dbConfigured)('dead-letter window SQL (disposable DB)', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  function expectWindowAt24Hours(start: Date) {
    expect(Math.abs(start.getTime() - hoursAgo(24).getTime())).toBeLessThan(60_000);
  }
  async function runWindow(
    markerAt: string | null,
    deadLetterAt: Date | Date[],
    columnKind: 'timestamp without time zone' | 'timestamp with time zone' = 'timestamp without time zone',
  ) {
    const db = postgres(testDbUrl, { max: 1 });
    try {
      // TEMP table: visible only to this session, so the disposable DB keeps no state from the test.
      await db.unsafe(
        `CREATE TEMP TABLE ai_workflow_run (state text NOT NULL, finished_at ${columnKind}, updated_at ${columnKind} NOT NULL)`,
      );
      await db`SET TIME ZONE 'Africa/Johannesburg'`;
      for (const time of Array.isArray(deadLetterAt) ? deadLetterAt : [deadLetterAt]) {
        await db.unsafe(
          `INSERT INTO ai_workflow_run (state, finished_at, updated_at) VALUES ($1, $2::${columnKind}, $2::${columnKind})`,
          ['dead_letter', time.toISOString()],
        );
      }
      return await runWorkflowSql(db, markerAt);
    } finally {
      await db.end({ timeout: 2 });
    }
  }

  it('does not count a dead letter older than 24 h when the marker is 3 days old', async () => {
    const row = await runWindow(hoursAgo(72).toISOString(), hoursAgo(48));

    expect(row.dead_letter).toBe(1);
    expect(row.dead_letter_recent).toBe(0);
    expectWindowAt24Hours(row.dead_letter_window_start);
  });

  it('counts a dead letter newer than the marker when the marker is 3 days old', async () => {
    const row = await runWindow(hoursAgo(72).toISOString(), hoursAgo(1));

    expect(row.dead_letter_recent).toBe(1);
  });

  it('uses the marker as the window start when the deploy is under 24 h old', async () => {
    const markerAt = hoursAgo(2).toISOString();
    const beforeMarker = await runWindow(markerAt, hoursAgo(3));
    const afterMarker = await runWindow(markerAt, hoursAgo(1));

    expect(beforeMarker.dead_letter_window_start.toISOString()).toBe(markerAt);
    expect(beforeMarker.dead_letter_recent).toBe(0);
    expect(afterMarker.dead_letter_recent).toBe(1);
  });

  it('uses now() - 24 h when no marker is set', async () => {
    const row = await runWindow(null, hoursAgo(48));

    expect(row.dead_letter_recent).toBe(0);
    expectWindowAt24Hours(row.dead_letter_window_start);
  });

  it.each(['timestamp without time zone', 'timestamp with time zone'] as const)(
    'counts only new failures with a non-UTC session and %s columns',
    async (kind) => {
      const boundary = hoursAgo(1);
      const row = await runWindow(boundary.toISOString(), [
        new Date(boundary.getTime() - 1),
        new Date(boundary.getTime() + 1),
      ], kind);
      expect(row.dead_letter).toBe(2);
      expect(row.dead_letter_recent).toBe(1);
    },
  );

  it('conservatively includes a failure at the same millisecond as restart', async () => {
    const boundary = hoursAgo(1);
    const row = await runWindow(boundary.toISOString(), boundary);
    expect(row.dead_letter_recent).toBe(1);
  });
});

describe('launch-readiness verdict', () => {
  it('passes when dead letters predate the last-good deploy marker', () => {
    const markerAt = '2026-10-12T00:00:00.000Z';
    const run = runVerdict((remote) => {
      remote.db.workflowDeadLetterCount = 1;
      remote.db.workflowDeadLetterRecentCount = 0;
      remote.db.workflowDeadLetterWindowStart = markerAt;
    });

    expect(run.status).toBe(0);
    expect(run.report).toMatchObject({
      status: 'READY',
      failures: [],
      observations: {
        workflowDeadLetterCount: 1,
        workflowDeadLetterRecentCount: 0,
        workflowDeadLetterWindowStart: markerAt,
      },
    });
  });

  it('fails when a dead letter is newer than the last-good deploy marker', () => {
    const markerAt = '2026-10-12T00:00:00.000Z';
    const run = runVerdict((remote) => {
      remote.db.workflowDeadLetterCount = 1;
      remote.db.workflowDeadLetterRecentCount = 1;
      remote.db.workflowDeadLetterWindowStart = markerAt;
    });

    expect(run.status).toBe(1);
    expect(run.report).toMatchObject({
      status: 'NOT_READY',
      failures: ['workflowDeadLetterBacklogEmpty'],
      observations: {
        workflowDeadLetterCount: 1,
        workflowDeadLetterRecentCount: 1,
        workflowDeadLetterWindowStart: markerAt,
      },
    });
  });

  it('reports the 24-hour fallback window start when no marker is present', () => {
    const fallbackWindowStart = '2026-10-11T01:00:00.000Z';
    const run = runVerdict((remote) => {
      remote.db.workflowDeadLetterCount = 1;
      remote.db.workflowDeadLetterRecentCount = 0;
      remote.db.workflowDeadLetterWindowStart = fallbackWindowStart;
    });

    expect(run.status).toBe(0);
    expect(run.report).toMatchObject({
      status: 'READY',
      failures: [],
      observations: {
        workflowDeadLetterCount: 1,
        workflowDeadLetterRecentCount: 0,
        workflowDeadLetterWindowStart: fallbackWindowStart,
      },
    });
  });

  it('reports the effective window start and notes a marker that strict validation rejects', () => {
    const run = runVerdict((remote) => {
      remote.db.workflowDeadLetterWindowStart = '2026-10-11T01:00:00.000Z';
      remote.db.workflowLastGoodDeployRejected = true;
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('deadLetterWindowStart=2026-10-11T01:00:00.000Z');
    expect(run.stderr.match(/last-good deploy marker rejected/g)).toHaveLength(1);
    expect(run.report).toMatchObject({ observations: { workflowLastGoodDeployRejected: true } });
  });

  it('writes the last-good marker only after readiness, VPN, and later deploy work succeed', () => {
    const readinessAt = opsDeployScript.indexOf('bash "${SCRIPT_DIR}/launch-readiness.sh"');
    const vpnAssertAt = opsDeployScript.indexOf('echo "== ops-deploy: VPN HARD assert =="');
    const markerWriteAt = opsDeployScript.indexOf('marker_path="$marker_dir/last-good.json"');
    const markerGuardAt = opsDeployScript.lastIndexOf(
      'if [ "$QUIESCED" != "1" ]; then',
      markerWriteAt,
    );
    const laterDeployWorkAt = opsDeployScript.indexOf(
      'bash apps/server-pilot/deploy/source-registry-cas.sh',
    );

    expect(opsDeployScript).toContain('set -euo pipefail');
    expect(readinessAt).toBeGreaterThanOrEqual(0);
    expect(vpnAssertAt).toBeGreaterThan(readinessAt);
    expect(laterDeployWorkAt).toBeGreaterThan(vpnAssertAt);
    expect(markerGuardAt).toBeGreaterThan(laterDeployWorkAt);
    expect(markerWriteAt).toBeGreaterThan(markerGuardAt);
  });

  it('is READY with no warnings when every check passes', () => {
    const run = runVerdict();
    expect(run.status).toBe(0);
    expect(run.report).toMatchObject({ status: 'READY', failures: [], warnings: [] });
    expect(run.stderr).toContain('launch-readiness READY');
    expect(run.stderr).not.toContain('WARNING');
  });

  it('prints an outbound backlog as a warning and still exits 0', () => {
    const run = runVerdict((remote) => {
      remote.db.outboundNonterminalCount = 3;
    });
    expect(run.status).toBe(0);
    expect(run.report).toMatchObject({
      status: 'READY',
      failures: [],
      warnings: ['outboundBacklogEmpty'],
    });
    expect(run.report?.checks.outboundBacklogEmpty).toBe(false);
    expect(run.report?.observations.outboundNonterminalCount).toBe(3);
    expect(run.stderr).toContain(
      'WARNING launch-readiness: outboundBacklogEmpty not met (outboundNonterminalCount=3)',
    );
  });

  it.each([
    ['an unhealthy HTTP listener', (remote: Remote) => (remote.health.http = false), 'httpHealthy'],
    [
      'a recent workflow dead letter',
      (remote: Remote) => (remote.db.workflowDeadLetterRecentCount = 1),
      'workflowDeadLetterBacklogEmpty',
    ],
  ])('still fails the gate on %s, and keeps the outbound warning', (_label, blocker, failure) => {
    const run = runVerdict((remote) => {
      remote.db.outboundNonterminalCount = 3;
      blocker(remote);
    });
    expect(run.status).toBe(1);
    expect(run.report).toMatchObject({
      status: 'NOT_READY',
      failures: [failure],
      warnings: ['outboundBacklogEmpty'],
    });
    expect(run.stderr).toContain('WARNING launch-readiness');
  });
});
