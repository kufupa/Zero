/**
 * Pull roomtype/rateplan codes from Guest Stay detail for OSRRAV search scoping.
 * Emits codes only — no guest names. HMS_DISCOVERY_ALLOW_LIVE=1.
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
  const conf = process.env.HMS_CONFIRMATION?.trim() || '58995484-1';
  const outPath =
    process.env.HMS_ROOM_CODES_OUT ?? '/tmp/hms-room-rate-codes.sanitized.v1.json';

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

    // Open OSRESS then HDR
    const detail = await page.evaluate(async (confirmation) => {
      await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          USER_FUNCTION_NAME: 'OSRESS',
          FUNCTION_CLASS: 'WEBL',
          removescreenflows: 'yes',
        }).toString(),
      });
      // Search by confirmation (structure response)
      const search = await fetch('/web/base/OSRESS.HDR.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          USER_FUNCTION_NAME: 'OSRESS',
          CURRENT_TAB_NAME: 'HDR',
          confirmationnumber: confirmation,
          ONLY_DATA_REQUIRED: 'true',
          pageaction: 'search',
        }).toString(),
      });
      const searchText = await search.text();
      // Pull roomtype/rateplan from GRID-ish JSON keys if present
      const pick = (re: RegExp) => {
        const m = searchText.match(re);
        return m?.[1] ?? null;
      };
      const roomtype =
        pick(/"roomtype"\s*:\s*"([^"]{1,32})"/i) ||
        pick(/"ROOMTYPE"\s*:\s*"([^"]{1,32})"/);
      const rateplan =
        pick(/"rateplan"\s*:\s*"([^"]{1,32})"/i) ||
        pick(/"RATEPLAN"\s*:\s*"([^"]{1,32})"/);
      return {
        searchStatus: search.status,
        searchBytes: searchText.length,
        roomtype,
        rateplan,
        hasRoomtypeKey: /roomtype/i.test(searchText),
        hasRateplanKey: /rateplan/i.test(searchText),
        // sample of field-like keys only
        keys: [
          ...new Set(
            [...searchText.matchAll(/"(roomtype|rateplan|room|confirmationnumber|arrivaldate|departuredate)"/gi)].map(
              (m) => m[1]!.toLowerCase(),
            ),
          ),
        ],
      };
    }, conf);

    // Also try OSRRAV search with extracted codes if present
    let quoteSearch = null;
    if (detail.roomtype) {
      quoteSearch = await page.evaluate(
        async ({ roomtype, rateplan }) => {
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
          const body = {
            property: 'HRCEN',
            roomtypes: roomtype,
            rateplans: rateplan || '',
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
          const text = await r.text();
          return {
            status: r.status,
            bytes: text.length,
            hasAvailabilitydata: /availabilitydata/i.test(text),
            msg: (text.match(/"msg"\s*:\s*"([^"]{0,160})"/) || [])[1] ?? null,
            successFalse: /"success"\s*:\s*false/.test(text),
          };
        },
        { roomtype: detail.roomtype, rateplan: detail.rateplan },
      );
    }

    const out = {
      schemaVersion: 1,
      confirmationUsed: conf,
      detail,
      quoteSearch,
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, outPath, ...out }) + '\n');
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
