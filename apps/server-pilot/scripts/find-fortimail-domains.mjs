/**
 * Ops helper: find FortiMail/quarantine-digest candidate domains (aggregates only).
 *   node scripts/find-fortimail-domains.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { default: postgres } = await import('postgres');
const ca = path.join(root, 'deploy', 'rds-ca-global.pem');
const sql = postgres(process.env.DATABASE_URL, {
  ssl: fs.existsSync(ca)
    ? { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') }
    : 'require',
  max: 1,
});

try {
  const rows = await sql`
    with hits as (
      select
        lower(split_part(trim(m.from_address), '@', 2)) as domain,
        (t.spam_at is not null) as is_spam
      from message m
      join mail_thread t on t.id = m.thread_id
      where m.transport_id = 'transport-centurion'
        and m.direction = 'inbound'
        and (
          lower(coalesce(m.subject, '')) like '%fortimail%'
          or lower(coalesce(m.subject, '')) like '%quarantine digest%'
          or lower(coalesce(m.subject, '')) like '%quarantine summary%'
          or lower(coalesce(m.text_body, '')) like '%fortimail%'
          or lower(coalesce(m.html_body, '')) like '%fortimail%'
        )
    )
    select domain, is_spam, count(*)::int as n
    from hits
    where domain is not null and domain <> ''
    group by 1, 2
    order by 3 desc
    limit 30
  `;
  const urgentAuto = await sql`
    select count(*)::int as n
    from mail_thread_category mtc
    join mail_category c on c.id = mtc.category_id
    join mail_thread t on t.id = mtc.thread_id
    where t.transport_id = 'transport-centurion'
      and c.slug = 'automated-channel'
      and exists (
        select 1 from mail_thread_category u
        join mail_category uc on uc.id = u.category_id
        where u.thread_id = t.id and uc.slug = 'urgent'
      )
  `;
  console.log(JSON.stringify({ fortimailDomains: rows, automateAlsoUrgent: urgentAuto[0]?.n ?? 0 }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
