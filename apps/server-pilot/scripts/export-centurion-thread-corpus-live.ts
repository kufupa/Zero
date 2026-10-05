import {
  createCenturionThreadCorpusExporter,
  type ClosableThreadCorpusReader,
  type ThreadCorpusExportDependencies,
  type ThreadCorpusExportRequest,
  type ThreadCorpusExportSafeResult,
} from '../src/ops/centurion-thread-corpus-exporter.js';
import {
  CENTURION_TRANSPORT_ID,
  createThreadCorpusPostgresReader,
  type ThreadCorpusPostgresReaderOptions,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import { preflightPrivateThreadCorpusOutputDestination } from '../src/ops/centurion-thread-corpus-snapshot.js';
import { RealS3Storage, type S3Storage } from '../src/storage/s3.js';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const PRIVATE_CORPUS_DIRECTORY_NAME = 'connected-mailbox-corpus';
const CORPUS_PATH_SEGMENTS = ['.private', PRIVATE_CORPUS_DIRECTORY_NAME] as const;
const EXPORTER_VERSION = 'connected-mailbox-corpus-live-v1';
const ATTACHMENT_EXPORTER_VERSION = 'connected-mailbox-corpus-live-v2';
const ATTACHMENT_HYDRATION_CONCURRENCY = 4;
const IMDS_HOST = '169.254.169.254';
const IMDS_MAX_RESPONSE_BYTES = 1024;
const IMDS_TIMEOUT_MS = 1_000;
const SAFE_SUMMARY_KEYS = [
  'asOf',
  'includedMessageCount',
  'sourceRowCount',
  'threadCount',
] as const;
const OPTIONAL_SAFE_SUMMARY_KEYS = ['malformedAttachmentDescriptorCount'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  preflightOutputDestination(repoRoot: string, outDir: string): Promise<void>;
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
  validateAllocatedDir(request: AllocatedDirectoryRequest): void;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

type PreparedExport = {
  repoRoot: string;
  corpusRoot: string;
  outDir: string;
  snapshotId: string;
  storage: Pick<S3Storage, 'getObjectBounded'>;
  exporter: (request: ThreadCorpusExportRequest) => Promise<ThreadCorpusExportSafeResult>;
};

type ExportMode = 'metadata' | 'attachment-inclusive';

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

function repoRootFromScript(scriptPath: string): string {
  if (!isCanonicalAbsolutePath(scriptPath)) return failPreflight();
  return path.posix.resolve(path.posix.dirname(scriptPath), '../../..');
}

function corpusRootFor(repoRoot: string): string {
  if (!isCanonicalAbsolutePath(repoRoot)) return failPreflight();
  return path.posix.join(repoRoot, ...CORPUS_PATH_SEGMENTS);
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

async function defaultPreflightOutputDestination(repoRoot: string, outDir: string): Promise<void> {
  await preflightPrivateThreadCorpusOutputDestination(repoRoot, outDir);
}

function defaultValidateAllocatedDir(request: AllocatedDirectoryRequest): void {
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

function cloneSafeSummary(
  value: unknown,
): Pick<
  ThreadCorpusExportSafeResult['summary'],
  | 'includedMessageCount'
  | 'sourceRowCount'
  | 'threadCount'
  | 'malformedAttachmentDescriptorCount'
> {
  if (!isPlainRecord(value)) {
    return failPreflight();
  }
  const hasMalformedCount = Object.hasOwn(
    value,
    OPTIONAL_SAFE_SUMMARY_KEYS[0],
  );
  if (
    !hasExactKeys(
      value,
      hasMalformedCount
        ? [...SAFE_SUMMARY_KEYS, ...OPTIONAL_SAFE_SUMMARY_KEYS]
        : SAFE_SUMMARY_KEYS,
    )
  ) {
    return failPreflight();
  }
  const asOf = value.asOf;
  const includedMessageCount = value.includedMessageCount;
  const sourceRowCount = value.sourceRowCount;
  const threadCount = value.threadCount;
  const malformedAttachmentDescriptorCount = value.malformedAttachmentDescriptorCount;
  if (!isTask7CompatibleIsoTimestamp(asOf)) return failPreflight();
  if (!isNonNegativeSafeInteger(includedMessageCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(sourceRowCount)) return failPreflight();
  if (!isNonNegativeSafeInteger(threadCount)) return failPreflight();
  if (
    hasMalformedCount &&
    !isNonNegativeSafeInteger(malformedAttachmentDescriptorCount)
  ) {
    return failPreflight();
  }
  return {
    includedMessageCount,
    sourceRowCount,
    threadCount,
    ...(hasMalformedCount
      ? { malformedAttachmentDescriptorCount }
      : {}),
  };
}

function failureJson(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({
    event: 'centurion_thread_corpus_export.failed',
    code,
  })}\n`;
}

function parseExportMode(args: readonly string[]): ExportMode | null {
  if (args.length === 0) return 'metadata';
  if (args.length === 1 && args[0] === '--attachment-inclusive') return 'attachment-inclusive';
  if (args.length === 2 && args[0] === '--mode' && (args[1] === 'metadata' || args[1] === 'attachment-inclusive')) {
    return args[1];
  }
  return null;
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
  const uuid = dependencies.uuid();
  if (!UUID_PATTERN.test(uuid)) return failPreflight();
  const snapshotId = `live-${uuid}`;
  const outDir = path.posix.join(corpusRoot, snapshotId);
  await dependencies.preflightOutputDestination(repoRoot, outDir);
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
      transportIds: [CENTURION_TRANSPORT_ID],
    });

  return {
    repoRoot,
    corpusRoot,
    outDir,
    snapshotId,
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
    preflightOutputDestination: defaultPreflightOutputDestination,
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
    const mode = parseExportMode(args);
    if (!mode) return writeFailure(dependencies, 'invalid_arguments');

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
        exporterVersion: mode === 'attachment-inclusive' ? ATTACHMENT_EXPORTER_VERSION : EXPORTER_VERSION,
        hydration: {
          storage: prepared.storage,
          retainAttachmentBytes: mode === 'attachment-inclusive',
          retainRawMime: mode !== 'attachment-inclusive',
          attachmentConcurrency: ATTACHMENT_HYDRATION_CONCURRENCY,
        },
      });
      const summary = cloneSafeSummary(result.summary);
      dependencies.validateAllocatedDir({
        repoRoot: prepared.repoRoot,
        corpusRoot: prepared.corpusRoot,
        snapshotId: prepared.snapshotId,
        outDir: result.outDir,
      });
      dependencies.writeStdout(`${JSON.stringify(summary)}\n`);
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
