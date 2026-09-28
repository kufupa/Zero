/**
 * A8 UI-only: menu Organization Profiles → wait grid → open row → Billing Profiles.
 * No prior soft-open (avoid Ext chrome miss). HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A8_UI2_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/ui-billing-click2.v1.json';

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
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const xhr: { path: string; keys: string[] }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    xhr.push({
      path: m[1]!.toUpperCase(),
      keys: [...new Set([...body.matchAll(/([A-Z_]{2,40})=/g)].map((x) => x[1]!))].slice(
        0,
        40,
      ),
    });
  });

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
  await page.waitForTimeout(5_000);

  const trace: string[] = [];
  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Profiles',
    );
    if (el) {
      (el as HTMLElement).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      (el as HTMLElement).click();
    }
  });
  await page.waitForTimeout(1_500);
  const mark = xhr.length;
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Organization Profiles',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(6_000);
  trace.push('opened:Organization Profiles');

  // Wait for any grid-like rows
  const gridWait = await page
    .locator('.x-grid-row, .x-grid3-row, .x-grid-item, table.x-grid3-row-table tr')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  trace.push(`gridVisible:${gridWait}`);

  const rowCount = await page
    .locator('.x-grid-row, .x-grid3-row, .x-grid-item')
    .count()
    .catch(() => 0);
  trace.push(`rowCount:${rowCount}`);

  if (rowCount > 0) {
    await page.locator('.x-grid-row, .x-grid3-row, .x-grid-item').first().dblclick({
      force: true,
      timeout: 8_000,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    trace.push('dblclick:row0');
  } else {
    // Fallback: click List View then any table row
    await page.getByText('List View', { exact: true }).first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const anyRow = page.locator('tr').filter({ hasText: /.+/ }).nth(2);
    await anyRow.dblclick({ force: true }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    trace.push('fallback:listViewRow');
  }

  const tabLabels = await page.evaluate(() =>
    [
      ...new Set(
        [
          ...document.querySelectorAll(
            '.x-tab-inner, .x-tab-button, .x-btn-inner, a.x-tab',
          ),
        ]
          .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t.length > 1 && t.length < 64),
      ),
    ].slice(0, 80),
  );
  trace.push(`tabs:${tabLabels.join('|')}`);

  for (const label of [
    'Billing Profiles',
    'Negotiated Rates',
    'Auto Transfer',
    'Record View',
    'List View',
  ]) {
    const hit = await page
      .getByText(label, { exact: true })
      .first()
      .click({ force: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    trace.push(`click:${label}:${hit}`);
    await page.waitForTimeout(2_500);
  }

  const xhrAfter = xhr.slice(mark);
  const paths = [...new Set(xhrAfter.map((x) => x.path))];
  const newFns = [
    ...new Set(
      paths
        .map((p) => p.split('.')[0]!)
        .filter((fn) => !['LOGIN', 'BSSTRT'].includes(fn)),
    ),
  ];

  // Soft-open new fns with fresh warm
  const soft: Record<string, { status: number; bytes: number; stub813: boolean }> =
    {};
  for (const fn of newFns) {
    soft[fn] = await page.evaluate(async (functionName) => {
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
      const r = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      const text = await r.text();
      return {
        status: r.status,
        bytes: text.length,
        stub813: text.length === 813,
      };
    }, fn);
  }

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    trace,
    tabLabels,
    xhrPaths: paths,
    xhrDetail: xhrAfter.slice(0, 50),
    newFns,
    soft,
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, outPath, ...out }) + '\n');
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    msg.replace(/arn:aws:\S+/gi, '[arn]').slice(0, 240) + '\n',
  );
  process.exit(1);
});
