/**
 * Backfill mail_thread.search_vector from its current source text.
 *
 * Run:
 *   pnpm --filter @zero/server tsx scripts/backfill-search-vector.ts
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { parseEnv } from '../src/env.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  THREAD_SEARCH_VECTOR_CONFIG,
  threadSearchVectorSourceSql,
} from '../src/mail/search/search-vector.js';

const BACKFILL_BATCH_SIZE = 200;

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    let lastId = '';
    let updated = 0;

    while (true) {
      const rows = await db.execute<{ id: string }>(sql`
        WITH batch AS (
          SELECT "id"
          FROM "mail_thread"
          WHERE "id" > ${lastId}
          ORDER BY "id"
          LIMIT ${BACKFILL_BATCH_SIZE}
        ),
        updated_rows AS (
          UPDATE "mail_thread"
          SET "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, ${threadSearchVectorSourceSql})
          FROM batch
          WHERE "mail_thread"."id" = batch."id"
          RETURNING "mail_thread"."id" AS "id"
        )
        SELECT "id"
        FROM updated_rows
        ORDER BY "id"
      `);

      if (rows.length === 0) break;
      updated += rows.length;
      lastId = rows[rows.length - 1]!.id;
    }

    const [indexed] = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS "count"
      FROM "mail_thread"
      WHERE "search_vector" IS NOT NULL
    `);
    console.log(
      `backfill complete: ${updated} row(s) updated; ${Number(indexed?.count ?? 0)} thread(s) with search_vector`,
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
