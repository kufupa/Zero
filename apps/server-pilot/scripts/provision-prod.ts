/** Additive provision runner. Dry-run default. --apply inserts only; never prunes. Never Secrets Manager. */
import {
  applyProvision,
  planProvision,
  PROVISION_SPEC,
  STALE_PLAN_MESSAGE,
  type ProvisionPlan,
} from '../src/db/provision.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { parseEnv } from '../src/env.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';

export const USAGE = 'usage: provision-prod.ts [--apply --credentials-out <path>]';

export class ProvisionUsageError extends Error {
  readonly exitCode = 2;
  constructor() {
    super(USAGE);
    this.name = 'ProvisionUsageError';
  }
}

export function parseFlags(argv: string[]): { apply: boolean; credentialsOut: string | null } {
  let apply = false;
  let credentialsOut: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--credentials-out') {
      credentialsOut = argv[++i] ?? null;
      continue;
    }
    throw new ProvisionUsageError();
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

export async function applyAfterReservingCredentialsFile(opts: {
  path: string;
  apply: () => Promise<Record<string, { password: string }>>;
}): Promise<void> {
  const fd = openSync(opts.path, 'wx', 0o600);
  let committed = false;
  try {
    const payload = await opts.apply();
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fsyncSync(fd);
    committed = true;
    closeSync(fd);
  } catch (err) {
    if (!committed) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(opts.path);
      } catch {
        // best-effort cleanup of the empty reservation
      }
    }
    throw err;
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
    await applyAfterReservingCredentialsFile({
      path: credentialsOut,
      apply: async () => {
        const credentials: Record<string, string> = {};
        for (const user of plan.usersToCreate) {
          credentials[user.email] = randomBytes(18).toString('base64url');
        }
        await applyProvision(db, plan, credentials);
        const payload: Record<string, { password: string }> = {};
        for (const user of plan.usersToCreate) {
          const password = credentials[user.email];
          if (!password) throw new Error(`provision missing password for ${user.id}`);
          payload[user.email] = { password };
        }
        return payload;
      },
    });
    console.log('provision apply complete (insert-only; never prunes)');
  } finally {
    await conn.end();
  }
}

function fail(err: unknown): never {
  if (err instanceof ProvisionUsageError) {
    console.error(USAGE);
    process.exit(2);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === STALE_PLAN_MESSAGE) console.error(STALE_PLAN_MESSAGE);
  else console.error('provision failed:', err);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(fail);
}
