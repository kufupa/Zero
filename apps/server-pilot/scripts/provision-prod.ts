/** Additive provision runner. Dry-run default. --apply inserts only; never prunes. Never Secrets Manager. */
import {
  applyProvision,
  applyProvisionThenWriteCredentials,
  planProvision,
  PROVISION_SPEC,
  STALE_PLAN_MESSAGE,
  stripPlanForTransportsOnly,
  transportsOnlySpec,
  type ProvisionPlan,
} from '../src/db/provision.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { parseEnv } from '../src/env.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';

export const USAGE =
  'usage: provision-prod.ts [--transports-only] [--credentials-in <path>] [--apply [--credentials-out <path>]]';
export const CREDENTIALS_IN_PLACEHOLDER = '<from credentials-in>';

export class ProvisionUsageError extends Error {
  readonly exitCode = 2;
  constructor() {
    super(USAGE);
    this.name = 'ProvisionUsageError';
  }
}

function requireFlagValue(argv: string[], flagIndex: number): string {
  const value = argv[flagIndex + 1];
  if (!value || value.startsWith('--')) throw new ProvisionUsageError();
  return value;
}

export function parseFlags(
  argv: string[],
):
  | {
      apply: false;
      transportsOnly: boolean;
      credentialsOut: string | null;
      credentialsIn: string | null;
    }
  | {
      apply: true;
      transportsOnly: false;
      credentialsOut: string;
      credentialsIn: string | null;
    }
  | {
      apply: true;
      transportsOnly: true;
      credentialsOut: string | null;
      credentialsIn: string | null;
    } {
  let apply = false;
  let transportsOnly = false;
  let credentialsOut: string | null = null;
  let credentialsIn: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--transports-only') {
      transportsOnly = true;
      continue;
    }
    if (arg === '--credentials-out') {
      credentialsOut = requireFlagValue(argv, i);
      i += 1;
      continue;
    }
    if (arg === '--credentials-in') {
      credentialsIn = requireFlagValue(argv, i);
      i += 1;
      continue;
    }
    throw new ProvisionUsageError();
  }
  if (apply) {
    if (transportsOnly) {
      return { apply: true, transportsOnly: true, credentialsOut, credentialsIn };
    }
    if (!credentialsOut) throw new ProvisionUsageError();
    return { apply: true, transportsOnly: false, credentialsOut, credentialsIn };
  }
  return { apply: false, transportsOnly, credentialsOut, credentialsIn };
}

export function redactCredentialsOut(
  payload: Record<string, { password: string }>,
): Record<string, { password: string }> {
  const redacted: Record<string, { password: string }> = {};
  for (const email of Object.keys(payload)) {
    redacted[email] = { password: CREDENTIALS_IN_PLACEHOLDER };
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load email→password from a 0600 JSON object. Errors list emails only, never passwords. */
export function loadCredentialsIn(
  path: string,
  specEmails: readonly string[],
  usersToCreateEmails: readonly string[],
): Record<string, string> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`provision credentials-in: cannot read ${path}`);
  }
  if ((mode & 0o777) !== 0o600) {
    throw new Error(`provision credentials-in: ${path} must be mode 0600`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`provision credentials-in: cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('provision credentials-in: invalid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('provision credentials-in: expected a JSON object');
  }

  const specSet = new Set(specEmails.map((email) => email.toLowerCase()));
  const extras: string[] = [];
  for (const email of Object.keys(parsed)) {
    if (!specSet.has(email.toLowerCase())) extras.push(email);
  }
  if (extras.length > 0) {
    throw new Error(`provision credentials-in: extra emails not in spec: ${extras.join(', ')}`);
  }

  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const email of usersToCreateEmails) {
    const key =
      email in parsed
        ? email
        : Object.keys(parsed).find((candidate) => candidate.toLowerCase() === email.toLowerCase());
    const value = key === undefined ? undefined : parsed[key];
    if (value === undefined) {
      missing.push(email);
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`provision credentials-in: password for ${email} is not a string`);
    }
    if (value.length < 9 || value.length > 64) {
      throw new Error(`provision credentials-in: password for ${email} must be 9-64 characters`);
    }
    out[email] = value;
  }
  if (missing.length > 0) {
    throw new Error(`provision credentials-in: missing emails: ${missing.join(', ')}`);
  }
  return out;
}

export function printPlan(plan: ProvisionPlan): void {
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
  line('aliasesToAdd', plan.aliasesToAdd.map((row) => `${row.transportId} ${row.aliases.length}`));
  if (plan.transportDrift.length === 0) return;
  console.log('transportDrift (reported, not overwritten)', plan.transportDrift.length);
  for (const row of plan.transportDrift) console.log(`  ${row.id} ${row.field}`);
}

function discardReservedCredentialsFile(fd: number, path: string): void {
  try {
    ftruncateSync(fd, 0);
    fsyncSync(fd);
  } catch {
    // still try unlink / rename
  }
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
  try {
    unlinkSync(path);
    return;
  } catch {
    // fall through to rename
  }
  const rolledBack = `${path}.ROLLED_BACK`;
  try {
    renameSync(path, rolledBack);
  } catch {
    throw new Error(
      `provision: FAILED to remove rolled-back credentials file ${path} (rename to ${rolledBack} also failed). Delete this file before retry. File is not a successful apply.`,
    );
  }
}

export type CredentialsWriteSync = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset?: number | null,
  length?: number | null,
  position?: number | null,
) => number;

function writeAllSync(fd: number, data: Uint8Array, write: CredentialsWriteSync): void {
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    const written = write(fd, data, offset, remaining);
    if (written <= 0 || written > remaining) {
      throw new Error(`provision: short write (${written} bytes written, ${remaining} remaining)`);
    }
    offset += written;
  }
}

export async function applyAfterReservingCredentialsFile(opts: {
  path: string;
  apply: (
    writeCredentials: (payload: Record<string, { password: string }>) => void,
  ) => Promise<void>;
  writeSync?: CredentialsWriteSync;
}): Promise<void> {
  const write = opts.writeSync ?? writeSync;
  const fd = openSync(opts.path, 'wx', 0o600);
  try {
    await opts.apply((payload) => {
      writeAllSync(fd, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`), write);
      fsyncSync(fd);
    });
  } catch (err) {
    discardReservedCredentialsFile(fd, opts.path);
    throw err;
  }
  closeSync(fd);
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
    const spec = flags.transportsOnly ? transportsOnlySpec(PROVISION_SPEC) : PROVISION_SPEC;
    const planned = await planProvision(
      db,
      spec,
      flags.transportsOnly ? { skipExistingAliasAdds: true } : undefined,
    );
    const plan = flags.transportsOnly ? stripPlanForTransportsOnly(planned) : planned;
    printPlan(plan);
    const fromCredentialsIn =
      flags.credentialsIn && !flags.transportsOnly
        ? loadCredentialsIn(
            flags.credentialsIn,
            PROVISION_SPEC.users.map((user) => user.email),
            plan.usersToCreate.map((user) => user.email),
          )
        : null;
    if (!flags.apply) {
      console.log(
        flags.transportsOnly
          ? 'dry-run only (never prunes); pass --apply --transports-only to insert'
          : 'dry-run only (never prunes); pass --apply --credentials-out <path> to insert',
      );
      return;
    }
    if (flags.transportsOnly) {
      await applyProvision(db, plan, {});
      console.log('provision apply complete (insert-only; never prunes)');
      return;
    }
    await applyAfterReservingCredentialsFile({
      path: flags.credentialsOut,
      apply: async (writeCredentials) => {
        const credentials: Record<string, string> = {};
        if (fromCredentialsIn) {
          for (const user of plan.usersToCreate) {
            credentials[user.email] = fromCredentialsIn[user.email]!;
          }
        } else {
          for (const user of plan.usersToCreate) {
            credentials[user.email] = randomBytes(18).toString('base64url');
          }
        }
        await applyProvisionThenWriteCredentials(db, plan, credentials, (payload) => {
          writeCredentials(fromCredentialsIn ? redactCredentialsOut(payload) : payload);
        });
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
