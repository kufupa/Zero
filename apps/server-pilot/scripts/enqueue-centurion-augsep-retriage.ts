#!/usr/bin/env npx tsx
/**
 * Enqueue inbound_triage for Centurion threads that gained Aug–Sep catchup outbound.
 *
 * Targets inbound-bearing threads:
 *  1) thread contains ≥1 new catchup outbound AND ≥1 inbound, or
 *  2) inbound thread has active conversation link to a thread with such outbound.
 *
 * Idempotency: inbound-triage:catchup-augsep-2026:<threadId>
 *
 * EC2:
 *   set -a && source .env.production && set +a
 *   pnpm --filter @zero/server exec tsx scripts/enqueue-centurion-augsep-retriage.ts \
 *     --confirm-pilot-rds [--dry-run] [--since=2026-09-11]
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../src/ai/run-ledger.js';
import * as schema from '../src/db/schema/index.js';
import { message, aiWorkflowRun } from '../src/db/schema/mail.js';
import { mailConversationLink } from '../src/db/schema/mail-conversation-link.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { parseEnv } from '../src/env.js';

const TRANSPORT = 'transport-centurion';
const BATCH = 'catchup-augsep-2026';

type Cli = { dryRun: boolean; confirmPilotRds: boolean; sinceIso: string };

function parseArgs(argv: string[]): Cli {
  let dryRun = false;
  let confirmPilotRds = false;
  let sinceIso = '2026-09-11T00:00:00.000Z';
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--confirm-pilot-rds') confirmPilotRds = true;
    else if (a.startsWith('--since=')) sinceIso = a.slice('--since='.length);
  }
  return { dryRun, confirmPilotRds, sinceIso };
}

function refuse(url: string | undefined, confirm: boolean): void {
  if (!url) throw new Error('DATABASE_URL required');
  if (url.includes('nava-zero-mail-pilot') && !confirm) {
    throw new Error('REFUSE: pilot RDS needs --confirm-pilot-rds');
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  refuse(env.DATABASE_URL, cli.confirmPilotRds);
  const conn = postgres(env.DATABASE_URL, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });
  const since = new Date(cli.sinceIso);
  if (Number.isNaN(since.getTime())) throw new Error(`bad --since ${cli.sinceIso}`);

  try {
    const outbound = await db
      .select({
        id: message.id,
        threadId: message.threadId,
      })
      .from(message)
      .where(
        and(
          eq(message.transportId, TRANSPORT),
          eq(message.direction, 'outbound'),
          sql`${message.pop3Uidl} LIKE 'catchup-gold-%'`,
          gte(message.createdAt, since),
        ),
      );

    const outboundThreadIds = [...new Set(outbound.map((r) => r.threadId))];
    console.log(
      JSON.stringify({
        newCatchupOutbound: outbound.length,
        outboundThreads: outboundThreadIds.length,
        since: since.toISOString(),
      }),
    );

    if (outboundThreadIds.length === 0) {
      console.log('nothing to retriage');
      return;
    }

    const selfInboundRows = await db
      .selectDistinct({ threadId: message.threadId })
      .from(message)
      .where(
        and(
          eq(message.transportId, TRANSPORT),
          eq(message.direction, 'inbound'),
          inArray(message.threadId, outboundThreadIds),
        ),
      );
    const selfIds = new Set(selfInboundRows.map((r) => r.threadId));

    const links = await db
      .select({
        src: mailConversationLink.srcThreadId,
        dst: mailConversationLink.dstThreadId,
      })
      .from(mailConversationLink)
      .where(
        and(
          eq(mailConversationLink.transportId, TRANSPORT),
          isNull(mailConversationLink.supersededAt),
          or(
            inArray(mailConversationLink.srcThreadId, outboundThreadIds),
            inArray(mailConversationLink.dstThreadId, outboundThreadIds),
          ),
        ),
      );

    const peerIds = new Set<string>();
    const outboundSet = new Set(outboundThreadIds);
    for (const l of links) {
      if (outboundSet.has(l.src)) peerIds.add(l.dst);
      if (outboundSet.has(l.dst)) peerIds.add(l.src);
    }
    for (const id of selfIds) peerIds.delete(id);

    let linkedInbound: string[] = [];
    if (peerIds.size > 0) {
      const rows = await db
        .selectDistinct({ threadId: message.threadId })
        .from(message)
        .where(
          and(
            eq(message.transportId, TRANSPORT),
            eq(message.direction, 'inbound'),
            inArray(message.threadId, [...peerIds]),
          ),
        );
      linkedInbound = rows.map((r) => r.threadId);
    }

    const targetThreads = [...new Set([...selfIds, ...linkedInbound])].sort();
    console.log(
      JSON.stringify({
        selfInboundThreads: selfIds.size,
        linkedInboundThreads: linkedInbound.length,
        targetThreads: targetThreads.length,
        dryRun: cli.dryRun,
      }),
    );

    if (cli.dryRun) {
      console.log('dry-run sample targets', targetThreads.slice(0, 15));
      return;
    }

    let inserted = 0;
    let already = 0;
    for (const threadId of targetThreads) {
      const [trig] = await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.transportId, TRANSPORT),
            eq(message.threadId, threadId),
            eq(message.direction, 'inbound'),
          ),
        )
        .orderBy(desc(message.receivedAt), desc(message.createdAt))
        .limit(1);
      if (!trig) continue;

      const key = `inbound-triage:${BATCH}:${threadId}`;
      const [prior] = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, key))
        .limit(1);

      await enqueueAiRun(
        {
          transportId: TRANSPORT,
          threadId,
          triggerMessageId: trig.id,
          runKind: 'inbound_triage',
          idempotencyKey: key,
          modelId: DEFAULT_AI_MODEL_ID,
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
        },
        db as never,
      );
      if (prior) already += 1;
      else inserted += 1;
    }

    console.log(
      JSON.stringify({ inserted, alreadyPresent: already, targetThreads: targetThreads.length }),
    );
  } finally {
    await conn.end();
    delete process.env.DATABASE_URL;
  }
}

main().catch((err) => {
  console.error('augsep retriage failed:', err);
  process.exit(1);
});
