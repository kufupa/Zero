/**
 * Soft-open tax invoice list candidates (OSTXI/OSTAX/OSINV/…).
 * A3 deepen after PSSNEL. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A3_TAX_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a3-payload/tax-invoice-softopen.v1.json';

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
  const net: { path: string; tab: string | null }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    net.push({
      path: m[1]!.toUpperCase(),
      tab: new URLSearchParams(req.postData() ?? '').get('CURRENT_TAB_NAME'),
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

  // Soft-open tax candidates BEFORE menu (A3 unlock)
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
    const codes = [
      'OSTXI',
      'OSTAX',
      'OSINV',
      'PSTXI',
      'PSTAX',
      'PSINV',
      'ARTXI',
      'ARTAX',
      'ARINV',
      'OSTXIV',
      'OSTXIL',
      'OSINVL',
      'PSSNEL',
    ];
    const probes: Record<
      string,
      { status: number; bytes: number; keyHits: string[]; head: string }
    > = {};
    for (const fn of codes) {
      await fetch(`/web/base/${fn}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: fn,
          USER_FUNCTION_NAME: fn,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      }).catch(() => undefined);
      for (const tab of ['', 'HDR', 'LST']) {
        const path = tab ? `${fn}.${tab}` : fn;
        try {
          const r = await fetch(`/web/base/${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: fn,
              USER_FUNCTION_NAME: fn,
              CURRENT_TAB_NAME: tab,
              ...(tab === 'LST'
                ? {
                    COMPONENT_INFO_TYPE: 'DATA_ONLY',
                    GRID_NAME: fn,
                  }
                : {}),
            }).toString(),
          });
          const text = await r.text();
          const keyHits = [
            ...new Set(
              [
                ...text.matchAll(
                  /"(tax[^"]*|invoice[^"]*|folio[^"]*|document[^"]*|amount[^"]*|status[^"]*|currency[^"]*)"/gi,
                ),
              ].map((m) => m[1]!),
            ),
          ].slice(0, 30);
          probes[path] = {
            status: r.status,
            bytes: text.length,
            keyHits,
            head: text
              .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
              .replace(/\d{6,}/g, '[n]')
              .slice(0, 160),
          };
        } catch {
          probes[path] = { status: 0, bytes: 0, keyHits: [], head: '' };
        }
      }
    }
    return probes;
  });

  // Menu harvest: More → look for Tax / Invoice
  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_000);
  const menuLabels = await page.evaluate(() => {
    return [...document.querySelectorAll('.x-menu-item-text, span, a')]
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t && t.length < 60)
      .filter((t) => /tax|invoice|account|receiv|folio|document|report/i.test(t))
      .slice(0, 40);
  });

  const real = Object.entries(soft)
    .filter(
      ([, v]) =>
        v.status === 200 &&
        v.bytes > 2000 &&
        v.keyHits.some((k) => /tax|invoice/i.test(k)),
    )
    .map(([path, v]) => ({
      path,
      bytes: v.bytes,
      keyHits: v.keyHits,
    }));

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    menuLabels,
    softSummary: Object.fromEntries(
      Object.entries(soft).map(([k, v]) => [
        k,
        `${v.status}/${v.bytes}/keys=${v.keyHits.length}`,
      ]),
    ),
    real,
    netSample: net.slice(0, 40),
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      menuLabels,
      real,
      softHits: Object.entries(soft)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000)
        .map(([k, v]) => `${k}:${v.bytes}`),
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
