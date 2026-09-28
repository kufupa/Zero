/**
 * Force-activate FSOGPF nested tabs (Billing Profiles + Events) via Ext tabpanel index/title.
 * Harvest fields/stores after activation. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_FORCE_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload/force-tabs.v1.json';

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
  await page
    .locator('.x-grid-row, .x-grid3-row, .x-grid-item')
    .first()
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(2_500);
  await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('.x-grid-row, .x-grid3-row, .x-grid-item'),
    ] as HTMLElement[];
    if (rows[0]) {
      rows[0].click();
      rows[0].dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }),
      );
    }
  });
  await page.waitForTimeout(5_000);

  async function activate(title: string) {
    const mark = net.length;
    const result = await page.evaluate((want) => {
      const w = window as unknown as {
        Ext?: {
          ComponentQuery?: {
            query: (s: string) => Array<Record<string, unknown>>;
          };
        };
      };
      const panels = w.Ext?.ComponentQuery?.query('tabpanel') ?? [];
      const panelInfo = panels.map((p) => {
        const items = (p.items as { items?: Array<{ title?: string }> })?.items ?? [];
        return {
          id: String(p.id ?? ''),
          titles: items.map((i) => String(i.title ?? '')),
        };
      });
      let activated = false;
      let activeTitle: string | null = null;
      for (const p of panels) {
        const items =
          (p.items as { items?: Array<Record<string, unknown>> })?.items ?? [];
        const idx = items.findIndex(
          (i) => String(i.title ?? '').trim() === want,
        );
        if (idx < 0) continue;
        try {
          (p as { setActiveTab?: (x: number | unknown) => void }).setActiveTab?.(
            idx,
          );
          activated = true;
          const at = (
            p as { getActiveTab?: () => { title?: string } }
          ).getActiveTab?.();
          activeTitle = at?.title ? String(at.title) : want;
          break;
        } catch {
          /* try next panel */
        }
      }
      return { activated, activeTitle, panelInfo };
    }, title);
    await page.waitForTimeout(4_000);
    const harvest = await page.evaluate(() => {
      const w = window as unknown as {
        Ext?: {
          ComponentQuery?: {
            query: (s: string) => Array<Record<string, unknown>>;
          };
        };
      };
      const fields = (w.Ext?.ComponentQuery?.query('field') ?? [])
        .map((f) => String(f.name ?? ''))
        .filter(Boolean);
      const billish = [
        ...new Set(
          fields.filter((n) =>
            /bill|pay|contract|term|mode|ar|agent|card|account|settlement|event|date|status|deposit/i.test(
              n,
            ),
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
      const domActive =
        document.querySelector('.x-tab-active .x-tab-inner')?.textContent?.trim() ??
        null;
      return { billish, grids, fieldCount: fields.length, domActive };
    });
    return {
      title,
      result,
      harvest,
      net: net.slice(mark),
    };
  }

  const billing = await activate('Billing Profiles');
  const events = await activate('Events');
  const notes = await activate('Notes');
  const negotiated = await activate('Negotiated Rates');
  const autoTransfer = await activate('Auto Transfer');

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    billing,
    events,
    notes,
    negotiated,
    autoTransfer,
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      billing: {
        activated: billing.result.activated,
        activeTitle: billing.result.activeTitle,
        domActive: billing.harvest.domActive,
        billish: billing.harvest.billish,
        grids: billing.harvest.grids,
        net: billing.net,
        panels: billing.result.panelInfo,
      },
      events: {
        activated: events.result.activated,
        activeTitle: events.result.activeTitle,
        domActive: events.harvest.domActive,
        billish: events.harvest.billish,
        grids: events.harvest.grids,
        net: events.net,
      },
      notes: {
        activated: notes.result.activated,
        grids: notes.harvest.grids,
        billish: notes.harvest.billish,
      },
      negotiated: {
        activated: negotiated.result.activated,
        grids: negotiated.harvest.grids,
      },
      autoTransfer: {
        activated: autoTransfer.result.activated,
        grids: autoTransfer.harvest.grids,
      },
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
