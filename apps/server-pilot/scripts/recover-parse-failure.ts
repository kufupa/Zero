/**
 * Recover `parse_failure` quarantine rows into normal message storage.
 *
 * Run (EC2):
 *   pnpm --filter @zero/server tsx scripts/recover-parse-failure.ts --dry-run
 *   pnpm --filter @zero/server tsx scripts/recover-parse-failure.ts --limit 10
 *
 * Default skipAiEnqueue=true so a drifted AI schema cannot re-poison persist.
 * Pass --enqueue-ai only on a host whose persist path matches live schema.
 */
import { parsePromoteCliArgs } from '../src/mail/ingest/promote-quarantine.js';
import { recoverParseFailureQuarantine } from '../src/mail/ingest/recover-parse-failure.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { parseEnv } from '../src/env.js';
import postgres from 'postgres';

function parseRecoverCliArgs(argv: string[]): {
  dryRun: boolean;
  limit?: number;
  skipAiEnqueue: boolean;
} {
  const enqueueAi = argv.includes('--enqueue-ai');
  const rest = argv.filter((arg) => arg !== '--enqueue-ai');
  const parsed = parsePromoteCliArgs(rest);
  return { ...parsed, skipAiEnqueue: !enqueueAi };
}

async function main(): Promise<void> {
  const cli = parseRecoverCliArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const result = await recoverParseFailureQuarantine({
      db,
      dryRun: cli.dryRun,
      limit: cli.limit,
      skipAiEnqueue: cli.skipAiEnqueue,
    });
    console.log(
      JSON.stringify({
        phase: cli.dryRun ? 'dry-run' : 'complete',
        scanned: result.scanned,
        stored: result.stored,
        duplicate: result.duplicate,
        quarantined: result.quarantined,
        errors: result.errors,
        skipped: result.skipped ?? 0,
        dryRunCount: result.dryRunIds.length,
        skipAiEnqueue: cli.skipAiEnqueue,
      }),
    );
    if (result.errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('recover-parse-failure failed:', err);
  process.exit(1);
});
