/**
 * A9: Guest Stay OSRESS Run → open row → harvest Notes/Traces tab XHR codes.
 * Soft-open harvested tabs. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A9_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a9-payload/traces-harvest.v1.json';

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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const posts: {
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
      'GRID_NAME',
      'COMPONENT_INFO_TYPE',
      'SYSTEM_FUNCTION_NAME',
      'confirmationnumber',
      'guestnumber',
      'reservationid',
    ]) {
      const v = params.get(k);
      if (v != null) {
        sample[k] = /id|number|confirmation|guest/i.test(k)
          ? v
            ? '[id]'
            : ''
          : v.slice(0, 40);
      }
    }
    posts.push({
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

  // Soft-open OSRESS first (A3), then menu Guest Stay
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

  // Menu Front Desk / Guest Stay if visible
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

  // Run dataspy
  await page.evaluate(() => {
    const run = [...document.querySelectorAll('.x-btn-inner, button, span')].find(
      (n) => (n.textContent || '').trim() === 'Run',
    );
    if (run) (run as HTMLElement).click();
  });
  await page.waitForTimeout(6_000);

  // Open first row via Ext
  await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const grids = w.Ext?.ComponentQuery?.query('grid') ?? [];
    const grid = grids.find((g) => {
      const sid = String(
        (g.store as { storeId?: string } | undefined)?.storeId ?? '',
      );
      return /osress/i.test(sid);
    }) ?? grids[0];
    if (!grid) return;
    const store = grid.store as {
      getCount?: () => number;
      getAt?: (i: number) => unknown;
    };
    if (!store?.getCount || store.getCount() <= 0) return;
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
  });
  await page.waitForTimeout(5_000);

  // List tabs
  const tabTitles = await page.evaluate(() => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const panels = w.Ext?.ComponentQuery?.query('tabpanel') ?? [];
    const titles: string[] = [];
    for (const p of panels) {
      const items =
        (p.items as { items?: Array<{ title?: string }> })?.items ?? [];
      for (const i of items) {
        if (i.title) titles.push(String(i.title));
      }
    }
    return [...new Set(titles)];
  });

  const mark = posts.length;
  // Activate Notes + Traces via Ext setActiveTab(item)
  for (const want of ['Notes', 'Traces', 'Rate Details', 'Folio']) {
    await page.evaluate((title) => {
      const w = window as unknown as {
        Ext?: {
          ComponentQuery?: {
            query: (s: string) => Array<Record<string, unknown>>;
          };
        };
      };
      const panels = w.Ext?.ComponentQuery?.query('tabpanel') ?? [];
      for (const p of panels) {
        const items =
          (p.items as { items?: Array<Record<string, unknown>> })?.items ?? [];
        const item = items.find(
          (i) => String(i.title ?? '').trim() === title,
        );
        if (!item) continue;
        try {
          (p as { setActiveTab?: (x: unknown) => void }).setActiveTab?.(item);
        } catch {
          /* ignore */
        }
      }
    }, want);
    await page.waitForTimeout(3_500);
  }

  const active = await page.evaluate(
    () =>
      document.querySelector('.x-tab-active .x-tab-inner')?.textContent?.trim() ??
      null,
  );

  const harvested = posts.slice(mark).filter(
    (p) =>
      p.path.startsWith('OSRESS') ||
      /NTE|TRC|NOTE|TRACE|RATE|FOLIO|DET/i.test(p.path + (p.tab ?? '')),
  );

  // Soft-open harvested tab codes with OSRESS + confirmation-like keys from sample
  const tabCodes = [
    ...new Set(
      harvested
        .map((p) => p.tab)
        .filter((t): t is string => Boolean(t) && !['HDR', 'LST', ''].includes(t)),
    ),
  ];
  // Also guess common codes
  const guessTabs = [
    ...tabCodes,
    'TRC',
    'NTE',
    'NOTE',
    'NOT',
    'TRA',
    'ALERT',
    'ALR',
    'LOC',
  ];
  const soft: Record<string, { status: number; bytes: number; keyHits: string[] }> =
    {};
  for (const tab of [...new Set(guessTabs)].slice(0, 16)) {
    soft[tab] = await page.evaluate(async (tabName) => {
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
      const r = await fetch(`/web/base/OSRESS.${tabName}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          USER_FUNCTION_NAME: 'OSRESS',
          CURRENT_TAB_NAME: tabName,
        }).toString(),
      });
      const text = await r.text();
      const keyHits = [
        ...new Set(
          [
            ...text.matchAll(
              /"(trace[^"]*|note[^"]*|alert[^"]*|locator[^"]*|status[^"]*|due[^"]*|author[^"]*)"/gi,
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
    tabTitles,
    active,
    harvested,
    postsSample: posts.filter((p) => p.path.startsWith('OS')).slice(0, 30),
    soft,
    softReal: Object.entries(soft)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000)
      .map(([tab, v]) => ({ tab, bytes: v.bytes, keyHits: v.keyHits })),
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
