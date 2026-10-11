/**
 * Reply link backfill (C2, C3). Applies the thread rules in planThreadWork to the work items already on the threads, so
 * the backlog gets the outcome live admission gives new mail: a needs-you item a hotel reply already answered becomes
 * done (hotel_replied, with sent_at); an older untouched item that a newer request on its thread supersedes is dismissed
 * (superseded_by_thread); an other mail from the hotel's own staff gets no needs-you (staff_sent_other).
 *
 * Dry run is the default and writes nothing: it plans every thread and prints the counts. --apply is required to write.
 * A write goes through refreshThreadWork, which plans each thread again under the item locks, so an edit a person made
 * after the dry run is never overwritten. A second --apply finds nothing left to change.
 *
 * Logs carry counts and codes only. No subject, body, address or connection string is printed.
 *
 * Run from apps/server-pilot:
 *   pnpm exec tsx scripts/backfill-reply-link.ts [--apply] [--transport-id <id>]
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { planThreadWork, refreshThreadWork, type ThreadWorkChange } from '../src/ai/work-items.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { workItem } from '../src/db/schema/work.js';

const USAGE = 'usage: pnpm exec tsx scripts/backfill-reply-link.ts [--apply] [--transport-id <id>]';

export type ReplyLinkCounts = {
  apply: boolean;
  /** Threads with an item the rules can still change. */
  threads: number;
  /** Planned changes in a dry run, applied changes with --apply. */
  changes: number;
  byKind: Record<string, number>;
  byReason: Record<string, number>;
};

/** Throws on unknown flags. */
export function parseReplyLinkArgs(argv: readonly string[]): { apply: boolean; help: boolean; transportId?: string } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: 'boolean' },
      'transport-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const transportId = values['transport-id']?.trim();
  if (values['transport-id'] !== undefined && !transportId) throw new Error('empty transport id');
  return {
    apply: values.apply === true,
    help: values.help === true,
    ...(transportId ? { transportId } : {}),
  };
}

/** Threads with a needs-you or done item that is not spam. A thread with no item has nothing to link. */
export async function selectReplyLinkThreads(
  db: DB,
  transportId?: string,
): Promise<Array<{ transportId: string; threadId: string }>> {
  const rows = await db
    .selectDistinct({ transportId: workItem.transportId, threadId: workItem.threadId })
    .from(workItem)
    .where(
      and(
        inArray(workItem.status, ['needs_you', 'done']),
        ne(workItem.kind, 'spam'),
        transportId ? eq(workItem.transportId, transportId) : undefined,
      ),
    );
  return rows.flatMap((row) => (row.threadId ? [{ transportId: row.transportId, threadId: row.threadId }] : []));
}

/** Plans every thread, or with apply writes its changes, and counts them by kind and by reason. */
export async function runReplyLinkBackfill(input: {
  db?: DB;
  apply: boolean;
  transportId?: string;
}): Promise<ReplyLinkCounts> {
  const db = input.db ?? getDb();
  const threads = await selectReplyLinkThreads(db, input.transportId);
  const counts: ReplyLinkCounts = { apply: input.apply, threads: threads.length, changes: 0, byKind: {}, byReason: {} };
  for (const thread of threads) {
    const changes: ThreadWorkChange[] = input.apply
      ? await refreshThreadWork(db, thread)
      : await planThreadWork(db, thread);
    for (const change of changes) {
      counts.changes += 1;
      counts.byKind[change.kind] = (counts.byKind[change.kind] ?? 0) + 1;
      const reason = 'reason' in change ? change.reason : 'repoint';
      counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
    }
  }
  return counts;
}

export async function runReplyLinkCli(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseReplyLinkArgs>;
  try {
    args = parseReplyLinkArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const counts = await runReplyLinkBackfill({ apply: args.apply, transportId: args.transportId });
    console.log(JSON.stringify({ event: 'reply_link_backfill_done', ...counts }));
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.log(
      JSON.stringify({
        event: 'reply_link_backfill_failed',
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
  void runReplyLinkCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
