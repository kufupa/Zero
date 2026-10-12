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
// Source-derived pieces: the dead-letter window SQL (with $1 bound to the marker), the marker validator, and the
// marker read block from ops-deploy.sh. Each is run for real below, not string-matched.
const deadLetterWindowSql = script
  .slice(
    script.indexOf('const [workflow] = await sql`') + 'const [workflow] = await sql`'.length,
    script.indexOf('`;\n  const [outbound]'),
  )
  .split('${lastGoodDeployAt}')
  .join('$1');
const markerValidatorSource = script.slice(
  script.indexOf('const rawLastGoodDeployAt ='),
  script.indexOf('const empty = {'),
);
const markerReadBlock = opsDeployScript.slice(
  opsDeployScript.indexOf('  echo "== ops-deploy: read last-good deploy marker =="'),
  opsDeployScript.indexOf('  REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0'),
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

function runVerdict(patch: (remote: Remote) => void = () => {}) {
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
          `set -euo pipefail\nSCRIPT_DIR='${dir}'\n${markerReadBlock}\nprintf 'AT=%s\\n' "\${LAST_GOOD_DEPLOY_AT:-}"`,
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
  *vpn-health-assert*) kind=vpn ;;
  *source-registry-cas.sh*) kind=cas ;;
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
  vpn) sleep "$VPN_DELAY"; exit "$FAIL_VPN" ;;
  cas) exit "$FAIL_CAS" ;;
esac
`;
  const readinessStub = String.raw`#!/usr/bin/env bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ >"$SCRATCH/readiness-started-at"
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
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const run = spawnSync('bash', [join(deployDir, 'ops-deploy.sh'), ...(options.args ?? [])], {
        cwd: deployDir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          SCRATCH: scratch,
          NODE_BIN: process.execPath,
          FAIL_READINESS: '0',
          FAIL_VPN: '0',
          FAIL_CAS: '0',
          VPN_DELAY: '0',
          ...options.env,
        },
      });
      const callsPath = join(scratch, 'calls.log');
      const markerPath = join(scratch, 'home', '.nava-deploy', 'last-good.json');
      const readinessPath = join(scratch, 'readiness-started-at');
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
  async function runWindow(markerAt: string | null, deadLetterAt: Date) {
    const db = postgres(testDbUrl, { max: 1 });
    try {
      // TEMP table: visible only to this session, so the disposable DB keeps no state from the test.
      await db.unsafe(
        'CREATE TEMP TABLE ai_workflow_run (state text NOT NULL, finished_at timestamptz, updated_at timestamptz NOT NULL)',
      );
      await db.unsafe('INSERT INTO ai_workflow_run (state, finished_at, updated_at) VALUES ($1, $2, $2)', [
        'dead_letter',
        deadLetterAt,
      ]);
      const [row] = await db.unsafe(deadLetterWindowSql, [markerAt]);
      return row;
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
