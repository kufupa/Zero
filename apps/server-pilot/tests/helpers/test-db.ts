/**
 * Test DB helper: opens a drizzle postgres-js DB to the same RDS instance
 * used in production and runs `cb` inside a transaction that is rolled back
 * at the end, so tests never pollute the pilot seed.
 *
 * Requires `DATABASE_URL` in env AND that the host is reachable. If the host
 * is not reachable (e.g. running tests on a laptop outside the VPC), tests
 * skip via `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`.
 *
 * Strategy: `db.transaction(tx => ...)` — drizzle rolls back automatically
 * when the callback rejects. We always reject with a sentinel after the
 * user callback resolves so the rollback is unconditional.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema/index.js';
import type { DB } from '../../src/db/client.js';
import { getPostgresSslOptions } from '../../src/db/ssl-config.js';

export const TEST_DB_AVAILABLE = !!process.env.DATABASE_URL;

let probePromise: Promise<boolean> | undefined;

async function probeDb(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
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

const ROLLBACK = '___test_rollback___';

export async function withTestDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required for withTestDb');
  }
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
