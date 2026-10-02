import {
  assertMigrationCompatibility,
  MigrationCompatibilityError,
} from '../src/db/migration-compatibility.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('Migration compatibility refused: DATABASE_URL required');
  process.exitCode = 1;
} else {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    ssl: getPostgresSslOptions(databaseUrl),
    onnotice: () => undefined,
  });
  try {
    await assertMigrationCompatibility(sql);
    console.log('Database compatible with committed migrations and application schema');
  } catch (error) {
    // Connection errors may embed credentials. Only our schema diagnostics are public.
    const reason =
      error instanceof MigrationCompatibilityError ? error.message : 'database check failed';
    console.error(`Migration compatibility refused: ${reason}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
