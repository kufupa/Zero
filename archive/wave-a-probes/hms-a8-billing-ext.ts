/**
 * Deep Ext/pageData field harvest after Billing Profiles tab click.
 * Structure key names only. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_EXT_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/billing-ext.v1.json';

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
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Billing Profiles',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(5_000);

  const harvest = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ext = w.Ext as
      | {
          ComponentQuery?: { query: (s: string) => unknown[] };
          StoreManager?: { lookup: (n: string) => unknown };
        }
      | undefined;

    const fieldNames: string[] = [];
    try {
      const fields = ext?.ComponentQuery?.query('field') ?? [];
      for (const f of fields as Array<Record<string, unknown>>) {
        const name = String(f.name ?? f.itemId ?? f.id ?? '');
        if (name) fieldNames.push(name.slice(0, 80));
      }
    } catch {
      /* ignore */
    }

    const storeKeys: string[] = [];
    const storeNames: string[] = [];
    try {
      const grids = ext?.ComponentQuery?.query('grid') ?? [];
      for (const g of grids as Array<Record<string, unknown>>) {
        const store = g.store as
          | {
              storeId?: string;
              getProxy?: () => { url?: string };
              getAt?: (i: number) => { data?: Record<string, unknown> };
              getCount?: () => number;
            }
          | undefined;
        if (store?.storeId) storeNames.push(String(store.storeId));
        const count = store?.getCount?.() ?? 0;
        if (count > 0) {
          const row = store.getAt?.(0);
          if (row?.data) storeKeys.push(...Object.keys(row.data).slice(0, 40));
        }
      }
    } catch {
      /* ignore */
    }

    const billishFields = [
      ...new Set(
        fieldNames.filter((n) =>
          /bill|pay|contract|term|mode|ar|agent|paper|account|settlement|folio/i.test(
            n,
          ),
        ),
      ),
    ].slice(0, 80);
    const billishStoreKeys = [
      ...new Set(
        storeKeys.filter((n) =>
          /bill|pay|contract|term|mode|ar|agent|paper|account|settlement|folio|card|guarantee/i.test(
            n,
          ),
        ),
      ),
    ].slice(0, 80);

    // Active tab text
    const activeTab =
      (
        document.querySelector(
          '.x-tab-active .x-tab-inner, .x-tab.x-tab-active',
        ) as HTMLElement | null
      )?.innerText?.trim() ?? null;

    // Visible panel text sample (no PII digits)
    const panelText = (
      document.querySelector('.x-panel-body, .x-tabpanel-child') as HTMLElement | null
    )?.innerText
      ?.slice(0, 500)
      ?.replace(/\d{5,}/g, '[n]')
      ?.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]');

    return {
      fieldCount: fieldNames.length,
      billishFields,
      storeNames: storeNames.slice(0, 40),
      billishStoreKeys,
      activeTab,
      panelText,
      hasExt: Boolean(ext),
    };
  });

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    harvest,
    dodTrio: {
      billingMode: harvest.billishFields
        .concat(harvest.billishStoreKeys)
        .some((k) => /billingmode|billmode/i.test(k)),
      paymentTermClass: harvest.billishFields
        .concat(harvest.billishStoreKeys)
        .some((k) => /paymentterm|payterm/i.test(k)),
      contractStatus: harvest.billishFields
        .concat(harvest.billishStoreKeys)
        .some((k) => /contractstatus|contract/i.test(k)),
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
