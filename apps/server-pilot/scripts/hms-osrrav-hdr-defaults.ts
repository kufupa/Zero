/**
 * Extract OSRRAV.HDR chrome key names + More-menu labels (structure only).
 * HMS_DISCOVERY_ALLOW_LIVE=1 required.
 */
import { writeFile } from 'node:fs/promises';
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
  const outPath =
    process.env.HMS_OSRRAV_DEFAULTS_OUT ?? '/tmp/osrrav-hdr-defaults.sanitized.v1.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) {
      await route.abort();
      return;
    }
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await ctx.newPage();
  try {
    await page.goto(secret.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page
      .locator('input[name=userid], input[name=username], input[name=j_username]')
      .first()
      .fill(secret.username);
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    await page.waitForTimeout(4_000);
    await page.evaluate(async () => {
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'BSSTRT',
            USER_FUNCTION_NAME: 'BSSTRT',
            manurefresh: 'yes',
          }).toString(),
        }).catch(() => undefined);
      }
    });
    await page.waitForTimeout(1_500);

    const text = await page.evaluate(async () => {
      const r = await fetch('/web/base/OSRRAV.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      });
      return r.text();
    });

    const interestingMasked: Record<string, string> = {};
    for (const key of [
      'hoteldate',
      'firstcolumndate',
      'property',
      'salesstrategy',
      'currency',
      'extId',
      'rowpagesize',
      'pagemode',
      'startdate',
      'roomtypes',
      'rateplans',
      'showavailableforsale',
      'showunavailable',
    ]) {
      const re = new RegExp(
        `['"]?${key}['"]?\\s*[:=]\\s*['"]([^'"]{0,64})['"]`,
        'i',
      );
      const m = text.match(re);
      if (m?.[1]) interestingMasked[key] = m[1].replace(/\d/g, '#');
    }

    const keys = [
      ...new Set(
        [...text.matchAll(/['"]([A-Za-z][A-Za-z0-9_]{2,40})['"]\s*:/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];

    await page.getByText('More', { exact: true }).first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const afterMore = await page.evaluate(() =>
      [
        ...new Set(
          [...document.querySelectorAll('.x-menu-item-text, .x-btn-inner, span, a')]
            .map((n) => (n.textContent || '').trim())
            .filter(
              (t) =>
                t.length > 2 &&
                t.length < 64 &&
                /group|event|profile|company|booking|avail|sales|front|stay|room|account|organization|banquet/i.test(
                  t,
                ),
            ),
        ),
      ].slice(0, 80),
    );

    const out = {
      schemaVersion: 1,
      bytes: text.length,
      interestingMasked,
      keySample: keys
        .filter((k) =>
          /date|room|rate|propert|sales|curren|hotel|ext|page|avail|show/i.test(k),
        )
        .slice(0, 80),
      menuAfterMore: afterMore,
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, outPath, ...out }) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'failed';
  process.stderr.write(
    (/password|secret|cookie|arn:aws/i.test(msg) ? 'redacted_error' : msg.slice(0, 200)) +
      '\n',
  );
  process.exit(1);
});
