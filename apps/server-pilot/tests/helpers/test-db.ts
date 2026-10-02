/**
 * Test DB helper: opens a configured disposable postgres DB and runs `cb`
 * inside a transaction that is rolled back at the end.
 *
 * HARD REFUSE: if DATABASE_URL / TEST_DATABASE_URL hostname contains
 * `nava-zero-mail-pilot`, this module always throws before connect.
 * No escape hatch exists. See tests/helpers/pilot-rds-guard.ts.
 *
 * Requires explicit disposable opt-in:
 *   TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1
 * Maps TEST_DATABASE_URL → DATABASE_URL for this process only when confirmed.
 * Ambient DATABASE_URL without CONFIRM is ignored (not used).
 * Never reads `.env` / `.env.production`. Never sources production env.
 */
import { getPostgresSslOptions } from '../../src/db/ssl-config.js';
import { assertNotPilotProdDatabase } from './pilot-rds-guard.js';
import * as schema from '../../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DB } from '../../src/db/client.js';
import postgres from 'postgres';

/** Local docker/disposable Postgres often has no TLS; RDS still uses CA SSL. */
function testDbSslOptions(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (sslmode === 'disable' || sslmode === 'allow' || sslmode === 'prefer') {
      return false as const;
    }
    const host = parsed.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return false as const;
    }
  } catch {
    /* fall through to RDS SSL */
  }
  return getPostgresSslOptions();
}

function resolveDisposableTestDatabaseUrl(): string | undefined {
  const confirm = process.env.CONFIRM_DISPOSABLE_TEST_DB === '1';
  const testUrl = process.env.TEST_DATABASE_URL?.trim() || undefined;

  if (!confirm) {
    // Refuse ambient DATABASE_URL / TEST_DATABASE_URL without disposable confirm.
    return undefined;
  }

  // Prefer TEST_DATABASE_URL; accept command-scoped DATABASE_URL only when
  // CONFIRM=1 and TEST unset (gate mapped URL onto vitest command).
  const url = testUrl ?? (process.env.DATABASE_URL?.trim() || undefined);
  if (!url) {
    throw new Error(
      'CONFIRM_DISPOSABLE_TEST_DB=1 requires TEST_DATABASE_URL (disposable non-pilot DB)',
    );
  }
  assertNotPilotProdDatabase(url);
  // Always overwrite DATABASE_URL from TEST when present (avoid mismatched leftover).
  process.env.DATABASE_URL = testUrl ?? url;
  return process.env.DATABASE_URL;
}

const resolvedUrl = resolveDisposableTestDatabaseUrl();
assertNotPilotProdDatabase(resolvedUrl);

export const TEST_DB_AVAILABLE = !!resolvedUrl;

/** Independent disposable DB session for real multi-session race tests. */
export function openTestDbSession(): {
  db: DB;
  close: () => Promise<void>;
} {
  if (!resolvedUrl) {
    throw new Error(
      'disposable TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1 required for test DB session',
    );
  }
  assertNotPilotProdDatabase(resolvedUrl);
  const conn = postgres(resolvedUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: testDbSslOptions(resolvedUrl),
  });
  return {
    db: drizzle(conn, { schema }),
    close: () => conn.end(),
  };
}

/**
 * HMS release gate: when HMS_DB_TEST_REQUIRED=1, missing disposable DB must throw
 * (fail closed). General suites retain skipIf(!TEST_DB_AVAILABLE) behavior.
 */
if (process.env.HMS_DB_TEST_REQUIRED === '1' && !resolvedUrl) {
  throw new Error(
    'HMS_DB_TEST_REQUIRED=1 but disposable TEST_DATABASE_URL/CONFIRM unset — fail closed (no skip)',
  );
}
if (process.env.INGESTION_DB_TEST_REQUIRED === '1' && !resolvedUrl) {
  throw new Error('Ingestion regressions require a reachable disposable DB (no skip)');
}
if (process.env.ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED === '1' && !resolvedUrl) {
  throw new Error('Rocketseed transactional tests require a reachable disposable DB');
}
if (process.env.OUTLOOK_V4_SECURITY_TEST_REQUIRED === '1' && !resolvedUrl) {
  throw new Error('Outlook v4 security tests require TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1');
}

let probePromise: Promise<boolean> | undefined;

async function probeDb(): Promise<boolean> {
  if (!resolvedUrl) return false;
  assertNotPilotProdDatabase(resolvedUrl);
  const conn = postgres(resolvedUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 4,
    ssl: testDbSslOptions(resolvedUrl),
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

if (process.env.INGESTION_DB_TEST_REQUIRED === '1' && !(await probeTestDb())) {
  throw new Error('Ingestion regressions require a reachable disposable DB (no skip)');
}
if (process.env.ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED === '1' && !(await probeTestDb())) {
  throw new Error('Rocketseed transactional tests require a reachable disposable DB');
}
if (process.env.OUTLOOK_V4_SECURITY_TEST_REQUIRED === '1' && !(await probeTestDb())) {
  throw new Error('Outlook v4 security tests require a reachable disposable PostgreSQL database');
}

const ROLLBACK = '___test_rollback___';

export async function withTestDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  if (!resolvedUrl) {
    throw new Error(
      'disposable TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1 required for withTestDb',
    );
  }
  assertNotPilotProdDatabase(resolvedUrl);
  const conn = postgres(resolvedUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: testDbSslOptions(resolvedUrl),
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
