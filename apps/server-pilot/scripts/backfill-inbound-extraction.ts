/**
 * Inbound extraction backfill: queues one read for each inbound mail from the last 14 days that has none yet, on one
 * transport (--transport-id) or every transport. Each read is the same `inbound_extraction` run that live admission queues, with the same idempotency key,
 * so a repeat is a no-op. Runs are spread across hours at the worker's hourly cap (INBOUND_EXTRACTION_MAX_PER_HOUR),
 * newest first, so the worker never claims a run it has to defer. A thread with a later staff reply gets a done work
 * item (see ensureWorkItemForMessage).
 *
 * --message-id <id> (repeatable) queues only those message rows (message.id), for a re-read after an extractor
 * change. It skips the 14-day window, so an older mail can be re-read; every other rule still holds: inbound only, no
 * ambiguous identity, no read yet for the current version, and --transport-id when given.
 *
 * Database: writes ai_workflow_run rows. --dry-run counts only and writes nothing.
 * Logs carry counts and codes only. No subject, body, address or connection string is printed.
 *
 * Run on EC2 from apps/server-pilot:
 *   pnpm exec tsx scripts/backfill-inbound-extraction.ts [--dry-run] [--transport-id <id>] [--message-id <id> ...]
 */
import {
  enqueueInboundExtraction,
  inboundExtractionMaxPerHour,
  EXTRACTION_VERSION,
} from '../src/ai/extraction/inbound-run.js';
import { and, desc, eq, gte, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { message } from '../src/db/schema/mail.js';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const BACKFILL_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;
const USAGE =
  'usage: pnpm exec tsx scripts/backfill-inbound-extraction.ts [--dry-run] [--transport-id <id>] [--message-id <id> ...]';

export type BackfillCounts = {
  dryRun: boolean;
  candidates: number;
  /** Runs handed to enqueueAiRun. A run that already exists is a no-op there, so this can exceed new rows. */
  queued: number;
  /** Hour slots the queued runs fill, at maxPerHour each. */
  hours: number;
  maxPerHour: number;
};

/** Throws on unknown flags. The message is never printed. */
export function parseBackfillArgs(argv: readonly string[]): {
  dryRun: boolean;
  help: boolean;
  transportId?: string;
  messageIds?: string[];
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean' },
      'transport-id': { type: 'string' },
      'message-id': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const transportId = values['transport-id']?.trim();
  if (values['transport-id'] !== undefined && !transportId) throw new Error('empty transport id');
  const messageIds = values['message-id']?.map((id) => id.trim());
  if (messageIds?.some((id) => !id)) throw new Error('empty message id');
  return {
    dryRun: values['dry-run'] === true,
    help: values.help === true,
    ...(transportId ? { transportId } : {}),
    ...(messageIds?.length ? { messageIds: [...new Set(messageIds)] } : {}),
  };
}

/**
 * Inbound mail received in the window with no read for the current extractor version. Newest first. The window and the
 * order use the mail's own date (receivedAt), not when the row was stored: Outlook history imported today keeps its
 * original date there. A row with no date falls back to when it was stored. Rows admission keeps out as ambiguous
 * identity are skipped. With messageIds, only those rows, and the window does not apply.
 */
export function selectBackfillCandidates(
  db: DB,
  input: { since: Date; transportId?: string; messageIds?: readonly string[] },
) {
  const mailAt = sql`coalesce(${message.receivedAt}, ${message.createdAt})`;
  return db
    .select({
      transportId: message.transportId,
      threadId: message.threadId,
      messageId: message.id,
    })
    .from(message)
    .where(
      and(
        eq(message.direction, 'inbound'),
        // Live admission never reads a row whose sender identity is unclear (it may be a staff copy), so neither does this.
        sql`(${message.sourceProvenance}->>'attention') is distinct from 'AMBIGUOUS_IDENTITY'`,
        input.messageIds
          ? inArray(message.id, [...input.messageIds])
          : or(
              gte(message.receivedAt, input.since),
              and(isNull(message.receivedAt), gte(message.createdAt, input.since)),
            ),
        input.transportId ? eq(message.transportId, input.transportId) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(mailExtraction)
            .where(
              and(
                eq(mailExtraction.messageId, message.id),
                eq(mailExtraction.extractorVersion, EXTRACTION_VERSION),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(mailAt), desc(message.id));
}

/**
 * Queues the window. Run i becomes due in hour floor(i / maxPerHour), so the worker's hourly cap is never hit. A second
 * call finds no candidates for the runs it already queued and leaves the same keys in place.
 */
export async function runInboundExtractionBackfill(input: {
  db?: DB;
  now?: Date;
  dryRun: boolean;
  maxPerHour: number;
  transportId?: string;
  /** Only these message rows, outside the window too. Empty means none. */
  messageIds?: readonly string[];
}): Promise<BackfillCounts> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const rows = await selectBackfillCandidates(db, {
    since: new Date(now.getTime() - BACKFILL_DAYS * 24 * HOUR_MS),
    transportId: input.transportId,
    messageIds: input.messageIds,
  });
  const queueable = rows.filter((row) => row.threadId !== null);
  if (!input.dryRun) {
    for (const [index, row] of queueable.entries()) {
      // A cap of 0 would make every slot infinite. The worker defers those runs anyway, so spread them one per hour.
      const slot = Math.floor(index / Math.max(1, input.maxPerHour));
      await enqueueInboundExtraction(
        {
          transportId: row.transportId,
          threadId: row.threadId as string,
          messageId: row.messageId,
          nextRunAt: new Date(now.getTime() + slot * HOUR_MS),
        },
        db,
      );
    }
  }
  return {
    dryRun: input.dryRun,
    candidates: queueable.length,
    queued: input.dryRun ? 0 : queueable.length,
    hours: Math.ceil(queueable.length / Math.max(1, input.maxPerHour)),
    maxPerHour: input.maxPerHour,
  };
}

export async function runBackfillCli(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseBackfillArgs>;
  try {
    args = parseBackfillArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const counts = await runInboundExtractionBackfill({
      dryRun: args.dryRun,
      maxPerHour: inboundExtractionMaxPerHour(process.env),
      transportId: args.transportId,
      messageIds: args.messageIds,
    });
    console.log(
      JSON.stringify({ event: 'inbound_extraction_backfill_done', days: BACKFILL_DAYS, ...counts }),
    );
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.log(
      JSON.stringify({
        event: 'inbound_extraction_backfill_failed',
        code: typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'error',
      }),
    );
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  void runBackfillCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
