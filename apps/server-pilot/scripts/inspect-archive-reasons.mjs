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

const postgres = (await import('postgres')).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: sslOptions() });
const TRANSPORT_ID = 'transport-centurion';

async function run() {
  console.log('=== INSPECTING ARCHIVED THREADS ===');

  // 1. Check updated_at, created_at, and message date ranges for archived threads
  const timeRanges = await sql`
    SELECT
      min(t.created_at) as min_thread_created,
      max(t.created_at) as max_thread_created,
      min(t.updated_at) as min_thread_updated,
      max(t.updated_at) as max_thread_updated,
      min(t.latest_message_at) as min_last_msg,
      max(t.latest_message_at) as max_last_msg
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
  `;
  console.log('Time ranges of archived threads:');
  console.table(timeRanges);

  // 2. Check how many archived threads have inbound vs outbound messages
  const directionDist = await sql`
    SELECT
      count(DISTINCT t.id)::int as total_archived_threads,
      count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.direction = 'inbound') THEN t.id END)::int as has_inbound,
      count(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.direction = 'inbound') THEN t.id END)::int as outbound_only
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
  `;
  console.log('Archived thread direction distribution:');
  console.table(directionDist);

  // 3. Sample 5 archived threads (subject, snippet, senders, created_at, updated_at)
  const samples = await sql`
    SELECT
      t.id,
      left(t.subject, 40) as subject,
      t.is_read,
      t.created_at,
      t.updated_at,
      t.latest_message_at
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
    ORDER BY t.latest_message_at DESC NULLS LAST
    LIMIT 5
  `;
  console.log('Sample 5 archived threads:');
  console.table(samples);

  // 4. Check if there are audit logs or workflow runs on these archived threads
  const runsOnArchived = await sql`
    SELECT
      count(DISTINCT t.id)::int as archived_with_ai_runs
    FROM mail_thread t
    JOIN ai_workflow_run r ON r.thread_id = t.id
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
  `;
  console.log('Archived threads with AI workflow runs:');
  console.table(runsOnArchived);

  // 5. Check categories assigned to archived threads
  const archivedCategories = await sql`
    SELECT
      coalesce(mc.slug, 'NO_CATEGORY') as category_slug,
      count(DISTINCT t.id)::int as thread_count
    FROM mail_thread t
    LEFT JOIN mail_thread_category mtc ON mtc.thread_id = t.id
    LEFT JOIN mail_category mc ON mc.id = mtc.category_id AND mc.is_active = true
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
    GROUP BY mc.slug
    ORDER BY thread_count DESC
  `;
  console.log('Categories of archived threads:');
  console.table(archivedCategories);

  // 6. Check unread breakdown of archived threads
  const unreadBreakdown = await sql`
    SELECT
      t.is_read,
      count(*)::int as thread_count
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
    GROUP BY t.is_read
  `;
  console.log('Unread status in archive folder:');
  console.table(unreadBreakdown);

  await sql.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
