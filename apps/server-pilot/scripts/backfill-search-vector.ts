/**
 * Backfill mail_thread.search_vector from subject + snippet.
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
    const result = await db.execute(sql`
      UPDATE "mail_thread"
      SET "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, ${threadSearchVectorSourceSql})
    `);
    const updated = Number(result.count ?? 0);
    console.log(`backfill complete: ${updated} row(s) updated`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
