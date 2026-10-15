/** Additive provision runner. Dry-run default. --apply inserts only; never prunes. Never Secrets Manager. */
import {
  applyProvisionThenWriteCredentials,
  planProvision,
  PROVISION_SPEC,
  STALE_PLAN_MESSAGE,
  type ProvisionPlan,
} from '../src/db/provision.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { parseEnv } from '../src/env.js';
import postgres from 'postgres';

function parseFlags(argv: string[]): { apply: boolean; credentialsOut: string | null } {
  let apply = false;
  let credentialsOut: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    if (argv[i] === '--credentials-out') credentialsOut = argv[++i] ?? null;
  }
  return { apply, credentialsOut };
}

function printPlan(plan: ProvisionPlan): void {
  const line = (label: string, ids: string[]) =>
    console.log(label, ids.length, ids.join(' ') || '(none)');
  line(
    'usersToCreate',
    plan.usersToCreate.map((r) => r.id),
  );
  line(
    'transportsToCreate',
    plan.transportsToCreate.map((r) => r.id),
  );
  line(
    'inactiveTransports (needs separate action; provisioner never activates)',
    plan.inactiveTransports,
  );
  line(
    'grantsToCreate',
    plan.grantsToCreate.map((r) => `access-${r.userId}-${r.transportId}`),
  );
  line('alreadyPresent users', plan.alreadyPresent.users);
  line('alreadyPresent transports', plan.alreadyPresent.transports);
  line('alreadyPresent grants', plan.alreadyPresent.grants);
  if (plan.transportDrift.length === 0) return;
  console.log('transportDrift (reported, not overwritten)', plan.transportDrift.length);
  for (const row of plan.transportDrift) console.log(`  ${row.id} ${row.field}`);
}

function writeCredentialsFile(path: string, payload: Record<string, { password: string }>): void {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'EEXIST')
      throw new Error(`refusing to overwrite existing credentials file: ${path}`);
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.apply && !flags.credentialsOut)
    throw new Error('--apply requires --credentials-out <path>');
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });
  try {
    const plan = await planProvision(db, PROVISION_SPEC);
    printPlan(plan);
    if (!flags.apply) {
      console.log('dry-run only (never prunes); pass --apply --credentials-out <path> to insert');
      return;
    }
    const credentialsOut = flags.credentialsOut;
    if (!credentialsOut) throw new Error('--apply requires --credentials-out <path>');
    if (existsSync(credentialsOut))
      throw new Error(`refusing to overwrite existing credentials file: ${credentialsOut}`);
    const credentials: Record<string, string> = {};
    for (const user of plan.usersToCreate) {
      credentials[user.email] = randomBytes(18).toString('base64url');
    }
    await applyProvisionThenWriteCredentials(db, plan, credentials, (payload) => {
      writeCredentialsFile(credentialsOut, payload);
    });
    console.log('provision apply complete (insert-only; never prunes)');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message === STALE_PLAN_MESSAGE) console.error(STALE_PLAN_MESSAGE);
  else console.error('provision failed:', err);
  process.exit(1);
});
