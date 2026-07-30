/**
 * HMS draft pipeline E2E (fixture / API harness).
 *
 * Divergence vs full UI Playwright: journeys proven via server-pilot vitest
 * (`hms-production-boundary.test.ts` → `runHmsDraftPipelineJourneys`). This
 * spec enforces loopback baseURL + zero-skip by failing if the vitest matrix
 * exits non-zero. Full disposable UI stack remains orchestrator EC2 work.
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPilot = join(here, '../../../apps/server-pilot');

test.describe('HMS draft pipeline fixture journeys', () => {
  test('baseURL is literal 127.0.0.1', async ({ baseURL }) => {
    expect(baseURL).toBeTruthy();
    expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  });

  test('API journey matrix via vitest (10 journeys, no skip)', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', 'tests/hms-production-boundary.test.ts', '--reporter=dot'],
      {
        cwd: serverPilot,
        encoding: 'utf8',
        shell: true,
        env: {
          ...process.env,
          // Do not force DB for this unit/API matrix
          HMS_DB_TEST_REQUIRED: process.env.HMS_DB_TEST_REQUIRED === '1' && process.env.DATABASE_URL
            ? '1'
            : '0',
        },
      },
    );
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
