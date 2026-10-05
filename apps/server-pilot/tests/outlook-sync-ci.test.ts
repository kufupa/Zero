import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
vi.setConfig({ testTimeout: 30000 });
const root = fileURLToPath(new URL('../', import.meta.url));
function probe(env: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      "import('./scripts/outlook-sync-test-gate.ts').then(m=>m.assertOutlookSyncTestDatabase()).catch(e=>{console.error(e.message);process.exit(1)})",
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: undefined,
        CONFIRM_DISPOSABLE_TEST_DB: undefined,
        VITEST_ALLOW_PILOT_RDS: undefined,
        ...env,
      },
    },
  );
}
describe('required Outlook sync verification gate', () => {
  it('fails without explicit disposable DB and refuses nonlocal databases before connect', () => {
    for (const env of [
      {},
      { TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:55441/outlook_sync_test' },
      {
        CONFIRM_DISPOSABLE_TEST_DB: '1',
        TEST_DATABASE_URL: 'postgres://postgres@rds.example.com/db',
      },
      {
        CONFIRM_DISPOSABLE_TEST_DB: '1',
        TEST_DATABASE_URL: 'postgres://postgres@nava-zero-mail-pilot.aws/db',
      },
    ]) {
      const result = probe(env);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('Cannot find module');
      expect(result.stderr).toMatch(/require explicit disposable|must be local|Refusing vitest/i);
    }
  });
  it('fails a confirmed unreachable disposable DB instead of skipping persistence', () => {
    const result = probe({
      CONFIRM_DISPOSABLE_TEST_DB: '1',
      TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:1/unused?sslmode=disable',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reachable/);
  });
  it('accepts a reachable local disposable database and no ambient database authority', () => {
    const result = probe({
      CONFIRM_DISPOSABLE_TEST_DB: '1',
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    expect(result.status).toBe(0);
  });
  it('rejects report success with required skipped/todo tests or no tests', async () => {
    const { assertOutlookSyncTestResults } = await import('../scripts/outlook-sync-test-gate.js');
    const ok = {
      success: true,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTests: 1,
    };
    expect(() => assertOutlookSyncTestResults(ok)).not.toThrow();
    for (const delta of [
      { numPendingTests: 1 },
      { numTodoTests: 1 },
      { numFailedTests: 1 },
      { numTotalTests: 0 },
    ])
      expect(() => assertOutlookSyncTestResults({ ...ok, ...delta })).toThrow('Required');
  });
  it('discovers every current and future sync test filename without duplicates and retains required safety suites', async () => {
    const { discoverOutlookSyncSuites } = await import('../scripts/outlook-sync-test-gate.js');
    const suites = discoverOutlookSyncSuites([
      'outlook-sync-ci.test.ts',
      'outlook-sync-future-regression.test.ts',
      'outlook-sync-ci.test.ts',
      'unrelated.test.ts',
      'outlook-sync-helper.ts',
    ]);
    expect(suites).toContain('tests/outlook-sync-future-regression.test.ts');
    expect(suites).toContain('tests/outlook-sync-ci.test.ts');
    expect(suites).not.toContain('tests/unrelated.test.ts');
    expect(suites).not.toContain('tests/outlook-sync-helper.ts');
    expect(new Set(suites).size).toBe(suites.length);
    for (const name of [
      'mail-retention-lifecycle',
      's3-stream',
      'migration-compatibility',
      'outlook-security-retention',
      'outlook-bridge-authorization',
      'outlook-device-enrollment',
    ])
      expect(suites).toContain('tests/' + name + '.test.ts');
  });
  it('package runs the required gate and includes every sync suite plus retention/migration evidence', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['test:outlook-sync']).toBe('tsx scripts/outlook-sync-test-gate.ts');
    const gate = readFileSync(
      new URL('../scripts/outlook-sync-test-gate.ts', import.meta.url),
      'utf8',
    );
    expect(gate).toContain('discoverOutlookSyncSuites(await readdir(');
    const names = readdirSync(new URL('./', import.meta.url));
    expect(names).toContain('outlook-sync-e2e.test.ts');
    expect(names).toContain('outlook-sync-quota.test.ts');
    expect(gate).toContain('readMigrationFiles(');
    expect(gate).toContain('await connection.begin(');
    expect(gate).toContain('../drizzle/');
    expect(gate).toContain('numPendingTests');
    expect(gate).toContain('OUTLOOK_SYNC_TEST_REQUIRED');
  });
  it('CI always runs isolated PostgreSQL sync gate and expands private exact native gitlink detection', () => {
    const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const job = ci.split('  outlook-sync:')[1];
    expect(job).toBeDefined();
    expect(job).toContain('image: postgres:16');
    expect(job).toContain('Require read-only private Outlook source access');
    expect(job).toContain('ref: ${{ steps.native.outputs.gitlink_sha }}');
    expect(job).toContain('path: apps/server-pilot/vsto');
    expect(job).toContain('persist-credentials: false');
    expect(job).toContain('Verify the native checkout matches the gitlink');
    expect(job.indexOf('Checkout exact private Outlook add-in gitlink')).toBeLessThan(
      job.indexOf('run test:outlook-sync'),
    );
    expect(job).toContain('run test:outlook-sync');
    expect(job).toContain('CONFIRM_DISPOSABLE_TEST_DB=1');
    expect(job).toContain('unset DATABASE_URL');
    for (const path of [
      'tests/outlook-sync-progress.test.tsx',
      'tests/outlook-sync-client.test.tsx',
      'tests/outlook-pane-onboarding.test.tsx',
    ])
      expect(ci).toContain(path);
    for (const path of [
      'apps/server-pilot/src/outlook-sync',
      'apps/server-pilot/src/http/outlook-sync-native.ts',
      'apps/server-pilot/src/db/schema/outlook-sync.ts',
      'apps/server-pilot/tests/outlook-sync',
    ])
      expect(ci).toContain(path);
  });
});
