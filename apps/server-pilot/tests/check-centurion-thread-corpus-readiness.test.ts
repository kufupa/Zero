import {
  createCenturionThreadCorpusReadinessCommand,
  type CenturionThreadCorpusReadinessCommandDependencies,
} from '../scripts/check-centurion-thread-corpus-readiness.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const REPO_ROOT = '/synthetic/zero';
const SCRIPT_PATH =
  '/synthetic/zero/apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts';
const CORPUS_ROOT = `${REPO_ROOT}/.private/centurion-thread-corpus`;
const CONFIG_PATH = `${CORPUS_ROOT}/readiness-config.json`;
const PRIVATE_ADDRESS_MARKER = 'PHASE_0A2_PRIVATE_ADDRESS_MARKER';
const PRIVATE_PATH_MARKER = 'PHASE_0A2_PRIVATE_PATH_MARKER';
const PRIVATE_ERROR_MARKER = 'PHASE_0A2_PRIVATE_ERROR_MARKER';
const PRIVATE_PREFIX_MARKER = 'PHASE_0A2_PRIVATE_PREFIX_MARKER';
const PRIVATE_DB_URL_MARKER = 'PHASE_0A2_PRIVATE_DATABASE_URL_MARKER';
const PRIVATE_AWS_RESPONSE_MARKER = 'PHASE_0A2_PRIVATE_AWS_RESPONSE_MARKER';

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
  stderr: string[];
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

function makeHarness(): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
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
      calls.push('config');
      expect(request).toEqual({
        repoRoot: REPO_ROOT,
        corpusRoot: CORPUS_ROOT,
        configPath: CONFIG_PATH,
      });
      return configText();
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
      expect(request.policySourceArn).toBe(
        'arn:aws:iam::123456789012:role/synthetic-readonly-role',
      );
      return true;
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
    writeStderr: (value) => {
      calls.push('stderr');
      stderr.push(value);
    },
  };
  return { calls, deps, stderr, stdout };
}

async function run(harness: Harness): Promise<number> {
  return await createCenturionThreadCorpusReadinessCommand(harness.deps)();
}

function expectNoPrivateOutput(harness: Harness): void {
  const output = `${harness.stdout.join('')}${harness.stderr.join('')}`;
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
    expect(harness.stderr).toEqual([]);
    expect(harness.calls).toEqual([
      'args',
      'platform',
      'scriptPath',
      'config',
      'imds',
      'environment',
      'git:revision',
      'git:worktree',
      'git:status',
      'disk',
      'ignored',
      'windowsTarget',
      'policySimulation',
      'metadataProbes',
      'stdout',
    ]);
    expectNoPrivateOutput(harness);
  });

  it('returns fixed blocked report and exit 2 for arguments before runtime capability calls', async () => {
    const harness = makeHarness();
    harness.deps.args = () => ['--unexpected'];

    expect(await run(harness)).toBe(2);
    expect(harness.stdout).toEqual([report(false)]);
    expect(harness.stderr).toEqual([]);
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
        harness.deps.simulateReadOnlyPolicy = async () => false;
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
    expect(harness.stdout).toEqual([report(false)]);
    expect(harness.stderr).toEqual([]);
    expectNoPrivateOutput(harness);
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
  const forbidden = [
    'PutObject',
    'CopyObject',
    'DeleteObject',
    'PutBucket',
    'PutKeyPolicy',
    'dotenv',
    'SSM',
    'DATABASE_URL',
    'fromEnv',
  ];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (forbidden.some((token) => node.text.includes(token))) {
        violations.push(`forbidden capability: ${node.text}`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'spawnSync') {
        const options = node.arguments[2];
        if (!options?.getText(sourceFile).includes('shell: false')) {
          violations.push('child process without shell false');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('check readiness command source boundary', () => {
  it('excludes writes, dotenv, SSM, DB, mailbox, and shell execution', () => {
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
    expect(source).toContain('head-bucket');
    expect(source).toContain('describe-key');
    expect(source).toContain('shell: false');
  });
});
