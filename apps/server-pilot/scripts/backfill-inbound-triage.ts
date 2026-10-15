/**
 * Backfill inbound_triage for skipAiEnqueue recoveries.
 *
 * EC2 persist only. No shadow. Counts-only stdout. Never Vitest.
 *
 *   pnpm --filter @zero/server tsx scripts/backfill-inbound-triage.ts --dry-run
 *   pnpm --filter @zero/server tsx scripts/backfill-inbound-triage.ts
 *   pnpm --filter @zero/server tsx scripts/backfill-inbound-triage.ts --quarantine-histogram
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { aiWorkflowRun, mailIngestQuarantine, message } from '../src/db/schema/mail.js';
import { parseEnv } from '../src/env.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../src/ai/run-ledger.js';

const CENTURION_INGEST_MAILBOX_ID = 'ingest-nava-legacy';
/** Recover overlay ran after the 17:21Z quarantine snapshot. */
const DEFAULT_SINCE = '2026-09-19T17:21:00.000Z';

function parseCli(argv: string[]): {
  dryRun: boolean;
  histogram: boolean;
  since: Date;
  limit?: number;
} {
  let dryRun = false;
  let histogram = false;
  let since = new Date(DEFAULT_SINCE);
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--quarantine-histogram') {
      histogram = true;
      continue;
    }
    if (arg === '--since') {
      const next = argv[i + 1];
      if (!next || Number.isNaN(Date.parse(next))) {
        throw new Error('--since requires an ISO timestamp');
      }
      since = new Date(next);
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const next = argv[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error('--limit requires a positive integer');
      }
      limit = Number(next);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit requires a positive integer');
  }
  return { dryRun, histogram, since, limit };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    if (cli.histogram) {
      const byReason = await db
        .select({
          reason: mailIngestQuarantine.reason,
          n: sql<number>`count(*)::int`,
        })
        .from(mailIngestQuarantine)
        .groupBy(mailIngestQuarantine.reason);
      const byReasonDay = await db
        .select({
          reason: mailIngestQuarantine.reason,
          day: sql<string>`to_char(${mailIngestQuarantine.createdAt}, 'YYYY-MM-DD')`,
          n: sql<number>`count(*)::int`,
        })
        .from(mailIngestQuarantine)
        .where(gte(mailIngestQuarantine.createdAt, new Date('2026-09-15T00:00:00.000Z')))
        .groupBy(
          mailIngestQuarantine.reason,
          sql`to_char(${mailIngestQuarantine.createdAt}, 'YYYY-MM-DD')`,
        );
      console.log(JSON.stringify({ phase: 'quarantine-histogram', byReason, byReasonDay }));
      return;
    }

    const query = db
      .select({
        id: message.id,
        transportId: message.transportId,
        threadId: message.threadId,
      })
      .from(message)
      .leftJoin(
        aiWorkflowRun,
        eq(aiWorkflowRun.idempotencyKey, sql`'inbound-triage:' || ${message.id}`),
      )
      .where(
        and(
          eq(message.ingestMailboxId, CENTURION_INGEST_MAILBOX_ID),
          eq(message.direction, 'inbound'),
          gte(message.createdAt, cli.since),
          isNull(aiWorkflowRun.id),
        ),
      );

    const rows = cli.limit !== undefined ? await query.limit(cli.limit) : await query;

    const result = {
      phase: cli.dryRun ? 'dry-run' : 'complete',
      since: cli.since.toISOString(),
      scanned: rows.length,
      enqueued: 0,
      alreadyPresent: 0,
      skippedOutbound: 0,
      errors: 0,
    };

    if (cli.dryRun) {
      console.log(JSON.stringify(result));
      return;
    }

    for (const row of rows) {
      try {
        const run = await enqueueAiRun({
          transportId: row.transportId,
          threadId: row.threadId,
          triggerMessageId: row.id,
          runKind: 'inbound_triage',
          idempotencyKey: `inbound-triage:${row.id}`,
          modelId: DEFAULT_AI_MODEL_ID,
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
        }, db);
        if (run.createdAt < cli.since) {
          result.alreadyPresent += 1;
        } else {
          result.enqueued += 1;
        }
      } catch {
        result.errors += 1;
      }
    }

    console.log(JSON.stringify(result));
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('backfill-inbound-triage failed:', err instanceof Error ? err.message : 'error');
  process.exit(1);
});
