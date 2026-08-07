#!/usr/bin/env npx tsx
/**
 * Read-only Centurion corpus shape diag — aggregates only, no bodies/addresses.
 * Hypothesis: BCC hotel replies land as direction=inbound from centurion@.
 */
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

async function main() {
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const sql = postgres(url, { ssl: sslOptions(serverRoot), max: 1 });

  try {
    const byDir = await sql`
      SELECT direction::text AS direction, count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
      GROUP BY direction
      ORDER BY direction
    `;

    const directionVsFrom = await sql`
      SELECT
        direction::text AS direction,
        CASE
          WHEN lower(from_address) LIKE '%centurion%' THEN 'from_centurion'
          ELSE 'from_other'
        END AS from_kind,
        count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    const fromCenturionTotal = await sql`
      SELECT count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
        AND lower(from_address) LIKE '%centurion%'
    `;

    const threadsWithBothFromKinds = await sql`
      SELECT count(*)::int AS c
      FROM (
        SELECT thread_id
        FROM message
        WHERE transport_id = ${TID}
        GROUP BY thread_id
        HAVING
          bool_or(lower(from_address) LIKE '%centurion%')
          AND bool_or(lower(from_address) NOT LIKE '%centurion%')
      ) t
    `;

    const guestThenCenturionReply = await sql`
      SELECT count(*)::int AS c
      FROM message g
      WHERE g.transport_id = ${TID}
        AND lower(g.from_address) NOT LIKE '%centurion%'
        AND EXISTS (
          SELECT 1
          FROM message c
          WHERE c.thread_id = g.thread_id
            AND c.transport_id = ${TID}
            AND lower(c.from_address) LIKE '%centurion%'
            AND coalesce(c.received_at, c.sent_at, c.created_at)
              >= coalesce(g.received_at, g.sent_at, g.created_at)
            AND c.id <> g.id
        )
    `;

    const uniqueGuestWithLaterCenturion = await sql`
      SELECT count(DISTINCT g.id)::int AS c
      FROM message g
      WHERE g.transport_id = ${TID}
        AND lower(g.from_address) NOT LIKE '%centurion%'
        AND EXISTS (
          SELECT 1
          FROM message c
          WHERE c.thread_id = g.thread_id
            AND c.transport_id = ${TID}
            AND lower(c.from_address) LIKE '%centurion%'
            AND coalesce(c.received_at, c.sent_at, c.created_at)
              >= coalesce(g.received_at, g.sent_at, g.created_at)
            AND c.id <> g.id
        )
    `;

    const centurionMsgsLabeledInbound = await sql`
      SELECT count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
        AND direction = 'inbound'
        AND lower(from_address) LIKE '%centurion%'
    `;

    const centurionMsgsLabeledOutbound = await sql`
      SELECT count(*)::int AS c
      FROM message
      WHERE transport_id = ${TID}
        AND direction = 'outbound'
        AND lower(from_address) LIKE '%centurion%'
    `;

    const oldGoldBearing = await sql`
      SELECT count(*)::int AS c
      FROM message m
      WHERE m.transport_id = ${TID}
        AND m.direction = 'inbound'
        AND EXISTS (
          SELECT 1
          FROM message o
          WHERE o.thread_id = m.thread_id
            AND o.direction = 'outbound'
            AND coalesce(o.received_at, o.sent_at, o.created_at)
              >= coalesce(m.received_at, m.sent_at, m.created_at)
        )
    `;

    const multiMsgThreads = await sql`
      SELECT count(*)::int AS c
      FROM (
        SELECT thread_id
        FROM message
        WHERE transport_id = ${TID}
        GROUP BY thread_id
        HAVING count(*) >= 2
      ) t
    `;

    console.log(
      JSON.stringify(
        {
          byDir,
          directionVsFrom,
          fromCenturionTotal: fromCenturionTotal[0]?.c,
          centurionMsgsLabeledInbound: centurionMsgsLabeledInbound[0]?.c,
          centurionMsgsLabeledOutbound: centurionMsgsLabeledOutbound[0]?.c,
          threadsWithBothFromKinds: threadsWithBothFromKinds[0]?.c,
          guestThenCenturionReply: guestThenCenturionReply[0]?.c,
          uniqueGuestWithLaterCenturion: uniqueGuestWithLaterCenturion[0]?.c,
          oldDirectionBasedGoldBearing: oldGoldBearing[0]?.c,
          multiMsgThreads: multiMsgThreads[0]?.c,
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
