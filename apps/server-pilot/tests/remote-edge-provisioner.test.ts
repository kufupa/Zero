import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');
const provisionerPath = join(deployDir, 'remote-edge-provisioner.sh');
const stateModulePath = join(deployDir, 'remote-edge-state.mjs');

type FakeMode =
  | 'valid'
  | 'read-error'
  | 'malformed'
  | 'duplicate'
  | 'unsafe'
  | 'global-owner-omitted'
  | 'unexpected-header'
  | 'numbered-header'
  | 'post-divergence';

type Harness = {
  root: string;
  evidenceRoot: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
};

function provisionerExists(): boolean {
  return existsSync(provisionerPath) && existsSync(stateModulePath);
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

function createHarness(mode: FakeMode = 'valid'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'nava-remote-edge-provisioner-'));
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'calls.log');
  const evidenceRoot = join(root, 'evidence');
  const fakeAwsPath = join(root, 'fake-aws.mjs');
  const fakeSsmPath = join(root, 'fake-ssm.mjs');

  writeFileSync(
    statePath,
    JSON.stringify({
      mode,
      targetAttached: false,
      unsafe: mode === 'unsafe',
    }),
    'utf8',
  );
  writeFileSync(logPath, '', 'utf8');

  writeExecutable(
    fakeAwsPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((value) => value !== '--no-cli-pager');
const [service, operation] = args;
const statePath = process.env.REMOTE_EDGE_FAKE_STATE;
const logPath = process.env.REMOTE_EDGE_FAKE_LOG;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
appendFileSync(logPath, 'aws ' + service + ' ' + operation + '\n');

const account = '845242190536';
const vpcId = 'vpc-0f078e17a5f0f8599';
const instanceId = 'i-008f737974a9ba9b3';
const targetIp = '172.31.12.112';
const albSg = 'sg-test-alb';
const targetSg = 'sg-test-target';
const legacySg = 'sg-test-legacy';
const defaultEgress = {
  IpProtocol: '-1',
  IpRanges: [{ CidrIp: '0.0.0.0/0' }],
  Ipv6Ranges: [],
  PrefixListIds: [],
  UserIdGroupPairs: [],
};
const publicHttps = {
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  IpRanges: [{ CidrIp: '0.0.0.0/0' }],
  Ipv6Ranges: [],
  PrefixListIds: [],
  UserIdGroupPairs: [],
};
const albTargetEgress = {
  IpProtocol: 'tcp',
  FromPort: 8443,
  ToPort: 8443,
  IpRanges: [],
  Ipv6Ranges: [],
  PrefixListIds: [],
  UserIdGroupPairs: [{ GroupId: targetSg }],
};
const targetAlbIngress = {
  IpProtocol: 'tcp',
  FromPort: 8443,
  ToPort: 8443,
  IpRanges: [],
  Ipv6Ranges: [],
  PrefixListIds: [],
  UserIdGroupPairs: [{ GroupId: albSg }],
};
const emit = (value) => process.stdout.write(JSON.stringify(value));
const fail = () => process.exit(21);

if (state.mode === 'read-error' && service === 'sts' && operation === 'get-caller-identity') fail();
if (state.mode === 'malformed' && service === 'ec2' && operation === 'describe-instances') {
  emit({ Reservations: 'not-an-array' });
  process.exit(0);
}

if (service === 'ec2' && operation === 'modify-instance-attribute') {
  state.targetAttached = true;
  if (state.mode === 'post-divergence') state.unsafe = true;
  writeFileSync(statePath, JSON.stringify(state));
  emit({});
  process.exit(0);
}

if (
  (service === 'elbv2' && ['register-targets', 'create-rule'].includes(operation)) ||
  (service === 'route53' && operation) ||
  (service === 'elbv2' && operation === 'create-listener' && args.includes('80'))
) {
  appendFileSync(logPath, 'PROHIBITED ' + service + ' ' + operation + '\n');
  process.exit(98);
}

switch (service + ' ' + operation) {
  case 'sts get-caller-identity':
    emit({ Account: account, Arn: 'arn:aws:iam::845242190536:user/fake', UserId: 'fake' });
    break;
  case 'ec2 describe-instances': {
    const groups = [{ GroupId: legacySg, GroupName: 'legacy' }];
    if (state.targetAttached) groups.push({ GroupId: targetSg, GroupName: 'nava-remote-admin-target' });
    emit({
      Reservations: [{
        Instances: [{
          InstanceId: instanceId,
          VpcId: vpcId,
          PrivateIpAddress: targetIp,
          SecurityGroups: groups,
          NetworkInterfaces: [{
            NetworkInterfaceId: 'eni-test-primary',
            Attachment: { DeviceIndex: 0 },
            PrivateIpAddress: targetIp,
            Groups: groups,
          }],
        }],
      }],
    });
    break;
  }
  case 'ec2 describe-network-interfaces': {
    const groups = [{ GroupId: legacySg, GroupName: 'legacy' }];
    if (state.targetAttached) groups.push({ GroupId: targetSg, GroupName: 'nava-remote-admin-target' });
    emit({
      NetworkInterfaces: [{
        NetworkInterfaceId: 'eni-test-primary',
        Attachment: state.mode === 'global-owner-omitted'
          ? { DeviceIndex: 0 }
          : { InstanceId: instanceId, DeviceIndex: 0 },
        Groups: groups,
      }],
    });
    break;
  }
  case 'ec2 describe-security-groups': {
    const legacyIngress = state.unsafe
      ? [{
          IpProtocol: 'tcp',
          FromPort: 8443,
          ToPort: 8443,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          Ipv6Ranges: [],
          PrefixListIds: [],
          UserIdGroupPairs: [],
        }]
      : [];
    const groups = [
      {
        GroupId: legacySg,
        GroupName: 'legacy',
        VpcId: vpcId,
        IpPermissions: legacyIngress,
        IpPermissionsEgress: [defaultEgress],
      },
      {
        GroupId: albSg,
        GroupName: 'nava-remote-admin-alb',
        VpcId: vpcId,
        IpPermissions: [publicHttps],
        IpPermissionsEgress: [albTargetEgress],
      },
      {
        GroupId: targetSg,
        GroupName: 'nava-remote-admin-target',
        VpcId: vpcId,
        IpPermissions: [targetAlbIngress],
        IpPermissionsEgress: [defaultEgress],
      },
    ];
    if (state.mode === 'duplicate') groups.push({ ...groups[2], GroupId: 'sg-test-target-duplicate' });
    emit({ SecurityGroups: groups });
    break;
  }
  case 'ec2 describe-subnets':
    emit({
      Subnets: [
        { SubnetId: 'subnet-0e6446aaaeaa8762e', VpcId: vpcId },
        { SubnetId: 'subnet-094bf8643d98c22f6', VpcId: vpcId },
      ],
    });
    break;
  case 'ec2 describe-route-tables':
    emit({
      RouteTables: [{
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-test' }],
      }],
    });
    break;
  case 'acm list-certificates':
    emit({
      CertificateSummaryList: [{
        DomainName: 'nava-admin.trynava.io',
        CertificateArn: 'arn:aws:acm:af-south-1:845242190536:certificate/test',
      }],
    });
    break;
  case 'acm describe-certificate':
    emit({
      Certificate: {
        DomainName: 'nava-admin.trynava.io',
        Status: 'ISSUED',
        CertificateArn: 'arn:aws:acm:af-south-1:845242190536:certificate/test',
      },
    });
    break;
  case 'elbv2 describe-load-balancers':
    emit({ LoadBalancers: [] });
    break;
  case 'elbv2 describe-target-groups':
    emit({ TargetGroups: [] });
    break;
  case 'wafv2 list-web-acls':
    emit({ WebACLs: [] });
    break;
  case 's3api list-buckets':
    emit({ Buckets: [] });
    break;
  case 's3api get-bucket-cors':
    emit({
      CORSRules: [{
        AllowedOrigins: ['https://nava.legacyhotels.co.za'],
        AllowedMethods: ['GET', 'HEAD'],
      }],
    });
    break;
  default:
    fail();
}
`,
  );

  writeExecutable(
    fakeSsmPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((value) => value !== '--no-cli-pager');
const [service, operation] = args;
const state = JSON.parse(readFileSync(process.env.REMOTE_EDGE_FAKE_STATE, 'utf8'));
const addedHeader = state.mode === 'unexpected-header'
  ? 'Unexpected UFW header:'
  : state.mode === 'numbered-header'
    ? "Added user rules (see 'ufw status numbered'):"
  : "Added user rules (see 'ufw status' for running firewall):";
appendFileSync(process.env.REMOTE_EDGE_FAKE_LOG, 'ssm ' + service + ' ' + operation + '\n');
if (service !== 'ssm') process.exit(22);
if (operation === 'send-command') {
  process.stdout.write(JSON.stringify({ Command: { CommandId: 'command-test' } }));
  process.exit(0);
}
if (operation === 'get-command-invocation') {
  process.stdout.write(JSON.stringify({
    Status: 'Success',
    StandardOutputContent: [
      '__REMOTE_EDGE_UFW_VERBOSE__',
      'Status: active',
      'Default: deny (incoming), allow (outgoing), disabled (routed)',
      '__REMOTE_EDGE_UFW_STATUS__',
      '[ 1] 443/tcp on tun0 ALLOW IN Anywhere',
      '__REMOTE_EDGE_UFW_ADDED__',
      addedHeader,
      'ufw allow in on tun0 to any port 443 proto tcp',
      '__REMOTE_EDGE_SOCKETS__',
      'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
      'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
      'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
      'LISTEN 0 511 172.31.12.112:8443 0.0.0.0:*',
      '__REMOTE_EDGE_ROUTE__',
      'default via 172.31.0.1 dev ens5',
      '',
    ].join('\n'),
    StandardErrorContent: '',
  }));
  process.exit(0);
}
process.exit(23);
`,
  );

  return {
    root,
    evidenceRoot,
    logPath,
    env: {
      ...process.env,
      REMOTE_EDGE_AWS_BIN: fakeAwsPath,
      REMOTE_EDGE_SSM_BIN: fakeSsmPath,
      REMOTE_EDGE_FAKE_STATE: statePath,
      REMOTE_EDGE_FAKE_LOG: logPath,
      AWS_PAGER: '',
    },
  };
}

function destroyHarness(harness: Harness): void {
  rmSync(harness.root, { recursive: true, force: true });
}

type ProvisionerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function runProvisioner(
  harness: Harness,
  args: string[],
): Promise<ProvisionerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'bash',
      [provisionerPath, ...args, '--evidence-root', harness.evidenceRoot],
      {
        cwd: deployDir,
        env: harness.env,
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProvisionerResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish({
        status: null,
        stdout,
        stderr,
        error: new Error('provisioner fixture timed out'),
      });
    }, 30_000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    child.once('close', (status) => {
      finish({ status, stdout, stderr });
    });
  });
}

function loggedCalls(harness: Harness): string[] {
  return readFileSync(harness.logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

function provisionerDiagnostic(
  result: ProvisionerResult,
  harness: Harness,
): string {
  return [
    result.error?.message ?? '',
    result.stderr,
    result.stdout,
    loggedCalls(harness).join('\n'),
  ].join('\n');
}

function strictFinalUnattachedFacts() {
  return {
    version: 1,
    baseline: {
      account: true,
      region: true,
      vpc: true,
      instance: true,
      targetPrivateIp: true,
      subnets: true,
      publicSubnetRoutes: true,
      certificateIssued: true,
      publicAddressPresence: { ipv4: true, ipv6: true },
    },
    counts: {
      alb: 0,
      targetGroup: 0,
      albSecurityGroup: 1,
      targetSecurityGroup: 1,
      waf: 0,
      logBucket: 0,
    },
    security: {
      stage: 'final',
      targetAttached: false,
      targetAttachmentExact: false,
      legacyIngressSafe: true,
      unexpectedAttachment: false,
      unexpectedPermission: false,
    },
    targetGroupStage: 'absent',
    albStage: 'absent',
    bucketStage: 'absent',
    wafStage: 'absent',
    listenerStage: 'absent',
    host: {
      ufwStage: 'none',
      ufwSafe: true,
      legacyTunnel443Exact: true,
      defaultRouteOffTun0: true,
      listenerSafe: true,
    },
    logDeliveryProof: false,
  };
}

describe('remote edge provisioner', () => {
  it('adds the narrow executable provisioner and pure state module', () => {
    expect(existsSync(provisionerPath)).toBe(true);
    expect(existsSync(stateModulePath)).toBe(true);
  });

  it('treats public-address presence as observation and maps final unattached SG state to attachment', () => {
    if (!provisionerExists()) return;
    const moduleUrl = pathToFileURL(stateModulePath).href;
    const facts = strictFinalUnattachedFacts();
    const encodedFacts = Buffer.from(JSON.stringify(facts)).toString('base64');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          `import { classifyFacts } from ${JSON.stringify(moduleUrl)};`,
          `const facts = JSON.parse(Buffer.from(${JSON.stringify(encodedFacts)}, 'base64').toString('utf8'));`,
          'const result = classifyFacts(facts);',
          "if (result.stage !== 'SG_FINAL_UNATTACHED' || result.action !== 'ATTACH_TARGET_SECURITY_GROUP') process.exit(3);",
          'facts.unexpectedExtra = true;',
          'let rejected = false;',
          'try { classifyFacts(facts); } catch { rejected = true; }',
          'if (!rejected) process.exit(4);',
          'delete facts.unexpectedExtra;',
          'facts.baseline.publicAddressPresence = { ipv4: false, ipv6: false };',
          'const withoutPublicAddress = classifyFacts(facts);',
          "if (withoutPublicAddress.stage !== 'SG_FINAL_UNATTACHED') process.exit(5);",
          'delete facts.baseline.publicAddressPresence;',
          'rejected = false;',
          'try { classifyFacts(facts); } catch { rejected = true; }',
          'if (!rejected) process.exit(6);',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it.each<FakeMode>([
    'valid',
    'numbered-header',
  ])(
    'inspects fresh state through explicit fake AWS and SSM binaries for %s UFW header',
    async (mode) => {
      if (!provisionerExists()) return;
      const harness = createHarness(mode);
      try {
        const first = await runProvisioner(harness, ['inspect']);
        const second = await runProvisioner(harness, ['inspect']);

        expect(first.status, provisionerDiagnostic(first, harness)).toBe(0);
        expect(second.status, provisionerDiagnostic(second, harness)).toBe(0);
        expect(JSON.parse(first.stdout)).toEqual({
          stage: 'SG_FINAL_UNATTACHED',
          action: 'ATTACH_TARGET_SECURITY_GROUP',
        });
        expect(first.stdout).not.toContain('sg-test');
        expect(first.stdout).not.toContain('0.0.0.0');
        const calls = loggedCalls(harness);
        expect(calls.filter((call) => call === 'aws sts get-caller-identity')).toHaveLength(2);
        expect(calls.filter((call) => call === 'ssm ssm send-command')).toHaveLength(2);
        expect(calls.filter((call) => call === 'aws ec2 modify-instance-attribute')).toHaveLength(0);
      } finally {
        destroyHarness(harness);
      }
    },
    60_000,
  );

  it('collects fresh facts before and after one allowed target-SG attachment', async () => {
    if (!provisionerExists()) return;
    const harness = createHarness();
    try {
      const result = await runProvisioner(harness, [
        'apply-one',
        '--action',
        'ATTACH_TARGET_SECURITY_GROUP',
      ]);

      expect(result.status, provisionerDiagnostic(result, harness)).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        stage: 'TARGET_SG_ATTACHED',
        action: 'CREATE_TARGET_GROUP',
      });
      const calls = loggedCalls(harness);
      expect(calls.filter((call) => call === 'aws sts get-caller-identity')).toHaveLength(2);
      expect(calls.filter((call) => call === 'ssm ssm send-command')).toHaveLength(2);
      expect(calls.filter((call) => call === 'aws ec2 modify-instance-attribute')).toHaveLength(1);
      expect(calls.some((call) => call.startsWith('PROHIBITED '))).toBe(false);

      const evidenceFiles = readdirSync(harness.evidenceRoot);
      expect(evidenceFiles.length).toBeGreaterThan(0);
      for (const file of evidenceFiles) {
        const contents = readFileSync(join(harness.evidenceRoot, file), 'utf8');
        expect(contents).not.toContain('sg-test');
        expect(contents).not.toContain('arn:aws');
        if (process.platform !== 'win32') {
          expect(statSync(join(harness.evidenceRoot, file)).mode & 0o777).toBe(0o600);
        }
      }
      if (process.platform !== 'win32') {
        expect(statSync(harness.evidenceRoot).mode & 0o777).toBe(0o700);
      }
      const source = readFileSync(provisionerPath, 'utf8');
      expect(source).toContain('assert_safe_evidence_root');
      expect(source).toContain('mkdir -m 700 -- "$EVIDENCE_ROOT"');
      expect(source).toContain('chmod 600 -- "$temporary"');
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('blocks wrong actions and ignores supplied historical facts', async () => {
    if (!provisionerExists()) return;
    const harness = createHarness();
    try {
      const wrongAction = await runProvisioner(harness, [
        'apply-one',
        '--action',
        'CREATE_TARGET_GROUP',
      ]);
      expect(wrongAction.status).not.toBe(0);

      const manualFacts = await runProvisioner(harness, [
        'apply-one',
        '--action',
        'ATTACH_TARGET_SECURITY_GROUP',
        '--facts',
        join(harness.root, 'stale-facts.json'),
      ]);
      expect(manualFacts.status).not.toBe(0);

      const calls = loggedCalls(harness);
      expect(calls.filter((call) => call === 'aws ec2 modify-instance-attribute')).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it.each<FakeMode>([
    'read-error',
    'malformed',
    'duplicate',
    'unsafe',
    'global-owner-omitted',
    'unexpected-header',
  ])(
    'fails closed before mutation for %s collection state',
    async (mode) => {
      if (!provisionerExists()) return;
      const harness = createHarness(mode);
      try {
        const result = await runProvisioner(harness, [
          'apply-one',
          '--action',
          'ATTACH_TARGET_SECURITY_GROUP',
        ]);
        expect(result.status).not.toBe(0);
        expect(loggedCalls(harness).filter((call) => call === 'aws ec2 modify-instance-attribute')).toHaveLength(0);
      } finally {
        destroyHarness(harness);
      }
    },
    60_000,
  );

  it('fails closed when post-mutation fresh readback diverges', async () => {
    if (!provisionerExists()) return;
    const harness = createHarness('post-divergence');
    try {
      const result = await runProvisioner(harness, [
        'apply-one',
        '--action',
        'ATTACH_TARGET_SECURITY_GROUP',
      ]);
      expect(result.status).not.toBe(0);
      const calls = loggedCalls(harness);
      expect(calls.filter((call) => call === 'aws sts get-caller-identity')).toHaveLength(2);
      expect(calls.filter((call) => call === 'aws ec2 modify-instance-attribute')).toHaveLength(1);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('has no Task 5/public-listener mutation and permits bounded log-proof prefix reads', () => {
    if (!provisionerExists()) return;
    const source = readFileSync(provisionerPath, 'utf8');
    for (const forbidden of [
      'register-targets',
      'create-rule',
      'route53',
      'change-resource-record-sets',
      'host-forward',
      'apply-all',
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    expect(source).toContain('for ((');
    expect(source).toContain(
      'fresh_log_proof_prefixes "$not_before" "$now" >"$prefixes" || die',
    );
    expect(source).toContain(
      'if (prefixes.length === 0 || prefixes.length > 2) process.exit(2);',
    );
    expect(source).toContain('while IFS= read -r prefix; do');
    expect(source).toContain('done <"$prefixes"');
    expect(source.match(/\bwhile\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/create-listener[\s\S]{0,300}--protocol HTTP[\s\S]{0,100}--port 80/);
  });
});
