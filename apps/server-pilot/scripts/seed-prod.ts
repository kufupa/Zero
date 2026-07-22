/**
 * Production runner for the pilot seed.
 *
 * Delegates the actual DB operations to `src/db/seed.ts` and additionally
 * persists the generated pilot credentials to AWS Secrets Manager under
 * `nava-zero/server-pilot/pilot-users` (JSON; never committed to the repo).
 *
 * Run via: pnpm --filter @zero/server seed:prod
 * Rotate passwords: pnpm --filter @zero/server seed:prod -- --rotate
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { parseEnv } from '../src/env.js';
import { seedAll, planPilotCredentials, PILOT_USERS } from '../src/db/seed.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { replacePilotSecretPayload } from '../src/lib/pilot-secrets.js';

const PILOT_SECRET_NAME = 'nava-zero/server-pilot/pilot-users';
const AWS_REGION = process.env.AWS_REGION ?? 'af-south-1';

function parseFlags(argv: string[]): { rotate: boolean } {
  return { rotate: argv.includes('--rotate') };
}

async function runAws(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const p = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`aws ${args[0]} exit ${code}: ${stderr}`)),
    );
  });
}

async function ensurePilotSecret(): Promise<void> {
  try {
    await runAws([
      'secretsmanager',
      'describe-secret',
      '--region',
      AWS_REGION,
      '--secret-id',
      PILOT_SECRET_NAME,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/ResourceNotFoundException|can't find the specified secret/i.test(message)) {
      throw err;
    }
    await runAws([
      'secretsmanager',
      'create-secret',
      '--region',
      AWS_REGION,
      '--name',
      PILOT_SECRET_NAME,
      '--description',
      'NAVA Zero server-pilot pilot user passwords (JSON by email)',
      '--secret-string',
      '{}',
    ]);
  }
}

async function getPilotSecret(): Promise<Record<string, { password: string }>> {
  try {
    const { stdout } = await runAws([
      'secretsmanager',
      'get-secret-value',
      '--region',
      AWS_REGION,
      '--secret-id',
      PILOT_SECRET_NAME,
      '--query',
      'SecretString',
      '--output',
      'text',
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed) as Record<string, { password: string }>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ResourceNotFoundException|can't find the specified secret/i.test(message)) {
      return {};
    }
    throw err;
  }
}

async function putPilotSecret(payload: Record<string, { password: string }>): Promise<void> {
  const json = JSON.stringify(payload);
  await runAws([
    'secretsmanager',
    'put-secret-value',
    '--region',
    AWS_REGION,
    '--secret-id',
    PILOT_SECRET_NAME,
    '--secret-string',
    json,
  ]);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const credentialsToWrite = await planPilotCredentials(db, {
      rotatePasswords: flags.rotate,
    });

    await ensurePilotSecret();
    const existing = await getPilotSecret();
    const allowedEmails = PILOT_USERS.map((u) => u.email);
    const nextSecret = replacePilotSecretPayload(
      existing,
      allowedEmails,
      credentialsToWrite,
    );
    // Always rewrite so orphan persona keys are dropped even when passwords unchanged.
    await putPilotSecret(nextSecret);

    const result = await seedAll(db, {
      rotatePasswords: flags.rotate,
      precomputedCredentials: credentialsToWrite,
    });

    console.log('seed complete');
    console.log('ingest mailbox: navaai@legacyhotels.co.za');
    console.log('transports (count):', result.transportCount);
    console.log('mailbox_access rows (total):', result.accessCount);
    console.log('pilot users:', allowedEmails.join(', '));
    if (Object.keys(credentialsToWrite).length > 0) {
      console.log('pilot credentials stored in Secrets Manager:', PILOT_SECRET_NAME);
    } else {
      console.log('pilot credentials unchanged (use --rotate to rotate); secret pruned to pilot emails');
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
