/**
 * Inbound extraction backfill: queues one read for each inbound mail from the last 14 days that has none yet, on every
 * transport. Each read is the same `inbound_extraction` run that live admission queues, with the same idempotency key,
 * so a repeat is a no-op. Runs are spread across hours at the worker's hourly cap (INBOUND_EXTRACTION_MAX_PER_HOUR),
 * newest first, so the worker never claims a run it has to defer. A thread with a later staff reply gets a done work
 * item (see ensureWorkItemForMessage).
 *
 * Database: writes ai_workflow_run rows. --dry-run counts only and writes nothing.
 * Logs carry counts and codes only. No subject, body, address or connection string is printed.
 *
 * Run on EC2 from apps/server-pilot:
 *   pnpm exec tsx scripts/backfill-inbound-extraction.ts [--dry-run]
 */
import {
  enqueueInboundExtraction,
  inboundExtractionMaxPerHour,
  EXTRACTION_VERSION,
} from '../src/ai/extraction/inbound-run.js';
import { and, desc, eq, gte, notExists, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { message } from '../src/db/schema/mail.js';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const BACKFILL_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;
const USAGE = 'usage: pnpm exec tsx scripts/backfill-inbound-extraction.ts [--dry-run]';

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
export function parseBackfillArgs(argv: readonly string[]): { dryRun: boolean; help: boolean } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  return { dryRun: values['dry-run'] === true, help: values.help === true };
}

/** Inbound mail received in the window with no read for the current extractor version. Newest first. */
export function selectBackfillCandidates(db: DB, input: { since: Date }) {
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
        gte(message.createdAt, input.since),
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
    .orderBy(desc(message.createdAt), desc(message.id));
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
}): Promise<BackfillCounts> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const rows = await selectBackfillCandidates(db, {
    since: new Date(now.getTime() - BACKFILL_DAYS * 24 * HOUR_MS),
  });
  const queueable = rows.filter((row) => row.threadId !== null);
  if (!input.dryRun) {
    for (const [index, row] of queueable.entries()) {
      const slot = Math.floor(index / input.maxPerHour);
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
    hours: Math.ceil(queueable.length / input.maxPerHour),
    maxPerHour: input.maxPerHour,
  };
}

export async function runBackfillCli(argv: readonly string[]): Promise<number> {
  let args: { dryRun: boolean; help: boolean };
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
