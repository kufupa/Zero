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
  const rows = await sql`
    WITH latest_runs AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        state,
        metrics,
        last_error,
        created_at,
        (metrics->'rawOutput'->>'rationale') AS raw_rationale
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    )
    SELECT 
      state, 
      count(*)::int AS count, 
      min(created_at) AS earliest, 
      max(created_at) AS latest,
      (array_agg(last_error))[1] AS sample_err
    FROM latest_runs
    WHERE raw_rationale IS NULL
    GROUP BY state;
  `;
  console.log('Null rationale breakdown:');
  console.table(rows);
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
