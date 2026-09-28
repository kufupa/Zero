/**
 * After Organization Profiles row open, click Billing Profiles and capture
 * CURRENT_TAB_NAME / paths from XHR. Soft-open harvested tab codes.
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
    process.env.HMS_A8_TAB_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/billing-tab-xhr.v1.json';

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
  const xhr: {
    path: string;
    currentTab: string | null;
    gridName: string | null;
    component: string | null;
    allKeys: string[];
  }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    const params = new URLSearchParams(body);
    xhr.push({
      path: m[1]!.toUpperCase(),
      currentTab: params.get('CURRENT_TAB_NAME'),
      gridName: params.get('GRID_NAME'),
      component: params.get('COMPONENT_INFO_TYPE'),
      allKeys: [...params.keys()].slice(0, 40),
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
  const rowOpen = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        '.x-grid-row, .x-grid3-row, .x-grid-item',
      ),
    ] as HTMLElement[];
    if (!rows[0]) return { ok: false, n: 0 };
    rows[0].scrollIntoView({ block: 'center' });
    rows[0].click();
    rows[0].dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }),
    );
    return { ok: true, n: rows.length };
  });
  await page.waitForTimeout(4_000);
  trace.push(`recordOpen:${rowOpen.ok}:n=${rowOpen.n}`);

  const mark = xhr.length;
  for (const label of [
    'Billing Profiles',
    'Negotiated Rates',
    'Auto Transfer',
    'Events',
    'Notes',
    'Record View',
  ]) {
    const before = xhr.length;
    const hit = await page
      .getByText(label, { exact: true })
      .first()
      .click({ force: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(3_500);
    const added = xhr.slice(before).map((x) => ({
      path: x.path,
      currentTab: x.currentTab,
      gridName: x.gridName,
      component: x.component,
    }));
    trace.push(`click:${label}:${hit}:xhr=${added.length}`);
    // stash per-label
    (trace as string[] & { _detail?: unknown })._detail = undefined;
    (globalThis as { __tabXhr?: Record<string, unknown> }).__tabXhr = {
      ...((globalThis as { __tabXhr?: Record<string, unknown> }).__tabXhr || {}),
      [label]: added,
    };
  }

  // Read tab xhr from node side via evaluate of last responses? keep from xhr array
  const tabXhr = xhr.slice(mark);

  // Also try soft-open FSOGPF.<tab> for candidate tab codes seen
  const tabCodes = [
    ...new Set(
      tabXhr.map((x) => x.currentTab).filter((t): t is string => Boolean(t)),
    ),
  ];
  const softTabs: Record<string, { status: number; bytes: number; keyHits: string[] }> =
    {};
  // Fresh browser page evaluate after BSSTRT — new context to avoid 813
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

  // Candidate tab codes from Infor naming + harvested
  const candidates = [
    ...new Set([
      ...tabCodes,
      'BLPF',
      'BPRF',
      'BPFL',
      'BILL',
      'BLPR',
      'ATRF',
      'NGRT',
      'EVNT',
      'NOTE',
      'NTE',
      'TRC',
      'RVW',
      'HDR',
      'LST',
      'DAT',
    ]),
  ];

  // New page/session for clean soft-open of tabs after re-open FSOGPF
  for (const tab of candidates) {
    softTabs[tab] = await page.evaluate(async (tabName) => {
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
      const r = await fetch(`/web/base/FSOGPF.${tabName}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          CURRENT_TAB_NAME: tabName,
          FUNCTION_CLASS: 'WEBL',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'FSOGPF',
        }).toString(),
      });
      const text = await r.text();
      const keyHits = [
        ...new Set(
          [
            ...text.matchAll(
              /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*|agent[^"]*|paperwork[^"]*)"/gi,
            ),
          ].map((m) => m[1]!),
        ),
      ].slice(0, 40);
      return { status: r.status, bytes: text.length, keyHits };
    }, tab);
  }

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    trace,
    tabXhr,
    tabCodes,
    softTabs,
    softReal: Object.entries(softTabs)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000)
      .map(([tab, v]) => ({ tab, bytes: v.bytes, keyHits: v.keyHits })),
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      trace,
      tabXhr,
      tabCodes,
      softReal: out.softReal,
      softTabsSummary: Object.fromEntries(
        Object.entries(softTabs).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/keys=${v.keyHits.length}`,
        ]),
      ),
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
