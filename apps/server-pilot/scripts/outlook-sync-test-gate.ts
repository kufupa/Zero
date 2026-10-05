/** Required server sync proof: explicit local disposable PostgreSQL, real migrations, no skips. */
import { assertNotPilotProdDatabase } from '../tests/helpers/pilot-rds-guard.js';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';

export async function assertOutlookSyncTestDatabase(): Promise<string> {
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
  assertNotPilotProdDatabase(process.env.TEST_DATABASE_URL);
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || process.env.CONFIRM_DISPOSABLE_TEST_DB !== '1')
    throw new Error(
      'Outlook sync tests require explicit disposable TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1',
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid disposable database URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('Outlook sync test database must be local disposable PostgreSQL');
  const connection = postgres(raw, {
    ssl: false,
    max: 1,
    connect_timeout: 4,
    onnotice: () => undefined,
  });
  try {
    await connection`SELECT 1`;
  } catch {
    throw new Error('Outlook sync tests require reachable disposable PostgreSQL');
  } finally {
    await connection.end({ timeout: 1 });
  }
  return raw;
}
const safetySuites = [
  'tests/mail-retention-lifecycle.test.ts',
  'tests/s3-stream.test.ts',
  'tests/migration-compatibility.test.ts',
  'tests/outlook-security-retention.test.ts',
  'tests/outlook-bridge-authorization.test.ts',
  'tests/outlook-device-enrollment.test.ts',
];
export function discoverOutlookSyncSuites(filenames: readonly string[]): string[] {
  const sync = filenames
    .filter((name) => /^outlook-sync-[A-Za-z0-9_.-]+\.test\.ts$/.test(name))
    .map((name) => 'tests/' + name);
  return [...new Set([...sync, ...safetySuites])].sort();
}
export function assertOutlookSyncTestResults(result: {
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  numTotalTests: number;
  success: boolean;
}) {
  if (
    !result.success ||
    result.numFailedTests ||
    result.numPendingTests ||
    result.numTodoTests ||
    !result.numTotalTests
  )
    throw new Error('Required Outlook sync tests must pass without pending, skipped or todo tests');
}
async function main() {
  const database = await assertOutlookSyncTestDatabase();
  const suites = discoverOutlookSyncSuites(await readdir(new URL('../tests/', import.meta.url)));
  const connection = postgres(database, {
    ssl: false,
    max: 1,
    connect_timeout: 4,
    onnotice: () => undefined,
  });
  try {
    // Commit each revision independently: newly added enum values cannot be used in the introducing transaction.
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
    });
    await connection`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await connection`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    const applied = await connection<
      { hash: string; created_at: string }[]
    >`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    for (const record of applied) {
      if (
        !migrations.some(
          (migration) =>
            String(migration.folderMillis) === String(record.created_at) &&
            migration.hash === record.hash,
        )
      )
        throw new Error('Disposable test database migration journal does not match source');
    }
    for (const migration of migrations) {
      if (applied.some((record) => String(record.created_at) === String(migration.folderMillis)))
        continue;
      await connection.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES (${migration.hash},${migration.folderMillis})`;
      });
    }
  } finally {
    await connection.end();
  }
  const scratch = await mkdtemp(join(tmpdir(), 'outlook-sync-gate-'));
  const report = join(scratch, 'tests.json');
  try {
    const env = {
      ...process.env,
      TEST_DATABASE_URL: database,
      CONFIRM_DISPOSABLE_TEST_DB: '1',
      OUTLOOK_SYNC_TEST_REQUIRED: '1',
      OUTLOOK_V4_SECURITY_TEST_REQUIRED: '1',
    };
    delete env.DATABASE_URL;
    delete env.VITEST_ALLOW_PILOT_RDS;
    const child = spawn(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--maxWorkers=1',
        '--testTimeout=30000',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${report}`,
        ...suites,
      ],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', env },
    );
    const status = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (value) => resolve(value ?? 1));
    });
    if (status !== 0) throw new Error(`Required Outlook sync tests failed (${status})`);
    const result = JSON.parse(await readFile(report, 'utf8')) as {
      numFailedTests: number;
      numPendingTests: number;
      numTodoTests: number;
      numTotalTests: number;
      success: boolean;
    };
    assertOutlookSyncTestResults(result);
    console.log(`Required Outlook sync gate passed: ${result.numTotalTests} tests, zero skips`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
