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
  console.log('=== CHECKING LABELS ON ARCHIVED THREADS ===');

  const labelStats = await sql`
    SELECT
      count(*) FILTER (WHERE label_ids IS NULL OR jsonb_array_length(label_ids) = 0)::int as no_labels,
      count(*) FILTER (WHERE label_ids IS NOT NULL AND jsonb_array_length(label_ids) > 0)::int as has_labels
    FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
      AND is_archived = true
      AND trashed_at IS NULL
      AND spam_at IS NULL
  `;
  console.table(labelStats);

  // If has labels, which labels?
  const topLabels = await sql`
    SELECT
      l.name,
      count(*)::int as count
    FROM mail_thread t,
    LATERAL jsonb_array_elements_text(t.label_ids) as lid
    JOIN mail_label l ON l.id = lid
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND t.is_archived = true
      AND t.trashed_at IS NULL
      AND t.spam_at IS NULL
    GROUP BY l.name
    ORDER BY count DESC
    LIMIT 20
  `;
  console.log('Top labels on archived threads:');
  console.table(topLabels);

  // How were these threads updated? When were they marked archived?
  const createDates = await sql`
    SELECT
      date_trunc('day', created_at) as create_day,
      count(*)::int as count
    FROM mail_thread
    WHERE transport_id = ${TRANSPORT_ID}
      AND is_archived = true
      AND trashed_at IS NULL
      AND spam_at IS NULL
    GROUP BY create_day
    ORDER BY count DESC
    LIMIT 10
  `;
  console.log('Top create days:');
  console.table(createDates);

  await sql.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
