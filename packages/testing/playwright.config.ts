import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/** Set by playwright-real-mail-ui-gate.sh — AE1/AE7/AE9 against real transport. */
const realMailGate = process.env.REAL_MAIL_UI_GATE === '1';

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
    baseURL:
      process.env.PLAYWRIGHT_BASE_URL ||
      (realMailGate ? 'https://127.0.0.1' : 'http://localhost:3000'),
    ignoreHTTPSErrors:
      process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === '1' || realMailGate,
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
