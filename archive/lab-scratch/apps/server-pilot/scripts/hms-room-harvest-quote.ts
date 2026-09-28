/**
 * Dump OSRESS GRID keys (no PII values) + harvest OSRTAV/OSRRAV room-type codes
 * + quote search trials. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import {
  buildExactOsressSearchBody,
  type ReservationSearchCandidate,
} from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const conf = process.env.HMS_CONFIRMATION?.trim() || '58995484-1';
  const outPath =
    process.env.HMS_ROOM_HARVEST_OUT ?? '/tmp/hms-room-harvest.sanitized.v1.json';

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

    const candidate: ReservationSearchCandidate = {
      id: 'wave-a-room-harvest',
      kind: 'confirmation',
      value: conf,
    };
    const searchBody = buildExactOsressSearchBody(candidate);

    const gridMeta = await page.evaluate(async (body) => {
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
      await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          USER_FUNCTION_NAME: 'OSRESS',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      const r = await fetch('/web/base/OSRESS.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const text = await r.text();
      let dataKeys: string[] = [];
      let metaCols: string[] = [];
      let roomtype: string | null = null;
      let rateplan: string | null = null;
      let gridRows = 0;
      const markers = ['pageData:', '"pageData":'];
      for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx < 0) continue;
        const brace = text.indexOf('{', idx + marker.length - 1);
        if (brace < 0) continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let quote = '';
        let end = -1;
        for (let j = brace; j < text.length; j++) {
          const ch = text[j]!;
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
          const pageData = JSON.parse(text.slice(brace, end + 1)) as Record<string, unknown>;
          const gridWrap = pageData.grid as Record<string, unknown> | undefined;
          const gridResult = gridWrap?.GRIDRESULT as Record<string, unknown> | undefined;
          const grid = gridResult?.GRID as Record<string, unknown> | undefined;
          const meta = grid?.METADATA as Record<string, unknown> | undefined;
          const cols = meta?.COLUMNS as unknown;
          if (Array.isArray(cols)) {
            metaCols = cols
              .map((c) => {
                if (c && typeof c === 'object' && 'name' in c) {
                  return String((c as { name: unknown }).name);
                }
                return typeof c === 'string' ? c : '';
              })
              .filter(Boolean)
              .slice(0, 80);
          }
          const data = grid?.DATA as unknown;
          if (Array.isArray(data)) {
            gridRows = data.length;
            const row = data[0];
            if (row && typeof row === 'object') {
              dataKeys = Object.keys(row as object).sort();
              const rec = row as Record<string, unknown>;
              for (const k of dataKeys) {
                if (/roomtype/i.test(k) && typeof rec[k] === 'string' && String(rec[k]).trim()) {
                  roomtype = String(rec[k]).trim();
                }
                if (/rateplan/i.test(k) && typeof rec[k] === 'string' && String(rec[k]).trim()) {
                  rateplan = String(rec[k]).trim();
                }
              }
            }
          }
          break;
        } catch {
          /* next */
        }
      }
      return {
        status: r.status,
        bytes: text.length,
        gridRows,
        metaCols,
        dataKeys,
        roomtype,
        rateplan,
      };
    }, searchBody);

    // Harvest roomtype codes from OSRTAV.HDR / OSRRAV.HDR (structure only)
    const surfaceHarvest = await page.evaluate(async () => {
      const ban =
        /^(OPTIONAL|TRUE|FALSE|NULL|HDR|WEBL|HRCEN|TRANSI|ZAR|YES|NO|ON|OFF|DISPLAY|SEARCH|PRESET|BAR|PROMO|WS|CON|GNC|GOV|CMPHS|OTH|AUD|CHF|EUR|GBP|USD|DY|MO|WK)$/i;
      const out: Record<
        string,
        {
          status: number;
          bytes: number;
          candidateCodes: string[];
          hasRoomtypes: boolean;
          inputNames: string[];
        }
      > = {};
      for (const fn of ['OSRTAV.HDR', 'OSRRAV.HDR', 'OSRPAV.HDR', 'OSRTAV', 'OSRRAV']) {
        const r = await fetch(`/web/base/${fn}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: fn.split('.')[0]!,
            USER_FUNCTION_NAME: fn.split('.')[0]!,
            CURRENT_TAB_NAME: fn.includes('.') ? 'HDR' : '',
            FUNCTION_CLASS: 'WEBL',
          }).toString(),
        });
        const text = await r.text();
        const names = [
          ...new Set(
            [...text.matchAll(/name=["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]!),
          ),
        ].sort();
        // Prefer tokens near roomtype / roomtypes fields
        const near: string[] = [];
        const reNear =
          /roomtypes?[^]{0,200}?"([A-Z0-9][A-Z0-9._/-]{1,15})"|\"([A-Z0-9][A-Z0-9._/-]{1,15})\"[^]{0,200}?roomtypes?/gi;
        let m: RegExpExecArray | null;
        while ((m = reNear.exec(text)) !== null) {
          const c = (m[1] || m[2] || '').toUpperCase();
          if (c && !ban.test(c) && !near.includes(c) && near.length < 30) near.push(c);
        }
        // Also collect short uppercase codes that look like room types (2-6 chars, letters)
        const alphaCodes = [
          ...text.matchAll(/"([A-Z][A-Z0-9]{1,5})"/g),
        ]
          .map((x) => x[1]!)
          .filter((c) => !ban.test(c) && /[A-Z]/.test(c) && !/^\d+$/.test(c));
        const candidateCodes = [
          ...new Set([...near, ...alphaCodes.filter((c) => c.length >= 2 && c.length <= 6)]),
        ].slice(0, 40);
        out[fn] = {
          status: r.status,
          bytes: text.length,
          candidateCodes,
          hasRoomtypes: /roomtypes/i.test(text),
          inputNames: names.slice(0, 40),
        };
      }
      return out;
    });

    // Collect trial room codes: grid roomtype + surface candidates (prefer letter codes)
    const trialRooms = [
      ...new Set(
        [
          gridMeta.roomtype,
          ...Object.values(surfaceHarvest).flatMap((s) => s.candidateCodes),
        ].filter((x): x is string => Boolean(x) && !/^\d{1,2}$/.test(x)),
      ),
    ].slice(0, 12);

    const quoteTrials: Array<Record<string, unknown>> = [];
    for (const roomtypes of trialRooms) {
      const one = await page.evaluate(async (rt) => {
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
        const msgMatch = text.match(/"msg"\s*:\s*"([^"]{0,160})"/);
        return {
          roomtypes: rt,
          status: r.status,
          bytes: text.length,
          hasAvailabilitydata: /availabilitydata/i.test(text),
          hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
          msg: msgMatch ? msgMatch[1] : null,
          successFalse: /"success"\s*:\s*false/.test(text),
        };
      }, roomtypes);
      quoteTrials.push(one);
      if (one.hasAvailabilitydata) break;
    }

    // Also try salesstrategy-only with showunavailable + smaller rowpagesize
    // (docs: sales strategy scopes room types; empty roomtypes may still overlimit)
    const strategyTrial = await page.evaluate(async () => {
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
        roomtypes: '',
        rateplans: 'BAR',
        salesstrategy: 'TRANSI',
        showunavailable: '0',
        ratetype: '',
        adults: '2',
        showexclusiverates: '0',
        showavailableforsale: 'on',
        children: '0',
        startdate: '09/15/2026',
        currency: 'ZAR',
        rowpagesize: '7',
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
      const msgMatch = text.match(/"msg"\s*:\s*"([^"]{0,160})"/);
      return {
        label: 'rateplan_BAR_only',
        status: r.status,
        bytes: text.length,
        hasAvailabilitydata: /availabilitydata/i.test(text),
        hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
        msg: msgMatch ? msgMatch[1] : null,
        successFalse: /"success"\s*:\s*false/.test(text),
      };
    });
    quoteTrials.push(strategyTrial);

    const out = {
      schemaVersion: 1,
      confirmationUsed: conf,
      gridMeta,
      surfaceHarvest,
      trialRooms,
      quoteTrials,
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
