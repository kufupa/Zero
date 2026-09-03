/**
 * Ops helper: recent dead_letter last_error samples for a KEY_PREFIX.
 *   node scripts/inspect-quality-retag-dead-letters.mjs [key-prefix]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const prefix =
  process.argv[2] ||
  process.env.KEY_PREFIX ||
  'inbound-triage-retag-v6-quality-202609030122';

const { default: postgres } = await import('postgres');
const ca = path.join(root, 'deploy', 'rds-ca-global.pem');
const sql = postgres(process.env.DATABASE_URL, {
  ssl: fs.existsSync(ca)
    ? { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') }
    : 'require',
  max: 1,
  connect_timeout: 30,
});

try {
  const rows = await sql`
    select state, last_error, finished_at, created_at, attempts
    from ai_workflow_run
    where idempotency_key like ${prefix + ':%'}
      and state = 'dead_letter'
    order by coalesce(finished_at, created_at) desc
    limit 15
  `;
  const buckets = {};
  for (const r of rows) {
    const err = String(r.last_error ?? '').split('\n')[0].slice(0, 160) || '(empty)';
    buckets[err] = (buckets[err] || 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        keyPrefix: prefix,
        recentBuckets: buckets,
        samples: rows.map((r) => ({
          err: String(r.last_error ?? '').slice(0, 200),
          finishedAt: r.finished_at,
          createdAt: r.created_at,
          attempts: r.attempts,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
