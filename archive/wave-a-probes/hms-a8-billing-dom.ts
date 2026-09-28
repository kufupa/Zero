/**
 * After org row + Billing Profiles click: harvest DOM field names + ALL network.
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
    process.env.HMS_A8_DOM_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/billing-dom.v1.json';

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
  const net: { method: string; path: string; tab: string | null }[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    const tab = new URLSearchParams(body).get('CURRENT_TAB_NAME');
    net.push({ method: req.method(), path: m[1]!.toUpperCase(), tab });
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
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Organization Profiles',
    );
    if (el) (el as HTMLElement).click();
  });
  await page
    .locator('.x-grid-row, .x-grid3-row, .x-grid-item')
    .first()
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const markRow = net.length;
  await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('.x-grid-row, .x-grid3-row, .x-grid-item'),
    ] as HTMLElement[];
    if (!rows[0]) return;
    rows[0].scrollIntoView({ block: 'center' });
    rows[0].click();
    rows[0].dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }),
    );
  });
  await page.waitForTimeout(5_000);
  const afterRow = net.slice(markRow);

  const markBill = net.length;
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Billing Profiles',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(4_000);
  const afterBill = net.slice(markBill);

  const dom = await page.evaluate(() => {
    const inputs = [
      ...document.querySelectorAll('input, select, textarea, [name]'),
    ]
      .map((el) => ({
        tag: el.tagName,
        name: (el.getAttribute('name') || '').slice(0, 80),
        id: (el.getAttribute('id') || '').slice(0, 80),
        type: (el.getAttribute('type') || '').slice(0, 40),
      }))
      .filter((x) => x.name || x.id)
      .filter((x) =>
        /bill|pay|contract|term|mode|ar|agent|paper|account|settlement/i.test(
          `${x.name} ${x.id}`,
        ),
      )
      .slice(0, 80);
    const labels = [
      ...new Set(
        [...document.querySelectorAll('label, .x-form-item-label, span, td')]
          .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t.length > 2 && t.length < 60)
          .filter((t) =>
            /bill|pay|contract|term|mode|ar account|agent|paper|settlement/i.test(
              t,
            ),
          ),
      ),
    ].slice(0, 60);
    const htmlHitCounts: Record<string, number> = {};
    const html = document.documentElement?.innerHTML?.slice(0, 500_000) ?? '';
    for (const n of [
      'billingmode',
      'paymentterm',
      'paymentterms',
      'contractstatus',
      'billingprofiles',
      'araccount',
      'directbill',
      'agenttype',
      'payage',
    ]) {
      htmlHitCounts[n] = (html.match(new RegExp(n, 'gi')) || []).length;
    }
    return { inputs, labels, htmlHitCounts, htmlBytes: html.length };
  });

  // Negotiated Rates DOM too
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Negotiated Rates',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(3_000);
  const negoDom = await page.evaluate(() => {
    const labels = [
      ...new Set(
        [...document.querySelectorAll('label, .x-form-item-label, span, td')]
          .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t.length > 2 && t.length < 60)
          .filter((t) => /rate|negotiat|sell|currency|property|plan/i.test(t)),
      ),
    ].slice(0, 40);
    return { labels };
  });

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    afterRow,
    afterBill,
    billingDom: dom,
    negotiatedLabels: negoDom.labels,
    dodTrioInDom: {
      billingMode: dom.htmlHitCounts.billingmode > 0,
      paymentTermClass:
        dom.htmlHitCounts.paymentterm > 0 ||
        dom.htmlHitCounts.paymentterms > 0,
      contractStatus: dom.htmlHitCounts.contractstatus > 0,
    },
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
