import {
  centurionThreadCorpusReadinessConfigSchema,
  evaluateCenturionThreadCorpusReadiness,
  type CenturionThreadCorpusReadinessConfig,
  type CenturionThreadCorpusReadinessReport,
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
const IMDS_HOST = '169.254.169.254';
const IMDS_TIMEOUT_MS = 1_000;
const IMDS_MAX_RESPONSE_BYTES = 1_024;

type ProtectedConfigRequest = {
  repoRoot: string;
  corpusRoot: string;
  configPath: string;
};

type GitCheck = 'revision' | 'worktree' | 'status';

export type CenturionThreadCorpusReadinessCommandDependencies = {
  args(): readonly string[];
  platform(): string;
  scriptPath(): string;
  attestImdsV2(instanceId: string): Promise<boolean>;
  readProtectedConfig(request: ProtectedConfigRequest): Promise<string>;
  environment(): Readonly<{ AWS_REGION?: string; S3_BUCKET?: string }>;
  inspectGit(request: { check: GitCheck; cwd: string }): string | null;
  availableBytes(root: string): number | null;
  isIgnored(request: { repoRoot: string; relativePath: string }): boolean;
  isStructurallySafeWindowsTarget(target: string): boolean;
  simulateReadOnlyPolicy(request: {
    region: string;
    bucket: string;
    policySourceArn: string;
  }): Promise<boolean>;
  probeS3AndKmsMetadata(request: {
    region: string;
    bucket: string;
    kmsKeyId: string;
  }): Promise<boolean>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
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
  if (
    request.corpusRoot !== expectedCorpusRoot ||
    request.configPath !== path.posix.join(expectedCorpusRoot, CONFIG_FILE_NAME)
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

function defaultInspectGit(request: { check: GitCheck; cwd: string }): string | null {
  const args =
    request.check === 'revision'
      ? ['rev-parse', 'HEAD']
      : request.check === 'worktree'
        ? ['rev-parse', '--show-toplevel']
        : ['status', '--porcelain=v1', '--untracked-files=all'];
  const result = spawnSync('git', args, {
    cwd: request.cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    return null;
  }
  return result.stdout;
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

function defaultIsIgnored(request: { repoRoot: string; relativePath: string }): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', request.relativePath], {
    cwd: request.repoRoot,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.error === undefined && result.signal === null && result.status === 0;
}

function defaultIsStructurallySafeWindowsTarget(target: string): boolean {
  return (
    /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]$/.test(target) &&
    !target.includes('..') &&
    !target.endsWith('\\')
  );
}

function successfulAws(result: ReturnType<typeof spawnSync>): boolean {
  return result.error === undefined && result.signal === null && result.status === 0;
}

function defaultSimulateReadOnlyPolicy(request: {
  region: string;
  bucket: string;
  policySourceArn: string;
}): Promise<boolean> {
  try {
    const simulation = spawnSync(
      'aws',
      [
        'iam',
        'simulate-principal-policy',
        '--policy-source-arn',
        request.policySourceArn,
        '--action-names',
        'rds:DescribeDBInstances',
        's3:ListBucket',
        'kms:DescribeKey',
        '--no-cli-pager',
        '--output',
        'json',
      ],
      {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    if (!successfulAws(simulation) || typeof simulation.stdout !== 'string') {
      return Promise.resolve(false);
    }
    const parsed = JSON.parse(simulation.stdout) as {
      EvaluationResults?: Array<{ EvalDecision?: unknown }>;
    };
    if (
      !Array.isArray(parsed.EvaluationResults) ||
      parsed.EvaluationResults.length !== 3 ||
      parsed.EvaluationResults.some((result) => result.EvalDecision !== 'allowed')
    ) {
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function defaultProbeS3AndKmsMetadata(request: {
  region: string;
  bucket: string;
  kmsKeyId: string;
}): Promise<boolean> {
  try {
    const bucketProbe = spawnSync(
      'aws',
      [
        's3api',
        'head-bucket',
        '--bucket',
        request.bucket,
        '--region',
        request.region,
        '--no-cli-pager',
      ],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const keyProbe = spawnSync(
      'aws',
      [
        'kms',
        'describe-key',
        '--key-id',
        request.kmsKeyId,
        '--region',
        request.region,
        '--no-cli-pager',
      ],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    return Promise.resolve(successfulAws(bucketProbe) && successfulAws(keyProbe));
  } catch {
    return Promise.resolve(false);
  }
}

function parseConfig(value: string): CenturionThreadCorpusReadinessConfig | null {
  try {
    const parsed = centurionThreadCorpusReadinessConfigSchema.safeParse(JSON.parse(value));
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

function isExactGitState(
  dependencies: CenturionThreadCorpusReadinessCommandDependencies,
  config: CenturionThreadCorpusReadinessConfig,
  repoRoot: string,
): boolean {
  return (
    dependencies.inspectGit({ check: 'revision', cwd: repoRoot }) ===
      `${config.expectedEc2.revision}\n` &&
    dependencies.inspectGit({ check: 'worktree', cwd: repoRoot }) ===
      `${config.expectedEc2.worktree}\n` &&
    dependencies.inspectGit({ check: 'status', cwd: repoRoot }) === ''
  );
}

export function createCenturionThreadCorpusReadinessCommand(
  overrides: Partial<CenturionThreadCorpusReadinessCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: CenturionThreadCorpusReadinessCommandDependencies = {
    args: () => process.argv.slice(2),
    platform: () => process.platform,
    scriptPath: () => fileURLToPath(import.meta.url),
    attestImdsV2: defaultAttestImdsV2,
    readProtectedConfig: defaultReadProtectedConfig,
    environment: () => ({
      AWS_REGION: process.env.AWS_REGION,
      S3_BUCKET: process.env.S3_BUCKET,
    }),
    inspectGit: defaultInspectGit,
    availableBytes: defaultAvailableBytes,
    isIgnored: defaultIsIgnored,
    isStructurallySafeWindowsTarget: defaultIsStructurallySafeWindowsTarget,
    simulateReadOnlyPolicy: defaultSimulateReadOnlyPolicy,
    probeS3AndKmsMetadata: defaultProbeS3AndKmsMetadata,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
    ...overrides,
  };
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
    try {
      if (dependencies.platform() !== 'linux') return fail();
      const repoRoot = repoRootFromScript(dependencies.scriptPath());
      const corpusRoot = corpusRootFor(repoRoot);
      const config = parseConfig(
        await dependencies.readProtectedConfig({
          repoRoot,
          corpusRoot,
          configPath: path.posix.join(corpusRoot, CONFIG_FILE_NAME),
        }),
      );
      if (config === null) return fail();
      const imdsV2Identity = await dependencies.attestImdsV2(config.expectedEc2.instanceId);
      const environment = dependencies.environment();
      const allReady =
        imdsV2Identity &&
        environment.AWS_REGION === config.approvedExportTarget.region &&
        environment.S3_BUCKET === config.approvedExportTarget.bucket &&
        isExactGitState(dependencies, config, repoRoot) &&
        (() => {
          const availableBytes = dependencies.availableBytes(repoRoot);
          return availableBytes !== null && availableBytes >= config.minimumSourceDiskHeadroomBytes;
        })() &&
        dependencies.isIgnored({
          repoRoot,
          relativePath: CORPUS_PATH_SEGMENTS.join('/'),
        }) &&
        dependencies.isStructurallySafeWindowsTarget(config.privateDestination.localTarget) &&
        (await dependencies.simulateReadOnlyPolicy({
          region: config.approvedExportTarget.region,
          bucket: config.approvedExportTarget.bucket,
          policySourceArn: config.readOnlyCapabilityProbe.policySourceArn,
        })) &&
        (await dependencies.probeS3AndKmsMetadata({
          region: config.approvedExportTarget.region,
          bucket: config.approvedExportTarget.bucket,
          kmsKeyId: config.readOnlyCapabilityProbe.kmsKeyId,
        }));
      const report = evaluateCenturionThreadCorpusReadiness(
        config,
        allReady
          ? {
              exactEc2RevisionWorktree: true,
              imdsV2Identity: true,
              protectedConfig: true,
              designatedMailboxScope: true,
              regionBucketPrefixAllowlist: true,
              readOnlyDbS3KmsCapabilities: true,
              sourceDiskHeadroom: true,
              privateDestinationIgnored: true,
              windowsLocalAclTarget: true,
              v2Semantics: true,
            }
          : null,
      );
      writeReport(dependencies, report);
      return report.ready ? 0 : 3;
    } catch {
      writeReport(dependencies, blockedReport());
      return 3;
    }
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
