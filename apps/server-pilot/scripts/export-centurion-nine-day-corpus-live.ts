import {
  canonicalCenturionWindow,
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  CENTURION_WINDOW_TIMEZONE,
  createThreadCorpusPostgresReader,
  type CenturionCorpusSnapshot,
  type ThreadCorpusPostgresReader,
  type ThreadCorpusPostgresReaderOptions,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import { preflightPrivateThreadCorpusOutputDestination } from '../src/ops/centurion-thread-corpus-snapshot.js';
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const PRIVATE_CORPUS_DIRECTORY_NAME = 'connected-mailbox-corpus';
const CORPUS_PATH_SEGMENTS = ['.private', PRIVATE_CORPUS_DIRECTORY_NAME] as const;
const EXPORTER_VERSION = 'centurion-nine-day-corpus-live-v1';
const IMDS_HOST = '169.254.169.254';
const IMDS_MAX_RESPONSE_BYTES = 1024;
const IMDS_TIMEOUT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID_PREFIX = 'centurion-nine-day-';

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

export type DirectCenturionImdsRequestDependencies = {
  request(options: ImdsRequestOptions, onResponse: (response: ImdsResponse) => void): ImdsRequest;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type CenturionNineDaySnapshotWriteRequest = {
  repoRoot: string;
  outDir: string;
  snapshotId: string;
  transportId: typeof CENTURION_TRANSPORT_ID;
  window: {
    startInclusive: string;
    endExclusive: string;
    timezone: typeof CENTURION_WINDOW_TIMEZONE;
  };
  snapshot: CenturionCorpusSnapshot;
};

export type CenturionNineDayCorpusReader = Pick<
  ThreadCorpusPostgresReader,
  'readCenturionSnapshot' | 'close'
>;

export type LiveCenturionNineDayCorpusDependencies = {
  args(): readonly string[];
  platform(): string;
  scriptPath(): string;
  attestImdsV2(): Promise<boolean>;
  preflightOutputDestination(repoRoot: string, outDir: string): Promise<void>;
  uuid(): string;
  environment(): Readonly<{ DATABASE_URL?: string }>;
  createReader(options: ThreadCorpusPostgresReaderOptions): CenturionNineDayCorpusReader;
  writeSnapshot(request: CenturionNineDaySnapshotWriteRequest): Promise<void>;
  validateAllocatedDir(request: {
    repoRoot: string;
    corpusRoot: string;
    snapshotId: string;
    outDir: string;
  }): void;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

type PreparedExport = {
  repoRoot: string;
  corpusRoot: string;
  outDir: string;
  snapshotId: string;
  databaseUrl: string;
};

type ExportWindow = { startInclusive: string; endExclusive: string };

/** `--from` and `--to` (ISO UTC) must come together; with neither, the original nine-day window applies. */
function exportWindowFrom(args: readonly string[]): ExportWindow {
  const { values } = parseArgs({
    args: [...args],
    options: { from: { type: 'string' }, to: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.from === undefined && values.to === undefined) {
    return { startInclusive: CENTURION_WINDOW_START_UTC, endExclusive: CENTURION_WINDOW_END_UTC };
  }
  if (values.from === undefined || values.to === undefined) {
    throw new Error('--from and --to must be given together');
  }
  return canonicalCenturionWindow(values.from, values.to);
}

const defaultImdsRequestDependencies: DirectCenturionImdsRequestDependencies = {
  request: (options, onResponse) =>
    httpRequest(options, (response) =>
      onResponse(response as unknown as ImdsResponse),
    ) as unknown as ImdsRequest,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function failPreflight(): never {
  throw new Error('preflight failed');
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

function snapshotIdFor(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) return failPreflight();
  return `${SNAPSHOT_ID_PREFIX}${uuid}`;
}

function outputPathFor(corpusRoot: string, snapshotId: string): string {
  if (!isCanonicalAbsolutePath(corpusRoot) || !snapshotId.startsWith(SNAPSHOT_ID_PREFIX)) {
    return failPreflight();
  }
  return path.posix.join(corpusRoot, snapshotId);
}

export function directCenturionImdsRequest(
  method: 'GET' | 'PUT',
  requestPath: string,
  headers: Record<string, string>,
  dependencies: DirectCenturionImdsRequestDependencies = defaultImdsRequestDependencies,
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
  const token = await directCenturionImdsRequest('PUT', '/latest/api/token', {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token || token.length > IMDS_MAX_RESPONSE_BYTES) return false;
  const instanceId = await directCenturionImdsRequest('GET', '/latest/meta-data/instance-id', {
    'X-aws-ec2-metadata-token': token,
  });
  return instanceId === APPROVED_INSTANCE_ID;
}

function defaultValidateAllocatedDir(request: {
  repoRoot: string;
  corpusRoot: string;
  snapshotId: string;
  outDir: string;
}): void {
  if (
    !isCanonicalAbsolutePath(request.repoRoot) ||
    !isCanonicalAbsolutePath(request.corpusRoot) ||
    !isCanonicalAbsolutePath(request.outDir) ||
    !request.snapshotId.startsWith(SNAPSHOT_ID_PREFIX) ||
    request.snapshotId === SNAPSHOT_ID_PREFIX
  ) {
    return failPreflight();
  }
  const relative = path.posix.relative(request.repoRoot, request.outDir);
  if (
    relative !== `${CORPUS_PATH_SEGMENTS.join('/')}/${request.snapshotId}` ||
    path.posix.dirname(relative) !== CORPUS_PATH_SEGMENTS.join('/')
  ) {
    return failPreflight();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function orderedMessageHash(snapshot: CenturionCorpusSnapshot): string {
  return sha256(snapshot.messages.map((message) => JSON.stringify(message)).join('\n'));
}

function safeManifest(
  snapshot: CenturionCorpusSnapshot,
  snapshotId: string,
): Record<string, unknown> {
  return {
    schemaVersion: 'centurion-nine-day-corpus-v1',
    snapshotId,
    exporterVersion: EXPORTER_VERSION,
    transportId: snapshot.transportId,
    asOf: snapshot.asOf,
    window: snapshot.window,
    counts: snapshot.counts,
    orderedMessageSha256: orderedMessageHash(snapshot),
    source: {
      readMode: 'ec2-imds-v2-read-only-rds-repeatable-read',
      writes: false,
    },
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertCenturionSnapshot(snapshot: CenturionCorpusSnapshot, window: ExportWindow): void {
  if (
    !snapshot ||
    snapshot.transportId !== CENTURION_TRANSPORT_ID ||
    !isIsoTimestamp(snapshot.asOf) ||
    snapshot.window.startInclusive !== window.startInclusive ||
    snapshot.window.endExclusive !== window.endExclusive ||
    snapshot.window.timezone !== CENTURION_WINDOW_TIMEZONE ||
    !Array.isArray(snapshot.messages) ||
    !snapshot.counts ||
    !isNonNegativeSafeInteger(snapshot.counts.sourceRowCount) ||
    !isNonNegativeSafeInteger(snapshot.counts.includedMessageCount) ||
    !isNonNegativeSafeInteger(snapshot.counts.contextOnlyMessageCount) ||
    !isNonNegativeSafeInteger(snapshot.counts.missingEventAtCount)
  ) {
    return failPreflight();
  }
  const includedMessageCount = snapshot.messages.filter((message) => message.dailyIncluded).length;
  const contextOnlyMessageCount = snapshot.messages.filter((message) => message.contextOnly).length;
  const missingEventAtCount = snapshot.messages.filter((message) => message.eventAt === null).length;
  if (
    snapshot.counts.sourceRowCount !== snapshot.messages.length ||
    snapshot.counts.includedMessageCount !== includedMessageCount ||
    snapshot.counts.contextOnlyMessageCount !== contextOnlyMessageCount ||
    snapshot.counts.missingEventAtCount !== missingEventAtCount
  ) {
    return failPreflight();
  }
  for (const message of snapshot.messages) {
    if (
      message.transportId !== CENTURION_TRANSPORT_ID ||
      message.direction !== message.messageDirection ||
      message.contextOnly !== (message.scope === 'context_only') ||
      message.dailyIncluded !== (message.scope === 'in_window') ||
      (message.contextOnly && message.dailyIncluded) ||
      (message.scope === 'missing_event_at' && message.eventAt !== null)
    ) {
      return failPreflight();
    }
  }
}

async function defaultWriteSnapshot(request: CenturionNineDaySnapshotWriteRequest): Promise<void> {
  const outputDirectory = path.resolve(request.outDir);
  const outputRoot = path.resolve(request.repoRoot, '.private', PRIVATE_CORPUS_DIRECTORY_NAME);
  if (
    path.dirname(outputDirectory) !== outputRoot ||
    !outputDirectory.startsWith(`${outputRoot}${path.sep}`)
  ) {
    return failPreflight();
  }
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const entry = await lstat(outputDirectory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) return failPreflight();
  const canonicalParent = await realpath(path.dirname(outputDirectory));
  if (canonicalParent !== outputRoot) return failPreflight();

  const messagesJsonl = `${request.snapshot.messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  const manifestJson = `${JSON.stringify(safeManifest(request.snapshot, request.snapshotId), null, 2)}\n`;
  await writeFile(path.join(outputDirectory, 'messages.jsonl'), messagesJsonl, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(path.join(outputDirectory, 'manifest.json'), manifestJson, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(path.join(outputDirectory, 'messages.jsonl'), 0o600);
  await chmod(path.join(outputDirectory, 'manifest.json'), 0o600);
}

function failureJson(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({
    event: 'centurion_nine_day_corpus_export.failed',
    code,
  })}\n`;
}

function writeFailure(
  dependencies: LiveCenturionNineDayCorpusDependencies,
  code: 'invalid_arguments' | 'preflight_failed' | 'export_failed',
): number {
  try {
    dependencies.writeStderr(failureJson(code));
  } catch {}
  return 1;
}

async function prepareExport(
  dependencies: LiveCenturionNineDayCorpusDependencies,
): Promise<PreparedExport> {
  if (dependencies.platform() !== 'linux') return failPreflight();
  const repoRoot = repoRootFromScript(dependencies.scriptPath());
  if (!(await dependencies.attestImdsV2())) return failPreflight();
  const corpusRoot = corpusRootFor(repoRoot);
  const snapshotId = snapshotIdFor(dependencies.uuid());
  const outDir = outputPathFor(corpusRoot, snapshotId);
  await dependencies.preflightOutputDestination(repoRoot, outDir);
  dependencies.validateAllocatedDir({ repoRoot, corpusRoot, snapshotId, outDir });
  const databaseUrl = nonBlankEnvironmentValue(dependencies.environment().DATABASE_URL);
  return { repoRoot, corpusRoot, outDir, snapshotId, databaseUrl };
}

function defaultDependencies(): LiveCenturionNineDayCorpusDependencies {
  return {
    args: () => process.argv.slice(2),
    platform: () => process.platform,
    scriptPath: () => fileURLToPath(import.meta.url),
    attestImdsV2: defaultAttestImdsV2,
    preflightOutputDestination: async (repoRoot, outDir) => {
      await preflightPrivateThreadCorpusOutputDestination(repoRoot, outDir);
    },
    uuid: randomUUID,
    environment: () => ({ DATABASE_URL: process.env.DATABASE_URL }),
    createReader: (options) => createThreadCorpusPostgresReader(options),
    writeSnapshot: defaultWriteSnapshot,
    validateAllocatedDir: defaultValidateAllocatedDir,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  };
}

export function createCenturionNineDayCorpusExportCommand(
  overrides: Partial<LiveCenturionNineDayCorpusDependencies> = {},
): () => Promise<number> {
  const dependencies: LiveCenturionNineDayCorpusDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };

  return async (): Promise<number> => {
    let window: ExportWindow;
    try {
      window = exportWindowFrom(dependencies.args());
    } catch {
      return writeFailure(dependencies, 'invalid_arguments');
    }

    let prepared: PreparedExport;
    try {
      prepared = await prepareExport(dependencies);
    } catch {
      return writeFailure(dependencies, 'preflight_failed');
    }

    let reader: CenturionNineDayCorpusReader | undefined;
    try {
      reader = dependencies.createReader({
        databaseUrl: prepared.databaseUrl,
        transportIds: [CENTURION_TRANSPORT_ID],
      });
      const snapshot = await reader.readCenturionSnapshot({
        transportId: CENTURION_TRANSPORT_ID,
        ...window,
      });
      assertCenturionSnapshot(snapshot, window);
      await reader.close();
      reader = undefined;
      await dependencies.writeSnapshot({
        repoRoot: prepared.repoRoot,
        outDir: prepared.outDir,
        snapshotId: prepared.snapshotId,
        transportId: CENTURION_TRANSPORT_ID,
        window: { ...window, timezone: CENTURION_WINDOW_TIMEZONE },
        snapshot,
      });
      const summary = {
        includedMessageCount: snapshot.counts.includedMessageCount,
        sourceRowCount: snapshot.counts.sourceRowCount,
        contextOnlyMessageCount: snapshot.counts.contextOnlyMessageCount,
        missingEventAtCount: snapshot.counts.missingEventAtCount,
      };
      dependencies.writeStdout(`${JSON.stringify(summary)}\n`);
      return 0;
    } catch {
      return writeFailure(dependencies, 'export_failed');
    } finally {
      if (reader) {
        try {
          await reader.close();
        } catch {
          // The command already returns a fixed failure code for any close error.
        }
      }
    }
  };
}

export async function runCenturionNineDayCorpusExport(
  overrides: Partial<LiveCenturionNineDayCorpusDependencies> = {},
): Promise<number> {
  return await createCenturionNineDayCorpusExportCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runCenturionNineDayCorpusExport().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
