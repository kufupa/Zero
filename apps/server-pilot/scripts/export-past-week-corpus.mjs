import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const postgres = (await import('postgres')).default;
const sql = postgres(url, { ssl: sslOptions(), max: 2 });

const TRANSPORT_ID = 'transport-centurion';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/tmp/past-week-corpus-2026-08-31-to-09-07.json';

async function main() {
  console.log('=== EXPORTING PAST WEEK INBOUND CORPUS (2026-08-31 to 2026-09-07) ===');

  // Step 1: Identify all threads with inbound messages in the target week
  const targetThreads = await sql`
    WITH latest_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        coalesce(m.received_at, m.created_at) AS inbound_at
      FROM message m
      WHERE m.transport_id = ${TRANSPORT_ID}
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
    )
    SELECT
      thread_id,
      inbound_at
    FROM latest_inbound
    WHERE inbound_at >= '2026-08-31T00:00:00Z'
      AND inbound_at <= '2026-09-07T23:59:59.999Z'
    ORDER BY inbound_at ASC
  `;

  console.log(`Identified ${targetThreads.length} target threads.`);

  const threadIds = targetThreads.map((t) => t.thread_id);

  // Step 2: Fetch thread metadata and categories
  const threadRows = await sql`
    WITH cats AS (
      SELECT
        mtc.thread_id,
        array_agg(mc.slug ORDER BY mc.slug) AS slugs
      FROM mail_thread_category mtc
      JOIN mail_category mc ON mc.id = mtc.category_id
      WHERE mc.transport_id = ${TRANSPORT_ID}
        AND mc.is_active = true
        AND mtc.thread_id = ANY(${threadIds})
      GROUP BY mtc.thread_id
    ),
    latest_run AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        metrics,
        state,
        created_at AS run_at
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
        AND thread_id = ANY(${threadIds})
      ORDER BY thread_id, created_at DESC
    )
    SELECT
      t.id,
      t.subject,
      t.snippet,
      t.is_read,
      t.spam_at,
      t.spam_user_locked_at,
      t.latest_message_at,
      t.created_at,
      c.slugs AS category_slugs,
      lr.run_id,
      lr.metrics AS run_metrics,
      lr.run_at
    FROM mail_thread t
    LEFT JOIN cats c ON c.thread_id = t.id
    LEFT JOIN latest_run lr ON lr.thread_id = t.id
    WHERE t.id = ANY(${threadIds})
  `;

  const threadMap = new Map();
  for (const r of threadRows) {
    threadMap.set(r.id, r);
  }

  // Step 3: Fetch all messages for these threads
  console.log('Fetching messages for all threads...');
  const messages = await sql`
    SELECT
      m.id,
      m.thread_id,
      m.direction,
      m.from_address,
      m.to_addresses,
      m.cc_addresses,
      m.bcc_addresses,
      m.subject,
      m.text_body,
      m.html_body,
      coalesce(m.received_at, m.sent_at, m.created_at) AS message_at,
      m.created_at
    FROM message m
    WHERE m.thread_id = ANY(${threadIds})
    ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) ASC, m.id ASC
  `;

  console.log(`Fetched ${messages.length} messages.`);

  const messagesByThread = new Map();
  for (const m of messages) {
    if (!messagesByThread.has(m.thread_id)) {
      messagesByThread.set(m.thread_id, []);
    }
    messagesByThread.get(m.thread_id).push(m);
  }

  // Step 4: Assemble complete thread records
  const exportData = [];
  for (const t of targetThreads) {
    const meta = threadMap.get(t.thread_id);
    const threadMsgs = messagesByThread.get(t.thread_id) || [];
    const latestInbound = [...threadMsgs].reverse().find((m) => m.direction === 'inbound') || threadMsgs[threadMsgs.length - 1];

    const rawAI = meta?.run_metrics?.rawOutput || meta?.run_metrics?.canonicalOutput || null;
    const refinedAI = meta?.run_metrics?.refinedOutput || meta?.run_metrics?.output || null;

    exportData.push({
      threadId: t.thread_id,
      subject: meta?.subject || latestInbound?.subject || '',
      inboundAt: t.inbound_at,
      isRead: meta?.is_read ?? false,
      isSpam: meta?.spam_at != null,
      spamAt: meta?.spam_at,
      categorySlugs: meta?.category_slugs || [],
      messageCount: threadMsgs.length,
      latestInbound: {
        id: latestInbound?.id,
        from: latestInbound?.from_address,
        to: latestInbound?.to_addresses,
        cc: latestInbound?.cc_addresses,
        subject: latestInbound?.subject,
        textBody: latestInbound?.text_body || '',
        receivedAt: latestInbound?.message_at,
      },
      messages: threadMsgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        from: m.from_address,
        to: m.to_addresses,
        cc: m.cc_addresses,
        subject: m.subject,
        textBody: m.text_body || '',
        messageAt: m.message_at,
      })),
      aiRun: {
        runId: meta?.run_id,
        runAt: meta?.run_at,
        raw: rawAI,
        refined: refinedAI,
      },
    });
  }

  console.log(`Writing ${exportData.length} threads to ${OUTPUT_FILE}...`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`Export complete: ${OUTPUT_FILE} (${(fs.statSync(OUTPUT_FILE).size / (1024 * 1024)).toFixed(2)} MB)`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
