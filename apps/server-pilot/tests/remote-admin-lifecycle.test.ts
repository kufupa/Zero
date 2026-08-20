import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyRemoteAdminLifecycle,
  expectedRemoteAdminLifecycleAfter,
} from '../deploy/remote-admin-lifecycle.mjs';

const REMOTE_HOST = 'nava-admin.trynava.io';
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:af-south-1:845242190536:targetgroup/nava-remote-admin/test';
const RULE_ARN =
  'arn:aws:elasticloadbalancing:af-south-1:845242190536:listener-rule/app/nava-remote-admin-alb/test/test';

const fixed404DefaultRule = {
  IsDefault: true,
  Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
};

const healthyTarget = {
  Target: { Id: 'i-008f737974a9ba9b3', Port: 8443 },
  TargetHealth: { State: 'healthy' },
};

const exactHostForwardRule = {
  IsDefault: false,
  RuleArn: RULE_ARN,
  Priority: '10',
  Conditions: [{ Field: 'host-header', Values: [REMOTE_HOST] }],
  Actions: [{ Type: 'forward', TargetGroupArn: TARGET_GROUP_ARN }],
};

function classify(input: {
  targets: unknown[];
  nonDefaultRules?: unknown[];
}) {
  return classifyRemoteAdminLifecycle({
    targetGroupArn: TARGET_GROUP_ARN,
    listenerRules: {
      Rules: [fixed404DefaultRule, ...(input.nonDefaultRules ?? [])],
    },
    targetHealth: { TargetHealthDescriptions: input.targets },
  });
}

function runReadiness(
  mode: 'pre-registration' | 'active' | 'rollback' | 'auto',
  facts: Record<string, boolean>,
) {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(here, '..', 'deploy', 'launch-readiness.sh'),
    'utf8',
  ).replaceAll('\r\n', '\n');
  const block = source.match(
    /# BEGIN_READINESS_REPORT_BUILDER\r?\n([\s\S]*?)# END_READINESS_REPORT_BUILDER/,
  )?.[1];
  if (!block) throw new Error('readiness report builder missing');

  const remote = {
    health: { http: true, https: true, tls: true },
    pm2: {
      required: {
        http: { present: true, online: true, restarts: 0 },
        worker: { present: true, online: true, restarts: 0 },
        'ai-worker': { present: true, online: true, restarts: 0 },
      },
      allOnline: true,
    },
    hotelProbe: true,
    firewall: {
      statusRead: true,
      rulesRead: true,
      active: true,
      defaultDeny: true,
      tunnel443: true,
      broad443Absent: true,
      remoteAlb8443Only: true,
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
      centurionActiveCategoryCount: 5,
      workflowNonterminalCount: 0,
      workflowDeadLetterCount: 0,
      workflowDeadLetterRecentCount: 0,
      outboundNonterminalCount: 0,
      latestInboundAt: null,
      counts: { threads: 0, messages: 0, inboundMessages: 0 },
    },
    disk: { safe: true, usedPercent: 10, freeMB: 10_000 },
  };
  const instanceNetwork = {
    securityGroups: [{ GroupId: 'sg-012345678' }, { GroupId: 'sg-012345679' }],
    networkInterfaces: [
      {
        id: 'eni-primary',
        deviceIndex: 0,
        securityGroups: [{ GroupId: 'sg-012345678' }, { GroupId: 'sg-012345679' }],
        publicIpv4: null,
        ipv6: [],
      },
    ],
    publicIpv4: [],
    ipv6: [],
  };
  const securityGroups = [
    { id: 'sg-012345678', ingress: [] },
    {
      id: 'sg-012345679',
      ingress: [
        {
          IpProtocol: 'tcp',
          FromPort: 8443,
          ToPort: 8443,
          UserIdGroupPairs: [{ GroupId: 'sg-012345670' }],
        },
      ],
    },
  ];
  const cors = {
    CORSRules: [
      {
        AllowedOrigins: ['https://nava.legacyhotels.co.za', `https://${REMOTE_HOST}`],
        AllowedMethods: ['GET', 'HEAD'],
      },
    ],
  };
  const result = spawnSync('bash', [], {
    encoding: 'utf8',
    input: `${block}\nbuild_readiness_report\n`,
    env: {
      ...process.env,
      REMOTE_JSON: JSON.stringify(remote),
      RDS_JSON: JSON.stringify({
        status: 'available',
        deletionProtection: true,
        backupRetentionDays: 7,
        backupLatestRestorableAt: '2026-08-14T00:00:00.000Z',
      }),
      S3_AVAILABLE: 'true',
      S3_VERSIONING: 'Enabled',
      S3_LIFECYCLE: '[]',
      CLOUDWATCH_ALARM_COUNT: '0',
      SNS_TOPIC_COUNT: '0',
      S3_CORS: JSON.stringify(cors),
      S3_PUBLIC_ACCESS: JSON.stringify({
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      }),
      INSTANCE_NETWORK: JSON.stringify(instanceNetwork),
      SG_STATE: JSON.stringify(securityGroups),
      INSTANCE_NETWORK_OK: 'true',
      SG_QUERY_OK: 'true',
      S3_CORS_OK: 'true',
      S3_PUBLIC_ACCESS_OK: 'true',
      REMOTE_ADMIN_MODE: '1',
      REMOTE_TARGET_HEALTH_REQUIRED: '0',
      REMOTE_ADMIN_LIFECYCLE_MODE: mode,
      REMOTE_ADMIN_FACTS: JSON.stringify(facts),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('remote-admin lifecycle', () => {
  it.each([
    ['pre-registration', { targets: [] }],
    ['active', { targets: [healthyTarget], nonDefaultRules: [exactHostForwardRule] }],
    ['rollback', { targets: [healthyTarget] }],
  ] as const)('classifies exact %s ALB shapes', (expected, input) => {
    expect(classify(input)).toMatchObject({ state: expected });
  });

  it('fails closed for broad or mixed target and listener shapes', () => {
    expect(
      classify({
        targets: [healthyTarget],
        nonDefaultRules: [
          exactHostForwardRule,
          { ...exactHostForwardRule, RuleArn: `${RULE_ARN}-unexpected`, Priority: '20' },
        ],
      }),
    ).toMatchObject({ state: 'unknown' });
    expect(
      classify({
        targets: [
          healthyTarget,
          { Target: { Id: 'i-other', Port: 8443 }, TargetHealth: { State: 'healthy' } },
        ],
      }),
    ).toMatchObject({ state: 'unknown' });
  });

  it('permits only cutover, rollback, and restore lifecycle transitions', () => {
    expect(expectedRemoteAdminLifecycleAfter('pre-registration', 'cutover')).toBe('active');
    expect(expectedRemoteAdminLifecycleAfter('active', 'rollback')).toBe('rollback');
    expect(expectedRemoteAdminLifecycleAfter('rollback', 'restore')).toBe('active');
    expect(() => expectedRemoteAdminLifecycleAfter('active', 'cutover')).toThrow();
    expect(() => expectedRemoteAdminLifecycleAfter('rollback', 'rollback')).toThrow();
  });

  it.each([
    [
      'pre-registration',
      {
        preRegistrationClean: true,
        noNonDefaultListenerRules: true,
        hostForwardExact: false,
        targetHealthy: false,
      },
    ],
    [
      'active',
      {
        preRegistrationClean: false,
        noNonDefaultListenerRules: false,
        hostForwardExact: true,
        targetHealthy: true,
      },
    ],
    [
      'rollback',
      {
        preRegistrationClean: false,
        noNonDefaultListenerRules: true,
        hostForwardExact: false,
        targetHealthy: true,
      },
    ],
  ] as const)('runs explicit readiness mode %s', (mode, lifecycleFacts) => {
    const report = runReadiness(mode, {
      resourcesResolved: true,
      targetGroupConfigured: true,
      listenerDefault404: true,
      targetSecurityGroupOnlyAlb: true,
      noDirectPublicTargetPath: true,
      logBucketCompliant: true,
      wafCompliant: true,
      ...lifecycleFacts,
    });
    expect(report.status).toBe('READY');
    expect(report.observations.remoteAdmin.detectedState).toBe(mode);
  });

  it('makes auto readiness reject unknown lifecycle state', () => {
    const report = runReadiness('auto', {
      resourcesResolved: true,
      targetGroupConfigured: true,
      listenerDefault404: true,
      targetSecurityGroupOnlyAlb: true,
      noDirectPublicTargetPath: true,
      logBucketCompliant: true,
      wafCompliant: true,
      preRegistrationClean: false,
      noNonDefaultListenerRules: false,
      hostForwardExact: false,
      targetHealthy: true,
    });
    expect(report.status).toBe('NOT_READY');
    expect(report.checks.remoteLifecycleStateKnown).toBe(false);
    expect(report.observations.remoteAdmin.detectedState).toBe('unknown');
  });

  it('keeps cutover mutations limited and readiness-gated', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'remote-admin-cutover.sh'), 'utf8');

    expect(script).toContain('register-targets');
    expect(script).toContain('create-rule');
    expect(script).toContain('--priority 10');
    expect(script).toContain('Field=host-header,Values=$REMOTE_ADMIN_HOST');
    expect(script).toContain('delete-rule');
    expect(script).toContain('run_readiness rollback');
    expect(script).toContain('run_readiness active');
    expect(script).not.toMatch(
      /deregister-targets|delete-listener|modify-listener|change-resource-record-sets/,
    );
  });

  it('uses lifecycle-safe readiness after normal deploy, restart, and reboot', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const scriptName of ['ops-deploy.sh', 'ops-restart.sh', 'ops-reboot.sh']) {
      const script = readFileSync(join(here, '..', 'deploy', scriptName), 'utf8');
      expect(script, scriptName).toContain(
        'REMOTE_ADMIN_LIFECYCLE_MODE=auto',
      );
      expect(script, scriptName).toContain('REMOTE_ADMIN_MODE=1');
    }
  });
});
