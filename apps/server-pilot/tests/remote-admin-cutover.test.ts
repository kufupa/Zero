import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url);
const cutoverPath = fileURLToPath(
  new URL('../deploy/remote-admin-cutover.sh', here),
);
const expected = {
  account: '845242190536',
  region: 'af-south-1',
  instance: 'i-008f737974a9ba9b3',
  host: 'nava-admin.trynava.io',
  alb: 'nava-remote-admin-alb',
  targetGroup: 'nava-remote-admin',
};
const arns = {
  alb: `arn:aws:elasticloadbalancing:${expected.region}:${expected.account}:loadbalancer/app/${expected.alb}/abc123`,
  targetGroup: `arn:aws:elasticloadbalancing:${expected.region}:${expected.account}:targetgroup/${expected.targetGroup}/def456`,
  listener: `arn:aws:elasticloadbalancing:${expected.region}:${expected.account}:listener/app/${expected.alb}/abc123/ghi789`,
  rule: `arn:aws:elasticloadbalancing:${expected.region}:${expected.account}:listener-rule/app/${expected.alb}/abc123/ghi789/jkl012`,
};

const toBashPath = (path: string) =>
  path
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type FakeRun = {
  status: number | null;
  stderr: string;
  calls: string[];
  readiness: string[];
};

function runFakeCutover(
  action: 'cutover' | 'rollback' | 'restore',
  state: 'pre-registration' | 'active' | 'rollback' | 'broad',
  options: {
    confirmed?: boolean;
    overrides?: Record<string, string>;
  } = {},
): FakeRun {
  const temp = mkdtempSync(join(tmpdir(), 'nava-cutover-test-'));
  const bin = join(temp, 'bin');
  const statePath = join(temp, 'state');
  const awsLogPath = join(temp, 'aws.log');
  const readinessLogPath = join(temp, 'readiness.log');
  const fakeBashPath = join(bin, 'bash');
  const awsPath = join(bin, 'aws');

  try {
    mkdirSync(bin);
    writeFileSync(statePath, state, 'utf8');
    writeFileSync(awsLogPath, '', 'utf8');
    writeFileSync(readinessLogPath, '', 'utf8');
    writeFileSync(
      fakeBashPath,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == */launch-readiness.sh ]]; then
  printf '%s\\n' "\${REMOTE_ADMIN_LIFECYCLE_MODE:-missing}" >> "$FAKE_READINESS_LOG"
  exit 0
fi
REAL_BASH="$(PATH=/usr/bin:/bin command -v bash)"
exec "$REAL_BASH" "$@"
`,
      'utf8',
    );
    writeFileSync(
      awsPath,
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_AWS_LOG"
state="$(<"$FAKE_AWS_STATE")"
default_rule='{"IsDefault":true,"Actions":[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"404"}}]}'
host_rule='{"IsDefault":false,"RuleArn":"${arns.rule}","Priority":"10","Conditions":[{"Field":"host-header","Values":["${expected.host}"]}],"Actions":[{"Type":"forward","TargetGroupArn":"${arns.targetGroup}"}]}'
unexpected_rule='{"IsDefault":false,"RuleArn":"${arns.rule}-unexpected","Priority":"20","Conditions":[{"Field":"path-pattern","Values":["/*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"${arns.targetGroup}"}]}'
healthy_target='{"Target":{"Id":"${expected.instance}","Port":8443},"TargetHealth":{"State":"healthy"}}'
case "$1 $2" in
  "sts get-caller-identity")
    [ "$*" = "sts get-caller-identity --region ${expected.region} --query Account --output text" ] || exit 90
    printf '%s\\n' "${expected.account}"
    ;;
  "elbv2 describe-load-balancers")
    [[ "$*" == *"--region ${expected.region} --names ${expected.alb} --output json"* ]] || exit 91
    printf '{"LoadBalancers":[{"LoadBalancerArn":"${arns.alb}"}]}'
    ;;
  "elbv2 describe-target-groups")
    [[ "$*" == *"--region ${expected.region} --names ${expected.targetGroup} --output json"* ]] || exit 92
    printf '{"TargetGroups":[{"TargetGroupArn":"${arns.targetGroup}"}]}'
    ;;
  "elbv2 describe-listeners")
    [[ "$*" == *"--region ${expected.region} --load-balancer-arn ${arns.alb} --output json"* ]] || exit 93
    printf '{"Listeners":[{"Protocol":"HTTPS","Port":443,"ListenerArn":"${arns.listener}"}]}'
    ;;
  "elbv2 describe-rules")
    [[ "$*" == *"--region ${expected.region} --listener-arn ${arns.listener} --output json"* ]] || exit 94
    case "$state" in
      active) printf '{"Rules":[%s,%s]}' "$default_rule" "$host_rule" ;;
      broad) printf '{"Rules":[%s,%s]}' "$default_rule" "$unexpected_rule" ;;
      *) printf '{"Rules":[%s]}' "$default_rule" ;;
    esac
    ;;
  "elbv2 describe-target-health")
    [[ "$*" == *"--region ${expected.region} --target-group-arn ${arns.targetGroup} --output json"* ]] || exit 95
    case "$state" in
      active|rollback) printf '{"TargetHealthDescriptions":[%s]}' "$healthy_target" ;;
      *) printf '{"TargetHealthDescriptions":[]}' ;;
    esac
    ;;
  "elbv2 register-targets")
    [ "$state" = "pre-registration" ] || exit 96
    [[ "$*" == *"--region ${expected.region} --target-group-arn ${arns.targetGroup} --targets Id=${expected.instance},Port=8443"* ]] || exit 97
    printf 'registered' > "$FAKE_AWS_STATE"
    ;;
  "elbv2 wait")
    [ "$state" = "registered" ] || exit 98
    [[ "$*" == *"target-in-service --region ${expected.region} --target-group-arn ${arns.targetGroup} --targets Id=${expected.instance},Port=8443"* ]] || exit 99
    printf 'rollback' > "$FAKE_AWS_STATE"
    ;;
  "elbv2 create-rule")
    [ "$state" = "rollback" ] || exit 100
    [[ "$*" == *"--region ${expected.region} --listener-arn ${arns.listener} --priority 10 --conditions Field=host-header,Values=${expected.host} --actions Type=forward,TargetGroupArn=${arns.targetGroup} --output json"* ]] || exit 101
    printf 'active' > "$FAKE_AWS_STATE"
    printf '{"Rules":[%s]}' "$host_rule"
    ;;
  "elbv2 delete-rule")
    [ "$state" = "active" ] || exit 102
    [ "$*" = "elbv2 delete-rule --region ${expected.region} --rule-arn ${arns.rule}" ] || exit 103
    printf 'rollback' > "$FAKE_AWS_STATE"
    ;;
  *) exit 104 ;;
esac
`,
      'utf8',
    );
    chmodSync(fakeBashPath, 0o755);
    chmodSync(awsPath, 0o755);

    const realBash = spawnSync('bash', ['-lc', 'command -v bash'], {
      encoding: 'utf8',
    }).stdout.trim();
    if (!realBash) throw new Error('real bash path unavailable');
    const bashSearchPath = `${toBashPath(bin)}:${(process.env.PATH ?? '')
      .split(delimiter)
      .map(toBashPath)
      .join(':')}`;
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `PATH=${shellQuote(bashSearchPath)} exec ${shellQuote(realBash)} ${shellQuote(
          toBashPath(cutoverPath),
        )} ${shellQuote(action)}`,
      ],
      {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_AWS_STATE: toBashPath(statePath),
        FAKE_AWS_LOG: toBashPath(awsLogPath),
        FAKE_READINESS_LOG: toBashPath(readinessLogPath),
        ...(options.confirmed === false
          ? {}
          : { CONFIRM_REMOTE_ADMIN_CUTOVER: '1' }),
        ...options.overrides,
      },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      calls: readFileSync(awsLogPath, 'utf8').trim().split('\n').filter(Boolean),
      readiness: readFileSync(readinessLogPath, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const mutations = (calls: string[]) =>
  calls.filter((call) =>
    /elbv2 (register-targets|create-rule|delete-rule)/.test(call),
  );

const FAKE_AWS_TEST_TIMEOUT_MS = 30_000;

describe('remote-admin cutover executable contract', () => {
  it('refuses missing confirmation before any AWS command', () => {
    const result = runFakeCutover('cutover', 'pre-registration', {
      confirmed: false,
    });

    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it.each([
    ['AWS_REGION', 'us-east-1'],
    ['INSTANCE_ID', 'i-other'],
    ['REMOTE_ADMIN_HOST', 'evil.example'],
    ['REMOTE_ALB_NAME', 'other-alb'],
    ['REMOTE_TARGET_GROUP_NAME', 'other-target-group'],
  ])('rejects overridden %s before AWS invocation', (name, value) => {
    const result = runFakeCutover('cutover', 'pre-registration', {
      overrides: { [name]: value },
    });

    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('cuts over only after strict account and post-registration readbacks', () => {
    const result = runFakeCutover('cutover', 'pre-registration');

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls[0]).toBe(
      `sts get-caller-identity --region ${expected.region} --query Account --output text`,
    );
    expect(mutations(result.calls)).toEqual([
      expect.stringContaining('elbv2 register-targets'),
      expect.stringContaining('elbv2 create-rule'),
    ]);
    const waitIndex = result.calls.findIndex((call) => call.startsWith('elbv2 wait '));
    const readbackIndex = result.calls.findIndex(
      (call, index) => index > waitIndex && call.startsWith('elbv2 describe-rules '),
    );
    const createIndex = result.calls.findIndex((call) => call.startsWith('elbv2 create-rule '));
    expect(readbackIndex).toBeGreaterThan(waitIndex);
    expect(createIndex).toBeGreaterThan(readbackIndex);
    expect(result.readiness).toEqual(['pre-registration', 'rollback', 'active']);
  }, FAKE_AWS_TEST_TIMEOUT_MS);

  it('rolls back by deleting only exact priority-10 host rule then rereads state', () => {
    const result = runFakeCutover('rollback', 'active');

    expect(result.status, result.stderr).toBe(0);
    expect(mutations(result.calls)).toEqual([
      `elbv2 delete-rule --region ${expected.region} --rule-arn ${arns.rule}`,
    ]);
    const deleteIndex = result.calls.findIndex((call) => call.startsWith('elbv2 delete-rule '));
    const readbackIndex = result.calls.findIndex(
      (call, index) => index > deleteIndex && call.startsWith('elbv2 describe-rules '),
    );
    expect(readbackIndex).toBeGreaterThan(deleteIndex);
    expect(result.readiness).toEqual(['active', 'rollback']);
  }, FAKE_AWS_TEST_TIMEOUT_MS);

  it('restores only from healthy rollback state and rereads active state', () => {
    const result = runFakeCutover('restore', 'rollback');

    expect(result.status, result.stderr).toBe(0);
    expect(mutations(result.calls)).toEqual([
      expect.stringContaining('elbv2 create-rule'),
    ]);
    const createIndex = result.calls.findIndex((call) => call.startsWith('elbv2 create-rule '));
    const readbackIndex = result.calls.findIndex(
      (call, index) => index > createIndex && call.startsWith('elbv2 describe-rules '),
    );
    expect(readbackIndex).toBeGreaterThan(createIndex);
    expect(result.readiness).toEqual(['rollback', 'active']);
  }, FAKE_AWS_TEST_TIMEOUT_MS);

  it('blocks broad listener state before every mutation', () => {
    const result = runFakeCutover('rollback', 'broad');

    expect(result.status).not.toBe(0);
    expect(mutations(result.calls)).toEqual([]);
  }, FAKE_AWS_TEST_TIMEOUT_MS);
});
