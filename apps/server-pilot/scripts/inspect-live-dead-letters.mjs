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
  const samples = await sql`
    SELECT
      id,
      thread_id,
      idempotency_key,
      last_error,
      created_at,
      finished_at
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND state = 'dead_letter'
      AND idempotency_key LIKE 'inbound-triage:%'
    ORDER BY created_at DESC
    LIMIT 5;
  `;
  for (const s of samples) {
    console.log('--- Sample Run ID:', s.id, 'Created:', s.created_at);
    console.log('Key:', s.idempotency_key);
    console.log('Error:', s.last_error);
  }
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
