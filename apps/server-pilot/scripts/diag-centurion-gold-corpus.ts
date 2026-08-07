#!/usr/bin/env npx tsx
/** Read-only corpus shape diagnostics — no bodies printed. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const CENTURION_TRANSPORT_ID = 'transport-centurion';

function sslOptions(rootDir: string) {
  const caPath = join(rootDir, 'deploy', 'rds-ca-global.pem');
  if (existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
  }
  return 'require' as const;
}

async function main() {
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const sql = postgres(url, { ssl: sslOptions(serverRoot), max: 1 });
  const tid = CENTURION_TRANSPORT_ID;
  try {
    const inbound = await sql`
      select count(*)::int as c from message
      where transport_id = ${tid} and direction = 'inbound'
    `;
    const outbound = await sql`
      select count(*)::int as c from message
      where transport_id = ${tid} and direction = 'outbound'
    `;
    const goldBearing = await sql`
      select count(*)::int as c from message m
      where m.transport_id = ${tid} and m.direction = 'inbound'
        and exists (
          select 1 from message o
          where o.thread_id = m.thread_id and o.direction = 'outbound'
            and coalesce(o.received_at, o.sent_at, o.created_at)
              >= coalesce(m.received_at, m.sent_at, m.created_at)
        )
    `;
    const anyOutboundThread = await sql`
      select count(*)::int as c from message m
      where m.transport_id = ${tid} and m.direction = 'inbound'
        and exists (
          select 1 from message o
          where o.thread_id = m.thread_id and o.direction = 'outbound'
        )
    `;
    const outBody = await sql`
      select
        count(*)::int as c,
        count(*) filter (where text_body is not null and length(text_body) > 0)::int as text_nonempty,
        count(*) filter (where html_body is not null and length(html_body) > 0)::int as html_nonempty
      from message
      where transport_id = ${tid} and direction = 'outbound'
    `;
    const sampleLens = await sql`
      select
        length(coalesce(i.text_body, ''))::int as in_text_len,
        length(coalesce(i.html_body, ''))::int as in_html_len,
        length(coalesce(o.text_body, ''))::int as out_text_len,
        length(coalesce(o.html_body, ''))::int as out_html_len
      from message i
      join lateral (
        select *
        from message o
        where o.thread_id = i.thread_id
          and o.direction = 'outbound'
          and coalesce(o.received_at, o.sent_at, o.created_at)
            >= coalesce(i.received_at, i.sent_at, i.created_at)
        order by coalesce(o.received_at, o.sent_at, o.created_at) asc
        limit 1
      ) o on true
      where i.transport_id = ${tid} and i.direction = 'inbound'
      order by coalesce(i.received_at, i.sent_at, i.created_at) desc
      limit 8
    `;
    console.log(
      JSON.stringify(
        {
          inbound: inbound[0]?.c,
          outbound: outbound[0]?.c,
          goldBearing: goldBearing[0]?.c,
          anyOutboundThread: anyOutboundThread[0]?.c,
          outBody: outBody[0],
          sampleLens,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
