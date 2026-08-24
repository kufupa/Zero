import {
  createCenturionThreadCorpusExporter,
  type ClosableThreadCorpusReader,
  type ThreadCorpusExportDependencies,
  type ThreadCorpusExportRequest,
  type ThreadCorpusExportSafeResult,
} from '../src/ops/centurion-thread-corpus-exporter.js';
import {
  createThreadCorpusPostgresReader,
  type ThreadCorpusPostgresReaderOptions,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { RealS3Storage, type S3Storage } from '../src/storage/s3.js';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const CONFIG_FILE_NAME = 'operator-config.json';
const CORPUS_PATH_SEGMENTS = ['.private', 'centurion-thread-corpus'] as const;
const EXPORTER_VERSION = 'centurion-thread-corpus-live-v1';
const IMDS_HOST = '169.254.169.254';
const IMDS_MAX_RESPONSE_BYTES = 1024;
const IMDS_TIMEOUT_MS = 1_000;
export const EC2_GIT = '/usr/bin/git';
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
const SAFE_SUMMARY_KEYS = [
  'asOf',
  'includedMessageCount',
  'sourceRowCount',
  'threadCount',
  'quarantineRecordCount',
  'unscopedQuarantineCount',
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OperatorConfig = {
  version: 1;
  source: {
    centurionTransportId: string;
    designatedTransportId: string;
    designatedIngestMailboxIds: string[];
    designatedAddresses: string[];
  };
};

type ProtectedConfigRequest = {
  repoRoot: string;
  corpusRoot: string;
  configPath: string;
};

type IgnoredDestinationRequest = {
  repoRoot: string;
  relativePath: string;
};

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

export type Ec2GitIgnoreProcessInvocation = {
  executable: typeof EC2_GIT;
  args: readonly ['check-ignore', '-q', '--no-index', string];
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
};

export type Ec2GitIgnoreProcessRunner = {
  run(invocation: Ec2GitIgnoreProcessInvocation): {
    failed: boolean;
    status: number | null;
  };
};

type AllocatedDirectoryRequest = {
  repoRoot: string;
  corpusRoot: string;
  snapshotId: string;
  outDir: string;
};

type LiveStorage = Pick<S3Storage, 'kind' | 'getObjectBounded'>;

type ImdsRequest = {
  on(event: 'error', listener: () => void): unknown;
  setTimeout(milliseconds: number, listener: () => void): unknown;
  end(): unknown;
  destroy(): unknown;
};

type ImdsResponse = {
  readonly statusCode?: number;
  resume(): unknown;
  on(
    event: 'data' | 'error' | 'end',
    listener: ((chunk: Buffer | string) => void) | (() => void),
  ): unknown;
};

type ImdsRequestOptions = {
  agent: false;
  headers: Record<string, string>;
  host: string;
  method: 'GET' | 'PUT';
  path: string;
  port: number;
  protocol: 'http:';
  timeout: number;
};

export type DirectImdsRequestDependencies = {
  request(options: ImdsRequestOptions, onResponse: (response: ImdsResponse) => void): ImdsRequest;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type LiveCenturionThreadCorpusDependencies = {
  args(): readonly string[];
  platform(): string;
  scriptPath(): string;
  attestImdsV2(): Promise<boolean>;
  readProtectedConfig(request: ProtectedConfigRequest): Promise<string>;
  isIgnored(request: IgnoredDestinationRequest): boolean | Promise<boolean>;
  uuid(): string;
  environment(): Readonly<{
    DATABASE_URL?: string;
    AWS_REGION?: string;
    S3_BUCKET?: string;
  }>;
  createReader(options: ThreadCorpusPostgresReaderOptions): ClosableThreadCorpusReader;
  createRealStorage(input: { region: string; bucket: string }): LiveStorage;
  createExporter(
    dependencies: Pick<ThreadCorpusExportDependencies, 'createReader'>,
  ): (request: ThreadCorpusExportRequest) => Promise<ThreadCorpusExportSafeResult>;
  validateAllocatedDir(request: AllocatedDirectoryRequest): string;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

type PreparedExport = {
  repoRoot: string;
  corpusRoot: string;
  outDir: string;
  snapshotId: string;
  source: OperatorConfig['source'];
  storage: Pick<S3Storage, 'getObjectBounded'>;
  exporter: (request: ThreadCorpusExportRequest) => Promise<ThreadCorpusExportSafeResult>;
};

function failPreflight(): never {
  throw new Error('preflight failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return failPreflight();
  return value;
}

function opaqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return failPreflight();
  return value.map(opaqueId);
}

function normalizedAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return failPreflight();
  return value.map((address) => {
    if (typeof address !== 'string') return failPreflight();
    const normalized = address.trim();
    if (!normalized) return failPreflight();
    return normalized;
  });
}

function parseOperatorConfig(text: string): OperatorConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failPreflight();
  }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ['version', 'source'])) {
    return failPreflight();
  }
  if (parsed.version !== 1 || !isPlainRecord(parsed.source)) return failPreflight();
  if (
    !hasExactKeys(parsed.source, [
      'centurionTransportId',
      'designatedTransportId',
      'designatedIngestMailboxIds',
      'designatedAddresses',
    ])
  ) {
    return failPreflight();
  }

  return {
    version: 1,
    source: {
      centurionTransportId: opaqueId(parsed.source.centurionTransportId),
      designatedTransportId: opaqueId(parsed.source.designatedTransportId),
      designatedIngestMailboxIds: opaqueIds(parsed.source.designatedIngestMailboxIds),
      designatedAddresses: normalizedAddresses(parsed.source.designatedAddresses),
    },
  };
}

function nonBlankEnvironmentValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return failPreflight();
  return value;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function trustedEc2Executable(
  inspection: TrustedExecutableInspection | null,
): inspection is TrustedExecutableInspection {
  return (
    inspection !== null &&
    inspection.path === EC2_GIT &&
    inspection.stableIdentity.length > 0 &&
    inspection.regularFile === true &&
    inspection.symbolicLink === false &&
    inspection.owner === 'root' &&
    inspection.writableByOthers === false &&
    path.posix.isAbsolute(inspection.path) &&
    path.posix.normalize(inspection.path) === inspection.path
  );
}

function inspectDefaultEc2GitExecutable(executable: string): TrustedExecutableInspection | null {
  try {
    if (executable !== EC2_GIT || !path.posix.isAbsolute(executable)) return null;
    let current = executable;
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

const defaultEc2GitExecutableInspector: TrustedExecutableInspector = {
  async inspect(executable) {
    return inspectDefaultEc2GitExecutable(executable);
  },
};

function sameEc2GitEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return (
    entries.length === Object.keys(EC2_GIT_ENV).length &&
    entries.every(([key, value]) => EC2_GIT_ENV[key as keyof typeof EC2_GIT_ENV] === value)
  );
}

class Ec2GitIgnoreProcessAdapter implements Ec2GitIgnoreProcessRunner {
  run(invocation: Ec2GitIgnoreProcessInvocation): { failed: boolean; status: number | null } {
    if (
      invocation.executable !== EC2_GIT ||
      invocation.shell !== false ||
      !isCanonicalAbsolutePath(invocation.cwd) ||
      invocation.args.length !== 4 ||
      invocation.args[0] !== 'check-ignore' ||
      invocation.args[1] !== '-q' ||
      invocation.args[2] !== '--no-index' ||
      !sameEc2GitEnvironment(invocation.env)
    ) {
      return { failed: true, status: null };
    }
    try {
      const result = spawnSync(EC2_GIT, ['check-ignore', '-q', '--no-index', invocation.args[3]], {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      return {
        failed: result.error !== undefined || result.signal !== null,
        status: result.status,
      };
    } catch {
      return { failed: true, status: null };
    }
  }
}

export function createFixedEc2GitIgnoreRunner(
  inspector: TrustedExecutableInspector = defaultEc2GitExecutableInspector,
  processRunner: Ec2GitIgnoreProcessRunner = new Ec2GitIgnoreProcessAdapter(),
): {
  isIgnored(request: IgnoredDestinationRequest): Promise<boolean>;
} {
  return {
    async isIgnored(request): Promise<boolean> {
      if (!isCanonicalAbsolutePath(request.repoRoot)) return false;
      const inspection = await inspector.inspect(EC2_GIT).catch(() => null);
      if (!trustedEc2Executable(inspection)) return false;
      const result = processRunner.run({
        executable: EC2_GIT,
        args: ['check-ignore', '-q', '--no-index', request.relativePath],
        cwd: request.repoRoot,
        env: EC2_GIT_ENV,
        shell: false,
      });
      return !result.failed && result.status === 0;
    },
  };
}

const fixedEc2GitIgnoreRunner = createFixedEc2GitIgnoreRunner();

function repoRootFromScript(scriptPath: string): string {
  if (!isCanonicalAbsolutePath(scriptPath)) return failPreflight();
  return path.posix.resolve(path.posix.dirname(scriptPath), '../../..');
}

function corpusRootFor(repoRoot: string): string {
  if (!isCanonicalAbsolutePath(repoRoot)) return failPreflight();
  return path.posix.join(repoRoot, ...CORPUS_PATH_SEGMENTS);
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentEffectiveUid(): number {
  const effectiveUid = process.geteuid?.();
  if (typeof effectiveUid !== 'number') return failPreflight();
  return effectiveUid;
}

function trustedDirectory(directory: string): { dev: number; ino: number } {
  const stats = lstatSync(directory);
  const effectiveUid = currentEffectiveUid();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.uid !== effectiveUid && stats.uid !== 0) ||
    (stats.mode & 0o022) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    return failPreflight();
  }
  return { dev: stats.dev, ino: stats.ino };
}

function trustedConfigLeaf(configPath: string): { dev: number; ino: number } {
  const stats = lstatSync(configPath);
  const effectiveUid = currentEffectiveUid();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.uid !== effectiveUid && stats.uid !== 0) ||
    (stats.mode & 0o077) !== 0
  ) {
    return failPreflight();
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function defaultReadProtectedConfig(request: ProtectedConfigRequest): Promise<string> {
  const expectedCorpusRoot = corpusRootFor(request.repoRoot);
  if (
    request.corpusRoot !== expectedCorpusRoot ||
    request.configPath !== path.posix.join(expectedCorpusRoot, CONFIG_FILE_NAME)
  ) {
    return failPreflight();
  }

  const directories = [
    request.repoRoot,
    path.posix.join(request.repoRoot, '.private'),
    request.corpusRoot,
  ];
  let identities: Array<{ dev: number; ino: number }>;
  let descriptor: number | undefined;
  try {
    identities = directories.map(trustedDirectory);
    const preOpen = trustedConfigLeaf(request.configPath);
    descriptor = openSync(request.configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || preOpen.dev !== opened.dev || preOpen.ino !== opened.ino) {
      return failPreflight();
    }
    const content = readFileSync(descriptor, 'utf8');
    const postOpen = trustedConfigLeaf(request.configPath);
    if (!sameIdentity(preOpen, postOpen) || !sameIdentity(preOpen, opened)) {
      return failPreflight();
    }
    for (let index = 0; index < directories.length; index += 1) {
      if (!sameIdentity(identities[index]!, trustedDirectory(directories[index]!))) {
        return failPreflight();
      }
    }
    return content;
  } catch {
    return failPreflight();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

const defaultImdsRequestDependencies: DirectImdsRequestDependencies = {
  request: (options, onResponse) =>
    httpRequest(options, (response) =>
      onResponse(response as unknown as ImdsResponse),
    ) as unknown as ImdsRequest,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function directImdsRequest(
  method: 'GET' | 'PUT',
  requestPath: string,
  headers: Record<string, string>,
  dependencies: DirectImdsRequestDependencies = defaultImdsRequestDependencies,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let deadlineTimer: unknown;
    let request: ImdsRequest | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      dependencies.clearTimeout(deadlineTimer);
      resolve(value);
    };
    deadlineTimer = dependencies.setTimeout(() => {
      request?.destroy();
      finish(null);
    }, IMDS_TIMEOUT_MS);
    try {
      request = dependencies.request(
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
            request?.destroy();
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.byteLength;
            if (bytes > IMDS_MAX_RESPONSE_BYTES) {
              request?.destroy();
              finish(null);
              return;
            }
            chunks.push(value);
          });
          response.on('error', () => {
            request?.destroy();
            finish(null);
          });
          response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        },
      );
      request.on('error', () => {
        request?.destroy();
        finish(null);
      });
      request.setTimeout(IMDS_TIMEOUT_MS, () => {
        request?.destroy();
        finish(null);
      });
      request.end();
    } catch {
      request?.destroy();
      finish(null);
    }
  });
}

async function defaultAttestImdsV2(): Promise<boolean> {
  const token = await directImdsRequest('PUT', '/latest/api/token', {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token || token.length > IMDS_MAX_RESPONSE_BYTES) return false;
  const instanceId = await directImdsRequest('GET', '/latest/meta-data/instance-id', {
    'X-aws-ec2-metadata-token': token,
  });
  return instanceId === APPROVED_INSTANCE_ID;
}

function defaultValidateAllocatedDir(request: AllocatedDirectoryRequest): string {
  if (
    !isCanonicalAbsolutePath(request.repoRoot) ||
    !isCanonicalAbsolutePath(request.corpusRoot) ||
    !isCanonicalAbsolutePath(request.outDir) ||
    !UUID_PATTERN.test(request.snapshotId.slice('live-'.length))
  ) {
    return failPreflight();
  }
  const canonicalRepoRoot = realpathSync(request.repoRoot);
  const canonicalCorpusRoot = realpathSync(request.corpusRoot);
  const canonicalOutDir = realpathSync(request.outDir);
  if (
    canonicalRepoRoot !== request.repoRoot ||
    canonicalCorpusRoot !== request.corpusRoot ||
    canonicalOutDir !== request.outDir ||
    path.posix.dirname(canonicalOutDir) !== canonicalCorpusRoot
  ) {
    return failPreflight();
  }
  const snapshotDir = path.posix.relative(canonicalRepoRoot, canonicalOutDir);
  const expectedParent = CORPUS_PATH_SEGMENTS.join('/');
  const expectedPrefix = `${request.snapshotId}-`;
  if (
    !snapshotDir ||
    snapshotDir.includes('\\') ||
    path.posix.isAbsolute(snapshotDir) ||
    snapshotDir.split('/').includes('..') ||
    path.posix.dirname(snapshotDir) !== expectedParent ||
    !path.posix.basename(snapshotDir).startsWith(expectedPrefix) ||
    path.posix.basename(snapshotDir) === expectedPrefix
  ) {
    return failPreflight();
  }
  return snapshotDir;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTask7CompatibleIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
}

function cloneSafeSummary(value: unknown): ThreadCorpusExportSafeResult['summary'] {
  if (!isPlainRecord(value) || !hasExactKeys(value, SAFE_SUMMARY_KEYS)) {
    return failPreflight();
  }
  const asOf = value.asOf;
  const includedMessageCount = value.includedMessageCount;
  const sourceRowCount = value.sourceRowCount;
  const threadCount = value.threadCount;
  const quarantineRecordCount = value.quarantineRecordCount;
  const unscopedQuarantineCount = value.unscopedQuarantineCount;
  if (!isTask7CompatibleIsoTimestamp(asOf)) return failPreflight();
  if (!isNonNegativeSafeInteger(includedMessageCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(sourceRowCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(threadCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(quarantineRecordCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(unscopedQuarantineCount)) return failPreflight();
  return {
    asOf,
    includedMessageCount,
    sourceRowCount,
    threadCount,
    quarantineRecordCount,
    unscopedQuarantineCount,
  };
}

function failureJson(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({
    event: 'centurion_thread_corpus_export.failed',
    code,
  })}\n`;
}

function writeFailure(
  dependencies: LiveCenturionThreadCorpusDependencies,
  code: 'invalid_arguments' | 'preflight_failed' | 'export_failed',
): number {
  try {
    dependencies.writeStderr(failureJson(code));
  } catch {}
  return 1;
}

async function prepareExport(
  dependencies: LiveCenturionThreadCorpusDependencies,
): Promise<PreparedExport> {
  if (dependencies.platform() !== 'linux') return failPreflight();
  const repoRoot = repoRootFromScript(dependencies.scriptPath());
  if (!(await dependencies.attestImdsV2())) return failPreflight();
  const corpusRoot = corpusRootFor(repoRoot);
  const config = parseOperatorConfig(
    await dependencies.readProtectedConfig({
      repoRoot,
      corpusRoot,
      configPath: path.posix.join(corpusRoot, CONFIG_FILE_NAME),
    }),
  );
  const uuid = dependencies.uuid();
  if (!UUID_PATTERN.test(uuid)) return failPreflight();
  const snapshotId = `live-${uuid}`;
  const outDir = path.posix.join(corpusRoot, snapshotId);
  const relativePath = path.posix.join(...CORPUS_PATH_SEGMENTS, snapshotId);
  if (!(await dependencies.isIgnored({ repoRoot, relativePath }))) return failPreflight();
  const environment = dependencies.environment();
  const databaseUrl = nonBlankEnvironmentValue(environment.DATABASE_URL);
  const region = nonBlankEnvironmentValue(environment.AWS_REGION);
  const bucket = nonBlankEnvironmentValue(environment.S3_BUCKET);
  const storage = dependencies.createRealStorage({ region, bucket });
  if (storage.kind !== 'real' || typeof storage.getObjectBounded !== 'function') {
    return failPreflight();
  }
  const readOnlyStorage = Object.freeze({
    getObjectBounded: storage.getObjectBounded.bind(storage),
  });
  const createReader = (): ClosableThreadCorpusReader =>
    dependencies.createReader({
      databaseUrl,
      ...config.source,
    });

  return {
    repoRoot,
    corpusRoot,
    outDir,
    snapshotId,
    source: config.source,
    storage: readOnlyStorage,
    exporter: dependencies.createExporter({ createReader }),
  };
}

function defaultDependencies(): LiveCenturionThreadCorpusDependencies {
  return {
    args: () => process.argv.slice(2),
    platform: () => process.platform,
    scriptPath: () => fileURLToPath(import.meta.url),
    attestImdsV2: defaultAttestImdsV2,
    readProtectedConfig: defaultReadProtectedConfig,
    isIgnored: fixedEc2GitIgnoreRunner.isIgnored,
    uuid: randomUUID,
    environment: () => ({
      DATABASE_URL: process.env.DATABASE_URL,
      AWS_REGION: process.env.AWS_REGION,
      S3_BUCKET: process.env.S3_BUCKET,
    }),
    createReader: (options) => createThreadCorpusPostgresReader(options),
    createRealStorage: ({ region, bucket }) => new RealS3Storage(region, bucket),
    createExporter: ({ createReader }) => createCenturionThreadCorpusExporter({ createReader }),
    validateAllocatedDir: defaultValidateAllocatedDir,
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    writeStderr: (value) => {
      process.stderr.write(value);
    },
  };
}

export function createCenturionThreadCorpusLiveExportCommand(
  overrides: Partial<LiveCenturionThreadCorpusDependencies> = {},
): () => Promise<number> {
  const dependencies: LiveCenturionThreadCorpusDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };

  return async (): Promise<number> => {
    let args: readonly string[];
    try {
      args = dependencies.args();
    } catch {
      return writeFailure(dependencies, 'invalid_arguments');
    }
    if (args.length !== 0) return writeFailure(dependencies, 'invalid_arguments');

    let prepared: PreparedExport;
    try {
      prepared = await prepareExport(dependencies);
    } catch {
      return writeFailure(dependencies, 'preflight_failed');
    }

    try {
      const result = await prepared.exporter({
        repoRoot: prepared.repoRoot,
        outDir: prepared.outDir,
        snapshotId: prepared.snapshotId,
        exporterVersion: EXPORTER_VERSION,
        source: prepared.source,
        hydration: { storage: prepared.storage },
      });
      const summary = cloneSafeSummary(result.summary);
      const snapshotDir = dependencies.validateAllocatedDir({
        repoRoot: prepared.repoRoot,
        corpusRoot: prepared.corpusRoot,
        snapshotId: prepared.snapshotId,
        outDir: result.outDir,
      });
      dependencies.writeStdout(
        JSON.stringify({
          event: 'centurion_thread_corpus_export.completed',
          snapshotId: prepared.snapshotId,
          snapshotDir,
          summary,
        }) + '\n',
      );
      return 0;
    } catch {
      return writeFailure(dependencies, 'export_failed');
    }
  };
}

export async function runCenturionThreadCorpusLiveExport(
  overrides: Partial<LiveCenturionThreadCorpusDependencies> = {},
): Promise<number> {
  return await createCenturionThreadCorpusLiveExportCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runCenturionThreadCorpusLiveExport().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
