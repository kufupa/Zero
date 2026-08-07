#!/usr/bin/env npx tsx
/**
 * Centurion draft backtest CLI (eval-only).
 * Modes:
 *   --offline-fixtures  synthetic pairs (laptop-safe)
 *   --live-corpus       read-only SELECT on DATABASE_URL (EC2; no Vitest)
 *
 * Draft modes:
 *   --draft signals (default) | claim-safe-stub
 *
 * No SMTP. No HMS mutation. No product draft promote. Concurrency=1.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  draftClaimSafeStub,
  draftSignalsOnly,
  type BacktestDraftMode,
} from '../src/ai/draft-backtest-agent.js';
import {
  aggregateRecords,
  appendEvalRecord,
  assertBacktestSourceSafe,
  CENTURION_TRANSPORT_ID,
  compareDraftToGold,
  hashOpaqueId,
  loadScoredHashes,
  pairCenturionGold,
  scoreDraftAgainstEvidence,
  writeScorecard,
  type CorpusPair,
  type DraftEvalRecord,
} from '../src/ai/draft-backtest.js';

function parseArgs(argv: string[]) {
  let limit = 25;
  let runId = randomUUID();
  let offline = false;
  let live = false;
  let draftMode: BacktestDraftMode = 'signals';
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
    else if (a === '--draft') {
      const v = String(argv[++i]);
      if (v !== 'signals' && v !== 'claim-safe-stub') {
        throw new Error('--draft must be signals|claim-safe-stub');
      }
      draftMode = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: run-centurion-draft-backtest.ts (--offline-fixtures|--live-corpus) [--limit N] [--run-id ID] [--root DIR] [--draft signals|claim-safe-stub]',
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
  return { limit, runId, offline, live, root, draftMode };
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

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function messagePlainText(row: {
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
}): string {
  const body =
    (row.text_body?.trim() || '') ||
    (row.html_body ? stripHtmlToText(row.html_body) : '');
  return [row.subject?.trim() ?? '', body]
    .filter(Boolean)
    .join('\n')
    .slice(0, 12_000);
}

type LivePairBundle = {
  pair: CorpusPair;
  inboundText: string;
  goldText: string | null;
};

async function loadLivePairs(
  limit: number,
  serverRoot: string,
): Promise<LivePairBundle[]> {
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

    const bundles: LivePairBundle[] = [];
    for (const inbound of inbounds) {
      const msgs = await sql<{
        id: string;
        direction: 'inbound' | 'outbound';
        transport_id: string | null;
        created_at: string;
        subject: string | null;
        text_body: string | null;
        html_body: string | null;
      }[]>`
        SELECT
          m.id,
          m.direction,
          m.transport_id,
          coalesce(m.received_at, m.sent_at, m.created_at)::text AS created_at,
          m.subject,
          m.text_body,
          m.html_body
        FROM message m
        WHERE m.thread_id = ${inbound.thread_id}
        ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) ASC, m.id ASC
      `;
      const pair = pairCenturionGold({
        threadId: inbound.thread_id,
        inboundMessageId: inbound.id,
        messages: msgs.map((m) => ({
          id: m.id,
          direction: m.direction,
          transportId: m.transport_id,
          createdAt: m.created_at,
          subject: m.subject,
        })),
      });
      const inboundRow = msgs.find((m) => m.id === inbound.id);
      const goldRow = pair.goldOutboundMessageId
        ? msgs.find((m) => m.id === pair.goldOutboundMessageId)
        : undefined;
      bundles.push({
        pair,
        inboundText: inboundRow ? messagePlainText(inboundRow) : '',
        goldText: goldRow ? messagePlainText(goldRow) : null,
      });
    }
    return bundles;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function draftForBundle(
  mode: BacktestDraftMode,
  inboundText: string,
  signal: AbortSignal,
) {
  if (mode === 'claim-safe-stub') {
    return draftClaimSafeStub({ inboundText, signal });
  }
  return draftSignalsOnly(inboundText);
}

async function main(): Promise<void> {
  const selfPath = fileURLToPath(import.meta.url);
  const serverRoot = join(dirname(selfPath), '..');
  assertBacktestSourceSafe(readFileSync(selfPath, 'utf8'));
  assertBacktestSourceSafe(
    readFileSync(join(serverRoot, 'src/ai/draft-backtest.ts'), 'utf8'),
  );
  assertBacktestSourceSafe(
    readFileSync(join(serverRoot, 'src/ai/draft-backtest-agent.ts'), 'utf8'),
  );

  const { limit, runId, offline, root, draftMode } = parseArgs(
    process.argv.slice(2),
  );
  const already = loadScoredHashes(root, runId);
  const ac = new AbortController();

  const bundles: LivePairBundle[] = offline
    ? offlineFixturePairs(limit).map((pair, i) => ({
        pair,
        inboundText: `Please confirm booking CONF-OFF${i} for 2026-09-0${(i % 9) + 1}.`,
        goldText:
          pair.goldKind === 'no_gold_reply'
            ? null
            : `Re: booking CONF-OFF${i} confirmed for 2026-09-0${(i % 9) + 1}. Rate ZAR 1200.`,
      }))
    : await loadLivePairs(limit, serverRoot);

  const pending = bundles.filter(
    (b) => !already.has(b.pair.inboundMessageIdHash),
  );

  const records: DraftEvalRecord[] = [];
  for (const bundle of pending) {
    const drafted = await draftForBundle(
      draftMode,
      bundle.inboundText,
      ac.signal,
    );
    const goldCompare = bundle.goldText
      ? compareDraftToGold({
          draftText: drafted.textBody,
          goldText: bundle.goldText,
          bracketLines: drafted.bracketLines,
        })
      : null;
    const failureClasses = scoreDraftAgainstEvidence({
      draftText: drafted.textBody,
      evidenceTokens: drafted.evidenceTokens,
      bracketLines: drafted.bracketLines,
      goldKind: bundle.pair.goldKind,
      goldCriticalCoverage: goldCompare?.goldCriticalCoverage,
    });
    const record: DraftEvalRecord = {
      runId,
      inboundMessageIdHash: bundle.pair.inboundMessageIdHash,
      threadIdHash: hashOpaqueId(bundle.pair.threadId),
      goldKind: bundle.pair.goldKind,
      draftText: drafted.textBody.slice(0, 4_000),
      evidenceTokens: drafted.evidenceTokens,
      bracketLines: drafted.bracketLines,
      failureClasses,
      scoredAt: new Date().toISOString(),
      goldCriticalCoverage: goldCompare?.goldCriticalCoverage,
      softWordOverlap: goldCompare?.softWordOverlap,
      draftMode: drafted.draftMode,
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
        draftMode,
        runId,
        root,
        corpusFingerprint: createHash('sha256')
          .update(pending.map((b) => b.pair.inboundMessageIdHash).join(','))
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
