/**
 * Orchestrator one-shot: inventory Guest Stay input names after live login.
 * Soft same-origin allow (abort mutate path keywords). Redacted keys only.
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') {
    throw new Error('refuse: credentialMode must be view_only');
  }
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(url).pathname.toLowerCase();
    if (/\/(save|delete|duplicate)|crs|checkin|checkout/.test(path)) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await ctx.newPage();
  try {
    const loginUrl = secret.loginUrl.includes('tenant=')
      ? secret.loginUrl
      : `${secret.loginUrl}${secret.loginUrl.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(secret.expectedTenant)}`;
    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.locator('input[name="userid"]').fill(secret.username);
    await page.locator('input[name="password"]').fill(secret.password);
    await page
      .locator('button, input[type="submit"]')
      .filter({ hasText: /sign in|log in|login/i })
      .first()
      .click({ timeout: 10_000 })
      .catch(async () => {
        await page.locator('input[name="password"]').press('Enter');
      });
    await page.waitForTimeout(6000);

    const clickLabel = async (want: string) => {
      await page.evaluate((label) => {
        for (const el of document.querySelectorAll('td,span,div,a')) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text === label) {
            (el as HTMLElement).click();
            return;
          }
        }
      }, want);
      await page.waitForTimeout(2500);
    };
    await clickLabel('Front Desk');
    await clickLabel('Guest Stay');
    await page.waitForTimeout(5000);

    const inv = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input,textarea,select')].map(
        (el) => {
          const i = el as HTMLInputElement;
          return {
            tag: el.tagName,
            type: i.type || '',
            name: (i.name || '').slice(0, 60),
            id: (i.id || '').slice(0, 60),
            placeholder: (i.placeholder || '').slice(0, 40),
          };
        },
      );
      return {
        title: document.title.slice(0, 80),
        iframeCount: document.querySelectorAll('iframe').length,
        inputCount: inputs.length,
        named: inputs.filter((x) => x.name).slice(0, 100),
        ids: inputs.filter((x) => x.id && !x.name).slice(0, 40),
        labels: [...document.querySelectorAll('label')]
          .map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, 50),
      };
    });
    console.log(JSON.stringify(inv, null, 2));
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    /password|secret|cookie|jsessionid/i.test(msg)
      ? 'redacted_error'
      : msg.slice(0, 200),
  );
  process.exit(1);
});
