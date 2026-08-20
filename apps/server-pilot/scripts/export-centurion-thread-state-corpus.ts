#!/usr/bin/env npx tsx
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION,
  createCenturionThreadStateSourceManifest,
  parseCenturionThreadStateCorpus,
  validateCenturionThreadStateOutputRoot,
  validateCenturionThreadStateOutputTarget,
  type CenturionThreadStateOutputFileInspection,
  type CenturionThreadStateOutputRootInspection,
} from '../src/ops/centurion-thread-state-corpus.js';

const DEFAULT_TRANSPORT_ID = 'transport-centurion';
const DEFAULT_OUTPUT_ROOT = '.tmp-centurion-thread-state-audit';
const OUTPUT_FILE_NAME = 'centurion-thread-state-corpus.json';
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = resolve(SERVER_ROOT, '..', '..');

type ExportCommand =
  | { kind: 'help' }
  | {
      kind: 'execute';
      transportId: string;
      eventCutoff: string;
      ingestCutoff: string;
      outputRoot: string;
    };

type MessageProjection = {
  messageId: string;
  threadId: string;
  transportId: string;
  direction: string;
  createdAt: Date | string | null;
  sentAt: Date | string | null;
  receivedAt: Date | string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[] | null;
};

type QuerySummary = {
  messageCount: number;
  threadCount: number;
};

type QueryKeyset = {
  messageId: string;
  threadId: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function parseTimestampArgument(value: string | undefined, code: string): string {
  const parts = value?.match(
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<millisecond>\d{1,3}))?(?<offset>Z|(?<offsetSign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u,
  );
  if (!value || value.startsWith('--') || !parts?.groups) {
    fail(code);
  }

  const {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond = '',
    offset,
    offsetHour,
    offsetMinute,
  } = parts.groups;
  const values = [year, month, day, hour, minute, second].map(Number);
  const [calendarYear, calendarMonth, calendarDay, calendarHour, calendarMinute, calendarSecond] =
    values;
  const calendarMillisecond = Number(millisecond.padEnd(3, '0'));
  if (
    offset === '-00:00' ||
    calendarHour > 23 ||
    calendarMinute > 59 ||
    calendarSecond > 59 ||
    (offset !== 'Z' &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    fail(code);
  }

  const calendar = new Date(0);
  calendar.setUTCFullYear(
    calendarYear,
    calendarMonth - 1,
    calendarDay,
  );
  calendar.setUTCHours(
    calendarHour,
    calendarMinute,
    calendarSecond,
    calendarMillisecond,
  );
  if (
    calendar.getUTCFullYear() !== calendarYear ||
    calendar.getUTCMonth() !== calendarMonth - 1 ||
    calendar.getUTCDate() !== calendarDay ||
    calendar.getUTCHours() !== calendarHour ||
    calendar.getUTCMinutes() !== calendarMinute ||
    calendar.getUTCSeconds() !== calendarSecond ||
    calendar.getUTCMilliseconds() !== calendarMillisecond
  ) {
    fail(code);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(code);
  return date.toISOString();
}

function parseStringArgument(value: string | undefined, code: string): string {
  if (!value || value.startsWith('--')) fail(code);
  const normalized = value.trim();
  if (!normalized) fail(code);
  return normalized;
}

export function validateCenturionThreadStateOutputRootPath(input: {
  outputRoot: string;
  serverRoot?: string;
  repositoryRoot?: string;
}): string {
  const serverRoot = resolve(input.serverRoot ?? SERVER_ROOT);
  const repositoryRoot = resolve(input.repositoryRoot ?? REPOSITORY_ROOT);
  const outputRoot = resolve(input.outputRoot);
  const canonicalRoot = resolve(serverRoot, DEFAULT_OUTPUT_ROOT);
  const pathFromRepository = relative(repositoryRoot, outputRoot);
  const insideRepository =
    pathFromRepository === '' ||
    (!pathFromRepository.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      pathFromRepository !== '..' &&
      !isAbsolute(pathFromRepository));
  if (insideRepository && outputRoot !== canonicalRoot) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_REPOSITORY_REJECTED');
  }
  return outputRoot;
}

export function parseCenturionThreadStateExportArgs(
  argv: readonly string[],
): ExportCommand {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { kind: 'help' };
  }

  let execute = false;
  let eventCutoff: string | undefined;
  let ingestCutoff: string | undefined;
  let transportId = DEFAULT_TRANSPORT_ID;
  let outputRoot = resolve(SERVER_ROOT, DEFAULT_OUTPUT_ROOT);
  const seen = new Set<string>();
  const mark = (option: string): void => {
    if (seen.has(option)) fail('CENTURION_THREAD_STATE_DUPLICATE_ARGUMENT');
    seen.add(option);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') {
      mark(argument);
      execute = true;
      continue;
    }
    if (argument === '--event-cutoff') {
      mark(argument);
      eventCutoff = parseTimestampArgument(
        argv[++index],
        'CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED',
      );
      continue;
    }
    if (argument === '--ingest-cutoff') {
      mark(argument);
      ingestCutoff = parseTimestampArgument(
        argv[++index],
        'CENTURION_THREAD_STATE_INGEST_CUTOFF_REQUIRED',
      );
      continue;
    }
    if (argument === '--transport-id') {
      mark(argument);
      transportId = parseStringArgument(
        argv[++index],
        'CENTURION_THREAD_STATE_TRANSPORT_ID_REQUIRED',
      );
      continue;
    }
    if (argument === '--output-root') {
      mark(argument);
      outputRoot = resolve(
        parseStringArgument(
          argv[++index],
          'CENTURION_THREAD_STATE_OUTPUT_ROOT_REQUIRED',
        ),
      );
      continue;
    }
    fail('CENTURION_THREAD_STATE_UNKNOWN_ARGUMENT');
  }

  if (!execute) fail('CENTURION_THREAD_STATE_EXECUTE_REQUIRED');
  if (!eventCutoff) fail('CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED');
  if (!ingestCutoff) fail('CENTURION_THREAD_STATE_INGEST_CUTOFF_REQUIRED');
  return {
    kind: 'execute',
    transportId,
    eventCutoff,
    ingestCutoff,
    outputRoot: validateCenturionThreadStateOutputRootPath({ outputRoot }),
  };
}

export function centurionThreadStateExportHelp(): string {
  return [
    'usage: export-centurion-thread-state-corpus.ts --execute --event-cutoff ISO --ingest-cutoff ISO [--transport-id ID] [--output-root PATH]',
    '  --execute              Required before any database connection.',
    '  --event-cutoff ISO     Inclusive canonical event-time boundary.',
    '  --ingest-cutoff ISO    Inclusive ingestion-time boundary.',
    '  --transport-id ID      Defaults to transport-centurion.',
    '  --output-root PATH     Private local root; default is .tmp-centurion-thread-state-audit.',
  ].join('\n');
}

function currentUid(): number {
  if (platform() !== 'linux' || typeof process.getuid !== 'function') {
    fail('CENTURION_THREAD_STATE_OUTPUT_PLATFORM_UNSUPPORTED');
  }
  return process.getuid();
}

function inspectOutputRoot(path: string): CenturionThreadStateOutputRootInspection {
  const info = lstatSync(path);
  return {
    path,
    realPath: realpathSync(path),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
    mode: info.mode,
    uid: info.uid,
  };
}

function inspectOutputFile(path: string): CenturionThreadStateOutputFileInspection {
  const info = lstatSync(path);
  return {
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
    mode: info.mode,
    uid: info.uid,
  };
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function assertCenturionThreadStateOutputTargetAbsent(
  path: string,
  inspect: (path: string) => { isSymbolicLink: () => boolean } = lstatSync,
): void {
  let entry: { isSymbolicLink: () => boolean } | null;
  try {
    entry = inspect(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    fail('CENTURION_THREAD_STATE_OUTPUT_FILE_SYMLINK');
  }
  fail('CENTURION_THREAD_STATE_OUTPUT_ALREADY_EXISTS');
}

function preparePrivateOutputRoot(root: string, uid: number): string {
  const resolvedRoot = resolve(root);
  const parent = dirname(resolvedRoot);
  const rootEntry = lstatIfExists(resolvedRoot);
  if (rootEntry?.isSymbolicLink()) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_SYMLINK');
  }
  if (!rootEntry) {
    const parentEntry = lstatIfExists(parent);
    if (
      !parentEntry ||
      !parentEntry.isDirectory() ||
      parentEntry.isSymbolicLink()
    ) {
      fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_PARENT_INVALID');
    }
    mkdirSync(resolvedRoot, { mode: 0o700 });
  }
  validateCenturionThreadStateOutputRoot({
    platform: platform(),
    currentUid: uid,
    root: inspectOutputRoot(resolvedRoot),
  });
  return resolvedRoot;
}

type PreparedOutputTarget = {
  root: string;
  anchoredRoot: string;
  outputPath: string;
  publicOutputPath: string;
  uid: number;
  directoryFd: number;
};

export function centurionThreadStateAnchoredOutputRootPath(input: {
  platform: string;
  directoryFd: number;
}): string {
  if (
    input.platform !== 'linux' ||
    !Number.isSafeInteger(input.directoryFd) ||
    input.directoryFd < 0
  ) {
    fail('CENTURION_THREAD_STATE_OUTPUT_PLATFORM_UNSUPPORTED');
  }
  return `/proc/self/fd/${input.directoryFd}`;
}

function validateAnchoredOutputRoot(directoryFd: number, uid: number): void {
  const info = fstatSync(directoryFd);
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  ) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_PERMISSIONS');
  }
}

function openAnchoredOutputRoot(root: string, uid: number): number {
  const expected = lstatSync(root);
  const directoryFd = openSync(
    root,
    fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG,
  );
  try {
    const opened = fstatSync(directoryFd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_SYMLINK');
    }
    validateAnchoredOutputRoot(directoryFd, uid);
    return directoryFd;
  } catch (error) {
    closeSync(directoryFd);
    throw error;
  }
}

function preflightPrivateOutputTarget(root: string): PreparedOutputTarget {
  const uid = currentUid();
  const outputRoot = preparePrivateOutputRoot(
    validateCenturionThreadStateOutputRootPath({ outputRoot: root }),
    uid,
  );
  const directoryFd = openAnchoredOutputRoot(outputRoot, uid);
  try {
    const anchoredRoot = centurionThreadStateAnchoredOutputRootPath({
      platform: platform(),
      directoryFd,
    });
    const outputPath = join(anchoredRoot, OUTPUT_FILE_NAME);
    assertCenturionThreadStateOutputTargetAbsent(outputPath);
    return {
      root: outputRoot,
      anchoredRoot,
      outputPath,
      publicOutputPath: join(outputRoot, OUTPUT_FILE_NAME),
      uid,
      directoryFd,
    };
  } catch (error) {
    closeSync(directoryFd);
    throw error;
  }
}

function writePrivateCorpus(
  target: PreparedOutputTarget,
  corpus: ReturnType<typeof parseCenturionThreadStateCorpus>,
): string {
  validateAnchoredOutputRoot(target.directoryFd, target.uid);
  assertCenturionThreadStateOutputTargetAbsent(target.outputPath);

  const temporaryPath = join(
    target.anchoredRoot,
    `.centurion-thread-state-${process.pid}-${Date.now()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NOFOLLOW_FLAG,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(corpus)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    validateAnchoredOutputRoot(target.directoryFd, target.uid);
    validateCenturionThreadStateOutputTarget({
      platform: platform(),
      currentUid: target.uid,
      root: {
        path: target.root,
        realPath: target.root,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o40700,
        uid: target.uid,
      },
      output: inspectOutputFile(temporaryPath),
    });
    linkSync(temporaryPath, target.outputPath);
    unlinkSync(temporaryPath);
    validateAnchoredOutputRoot(target.directoryFd, target.uid);
    validateCenturionThreadStateOutputTarget({
      platform: platform(),
      currentUid: target.uid,
      root: {
        path: target.root,
        realPath: target.root,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o40700,
        uid: target.uid,
      },
      output: inspectOutputFile(target.outputPath),
    });
    return target.publicOutputPath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      const temporaryEntry = lstatIfExists(temporaryPath);
      if (temporaryEntry && !temporaryEntry.isSymbolicLink()) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Private temporary file remains for local operator inspection.
    }
    throw error;
  }
}

function tlsOptions(serverRoot: string) {
  const caPath = join(serverRoot, 'deploy', 'rds-ca-global.pem');
  if (!existsSync(caPath)) {
    fail('CENTURION_THREAD_STATE_RDS_CA_UNAVAILABLE');
  }
  return {
    rejectUnauthorized: true,
    ca: readFileSync(caPath, 'utf8'),
  };
}

function serializeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail('CENTURION_THREAD_STATE_QUERY_TIMESTAMP_INVALID');
  }
  return date.toISOString();
}

function serializeRows(rows: readonly MessageProjection[]): unknown[] {
  return rows.map((row) => ({
    messageId: row.messageId,
    threadId: row.threadId,
    transportId: row.transportId,
    direction: row.direction,
    createdAt: serializeTimestamp(row.createdAt),
    sentAt: serializeTimestamp(row.sentAt),
    receivedAt: serializeTimestamp(row.receivedAt),
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    bccAddresses: row.bccAddresses,
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references,
  }));
}

type ExportDependencies = {
  preflight?: (root: string) => PreparedOutputTarget;
  createClient?: typeof postgres;
};

export async function exportCenturionThreadStateCorpus(
  input: Extract<ExportCommand, { kind: 'execute' }>,
  dependencies: ExportDependencies = {},
): Promise<{
  corpus: ReturnType<typeof parseCenturionThreadStateCorpus>;
  outputPath: string;
}> {
  const outputTarget = (dependencies.preflight ?? preflightPrivateOutputTarget)(
    input.outputRoot,
  );
  try {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) fail('CENTURION_THREAD_STATE_DATABASE_URL_REQUIRED');

    const sql = (dependencies.createClient ?? postgres)(databaseUrl, {
      max: 1,
      connect_timeout: 30,
      idle_timeout: 30,
      ssl: tlsOptions(SERVER_ROOT),
    });
    try {
      const snapshot = await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await transaction`SET LOCAL statement_timeout = '30000ms'`;
      const [transactionState] = await transaction<
        { readOnly: string; isolation: string }[]
      >`
        SELECT
          current_setting('transaction_read_only') AS "readOnly",
          current_setting('transaction_isolation') AS isolation
      `;
      if (
        transactionState?.readOnly !== 'on' ||
        transactionState.isolation.toLowerCase() !== 'repeatable read'
      ) {
        fail('CENTURION_THREAD_STATE_READ_ONLY_ASSERT_FAILED');
      }

      const [summary] = await transaction<QuerySummary[]>`
        SELECT
          count(*)::int AS "messageCount",
          count(DISTINCT m.thread_id)::int AS "threadCount"
        FROM message m
        WHERE m.transport_id = ${input.transportId}
          AND (
            CASE
              WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at)
              WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at)
            END
          ) <= ${input.eventCutoff}
          AND m.created_at <= ${input.ingestCutoff}
      `;
      if (
        !summary ||
        !Number.isSafeInteger(summary.messageCount) ||
        !Number.isSafeInteger(summary.threadCount)
      ) {
        fail('CENTURION_THREAD_STATE_QUERY_CARDINALITY_INVALID');
      }

      const keyset = await transaction<QueryKeyset[]>`
        SELECT
          m.id AS "messageId",
          m.thread_id AS "threadId"
        FROM message m
        WHERE m.transport_id = ${input.transportId}
          AND (
            CASE
              WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at)
              WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at)
            END
          ) <= ${input.eventCutoff}
          AND m.created_at <= ${input.ingestCutoff}
        ORDER BY m.id ASC
      `;
      const rows = await transaction<MessageProjection[]>`
        SELECT
          m.id AS "messageId",
          m.thread_id AS "threadId",
          m.transport_id AS "transportId",
          m.direction AS direction,
          m.created_at AS "createdAt",
          m.sent_at AS "sentAt",
          m.received_at AS "receivedAt",
          m.from_address AS "fromAddress",
          m.to_addresses AS "toAddresses",
          m.cc_addresses AS "ccAddresses",
          m.bcc_addresses AS "bccAddresses",
          m.subject AS subject,
          m.text_body AS "textBody",
          m.html_body AS "htmlBody",
          m.message_id_header AS "messageIdHeader",
          m.in_reply_to AS "inReplyTo",
          m."references" AS "references"
        FROM message m
        WHERE m.transport_id = ${input.transportId}
          AND (
            CASE
              WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at)
              WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at)
            END
          ) <= ${input.eventCutoff}
          AND m.created_at <= ${input.ingestCutoff}
        ORDER BY
          CASE
            WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at)
            WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at)
          END ASC,
          m.id ASC
      `;
      if (
        keyset.length !== summary.messageCount ||
        rows.length !== summary.messageCount
      ) {
        fail('CENTURION_THREAD_STATE_QUERY_CARDINALITY_MISMATCH');
      }
      return { summary, keyset, rows };
    });

    const rows = serializeRows(snapshot.rows);
    const sourceManifest = createCenturionThreadStateSourceManifest(rows);
    const keysetManifest = createCenturionThreadStateSourceManifest(
      snapshot.keyset.map((row) => ({
        messageId: row.messageId,
        threadId: row.threadId,
      })),
    );
    const corpus = parseCenturionThreadStateCorpus({
      source: {
        schemaVersion: CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION,
        transportId: input.transportId,
        eventCutoff: input.eventCutoff,
        ingestCutoff: input.ingestCutoff,
      },
      manifest: {
        ...sourceManifest,
        messageCount: snapshot.summary.messageCount,
        threadCount: snapshot.summary.threadCount,
        messageIdsSha256: keysetManifest.messageIdsSha256,
        messageThreadPairsSha256: keysetManifest.messageThreadPairsSha256,
      },
      messages: rows,
    });
      return {
        corpus,
        outputPath: writePrivateCorpus(outputTarget, corpus),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    closeSync(outputTarget.directoryFd);
  }
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^CENTURION_THREAD_STATE_[A-Z0-9_:-]+$/u.test(message)
    ? message
    : 'CENTURION_THREAD_STATE_EXPORT_FAILED';
}

async function main(): Promise<void> {
  const command = parseCenturionThreadStateExportArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(`${centurionThreadStateExportHelp()}\n`);
    return;
  }
  const { corpus, outputPath } = await exportCenturionThreadStateCorpus(command);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      outputPath,
      messageCount: corpus.manifest.messageCount,
      threadCount: corpus.manifest.threadCount,
      corpusSha256: corpus.manifest.corpusSha256,
    })}\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (
  invokedPath &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
