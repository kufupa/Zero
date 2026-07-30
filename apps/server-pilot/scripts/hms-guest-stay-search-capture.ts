/**
 * Soft-allow capture of Guest Stay search POST shapes (key lengths only).
 * Abort mutation paths. Never logs credential/cookie/body values.
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
  const captures: Array<{
    path: string;
    status: number | 'pending';
    bodyBytes: number;
    bodyLens: Record<string, number>;
  }> = [];

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(url).pathname;
    if (/\/(save|delete|duplicate)|crs|checkin|checkout/i.test(path)) {
      await route.abort();
      return;
    }
    if (
      req.method() === 'POST' &&
      (path.includes('OSRESV.HDR') ||
        path.includes('OSRESS.search') ||
        path.includes('OSRESV.LST') ||
        path.includes('OSRESS'))
    ) {
      const raw = req.postData() || '';
      const params = new URLSearchParams(raw);
      const bodyLens: Record<string, number> = {};
      for (const [k, v] of params.entries()) {
        bodyLens[k] = String(v).length;
      }
      captures.push({
        path,
        status: 'pending',
        bodyBytes: raw.length,
        bodyLens,
      });
    }
    await route.continue();
  });
  const page = await ctx.newPage();
  page.on('response', (r) => {
    try {
      const path = new URL(r.url()).pathname;
      const last = [...captures]
        .reverse()
        .find((c) => c.path === path && c.status === 'pending');
      if (last) last.status = r.status();
    } catch {
      /* ignore */
    }
  });

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

    const search = page.locator('input[name="search"]').first();
    await search.fill('NOTFOUND-CANARY');
    await search.press('Enter');
    await page.waitForTimeout(5000);

    const hints = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return {
        hasNoResults:
          /no (reservations|records|results|data to display|matching)|0 (records|items)|not found/.test(
            t,
          ),
        hasGuestStay: /guest stay|confirmation/.test(t),
        searchValueLen: (
          document.querySelector(
            'input[name="search"]',
          ) as HTMLInputElement | null
        )?.value?.length,
        bodySnippet: t.slice(0, 240),
      };
    });

    console.log(JSON.stringify({ captures, hints }, null, 2));
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
