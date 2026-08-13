import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');
const provisionerPath = join(deployDir, 'remote-edge-provisioner.sh');
const stateModulePath = join(deployDir, 'remote-edge-state.mjs');

const STAGES = [
  ['FRESH', 'CREATE_ALB_SECURITY_GROUP', 'ALB_SG_CREATED'],
  ['ALB_SG_CREATED', 'CREATE_TARGET_SECURITY_GROUP', 'SGS_CREATED'],
  ['SGS_CREATED', 'AUTHORIZE_ALB_HTTPS_INGRESS', 'ALB_INGRESS_READY'],
  ['ALB_INGRESS_READY', 'REVOKE_ALB_DEFAULT_EGRESS', 'ALB_EGRESS_REVOKED'],
  ['ALB_EGRESS_REVOKED', 'AUTHORIZE_ALB_TARGET_EGRESS', 'ALB_EGRESS_READY'],
  ['ALB_EGRESS_READY', 'AUTHORIZE_TARGET_ALB_INGRESS', 'SG_FINAL_UNATTACHED'],
  ['SG_FINAL_UNATTACHED', 'ATTACH_TARGET_SECURITY_GROUP', 'TARGET_SG_ATTACHED'],
  ['TARGET_SG_ATTACHED', 'CREATE_TARGET_GROUP', 'TARGET_GROUP_CREATED'],
  ['TARGET_GROUP_CREATED', 'SET_TARGET_GROUP_DEREGISTRATION_DELAY', 'TARGET_GROUP_READY'],
  ['TARGET_GROUP_READY', 'CREATE_ALB', 'ALB_CREATED'],
  ['ALB_CREATED', 'CREATE_LOG_BUCKET', 'LOG_BUCKET_CREATED'],
  ['LOG_BUCKET_CREATED', 'BLOCK_LOG_BUCKET_PUBLIC_ACCESS', 'LOG_BUCKET_PUBLIC_BLOCKED'],
  ['LOG_BUCKET_PUBLIC_BLOCKED', 'ENFORCE_LOG_BUCKET_OWNERSHIP', 'LOG_BUCKET_OWNERSHIP_ENFORCED'],
  ['LOG_BUCKET_OWNERSHIP_ENFORCED', 'SET_LOG_BUCKET_AES256', 'LOG_BUCKET_ENCRYPTED'],
  ['LOG_BUCKET_ENCRYPTED', 'SET_LOG_BUCKET_LIFECYCLE', 'LOG_BUCKET_LIFECYCLE_READY'],
  ['LOG_BUCKET_LIFECYCLE_READY', 'SET_LOG_BUCKET_POLICY', 'LOG_BUCKET_POLICY_READY'],
  ['LOG_BUCKET_POLICY_READY', 'ENABLE_ALB_LOGGING', 'ALB_LOGGING_READY'],
  ['ALB_LOGGING_READY', 'CREATE_WAF', 'WAF_CREATED'],
  ['WAF_CREATED', 'ASSOCIATE_WAF', 'WAF_ASSOCIATED'],
  ['WAF_ASSOCIATED', 'CREATE_FIXED_404_LISTENER', 'LISTENER_FIXED_404'],
  ['LISTENER_FIXED_404', 'ALLOW_UFW_SUBNET_A', 'UFW_SUBNET_A_READY'],
  ['UFW_SUBNET_A_READY', 'ALLOW_UFW_SUBNET_B', 'UFW_READY'],
  ['UFW_READY', 'PROVE_ALB_LOG_DELIVERY', 'TASK4_PRE_GATE_B_READY'],
] as const;

type Stage = (typeof STAGES)[number][0];
type Mode =
  | 'valid'
  | 'pending-ssm'
  | 'stuck-ssm'
  | 'ufw-shorthand'
  | 'ufw-status-shorthand'
  | 'ufw-status-missing'
  | 'ufw-verbose-default-only'
  | 'ufw-ipv6-display-companion'
  | 'ufw-broad-rule'
  | 'ufw-duplicate-rule'
  | 'udp-8443-listener'
  | 'legacy-public-ingress'
  | 'legacy-secondary-public-ingress'
  | 'secondary-eni-missing-global'
  | 'secondary-eni-group-mismatch-global'
  | 'non-alb-eni'
  | 'single-alb-eni'
  | 'bucket-broad-principal'
  | 'log-proof-failure'
  | 'log-proof-boundary'
  | 'log-proof-wrong-key'
  | 'log-proof-invalid-time'
  | 'log-proof-invalid-ip'
  | 'log-proof-directory-mismatch'
  | 'log-proof-differing-delivery-date'
  | 'log-proof-test-token'
  | 'log-proof-health-token'
  | 'log-proof-connection-token'
  | 'log-proof-official-token'
  | 'alb-log-prefix'
  | 'alb-log-prefix-missing'
  | 'alb-log-prefix-malformed'
  | 'alb-provisioning'
  | 'alb-stuck-provisioning'
  | 'public-address-safe'
  | 'public-address-broad-ingress'
  | 'public-address-wrong-ufw'
  | 'public-address-public-listener'
  | 'public-address-ipv6-listener';

type Harness = {
  root: string;
  awsPath: string;
  statePath: string;
  evidenceRoot: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
};

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

function createHarness(stage: Stage, mode: Mode = 'valid'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'nava-remote-edge-security-'));
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'calls.log');
  const evidenceRoot = join(root, 'evidence');
  const awsPath = join(root, 'fake-aws.mjs');
  const ssmPath = join(root, 'fake-ssm.mjs');
  const curlPath = join(root, 'fake-curl.mjs');
  const datePath = join(root, 'fake-date.sh');

  writeFileSync(
    statePath,
    JSON.stringify({
      stage,
      mode,
      commandCounter: 0,
      commands: {},
      polls: {},
      albPolls: 0,
    }),
    'utf8',
  );
  writeFileSync(logPath, '', 'utf8');

  writeExecutable(
    awsPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((value) => value !== '--no-cli-pager');
const [service, operation] = args;
const statePath = process.env.REMOTE_EDGE_FAKE_STATE;
const logPath = process.env.REMOTE_EDGE_FAKE_LOG;
const state = JSON.parse(readFileSync(statePath, 'utf8'));

const account = '845242190536';
const region = 'af-south-1';
const vpc = 'vpc-0f078e17a5f0f8599';
const instance = 'i-008f737974a9ba9b3';
const targetIp = '172.31.12.112';
const albName = 'nava-remote-admin-alb';
const targetName = 'nava-remote-admin-target';
const targetGroupName = 'nava-remote-admin';
const wafName = 'nava-remote-admin-waf';
const bucket = 'nava-zero-remote-alb-logs-845242190536-af-south-1';
const albSg = 'sg-test-alb';
const targetSg = 'sg-test-target';
const legacySg = 'sg-test-legacy';
const legacySecondarySg = 'sg-test-legacy-secondary';
const albArn = 'arn:aws:elasticloadbalancing:af-south-1:845242190536:loadbalancer/app/nava-remote-admin-alb/test';
const targetGroupArn = 'arn:aws:elasticloadbalancing:af-south-1:845242190536:targetgroup/nava-remote-admin/test';
const wafArn = 'arn:aws:wafv2:af-south-1:845242190536:regional/webacl/nava-remote-admin-waf/test';
const certArn = 'arn:aws:acm:af-south-1:845242190536:certificate/test';
const stages = [
  'FRESH', 'ALB_SG_CREATED', 'SGS_CREATED', 'ALB_INGRESS_READY',
  'ALB_EGRESS_REVOKED', 'ALB_EGRESS_READY', 'SG_FINAL_UNATTACHED',
  'TARGET_SG_ATTACHED', 'TARGET_GROUP_CREATED', 'TARGET_GROUP_READY',
  'ALB_CREATED', 'LOG_BUCKET_CREATED', 'LOG_BUCKET_PUBLIC_BLOCKED',
  'LOG_BUCKET_OWNERSHIP_ENFORCED', 'LOG_BUCKET_ENCRYPTED',
  'LOG_BUCKET_LIFECYCLE_READY', 'LOG_BUCKET_POLICY_READY',
  'ALB_LOGGING_READY', 'WAF_CREATED', 'WAF_ASSOCIATED',
  'LISTENER_FIXED_404', 'UFW_SUBNET_A_READY', 'UFW_READY',
  'TASK4_PRE_GATE_B_READY',
];

const index = (name) => stages.indexOf(name);
const at = (name) => index(state.stage) >= index(name);
const publicAddressMode = state.mode.startsWith('public-address-');
const save = () => writeFileSync(statePath, JSON.stringify(state));
const log = (line) => appendFileSync(logPath, line + '\n');
const emit = (value) => process.stdout.write(JSON.stringify(value));
const fail = () => process.exit(21);
const mutation = (expected, next, label) => {
  if (state.stage !== expected || option('--region') !== region) fail();
  state.stage = next;
  save();
  log('mutate ' + label);
  emit({});
  process.exit(0);
};
const absent = (message) => {
  process.stderr.write(message);
  process.exit(22);
};
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const requireOptions = (expected) => {
  if (Object.entries(expected).some(([name, value]) => option(name) !== value)) {
    log('invalid options ' + JSON.stringify(args));
    fail();
  }
};
const fileJson = (name) => {
  const value = option(name);
  if (typeof value !== 'string' || !value.startsWith('file://')) {
    log('invalid file option ' + JSON.stringify(args));
    fail();
  }
  try {
    const path = value.slice('file://'.length);
    const nativePath =
      process.platform === 'win32' && path.startsWith('/')
        ? process.env.REMOTE_EDGE_NATIVE_TMP + path.slice('/tmp'.length)
        : path;
    return JSON.parse(readFileSync(nativePath, 'utf8'));
  } catch (error) {
    log('unreadable file option ' + value + ' ' + String(error));
    fail();
  }
};
const exactJson = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

log('aws ' + service + ' ' + operation);

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
const bucketPolicy = () => {
  const principal = { Service: 'logdelivery.elasticloadbalancing.amazonaws.com' };
  if (state.mode === 'bucket-broad-principal') principal.AWS = '*';
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowAlbLogDeliveryWrite',
        Effect: 'Allow',
        Principal: principal,
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::' + bucket + '/AWSLogs/' + account + '/*',
        Condition: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': albArn },
        },
      },
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: ['arn:aws:s3:::' + bucket, 'arn:aws:s3:::' + bucket + '/*'],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  };
};
const waf = () => ({
  WebACL: {
    Name: wafName,
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: [
      {
        Name: 'AWS-AmazonIpReputation',
        Priority: 10,
        OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesAmazonIpReputationList' } },
      },
      {
        Name: 'AWS-Common',
        Priority: 20,
        OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } },
      },
      {
        Name: 'AWS-KnownBadInputs',
        Priority: 30,
        OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesKnownBadInputsRuleSet' } },
      },
      {
        Name: 'signin-25-per-5m',
        Priority: 40,
        Action: { Block: {} },
        Statement: {
          RateBasedStatement: {
            Limit: 25,
            AggregateKeyType: 'IP',
            EvaluationWindowSec: 300,
            ScopeDownStatement: {
              AndStatement: {
                Statements: [
                  {
                    ByteMatchStatement: {
                      SearchString: '/api/auth/sign-in/email',
                      FieldToMatch: { UriPath: {} },
                      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                      PositionalConstraint: 'EXACTLY',
                    },
                  },
                  {
                    ByteMatchStatement: {
                      SearchString: 'POST',
                      FieldToMatch: { Method: {} },
                      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                      PositionalConstraint: 'EXACTLY',
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        Name: 'remote-plane-1000-per-5m',
        Priority: 50,
        Action: { Block: {} },
        Statement: { RateBasedStatement: { Limit: 1000, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } },
      },
    ],
  },
});

if (service === 'ec2' && operation === 'create-security-group') {
  if (option('--group-name') === albName) {
    requireOptions({
      '--vpc-id': vpc,
      '--group-name': albName,
      '--description': 'Nava remote admin ALB ingress only',
    });
    mutation('FRESH', 'ALB_SG_CREATED', 'ec2 create-security-group');
  }
  if (option('--group-name') === targetName) {
    requireOptions({
      '--vpc-id': vpc,
      '--group-name': targetName,
      '--description': 'Nava remote admin target only',
    });
    mutation('ALB_SG_CREATED', 'SGS_CREATED', 'ec2 create-security-group');
  }
  fail();
}
if (service === 'ec2' && operation === 'authorize-security-group-ingress') {
  if (state.stage === 'SGS_CREATED') {
    requireOptions({
      '--group-id': albSg,
      '--ip-permissions': 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]',
    });
    mutation('SGS_CREATED', 'ALB_INGRESS_READY', 'ec2 authorize-security-group-ingress');
  }
  if (state.stage === 'ALB_EGRESS_READY') {
    requireOptions({
      '--group-id': targetSg,
      '--ip-permissions': 'IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=sg-test-alb}]',
    });
    mutation('ALB_EGRESS_READY', 'SG_FINAL_UNATTACHED', 'ec2 authorize-security-group-ingress');
  }
  fail();
}
if (service === 'ec2' && operation === 'revoke-security-group-egress') {
  requireOptions({
    '--group-id': albSg,
    '--ip-permissions': 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]',
  });
  mutation('ALB_INGRESS_READY', 'ALB_EGRESS_REVOKED', 'ec2 revoke-security-group-egress');
}
if (service === 'ec2' && operation === 'authorize-security-group-egress') {
  requireOptions({
    '--group-id': albSg,
    '--ip-permissions': 'IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=sg-test-target}]',
  });
  mutation('ALB_EGRESS_REVOKED', 'ALB_EGRESS_READY', 'ec2 authorize-security-group-egress');
}
if (service === 'ec2' && operation === 'modify-instance-attribute') {
  if (
    option('--instance-id') !== instance ||
    args.slice(args.indexOf('--groups') + 1).join(',') !== legacySg + ',' + targetSg
  ) {
    fail();
  }
  mutation('SG_FINAL_UNATTACHED', 'TARGET_SG_ATTACHED', 'ec2 modify-instance-attribute');
}
if (service === 'elbv2' && operation === 'create-target-group') {
  requireOptions({
    '--name': targetGroupName,
    '--protocol': 'HTTP',
    '--port': '8443',
    '--vpc-id': vpc,
    '--health-check-protocol': 'HTTP',
    '--health-check-path': '/health',
    '--matcher': 'HttpCode=200',
    '--target-type': 'instance',
  });
  mutation('TARGET_SG_ATTACHED', 'TARGET_GROUP_CREATED', 'elbv2 create-target-group');
}
if (service === 'elbv2' && operation === 'modify-target-group-attributes') {
  requireOptions({
    '--target-group-arn': targetGroupArn,
    '--attributes': 'Key=deregistration_delay.timeout_seconds,Value=30',
  });
  mutation('TARGET_GROUP_CREATED', 'TARGET_GROUP_READY', 'elbv2 modify-target-group-attributes');
}
if (service === 'elbv2' && operation === 'create-load-balancer') {
  requireOptions({
    '--name': albName,
    '--scheme': 'internet-facing',
    '--type': 'application',
    '--ip-address-type': 'ipv4',
    '--security-groups': albSg,
  });
  if (args.slice(args.indexOf('--subnets') + 1, args.indexOf('--security-groups')).join(',') !== 'subnet-0e6446aaaeaa8762e,subnet-094bf8643d98c22f6') fail();
  mutation('TARGET_GROUP_READY', 'ALB_CREATED', 'elbv2 create-load-balancer');
}
if (service === 's3api' && operation === 'create-bucket') {
  requireOptions({
    '--region': region,
    '--bucket': bucket,
    '--create-bucket-configuration': 'LocationConstraint=af-south-1',
  });
  mutation('ALB_CREATED', 'LOG_BUCKET_CREATED', 's3api create-bucket');
}
if (service === 's3api' && operation === 'put-public-access-block') {
  requireOptions({
    '--bucket': bucket,
    '--public-access-block-configuration': 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
  });
  mutation('LOG_BUCKET_CREATED', 'LOG_BUCKET_PUBLIC_BLOCKED', 's3api put-public-access-block');
}
if (service === 's3api' && operation === 'put-bucket-ownership-controls') {
  requireOptions({
    '--bucket': bucket,
    '--ownership-controls': '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}',
  });
  mutation('LOG_BUCKET_PUBLIC_BLOCKED', 'LOG_BUCKET_OWNERSHIP_ENFORCED', 's3api put-bucket-ownership-controls');
}
if (service === 's3api' && operation === 'put-bucket-encryption') {
  requireOptions({
    '--bucket': bucket,
    '--server-side-encryption-configuration': '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}',
  });
  mutation('LOG_BUCKET_OWNERSHIP_ENFORCED', 'LOG_BUCKET_ENCRYPTED', 's3api put-bucket-encryption');
}
if (service === 's3api' && operation === 'put-bucket-lifecycle-configuration') {
  requireOptions({
    '--bucket': bucket,
    '--lifecycle-configuration': '{"Rules":[{"ID":"expire-remote-alb-logs-365d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":365}}]}',
  });
  mutation('LOG_BUCKET_ENCRYPTED', 'LOG_BUCKET_LIFECYCLE_READY', 's3api put-bucket-lifecycle-configuration');
}
if (service === 's3api' && operation === 'put-bucket-policy') {
  if (option('--bucket') !== bucket || !exactJson(fileJson('--policy'), bucketPolicy())) {
    log('invalid bucket policy ' + JSON.stringify(args));
    fail();
  }
  mutation('LOG_BUCKET_LIFECYCLE_READY', 'LOG_BUCKET_POLICY_READY', 's3api put-bucket-policy');
}
if (service === 'elbv2' && operation === 'modify-load-balancer-attributes') {
  requireOptions({
    '--load-balancer-arn': albArn,
    '--attributes': 'Key=access_logs.s3.enabled,Value=true',
  });
  if (
    args.slice(args.indexOf('--attributes') + 1).join(',') !==
    'Key=access_logs.s3.enabled,Value=true,Key=access_logs.s3.bucket,Value=nava-zero-remote-alb-logs-845242190536-af-south-1'
  ) {
    fail();
  }
  mutation('LOG_BUCKET_POLICY_READY', 'ALB_LOGGING_READY', 'elbv2 modify-load-balancer-attributes');
}
if (service === 'wafv2' && operation === 'create-web-acl') {
  const definition = fileJson('--cli-input-json');
  const rules = definition.Rules;
  if (
    definition.Scope !== 'REGIONAL' ||
    JSON.stringify(definition.DefaultAction) !== JSON.stringify({ Allow: {} }) ||
    !Array.isArray(rules) ||
    rules.length !== 5 ||
    rules.slice(0, 3).some((rule) => JSON.stringify(rule.OverrideAction) !== JSON.stringify({ None: {} })) ||
    rules.slice(3).some((rule) => JSON.stringify(rule.Action) !== JSON.stringify({ Block: {} }))
  ) {
    log('invalid waf definition ' + JSON.stringify(definition));
    fail();
  }
  mutation('ALB_LOGGING_READY', 'WAF_CREATED', 'wafv2 create-web-acl');
}
if (service === 'wafv2' && operation === 'associate-web-acl') {
  requireOptions({
    '--web-acl-arn': wafArn,
    '--resource-arn': albArn,
  });
  mutation('WAF_CREATED', 'WAF_ASSOCIATED', 'wafv2 associate-web-acl');
}
if (service === 'elbv2' && operation === 'create-listener') {
  requireOptions({
    '--load-balancer-arn': albArn,
    '--protocol': 'HTTPS',
    '--port': '443',
    '--certificates': 'CertificateArn=arn:aws:acm:af-south-1:845242190536:certificate/test',
    '--default-actions': 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=Not Found}',
  });
  mutation('WAF_ASSOCIATED', 'LISTENER_FIXED_404', 'elbv2 create-listener');
}
if (
  (service === 'elbv2' && ['register-targets', 'create-rule'].includes(operation)) ||
  service === 'route53'
) {
  log('forbidden ' + service + ' ' + operation);
  process.exit(99);
}

switch (service + ' ' + operation) {
  case 'sts get-caller-identity':
    emit({ Account: account, Arn: 'arn:aws:iam::845242190536:user/fake', UserId: 'fake' });
    break;
  case 'ec2 describe-instances': {
    const groups = [{ GroupId: legacySg, GroupName: 'legacy' }];
    if (at('TARGET_SG_ATTACHED')) groups.push({ GroupId: targetSg, GroupName: targetName });
    const primaryNetworkInterface = {
      NetworkInterfaceId: 'eni-test-primary',
      Attachment: { DeviceIndex: 0, InstanceId: instance },
      PrivateIpAddress: targetIp,
      Groups: groups,
    };
    const instanceNetworkInterfaces = [primaryNetworkInterface];
    if ([
      'legacy-secondary-public-ingress',
      'secondary-eni-missing-global',
      'secondary-eni-group-mismatch-global',
    ].includes(state.mode)) {
      instanceNetworkInterfaces.push({
        NetworkInterfaceId: 'eni-test-secondary',
        Attachment: { DeviceIndex: 1, InstanceId: instance },
        Groups: [{ GroupId: legacySecondarySg, GroupName: 'legacy-secondary' }],
      });
    }
    const instanceRecord = {
      InstanceId: instance,
      VpcId: vpc,
      PrivateIpAddress: targetIp,
      SecurityGroups: groups,
      NetworkInterfaces: instanceNetworkInterfaces,
    };
    if (publicAddressMode) {
      instanceRecord.PublicIpAddress = '198.51.100.23';
      instanceRecord.Ipv6Addresses = [{ Ipv6Address: '2001:db8::23' }];
      primaryNetworkInterface.Association = { PublicIp: '198.51.100.23' };
      primaryNetworkInterface.Ipv6Addresses = [{ Ipv6Address: '2001:db8::23' }];
    }
    emit({
      Reservations: [{
        Instances: [instanceRecord],
      }],
    });
    break;
  }
  case 'ec2 describe-network-interfaces': {
    const primaryGroups = [{ GroupId: legacySg, GroupName: 'legacy' }];
    if (at('TARGET_SG_ATTACHED')) primaryGroups.push({ GroupId: targetSg, GroupName: targetName });
    const interfaces = [{
      NetworkInterfaceId: 'eni-test-primary',
      Attachment: { InstanceId: instance, DeviceIndex: 0 },
      Groups: primaryGroups,
    }];
    if (
      state.mode === 'legacy-secondary-public-ingress' ||
      state.mode === 'secondary-eni-group-mismatch-global'
    ) {
      interfaces.push({
        NetworkInterfaceId: 'eni-test-secondary',
        Attachment: { InstanceId: instance, DeviceIndex: 1 },
        Groups: state.mode === 'secondary-eni-group-mismatch-global'
          ? [{ GroupId: legacySg, GroupName: 'legacy' }]
          : [{ GroupId: legacySecondarySg, GroupName: 'legacy-secondary' }],
      });
    }
    if (at('ALB_CREATED')) {
      const description = state.mode === 'non-alb-eni'
        ? 'ELB app/not-nava-remote-admin-alb/test'
        : 'ELB app/nava-remote-admin-alb/test';
      interfaces.push({
        NetworkInterfaceId: 'eni-test-alb-a',
        Description: description,
        RequesterManaged: true,
        RequesterId: 'amazon-elb',
        Groups: [{ GroupId: albSg, GroupName: albName }],
      });
      if (state.mode !== 'single-alb-eni') {
        interfaces.push({
          NetworkInterfaceId: 'eni-test-alb-b',
          Description: description,
          RequesterManaged: true,
          RequesterId: 'amazon-elb',
          Groups: [{ GroupId: albSg, GroupName: albName }],
        });
      }
    }
    emit({ NetworkInterfaces: interfaces });
    break;
  }
  case 'ec2 describe-security-groups': {
    const legacyIngress = [
      'legacy-public-ingress',
      'public-address-broad-ingress',
    ].includes(state.mode) ? [publicHttps] : [];
    const groups = [{
      GroupId: legacySg,
      GroupName: 'legacy',
      VpcId: vpc,
      IpPermissions: legacyIngress,
      IpPermissionsEgress: [defaultEgress],
    }];
    if (state.mode === 'legacy-secondary-public-ingress') {
      groups.push({
        GroupId: legacySecondarySg,
        GroupName: 'legacy-secondary',
        VpcId: vpc,
        IpPermissions: [publicHttps],
        IpPermissionsEgress: [defaultEgress],
      });
    }
    if (at('ALB_SG_CREATED')) {
      let ingress = [];
      let egress = [defaultEgress];
      if (at('ALB_INGRESS_READY')) ingress = [publicHttps];
      if (at('ALB_EGRESS_REVOKED')) egress = [];
      if (at('ALB_EGRESS_READY')) egress = [albTargetEgress];
      groups.push({
        GroupId: albSg,
        GroupName: albName,
        VpcId: vpc,
        IpPermissions: ingress,
        IpPermissionsEgress: egress,
      });
    }
    if (at('SGS_CREATED')) {
      groups.push({
        GroupId: targetSg,
        GroupName: targetName,
        VpcId: vpc,
        IpPermissions: at('SG_FINAL_UNATTACHED') ? [targetAlbIngress] : [],
        IpPermissionsEgress: [defaultEgress],
      });
    }
    emit({ SecurityGroups: groups });
    break;
  }
  case 'ec2 describe-subnets':
    emit({ Subnets: [
      { SubnetId: 'subnet-0e6446aaaeaa8762e', VpcId: vpc },
      { SubnetId: 'subnet-094bf8643d98c22f6', VpcId: vpc },
    ] });
    break;
  case 'ec2 describe-route-tables':
    emit({ RouteTables: [{
      Associations: [{ Main: true }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-test' }],
    }] });
    break;
  case 'acm list-certificates':
    emit({ CertificateSummaryList: [{ DomainName: 'nava-admin.trynava.io', CertificateArn: certArn }] });
    break;
  case 'acm describe-certificate':
    emit({ Certificate: { DomainName: 'nava-admin.trynava.io', Status: 'ISSUED', CertificateArn: certArn } });
    break;
  case 'elbv2 describe-target-groups':
    emit({
      TargetGroups: at('TARGET_GROUP_CREATED') ? [{
        TargetGroupName: targetGroupName,
        TargetGroupArn: targetGroupArn,
        VpcId: vpc,
        Protocol: 'HTTP',
        Port: 8443,
        TargetType: 'instance',
        HealthCheckProtocol: 'HTTP',
        HealthCheckPath: '/health',
        Matcher: { HttpCode: '200' },
      }] : [],
    });
    break;
  case 'elbv2 describe-target-group-attributes':
    emit({ Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: at('TARGET_GROUP_READY') ? '30' : '300' }] });
    break;
  case 'elbv2 describe-target-health':
    emit({ TargetHealthDescriptions: [] });
    break;
  case 'elbv2 describe-load-balancers': {
    if (!at('ALB_CREATED')) {
      emit({ LoadBalancers: [] });
      break;
    }
    state.albPolls += 1;
    const provisioning = state.mode === 'alb-stuck-provisioning' ||
      (state.mode === 'alb-provisioning' && state.albPolls === 1);
    save();
    emit({ LoadBalancers: [{
      LoadBalancerName: albName,
      LoadBalancerArn: albArn,
      DNSName: 'nava-remote-admin-alb-123.af-south-1.elb.amazonaws.com',
      VpcId: vpc,
      Scheme: 'internet-facing',
      Type: 'application',
      IpAddressType: 'ipv4',
      State: { Code: provisioning ? 'provisioning' : 'active' },
      SecurityGroups: [albSg],
      AvailabilityZones: [
        { SubnetId: 'subnet-0e6446aaaeaa8762e' },
        { SubnetId: 'subnet-094bf8643d98c22f6' },
      ],
    }] });
    break;
  }
  case 'elbv2 describe-load-balancer-attributes': {
    const attributes = [
      { Key: 'access_logs.s3.enabled', Value: at('ALB_LOGGING_READY') ? 'true' : 'false' },
      { Key: 'access_logs.s3.bucket', Value: at('ALB_LOGGING_READY') ? bucket : '' },
    ];
    if (state.mode !== 'alb-log-prefix-missing') {
      attributes.push({
        Key: 'access_logs.s3.prefix',
        Value: state.mode === 'alb-log-prefix-malformed'
          ? 17
          : state.mode === 'alb-log-prefix'
            ? 'unexpected'
            : '',
      });
    }
    emit({ Attributes: attributes });
    break;
  }
  case 'elbv2 describe-listeners':
    emit({ Listeners: at('LISTENER_FIXED_404') ? [{
      ListenerArn: 'arn:aws:elasticloadbalancing:af-south-1:845242190536:listener/app/nava-remote-admin-alb/test/listener',
      Protocol: 'HTTPS',
      Port: 443,
      Certificates: [{ CertificateArn: certArn }],
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
    }] : [] });
    break;
  case 'elbv2 describe-rules':
    emit({ Rules: [{
      IsDefault: true,
      Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
    }] });
    break;
  case 'wafv2 list-web-acls':
    emit({ WebACLs: at('WAF_CREATED') ? [{ Name: wafName, ARN: wafArn, Id: 'waf-test' }] : [] });
    break;
  case 'wafv2 get-web-acl':
    emit(waf());
    break;
  case 'wafv2 list-resources-for-web-acl':
    emit({ ResourceArns: at('WAF_ASSOCIATED') ? [albArn] : [] });
    break;
  case 's3api list-buckets':
    emit({ Buckets: at('LOG_BUCKET_CREATED') ? [{ Name: bucket }] : [] });
    break;
  case 's3api get-bucket-cors':
    emit({ CORSRules: [{
      AllowedOrigins: ['https://nava.legacyhotels.co.za'],
      AllowedMethods: ['GET', 'HEAD'],
    }] });
    break;
  case 's3api get-bucket-location':
    emit({ LocationConstraint: region });
    break;
  case 's3api get-public-access-block':
    if (!at('LOG_BUCKET_PUBLIC_BLOCKED')) absent('NoSuchPublicAccessBlockConfiguration');
    emit({ PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    } });
    break;
  case 's3api get-bucket-ownership-controls':
    if (!at('LOG_BUCKET_OWNERSHIP_ENFORCED')) absent('OwnershipControlsNotFoundError');
    emit({ OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } });
    break;
  case 's3api get-bucket-encryption':
    if (!at('LOG_BUCKET_ENCRYPTED')) absent('ServerSideEncryptionConfigurationNotFoundError');
    emit({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } });
    break;
  case 's3api get-bucket-lifecycle-configuration':
    if (!at('LOG_BUCKET_LIFECYCLE_READY')) absent('NoSuchLifecycleConfiguration');
    emit({ Rules: [{ ID: 'expire-remote-alb-logs-365d', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 365 } }] });
    break;
  case 's3api get-bucket-policy':
    if (!at('LOG_BUCKET_POLICY_READY')) absent('NoSuchBucketPolicy');
    emit({ Policy: JSON.stringify(bucketPolicy()) });
    break;
  case 's3api list-objects-v2':
    const key = state.mode === 'log-proof-wrong-key'
      ? 'AWSLogs/845242190536/test-fixture.txt'
      : state.mode === 'log-proof-invalid-time'
        ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T2460Z_172.31.0.1_deadbeef.log.gz'
        : state.mode === 'log-proof-invalid-ip'
          ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_999.31.0.1_deadbeef.log.gz'
          : state.mode === 'log-proof-directory-mismatch'
            ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/02/30/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_deadbeef.log.gz'
            : state.mode === 'log-proof-differing-delivery-date'
              ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/02/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_20sg8hgm.log.gz'
            : state.mode === 'log-proof-test-token'
              ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_test-file.log.gz'
              : state.mode === 'log-proof-health-token'
                ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_health-check.log.gz'
                : state.mode === 'log-proof-connection-token'
                  ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_connection.log'
                  : state.mode === 'log-proof-official-token'
                    ? 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_20sg8hgm.log.gz'
                  : 'AWSLogs/845242190536/elasticloadbalancing/af-south-1/2030/01/01/845242190536_elasticloadbalancing_af-south-1_app.nava-remote-admin-alb.test_20300101T0000Z_172.31.0.1_deadbeef.log.gz';
    emit({
      Contents: state.mode === 'log-proof-failure'
        ? []
        : [{
            Key: key,
            LastModified: state.mode === 'log-proof-boundary'
              ? '2030-01-01T00:00:00Z'
              : new Date().toISOString(),
          }],
    });
    break;
  default:
    fail();
}
`,
  );

  writeExecutable(
    ssmPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((value) => value !== '--no-cli-pager');
const [service, operation] = args;
const instance = 'i-008f737974a9ba9b3';
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const statePath = process.env.REMOTE_EDGE_FAKE_STATE;
const logPath = process.env.REMOTE_EDGE_FAKE_LOG;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const regionIndex = args.indexOf('--region');
const exactRegion = regionIndex >= 0 && args[regionIndex + 1] === 'af-south-1';
const relaxedModes = new Set([
  'ufw-shorthand',
  'ufw-status-shorthand',
  'legacy-public-ingress',
  'non-alb-eni',
  'bucket-broad-principal',
  'log-proof-failure',
  'alb-provisioning',
  'alb-stuck-provisioning',
]);
const log = (line) => appendFileSync(logPath, line + '\n');
const save = () => writeFileSync(statePath, JSON.stringify(state));
const emit = (value) => process.stdout.write(JSON.stringify(value));
const fail = () => process.exit(31);
const stages = [
  'FRESH', 'ALB_SG_CREATED', 'SGS_CREATED', 'ALB_INGRESS_READY',
  'ALB_EGRESS_REVOKED', 'ALB_EGRESS_READY', 'SG_FINAL_UNATTACHED',
  'TARGET_SG_ATTACHED', 'TARGET_GROUP_CREATED', 'TARGET_GROUP_READY',
  'ALB_CREATED', 'LOG_BUCKET_CREATED', 'LOG_BUCKET_PUBLIC_BLOCKED',
  'LOG_BUCKET_OWNERSHIP_ENFORCED', 'LOG_BUCKET_ENCRYPTED',
  'LOG_BUCKET_LIFECYCLE_READY', 'LOG_BUCKET_POLICY_READY',
  'ALB_LOGGING_READY', 'WAF_CREATED', 'WAF_ASSOCIATED',
  'LISTENER_FIXED_404', 'UFW_SUBNET_A_READY', 'UFW_READY',
  'TASK4_PRE_GATE_B_READY',
];
const at = (name) => stages.indexOf(state.stage) >= stages.indexOf(name);
const hostOutput = () => {
  const rules = ['ufw allow in on tun0 to any port 443 proto tcp'];
  const statusRules = ['[ 1] 443/tcp on tun0 ALLOW IN Anywhere'];
  if (at('UFW_SUBNET_A_READY')) {
    rules.push('ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp');
    statusRules.push('[ 2] 8443/tcp on ens5 ALLOW IN 172.31.0.0/20');
  }
  if (at('UFW_READY')) {
    rules.push('ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp');
    statusRules.push('[ 3] 8443/tcp on ens5 ALLOW IN 172.31.32.0/20');
  }
  if (state.mode === 'ufw-shorthand') rules.push('ufw allow 8443/tcp');
  if (state.mode === 'ufw-broad-rule') {
    rules.push('ufw allow in on ens5 to any port 8443 proto tcp');
  }
  if (state.mode === 'ufw-duplicate-rule') {
    rules.push('ufw allow in on tun0 to any port 443 proto tcp');
  }
  if (state.mode === 'public-address-wrong-ufw') {
    rules.push('ufw allow in on ens5 to any port 8443 proto tcp');
  }
  if (state.mode === 'ufw-status-shorthand') {
    statusRules.push('[ 1] 8443/tcp ALLOW IN Anywhere');
  }
  if (state.mode === 'ufw-status-missing') statusRules.length = 0;
  if (state.mode === 'ufw-ipv6-display-companion') {
    statusRules.push('[ 2] 443/tcp (v6) on tun0 ALLOW IN Anywhere (v6)');
  }
  const targetListener = state.mode === 'public-address-public-listener'
    ? 'LISTEN 0 511 0.0.0.0:8443 0.0.0.0:*'
    : state.mode === 'public-address-ipv6-listener'
      ? 'LISTEN 0 511 [::]:8443 [::]:*'
      : 'LISTEN 0 511 172.31.12.112:8443 0.0.0.0:*';
  return [
    '__REMOTE_EDGE_UFW_VERBOSE__',
    'Status: active',
    'Default: deny (incoming), allow (outgoing), disabled (routed)',
    '__REMOTE_EDGE_UFW_STATUS__',
    ...statusRules,
    '__REMOTE_EDGE_UFW_ADDED__',
    ...rules,
    '__REMOTE_EDGE_SOCKETS__',
    'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
    'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
    'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
    targetListener,
    ...(state.mode === 'udp-8443-listener'
      ? ['UNCONN 0 0 172.31.12.112:8443 0.0.0.0:*']
      : []),
    '__REMOTE_EDGE_ROUTE__',
    'default via 172.31.0.1 dev ens5',
    '',
  ].join('\n');
};

log('ssm ' + service + ' ' + operation + ' region=' + (exactRegion ? 'af-south-1' : 'missing'));
if (service !== 'ssm') fail();
if (!relaxedModes.has(state.mode) && !exactRegion) fail();
if (operation === 'send-command') {
  const parameters = args[args.indexOf('--parameters') + 1] ?? '';
  const isMutation = parameters.includes('ufw allow in on ens5 from');
  if (isMutation) {
    const cidr =
      state.stage === 'LISTENER_FIXED_404'
        ? '172.31.0.0/20'
        : state.stage === 'UFW_SUBNET_A_READY'
          ? '172.31.32.0/20'
          : '';
    const expectedCommand =
      'set -eu; ufw allow in on ens5 from ' + cidr +
      ' to any port 8443 proto tcp; printf "__REMOTE_EDGE_UFW_VERBOSE__\\n"; ufw status verbose; printf "__REMOTE_EDGE_UFW_STATUS__\\n"; ufw status numbered; printf "__REMOTE_EDGE_UFW_ADDED__\\n"; ufw show added; printf "__REMOTE_EDGE_SOCKETS__\\n"; ss -ltnH; ss -lunH; printf "__REMOTE_EDGE_ROUTE__\\n"; ip route show default';
    let command;
    try {
      const payload = JSON.parse(parameters);
      command = payload.commands?.[0];
    } catch {
      log('invalid ssm parameters ' + parameters);
      fail();
    }
    if (
      option('--document-name') !== 'AWS-RunShellScript' ||
      option('--instance-ids') !== instance ||
      command !== expectedCommand
    ) {
      log('invalid ssm mutation ' + JSON.stringify(args) + ' command=' + String(command));
      fail();
    }
    if (
      state.stage === 'LISTENER_FIXED_404' &&
      cidr === '172.31.0.0/20'
    ) {
      state.stage = 'UFW_SUBNET_A_READY';
    } else if (
      state.stage === 'UFW_SUBNET_A_READY' &&
      cidr === '172.31.32.0/20'
    ) {
      state.stage = 'UFW_READY';
    } else {
      fail();
    }
    log('mutate ssm ufw');
  } else {
    const expectedCommand =
      'set -eu; printf "__REMOTE_EDGE_UFW_VERBOSE__\\n"; ufw status verbose; ' +
      'printf "__REMOTE_EDGE_UFW_STATUS__\\n"; ufw status numbered; ' +
      'printf "__REMOTE_EDGE_UFW_ADDED__\\n"; ufw show added; ' +
      'printf "__REMOTE_EDGE_SOCKETS__\\n"; ss -ltnH; ss -lunH; ' +
      'printf "__REMOTE_EDGE_ROUTE__\\n"; ip route show default';
    let command;
    try {
      const payload = JSON.parse(parameters);
      command = payload.commands?.[0];
    } catch {
      log('invalid observe parameters ' + parameters);
      fail();
    }
    if (
      option('--document-name') !== 'AWS-RunShellScript' ||
      option('--instance-ids') !== instance ||
      command !== expectedCommand
    ) {
      log('invalid ssm observe ' + JSON.stringify(args) + ' command=' + String(command));
      fail();
    }
  }
  state.commandCounter += 1;
  const commandId = 'command-' + state.commandCounter;
  state.commands[commandId] = true;
  save();
  emit({ Command: { CommandId: commandId } });
  process.exit(0);
}
if (operation === 'get-command-invocation') {
  const commandId = args[args.indexOf('--command-id') + 1];
  if (!state.commands[commandId]) fail();
  const count = state.polls[commandId] ?? 0;
  state.polls[commandId] = count + 1;
  save();
  if (state.mode === 'stuck-ssm' || (state.mode === 'pending-ssm' && count === 0)) {
    emit({ Status: 'InProgress', StandardOutputContent: '', StandardErrorContent: '' });
    process.exit(0);
  }
  emit({
    Status: 'Success',
    StandardOutputContent: hostOutput(),
    StandardErrorContent: '',
  });
  process.exit(0);
}
fail();
`,
  );

  writeExecutable(
    curlPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync(process.env.REMOTE_EDGE_FAKE_STATE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.REMOTE_EDGE_FAKE_LOG, 'mutate proof curl\n');
const outputPath = args[args.indexOf('--output') + 1];
if (
  !args.includes('--output') ||
  (outputPath !== 'nul' &&
    outputPath !== '/dev/null' &&
    !/[\\/]dev[\\/]null$/i.test(outputPath)) ||
  !args.includes('--connect-to') ||
  !args.includes('nava-admin.trynava.io:443:nava-remote-admin-alb-123.af-south-1.elb.amazonaws.com:443')
) {
  process.exit(41);
}
if (state.mode === 'log-proof-failure') process.exit(42);
process.exit(0);
`,
  );
  writeExecutable(
    datePath,
    String.raw`#!/usr/bin/env bash
printf '%s\n' 'date invoked' >> "$REMOTE_EDGE_FAKE_LOG"
printf '%s\n' '2030-01-01T00:00:00Z'
`,
  );

  return {
    root,
    awsPath,
    statePath,
    evidenceRoot,
    logPath,
    env: {
      ...process.env,
      REMOTE_EDGE_AWS_BIN: awsPath,
      REMOTE_EDGE_SSM_BIN: ssmPath,
      REMOTE_EDGE_CURL_BIN: curlPath,
      REMOTE_EDGE_FAKE_STATE: statePath,
      REMOTE_EDGE_FAKE_LOG: logPath,
      REMOTE_EDGE_SSM_POLL_MAX_ATTEMPTS: '3',
      REMOTE_EDGE_SSM_POLL_INTERVAL_SECONDS: '0',
      REMOTE_EDGE_ALB_POLL_MAX_ATTEMPTS: '3',
      REMOTE_EDGE_ALB_POLL_INTERVAL_SECONDS: '0',
      REMOTE_EDGE_LOG_PROOF_MAX_ATTEMPTS: '3',
      REMOTE_EDGE_LOG_PROOF_INTERVAL_SECONDS: '0',
      REMOTE_EDGE_DATE_BIN: mode === 'log-proof-boundary' ? datePath : 'date',
      REMOTE_EDGE_NATIVE_TMP: tmpdir(),
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
  evidenceRoot = harness.evidenceRoot,
): Promise<ProvisionerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'bash',
      [provisionerPath, ...args, '--evidence-root', evidenceRoot],
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
    }, 60_000);
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

function runFakeAws(harness: Harness, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('node', [harness.awsPath, ...args], { env: harness.env });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
}

function calls(harness: Harness): string[] {
  return readFileSync(harness.logPath, 'utf8')
    .split('\n')
    .filter(Boolean);
}

function resultDiagnostic(
  result: ProvisionerResult,
  harness: Harness,
): string {
  return [result.error?.message ?? '', result.stderr, result.stdout, ...calls(harness)].join(
    '\n',
  );
}

function nextAction(stage: string): string {
  return STAGES.find(([current]) => current === stage)?.[1] ?? 'STOP';
}

describe('remote edge provisioner security contracts', () => {
  it.each(STAGES)(
    'advances %s with exactly one fake mutation and fresh successor facts',
    async (stage, action, successor) => {
      const harness = createHarness(stage);
      try {
        const result = await runProvisioner(harness, [
          'apply-one',
          '--action',
          action,
        ]);
        expect(result.status, resultDiagnostic(result, harness)).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          stage: successor,
          action: nextAction(successor),
        });
        expect(
          calls(harness).filter((entry) => entry.startsWith('mutate ')),
        ).toHaveLength(1);
        expect(calls(harness).some((entry) => entry.startsWith('forbidden '))).toBe(false);
        expect(JSON.parse(readFileSync(harness.statePath, 'utf8')).stage).toBe(
          action === 'PROVE_ALB_LOG_DELIVERY' ? stage : successor,
        );
      } finally {
        destroyHarness(harness);
      }
    },
    60_000,
  );

  it('pins every SSM call to af-south-1 and polls pending invocations to success', async () => {
    const harness = createHarness('SG_FINAL_UNATTACHED', 'pending-ssm');
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status, resultDiagnostic(result, harness)).toBe(0);
      const ssmCalls = calls(harness).filter((entry) => entry.startsWith('ssm '));
      expect(ssmCalls.length).toBeGreaterThan(2);
      expect(ssmCalls.every((entry) => entry.endsWith('region=af-south-1'))).toBe(true);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('blocks stuck or inconsistent SSM before classification or mutation', async () => {
    const harness = createHarness('SG_FINAL_UNATTACHED', 'stuck-ssm');
    try {
      const result = await runProvisioner(harness, [
        'apply-one',
        '--action',
        'ATTACH_TARGET_SECURITY_GROUP',
      ]);
      expect(result.status, resultDiagnostic(result, harness)).not.toBe(0);
      expect(calls(harness).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('waits for ALB active before successor classification and fails if it stays provisioning', async () => {
    const ready = createHarness('TARGET_GROUP_READY', 'alb-provisioning');
    try {
      const result = await runProvisioner(ready, [
        'apply-one',
        '--action',
        'CREATE_ALB',
      ]);
      expect(result.status, resultDiagnostic(result, ready)).toBe(0);
      expect(JSON.parse(result.stdout).stage).toBe('ALB_CREATED');
      expect(
        calls(ready).filter((entry) => entry === 'aws elbv2 describe-load-balancers').length,
      ).toBeGreaterThan(2);
    } finally {
      destroyHarness(ready);
    }

    const stuck = createHarness('TARGET_GROUP_READY', 'alb-stuck-provisioning');
    try {
      const result = await runProvisioner(stuck, [
        'apply-one',
        '--action',
        'CREATE_ALB',
      ]);
      expect(result.status, resultDiagnostic(result, stuck)).not.toBe(0);
      expect(calls(stuck).filter((entry) => entry.startsWith('mutate '))).toEqual([
        'mutate elbv2 create-load-balancer',
      ]);
    } finally {
      destroyHarness(stuck);
    }
  }, 60_000);

  it.each([
    ['UFW shorthand', 'SG_FINAL_UNATTACHED', 'ufw-shorthand'],
    ['UFW status shorthand', 'SG_FINAL_UNATTACHED', 'ufw-status-shorthand'],
    ['missing UFW status', 'SG_FINAL_UNATTACHED', 'ufw-status-missing'],
    ['legacy public ingress', 'SG_FINAL_UNATTACHED', 'legacy-public-ingress'],
    ['legacy secondary-ENI public ingress', 'SG_FINAL_UNATTACHED', 'legacy-secondary-public-ingress'],
    ['non-ALB ENI attachment', 'ALB_CREATED', 'non-alb-eni'],
    ['broadened bucket principal', 'LOG_BUCKET_POLICY_READY', 'bucket-broad-principal'],
  ] as const)('rejects %s before mutation', async (_name, stage, mode) => {
    const harness = createHarness(stage, mode);
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status).not.toBe(0);
      expect(calls(harness).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it.each([
    ['missing from global describe-network-interfaces', 'secondary-eni-missing-global'],
    ['group-mismatched in global describe-network-interfaces', 'secondary-eni-group-mismatch-global'],
  ] as const)('blocks instance secondary ENI %s before classification', async (_name, mode) => {
    const harness = createHarness('SG_FINAL_UNATTACHED', mode);
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status, resultDiagnostic(result, harness)).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(calls(harness).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('accepts an active ALB with one EC2-visible managed interface', async () => {
    const harness = createHarness('ALB_CREATED', 'single-alb-eni');
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status, resultDiagnostic(result, harness)).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        stage: 'ALB_CREATED',
        action: 'CREATE_LOG_BUCKET',
      });
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('reads UFW default policy from verbose and normalizes only tunnel IPv6 display', async () => {
    for (const mode of [
      'ufw-verbose-default-only',
      'ufw-ipv6-display-companion',
    ] as const) {
      const harness = createHarness('SG_FINAL_UNATTACHED', mode);
      try {
        const result = await runProvisioner(harness, ['inspect']);
        expect(result.status, resultDiagnostic(result, harness)).toBe(0);
      } finally {
        destroyHarness(harness);
      }
    }
  }, 60_000);

  it.each([
    'ufw-shorthand',
    'ufw-status-shorthand',
    'ufw-status-missing',
    'ufw-broad-rule',
    'ufw-duplicate-rule',
  ] as const)('rejects unknown, broad, missing, or duplicate UFW state: %s', async (mode) => {
    const harness = createHarness('UFW_READY', mode);
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status, resultDiagnostic(result, harness)).not.toBe(0);
      expect(calls(harness).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('rejects UDP :8443 even when TCP target binding is exact', async () => {
    const harness = createHarness('UFW_READY', 'udp-8443-listener');
    try {
      const result = await runProvisioner(harness, ['inspect']);
      expect(result.status, resultDiagnostic(result, harness)).not.toBe(0);
      expect(calls(harness).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('accepts assigned public addresses only behind exact remote path controls', async () => {
    const safe = createHarness('UFW_READY', 'public-address-safe');
    try {
      const result = await runProvisioner(safe, ['inspect']);
      expect(result.status, resultDiagnostic(result, safe)).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        stage: 'UFW_READY',
        action: 'PROVE_ALB_LOG_DELIVERY',
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('198.51.100.23');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('2001:db8::23');
    } finally {
      destroyHarness(safe);
    }

    for (const mode of [
      'public-address-broad-ingress',
      'public-address-wrong-ufw',
      'public-address-public-listener',
      'public-address-ipv6-listener',
    ] as const) {
      const unsafe = createHarness('UFW_READY', mode);
      try {
        const result = await runProvisioner(unsafe, ['inspect']);
        expect(result.status, `${mode}\n${resultDiagnostic(result, unsafe)}`).not.toBe(0);
        expect(calls(unsafe).filter((entry) => entry.startsWith('mutate '))).toHaveLength(0);
      } finally {
        destroyHarness(unsafe);
      }
    }
  }, 90_000);

  it('requires bounded body-discarded log delivery proof before pre-Gate-B readiness', async () => {
    const failing = createHarness('UFW_READY', 'log-proof-failure');
    try {
      const before = await runProvisioner(failing, ['inspect']);
      expect(before.status, resultDiagnostic(before, failing)).toBe(0);
      expect(JSON.parse(before.stdout)).toEqual({
        stage: 'UFW_READY',
        action: 'PROVE_ALB_LOG_DELIVERY',
      });

      const failedProof = await runProvisioner(failing, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(failedProof.status).not.toBe(0);
      expect(calls(failing)).toContain('mutate proof curl');
      expect(
        calls(failing).filter((entry) => entry.startsWith('mutate ')),
      ).toEqual(['mutate proof curl']);
    } finally {
      destroyHarness(failing);
    }
  }, 60_000);

  it('requires an ALB log object newer than proof start', async () => {
    const boundary = createHarness('UFW_READY', 'log-proof-boundary');
    try {
      const result = await runProvisioner(boundary, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(result.status, resultDiagnostic(result, boundary)).not.toBe(0);
      expect(calls(boundary)).toContain('mutate proof curl');
      expect(
        calls(boundary).filter((entry) => entry === 'aws s3api list-objects-v2'),
      ).toHaveLength(3);
    } finally {
      destroyHarness(boundary);
    }
  }, 60_000);

  it('rejects a fresh object outside the exact ALB access-log hierarchy', async () => {
    const wrongKey = createHarness('UFW_READY', 'log-proof-wrong-key');
    try {
      const result = await runProvisioner(wrongKey, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(result.status).not.toBe(0);
      expect(calls(wrongKey)).toContain('mutate proof curl');
      expect(
        calls(wrongKey).filter((entry) => entry === 'aws s3api list-objects-v2'),
      ).toHaveLength(3);
    } finally {
      destroyHarness(wrongKey);
    }
  }, 60_000);

  it.each([
    'log-proof-invalid-time',
    'log-proof-invalid-ip',
    'log-proof-directory-mismatch',
    'log-proof-test-token',
    'log-proof-health-token',
    'log-proof-connection-token',
  ] as const)('rejects malformed official ALB access-log key: %s', async (mode) => {
    const malformed = createHarness('UFW_READY', mode);
    try {
      const result = await runProvisioner(malformed, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(result.status).not.toBe(0);
      expect(
        calls(malformed).filter((entry) => entry === 'aws s3api list-objects-v2'),
      ).toHaveLength(3);
    } finally {
      destroyHarness(malformed);
    }
  }, 60_000);

  it('accepts official-style alphanumeric ALB access-log suffix', async () => {
    const officialToken = createHarness('UFW_READY', 'log-proof-official-token');
    try {
      const result = await runProvisioner(officialToken, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        stage: 'TASK4_PRE_GATE_B_READY',
        action: 'STOP',
      });
    } finally {
      destroyHarness(officialToken);
    }
  }, 60_000);

  it('accepts official ALB log with independent delivery date', async () => {
    const differingDate = createHarness('UFW_READY', 'log-proof-differing-delivery-date');
    try {
      const result = await runProvisioner(differingDate, [
        'apply-one',
        '--action',
        'PROVE_ALB_LOG_DELIVERY',
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        stage: 'TASK4_PRE_GATE_B_READY',
        action: 'STOP',
      });
    } finally {
      destroyHarness(differingDate);
    }
  }, 60_000);

  it.each([
    'alb-log-prefix',
    'alb-log-prefix-missing',
    'alb-log-prefix-malformed',
  ] as const)('rejects unsafe ALB access-log prefix before mutation: %s', async (mode) => {
    const prefixed = createHarness('ALB_LOGGING_READY', mode);
    try {
      const result = await runProvisioner(prefixed, [
        'apply-one',
        '--action',
        'CREATE_WAF',
      ]);
      expect(result.status).not.toBe(0);
      expect(calls(prefixed).filter((entry) => entry.startsWith('mutate '))).toEqual([]);
    } finally {
      destroyHarness(prefixed);
    }
  }, 60_000);

  it('rejects a regional fake mutation with wrong region', async () => {
    const wrongRegion = createHarness('FRESH', 'valid');
    try {
      const status = await runFakeAws(wrongRegion, [
        '--no-cli-pager',
        'ec2',
        'create-security-group',
        '--region',
        'us-east-1',
        '--vpc-id',
        'vpc-0f078e17a5f0f8599',
        '--group-name',
        'nava-remote-admin-alb',
        '--description',
        'Nava remote admin ALB ingress only',
      ]);
      expect(status).not.toBe(0);
    } finally {
      destroyHarness(wrongRegion);
    }
  });

  it('rejects unsafe evidence roots before invoking fake AWS or SSM', async () => {
    const harness = createHarness('SG_FINAL_UNATTACHED', 'ufw-shorthand');
    const unsafe = join(harness.root, 'unsafe-evidence');
    try {
      const rootResult = await runProvisioner(harness, ['inspect'], '/');
      expect(rootResult.status).not.toBe(0);
      expect(calls(harness)).toHaveLength(0);

      if (process.platform !== 'win32') {
        // Existing directory intentionally group/world-readable.
        mkdirSync(unsafe, { mode: 0o755 });
        chmodSync(unsafe, 0o755);
        const modeResult = await runProvisioner(harness, ['inspect'], unsafe);
        expect(modeResult.status).not.toBe(0);
        expect(calls(harness)).toHaveLength(0);

        const target = join(harness.root, 'safe-target');
        mkdirSync(target, { mode: 0o700 });
        const link = join(harness.root, 'evidence-link');
        symlinkSync(target, link);
        const linkResult = await runProvisioner(harness, ['inspect'], link);
        expect(linkResult.status).not.toBe(0);
        expect(calls(harness)).toHaveLength(0);
      }

      const source = readFileSync(provisionerPath, 'utf8');
      expect(source).toContain('assert_safe_evidence_root');
      expect(source).not.toContain('mkdir -p -- "$EVIDENCE_ROOT"');
      expect(source).toContain('EVIDENCE_ROOT" != "/"');
    } finally {
      destroyHarness(harness);
    }
  }, 60_000);

  it('keeps Task 5, DNS, and public HTTP outside provisioner source', () => {
    const source = readFileSync(provisionerPath, 'utf8');
    for (const forbidden of [
      'register-targets',
      'create-rule',
      'route53',
      'change-resource-record-sets',
      'put-bucket-cors',
      'create-listener --protocol HTTP --port 80',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('uses one ordered state table without private error or unused constants', () => {
    const source = readFileSync(stateModulePath, 'utf8');
    expect(source).toContain('STAGE_TABLE');
    expect(source).not.toContain('ACTION_BY_STAGE');
    expect(source).not.toContain('NEXT_STAGE_BY_STAGE');
    expect(source).not.toContain('RemoteEdgeStateError');
    expect(source).not.toContain('REMOTE_EDGE_CONSTANTS');
    expect(source).not.toContain("const MAIL_BUCKET =");
  });
});
