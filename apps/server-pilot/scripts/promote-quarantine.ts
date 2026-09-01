/**
 * Promote `missing_owner_header` quarantine rows into normal message storage.
 *
 * Run (EC2, after INGEST_REQUIRE_OWNER_HEADER=false):
 *   pnpm --filter @zero/server tsx scripts/promote-quarantine.ts
 *   pnpm --filter @zero/server tsx scripts/promote-quarantine.ts --dry-run
 *   pnpm --filter @zero/server tsx scripts/promote-quarantine.ts --limit 10
 */
import {
  formatPromoteSummary,
  parsePromoteCliArgs,
  promoteMissingOwnerHeaderQuarantine,
  PromoteEnvError,
} from '../src/mail/ingest/promote-quarantine.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { parseEnv } from '../src/env.js';
import postgres from 'postgres';

async function main(): Promise<void> {
  const cli = parsePromoteCliArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const result = await promoteMissingOwnerHeaderQuarantine({
      db,
      dryRun: cli.dryRun,
      limit: cli.limit,
    });
    const summary = formatPromoteSummary(result);
    console.log(
      cli.dryRun ? 'promote dry-run:' : 'promote complete:',
      cli.dryRun ? `promote_candidates=${result.dryRunIds.length} ${summary}` : summary,
    );
    if (result.errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  if (err instanceof PromoteEnvError) {
    console.error('promote aborted:', err.message);
    process.exit(1);
  }
  console.error('promote failed:', err);
  process.exit(1);
});
