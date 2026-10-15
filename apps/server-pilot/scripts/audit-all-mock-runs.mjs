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
  console.log('=== AUDITING ENTIRE RDS DATABASE FOR MOCK RUNS ===');

  // 1. Total threads
  const totalThreads = await sql`
    SELECT count(*)::int AS count FROM mail_thread WHERE transport_id = ${TRANSPORT_ID}
  `;
  console.log(`Total threads in DB: ${totalThreads[0].count}`);

  // 2. Breakdown of latest AI run per thread across the entire DB
  const runBreakdown = await sql`
    WITH latest_runs AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        metrics,
        state,
        created_at,
        (metrics->'rawOutput'->>'rationale') AS raw_rationale,
        (metrics->'usage'->>'latencyMs')::int AS latency_ms,
        (metrics->'rawOutput'->>'primaryFolder') AS raw_primary
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    )
    SELECT
      count(*)::int AS total_with_runs,
      count(CASE WHEN raw_rationale IN (
        'Guest booking inquiry',
        'Group quote language',
        'Internal ops handover',
        'Spam offer',
        'Baseline legacy triage.',
        'Ops automation',
        'At-risk recovery'
      ) OR latency_ms = 15 THEN 1 END)::int AS mock_runs_count,
      count(CASE WHEN NOT (raw_rationale IN (
        'Guest booking inquiry',
        'Group quote language',
        'Internal ops handover',
        'Spam offer',
        'Baseline legacy triage.',
        'Ops automation',
        'At-risk recovery'
      ) OR latency_ms = 15) AND raw_rationale IS NOT NULL THEN 1 END)::int AS real_bedrock_count,
      count(CASE WHEN raw_rationale IS NULL THEN 1 END)::int AS null_rationale_count
    FROM latest_runs
  `;
  console.log('Latest Run Breakdown across entire DB:', runBreakdown[0]);

  // 3. Threads with NO AI run at all
  const threadsNoRuns = await sql`
    SELECT count(*)::int AS count
    FROM mail_thread t
    WHERE t.transport_id = ${TRANSPORT_ID}
      AND NOT EXISTS (
        SELECT 1 FROM ai_workflow_run r
        WHERE r.thread_id = t.id AND r.run_kind = 'inbound_triage'
      )
  `;
  console.log('Threads with NO AI run at all:', threadsNoRuns[0].count);

  // 4. Distribution of mock runs by rationale
  const mockRationales = await sql`
    WITH latest_runs AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        metrics,
        (metrics->'rawOutput'->>'rationale') AS raw_rationale,
        (metrics->'usage'->>'latencyMs')::int AS latency_ms,
        created_at
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    )
    SELECT
      coalesce(raw_rationale, 'NULL/NO_RATIONALE') AS rationale,
      count(*)::int AS count,
      min(created_at) AS first_run,
      max(created_at) AS last_run
    FROM latest_runs
    WHERE raw_rationale IN (
      'Guest booking inquiry',
      'Group quote language',
      'Internal ops handover',
      'Spam offer',
      'Baseline legacy triage.',
      'Ops automation',
      'At-risk recovery'
    ) OR latency_ms = 15
    GROUP BY raw_rationale
    ORDER BY count DESC
  `;
  console.log('\nMock Runs Breakdown by Rationale:');
  console.table(mockRationales);

  // 5. Which folders are these mock runs currently sitting in?
  const mockFolders = await sql`
    WITH latest_runs AS (
      SELECT DISTINCT ON (thread_id)
        id AS run_id,
        thread_id,
        metrics,
        (metrics->'rawOutput'->>'rationale') AS raw_rationale,
        (metrics->'usage'->>'latencyMs')::int AS latency_ms
      FROM ai_workflow_run
      WHERE transport_id = ${TRANSPORT_ID}
        AND run_kind = 'inbound_triage'
      ORDER BY thread_id, created_at DESC
    ),
    mock_threads AS (
      SELECT thread_id
      FROM latest_runs
      WHERE raw_rationale IN (
        'Guest booking inquiry',
        'Group quote language',
        'Internal ops handover',
        'Spam offer',
        'Baseline legacy triage.',
        'Ops automation',
        'At-risk recovery'
      ) OR latency_ms = 15
    )
    SELECT
      coalesce(mc.slug, 'NO_CATEGORY') AS current_folder,
      count(DISTINCT mt.thread_id)::int AS count
    FROM mock_threads mt
    LEFT JOIN mail_thread_category mtc ON mtc.thread_id = mt.thread_id
    LEFT JOIN mail_category mc ON mc.id = mtc.category_id AND mc.is_active = true
    GROUP BY mc.slug
    ORDER BY count DESC
  `;
  console.log('\nCurrent Folders of Mock Run Threads:');
  console.table(mockFolders);

  // 6. How many threads have inbound messages vs outbound only?
  const inboundCount = await sql`
    SELECT count(DISTINCT thread_id)::int AS count
    FROM message
    WHERE transport_id = ${TRANSPORT_ID} AND direction = 'inbound'
  `;
  console.log(`\nThreads with at least 1 inbound message: ${inboundCount[0].count}`);

  // 7. Check the live ingestion pipeline: Is live triage currently using real Bedrock or fake?
  const latest10Runs = await sql`
    SELECT
      id,
      thread_id,
      created_at,
      state,
      (metrics->'usage'->>'latencyMs')::int AS latency_ms,
      (metrics->'rawOutput'->>'rationale') AS rationale,
      (metrics->'rawOutput'->>'primaryFolder') AS primary_folder
    FROM ai_workflow_run
    WHERE transport_id = ${TRANSPORT_ID}
      AND run_kind = 'inbound_triage'
    ORDER BY created_at DESC
    LIMIT 10
  `;
  console.log('\nLatest 10 Inbound Triage Runs on RDS:');
  console.table(latest10Runs);

  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
