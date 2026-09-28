/**
 * A5 search param matrix for DLXQN — report roomTypeInvArray length + sample codes.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';
import { parseOsrravSearchEnvelope } from '../src/hms/live-quote-stay-driver.js';

type Trial = {
  label: string;
  body: Record<string, string>;
};

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A5_MATRIX_OUT ?? '/tmp/a5-search-matrix.sanitized.v1.json';

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
    });

    const base = {
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
      currency: 'ZAR',
      rowpagesize: '14',
      salesstrategy_display: 'TRANSI',
      currency_display: 'ZAR',
      adults_display: '2',
      children_display: '0',
      pagemode: 'display',
      ONLY_DATA_REQUIRED: 'true',
      USER_FUNCTION_NAME: 'OSRRAV',
      SYSTEM_FUNCTION_NAME: 'OSRRAV',
      CURRENT_TAB_NAME: 'HDR',
    };

    const trials: Trial[] = [
      {
        label: 'mdy_transi_dlxqn',
        body: {
          ...base,
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'mdy_bar_rate',
        body: {
          ...base,
          rateplans: 'BAR',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'mdy_showunavail',
        body: {
          ...base,
          showunavailable: '1',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'mdy_empty_strategy',
        body: {
          ...base,
          salesstrategy: '',
          salesstrategy_display: '',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'ddmon_transi',
        body: {
          ...base,
          startdate: '15-SEP-2026',
          hoteldate: '12-SEP-2026',
          firstcolumndate: '15-SEP-2026',
        },
      },
      {
        label: 'mdy_near_term',
        body: {
          ...base,
          startdate: '09/13/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/13/2026',
        },
      },
      {
        label: 'mdy_stqn',
        body: {
          ...base,
          roomtypes: 'STQN',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'mdy_suite',
        body: {
          ...base,
          roomtypes: 'SUITE',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
      {
        label: 'mdy_adults1',
        body: {
          ...base,
          adults: '1',
          adults_display: '1',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
      },
    ];

    const results = [];
    for (const trial of trials) {
      const text = await page.evaluate(async (body) => {
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
        const r = await fetch('/web/base/OSRRAV.HDR.search', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body).toString(),
        });
        return await r.text();
      }, trial.body);

      const env = parseOsrravSearchEnvelope(text);
      const values = env?.values as Record<string, unknown> | undefined;
      const ad = values?.availabilitydata as Record<string, unknown> | undefined;
      const rtArr = Array.isArray(ad?.roomTypeInvArray)
        ? (ad!.roomTypeInvArray as Record<string, unknown>[])
        : [];
      const codes = rtArr
        .map((rt) => String(rt.roomTypeCode ?? ''))
        .filter(Boolean)
        .slice(0, 10);
      const rpCodes = rtArr
        .flatMap((rt) => {
          const rps = Array.isArray(rt.ratePlanInvArray)
            ? (rt.ratePlanInvArray as Record<string, unknown>[])
            : [];
          return rps.map((rp) => String(rp.ratePlanCode ?? ''));
        })
        .filter(Boolean)
        .slice(0, 10);
      const msgMatch = text.match(/"msg"\s*:\s*"([^"]{0,160})"/);
      results.push({
        label: trial.label,
        bytes: text.length,
        stub813: text.length === 813,
        roomTypeInvLen: rtArr.length,
        roomTypeCodes: codes,
        ratePlanCodes: [...new Set(rpCodes)],
        hasRoomTypeCodeToken: /"roomTypeCode"\s*:/.test(text),
        msg: msgMatch ? msgMatch[1] : null,
        successFalse: /"success"\s*:\s*false/.test(text),
        propertyDailyLen: Array.isArray(ad?.propertyDailyInvArray)
          ? (ad!.propertyDailyInvArray as unknown[]).length
          : null,
      });
    }

    const out = { schemaVersion: 1, results };
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
