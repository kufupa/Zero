/**
 * Dry-run counts for routed quarantine promote. `--dry-run` required.
 *
 *   pnpm --filter @zero/server tsx scripts/promote-quarantine-routed.ts --dry-run
 */
import {
  dryRunRoutedPromote,
  parseRoutedPromoteCliArgs,
  RoutedPromoteDryRunRequiredError,
} from '../src/mail/ingest/promote-quarantine-routed.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { parseEnv } from '../src/env.js';
import { getS3Storage } from '../src/storage/s3.js';
import postgres from 'postgres';

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseRoutedPromoteCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RoutedPromoteDryRunRequiredError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });
  try {
    const result = await db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
        return dryRunRoutedPromote({
          db: tx,
          storage: getS3Storage(),
          limit: cli.limit,
          transportId: cli.transportId,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (result.cross_hotel_violations > 0) {
      console.error(`CROSS_HOTEL_VIOLATION ${result.crossHotelViolationIds.join(' ')}`);
    }
    const {
      scanned,
      byTransport,
      unknown,
      ambiguous,
      multi_transport,
      error,
      dup_stored,
      cross_hotel_violations,
      ingestMailboxes,
      requireOwnerHeader,
    } = result;
    console.log(
      JSON.stringify({
        scanned,
        byTransport,
        unknown,
        ambiguous,
        multi_transport,
        error,
        dup_stored,
        cross_hotel_violations,
        ingestMailboxes,
        requireOwnerHeader,
      }),
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('promote-quarantine-routed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
