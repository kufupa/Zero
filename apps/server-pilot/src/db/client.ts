import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';
import { parseEnv } from '../env.js';
import { getPostgresSslOptions } from './ssl-config.js';

export type DB = PostgresJsDatabase<typeof schema>;
export type { Sql };

let cached: { db: DB; conn: Sql } | null = null;

/**
 * Test-only override: force `getDb()`/`getConn()` to return this handle
 * instead of lazily creating one from `DATABASE_URL`. Pass `null` to clear.
 *
 * Production code never calls this; it exists so transaction-rollback tests
 * can point the routes' `getDb()` calls at a tx-scoped drizzle handle.
 */
export function __setDbForTests(handle: { db: DB; conn: Sql } | null): void {
  cached = handle;
}

export function createDb(url: string): { db: DB; conn: Sql } {
  const conn = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });
  return { db, conn };
}

export function getDb(): DB {
  if (cached) return cached.db;
  const env = parseEnv(process.env);
  cached = createDb(env.DATABASE_URL);
  return cached.db;
}

export function getConn(): Sql {
  if (cached) return cached.conn;
  const env = parseEnv(process.env);
  cached = createDb(env.DATABASE_URL);
  return cached.conn;
}

export async function closeDb(): Promise<void> {
  if (!cached) return;
  await cached.conn.end();
  cached = null;
}
