/**
 * Test DB helper: opens a configured disposable postgres DB and runs `cb`
 * inside a transaction that is rolled back at the end.
 *
 * HARD REFUSE: if DATABASE_URL hostname contains `nava-zero-mail-pilot`,
 * this module always throws before connect. No escape hatch exists.
 * See tests/helpers/pilot-rds-guard.ts.
 *
 * Requires `DATABASE_URL` in env AND that the host is reachable. If unset,
 * loads `apps/server-pilot/.env` silently (no secret logging). If the host
 * is not reachable (e.g. running tests on a laptop outside the VPC), tests
 * skip via `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`.
 *
 * Strategy: `db.transaction(tx => ...)` — drizzle rolls back automatically
 * when the callback rejects. We always reject with a sentinel after the
 * user callback resolves so the rollback is unconditional.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema/index.js';
import type { DB } from '../../src/db/client.js';
import { getPostgresSslOptions } from '../../src/db/ssl-config.js';
import { assertNotPilotProdDatabase } from './pilot-rds-guard.js';

function loadTestEnvFromDotenv(): void {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(fileURLToPath(new URL('../..', import.meta.url)), '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadTestEnvFromDotenv();
assertNotPilotProdDatabase(process.env.DATABASE_URL);

export const TEST_DB_AVAILABLE = !!process.env.DATABASE_URL;

/**
 * HMS release gate: when HMS_DB_TEST_REQUIRED=1, missing DATABASE_URL must throw
 * (fail closed). General suites retain skipIf(!TEST_DB_AVAILABLE) behavior.
 */
if (process.env.HMS_DB_TEST_REQUIRED === '1' && !process.env.DATABASE_URL) {
  throw new Error(
    'HMS_DB_TEST_REQUIRED=1 but DATABASE_URL is unset — fail closed (no skip)',
  );
}

let probePromise: Promise<boolean> | undefined;

async function probeDb(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
  const conn = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 4,
    ssl: getPostgresSslOptions(),
  });
  try {
    await conn`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/** Probe once; safe to call multiple times. */
export function probeTestDb(): Promise<boolean> {
  if (!probePromise) probePromise = probeDb();
  return probePromise;
}

/** Open one independent disposable-DB connection for concurrency tests. */
export function openTestDbConnection(): {
  db: DB;
  close: () => Promise<void>;
} {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required for openTestDbConnection');
  }
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
  const conn = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  return {
    db: drizzle(conn, { schema }),
    close: () => conn.end(),
  };
}

const ROLLBACK = '___test_rollback___';

export async function withTestDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required for withTestDb');
  }
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
  const conn = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  let userResult: T | undefined;
  try {
    try {
      await db.transaction(async (tx) => {
        userResult = await cb(tx as unknown as DB);
        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (err instanceof Error && err.message === ROLLBACK) {
        // expected — rollback triggered
      } else {
        throw err;
      }
    }
  } finally {
    await conn.end();
  }
  return userResult as T;
}

/**
 * Variant that seeds inside the rollback transaction so callers see the
 * seeded rows. The whole transaction is rolled back at the end.
 */
export async function withSeededTestDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  return withTestDb(async (db) => {
    const { seedAll } = await import('../../src/db/seed.js');
    await seedAll(db);
    return cb(db);
  });
}
