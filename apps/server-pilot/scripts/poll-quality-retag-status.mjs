/**
 * Ops helper: poll quality KEY_PREFIX drain + live Centurion folder/spam counts.
 * Invoke from apps/server-pilot with DATABASE_URL set (ops only — never Vitest).
 *
 *   node scripts/poll-quality-retag-status.mjs [key-prefix]
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
  const runs = await sql`
    select state, count(*)::int as n
    from ai_workflow_run
    where idempotency_key like ${prefix + ':%'}
    group by 1
    order by 1
  `;
  const pending = await sql`
    select count(*)::int as pending
    from ai_workflow_run
    where idempotency_key like ${prefix + ':%'}
      and state in ('queued', 'running', 'retry_wait')
  `;
  const folders = await sql`
    select c.slug, count(*)::int as n
    from mail_thread_category mtc
    join mail_category c on c.id = mtc.category_id
    join mail_thread t on t.id = mtc.thread_id
    where t.transport_id = 'transport-centurion'
      and c.slug in (
        'automated-channel',
        'bookings',
        'exceptions-recovery',
        'confirmations-amendments',
        'urgent',
        'ops',
        'unknown-review'
      )
    group by 1
    order by 2 desc
  `;
  const spam = await sql`
    select count(*)::int as spam_threads
    from mail_thread
    where transport_id = 'transport-centurion' and spam_at is not null
  `;
  const quarantine = await sql`
    select count(*)::int as quarantine_labeled
    from mail_thread t
    join mail_label l
      on l.transport_id = t.transport_id
     and lower(l.name) = 'quarantine'
    where t.transport_id = 'transport-centurion'
      and t.label_ids ? l.id
  `;
  console.log(
    JSON.stringify(
      {
        keyPrefix: prefix,
        runs,
        pending: pending[0]?.pending ?? 0,
        folders,
        spam: spam[0]?.spam_threads ?? 0,
        quarantineLabeled: quarantine[0]?.quarantine_labeled ?? 0,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
