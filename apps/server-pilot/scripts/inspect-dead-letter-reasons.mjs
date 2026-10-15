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
  const deadLetters = await sql`
    SELECT
      split_part(idempotency_key, ':', 1) AS prefix,
      count(*)::int AS count,
      min(created_at) AS earliest,
      max(created_at) AS latest,
      left(last_error, 120) AS err_sample
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND state = 'dead_letter'
    GROUP BY 1, 5
    ORDER BY count DESC;
  `;
  console.log('Dead letter runs breakdown:');
  console.table(deadLetters);
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
