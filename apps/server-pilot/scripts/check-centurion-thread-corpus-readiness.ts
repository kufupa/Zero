import {
  buildCenturionThreadCorpusReadinessAttestation,
  centurionThreadCorpusReadinessConfigSchema,
  evaluateCenturionThreadCorpusReadiness,
  parseJsonWithoutDuplicateKeys,
  type CapabilityExpectation,
  type CenturionThreadCorpusReadinessAttestationV1,
  type CenturionThreadCorpusReadinessConfig,
  type CenturionThreadCorpusReadinessReport,
  type ReadinessAttestationBindingInputV1,
} from '../src/ops/centurion-thread-corpus-readiness.js';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CORPUS_PATH_SEGMENTS = ['.private', 'centurion-thread-corpus'] as const;
const CONFIG_FILE_NAME = 'readiness-config.json';
const OPERATOR_CONFIG_FILE_NAME = 'operator-config.json';
const READINESS_PROBE_OBJECT_NAME = 'readiness-probe';
const IMDS_HOST = '169.254.169.254';
const IMDS_TIMEOUT_MS = 1_000;
const IMDS_MAX_RESPONSE_BYTES = 1_024;
export const EC2_GIT = '/usr/bin/git';
export const EC2_AWS = '/usr/local/bin/aws';
const EC2_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_KEY_2: 'core.excludesFile',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_VALUE_2: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
});
const EC2_AWS_ENV = Object.freeze({
  AWS_CONFIG_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'false',
  AWS_PAGER: '',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  NO_PROXY: '169.254.169.254',
});

type ProtectedConfigRequest = {
  repoRoot: string;
  corpusRoot: string;
  configPath: string;
};

type GitCheck = 'revision' | 'worktree' | 'status';

export type TrustedExecutableInspection = {
  path: string;
  stableIdentity: string;
  regularFile: true;
  symbolicLink: false;
  owner: 'root' | 'trusted-system';
  writableByOthers: false;
};

export type TrustedExecutableInspector = {
  inspect(executable: string): Promise<TrustedExecutableInspection | null>;
};

type Ec2GitArgs =
  | readonly ['rev-parse', 'HEAD']
  | readonly ['rev-parse', '--show-toplevel']
  | readonly ['status', '--porcelain=v1', '--untracked-files=all']
  | readonly ['check-ignore', '-q', '--no-index', string];

export type Ec2GitProcessInvocation = {
  executable: typeof EC2_GIT;
  args: Ec2GitArgs;
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
};

export type Ec2GitProcessRunner = {
  run(invocation: Ec2GitProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  };
};

type Ec2AwsArgs =
  | readonly [
      'iam',
      'simulate-principal-policy',
      '--policy-source-arn',
      string,
      '--action-names',
      string,
      '--resource-arns',
      string,
      '--region',
      string,
      '--no-cli-pager',
      '--output',
      'json',
    ]
  | readonly ['s3api', 'head-bucket', '--bucket', string, '--region', string, '--no-cli-pager']
  | readonly ['kms', 'describe-key', '--key-id', string, '--region', string, '--no-cli-pager'];

export type Ec2AwsProcessInvocation = {
  executable: typeof EC2_AWS;
  args: Ec2AwsArgs;
  cwd: '/';
  env: Readonly<Record<string, string>>;
  shell: false;
};

export type Ec2AwsProcessRunner = {
  run(invocation: Ec2AwsProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  };
};

type PolicySimulationResult = {
  action: string;
  resource: string;
  decision: string;
};

type OperatorConfig = {
  version: 1;
  source: {
    centurionTransportId: string;
    designatedTransportId: string;
    designatedIngestMailboxIds: string[];
    designatedAddresses: string[];
  };
};

export type CenturionThreadCorpusReadinessCommandDependencies = {
  args(): readonly string[];
  platform(): string;
  scriptPath(): string;
  attestImdsV2(instanceId: string): Promise<boolean>;
  readProtectedConfig(request: ProtectedConfigRequest): Promise<string>;
  environment(): Readonly<{ AWS_REGION?: string; S3_BUCKET?: string }>;
  inspectGit(request: { check: GitCheck; cwd: string }): string | null | Promise<string | null>;
  availableBytes(root: string): number | null;
  isIgnored(request: { repoRoot: string; relativePath: string }): boolean | Promise<boolean>;
  isStructurallySafeWindowsTarget(target: string): boolean;
  simulateReadOnlyPolicy(request: {
    region: string;
    bucket: string;
    prefix: string;
    policySourceArn: string;
    kmsKeyId: string;
    dbInstanceArn: string;
  }): Promise<readonly PolicySimulationResult[] | null>;
  probeS3AndKmsMetadata(request: {
    region: string;
    bucket: string;
    kmsKeyId: string;
  }): Promise<boolean>;
  writeStdout(value: string): void;
};

function fail(): never {
  throw new Error('readiness check blocked');
}

function canonicalAbsolutePath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function repoRootFromScript(scriptPath: string): string {
  if (!canonicalAbsolutePath(scriptPath)) return fail();
  return path.posix.resolve(path.posix.dirname(scriptPath), '../../..');
}

function corpusRootFor(repoRoot: string): string {
  if (!canonicalAbsolutePath(repoRoot)) return fail();
  return path.posix.join(repoRoot, ...CORPUS_PATH_SEGMENTS);
}

function currentEffectiveUid(): number {
  const uid = process.geteuid?.();
  if (typeof uid !== 'number') return fail();
  return uid;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function trustedDirectory(directory: string): { dev: number; ino: number } {
  const stats = lstatSync(directory);
  const uid = currentEffectiveUid();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.uid !== uid && stats.uid !== 0) ||
    (stats.mode & 0o022) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    return fail();
  }
  return { dev: stats.dev, ino: stats.ino };
}

function trustedConfigLeaf(configPath: string): { dev: number; ino: number } {
  const stats = lstatSync(configPath);
  const uid = currentEffectiveUid();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.uid !== uid && stats.uid !== 0) ||
    (stats.mode & 0o077) !== 0
  ) {
    return fail();
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function defaultReadProtectedConfig(request: ProtectedConfigRequest): Promise<string> {
  const expectedCorpusRoot = corpusRootFor(request.repoRoot);
  const readinessPath = path.posix.join(expectedCorpusRoot, CONFIG_FILE_NAME);
  const operatorPath = path.posix.join(expectedCorpusRoot, OPERATOR_CONFIG_FILE_NAME);
  if (
    request.corpusRoot !== expectedCorpusRoot ||
    (request.configPath !== readinessPath && request.configPath !== operatorPath)
  ) {
    return fail();
  }
  const directories = [
    request.repoRoot,
    path.posix.join(request.repoRoot, '.private'),
    request.corpusRoot,
  ];
  let descriptor: number | undefined;
  try {
    const identities = directories.map(trustedDirectory);
    const preOpen = trustedConfigLeaf(request.configPath);
    descriptor = openSync(request.configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(preOpen, opened)) {
      return fail();
    }
    const content = readFileSync(descriptor, 'utf8');
    if (!sameIdentity(preOpen, trustedConfigLeaf(request.configPath))) {
      return fail();
    }
    for (let index = 0; index < directories.length; index += 1) {
      if (!sameIdentity(identities[index]!, trustedDirectory(directories[index]!))) {
        return fail();
      }
    }
    return content;
  } catch {
    return fail();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function requestImds(
  method: 'GET' | 'PUT',
  requestPath: string,
  headers: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = httpRequest(
        {
          agent: false,
          headers,
          host: IMDS_HOST,
          method,
          path: requestPath,
          port: 80,
          protocol: 'http:',
          timeout: IMDS_TIMEOUT_MS,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.byteLength;
            if (bytes > IMDS_MAX_RESPONSE_BYTES) {
              request.destroy();
              finish(null);
              return;
            }
            chunks.push(value);
          });
          response.on('error', () => finish(null));
          response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        },
      );
      request.on('error', () => finish(null));
      request.setTimeout(IMDS_TIMEOUT_MS, () => {
        request.destroy();
        finish(null);
      });
      request.end();
    } catch {
      finish(null);
    }
  });
}

async function defaultAttestImdsV2(instanceId: string): Promise<boolean> {
  const token = await requestImds('PUT', '/latest/api/token', {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token || token.length > IMDS_MAX_RESPONSE_BYTES) return false;
  const actualInstanceId = await requestImds('GET', '/latest/meta-data/instance-id', {
    'X-aws-ec2-metadata-token': token,
  });
  return actualInstanceId === instanceId;
}

function defaultAvailableBytes(root: string): number | null {
  try {
    const stats = statfsSync(root);
    const bytes = stats.bavail * stats.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

function defaultIsStructurallySafeWindowsTarget(target: string): boolean {
  return (
    /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]$/.test(target) &&
    !target.includes('..') &&
    !target.endsWith('\\')
  );
}

function isSafeBucketName(bucket: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/.test(bucket);
}

function objectProbeArn(bucket: string, prefix: string): string | null {
  if (
    !isSafeBucketName(bucket) ||
    !prefix ||
    prefix.includes('\\') ||
    prefix.includes('\0') ||
    prefix.includes('*') ||
    prefix.includes('?') ||
    prefix.includes('$') ||
    prefix.includes('{') ||
    prefix.includes('}') ||
    prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return `arn:aws:s3:::${bucket}/${prefix}/${READINESS_PROBE_OBJECT_NAME}`;
}

function isKmsKeyArn(value: string): boolean {
  return /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(value);
}

function isExactRdsInstanceArn(value: string): boolean {
  return /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:db:[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
    value,
  );
}

function expectedPolicyPairs(request: {
  bucket: string;
  prefix: string;
  kmsKeyId: string;
  dbInstanceArn: string;
}): CapabilityExpectation[] | null {
  const objectArn = objectProbeArn(request.bucket, request.prefix);
  if (
    !objectArn ||
    !isKmsKeyArn(request.kmsKeyId) ||
    !isExactRdsInstanceArn(request.dbInstanceArn)
  ) {
    return null;
  }
  return [
    {
      action: 'rds:DescribeDBInstances',
      resource: '*',
      requiredDecision: 'allowed',
    },
    {
      action: 's3:ListBucket',
      resource: `arn:aws:s3:::${request.bucket}`,
      requiredDecision: 'allowed',
    },
    { action: 's3:GetObject', resource: objectArn, requiredDecision: 'allowed' },
    { action: 'kms:DescribeKey', resource: request.kmsKeyId, requiredDecision: 'allowed' },
    {
      action: 'rds:ModifyDBInstance',
      resource: request.dbInstanceArn,
      requiredDecision: 'not_allowed',
    },
    { action: 's3:PutObject', resource: objectArn, requiredDecision: 'not_allowed' },
    {
      action: 's3:PutBucketPolicy',
      resource: `arn:aws:s3:::${request.bucket}`,
      requiredDecision: 'not_allowed',
    },
    { action: 'kms:PutKeyPolicy', resource: request.kmsKeyId, requiredDecision: 'not_allowed' },
  ];
}

function trustedEc2Executable(
  inspection: TrustedExecutableInspection | null,
  executable: typeof EC2_GIT | typeof EC2_AWS,
): inspection is TrustedExecutableInspection {
  return (
    inspection !== null &&
    inspection.path === executable &&
    inspection.stableIdentity.length > 0 &&
    inspection.regularFile === true &&
    inspection.symbolicLink === false &&
    inspection.owner === 'root' &&
    inspection.writableByOthers === false &&
    path.posix.isAbsolute(inspection.path) &&
    path.posix.normalize(inspection.path) === inspection.path
  );
}

function inspectDefaultEc2Executable(
  executable: typeof EC2_GIT | typeof EC2_AWS,
): TrustedExecutableInspection | null {
  try {
    if (!path.posix.isAbsolute(executable)) return null;
    let current: string = executable;
    let executableStats: ReturnType<typeof lstatSync> | null = null;
    while (true) {
      const stats = lstatSync(current);
      if (
        stats.isSymbolicLink() ||
        stats.uid !== 0 ||
        (stats.mode & 0o022) !== 0 ||
        realpathSync(current) !== current
      ) {
        return null;
      }
      if (current === executable) {
        if (!stats.isFile()) return null;
        executableStats = stats;
      } else if (!stats.isDirectory()) {
        return null;
      }
      if (current === '/') break;
      current = path.posix.dirname(current);
    }
    if (!executableStats) return null;
    return {
      path: executable,
      stableIdentity: `${String(executableStats.dev)}:${String(executableStats.ino)}`,
      regularFile: true,
      symbolicLink: false,
      owner: 'root',
      writableByOthers: false,
    };
  } catch {
    return null;
  }
}

const defaultEc2ExecutableInspector: TrustedExecutableInspector = {
  async inspect(executable) {
    if (executable !== EC2_GIT && executable !== EC2_AWS) return null;
    return inspectDefaultEc2Executable(executable);
  },
};

function exactEc2GitArgs(args: Ec2GitArgs): boolean {
  return (
    (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD') ||
    (args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel') ||
    (args.length === 3 &&
      args[0] === 'status' &&
      args[1] === '--porcelain=v1' &&
      args[2] === '--untracked-files=all') ||
    (args.length === 4 &&
      args[0] === 'check-ignore' &&
      args[1] === '-q' &&
      args[2] === '--no-index')
  );
}

function exactEc2AwsArgs(args: Ec2AwsArgs): boolean {
  return (
    (args.length === 13 &&
      args[0] === 'iam' &&
      args[1] === 'simulate-principal-policy' &&
      args[2] === '--policy-source-arn' &&
      args[4] === '--action-names' &&
      args[6] === '--resource-arns' &&
      args[8] === '--region' &&
      args[10] === '--no-cli-pager' &&
      args[11] === '--output' &&
      args[12] === 'json') ||
    (args.length === 7 &&
      args[0] === 's3api' &&
      args[1] === 'head-bucket' &&
      args[2] === '--bucket' &&
      args[4] === '--region' &&
      args[6] === '--no-cli-pager') ||
    (args.length === 7 &&
      args[0] === 'kms' &&
      args[1] === 'describe-key' &&
      args[2] === '--key-id' &&
      args[4] === '--region' &&
      args[6] === '--no-cli-pager')
  );
}

function sameFixedEnvironment(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(actual);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([key, value]) => expected[key as keyof typeof expected] === value)
  );
}

class Ec2GitProcessAdapter implements Ec2GitProcessRunner {
  run(invocation: Ec2GitProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  } {
    if (
      invocation.executable !== EC2_GIT ||
      invocation.shell !== false ||
      !canonicalAbsolutePath(invocation.cwd) ||
      !exactEc2GitArgs(invocation.args) ||
      !sameFixedEnvironment(invocation.env, EC2_GIT_ENV)
    ) {
      return { failed: true, status: null, stdout: null };
    }
    try {
      const result = spawnSync(EC2_GIT, invocation.args, {
        cwd: invocation.cwd,
        encoding: 'utf8',
        env: invocation.env,
        maxBuffer: 65_536,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return {
        failed: result.error !== undefined || result.signal !== null,
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : null,
      };
    } catch {
      return { failed: true, status: null, stdout: null };
    }
  }
}

class Ec2AwsProcessAdapter implements Ec2AwsProcessRunner {
  run(invocation: Ec2AwsProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  } {
    if (
      invocation.executable !== EC2_AWS ||
      invocation.cwd !== '/' ||
      invocation.shell !== false ||
      !exactEc2AwsArgs(invocation.args) ||
      !sameFixedEnvironment(invocation.env, EC2_AWS_ENV)
    ) {
      return { failed: true, status: null, stdout: null };
    }
    try {
      const result = spawnSync(EC2_AWS, invocation.args, {
        cwd: '/',
        encoding: 'utf8',
        env: invocation.env,
        maxBuffer: 65_536,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return {
        failed: result.error !== undefined || result.signal !== null,
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : null,
      };
    } catch {
      return { failed: true, status: null, stdout: null };
    }
  }
}

type ReadinessProcessAdapters = {
  inspectGit(request: { check: GitCheck; cwd: string }): Promise<string | null>;
  isIgnored(request: { repoRoot: string; relativePath: string }): Promise<boolean>;
  simulateReadOnlyPolicy(request: {
    region: string;
    bucket: string;
    prefix: string;
    policySourceArn: string;
    kmsKeyId: string;
    dbInstanceArn: string;
  }): Promise<readonly PolicySimulationResult[] | null>;
  probeS3AndKmsMetadata(request: {
    region: string;
    bucket: string;
    kmsKeyId: string;
  }): Promise<boolean>;
};

export function createFixedReadinessProcessAdapters(
  inspector: TrustedExecutableInspector = defaultEc2ExecutableInspector,
  gitRunner: Ec2GitProcessRunner = new Ec2GitProcessAdapter(),
  awsRunner: Ec2AwsProcessRunner = new Ec2AwsProcessAdapter(),
): ReadinessProcessAdapters {
  const trusted = async (executable: typeof EC2_GIT | typeof EC2_AWS): Promise<boolean> =>
    trustedEc2Executable(await inspector.inspect(executable).catch(() => null), executable);
  const successful = (result: { failed: boolean; status: number | null }): boolean =>
    !result.failed && result.status === 0;

  return {
    async inspectGit(request): Promise<string | null> {
      if (!canonicalAbsolutePath(request.cwd) || !(await trusted(EC2_GIT))) return null;
      const args: Ec2GitArgs =
        request.check === 'revision'
          ? ['rev-parse', 'HEAD']
          : request.check === 'worktree'
            ? ['rev-parse', '--show-toplevel']
            : ['status', '--porcelain=v1', '--untracked-files=all'];
      const result = gitRunner.run({
        executable: EC2_GIT,
        args,
        cwd: request.cwd,
        env: EC2_GIT_ENV,
        shell: false,
      });
      return successful(result) && typeof result.stdout === 'string' ? result.stdout : null;
    },

    async isIgnored(request): Promise<boolean> {
      if (!canonicalAbsolutePath(request.repoRoot) || !(await trusted(EC2_GIT))) {
        return false;
      }
      const result = gitRunner.run({
        executable: EC2_GIT,
        args: ['check-ignore', '-q', '--no-index', request.relativePath],
        cwd: request.repoRoot,
        env: EC2_GIT_ENV,
        shell: false,
      });
      return successful(result);
    },

    async simulateReadOnlyPolicy(request): Promise<readonly PolicySimulationResult[] | null> {
      const pairs = expectedPolicyPairs(request);
      if (pairs === null || !(await trusted(EC2_AWS))) return null;
      try {
        const results: PolicySimulationResult[] = [];
        for (const pair of pairs) {
          const simulation = awsRunner.run({
            executable: EC2_AWS,
            args: [
              'iam',
              'simulate-principal-policy',
              '--policy-source-arn',
              request.policySourceArn,
              '--action-names',
              pair.action,
              '--resource-arns',
              pair.resource,
              '--region',
              request.region,
              '--no-cli-pager',
              '--output',
              'json',
            ],
            cwd: '/',
            env: EC2_AWS_ENV,
            shell: false,
          });
          if (!successful(simulation) || typeof simulation.stdout !== 'string') return null;
          const parsed = parseJsonWithoutDuplicateKeys(simulation.stdout);
          if (
            !isPlainRecord(parsed) ||
            !hasExactKeys(parsed, ['EvaluationResults']) ||
            !Array.isArray(parsed.EvaluationResults) ||
            parsed.EvaluationResults.length !== 1
          ) {
            return null;
          }
          const result = parsed.EvaluationResults[0]!;
          if (
            typeof result.EvalActionName !== 'string' ||
            typeof result.EvalResourceName !== 'string' ||
            typeof result.EvalDecision !== 'string'
          ) {
            return null;
          }
          results.push({
            action: result.EvalActionName,
            resource: result.EvalResourceName,
            decision: result.EvalDecision,
          });
        }
        return results;
      } catch {
        return null;
      }
    },

    async probeS3AndKmsMetadata(request): Promise<boolean> {
      if (!(await trusted(EC2_AWS))) return false;
      const bucketProbe = awsRunner.run({
        executable: EC2_AWS,
        args: [
          's3api',
          'head-bucket',
          '--bucket',
          request.bucket,
          '--region',
          request.region,
          '--no-cli-pager',
        ],
        cwd: '/',
        env: EC2_AWS_ENV,
        shell: false,
      });
      const keyProbe = awsRunner.run({
        executable: EC2_AWS,
        args: [
          'kms',
          'describe-key',
          '--key-id',
          request.kmsKeyId,
          '--region',
          request.region,
          '--no-cli-pager',
        ],
        cwd: '/',
        env: EC2_AWS_ENV,
        shell: false,
      });
      return successful(bucketProbe) && successful(keyProbe);
    },
  };
}

const fixedReadinessProcessAdapters = createFixedReadinessProcessAdapters();

function parseConfig(value: string): CenturionThreadCorpusReadinessConfig | null {
  try {
    const parsed = centurionThreadCorpusReadinessConfigSchema.safeParse(
      parseJsonWithoutDuplicateKeys(value),
    );
    if (
      !parsed.success ||
      !/^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:(user|group|role)\/[A-Za-z0-9+=,.@_/-]+$/.test(
        parsed.data.readOnlyCapabilityProbe.policySourceArn,
      )
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function opaqueId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function opaqueIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(opaqueId);
  return ids.every((id): id is string => id !== null) ? ids : null;
}

function normalizedAddresses(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const addresses = value.map((address) =>
    typeof address === 'string' && address.trim() ? address.trim() : null,
  );
  return addresses.every((address): address is string => address !== null) ? addresses : null;
}

function parseOperatorConfig(value: string): OperatorConfig | null {
  try {
    const parsed = parseJsonWithoutDuplicateKeys(value);
    if (
      !isPlainRecord(parsed) ||
      !hasExactKeys(parsed, ['version', 'source']) ||
      parsed.version !== 1 ||
      !isPlainRecord(parsed.source) ||
      !hasExactKeys(parsed.source, [
        'centurionTransportId',
        'designatedTransportId',
        'designatedIngestMailboxIds',
        'designatedAddresses',
      ])
    ) {
      return null;
    }
    const centurionTransportId = opaqueId(parsed.source.centurionTransportId);
    const designatedTransportId = opaqueId(parsed.source.designatedTransportId);
    const designatedIngestMailboxIds = opaqueIds(parsed.source.designatedIngestMailboxIds);
    const designatedAddresses = normalizedAddresses(parsed.source.designatedAddresses);
    if (
      centurionTransportId === null ||
      designatedTransportId === null ||
      designatedIngestMailboxIds === null ||
      designatedAddresses === null
    ) {
      return null;
    }
    return {
      version: 1,
      source: {
        centurionTransportId,
        designatedTransportId,
        designatedIngestMailboxIds,
        designatedAddresses,
      },
    };
  } catch {
    return null;
  }
}

function normalizedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSourceScope(
  config: CenturionThreadCorpusReadinessConfig,
  operator: OperatorConfig,
): boolean {
  const readiness = config.designatedSourceScope;
  const canonical = operator.source;
  return (
    readiness.centurionTransportId === canonical.centurionTransportId &&
    readiness.designatedTransportId === canonical.designatedTransportId &&
    JSON.stringify(normalizedSet(readiness.mailboxIds)) ===
      JSON.stringify(normalizedSet(canonical.designatedIngestMailboxIds)) &&
    JSON.stringify(normalizedSet(readiness.addresses)) ===
      JSON.stringify(normalizedSet(canonical.designatedAddresses))
  );
}

function hasExpectedPolicyResults(
  results: readonly PolicySimulationResult[] | null,
  request: { bucket: string; prefix: string; kmsKeyId: string; dbInstanceArn: string },
): boolean {
  const expected = expectedPolicyPairs(request);
  if (results === null || expected === null || results.length !== expected.length) {
    return false;
  }
  return (
    results.every(
      (result) =>
        typeof result.action === 'string' &&
        typeof result.resource === 'string' &&
        typeof result.decision === 'string' &&
        expected.some((pair) => pair.action === result.action && pair.resource === result.resource),
    ) &&
    expected.every((pair) => {
      const matches = results.filter(
        (result) => result.action === pair.action && result.resource === pair.resource,
      );
      return (
        matches.length === 1 &&
        (pair.requiredDecision === 'allowed'
          ? matches[0]!.decision === 'allowed'
          : matches[0]!.decision === 'implicitDeny' || matches[0]!.decision === 'explicitDeny')
      );
    })
  );
}

function blockedReport(): CenturionThreadCorpusReadinessReport {
  return evaluateCenturionThreadCorpusReadiness(null, null);
}

function writeReport(
  dependencies: CenturionThreadCorpusReadinessCommandDependencies,
  report: CenturionThreadCorpusReadinessReport,
): void {
  try {
    dependencies.writeStdout(`${JSON.stringify(report)}\n`);
  } catch {}
}

async function isExactGitState(
  dependencies: CenturionThreadCorpusReadinessCommandDependencies,
  config: CenturionThreadCorpusReadinessConfig,
  repoRoot: string,
): Promise<boolean> {
  return (
    (await dependencies.inspectGit({ check: 'revision', cwd: repoRoot })) ===
      `${config.expectedEc2.revision}\n` &&
    (await dependencies.inspectGit({ check: 'worktree', cwd: repoRoot })) ===
      `${config.expectedEc2.worktree}\n` &&
    (await dependencies.inspectGit({ check: 'status', cwd: repoRoot })) === ''
  );
}

export type CenturionThreadCorpusReadinessAssessment = {
  report: CenturionThreadCorpusReadinessReport;
  attestation: CenturionThreadCorpusReadinessAttestationV1 | null;
};

function readinessDependencies(
  overrides: Partial<CenturionThreadCorpusReadinessCommandDependencies>,
): CenturionThreadCorpusReadinessCommandDependencies {
  return {
    args: () => process.argv.slice(2),
    platform: () => process.platform,
    scriptPath: () => fileURLToPath(import.meta.url),
    attestImdsV2: defaultAttestImdsV2,
    readProtectedConfig: defaultReadProtectedConfig,
    environment: () => ({
      AWS_REGION: process.env.AWS_REGION,
      S3_BUCKET: process.env.S3_BUCKET,
    }),
    inspectGit: fixedReadinessProcessAdapters.inspectGit,
    availableBytes: defaultAvailableBytes,
    isIgnored: fixedReadinessProcessAdapters.isIgnored,
    isStructurallySafeWindowsTarget: defaultIsStructurallySafeWindowsTarget,
    simulateReadOnlyPolicy: fixedReadinessProcessAdapters.simulateReadOnlyPolicy,
    probeS3AndKmsMetadata: fixedReadinessProcessAdapters.probeS3AndKmsMetadata,
    writeStdout: (value) => process.stdout.write(value),
    ...overrides,
  };
}

function readinessBindingFor(
  config: CenturionThreadCorpusReadinessConfig,
): ReadinessAttestationBindingInputV1 {
  return {
    corpusContractId: config.corpusContractId,
    expectedInstanceId: config.expectedEc2.instanceId,
    expectedRevision: config.expectedEc2.revision,
    expectedWorktree: config.expectedEc2.worktree,
    designatedSourceScope: {
      centurionTransportId: config.designatedSourceScope.centurionTransportId,
      designatedTransportId: config.designatedSourceScope.designatedTransportId,
      mailboxIds: config.designatedSourceScope.mailboxIds,
      addresses: config.designatedSourceScope.addresses,
    },
  };
}

async function assessReadiness(
  dependencies: CenturionThreadCorpusReadinessCommandDependencies,
): Promise<CenturionThreadCorpusReadinessAssessment> {
  try {
    if (dependencies.platform() !== 'linux') return { report: blockedReport(), attestation: null };
    const repoRoot = repoRootFromScript(dependencies.scriptPath());
    const corpusRoot = corpusRootFor(repoRoot);
    const config = parseConfig(
      await dependencies.readProtectedConfig({
        repoRoot,
        corpusRoot,
        configPath: path.posix.join(corpusRoot, CONFIG_FILE_NAME),
      }),
    );
    if (config === null) return { report: blockedReport(), attestation: null };
    const operator = parseOperatorConfig(
      await dependencies.readProtectedConfig({
        repoRoot,
        corpusRoot,
        configPath: path.posix.join(corpusRoot, OPERATOR_CONFIG_FILE_NAME),
      }),
    );
    const environment = dependencies.environment();
    const protectedConfig = operator !== null;
    const regionBucketPrefixAllowlist =
      environment.AWS_REGION === config.approvedExportTarget.region &&
      environment.S3_BUCKET === config.approvedExportTarget.bucket &&
      objectProbeArn(config.approvedExportTarget.bucket, config.approvedExportTarget.prefix) !==
        null;
    const observations = {
      exactEc2RevisionWorktree: await isExactGitState(dependencies, config, repoRoot),
      imdsV2Identity: await dependencies.attestImdsV2(config.expectedEc2.instanceId),
      protectedConfig,
      designatedMailboxScope: operator !== null && sameSourceScope(config, operator),
      regionBucketPrefixAllowlist,
      readOnlyDbS3KmsCapabilities: false,
      sourceDiskHeadroom: (() => {
        const availableBytes = dependencies.availableBytes(repoRoot);
        return availableBytes !== null && availableBytes >= config.minimumSourceDiskHeadroomBytes;
      })(),
      privateDestinationIgnored: await dependencies.isIgnored({
        repoRoot,
        relativePath: CORPUS_PATH_SEGMENTS.join('/'),
      }),
      windowsLocalAclTarget: dependencies.isStructurallySafeWindowsTarget(
        config.privateDestination.localTarget,
      ),
      v2Semantics: true,
    };
    if (regionBucketPrefixAllowlist) {
      const policyResults = await dependencies.simulateReadOnlyPolicy({
        region: config.approvedExportTarget.region,
        bucket: config.approvedExportTarget.bucket,
        prefix: config.approvedExportTarget.prefix,
        policySourceArn: config.readOnlyCapabilityProbe.policySourceArn,
        kmsKeyId: config.readOnlyCapabilityProbe.kmsKeyId,
        dbInstanceArn: config.readOnlyCapabilityProbe.dbInstanceArn,
      });
      const metadataProbe = await dependencies.probeS3AndKmsMetadata({
        region: config.approvedExportTarget.region,
        bucket: config.approvedExportTarget.bucket,
        kmsKeyId: config.readOnlyCapabilityProbe.kmsKeyId,
      });
      observations.readOnlyDbS3KmsCapabilities =
        hasExpectedPolicyResults(policyResults, {
          bucket: config.approvedExportTarget.bucket,
          prefix: config.approvedExportTarget.prefix,
          kmsKeyId: config.readOnlyCapabilityProbe.kmsKeyId,
          dbInstanceArn: config.readOnlyCapabilityProbe.dbInstanceArn,
        }) && metadataProbe;
    }
    const report = evaluateCenturionThreadCorpusReadiness(config, observations);
    return {
      report,
      attestation: buildCenturionThreadCorpusReadinessAttestation(
        report,
        readinessBindingFor(config),
      ),
    };
  } catch {
    return { report: blockedReport(), attestation: null };
  }
}

export async function assessCenturionThreadCorpusReadiness(
  overrides: Partial<CenturionThreadCorpusReadinessCommandDependencies> = {},
): Promise<CenturionThreadCorpusReadinessAssessment> {
  return await assessReadiness(readinessDependencies(overrides));
}

export function createCenturionThreadCorpusReadinessCommand(
  overrides: Partial<CenturionThreadCorpusReadinessCommandDependencies> = {},
): () => Promise<number> {
  const dependencies = readinessDependencies(overrides);
  return async (): Promise<number> => {
    let args: readonly string[];
    try {
      args = dependencies.args();
    } catch {
      writeReport(dependencies, blockedReport());
      return 2;
    }
    if (args.length !== 0) {
      writeReport(dependencies, blockedReport());
      return 2;
    }
    const assessment = await assessReadiness(dependencies);
    writeReport(dependencies, assessment.report);
    return assessment.report.ready ? 0 : 3;
  };
}

export async function runCenturionThreadCorpusReadiness(
  overrides: Partial<CenturionThreadCorpusReadinessCommandDependencies> = {},
): Promise<number> {
  return await createCenturionThreadCorpusReadinessCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runCenturionThreadCorpusReadiness().then((code) => {
    process.exitCode = code;
  });
}
