#!/usr/bin/env node
/**
 * Read-only: Centurion spam_at + latest inbound_triage metrics per thread.
 * Usage: node scripts/dump-centurion-spam-audit.mjs [--out /tmp/out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let out = '/tmp/centurion-spam-audit.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
  }
  return { out };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

const { out } = parseArgs(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });

try {
  const threads = await sql`
    SELECT
      t.id AS thread_id,
      t.spam_at,
      t.spam_user_locked_at,
      (
        SELECT m.from_address
        FROM message m
        WHERE m.thread_id = t.id
        ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) ASC NULLS LAST, m.id ASC
        LIMIT 1
      ) AS first_from,
      (
        SELECT m.subject
        FROM message m
        WHERE m.thread_id = t.id
        ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) ASC NULLS LAST, m.id ASC
        LIMIT 1
      ) AS first_subject,
      (
        SELECT count(*)::int FROM message m WHERE m.thread_id = t.id
      ) AS msg_count
    FROM mail_thread t
    WHERE t.transport_id = 'transport-centurion'
    ORDER BY t.id
  `;

  const triage = await sql`
    SELECT DISTINCT ON (thread_id)
      thread_id,
      metrics->'canonicalOutput'->>'primaryFolder' AS primary_folder,
      metrics->'canonicalOutput'->>'priority' AS priority,
      metrics->'canonicalOutput'->>'urgent' AS urgent,
      metrics->'canonicalOutput'->>'isSpam' AS is_spam,
      metrics->>'applyMode' AS apply_mode,
      metrics->>'durableWrite' AS durable_write,
      metrics->'canonicalOutput'->>'confidence' AS confidence,
      state,
      created_at
    FROM ai_workflow_run
    WHERE run_kind = 'inbound_triage'
      AND transport_id = 'transport-centurion'
    ORDER BY thread_id, created_at DESC
  `;

  const triageByTid = new Map(triage.map((r) => [r.thread_id, r]));
  const joined = threads.map((t) => {
    const tr = triageByTid.get(t.thread_id) || null;
    return {
      threadId: t.thread_id,
      spamAt: t.spam_at ? new Date(t.spam_at).toISOString() : null,
      spamUserLockedAt: t.spam_user_locked_at
        ? new Date(t.spam_user_locked_at).toISOString()
        : null,
      firstFrom: t.first_from,
      firstSubject: t.first_subject,
      msgCount: t.msg_count,
      triage: tr
        ? {
            category: tr.primary_folder,
            primaryFolder: tr.primary_folder,
            priority: tr.priority,
            urgent: tr.urgent === 'true',
            isSpam: tr.is_spam === 'true',
            applyMode: tr.apply_mode,
            durableWrite: tr.durable_write,
            confidence: tr.confidence,
            state: tr.state,
            createdAt: tr.created_at ? new Date(tr.created_at).toISOString() : null,
          }
        : null,
    };
  });

  const spamThreads = joined.filter((t) => t.spamAt);
  const catCounts = {};
  for (const t of joined) {
    const c = t.triage?.category || (t.triage ? 'unknown' : 'no_triage');
    catCounts[c] = (catCounts[c] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    transportId: 'transport-centurion',
    threadCount: joined.length,
    spamThreadCount: spamThreads.length,
    categoryCounts: catCounts,
    triageRunCount: triage.length,
    spamThreads,
    allThreads: joined,
  };

  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      out,
      threadCount: report.threadCount,
      spamThreadCount: report.spamThreadCount,
      categoryCounts: report.categoryCounts,
      bytes: Buffer.byteLength(JSON.stringify(report), 'utf8'),
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
