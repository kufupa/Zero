/**
 * Sanitize OSRRAV.HDR.search envelope shape for parser alignment.
 * HMS_DISCOVERY_ALLOW_LIVE=1. Structure only.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';
import { extractOsressPageData } from '../src/hms/live-guest-stay-driver.js';
import { parseOsrravSearchEnvelope } from '../src/hms/live-quote-stay-driver.js';

function keysOf(o: unknown): string[] | null {
  return o && typeof o === 'object' ? Object.keys(o as object).slice(0, 40) : null;
}

function dig(o: unknown, path: Array<string | number>): unknown {
  let cur: unknown = o;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A5_SHAPE_OUT ?? '/tmp/a5-envelope-shape.sanitized.v1.json';

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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  try {
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

    const text = await page.evaluate(async () => {
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
      await fetch('/web/base/OSRRAV.HDR', {
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
      const body: Record<string, string> = {
        property: 'HRCEN',
        roomtypes: 'DLXQN',
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
      };
      const r = await fetch('/web/base/OSRRAV.HDR.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      return await r.text();
    });

    const pageData = extractOsressPageData(text);
    const env = parseOsrravSearchEnvelope(text);
    const values =
      env && typeof env === 'object' ? (env as { values?: unknown }).values : null;
    const ad =
      values && typeof values === 'object'
        ? (values as { availabilitydata?: unknown }).availabilitydata
        : null;

    const firstRt = dig(ad, ['roomTypeInvArray', 0]) as Record<string, unknown> | null;
    const firstRp = dig(ad, ['roomTypeInvArray', 0, 'ratePlanInvArray', 0]) as
      | Record<string, unknown>
      | null;
    const firstDay = dig(ad, [
      'roomTypeInvArray',
      0,
      'ratePlanInvArray',
      0,
      'ratePlanDailyInvArray',
      0,
    ]) as Record<string, unknown> | null;

    const typeMap = (o: Record<string, unknown> | null) =>
      o
        ? Object.fromEntries(
            Object.entries(o).map(([k, v]) => [
              k,
              Array.isArray(v) ? `array:${v.length}` : v === null ? 'null' : typeof v,
            ]),
          )
        : null;

    // Find which object actually holds roomTypeInvArray
    let holderPath: string | null = null;
    if (/roomTypeInvArray/i.test(text)) {
      if (dig(env, ['values', 'availabilitydata', 'roomTypeInvArray'])) {
        holderPath = 'env.values.availabilitydata';
      } else if (dig(pageData, ['values', 'availabilitydata', 'roomTypeInvArray'])) {
        holderPath = 'pageData.values.availabilitydata';
      } else if (dig(pageData, ['availabilitydata', 'roomTypeInvArray'])) {
        holderPath = 'pageData.availabilitydata';
      } else if (dig(env, ['availabilitydata', 'roomTypeInvArray'])) {
        holderPath = 'env.availabilitydata';
      }
    }

    const summary = {
      bytes: text.length,
      startsWith: text.trim().slice(0, 60).replace(/\d/g, '#'),
      hasPageDataMarker: /pageData/i.test(text),
      hasAvailabilitydata: /availabilitydata/i.test(text),
      hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
      extractOsressPageDataKeys: keysOf(pageData),
      parseOsrravKeys: keysOf(env),
      envSuccess: env && (env as { success?: unknown }).success,
      valuesKeys: keysOf(values),
      adKeys: keysOf(ad),
      holderPath,
      roomTypeInvLen: Array.isArray(dig(ad, ['roomTypeInvArray']))
        ? (dig(ad, ['roomTypeInvArray']) as unknown[]).length
        : null,
      firstRtTypes: typeMap(firstRt),
      firstRpTypes: typeMap(firstRp),
      firstDayTypes: typeMap(firstDay),
      firstRtCode: dig(ad, ['roomTypeInvArray', 0, 'roomTypeCode']),
      firstRpCode: dig(ad, ['roomTypeInvArray', 0, 'ratePlanInvArray', 0, 'ratePlanCode']),
      firstDayDate: dig(ad, [
        'roomTypeInvArray',
        0,
        'ratePlanInvArray',
        0,
        'ratePlanDailyInvArray',
        0,
        'date',
      ]),
      firstDayRateType: (() => {
        const v = dig(ad, [
          'roomTypeInvArray',
          0,
          'ratePlanInvArray',
          0,
          'ratePlanDailyInvArray',
          0,
          'roomRate',
        ]);
        return v === null || v === undefined ? null : typeof v;
      })(),
      rawAvailKeyMatch: (text.match(/availabilitydata/i) || [])[0] ?? null,
      rawRoomTypeKeyMatch:
        (text.match(/roomTypeInvArray|roomtypeinvarray|ROOMTYPEINVARRAY/i) || [])[0] ?? null,
      availSnippetMasked: (() => {
        const i = text.search(/availabilitydata/i);
        if (i < 0) return null;
        return text
          .slice(Math.max(0, i - 40), i + 120)
          .replace(/\d/g, '#')
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[redacted]');
      })(),
    };

    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, outPath, ...summary }) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) + '\n',
  );
  process.exit(1);
});
