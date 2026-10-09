import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Everything above the marker only collects AWS and host facts. The marker starts the report builder, the verdict
// and the exit code, so this test runs that part on fixture facts and never calls AWS or the remote host.
const script = readFileSync(
  fileURLToPath(new URL('../deploy/launch-readiness.sh', import.meta.url)),
  'utf8',
);
const verdict = script.slice(script.indexOf('# BEGIN_READINESS_REPORT_BUILDER'));

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
      workflowDeadLetterRecentCount: 0,
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

describe('launch-readiness verdict', () => {
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
