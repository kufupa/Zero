/**
 * UI: open Organization Profiles, select first list row, click Billing Profiles tab/action.
 * Capture XHR paths + billing key names only. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_UI_BILL_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/ui-billing-click.v1.json';

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
  await page.waitForTimeout(4_000);

  const trace: string[] = [];

  // Soft-open FSOGPF first (A3 pattern) so UI list is live
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
    await fetch('/web/base/FSOGPF?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    await fetch('/web/base/FSOGPF.LST', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'FSOGPF',
      }).toString(),
    });
  });
  await page.waitForTimeout(2_000);
  trace.push('softOpen:FSOGPF');

  // Also open via menu for full Ext UI chrome
  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_000);
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
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Organization Profiles',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(4_000);
  trace.push('menu:Organization Profiles');

  const mark = xhr.length;

  // Click first grid row / List View row
  const rowClick = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        '.x-grid-row, .x-grid3-row, tr.x-grid-row, .x-grid-item',
      ),
    ];
    if (rows[0]) {
      (rows[0] as HTMLElement).click();
      (rows[0] as HTMLElement).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
      return { ok: true, n: rows.length };
    }
    return { ok: false, n: rows.length };
  });
  trace.push(`rowClick:${rowClick.ok}:n=${rowClick.n}`);
  await page.waitForTimeout(3_000);

  // Collect tab labels
  const tabsBefore = await page.evaluate(() =>
    [
      ...new Set(
        [
          ...document.querySelectorAll(
            '.x-tab-inner, .x-tab-button, a.x-tab, .x-btn-inner, span',
          ),
        ]
          .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t.length > 2 && t.length < 64)
          .filter((t) =>
            /billing|negotiat|auto.?transfer|note|prefer|contact|profile|record|list|contract|rate/i.test(
              t,
            ),
          ),
      ),
    ].slice(0, 60),
  );
  trace.push(`tabs:${tabsBefore.join('|')}`);

  // Click Billing Profiles
  const billClick = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner, span, a')].find(
      (n) => /billing\s*profiles?/i.test((n.textContent || '').trim()),
    );
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  });
  trace.push(`billingClick:${billClick}`);
  await page.waitForTimeout(3_500);

  // Also try Negotiated Rates / Auto Transfer
  for (const label of ['Negotiated Rates', 'Auto Transfer', 'Contracts']) {
    const hit = await page.evaluate((lab) => {
      const el = [
        ...document.querySelectorAll('.x-tab-inner, .x-btn-inner, span, a'),
      ].find((n) => (n.textContent || '').trim() === lab);
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    }, label);
    trace.push(`click:${label}:${hit}`);
    await page.waitForTimeout(2_000);
  }

  const xhrAfter = xhr.slice(mark);
  const paths = [...new Set(xhrAfter.map((x) => x.path))];

  // Soft-open any new fns harvested
  const newFns = [
    ...new Set(
      paths
        .map((p) => p.split('.')[0]!)
        .filter((fn) => !['LOGIN', 'BSSTRT', 'FSOGPF'].includes(fn)),
    ),
  ];
  const soft: Record<string, { status: number; bytes: number }> = {};
  for (const fn of newFns.slice(0, 10)) {
    soft[fn] = await page.evaluate(async (functionName) => {
      for (const path of ['/web/base/BSSTRT']) {
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
      return { status: r.status, bytes: (await r.text()).length };
    }, fn);
  }

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    trace,
    tabsBefore,
    xhrPaths: paths,
    xhrDetail: xhrAfter.slice(0, 40),
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
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) +
      '\n',
  );
  process.exit(1);
});
