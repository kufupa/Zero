import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CANONICAL_ORIGIN = 'https://nava.legacyhotels.co.za';
/** Set by playwright-real-mail-ui-gate.sh — AE1/AE7/AE9 against real transport. */
const realMailGate = process.env.REAL_MAIL_UI_GATE === '1';

if (!realMailGate) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const realMailBaseURL =
  configuredBaseURL === `${CANONICAL_ORIGIN}/` ? CANONICAL_ORIGIN : configuredBaseURL;
const ignoreHTTPSErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === '1';

if (realMailGate && !configuredBaseURL) {
  throw new Error('Real-mail Playwright requires PLAYWRIGHT_BASE_URL');
}
if (realMailGate && realMailBaseURL !== CANONICAL_ORIGIN) {
  throw new Error('Real-mail Playwright requires canonical HTTPS base URL');
}
if (realMailGate && ignoreHTTPSErrors) {
  throw new Error('Real-mail Playwright forbids ignored HTTPS errors');
}

export default defineConfig({
  testDir: realMailGate ? '../../apps/mail/tests/e2e' : './e2e',
  ...(realMailGate ? { testMatch: /real-mail-.*\.spec\.ts/ } : {}),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: realMailGate ? 0 : process.env.CI ? 2 : 0,
  workers: 1,
  ...(realMailGate ? { timeout: 180_000, expect: { timeout: 90_000 } } : {}),
  reporter: realMailGate ? [['line'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: realMailGate
      ? realMailBaseURL
      : (configuredBaseURL ?? 'http://localhost:3000'),
    ignoreHTTPSErrors,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: realMailGate
    ? [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'setup',
          testMatch: /.*\.setup\.ts/,
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'chromium',
          use: {
            ...devices['Desktop Chrome'],
            storageState: 'playwright/.auth/user.json',
          },
          dependencies: ['setup'],
        },
      ],
});
