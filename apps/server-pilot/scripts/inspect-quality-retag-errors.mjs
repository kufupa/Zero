/**
 * Ops helper: summarize quality KEY_PREFIX run outcomes (no PII bodies).
 *   node scripts/inspect-quality-retag-errors.mjs [key-prefix]
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
    select state, last_error, metrics
    from ai_workflow_run
    where idempotency_key like ${prefix + ':%'}
    order by created_at desc
    limit 40
  `;
  const errBuckets = {};
  const samples = [];
  for (const r of rows) {
    const err = String(r.last_error ?? '').split('\n')[0].slice(0, 160) || '(empty)';
    errBuckets[err] = (errBuckets[err] || 0) + 1;
    if (samples.length < 10) {
      samples.push({
        state: r.state,
        err,
        primaryFolder: r.metrics?.primaryFolder ?? null,
        isSpam: r.metrics?.isSpam ?? null,
        policyFlags: r.metrics?.policyFlags ?? null,
        retagPending: r.metrics?.retagPending ?? null,
      });
    }
  }
  console.log(JSON.stringify({ keyPrefix: prefix, errBuckets, samples }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
