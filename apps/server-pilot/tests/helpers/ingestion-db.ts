import { getPostgresSslOptions } from '../../src/db/ssl-config.js';
import { assertNotPilotProdDatabase } from './pilot-rds-guard.js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from '../../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DB } from '../../src/db/client.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const testUrl = process.env.TEST_DATABASE_URL?.trim();
assertNotPilotProdDatabase(testUrl);
if (!testUrl || process.env.CONFIRM_DISPOSABLE_TEST_DB !== '1') {
  throw new Error('Ingestion regressions require TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1');
}
const confirmedUrl = testUrl;
const migrationFiles = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
});

function connection(url: string) {
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return postgres(url, {
    max: 1,
    connect_timeout: 5,
    ssl:
      local || parsed.searchParams.get('sslmode') === 'disable' ? false : getPostgresSslOptions(),
    onnotice: () => undefined,
  });
}

/** Each callback owns an entire database; schema drift cannot leak into another suite. */
export async function withIngestionDb<T>(
  cb: (context: {
    db: DB;
    sql: ReturnType<typeof postgres>;
    url: string;
    openConnection: () => ReturnType<typeof postgres>;
  }) => Promise<T>,
  options: { through?: number; seed?: boolean } = {},
): Promise<T> {
  const admin = connection(confirmedUrl);
  const name = `zero_ingestion_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(confirmedUrl);
  url.pathname = `/${name}`;
  let sql: ReturnType<typeof postgres> | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    sql = connection(url.toString());
    await sql`CREATE SCHEMA drizzle`;
    await sql`CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    // PostgreSQL enum values become usable only after the introducing migration commits.
    for (const migration of migrationFiles.slice(
      0,
      (options.through ?? migrationFiles.length - 1) + 1,
    )) {
      await sql.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`;
      });
    }
    const db = drizzle(sql, { schema });
    if (options.seed !== false) {
      await db.insert(schema.mailIngestMailbox).values({
        id: 'ingest-nava-legacy',
        email: 'navaai@legacyhotels.co.za',
      });
      await db.insert(schema.mailboxTransport).values({
        id: 'transport-centurion',
        email: 'centurion@legacyhotels.co.za',
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        mailboxType: 'personal',
        sendFromConfig: { aliases: ['centurion@legacyhotel.com'] },
      });
    }
    return await cb({ db, sql, url: url.toString(), openConnection: () => connection(url.toString()) });
  } finally {
    await sql?.end();
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
