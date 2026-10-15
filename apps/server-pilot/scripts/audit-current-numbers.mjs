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

async function main() {
  console.log('=== RDS CURRENT CATEGORY COUNTS (ALL TIME) ===');
  const allCats = await sql`
    SELECT
      mc.slug,
      count(DISTINCT mtc.thread_id)::int AS total_threads,
      count(DISTINCT CASE WHEN NOT t.is_read THEN mtc.thread_id END)::int AS unread_threads
    FROM mail_category mc
    LEFT JOIN mail_thread_category mtc ON mtc.category_id = mc.id
    LEFT JOIN mail_thread t ON t.id = mtc.thread_id
    WHERE mc.transport_id = ${TRANSPORT_ID}
      AND mc.is_active = true
    GROUP BY mc.slug
    ORDER BY total_threads DESC
  `;
  console.table(allCats);

  const spam = await sql`
    SELECT
      count(*)::int AS total_spam,
      count(CASE WHEN NOT is_read THEN 1 END)::int AS unread_spam
    FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
      AND spam_at IS NOT NULL
  `;
  console.log('Spam table counts:', spam[0]);

  const totalThreads = await sql`
    SELECT count(*)::int AS total FROM mail_thread WHERE transport_id = ${TRANSPORT_ID}
  `;
  console.log('Total threads in DB:', totalThreads[0].total);

  console.log('\n=== RDS PAST WEEK INBOUND THREADS (2026-08-31 to 2026-09-07) ===');
  const weekRange = await sql`
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
      count(*)::int AS thread_count,
      min(inbound_at) AS min_date,
      max(inbound_at) AS max_date
    FROM latest_inbound
    WHERE inbound_at >= '2026-08-31T00:00:00Z'
      AND inbound_at <= '2026-09-07T23:59:59.999Z'
  `;
  console.log('Week inbound thread count:', weekRange[0]);

  // Breakdown of categories for past week
  const weekCats = await sql`
    WITH latest_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        coalesce(m.received_at, m.created_at) AS inbound_at
      FROM message m
      WHERE m.transport_id = ${TRANSPORT_ID}
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
    ),
    target_threads AS (
      SELECT thread_id
      FROM latest_inbound
      WHERE inbound_at >= '2026-08-31T00:00:00Z'
        AND inbound_at <= '2026-09-07T23:59:59.999Z'
    )
    SELECT
      mc.slug,
      count(DISTINCT mtc.thread_id)::int AS count
    FROM target_threads tt
    JOIN mail_thread_category mtc ON mtc.thread_id = tt.thread_id
    JOIN mail_category mc ON mc.id = mtc.category_id
    WHERE mc.transport_id = ${TRANSPORT_ID}
      AND mc.is_active = true
    GROUP BY mc.slug
    ORDER BY count DESC
  `;
  console.log('\n=== PAST WEEK THREADS BY CATEGORY ===');
  console.table(weekCats);

  const weekSpam = await sql`
    WITH latest_inbound AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        coalesce(m.received_at, m.created_at) AS inbound_at
      FROM message m
      WHERE m.transport_id = ${TRANSPORT_ID}
        AND m.direction = 'inbound'
      ORDER BY m.thread_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC NULLS LAST, m.id DESC
    )
    SELECT count(*)::int AS spam_count
    FROM latest_inbound li
    JOIN mail_thread t ON t.id = li.thread_id
    WHERE li.inbound_at >= '2026-08-31T00:00:00Z'
      AND li.inbound_at <= '2026-09-07T23:59:59.999Z'
      AND t.spam_at IS NOT NULL
  `;
  console.log('Past week spam thread count:', weekSpam[0].spam_count);

  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
