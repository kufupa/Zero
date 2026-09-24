/**
 * Pull roomtype/rateplan codes for OSRRAV.HDR.search scoping.
 * Emits codes only — no guest names. HMS_DISCOVERY_ALLOW_LIVE=1.
 *
 * Avoid nested named functions inside page.evaluate (tsx injects __name).
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

    // Warm BSSTRT then early-open OSRRAV.HDR (A3 unlock order).
    const hdrMeta = await page.evaluate(async () => {
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
      const roomFromValue = text.match(/\bname\s*=\s*["']roomtypes["'][^>]*value\s*=\s*["']([^"']{1,32})["']/i);
      const rateFromValue = text.match(/\bname\s*=\s*["']rateplans["'][^>]*value\s*=\s*["']([^"']{1,32})["']/i);
      const roomCodes: string[] = [];
      const rateCodes: string[] = [];
      const roomRe = /roomtype(?:code|s)?["']?\s*[:=]\s*["']([A-Za-z0-9][A-Za-z0-9._/-]{0,31})["']/gi;
      const rateRe = /rateplan(?:code|s)?["']?\s*[:=]\s*["']([A-Za-z0-9][A-Za-z0-9._/-]{0,31})["']/gi;
      let m: RegExpExecArray | null;
      while ((m = roomRe.exec(text)) !== null) {
        if (roomCodes.length < 20 && !roomCodes.includes(m[1]!)) roomCodes.push(m[1]!);
      }
      while ((m = rateRe.exec(text)) !== null) {
        if (rateCodes.length < 20 && !rateCodes.includes(m[1]!)) rateCodes.push(m[1]!);
      }
      return {
        status: hdr.status,
        bytes: text.length,
        hasRoomtypes: /roomtypes/i.test(text),
        roomFromValue: roomFromValue?.[1] ?? null,
        rateFromValue: rateFromValue?.[1] ?? null,
        roomCodes,
        rateCodes,
      };
    });

    // OSRESS search → parse pageData GRID DATA[0] roomtype/rateplan
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
      let roomtype: string | null = null;
      let rateplan: string | null = null;
      let gridRows = 0;
      let pageDataFound = false;
      const markers = ['pageData:', '"pageData":', "'pageData':"];
      for (const marker of markers) {
        const idx = searchText.indexOf(marker);
        if (idx < 0) continue;
        const brace = searchText.indexOf('{', idx + marker.length - 1);
        if (brace < 0) continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let quote = '';
        let end = -1;
        for (let j = brace; j < searchText.length; j++) {
          const ch = searchText[j]!;
          if (inStr) {
            if (esc) {
              esc = false;
              continue;
            }
            if (ch === '\\') {
              esc = true;
              continue;
            }
            if (ch === quote) inStr = false;
            continue;
          }
          if (ch === '"' || ch === "'") {
            inStr = true;
            quote = ch;
            continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        if (end < 0) continue;
        try {
          const pageData = JSON.parse(searchText.slice(brace, end + 1)) as {
            grid?: { GRIDRESULT?: { GRID?: { DATA?: Array<Record<string, unknown>> } } };
          };
          pageDataFound = true;
          const data = pageData.grid?.GRIDRESULT?.GRID?.DATA;
          if (Array.isArray(data)) {
            gridRows = data.length;
            const row = data[0];
            if (row && typeof row === 'object') {
              const rt = row.roomtype ?? row.ROOMTYPE;
              const rp = row.rateplan ?? row.RATEPLAN;
              if (typeof rt === 'string' && rt.trim()) roomtype = rt.trim();
              if (typeof rp === 'string' && rp.trim()) rateplan = rp.trim();
            }
          }
          break;
        } catch {
          /* try next marker */
        }
      }
      if (!roomtype) {
        const m = searchText.match(/"roomtype"\s*:\s*"([^"]{1,32})"/i);
        if (m) roomtype = m[1]!;
      }
      if (!rateplan) {
        const m = searchText.match(/"rateplan"\s*:\s*"([^"]{1,32})"/i);
        if (m) rateplan = m[1]!;
      }
      return {
        searchStatus: search.status,
        searchBytes: searchText.length,
        pageDataFound,
        gridRows,
        roomtype,
        rateplan,
        hasRoomtypeKey: /roomtype/i.test(searchText),
        hasRateplanKey: /rateplan/i.test(searchText),
      };
    }, conf);

    const roomtype =
      detail.roomtype || hdrMeta.roomFromValue || hdrMeta.roomCodes[0] || null;
    const rateplan =
      detail.rateplan || hdrMeta.rateFromValue || hdrMeta.rateCodes[0] || null;

    // Quote search trials: MM/DD/YYYY chrome (live-proven) + optional DD-MON-YYYY
    const trials: Array<Record<string, unknown>> = [];
    if (roomtype) {
      const bodies = [
        {
          label: 'mdy_with_rate',
          roomtypes: roomtype,
          rateplans: rateplan || '',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
        {
          label: 'mdy_room_only',
          roomtypes: roomtype,
          rateplans: '',
          startdate: '09/15/2026',
          hoteldate: '09/12/2026',
          firstcolumndate: '09/15/2026',
        },
        {
          label: 'ddmon_with_rate',
          roomtypes: roomtype,
          rateplans: rateplan || '',
          startdate: '15-SEP-2026',
          hoteldate: '12-SEP-2026',
          firstcolumndate: '15-SEP-2026',
        },
      ];
      for (const b of bodies) {
        const one = await page.evaluate(async (payload) => {
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
            startdate: payload.startdate,
            currency: 'ZAR',
            rowpagesize: '14',
            salesstrategy_display: 'TRANSI',
            currency_display: 'ZAR',
            adults_display: '2',
            children_display: '0',
            hoteldate: payload.hoteldate,
            firstcolumndate: payload.firstcolumndate,
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
          const msgMatch = text.match(/"msg"\s*:\s*"([^"]{0,160})"/);
          return {
            label: payload.label,
            status: r.status,
            bytes: text.length,
            hasAvailabilitydata: /availabilitydata/i.test(text),
            hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
            msg: msgMatch ? msgMatch[1] : null,
            successFalse: /"success"\s*:\s*false/.test(text),
          };
        }, b);
        trials.push(one);
        if (one.hasAvailabilitydata) break;
      }
    }

    const out = {
      schemaVersion: 1,
      confirmationUsed: conf,
      hdrMeta,
      detail,
      resolved: { roomtype, rateplan },
      quoteTrials: trials,
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
