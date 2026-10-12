import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(run.stdout).toContain('ops-deploy: readiness window starts at 2026-10-09T12:34:56Z');
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

// Needs the disposable lane DB (CONFIRM_DISPOSABLE_TEST_DB=1, TEST_DATABASE_URL on localhost). Runs the shipped
// dead-letter window SQL, so a regression to coalesce() or a wider window fails here.
const testDbUrl = process.env.TEST_DATABASE_URL ?? '';
if (process.env.CONFIRM_DISPOSABLE_TEST_DB === '1' && /127\.0\.0\.1|localhost/.test(testDbUrl)) {
  describe('dead-letter window SQL (disposable DB)', () => {
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
}

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
