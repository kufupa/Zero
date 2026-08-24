import {
  assessCenturionThreadCorpusReadiness,
  createCenturionThreadCorpusReadinessCommand,
  createFixedReadinessProcessAdapters,
  EC2_AWS,
  EC2_GIT,
  type CenturionThreadCorpusReadinessCommandDependencies,
} from '../scripts/check-centurion-thread-corpus-readiness.js';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const REPO_ROOT = '/synthetic/zero';
const SCRIPT_PATH =
  '/synthetic/zero/apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts';
const CORPUS_ROOT = `${REPO_ROOT}/.private/centurion-thread-corpus`;
const CONFIG_PATH = `${CORPUS_ROOT}/readiness-config.json`;
const OPERATOR_CONFIG_PATH = `${CORPUS_ROOT}/operator-config.json`;
const PRIVATE_ADDRESS_MARKER = 'PHASE_0A2_PRIVATE_ADDRESS_MARKER';
const PRIVATE_PATH_MARKER = 'PHASE_0A2_PRIVATE_PATH_MARKER';
const PRIVATE_ERROR_MARKER = 'PHASE_0A2_PRIVATE_ERROR_MARKER';
const PRIVATE_PREFIX_MARKER = 'PHASE_0A2_PRIVATE_PREFIX_MARKER';
const PRIVATE_DB_URL_MARKER = 'PHASE_0A2_PRIVATE_DATABASE_URL_MARKER';
const PRIVATE_AWS_RESPONSE_MARKER = 'PHASE_0A2_PRIVATE_AWS_RESPONSE_MARKER';
const PRIVATE_WILDCARD_PREFIX_MARKER = 'PHASE_0A2_PRIVATE_PREFIX_*';
const PRIVATE_VARIABLE_PREFIX_MARKER = 'PHASE_0A2_PRIVATE_PREFIX_${aws:username}';
const DB_INSTANCE_ARN = 'arn:aws:rds:synthetic-region-1:123456789012:db:synthetic-source-db';

const CHECK_NAMES = [
  'exactEc2RevisionWorktree',
  'imdsV2Identity',
  'protectedConfig',
  'designatedMailboxScope',
  'regionBucketPrefixAllowlist',
  'readOnlyDbS3KmsCapabilities',
  'sourceDiskHeadroom',
  'privateDestinationIgnored',
  'windowsLocalAclTarget',
  'v2Semantics',
] as const;

type Harness = {
  calls: string[];
  deps: CenturionThreadCorpusReadinessCommandDependencies;
  stdout: string[];
};

function configText(input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 'centurion-thread-corpus-readiness-config-v1',
    expectedEc2: {
      instanceId: 'i-synthetic-approved',
      revision: 'f4581cf6',
      worktree: REPO_ROOT,
    },
    designatedSourceScope: {
      centurionTransportId: 'synthetic-centurion-transport',
      designatedTransportId: 'synthetic-designated-transport',
      mailboxIds: ['synthetic-mailbox'],
      addresses: [PRIVATE_ADDRESS_MARKER],
    },
    approvedExportTarget: {
      region: 'synthetic-region-1',
      bucket: 'synthetic-private-bucket',
      prefix: PRIVATE_PREFIX_MARKER,
    },
    minimumSourceDiskHeadroomBytes: 4096,
    corpusContractId: 'centurion-thread-corpus-v2',
    privateDestination: {
      localTarget: 'C:\\synthetic\\future-relay-target',
    },
    readOnlyCapabilityProbe: {
      policySourceArn: 'arn:aws:iam::123456789012:role/synthetic-readonly-role',
      kmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
      dbInstanceArn: DB_INSTANCE_ARN,
    },
    ...input,
  });
}

function operatorConfigText(input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    source: {
      centurionTransportId: 'synthetic-centurion-transport',
      designatedTransportId: 'synthetic-designated-transport',
      designatedIngestMailboxIds: ['synthetic-mailbox'],
      designatedAddresses: [` ${PRIVATE_ADDRESS_MARKER} `],
    },
    ...input,
  });
}

function checks(value: boolean): Record<(typeof CHECK_NAMES)[number], boolean> {
  return Object.fromEntries(CHECK_NAMES.map((name) => [name, value])) as Record<
    (typeof CHECK_NAMES)[number],
    boolean
  >;
}

function report(ready: boolean): string {
  return (
    JSON.stringify({
      schemaVersion: 'centurion-thread-corpus-readiness-report-v1',
      outcome: ready ? 'ready' : 'blocked',
      code: ready ? 'CENTURION_THREAD_CORPUS_READY' : 'CENTURION_THREAD_CORPUS_BLOCKED',
      ready,
      checks: checks(ready),
    }) + '\n'
  );
}

function syntheticPolicyResults(): Array<{ action: string; resource: string; decision: string }> {
  const bucketArn = 'arn:aws:s3:::synthetic-private-bucket';
  const objectArn = `${bucketArn}/${PRIVATE_PREFIX_MARKER}/readiness-probe`;
  const keyArn = 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic';
  return [
    { action: 'rds:DescribeDBInstances', resource: DB_INSTANCE_ARN, decision: 'allowed' },
    { action: 's3:ListBucket', resource: bucketArn, decision: 'allowed' },
    { action: 's3:GetObject', resource: objectArn, decision: 'allowed' },
    { action: 'kms:DescribeKey', resource: keyArn, decision: 'allowed' },
    { action: 'rds:ModifyDBInstance', resource: DB_INSTANCE_ARN, decision: 'implicitDeny' },
    { action: 's3:PutObject', resource: objectArn, decision: 'explicitDeny' },
    { action: 's3:PutBucketPolicy', resource: bucketArn, decision: 'implicitDeny' },
    { action: 'kms:PutKeyPolicy', resource: keyArn, decision: 'explicitDeny' },
  ];
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const deps: CenturionThreadCorpusReadinessCommandDependencies = {
    args: () => {
      calls.push('args');
      return [];
    },
    platform: () => {
      calls.push('platform');
      return 'linux';
    },
    scriptPath: () => {
      calls.push('scriptPath');
      return SCRIPT_PATH;
    },
    attestImdsV2: async (instanceId) => {
      calls.push('imds');
      return instanceId === 'i-synthetic-approved';
    },
    readProtectedConfig: async (request) => {
      if (request.configPath === CONFIG_PATH) {
        calls.push('readinessConfig');
        expect(request).toEqual({
          repoRoot: REPO_ROOT,
          corpusRoot: CORPUS_ROOT,
          configPath: CONFIG_PATH,
        });
        return configText();
      }
      calls.push('operatorConfig');
      expect(request).toEqual({
        repoRoot: REPO_ROOT,
        corpusRoot: CORPUS_ROOT,
        configPath: OPERATOR_CONFIG_PATH,
      });
      return operatorConfigText();
    },
    environment: () => {
      calls.push('environment');
      return {
        AWS_REGION: 'synthetic-region-1',
        S3_BUCKET: 'synthetic-private-bucket',
      };
    },
    inspectGit: (request) => {
      calls.push(`git:${request.check}`);
      expect(request.cwd).toBe(REPO_ROOT);
      if (request.check === 'revision') return 'f4581cf6\n';
      if (request.check === 'worktree') return `${REPO_ROOT}\n`;
      return '';
    },
    availableBytes: (root) => {
      calls.push('disk');
      expect(root).toBe(REPO_ROOT);
      return 4096;
    },
    isIgnored: (request) => {
      calls.push('ignored');
      expect(request).toEqual({
        repoRoot: REPO_ROOT,
        relativePath: '.private/centurion-thread-corpus',
      });
      return true;
    },
    isStructurallySafeWindowsTarget: (target) => {
      calls.push('windowsTarget');
      expect(target).toBe('C:\\synthetic\\future-relay-target');
      return true;
    },
    simulateReadOnlyPolicy: async (request) => {
      calls.push('policySimulation');
      expect(request.region).toBe('synthetic-region-1');
      expect(request.bucket).toBe('synthetic-private-bucket');
      expect(request.prefix).toBe(PRIVATE_PREFIX_MARKER);
      expect(request.kmsKeyId).toBe('arn:aws:kms:synthetic-region-1:123456789012:key/synthetic');
      expect(request.policySourceArn).toBe(
        'arn:aws:iam::123456789012:role/synthetic-readonly-role',
      );
      return syntheticPolicyResults();
    },
    probeS3AndKmsMetadata: async (request) => {
      calls.push('metadataProbes');
      expect(request.region).toBe('synthetic-region-1');
      expect(request.bucket).toBe('synthetic-private-bucket');
      expect(request.kmsKeyId).toBe('arn:aws:kms:synthetic-region-1:123456789012:key/synthetic');
      return true;
    },
    writeStdout: (value) => {
      calls.push('stdout');
      stdout.push(value);
    },
  };
  return { calls, deps, stdout };
}

async function run(harness: Harness): Promise<number> {
  return await createCenturionThreadCorpusReadinessCommand(harness.deps)();
}

function expectNoPrivateOutput(harness: Harness): void {
  const output = harness.stdout.join('');
  for (const marker of [
    PRIVATE_ADDRESS_MARKER,
    PRIVATE_PATH_MARKER,
    PRIVATE_ERROR_MARKER,
    PRIVATE_PREFIX_MARKER,
    PRIVATE_DB_URL_MARKER,
    PRIVATE_AWS_RESPONSE_MARKER,
  ]) {
    expect(output).not.toContain(marker);
  }
}

describe('check-centurion-thread-corpus-readiness command', () => {
  it('returns exact fixed ready report after all synthetic runtime gates pass', async () => {
    const harness = makeHarness();

    expect(await run(harness)).toBe(0);
    expect(harness.stdout).toEqual([report(true)]);
    expect(harness.calls).toEqual([
      'args',
      'platform',
      'scriptPath',
      'readinessConfig',
      'operatorConfig',
      'environment',
      'git:revision',
      'git:worktree',
      'git:status',
      'imds',
      'disk',
      'ignored',
      'windowsTarget',
      'policySimulation',
      'metadataProbes',
      'stdout',
    ]);
    expectNoPrivateOutput(harness);
  });

  it('returns a private-binding attestation only through the in-process assessment', async () => {
    const harness = makeHarness();

    const assessment = await assessCenturionThreadCorpusReadiness(harness.deps);

    expect(assessment.report.ready).toBe(true);
    expect(assessment.attestation).toEqual({
      schemaVersion: 'centurion-thread-corpus-readiness-attestation-v1',
      corpusContractId: 'centurion-thread-corpus-v2',
      readinessReportVersion: 'centurion-thread-corpus-readiness-report-v1',
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.stdout).toEqual([]);
    expectNoPrivateOutput(harness);
    expect(JSON.stringify(assessment)).not.toContain(PRIVATE_ADDRESS_MARKER);
    expect(JSON.stringify(assessment)).not.toContain(PRIVATE_PREFIX_MARKER);
  });

  it.each([
    {
      name: 'allowed source DB mutation',
      results: () =>
        syntheticPolicyResults().map((result) =>
          result.action === 'rds:ModifyDBInstance' ? { ...result, decision: 'allowed' } : result,
        ),
    },
    {
      name: 'allowed source object mutation',
      results: () =>
        syntheticPolicyResults().map((result) =>
          result.action === 's3:PutObject' ? { ...result, decision: 'allowed' } : result,
        ),
    },
    {
      name: 'allowed source bucket-policy mutation',
      results: () =>
        syntheticPolicyResults().map((result) =>
          result.action === 's3:PutBucketPolicy' ? { ...result, decision: 'allowed' } : result,
        ),
    },
    {
      name: 'allowed source key-policy mutation',
      results: () =>
        syntheticPolicyResults().map((result) =>
          result.action === 'kms:PutKeyPolicy' ? { ...result, decision: 'allowed' } : result,
        ),
    },
    {
      name: 'unknown capability result',
      results: () => [
        ...syntheticPolicyResults(),
        {
          action: 's3:DeleteObject',
          resource: `arn:aws:s3:::synthetic-private-bucket/${PRIVATE_PREFIX_MARKER}/readiness-probe`,
          decision: 'implicitDeny',
        },
      ],
    },
    {
      name: 'duplicate capability result',
      results: () => {
        const results = syntheticPolicyResults();
        results[7] = { ...results[6]! };
        return results;
      },
    },
    {
      name: 'missing capability result',
      results: () => syntheticPolicyResults().slice(0, -1),
    },
    {
      name: 'mismatched capability resource',
      results: () =>
        syntheticPolicyResults().map((result) =>
          result.action === 'rds:ModifyDBInstance'
            ? { ...result, resource: 'arn:aws:rds:synthetic-region-1:123456789012:db:other-db' }
            : result,
        ),
    },
    {
      name: 'malformed capability result',
      results: () =>
        [
          ...syntheticPolicyResults().slice(0, -1),
          { action: 3, resource: null, decision: false },
        ] as unknown as Array<{ action: string; resource: string; decision: string }>,
    },
  ])('blocks $name without leaking protected values', async ({ results }) => {
    const harness = makeHarness();
    harness.deps.simulateReadOnlyPolicy = async () => results();

    expect(await run(harness)).toBe(3);
    expect(JSON.parse(harness.stdout[0]!) as { ready: boolean }).toMatchObject({ ready: false });
    expectNoPrivateOutput(harness);
  });

  it('rejects duplicate protected readiness config keys before capability probes', async () => {
    const harness = makeHarness();
    harness.deps.readProtectedConfig = async (request) =>
      request.configPath === CONFIG_PATH
        ? configText().replace(
            '"kmsKeyId":"arn:aws:kms:synthetic-region-1:123456789012:key/synthetic"',
            '"kmsKeyId":"arn:aws:kms:synthetic-region-1:123456789012:key/synthetic","kmsKeyId":"arn:aws:kms:synthetic-region-1:123456789012:key/synthetic"',
          )
        : operatorConfigText();

    expect(await run(harness)).toBe(3);
    expect(harness.calls).not.toContain('policySimulation');
    expect(harness.calls).not.toContain('metadataProbes');
    expectNoPrivateOutput(harness);
  });

  it('returns fixed blocked report and exit 2 for arguments before runtime capability calls', async () => {
    const harness = makeHarness();
    harness.deps.args = () => ['--unexpected'];

    expect(await run(harness)).toBe(2);
    expect(harness.stdout).toEqual([report(false)]);
    expectNoPrivateOutput(harness);
  });

  it.each([
    {
      name: 'non-Linux runtime',
      configure: (harness: Harness) => {
        harness.deps.platform = () => 'darwin';
      },
    },
    {
      name: 'IMDSv2 mismatch',
      configure: (harness: Harness) => {
        harness.deps.attestImdsV2 = async () => false;
      },
    },
    {
      name: 'malformed protected config',
      configure: (harness: Harness) => {
        harness.deps.readProtectedConfig = async () => `{${PRIVATE_ERROR_MARKER}}`;
      },
    },
    {
      name: 'divergent canonical source scope',
      configure: (harness: Harness) => {
        harness.deps.readProtectedConfig = async (request) =>
          request.configPath === CONFIG_PATH
            ? configText()
            : operatorConfigText({
                source: {
                  centurionTransportId: 'different-transport',
                  designatedTransportId: 'synthetic-designated-transport',
                  designatedIngestMailboxIds: ['synthetic-mailbox'],
                  designatedAddresses: [` ${PRIVATE_ADDRESS_MARKER} `],
                },
              });
      },
    },
    {
      name: 'non-IAM policy source ARN',
      configure: (harness: Harness) => {
        harness.deps.readProtectedConfig = async () =>
          configText({
            readOnlyCapabilityProbe: {
              policySourceArn: 'arn:aws:sts::123456789012:assumed-role/synthetic/session',
              kmsKeyId: 'synthetic-kms-key',
            },
          });
      },
    },
    {
      name: 'revision mismatch',
      configure: (harness: Harness) => {
        harness.deps.inspectGit = (request) =>
          request.check === 'revision' ? 'wrong-revision\n' : REPO_ROOT + '\n';
      },
    },
    {
      name: 'worktree mismatch',
      configure: (harness: Harness) => {
        harness.deps.inspectGit = (request) =>
          request.check === 'worktree' ? '/wrong/worktree\n' : 'f4581cf6\n';
      },
    },
    {
      name: 'dirty worktree',
      configure: (harness: Harness) => {
        harness.deps.inspectGit = (request) =>
          request.check === 'status'
            ? ' M synthetic\n'
            : request.check === 'revision'
              ? 'f4581cf6\n'
              : `${REPO_ROOT}\n`;
      },
    },
    {
      name: 'environment allowlist mismatch',
      configure: (harness: Harness) => {
        harness.deps.environment = () => ({
          AWS_REGION: 'wrong-region',
          S3_BUCKET: 'synthetic-private-bucket',
        });
      },
    },
    {
      name: 'insufficient source disk',
      configure: (harness: Harness) => {
        harness.deps.availableBytes = () => 4095;
      },
    },
    {
      name: 'unignored private destination',
      configure: (harness: Harness) => {
        harness.deps.isIgnored = () => false;
      },
    },
    {
      name: 'unsafe future Windows target',
      configure: (harness: Harness) => {
        harness.deps.isStructurallySafeWindowsTarget = () => false;
      },
    },
    {
      name: 'failed policy simulation',
      configure: (harness: Harness) => {
        harness.deps.simulateReadOnlyPolicy = async () => [
          { action: 'rds:DescribeDBInstances', resource: '*', decision: 'allowed' },
          { action: 's3:ListBucket', resource: 'wrong-resource', decision: 'allowed' },
          { action: 's3:GetObject', resource: 'wrong-resource', decision: 'denied' },
        ];
      },
    },
    {
      name: 'wrong policy action result',
      configure: (harness: Harness) => {
        harness.deps.simulateReadOnlyPolicy = async () => [
          { action: 'rds:DescribeDBInstances', resource: '*', decision: 'allowed' },
          {
            action: 's3:ListObjectsV2',
            resource: 'arn:aws:s3:::synthetic-private-bucket',
            decision: 'allowed',
          },
          {
            action: 's3:GetObject',
            resource: `arn:aws:s3:::synthetic-private-bucket/${PRIVATE_PREFIX_MARKER}/readiness-probe`,
            decision: 'allowed',
          },
          {
            action: 'kms:DescribeKey',
            resource: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
            decision: 'allowed',
          },
        ];
      },
    },
    {
      name: 'failed S3 or KMS metadata probe',
      configure: (harness: Harness) => {
        harness.deps.probeS3AndKmsMetadata = async () => false;
      },
    },
  ])('fails closed for $name without leaking private values', async ({ configure }) => {
    const harness = makeHarness();
    configure(harness);

    expect(await run(harness)).toBe(3);
    expect(JSON.parse(harness.stdout[0]!) as { ready: boolean }).toMatchObject({
      ready: false,
    });
    expectNoPrivateOutput(harness);
  });

  it('preserves completed safe checks when a later metadata probe blocks readiness', async () => {
    const harness = makeHarness();
    harness.deps.probeS3AndKmsMetadata = async () => false;

    expect(await run(harness)).toBe(3);
    expect(
      JSON.parse(harness.stdout[0]!) as { ready: boolean; checks: Record<string, boolean> },
    ).toMatchObject({
      ready: false,
      checks: {
        exactEc2RevisionWorktree: true,
        imdsV2Identity: true,
        protectedConfig: true,
        designatedMailboxScope: true,
        regionBucketPrefixAllowlist: true,
        readOnlyDbS3KmsCapabilities: false,
        sourceDiskHeadroom: true,
        privateDestinationIgnored: true,
        windowsLocalAclTarget: true,
        v2Semantics: true,
      },
    });
    expectNoPrivateOutput(harness);
  });

  it.each([PRIVATE_WILDCARD_PREFIX_MARKER, PRIVATE_VARIABLE_PREFIX_MARKER])(
    'blocks wildcard or variable prefix %s before policy and metadata probes',
    async (prefix) => {
      const harness = makeHarness();
      harness.deps.readProtectedConfig = async (request) =>
        request.configPath === CONFIG_PATH
          ? configText({
              approvedExportTarget: {
                region: 'synthetic-region-1',
                bucket: 'synthetic-private-bucket',
                prefix,
              },
            })
          : operatorConfigText();

      expect(await run(harness)).toBe(3);
      expect(harness.calls).not.toContain('policySimulation');
      expect(harness.calls).not.toContain('metadataProbes');
      expect(harness.stdout[0]).not.toContain(prefix);
      expectNoPrivateOutput(harness);
    },
  );
});

describe('fixed readiness process adapters', () => {
  function trustedInspector() {
    return {
      inspect: async (executable: string) =>
        executable === EC2_GIT || executable === EC2_AWS
          ? {
              path: executable,
              stableIdentity: `synthetic:${executable}`,
              regularFile: true as const,
              symbolicLink: false as const,
              owner: 'root' as const,
              writableByOthers: false as const,
            }
          : null,
    };
  }

  it('uses fixed absolute Git and AWS executables with exact bounded invocations', async () => {
    const gitCalls: Array<{
      executable: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      shell: boolean;
    }> = [];
    const awsCalls: Array<{
      executable: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
      shell: boolean;
    }> = [];
    const adapters = createFixedReadinessProcessAdapters(
      trustedInspector(),
      {
        run: (invocation) => {
          gitCalls.push(invocation);
          return { failed: false, status: 0, stdout: 'f4581cf6\n' };
        },
      },
      {
        run: (invocation) => {
          awsCalls.push(invocation);
          if (invocation.args[0] !== 'iam') {
            return { failed: false, status: 0, stdout: '' };
          }
          const action = invocation.args[5]!;
          const resource = invocation.args[7]!;
          const decision =
            action === 's3:PutObject' || action === 'kms:PutKeyPolicy'
              ? 'explicitDeny'
              : ['rds:ModifyDBInstance', 's3:PutBucketPolicy'].includes(action)
                ? 'implicitDeny'
                : 'allowed';
          return {
            failed: false,
            status: 0,
            stdout: JSON.stringify({
              EvaluationResults: [
                {
                  EvalActionName: action,
                  EvalResourceName: resource,
                  EvalDecision: decision,
                },
              ],
            }),
          };
        },
      },
    );

    expect(
      await adapters.inspectGit({
        check: 'revision',
        cwd: '/synthetic/zero',
      }),
    ).toBe('f4581cf6\n');
    const results = await adapters.simulateReadOnlyPolicy({
      region: 'synthetic-region-1',
      bucket: 'synthetic-private-bucket',
      prefix: PRIVATE_PREFIX_MARKER,
      policySourceArn: 'arn:aws:iam::123456789012:role/synthetic-readonly-role',
      kmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
      dbInstanceArn: DB_INSTANCE_ARN,
    });

    expect(results).toEqual(syntheticPolicyResults());
    expect(gitCalls).toEqual([
      expect.objectContaining({
        executable: EC2_GIT,
        args: ['rev-parse', 'HEAD'],
        shell: false,
      }),
    ]);
    expect(awsCalls.filter((call) => call.args[0] === 'iam').map((call) => call.args[5])).toEqual([
      'rds:DescribeDBInstances',
      's3:ListBucket',
      's3:GetObject',
      'kms:DescribeKey',
      'rds:ModifyDBInstance',
      's3:PutObject',
      's3:PutBucketPolicy',
      'kms:PutKeyPolicy',
    ]);
    for (const invocation of [...gitCalls, ...awsCalls]) {
      expect(invocation.executable).toMatch(/^\/(?:usr\/bin\/git|usr\/local\/bin\/aws)$/);
      expect(invocation.shell).toBe(false);
      expect(Object.keys(invocation.env)).not.toEqual(
        expect.arrayContaining([
          'PATH',
          'PATHEXT',
          'HOME',
          'AWS_PROFILE',
          'AWS_ENDPOINT_URL',
          'HTTPS_PROXY',
          'GIT_DIR',
        ]),
      );
    }
    expect(awsCalls.every((invocation) => invocation.cwd === '/')).toBe(true);
  });

  it('rejects duplicate raw policy response fields before returning a capability result', async () => {
    const adapters = createFixedReadinessProcessAdapters(
      trustedInspector(),
      {
        run: () => ({ failed: false, status: 0, stdout: '' }),
      },
      {
        run: () => ({
          failed: false,
          status: 0,
          stdout:
            '{"EvaluationResults":[],"EvaluationResults":[{"EvalActionName":"rds:DescribeDBInstances","EvalResourceName":"arn:aws:rds:synthetic-region-1:123456789012:db:synthetic-source-db","EvalDecision":"allowed"}]}',
        }),
      },
    );

    await expect(
      adapters.simulateReadOnlyPolicy({
        region: 'synthetic-region-1',
        bucket: 'synthetic-private-bucket',
        prefix: PRIVATE_PREFIX_MARKER,
        policySourceArn: 'arn:aws:iam::123456789012:role/synthetic-readonly-role',
        kmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
        dbInstanceArn: DB_INSTANCE_ARN,
      }),
    ).resolves.toBeNull();
  });

  it('blocks a non-exact DB resource before invoking AWS', async () => {
    const awsRunner = {
      run: vi.fn(() => ({ failed: false, status: 0, stdout: '' })),
    };
    const adapters = createFixedReadinessProcessAdapters(
      trustedInspector(),
      {
        run: () => ({ failed: false, status: 0, stdout: '' }),
      },
      awsRunner,
    );

    await expect(
      adapters.simulateReadOnlyPolicy({
        region: 'synthetic-region-1',
        bucket: 'synthetic-private-bucket',
        prefix: PRIVATE_PREFIX_MARKER,
        policySourceArn: 'arn:aws:iam::123456789012:role/synthetic-readonly-role',
        kmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
        dbInstanceArn: 'arn:aws:rds:synthetic-region-1:123456789012:db:*',
      }),
    ).resolves.toBeNull();
    expect(awsRunner.run).not.toHaveBeenCalled();
  });
});

function sourceViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'check-centurion-thread-corpus-readiness.ts',
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const violations: string[] = [];
  const forbidden = ['CopyObject', 'DeleteObject', 'dotenv', 'SSM', 'DATABASE_URL', 'fromEnv'];
  const containingDeclarationName = (
    node: ts.Node,
    predicate: (candidate: ts.Node) => candidate is ts.Declaration,
  ): string | null => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      const declaration = current as ts.Declaration & { name?: ts.Node };
      if (predicate(current) && declaration.name && ts.isIdentifier(declaration.name)) {
        return declaration.name.text;
      }
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (forbidden.some((token) => node.text.includes(token))) {
        violations.push(`forbidden capability: ${node.text}`);
      }
    }
    if (ts.isIdentifier(node) && ['eval', 'Function', 'require'].includes(node.text)) {
      violations.push(`indirect runtime capability: ${node.text}`);
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'constructor')
    ) {
      violations.push('constructor reflection');
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push('dynamic import');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'spawnSync') {
        const options = node.arguments[2];
        const executable = node.arguments[0]?.getText(sourceFile);
        const className = containingDeclarationName(node, ts.isClassDeclaration);
        if (
          !options?.getText(sourceFile).includes('shell: false') ||
          (executable !== 'EC2_GIT' && executable !== 'EC2_AWS') ||
          (className !== 'Ec2GitProcessAdapter' && className !== 'Ec2AwsProcessAdapter')
        ) {
          violations.push('child process without shell false');
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'writeStdout' &&
        containingDeclarationName(node, ts.isFunctionDeclaration) !== 'writeReport'
      ) {
        violations.push('raw output forwarding');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('check readiness command source boundary', () => {
  it('allows only fixed process adapters and fixed report output', () => {
    const sourcePath = fileURLToPath(
      new URL('../scripts/check-centurion-thread-corpus-readiness.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(sourceViolations(source)).toEqual([]);
    expect(source).toContain('O_NOFOLLOW');
    expect(source).toContain('lstatSync');
    expect(source).toContain('fstatSync');
    expect(source).toContain('realpathSync');
    expect(source).toContain('simulate-principal-policy');
    expect(source).toContain('--resource-arns');
    expect(source).toContain('rds:DescribeDBInstances');
    expect(source).toContain('s3:GetObject');
    expect(source).toContain('rds:ModifyDBInstance');
    expect(source).toContain('s3:PutObject');
    expect(source).toContain('s3:PutBucketPolicy');
    expect(source).toContain('kms:PutKeyPolicy');
    expect(source).toContain('head-bucket');
    expect(source).toContain('describe-key');
    expect(source).toContain('shell: false');
  });
});
