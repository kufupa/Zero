#!/usr/bin/env npx tsx
/** Read-only: redacted from-shapes + staff BCC pairing. No raw addresses. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const TID = 'transport-centurion';

function sslOptions(rootDir: string) {
  const caPath = join(rootDir, 'deploy', 'rds-ca-global.pem');
  if (existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
  }
  return 'require' as const;
}

function shapeAddr(addr: string) {
  const a = addr.toLowerCase();
  const at = a.lastIndexOf('@');
  const domain = at >= 0 ? a.slice(at + 1) : 'none';
  const local = at >= 0 ? a.slice(0, at) : a;
  const localShape =
    local.length === 0 ? '' : `${local[0]}*${local.length}`;
  return {
    domain,
    localShape,
    h: createHash('sha256').update(a).digest('hex').slice(0, 10),
  };
}

async function main() {
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const sql = postgres(url, { ssl: sslOptions(serverRoot), max: 1 });

  try {
    const rows = await sql<{ from_address: string; c: number }[]>`
      SELECT from_address, count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID} AND direction = 'inbound'
      GROUP BY from_address
      ORDER BY c DESC
      LIMIT 40
    `;

    const staffish = await sql`
      SELECT count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
        AND direction = 'inbound'
        AND (
          lower(from_address) LIKE '%@legacyhotels.%'
          OR lower(from_address) LIKE '%@legacyhotel.%'
        )
        AND lower(from_address) NOT LIKE '%centurion%'
    `;

    const staffDomains = await sql`
      SELECT
        lower(split_part(from_address, '@', 2)) AS domain,
        count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
        AND direction = 'inbound'
        AND (
          lower(from_address) LIKE '%@legacyhotels.%'
          OR lower(from_address) LIKE '%@legacyhotel.%'
        )
      GROUP BY 1
      ORDER BY c DESC
    `;

    const guestThenStaff = await sql`
      SELECT count(DISTINCT g.id)::int AS c
      FROM message g
      WHERE g.transport_id = ${TID}
        AND lower(g.from_address) NOT LIKE '%@legacyhotels.%'
        AND lower(g.from_address) NOT LIKE '%@legacyhotel.%'
        AND lower(g.from_address) NOT LIKE '%centurion%'
        AND EXISTS (
          SELECT 1
          FROM message s
          WHERE s.thread_id = g.thread_id
            AND s.transport_id = ${TID}
            AND s.id <> g.id
            AND (
              lower(s.from_address) LIKE '%@legacyhotels.%'
              OR lower(s.from_address) LIKE '%@legacyhotel.%'
              OR lower(s.from_address) LIKE '%centurion%'
            )
            AND coalesce(s.received_at, s.sent_at, s.created_at)
              >= coalesce(g.received_at, g.sent_at, g.created_at)
        )
    `;

    const withReplyHeaders = await sql`
      SELECT
        count(*) FILTER (
          WHERE in_reply_to IS NOT NULL AND length(in_reply_to) > 0
        )::int AS with_in_reply_to,
        count(*) FILTER (
          WHERE "references" IS NOT NULL
        )::int AS with_references,
        count(*)::int AS total
      FROM message
      WHERE transport_id = ${TID}
    `;

    // Cross-thread: staff msg whose in_reply_to matches some guest message_id_header
    const crossThreadGold = await sql`
      SELECT count(DISTINCT g.id)::int AS c
      FROM message g
      JOIN message s
        ON s.transport_id = ${TID}
       AND s.id <> g.id
       AND s.in_reply_to IS NOT NULL
       AND length(s.in_reply_to) > 0
       AND g.message_id_header IS NOT NULL
       AND s.in_reply_to = g.message_id_header
      WHERE g.transport_id = ${TID}
        AND lower(g.from_address) NOT LIKE '%centurion%'
        AND lower(g.from_address) NOT LIKE '%@legacyhotels.%'
        AND (
          lower(s.from_address) LIKE '%centurion%'
          OR lower(s.from_address) LIKE '%@legacyhotels.%'
        )
    `;

    console.log(
      JSON.stringify(
        {
          topInboundFromShapes: rows.map((r) => ({
            ...shapeAddr(r.from_address),
            c: r.c,
          })),
          staffishNonCenturionInbound: staffish[0]?.c,
          staffDomains,
          guestThenStaffSameThread: guestThenStaff[0]?.c,
          withReplyHeaders: withReplyHeaders[0],
          crossThreadViaInReplyTo: crossThreadGold[0]?.c,
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
