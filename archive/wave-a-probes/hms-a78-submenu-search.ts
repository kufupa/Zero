/**
 * A7/A8: More→submenu XHR harvest + OSORGP popup search POST.
 * Structure/counts only. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
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
    process.env.HMS_A78_SUBMENU_OUT ?? '/tmp/a78-submenu-search.sanitized.v1.json';

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
  const xhrLog: { path: string; bytesHint: number; keys: string[] }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    xhrLog.push({
      path: m[1]!.toUpperCase(),
      bytesHint: body.length,
      keys: [...new Set([...body.matchAll(/([A-Z_]{2,40})=/g)].map((x) => x[1]!))].slice(
        0,
        30,
      ),
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

  async function visibleMenuLabels(p: Page): Promise<string[]> {
    return p.evaluate(() => {
      const sel =
        '.x-menu-item-text, .x-menu-list-item, .x-menu-item, [role="menuitem"], .x-btn-inner';
      return [
        ...new Set(
          [...document.querySelectorAll(sel)]
            .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
            .filter((t) => t.length > 1 && t.length < 80),
        ),
      ].slice(0, 100);
    });
  }

  async function openMore(p: Page): Promise<string> {
    const moreBtn = p.locator('.x-btn-inner', { hasText: /^More$/ }).first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click({ force: true }).catch(() => undefined);
      await p.waitForTimeout(1_200);
      return 'more:x-btn-inner';
    }
    const moreText = p.getByText('More', { exact: true }).first();
    if (await moreText.isVisible().catch(() => false)) {
      await moreText.click({ force: true }).catch(() => undefined);
      await p.waitForTimeout(1_200);
      return 'more:text';
    }
    return 'more:miss';
  }

  async function hoverMenuItem(p: Page, label: string): Promise<boolean> {
    const item = p.locator('.x-menu-item-text', { hasText: label }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.hover({ force: true }).catch(() => undefined);
      await p.waitForTimeout(2_000);
      return true;
    }
    const role = p.getByRole('menuitem', { name: label }).first();
    if (await role.isVisible().catch(() => false)) {
      await role.hover({ force: true }).catch(() => undefined);
      await p.waitForTimeout(2_000);
      return true;
    }
    return false;
  }

  async function clickMenuItem(p: Page, label: string): Promise<boolean> {
    const item = p.locator('.x-menu-item-text', { hasText: label }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click({ force: true }).catch(() => undefined);
      await p.waitForTimeout(2_500);
      return true;
    }
    const role = p.getByRole('menuitem', { name: label }).first();
    if (await role.isVisible().catch(() => false)) {
      await role.click({ force: true }).catch(() => undefined);
      await p.waitForTimeout(2_500);
      return true;
    }
    return false;
  }

  const trace: string[] = [];
  const xhrMark = xhrLog.length;

  // Path A: More → Group Sales → Events → Event Reservations
  trace.push(await openMore(page));
  let labels = await visibleMenuLabels(page);
  trace.push(`afterMore:${labels.join('|')}`);
  const hsGroup = await hoverMenuItem(page, 'Group Sales');
  trace.push(`hoverGroupSales:${hsGroup}`);
  labels = await visibleMenuLabels(page);
  trace.push(`afterHoverGroup:${labels.join('|')}`);
  const clickEvents = await clickMenuItem(page, 'Events');
  trace.push(`clickEvents:${clickEvents}`);
  labels = await visibleMenuLabels(page);
  trace.push(`afterEvents:${labels.join('|')}`);
  const clickEvRes = await clickMenuItem(page, 'Event Reservations');
  trace.push(`clickEventReservations:${clickEvRes}`);
  await page.waitForTimeout(2_000);

  // Path B: More → Group Sales → Group Booking (control — should work / already soft-open)
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
  trace.push(await openMore(page));
  await hoverMenuItem(page, 'Group Sales');
  await page.waitForTimeout(1_500);
  labels = await visibleMenuLabels(page);
  trace.push(`groupSubmenu:${labels.join('|')}`);
  const clickGb = await clickMenuItem(page, 'Group Booking');
  trace.push(`clickGroupBooking:${clickGb}`);
  await page.waitForTimeout(2_500);

  // Path C: More → Profiles → Organization Profiles
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
  trace.push(await openMore(page));
  await hoverMenuItem(page, 'Profiles');
  await page.waitForTimeout(1_500);
  labels = await visibleMenuLabels(page);
  trace.push(`profilesSubmenu:${labels.join('|')}`);
  const clickOrg = await clickMenuItem(page, 'Organization Profiles');
  trace.push(`clickOrgProfiles:${clickOrg}`);
  const clickAgency = await clickMenuItem(page, 'Booking Agency Profiles');
  trace.push(`clickAgency:${clickAgency}`);
  await page.waitForTimeout(2_500);

  const xhrFromUi = xhrLog.slice(xhrMark);

  // Soft: OSORGP popup search variants after BSSTRT warm
  const orgSearch = await page.evaluate(async () => {
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
    await fetch('/web/base/OSORGP?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSORGP',
        USER_FUNCTION_NAME: 'OSORGP',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const trials: Record<string, { status: number; bytes: number; head: string }> = {};
    const paths = [
      'OSORGP.search',
      'OSORGP.SEARCH',
      'OSORGP.find',
      'OSORGP.FIND',
      'OSORGP.lookup',
      'OSORGP.LOOKUP',
      'OSORGP.LST',
      'OSORGP.list',
      'operations.popups.osorgp',
    ];
    for (const p of paths) {
      const url = p.startsWith('operations') ? `/web/base/${p}` : `/web/base/${p}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSORGP',
            USER_FUNCTION_NAME: 'OSORGP',
            FUNCTION_CLASS: 'WEBL',
            organizationname: 'A',
            externalorganizationid: '',
            COMPONENT_INFO_TYPE: 'DATA_ONLY',
            GRID_NAME: 'OSORGP',
          }).toString(),
        });
        const text = await r.text();
        trials[p] = {
          status: r.status,
          bytes: text.length,
          head: text
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
            .replace(/\d{6,}/g, '[n]')
            .slice(0, 180),
        };
      } catch {
        trials[p] = { status: 0, bytes: 0, head: '' };
      }
    }
    // Also try common popup search body shape used elsewhere
    for (const path of ['OSORGP.search', 'OSORGP.find']) {
      try {
        const r = await fetch(`/web/base/${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSORGP',
            USER_FUNCTION_NAME: 'OSORGP',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            manurefresh: 'yes',
            organizationname: '%',
            search: 'Search',
          }).toString(),
        });
        const text = await r.text();
        trials[`${path}|pct`] = {
          status: r.status,
          bytes: text.length,
          head: text
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
            .slice(0, 180),
        };
      } catch {
        /* ignore */
      }
    }
    return trials;
  });

  // Soft-open any NEW function codes seen in UI XHR
  const newFns = [
    ...new Set(
      xhrFromUi
        .map((x) => x.path.split('.')[0]!)
        .filter((fn) => !['BSSTRT', 'LOGIN', 'GSGRPB', 'OSORGP'].includes(fn)),
    ),
  ];
  const newOpens: Record<string, { status: number; bytes: number }> = {};
  for (const fn of newFns.slice(0, 15)) {
    newOpens[fn] = await page.evaluate(async (functionName) => {
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
      const r = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      return { status: r.status, bytes: (await r.text()).length };
    }, fn);
  }

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    trace,
    xhrFromUi: xhrFromUi.map((x) => ({ path: x.path, keys: x.keys })),
    orgSearch,
    newFns,
    newOpens,
  };
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      trace,
      xhrPaths: [...new Set(xhrFromUi.map((x) => x.path))],
      orgSearch,
      newFns,
      newOpens,
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) +
      '\n',
  );
  process.exit(1);
});
