#!/usr/bin/env npx tsx
/**
 * Centurion draft backtest CLI (eval-only).
 * Modes:
 *   --offline-fixtures  synthetic pairs (laptop-safe)
 *   --live-corpus       read-only SELECT on DATABASE_URL (EC2; no Vitest)
 *
 * No SMTP. No HMS mutation. No product draft promote. Concurrency=1.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  aggregateRecords,
  appendEvalRecord,
  assertBacktestSourceSafe,
  CENTURION_TRANSPORT_ID,
  hashOpaqueId,
  loadScoredHashes,
  pairCenturionGold,
  renderOfflineBracketDraft,
  scoreDraftAgainstEvidence,
  writeScorecard,
  type DraftEvalRecord,
} from '../src/ai/draft-backtest.js';

function parseArgs(argv: string[]) {
  let limit = 25;
  let runId = randomUUID();
  let offline = false;
  let live = false;
  let root =
    process.env.DRAFT_BACKTEST_ROOT?.trim() ||
    '/opt/nava/shared/draft-backtest';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline-fixtures') offline = true;
    else if (a === '--live-corpus') live = true;
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--run-id') runId = String(argv[++i]);
    else if (a === '--root') root = String(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: run-centurion-draft-backtest.ts (--offline-fixtures|--live-corpus) [--limit N] [--run-id ID] [--root DIR]',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('--limit must be >= 1');
  }
  if (offline === live) {
    throw new Error('choose exactly one of --offline-fixtures | --live-corpus');
  }
  return { limit, runId, offline, live, root };
}

function sslOptions(rootDir: string) {
  const caPath = join(rootDir, 'deploy', 'rds-ca-global.pem');
  if (existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
  }
  return 'require' as const;
}

function offlineFixturePairs(limit: number) {
  const pairs = [];
  for (let i = 0; i < limit; i++) {
    const inboundId = `fix-in-${i}`;
    const threadId = `fix-thread-${i}`;
    const hasGold = i % 3 !== 0;
    const forward = i % 5 === 0;
    pairs.push(
      pairCenturionGold({
        threadId,
        inboundMessageId: inboundId,
        messages: [
          {
            id: inboundId,
            direction: 'inbound' as const,
            createdAt: '2026-08-01T10:00:00.000Z',
          },
          ...(hasGold
            ? [
                {
                  id: `fix-out-${i}`,
                  direction: 'outbound' as const,
                  transportId: CENTURION_TRANSPORT_ID,
                  createdAt: '2026-08-01T11:00:00.000Z',
                  subject: forward ? 'Fw: handle' : 'Re: booking',
                },
              ]
            : []),
        ],
      }),
    );
  }
  return pairs;
}

async function loadLivePairs(limit: number, serverRoot: string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for --live-corpus');
  const sql = postgres(url, {
    ssl: sslOptions(serverRoot),
    max: 1,
    connect_timeout: 30,
  });
  try {
    const inbounds = await sql<{
      id: string;
      thread_id: string;
      created_at: string;
    }[]>`
      SELECT m.id, m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at)::text AS created_at
      FROM message m
      WHERE m.transport_id = ${CENTURION_TRANSPORT_ID}
        AND m.direction = 'inbound'
        AND EXISTS (
          SELECT 1
          FROM message o
          WHERE o.thread_id = m.thread_id
            AND o.direction = 'outbound'
            AND coalesce(o.received_at, o.sent_at, o.created_at)
              >= coalesce(m.received_at, m.sent_at, m.created_at)
        )
      ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) DESC
      LIMIT ${limit}
    `;

    const pairs = [];
    for (const inbound of inbounds) {
      const msgs = await sql<{
        id: string;
        direction: 'inbound' | 'outbound';
        transport_id: string | null;
        created_at: string;
        subject: string | null;
      }[]>`
        SELECT
          m.id,
          m.direction,
          m.transport_id,
          coalesce(m.received_at, m.sent_at, m.created_at)::text AS created_at,
          m.subject
        FROM message m
        WHERE m.thread_id = ${inbound.thread_id}
        ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) ASC, m.id ASC
      `;
      pairs.push(
        pairCenturionGold({
          threadId: inbound.thread_id,
          inboundMessageId: inbound.id,
          messages: msgs.map((m) => ({
            id: m.id,
            direction: m.direction,
            transportId: m.transport_id,
            createdAt: m.created_at,
            subject: m.subject,
          })),
        }),
      );
    }
    return pairs;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function draftForPair() {
  return renderOfflineBracketDraft({
    opening: 'Thank you for your email. We are preparing a reply.',
    unresolved: [
      { need: 'confirmation number', acquisition: 'hms_find_reservation' },
      { need: 'stay quote / availability', acquisition: 'hms_quote_stay' },
      { need: 'folio / deposit summary', acquisition: 'hms_read_folio' },
      {
        need: 'company billing terms',
        acquisition: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
      },
    ],
  });
}

async function main(): Promise<void> {
  const selfPath = fileURLToPath(import.meta.url);
  const serverRoot = join(dirname(selfPath), '..');
  assertBacktestSourceSafe(readFileSync(selfPath, 'utf8'));
  assertBacktestSourceSafe(
    readFileSync(join(serverRoot, 'src/ai/draft-backtest.ts'), 'utf8'),
  );

  const { limit, runId, offline, root } = parseArgs(process.argv.slice(2));
  const already = loadScoredHashes(root, runId);
  const pairs = (
    offline ? offlineFixturePairs(limit) : await loadLivePairs(limit, serverRoot)
  ).filter((p) => !already.has(p.inboundMessageIdHash));

  const records: DraftEvalRecord[] = [];
  for (const pair of pairs) {
    const { textBody, bracketLines } = draftForPair();
    const failureClasses = scoreDraftAgainstEvidence({
      draftText: textBody,
      evidenceTokens: [],
      bracketLines,
      goldKind: pair.goldKind,
    });
    const record: DraftEvalRecord = {
      runId,
      inboundMessageIdHash: pair.inboundMessageIdHash,
      threadIdHash: hashOpaqueId(pair.threadId),
      goldKind: pair.goldKind,
      draftText: textBody,
      evidenceTokens: [],
      bracketLines,
      failureClasses,
      scoredAt: new Date().toISOString(),
    };
    appendEvalRecord(root, runId, record);
    records.push(record);
  }

  const card = aggregateRecords(runId, records);
  writeScorecard(root, runId, card);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: offline ? 'offline-fixtures' : 'live-corpus',
        runId,
        root,
        corpusFingerprint: createHash('sha256')
          .update(pairs.map((p) => p.inboundMessageIdHash).join(','))
          .digest('hex')
          .slice(0, 16),
        ...card,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
