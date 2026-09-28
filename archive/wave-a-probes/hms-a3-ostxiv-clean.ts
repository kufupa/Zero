/**
 * Clean soft-open OSTXIV (Tax Invoice) alone — A3 unlock, no sibling probes.
 * Also UI: More → Front Desk → Tax Invoice XHR harvest.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A3_TAX_CLEAN_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a3-payload/ostxiv-clean.v1.json';

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
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const net: {
    path: string;
    tab: string | null;
    keys: string[];
  }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? '');
    net.push({
      path: m[1]!.toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      keys: [...params.keys()].slice(0, 40),
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

  // Clean soft-open OSTXIV only
  const soft = await page.evaluate(async () => {
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
    const probes: Record<
      string,
      { status: number; bytes: number; keyHits: string[]; head: string }
    > = {};
    const open = await fetch('/web/base/OSTXIV?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSTXIV',
        USER_FUNCTION_NAME: 'OSTXIV',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const openText = await open.text();
    probes['OSTXIV.open'] = {
      status: open.status,
      bytes: openText.length,
      keyHits: [
        ...new Set(
          [
            ...openText.matchAll(
              /"(tax[^"]*|invoice[^"]*|folio[^"]*|amount[^"]*|status[^"]*|currency[^"]*)"/gi,
            ),
          ].map((m) => m[1]!),
        ),
      ].slice(0, 40),
      head: openText
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\d{6,}/g, '[n]')
        .slice(0, 200),
    };
    for (const tab of ['HDR', 'LST']) {
      const r = await fetch(`/web/base/OSTXIV.${tab}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSTXIV',
          USER_FUNCTION_NAME: 'OSTXIV',
          CURRENT_TAB_NAME: tab,
          ...(tab === 'LST'
            ? { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: 'OSTXIV' }
            : {}),
        }).toString(),
      });
      const text = await r.text();
      probes[`OSTXIV.${tab}`] = {
        status: r.status,
        bytes: text.length,
        keyHits: [
          ...new Set(
            [
              ...text.matchAll(
                /"(tax[^"]*|invoice[^"]*|folio[^"]*|amount[^"]*|status[^"]*|currency[^"]*|balance[^"]*|gross[^"]*|vat[^"]*|net[^"]*)"/gi,
              ),
            ].map((m) => m[1]!),
          ),
        ].slice(0, 50),
        head: text
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
          .replace(/\d{6,}/g, '[n]')
          .slice(0, 200),
      };
    }
    // control: PSSNEL early too
    await fetch('/web/base/PSSNEL?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        USER_FUNCTION_NAME: 'PSSNEL',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const pss = await fetch('/web/base/PSSNEL.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        USER_FUNCTION_NAME: 'PSSNEL',
        CURRENT_TAB_NAME: 'HDR',
      }).toString(),
    });
    const pssText = await pss.text();
    probes['PSSNEL.HDR'] = {
      status: pss.status,
      bytes: pssText.length,
      keyHits: [],
      head: pssText
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\d{6,}/g, '[n]')
        .slice(0, 120),
    };
    return probes;
  });

  // UI Front Desk → Tax Invoice
  const mark = net.length;
  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Front Desk',
    );
    if (el) {
      (el as HTMLElement).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      (el as HTMLElement).click();
    }
  });
  await page.waitForTimeout(1_500);
  const fdLabels = await page.evaluate(() => {
    return [...document.querySelectorAll('.x-menu-item-text, span, a')]
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t && t.length < 50)
      .filter((t) =>
        /tax|invoice|account|guest|check|folio|email|sent/i.test(t),
      )
      .slice(0, 40);
  });
  const taxClick = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => /^Tax Invoice/i.test((n.textContent || '').trim()),
    );
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  });
  await page.waitForTimeout(5_000);
  const after = net.slice(mark);

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    soft,
    fdLabels,
    taxClick,
    afterPosts: after.slice(0, 40),
    harvestedPaths: [...new Set(after.map((n) => n.path))],
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      softSummary: Object.fromEntries(
        Object.entries(soft).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/keys=${v.keyHits.length}`,
        ]),
      ),
      softReal: Object.entries(soft)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000)
        .map(([k, v]) => ({
          path: k,
          bytes: v.bytes,
          keyHits: v.keyHits.slice(0, 25),
        })),
      fdLabels,
      taxClick,
      harvestedPaths: payload.harvestedPaths,
      afterPosts: after.slice(0, 20),
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    msg.replace(/arn:aws:\S+/gi, '[arn]').slice(0, 240) + '\n',
  );
  process.exit(1);
});
