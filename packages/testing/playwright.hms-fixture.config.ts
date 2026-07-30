/**
 * HMS fixture Playwright config — loopback-only, zero retries, fail on skip.
 * Disposable stack expected via webServer / env (fixture DB, fake S3, fixture HMS, server, mail UI).
 * Journeys in hms-draft-pipeline.spec.ts are API-level against claim-safe agent (no live HMS).
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawBase =
  process.env.PLAYWRIGHT_BASE_URL?.trim() || 'http://127.0.0.1:3000';

function assertLoopbackBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`HMS fixture Playwright: invalid baseURL ${url}`);
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(
      `HMS fixture Playwright refuses non-loopback baseURL (got host=${parsed.hostname}; require literal 127.0.0.1)`,
    );
  }
  return url;
}

const baseURL = assertLoopbackBaseUrl(rawBase);

export default defineConfig({
  testDir: './e2e',
  testMatch: /hms-draft-pipeline\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.resolve(__dirname, '../../.superpowers/sdd/hms-read-foundation/gates/playwright-hms-fixture.json') }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-hms-fixture',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
