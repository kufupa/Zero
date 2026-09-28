/**
 * A5 payload: OSRRAV.HDR.search with proven room code → parse nightly schedule.
 * HMS_DISCOVERY_ALLOW_LIVE=1. Sanitized observations only.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';
import { parseLiveQuoteAvailability } from '../src/hms/live-quote-stay-driver.js';
import type { QuoteStayCandidate } from '../src/hms/quote-stay-candidate.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const roomtypes = process.env.HMS_ROOMTYPES?.trim() || 'DLXQN';
  const outDir =
    process.env.HMS_A5_PAYLOAD_OUT ||
    '/tmp/wave-a-a5-payload';
  await mkdir(outDir, { recursive: true, mode: 0o700 });

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

    const searchText = await page.evaluate(async (rt) => {
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
        roomtypes: rt,
        rateplans: '',
        // TRANSI scopes room types out of inventory on HRCEN; empty strategy returns rows.
        salesstrategy: '',
        showunavailable: '0',
        ratetype: '',
        adults: '2',
        showexclusiverates: '0',
        showavailableforsale: 'on',
        children: '0',
        startdate: '09/15/2026',
        currency: 'ZAR',
        rowpagesize: '14',
        salesstrategy_display: '',
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
    }, roomtypes);

    const candidate: QuoteStayCandidate = {
      id: createHash('sha256').update(`a5:${roomtypes}`).digest('hex').slice(0, 32),
      kind: 'quote_stay',
      quoteRequestRef: `wave-a-a5-${roomtypes}`,
      arrivalDate: '2026-09-15',
      departureDate: '2026-09-17',
      adults: 2,
      children: 0,
      rooms: 1,
      roomType: roomtypes,
      ratePlan: 'BAR',
      currency: 'ZAR',
    };

    const parsed = parseLiveQuoteAvailability(searchText, candidate, new Date());
    const sha = createHash('sha256').update(searchText).digest('hex');

    const compare = {
      schemaVersion: 1,
      toolId: 'hms_quote_stay',
      finishedAt: new Date().toISOString(),
      verdict: parsed.rows.length > 0 ? 'PASS_NIGHTLY_SCHEDULE_PAYLOAD' : 'PARTIAL_ENVELOPE_NO_ROWS',
      allRequiredPass: parsed.rows.length > 0 && parsed.envelopeRecognized,
      liveEvidence: {
        roomtypes,
        searchBytes: searchText.length,
        searchSha256: sha,
        envelopeRecognized: parsed.envelopeRecognized,
        nightlyRowCount: parsed.rows.length,
        currency: parsed.currency,
        unresolvedFields: parsed.unresolvedFields,
        sampleNights: parsed.rows.slice(0, 6).map((r) => ({
          date: r.date,
          roomType: r.roomType,
          ratePlan: r.ratePlan,
          availableCount: r.availableCount,
          displayedAmount: r.displayedAmount,
          currency: r.currency,
          rateBasis: r.rateBasis,
          restrictions: r.restrictions,
        })),
      },
      packaging: {
        note: 'payload reopen — packaging videos already exist; this artifact proves nightly schedule',
      },
      rca: {
        priorBlocker: 'probe-order 813 stub + missing room codes',
        unlock: 'BSSTRT warm → OSRRAV.HDR early-open → roomtypes from OSRTAV.HDR (DLXQN…)',
      },
    };

    await writeFile(join(outDir, 'compare.v1.json'), `${JSON.stringify(compare, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(outDir, 'nightly.sanitized.v1.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          envelopeRecognized: parsed.envelopeRecognized,
          currency: parsed.currency,
          unresolvedFields: parsed.unresolvedFields,
          rows: parsed.rows.slice(0, 40),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    process.stdout.write(
      JSON.stringify({
        ok: true,
        outDir,
        allRequiredPass: compare.allRequiredPass,
        nightlyRowCount: parsed.rows.length,
        currency: parsed.currency,
        unresolvedFields: parsed.unresolvedFields,
        searchBytes: searchText.length,
        searchSha256: sha,
      }) + '\n',
    );
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
