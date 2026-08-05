#!/usr/bin/env node
/**
 * Read-only: Centurion threads + durable categories + latest triage + body snip.
 * Usage: node scripts/dump-centurion-full-triage-audit.mjs [--out /tmp/out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let out = '/tmp/centurion-full-triage-audit.json';
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
  const rows = await sql`
    WITH latest_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        m.id AS message_id,
        m.subject,
        m.from_address,
        left(coalesce(m.text_body, ''), 800) AS body_snip,
        coalesce(m.received_at, m.sent_at, m.created_at) AS ts
      FROM message m
      WHERE m.transport_id = 'transport-centurion'
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
    ),
    first_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        m.subject AS first_subject,
        m.from_address AS first_from
      FROM message m
      WHERE m.transport_id = 'transport-centurion'
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) ASC NULLS LAST, m.id ASC
    ),
    cats AS (
      SELECT mtc.thread_id,
             array_agg(mc.slug ORDER BY mc.slug) AS slugs
      FROM mail_thread_category mtc
      JOIN mail_category mc ON mc.id = mtc.category_id
      WHERE mc.transport_id = 'transport-centurion'
        AND mc.is_active = true
      GROUP BY mtc.thread_id
    ),
    triage AS (
      SELECT DISTINCT ON (thread_id)
        thread_id,
        metrics->>'category' AS triage_category,
        metrics->>'urgent' AS triage_urgent,
        (metrics->>'confidence')::float AS confidence,
        metrics->>'rationale' AS rationale,
        state AS triage_state,
        created_at AS triage_at
      FROM ai_workflow_run
      WHERE run_kind = 'inbound_triage'
        AND transport_id = 'transport-centurion'
      ORDER BY thread_id, created_at DESC
    ),
    msg_counts AS (
      SELECT thread_id,
             count(*)::int AS msg_count,
             count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_count,
             count(*) FILTER (WHERE direction = 'outbound')::int AS outbound_count
      FROM message
      WHERE transport_id = 'transport-centurion'
      GROUP BY thread_id
    )
    SELECT
      t.id AS thread_id,
      t.spam_at IS NOT NULL AS is_spam,
      t.spam_user_locked_at IS NOT NULL AS spam_locked,
      c.slugs AS category_slugs,
      tr.triage_category,
      tr.triage_urgent,
      tr.confidence,
      tr.rationale,
      tr.triage_state,
      tr.triage_at,
      mc.msg_count,
      mc.inbound_count,
      mc.outbound_count,
      li.subject,
      li.from_address,
      li.body_snip,
      li.ts AS latest_inbound_at,
      fi.first_subject,
      fi.first_from
    FROM mail_thread t
    LEFT JOIN cats c ON c.thread_id = t.id
    LEFT JOIN triage tr ON tr.thread_id = t.id
    LEFT JOIN msg_counts mc ON mc.thread_id = t.id
    LEFT JOIN latest_inbound li ON li.thread_id = t.id
    LEFT JOIN first_inbound fi ON fi.thread_id = t.id
    WHERE t.transport_id = 'transport-centurion'
    ORDER BY li.ts ASC NULLS LAST, t.id
  `;

  const threads = rows.map((r) => ({
    threadId: r.thread_id,
    isSpam: Boolean(r.is_spam),
    spamLocked: Boolean(r.spam_locked),
    categorySlugs: r.category_slugs || [],
    triageCategory: r.triage_category,
    triageUrgent: r.triage_urgent === 'true' || r.triage_urgent === true,
    confidence: r.confidence,
    rationale: r.rationale,
    triageState: r.triage_state,
    msgCount: r.msg_count,
    inboundCount: r.inbound_count,
    outboundCount: r.outbound_count,
    subject: r.subject,
    from: r.from_address,
    bodySnip: r.body_snip,
    latestInboundAt: r.latest_inbound_at,
    firstSubject: r.first_subject,
    firstFrom: r.first_from,
  }));

  const hist = {};
  for (const t of threads) {
    let k = 'no_triage';
    if (t.isSpam) k = 'spam';
    else if (t.triageCategory) k = t.triageCategory;
    else if ((t.inboundCount || 0) === 0) k = 'outbound_only';
    hist[k] = (hist[k] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    count: threads.length,
    histogram: hist,
    threads,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, count: report.count, histogram: hist }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
