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
  console.log('=== WORKFLOW RUN HISTORY & DEAD LETTERS AUDIT ===');

  // Prefix breakdown
  const prefixes = await sql`
    SELECT
      split_part(idempotency_key, ':', 1) AS prefix,
      state,
      count(*)::int AS count
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND run_kind = 'inbound_triage'
    GROUP BY 1, 2
    ORDER BY count DESC
  `;
  console.log('\n--- Idempotency Key Prefixes & States ---');
  console.table(prefixes);

  // Dead letters details
  const deadLetters = await sql`
    SELECT
      id,
      thread_id,
      idempotency_key,
      last_error,
      attempts,
      created_at,
      finished_at
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND state = 'dead_letter'
    ORDER BY coalesce(finished_at, created_at) DESC
    LIMIT 10
  `;
  console.log('\n--- Dead Letter Samples ---');
  console.table(deadLetters.map(d => ({
    id: d.id,
    key: d.idempotency_key?.slice(0, 40),
    error: (d.last_error || '').split('\n')[0].slice(0, 80),
    attempts: d.attempts,
    finished_at: d.finished_at
  })));

  // When were the real Bedrock runs created?
  const realRunTimeline = await sql`
    SELECT
      date_trunc('day', created_at) AS run_day,
      count(*)::int AS count,
      avg((metrics->'usage'->>'latencyMs')::int)::int AS avg_latency_ms
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND run_kind = 'inbound_triage'
      AND (metrics->'usage'->>'latencyMs')::int > 50
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  console.log('\n--- Real Bedrock Runs Timeline (latency > 50ms) ---');
  console.table(realRunTimeline);

  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
