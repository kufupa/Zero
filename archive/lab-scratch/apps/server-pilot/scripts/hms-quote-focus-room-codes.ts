/**
 * Focused A5 quote: early-open OSRRAV.HDR then search with OSRTAV-harvested room codes.
 * HMS_DISCOVERY_ALLOW_LIVE=1. Codes only.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/src/hms/runtime.js';

const ROOM_CODES = [
  'DLXQN',
  'DLXTWN',
  'DLXKNG',
  'EXKNG',
  'LUXKNG',
  'SKNG',
  'STQN',
  'STWN',
  'SUITE',
];

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_QUOTE_FOCUS_OUT ?? '/tmp/hms-quote-focus.sanitized.v1.json';

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

    // Warm + early HDR only — no other surfaces
    const early = await page.evaluate(async () => {
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
      const hdr = await fetch('/web/base/OSRRAV.HDR', {
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
      const text = await hdr.text();
      return {
        status: hdr.status,
        bytes: text.length,
        hasRoomtypes: /roomtypes/i.test(text),
      };
    });

    const trials: Array<Record<string, unknown>> = [];
    for (const roomtypes of ROOM_CODES) {
      for (const rateplans of ['', 'BAR', 'RACK', 'TRANSI']) {
        const one = await page.evaluate(
          async (payload) => {
            // Re-open HDR before each search (session hygiene)
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
              roomtypes: payload.roomtypes,
              rateplans: payload.rateplans,
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
            const msgMatch = text.match(/"msg"\s*:\s*"([^"]{0,200})"/);
            return {
              roomtypes: payload.roomtypes,
              rateplans: payload.rateplans,
              status: r.status,
              bytes: text.length,
              stub813: text.length === 813,
              hasAvailabilitydata: /availabilitydata/i.test(text),
              hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
              hasRatePlanCode: /ratePlanCode/i.test(text),
              msg: msgMatch ? msgMatch[1] : null,
              successFalse: /"success"\s*:\s*false/.test(text),
              successTrue: /"success"\s*:\s*true/.test(text),
            };
          },
          { roomtypes, rateplans },
        );
        trials.push(one);
        if (one.hasAvailabilitydata || one.stub813) {
          // stop rateplan loop on hit or session death
          if (one.hasAvailabilitydata) break;
        }
      }
      if (trials.some((t) => t.hasAvailabilitydata)) break;
      if (trials.filter((t) => t.stub813).length >= 2) break;
    }

    const out = {
      schemaVersion: 1,
      early,
      trials,
      hit: trials.find((t) => t.hasAvailabilitydata) ?? null,
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
