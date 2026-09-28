/**
 * Click-harvest Organization Profiles / Booking Agency / Group Availability XHR.
 * Uses DOM click after More→module hover (proven labels). HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
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
    process.env.HMS_A78_CLICK_OUT ?? '/tmp/a78-click-harvest.sanitized.v1.json';

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
  const xhr: { path: string; keys: string[] }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,30})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    xhr.push({
      path: m[1]!.toUpperCase(),
      keys: [...new Set([...body.matchAll(/([A-Z_]{2,40})=/g)].map((x) => x[1]!))].slice(
        0,
        40,
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

  async function openMore(): Promise<void> {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,span,button')].find(
        (n) => (n.textContent || '').trim() === 'More',
      );
      if (el) (el as HTMLElement).click();
    });
    await page.waitForTimeout(1_200);
  }

  async function openModuleThenClick(
    module: string,
    child: string,
  ): Promise<{ ok: boolean; xhrPaths: string[]; labels: string[] }> {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);
    await openMore();
    // Click module to expand children (proven pattern)
    await page.evaluate((mod) => {
      const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
        (n) => (n.textContent || '').trim() === mod,
      );
      if (!el) return;
      (el as HTMLElement).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      (el as HTMLElement).click();
    }, module);
    await page.waitForTimeout(2_000);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.x-menu-item-text, .x-menu-list-item')]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80)
        .slice(0, 80),
    );
    const mark = xhr.length;
    const clicked = await page.evaluate((ch) => {
      const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
        (n) => (n.textContent || '').trim() === ch,
      );
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    }, child);
    await page.waitForTimeout(4_000);
    return {
      ok: clicked,
      xhrPaths: [...new Set(xhr.slice(mark).map((x) => x.path))],
      labels,
    };
  }

  const groupBooking = await openModuleThenClick('Group Sales', 'Group Booking');
  const groupAvail = await openModuleThenClick('Group Sales', 'Group Availability');
  const orgProfiles = await openModuleThenClick('Profiles', 'Organization Profiles');
  const agency = await openModuleThenClick('Profiles', 'Booking Agency Profiles');
  const guestProf = await openModuleThenClick('Profiles', 'Guest Profiles');
  // Events path — expect miss
  const events = await openModuleThenClick('Group Sales', 'Events');

  // Soft-open any harvested codes (shell + HDR + LST)
  const harvested = [
    ...new Set(
      [
        ...groupBooking.xhrPaths,
        ...groupAvail.xhrPaths,
        ...orgProfiles.xhrPaths,
        ...agency.xhrPaths,
        ...guestProf.xhrPaths,
        ...events.xhrPaths,
      ]
        .map((p) => p.split('.')[0]!)
        .filter((fn) => !['LOGIN', 'BSSTRT'].includes(fn)),
    ),
  ];

  const softOpens: Record<
    string,
    { status: number; bytes: number; stub813: boolean; hasGrid: boolean }
  > = {};
  for (const fn of harvested) {
    for (const variant of ['', '.HDR', '.LST'] as const) {
      const key = variant ? `${fn}${variant}` : fn;
      softOpens[key] = await page.evaluate(
        async ({ functionName, tab }) => {
          for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
            await fetch(path, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                SYSTEM_FUNCTION_NAME: 'BSSTRT',
                USER_FUNCTION_NAME: 'BSSTRT',
                manurefresh: 'yes',
              }).toString(),
            }).catch(() => undefined);
          }
          const url = tab
            ? `/web/base/${functionName}.${tab}`
            : `/web/base/${functionName}?FUNCTION_CLASS=WEBL`;
          const body: Record<string, string> = {
            SYSTEM_FUNCTION_NAME: functionName,
            USER_FUNCTION_NAME: functionName,
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          };
          if (tab) {
            body.CURRENT_TAB_NAME = tab;
            if (tab === 'LST') {
              body.COMPONENT_INFO_TYPE = 'DATA_ONLY';
              body.GRID_NAME = functionName;
            }
          } else {
            body.CURRENT_TAB_NAME = '';
            body.MENU_MODULE_KEY = '0';
          }
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body).toString(),
          });
          const text = await r.text();
          return {
            status: r.status,
            bytes: text.length,
            stub813: text.length === 813,
            hasGrid: /GRID|"DATA"\s*:/i.test(text),
          };
        },
        { functionName: fn, tab: variant.replace('.', '') as '' | 'HDR' | 'LST' },
      );
    }
  }

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    groupBooking,
    groupAvail,
    orgProfiles,
    agency,
    guestProf,
    events,
    harvested,
    softOpens,
    xhrSample: xhr
      .filter((x) => !['LOGIN', 'BSSTRT', 'BSSTRT.HDR'].includes(x.path))
      .slice(0, 80),
  };
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      groupBooking,
      groupAvail,
      orgProfiles,
      agency,
      guestProf,
      events,
      harvested,
      softOpens,
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
