/**
 * Production runner for the pilot seed.
 *
 * Delegates the actual DB operations to `src/db/seed.ts` and additionally
 * persists the generated pilot credentials to AWS Secrets Manager under
 * `nava-zero/server-pilot/pilot-users` (JSON; never committed to the repo).
 *
 * Run via: pnpm --filter @zero/server seed:prod
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { parseEnv } from '../src/env.js';
import { seedAll, PILOT_USERS } from '../src/db/seed.js';

const PILOT_SECRET_NAME = 'nava-zero/server-pilot/pilot-users';
const AWS_REGION = process.env.AWS_REGION ?? 'af-south-1';

async function putPilotSecret(payload: Record<string, { password: string }>): Promise<void> {
  const { spawn } = await import('node:child_process');
  const json = JSON.stringify(payload);
  const args = [
    'secretsmanager',
    'put-secret-value',
    '--region',
    AWS_REGION,
    '--secret-id',
    PILOT_SECRET_NAME,
    '--secret-string',
    json,
  ];
  await new Promise<void>((resolve, reject) => {
    const p = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`aws secretsmanager put-secret-value exit ${code}: ${stderr}`)),
    );
  });
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: { rejectUnauthorized: false },
  });
  const db = drizzle(conn, { schema });

  try {
    const result = await seedAll(db);
    await putPilotSecret(result.pilotCredentials);

    console.log('seed complete');
    console.log('ingest mailbox: nava@legacyhotel.com');
    console.log('transports (count):', result.transportCount);
    console.log('mailbox_access rows (total):', result.accessCount);
    console.log('pilot users:', PILOT_USERS.map((u) => u.email).join(', '));
    console.log('pilot credentials stored in Secrets Manager:', PILOT_SECRET_NAME);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
