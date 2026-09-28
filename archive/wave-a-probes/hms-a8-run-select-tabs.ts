/**
 * FSOGPF: Run dataspy → select row via Ext selection → open record → switch tabs.
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
    process.env.HMS_A8_RUN_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/run-select-tabs.v1.json';

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
  await page.waitForTimeout(4_000);

  // Click List View + Run
  await page.evaluate(() => {
    const list = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner')].find(
      (n) => (n.textContent || '').trim() === 'List View',
    );
    if (list) (list as HTMLElement).click();
  });
  await page.waitForTimeout(1_500);
  const runClick = await page.evaluate(() => {
    const run = [...document.querySelectorAll('.x-btn-inner, button, span')].find(
      (n) => (n.textContent || '').trim() === 'Run',
    );
    if (!run) return false;
    (run as HTMLElement).click();
    return true;
  });
  await page.waitForTimeout(6_000);

  const afterRun = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        StoreManager?: {
          lookup: (n: string) => {
            getCount: () => number;
            getAt: (i: number) => { data?: Record<string, unknown> };
          } | null;
        };
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const store =
      w.Ext?.StoreManager?.lookup(
        'EAM.store.operations.organizationprofile.fsogpf_lst',
      ) ?? null;
    const count = store?.getCount?.() ?? 0;
    let billIdx = 0;
    let flag: string | null = null;
    for (let i = 0; i < count; i++) {
      const f = store!.getAt(i)?.data?.billingprofilesflag;
      if (f === true || f === '1' || f === 1 || f === 'Y' || f === 'true') {
        billIdx = i;
        flag = String(f);
        break;
      }
    }
    return { count, billIdx, flag };
  });

  // Select + open record via Ext grid selection model + fireEvent
  const opened = await page.evaluate((idx) => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const grids = w.Ext?.ComponentQuery?.query('grid') ?? [];
    const grid = grids.find((g) => {
      const sid = (g.store as { storeId?: string } | undefined)?.storeId;
      return sid?.includes('fsogpf_lst');
    });
    if (!grid) return { ok: false, reason: 'no_grid' };
    const store = grid.store as {
      getCount: () => number;
      getAt: (i: number) => unknown;
    };
    if (store.getCount() <= 0) return { ok: false, reason: 'empty' };
    const rec = store.getAt(Math.min(idx, store.getCount() - 1));
    const sm = grid.getSelectionModel as
      | (() => { select: (r: unknown) => void })
      | undefined;
    try {
      sm?.().select(rec);
    } catch {
      /* ignore */
    }
    try {
      (grid as { fireEvent?: (e: string, g: unknown, r: unknown) => void }).fireEvent?.(
        'itemdblclick',
        grid,
        rec,
      );
    } catch {
      /* ignore */
    }
    try {
      (grid as { fireEvent?: (e: string, g: unknown, r: unknown) => void }).fireEvent?.(
        'itemclick',
        grid,
        rec,
      );
    } catch {
      /* ignore */
    }
    return { ok: true, storeCount: store.getCount() };
  }, afterRun.billIdx);
  await page.waitForTimeout(6_000);

  // Switch to Billing Profiles by item ref
  const mark = net.length;
  const tabSwitch = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const panels = w.Ext?.ComponentQuery?.query('tabpanel') ?? [];
    const panel = panels.find((p) =>
      ((p.items as { items?: Array<{ title?: string }> })?.items ?? []).some(
        (i) => String(i.title ?? '') === 'Billing Profiles',
      ),
    );
    if (!panel) return { ok: false, reason: 'no_panel' };
    const items =
      (panel.items as { items?: Array<Record<string, unknown>> })?.items ?? [];
    const bill = items.find((i) => String(i.title ?? '') === 'Billing Profiles');
    const ev = items.find((i) => String(i.title ?? '') === 'Events');
    const out: Record<string, unknown> = { ok: true };
    try {
      (panel as { setActiveTab?: (x: unknown) => void }).setActiveTab?.(bill);
      out.billingActive = (
        panel as { getActiveTab?: () => { title?: string } }
      ).getActiveTab?.()?.title;
    } catch (e) {
      out.billingErr = String(e).slice(0, 120);
    }
    try {
      (panel as { setActiveTab?: (x: unknown) => void }).setActiveTab?.(ev);
      out.eventsActive = (
        panel as { getActiveTab?: () => { title?: string } }
      ).getActiveTab?.()?.title;
    } catch (e) {
      out.eventsErr = String(e).slice(0, 120);
    }
    // return to billing for harvest
    try {
      (panel as { setActiveTab?: (x: unknown) => void }).setActiveTab?.(bill);
    } catch {
      /* ignore */
    }
    return out;
  });
  await page.waitForTimeout(5_000);

  const harvest = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const active =
      document.querySelector('.x-tab-active .x-tab-inner')?.textContent?.trim() ??
      null;
    const fields = (w.Ext?.ComponentQuery?.query('field') ?? [])
      .map((f) => String(f.name ?? ''))
      .filter(Boolean);
    const billish = [
      ...new Set(
        fields.filter((n) =>
          /bill|pay|contract|term|mode|ar|agent|card|account|settlement/i.test(n),
        ),
      ),
    ];
    const grids = (w.Ext?.ComponentQuery?.query('grid') ?? []).map((g) => {
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
    return { active, billish, grids, fieldCount: fields.length };
  });

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    runClick,
    afterRun,
    opened,
    tabSwitch,
    harvest,
    netAfterOpen: net.slice(mark),
    netSample: net.filter((n) => n.path.startsWith('FS') || n.path.startsWith('OS')),
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
