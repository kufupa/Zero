/**
 * Payload reopen: More→Group Sales click-harvest + OSRRAV.HDR.search with MM/DD/YYYY chrome.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Request } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type Cap = {
  method: string;
  path: string;
  systemFn: string | null;
  userFn: string | null;
  tokens: string[];
};

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outDir = process.env.HMS_PAYLOAD_OUT_DIR?.trim() || '/tmp/hms-payload-more';
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const caps: Cap[] = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    const p = new URL(u).pathname;
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(p) && !/\.search$/i.test(p)) {
      return route.abort();
    }
    return route.continue();
  });
  ctx.on('request', (req: Request) => {
    try {
      if (!req.url().startsWith(origin)) return;
      const path = new URL(req.url()).pathname;
      const post = req.postData() ?? '';
      const params = new URLSearchParams(post);
      const tokens = [
        ...new Set(
          [...`${path} ${post}`.matchAll(/\b((?:OS|PS|AR|CS)[A-Z0-9]{3,10})\b/g)].map(
            (m) => m[1]!,
          ),
        ),
      ];
      if (!tokens.length && !/\/web\/base\//.test(path)) return;
      caps.push({
        method: req.method(),
        path,
        systemFn: params.get('SYSTEM_FUNCTION_NAME'),
        userFn: params.get('USER_FUNCTION_NAME'),
        tokens: tokens.slice(0, 12),
      });
    } catch {
      /* ignore */
    }
  });

  const page = await ctx.newPage();
  const log: string[] = [];
  try {
    await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
    await page.waitForTimeout(1_500);

    // A5 search with MM/DD/YYYY chrome after HDR open
    const hdr = await page.evaluate(async () => {
      const r = await fetch('/web/base/OSRRAV.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      });
      return { status: r.status, bytes: (await r.text()).length };
    });

    const searchBodies = [
      {
        label: 'empty_rooms_mdy',
        body: {
          property: 'HRCEN',
          roomtypes: '',
          rateplans: '',
          salesstrategy: 'TRANSI',
          showunavailable: '0',
          ratetype: '',
          adults: '2',
          showexclusiverates: '0',
          showavailableforsale: 'on',
          children: '0',
          startdate: '09/15/2026',
          currency: 'ZAR',
          rowpagesize: '14',
          salesstrategy_display: 'TRANSI',
          currency_display: 'ZAR',
          adults_display: '2',
          children_display: '0',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
          pagemode: 'display',
          ONLY_DATA_REQUIRED: 'true',
          USER_FUNCTION_NAME: 'OSRRAV',
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
        },
      },
      {
        label: 'room_1_mdy',
        body: {
          property: 'HRCEN',
          roomtypes: '1',
          rateplans: '1',
          salesstrategy: 'TRANSI',
          showunavailable: '0',
          ratetype: '',
          adults: '2',
          showexclusiverates: '0',
          showavailableforsale: 'on',
          children: '0',
          startdate: '09/15/2026',
          currency: 'ZAR',
          rowpagesize: '14',
          salesstrategy_display: 'TRANSI',
          currency_display: 'ZAR',
          adults_display: '2',
          children_display: '0',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
          pagemode: 'display',
          ONLY_DATA_REQUIRED: 'true',
          USER_FUNCTION_NAME: 'OSRRAV',
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
        },
      },
    ];

    const searches = [];
    for (const trial of searchBodies) {
      const result = await page.evaluate(async (b) => {
        const r = await fetch('/web/base/OSRRAV.HDR.search', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(b).toString(),
        });
        const text = await r.text();
        const keys = [
          ...new Set([...text.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((m) => m[1]!)),
        ].slice(0, 50);
        return {
          status: r.status,
          bytes: text.length,
          hasAvailabilitydata: /availabilitydata/i.test(text),
          successFalse: /"success"\s*:\s*false/.test(text),
          msg: (text.match(/"msg"\s*:\s*"([^"]{0,120})"/) || [])[1] ?? null,
          topKeys: keys,
          headMasked: text
            .slice(0, 220)
            .replace(/\d/g, '#')
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[redacted]'),
        };
      }, trial.body);
      searches.push({ label: trial.label, ...result });
    }

    // More → Group Sales → (hover) Group Booking / Events
    async function clickExact(label: string): Promise<boolean> {
      const loc = page.getByText(label, { exact: true }).first();
      const vis = await loc.isVisible().catch(() => false);
      if (!vis) {
        log.push(`miss:${label}`);
        return false;
      }
      await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
      log.push(`click:${label}`);
      await page.waitForTimeout(2_000);
      return true;
    }
    async function hoverThenClick(parent: string, child: string): Promise<boolean> {
      const pLoc = page.getByText(parent, { exact: true }).first();
      if (!(await pLoc.isVisible().catch(() => false))) {
        log.push(`miss-hover-parent:${parent}`);
        return false;
      }
      await pLoc.hover({ timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(1_200);
      const cLoc = page.getByText(child, { exact: true }).first();
      if (!(await cLoc.isVisible().catch(() => false))) {
        // try role=menuitem
        const menuItem = page.getByRole('menuitem', { name: child }).first();
        if (await menuItem.isVisible().catch(() => false)) {
          await menuItem.click({ force: true, timeout: 8_000 }).catch(() => undefined);
          log.push(`click-menuitem:${child}`);
          await page.waitForTimeout(2_500);
          return true;
        }
        log.push(`miss-hover-child:${child}`);
        return false;
      }
      await cLoc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
      log.push(`hover-click:${parent}>${child}`);
      await page.waitForTimeout(2_500);
      return true;
    }
    await clickExact('More');
    await hoverThenClick('Group Sales', 'Group Booking');
    await clickExact('More');
    await hoverThenClick('Group Sales', 'Events');
    await page.getByText('Event Reservations', { exact: true }).first().click({ force: true, timeout: 8_000 }).catch(() => {
      log.push('miss:Event Reservations');
    });
    await page.waitForTimeout(2_000);
    await clickExact('More');
    await hoverThenClick('Profiles', 'Organization Profiles');
    await clickExact('More');
    await clickExact('Rate and Sales');
    const harvested = [
      ...new Set(
        caps
          .flatMap((c) => [c.systemFn, c.userFn, ...c.tokens].filter(Boolean) as string[])
          .map((x) => x.toUpperCase())
          .filter((x) => /^(OS|PS|AR|CS)[A-Z0-9]{3,10}$/.test(x)),
      ),
    ].sort();

    // Soft-open any new group-ish codes
    const opens: Record<string, { status: number; bytes: number; stub813: boolean }> = {};
    for (const fn of harvested.filter((f) => /GR|EV|BLK|BOOK|COMP|ACCT|ACBL|PROF|BEO|ALLT/i.test(f)).slice(0, 20)) {
      opens[fn] = await page.evaluate(async (functionName) => {
        try {
          const r = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              FUNCTION_CLASS: 'WEBL',
              removescreenflows: 'yes',
            }).toString(),
          });
          const text = await r.text();
          return { status: r.status, bytes: text.length, stub813: text.length === 813 };
        } catch {
          return { status: 0, bytes: 0, stub813: false };
        }
      }, fn);
    }

    const out = {
      schemaVersion: 1,
      hdr,
      searches,
      clickLog: log,
      harvestedFns: harvested,
      captureSample: caps.slice(0, 60),
      opens,
      realOpens: Object.entries(opens)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
        .map(([fn, v]) => ({ fn, bytes: v.bytes })),
    };
    await writeFile(join(outDir, 'more-group-search.sanitized.v1.json'), `${JSON.stringify(out, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(JSON.stringify({ ok: true, outDir, ...out }) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write((/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) + '\n');
  process.exit(1);
});
