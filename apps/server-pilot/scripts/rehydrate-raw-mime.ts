/**
 * Rehydrate wiped mailbox rows from S3 raw-mime objects.
 *
 * Run (EC2, after INGEST_REQUIRE_OWNER_HEADER=false):
 *   pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts --dry-run
 *   pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts
 *   pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts --limit 20
 *   pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts --triage
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { parseEnv } from '../src/env.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  formatRehydrateSummary,
  parseRehydrateCliArgs,
  rehydrateRawMimeFromS3,
  RehydrateEnvError,
} from '../src/mail/ingest/rehydrate-raw-mime.js';

async function main(): Promise<void> {
  const cli = parseRehydrateCliArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const result = await rehydrateRawMimeFromS3({
      db,
      dryRun: cli.dryRun,
      limit: cli.limit,
      prefix: cli.prefix,
      triage: cli.triage,
    });
    console.log(
      cli.dryRun ? 'rehydrate dry-run:' : 'rehydrate complete:',
      formatRehydrateSummary(result),
    );
    if (result.errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  if (err instanceof RehydrateEnvError) {
    console.error('rehydrate aborted:', err.message);
    process.exit(1);
  }
  console.error('rehydrate failed:', err);
  process.exit(1);
});
