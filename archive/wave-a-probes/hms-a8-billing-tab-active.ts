/**
 * Activate Billing Profiles via .x-tab-inner; prefer billingprofilesflag row.
 * Harvest Ext fields after active tab confirms. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_TABACT_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/billing-tab-active.v1.json';

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
  const net: { path: string; tab: string | null; method: string }[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    net.push({
      method: req.method(),
      path: m[1]!.toUpperCase(),
      tab: new URLSearchParams(body).get('CURRENT_TAB_NAME'),
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

  // Menu open Organization Profiles
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
  await page.waitForTimeout(2_500);

  // Pick row index with billingprofilesflag if LST data in Ext store
  const rowPick = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        StoreManager?: {
          lookup: (n: string) => {
            getCount: () => number;
            getAt: (i: number) => { data?: Record<string, unknown> };
          } | null;
        };
      };
    };
    const store =
      w.Ext?.StoreManager?.lookup(
        'EAM.store.operations.organizationprofile.fsogpf_lst',
      ) ?? null;
    let idx = 0;
    let flag: unknown = null;
    if (store) {
      const n = store.getCount();
      for (let i = 0; i < n; i++) {
        const d = store.getAt(i)?.data;
        const f = d?.billingprofilesflag;
        if (f === true || f === '1' || f === 1 || f === 'Y' || f === 'true') {
          idx = i;
          flag = f;
          break;
        }
      }
      if (flag == null && n > 0) {
        flag = store.getAt(0)?.data?.billingprofilesflag ?? null;
      }
    }
    const rows = [
      ...document.querySelectorAll('.x-grid-row, .x-grid3-row, .x-grid-item'),
    ] as HTMLElement[];
    const row = rows[idx] ?? rows[0];
    if (!row) return { ok: false, idx, flag, n: rows.length };
    row.scrollIntoView({ block: 'center' });
    row.click();
    row.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }),
    );
    return { ok: true, idx, flag: flag == null ? null : String(flag), n: rows.length };
  });
  await page.waitForTimeout(5_000);

  // Click Record View then Billing Profiles via tab inner
  await page.locator('.x-tab-inner', { hasText: /^Record View$/ }).first().click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const mark = net.length;
  await page
    .locator('.x-tab-inner', { hasText: /^Billing Profiles$/ })
    .first()
    .click({ force: true })
    .catch(() => undefined);
  await page.waitForTimeout(5_000);

  // Confirm active tab
  const active = await page.evaluate(() => {
    const act = document.querySelector('.x-tab-active .x-tab-inner');
    return act?.textContent?.trim() ?? null;
  });

  // If still not Billing Profiles, try Ext tabpanel setActiveTab by title
  if (active !== 'Billing Profiles') {
    await page.evaluate(() => {
      const w = window as unknown as {
        Ext?: { ComponentQuery?: { query: (s: string) => Array<Record<string, unknown>> } };
      };
      const tabs = w.Ext?.ComponentQuery?.query('tab') ?? [];
      for (const t of tabs) {
        const title = String(t.title ?? t.text ?? '');
        if (/billing profiles/i.test(title)) {
          const tp = t.up?.('tabpanel') as
            | { setActiveTab?: (x: unknown) => void }
            | undefined;
          tp?.setActiveTab?.(t);
          break;
        }
      }
    });
    await page.waitForTimeout(4_000);
  }

  const active2 = await page.evaluate(() => {
    const act = document.querySelector('.x-tab-active .x-tab-inner');
    return act?.textContent?.trim() ?? null;
  });

  const harvest = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: { ComponentQuery?: { query: (s: string) => Array<Record<string, unknown>> } };
    };
    const fields = w.Ext?.ComponentQuery?.query('field') ?? [];
    const names = fields
      .map((f) => String(f.name ?? ''))
      .filter(Boolean);
    const billish = [
      ...new Set(
        names.filter((n) =>
          /bill|pay|contract|term|mode|ar|agent|paper|account|settlement|card|guarantee/i.test(
            n,
          ),
        ),
      ),
    ];
    const grids = w.Ext?.ComponentQuery?.query('grid') ?? [];
    const gridInfo = grids.map((g) => {
      const store = g.store as
        | {
            storeId?: string;
            getCount?: () => number;
            getAt?: (i: number) => { data?: Record<string, unknown> };
          }
        | undefined;
      const count = store?.getCount?.() ?? 0;
      const keys =
        count > 0 && store?.getAt?.(0)?.data
          ? Object.keys(store.getAt(0)!.data!).slice(0, 50)
          : [];
      return { storeId: store?.storeId ?? null, count, keys };
    });
    const labels = [
      ...new Set(
        [...document.querySelectorAll('.x-form-item-label, label, .x-tab-inner')]
          .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t.length > 1 && t.length < 64),
      ),
    ]
      .filter((t) =>
        /bill|pay|contract|term|mode|account|agent|card|settlement|profile/i.test(t),
      )
      .slice(0, 40);
    return {
      fieldNamesSample: names.slice(0, 60),
      billish,
      gridInfo,
      labels,
    };
  });

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    rowPick,
    activeAfterClick: active,
    activeAfterExt: active2,
    netAfterBill: net.slice(mark),
    harvest,
    dodTrio: {
      billingMode: harvest.billish.some((k) => /billingmode|billmode/i.test(k)),
      paymentTermClass: harvest.billish.some((k) =>
        /paymentterm|payterm/i.test(k),
      ),
      contractStatus: harvest.billish.some((k) => /contractstatus|^contract$/i.test(k)),
      gridHasContract: harvest.gridInfo.some((g) =>
        g.keys.some((k) => /contract/i.test(k)),
      ),
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
