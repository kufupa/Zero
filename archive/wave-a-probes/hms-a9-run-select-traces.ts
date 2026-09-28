/**
 * A9 UI: Guest Stay → Run → Ext select/dblclick → setActiveTab Notes/Traces.
 * Harvest CURRENT_TAB_NAME from XHR (A8 BPF pattern). HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A9_UI_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a9-payload/run-select-traces.v1.json';

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
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(
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
    sample: Record<string, string>;
  }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? '');
    const sample: Record<string, string> = {};
    for (const k of [
      'CURRENT_TAB_NAME',
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'GRID_NAME',
      'COMPONENT_INFO_TYPE',
      'MENU_MODULE_KEY',
    ]) {
      const v = params.get(k);
      if (v != null) sample[k] = v.slice(0, 40);
    }
    net.push({
      path: m[1]!.toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      keys: [...params.keys()].slice(0, 40),
      sample,
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

  // Soft-open OSRESS before menu (A3 unlock)
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
    await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
  });
  await page.waitForTimeout(2_000);

  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_000);
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
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Guest Stay',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(4_000);

  await page.evaluate(() => {
    const list = [...document.querySelectorAll('.x-tab-inner, .x-btn-inner')].find(
      (n) => (n.textContent || '').trim() === 'List View',
    );
    if (list) (list as HTMLElement).click();
  });
  await page.waitForTimeout(1_000);
  const runClick = await page.evaluate(() => {
    const run = [...document.querySelectorAll('.x-btn-inner, button, span')].find(
      (n) => (n.textContent || '').trim() === 'Run',
    );
    if (!run) return false;
    (run as HTMLElement).click();
    return true;
  });
  await page.waitForTimeout(7_000);

  const opened = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const grids = w.Ext?.ComponentQuery?.query('grid') ?? [];
    const grid =
      grids.find((g) => {
        const sid = String(
          (g.store as { storeId?: string } | undefined)?.storeId ?? '',
        );
        return /osress/i.test(sid);
      }) ?? grids[0];
    if (!grid) return { ok: false, reason: 'no_grid', storeCount: 0 };
    const store = grid.store as {
      getCount?: () => number;
      getAt?: (i: number) => unknown;
      storeId?: string;
    };
    const count = store?.getCount?.() ?? 0;
    if (count <= 0) {
      return { ok: false, reason: 'empty', storeCount: 0, storeId: store?.storeId };
    }
    const rec = store.getAt?.(0);
    try {
      (
        grid.getSelectionModel as
          | (() => { select: (r: unknown) => void })
          | undefined
      )?.().select(rec);
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
    return { ok: true, storeCount: count, storeId: store?.storeId };
  });
  await page.waitForTimeout(6_000);

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
    const titles = panels.flatMap((p) =>
      ((p.items as { items?: Array<{ title?: string }> })?.items ?? []).map((i) =>
        String(i.title ?? ''),
      ),
    );
    const want = ['Notes', 'Traces', 'Record View', 'Folio'];
    const out: Record<string, unknown> = { titles: titles.slice(0, 40) };
    for (const title of want) {
      const panel = panels.find((p) =>
        ((p.items as { items?: Array<{ title?: string }> })?.items ?? []).some(
          (i) => String(i.title ?? '') === title,
        ),
      );
      if (!panel) continue;
      const item = (
        (panel.items as { items?: Array<Record<string, unknown>> })?.items ?? []
      ).find((i) => String(i.title ?? '') === title);
      try {
        (panel as { setActiveTab?: (x: unknown) => void }).setActiveTab?.(item);
        out[title] = (
          panel as { getActiveTab?: () => { title?: string } }
        ).getActiveTab?.()?.title;
      } catch (e) {
        out[`${title}Err`] = String(e).slice(0, 120);
      }
    }
    return out;
  });
  await page.waitForTimeout(5_000);

  // Also click tab strip text nodes as fallback
  for (const label of ['Traces', 'Notes']) {
    await page.evaluate((lab) => {
      const el = [...document.querySelectorAll('.x-tab-inner, a, span')].find(
        (n) => (n.textContent || '').trim() === lab,
      );
      if (el) (el as HTMLElement).click();
    }, label);
    await page.waitForTimeout(2_500);
  }

  const afterTabs = net.slice(mark);
  const harvestedTabs = [
    ...new Set(
      afterTabs
        .map((n) => n.tab)
        .filter((t): t is string => Boolean(t && t.length > 0)),
    ),
  ];

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    runClick,
    opened,
    tabSwitch,
    harvestedTabs,
    afterTabPosts: afterTabs.slice(0, 80),
    allPaths: [...new Set(net.map((n) => n.path))].slice(0, 80),
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      runClick,
      opened,
      harvestedTabs,
      tabTitles: (tabSwitch as { titles?: string[] }).titles ?? [],
      afterTabPostCount: afterTabs.length,
      interesting: afterTabs
        .filter((n) => /TRC|NTE|NOTE|TRACE|ALT|OSRES/i.test(n.path + (n.tab || '')))
        .slice(0, 30),
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
