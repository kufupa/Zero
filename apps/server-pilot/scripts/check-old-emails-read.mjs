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
  console.log('=== CHECKING "Old Emails" THREADS ===');

  const oldEmailsBreakdown = await sql`
    SELECT
      t.is_read,
      count(*)::int as thread_count
    FROM mail_thread t,
    LATERAL jsonb_array_elements_text(t.label_ids) as lid
    JOIN mail_label l ON l.id = lid
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND l.name = 'Old Emails'
    GROUP BY t.is_read
  `;
  console.table(oldEmailsBreakdown);

  // Check overall is_read across all labels on archived threads
  const labelReadBreakdown = await sql`
    SELECT
      l.name,
      count(*)::int as total,
      count(*) FILTER (WHERE NOT t.is_read)::int as unread,
      count(*) FILTER (WHERE t.is_read)::int as read
    FROM mail_thread t,
    LATERAL jsonb_array_elements_text(t.label_ids) as lid
    JOIN mail_label l ON l.id = lid
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
    GROUP BY l.name
    ORDER BY total DESC
    LIMIT 10
  `;
  console.table(labelReadBreakdown);

  // Total threads in the archive view
  const archiveView = await sql`
    SELECT
      count(*)::int as total_threads_in_archive_view,
      count(*) FILTER (WHERE NOT is_read)::int as unread_threads_in_archive_view,
      count(*) FILTER (WHERE is_read)::int as read_threads_in_archive_view
    FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
      AND is_archived = true
      AND trashed_at IS NULL
      AND spam_at IS NULL
  `;
  console.log('Archive View Total vs Unread:');
  console.table(archiveView);

  await sql.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
