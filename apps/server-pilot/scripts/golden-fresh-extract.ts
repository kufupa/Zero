/** Re-run production inbound extraction for a fixed message-id set without persisting any result. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { classifyMailSource, type MailSourceKind } from '../src/ai/mail-source.js';
import { resolveAdapter } from '../src/ai/quote-workflow-analyse-selection.js';
import { EXTRACTION_DEADLINE_MS, extractInboundMail } from '../src/ai/extraction/extract.js';
import type { MailExtractionPayload, MailKind } from '../src/ai/extraction/schema.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
} from '../src/ai/quote-workflow-synced-selection.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { mailboxTransport, message } from '../src/db/schema/mail.js';

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = EXTRACTION_DEADLINE_MS;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAIL_SOURCE_BODY_LIMIT = 16_384;
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const USAGE =
  'usage: pnpm exec tsx scripts/golden-fresh-extract.ts [--input <file.json>] <message-id>... --out <path.jsonl> [--concurrency <n>] [--timeout-ms <n>]';

export type GoldenFreshStatus = 'succeeded' | 'failed' | 'skipped';

export type GoldenFreshRow = {
  message_id: string;
  source: MailSourceKind;
  status: GoldenFreshStatus;
  kind: MailKind | null;
  payload: MailExtractionPayload | null;
  error_code?: string;
};

export type GoldenFreshArgs = {
  help: boolean;
  messageIds: string[];
  outPath: string;
  concurrency: number;
  timeoutMs: number;
};

export type GoldenFreshMessage = {
  id: string;
  transportId: string;
  direction: string;
  fromAddress: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  mailbox: string | null;
};

type ReadOnlyDb = Pick<DB, 'transaction'>;

type GoldenFreshInput = {
  messageIds: readonly string[];
  db: ReadOnlyDb;
  adapter: ModelAdapter | null;
  concurrency?: number;
  timeoutMs?: number;
  loadSelection?: typeof loadSyncedQuoteSelectionFromMailbox;
};

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof candidate === 'string' && SAFE_ERROR_CODE.test(candidate) ? candidate : 'error';
}

function positiveInteger(value: string | undefined, fallback: number, max: number, code: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw codedError(code);
  return parsed;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function goldenFreshSourceBody(textBody: string | null, htmlBody: string | null): string | null {
  return (textBody ?? htmlBody)?.slice(0, MAIL_SOURCE_BODY_LIMIT) ?? null;
}

export function parseGoldenFreshExtractArgs(
  argv: readonly string[],
  readIdsFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): GoldenFreshArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        input: { type: 'string' },
        out: { type: 'string' },
        concurrency: { type: 'string' },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch {
    throw codedError('invalid_args');
  }

  if (parsed.values.help) {
    return {
      help: true,
      messageIds: [],
      outPath: '',
      concurrency: DEFAULT_CONCURRENCY,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  let fileIds: string[] = [];
  if (parsed.values.input !== undefined) {
    let contents: string;
    try {
      contents = readIdsFile(parsed.values.input);
    } catch {
      throw codedError('input_read_failed');
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw codedError('input_json_invalid');
    }
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
      throw codedError('input_ids_invalid');
    }
    fileIds = value;
  }

  const messageIds = uniqueIds([...fileIds, ...parsed.positionals]);
  if (messageIds.length === 0) throw codedError('message_ids_required');
  const outPath = parsed.values.out?.trim();
  if (!outPath) throw codedError('out_required');

  return {
    help: false,
    messageIds,
    outPath,
    concurrency: positiveInteger(
      parsed.values.concurrency,
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
      'concurrency_invalid',
    ),
    timeoutMs: positiveInteger(
      parsed.values['timeout-ms'],
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeout_invalid',
    ),
  };
}

function isWithinPath(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

/** Resolves symlinked parents too, so `--out` cannot reach back into the repository. */
export function resolveGoldenFreshOutputPath(
  outputPath: string,
  repositoryRoot: string,
  workingDirectory = process.cwd(),
): string {
  const target = resolve(workingDirectory, outputPath);
  const root = resolve(repositoryRoot);
  const canonicalRoot = realpathSync(root);
  if (isWithinPath(target, root) || isWithinPath(target, canonicalRoot)) {
    throw codedError('out_inside_repo');
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw codedError('out_path_invalid');
    try {
      canonicalTarget = resolve(realpathSync(dirname(target)), basename(target));
    } catch {
      throw codedError('out_path_invalid');
    }
  }
  if (isWithinPath(canonicalTarget, canonicalRoot)) throw codedError('out_inside_repo');
  return target;
}

/** The worker admits this read under a claim; the scorer reads only the same source columns. */
export async function loadGoldenFreshMessage(
  db: ReadOnlyDb,
  messageId: string,
): Promise<GoldenFreshMessage | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [row] = await tx
      .select({
        id: message.id,
        transportId: message.transportId,
        direction: message.direction,
        fromAddress: message.fromAddress,
        subject: message.subject,
        textBody: sql<string | null>`left(${message.textBody},${MAIL_SOURCE_BODY_LIMIT})`,
        htmlBody: sql<string | null>`left(${message.htmlBody},${MAIL_SOURCE_BODY_LIMIT})`,
        mailbox: mailboxTransport.email,
      })
      .from(message)
      .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
      .where(eq(message.id, messageId))
      .limit(1);
    return row ?? null;
  });
}

function failedRow(messageId: string, source: MailSourceKind, code: string): GoldenFreshRow {
  return {
    message_id: messageId,
    source,
    status: 'failed',
    kind: null,
    payload: null,
    error_code: code,
  };
}

function skippedRow(messageId: string, source: MailSourceKind): GoldenFreshRow {
  return { message_id: messageId, source, status: 'skipped', kind: null, payload: null };
}

async function runOne(
  messageId: string,
  input: GoldenFreshInput,
  loadSelection: typeof loadSyncedQuoteSelectionFromMailbox,
  timeoutMs: number,
): Promise<GoldenFreshRow> {
  const controller = new AbortController();
  let source: MailSourceKind = 'direct';
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GoldenFreshRow>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      resolveTimeout(failedRow(messageId, source, 'timeout'));
    }, timeoutMs);
  });

  const read = (async (): Promise<GoldenFreshRow> => {
    const trigger = await loadGoldenFreshMessage(input.db, messageId);
    if (!trigger) return failedRow(messageId, source, 'message_not_found');

    source = classifyMailSource({
      fromAddress: trigger.fromAddress,
      subject: trigger.subject,
      bodyText: goldenFreshSourceBody(trigger.textBody, trigger.htmlBody),
    }).kind;
    if (trigger.direction !== 'inbound' || source !== 'direct') {
      return skippedRow(messageId, source);
    }
    if (!input.adapter) return failedRow(messageId, source, 'adapter_unavailable');

    const selection = await loadSelection({
      transportId: trigger.transportId,
      messageId: trigger.id,
      signal: controller.signal,
    });
    if (!selection) return failedRow(messageId, source, 'not_found');
    if (controller.signal.aborted) return failedRow(messageId, source, 'timeout');

    const extraction = await extractInboundMail({
      adapter: input.adapter,
      selection,
      messageId: trigger.id,
      from: trigger.fromAddress,
      mailbox: trigger.mailbox,
      signal: controller.signal,
      deadlineMs: EXTRACTION_DEADLINE_MS,
    });
    if (!extraction.ok) return failedRow(messageId, source, extraction.reason);
    return {
      message_id: messageId,
      source,
      status: 'succeeded',
      kind: extraction.kind,
      payload: extraction.payload,
    };
  })();

  try {
    return await Promise.race([
      read.catch((error: unknown) => failedRow(messageId, source, errorCode(error))),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function runGoldenFreshExtract(input: GoldenFreshInput): Promise<GoldenFreshRow[]> {
  const messageIds = uniqueIds(input.messageIds);
  if (messageIds.length === 0) return [];
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw codedError('concurrency_invalid');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw codedError('timeout_invalid');
  }
  const loadSelection = input.loadSelection ?? loadSyncedQuoteSelectionFromMailbox;
  const rows: GoldenFreshRow[] = [];
  rows.length = messageIds.length;
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, messageIds.length) }, async () => {
      while (nextIndex < messageIds.length) {
        const index = nextIndex++;
        rows[index] = await runOne(messageIds[index]!, input, loadSelection, timeoutMs);
      }
    }),
  );
  return rows;
}

export function formatGoldenFreshJsonl(rows: readonly GoldenFreshRow[]): string {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

export function summarizeGoldenFreshRows(rows: readonly GoldenFreshRow[]): {
  statuses: Record<GoldenFreshStatus, number>;
  kinds: Record<string, number>;
} {
  const statuses: Record<GoldenFreshStatus, number> = { succeeded: 0, failed: 0, skipped: 0 };
  const kinds = new Map<string, number>();
  for (const row of rows) {
    statuses[row.status] += 1;
    const kind = row.kind ?? '(none)';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return { statuses, kinds: Object.fromEntries([...kinds].sort(([left], [right]) => left.localeCompare(right))) };
}

/** Contains aggregate labels only. It deliberately excludes ids, payloads, errors and model metadata. */
export function formatGoldenFreshSummary(rows: readonly GoldenFreshRow[]): string {
  return JSON.stringify({ event: 'golden_fresh_extract_summary', ...summarizeGoldenFreshRows(rows) });
}

export async function runGoldenFreshExtractCli(argv: readonly string[]): Promise<number> {
  let args: GoldenFreshArgs;
  try {
    args = parseGoldenFreshExtractArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ event: 'golden_fresh_extract_failed', code: errorCode(error) }));
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let outputPath: string;
  try {
    outputPath = resolveGoldenFreshOutputPath(args.outPath, REPOSITORY_ROOT);
  } catch (error) {
    console.error(JSON.stringify({ event: 'golden_fresh_extract_failed', code: errorCode(error) }));
    return 2;
  }

  try {
    const rows = await runGoldenFreshExtract({
      messageIds: args.messageIds,
      db: getDb(),
      adapter: resolveAdapter(true, null).adapter,
      concurrency: args.concurrency,
      timeoutMs: args.timeoutMs,
    });
    writeFileSync(outputPath, formatGoldenFreshJsonl(rows), { encoding: 'utf8', mode: 0o600 });
    console.log(formatGoldenFreshSummary(rows));
    return rows.some((row) => row.status === 'failed') ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({ event: 'golden_fresh_extract_failed', code: errorCode(error) }));
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  void runGoldenFreshExtractCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
