/**
 * Sanitize OSRRAV.HDR structure + OSRESS.search (correct path) for room/rate codes.
 * HMS_DISCOVERY_ALLOW_LIVE=1. Codes only — no guest names.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { buildExactOsressSearchBody } from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const conf = process.env.HMS_CONFIRMATION?.trim() || '58995484-1';
  const outPath =
    process.env.HMS_HDR_STRUCT_OUT ?? '/tmp/hms-hdr-struct.sanitized.v1.json';

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

    const hdrStruct = await page.evaluate(async () => {
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
      const names = [
        ...new Set(
          [...text.matchAll(/name=["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]!),
        ),
      ].sort();
      const ban =
        /^(OPTIONAL|TRUE|FALSE|NULL|HDR|WEBL|HRCEN|TRANSI|ZAR|YES|NO|ON|OFF|DISPLAY|SEARCH)$/i;
      const codeish = [
        ...text.matchAll(/"(?:code|value|id)"\s*:\s*"([A-Z0-9][A-Z0-9._/-]{1,15})"/g),
      ]
        .map((m) => m[1]!)
        .filter((c) => /^[A-Z0-9]{2,12}$/.test(c) && !ban.test(c));
      const upperCodes = [...new Set(codeish)].slice(0, 40);
      const probes: Record<
        string,
        { status: number; bytes: number; stub813: boolean; hasRoom: boolean }
      > = {};
      for (const fn of ['CSVAVL', 'OSRTAV', 'OSRPAV', 'OSRSAV', 'OSRSVL', 'OSRRAV']) {
        const r = await fetch(`/web/base/${fn}?FUNCTION_CLASS=WEBL`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: fn,
            USER_FUNCTION_NAME: fn,
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          }).toString(),
        });
        const t = await r.text();
        probes[fn] = {
          status: r.status,
          bytes: t.length,
          stub813: t.length === 813,
          hasRoom: /roomtype/i.test(t),
        };
      }
      return {
        status: hdr.status,
        bytes: text.length,
        inputNames: names.slice(0, 80),
        upperCodes,
        probes,
      };
    });

    // Correct production path: /web/base/OSRESS.search
    const searchBody = buildExactOsressSearchBody({
      kind: 'confirmation',
      value: conf,
    } as Parameters<typeof buildExactOsressSearchBody>[0]);

    const osress = await page.evaluate(async (body) => {
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
      let roomtype: string | null = null;
      let rateplan: string | null = null;
      let gridRows = 0;
      let pageDataFound = false;
      const markers = ['pageData:', '"pageData":', "'pageData':"];
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
          const pageData = JSON.parse(text.slice(brace, end + 1)) as {
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
          /* next */
        }
      }
      return {
        status: r.status,
        bytes: text.length,
        pageDataFound,
        gridRows,
        roomtype,
        rateplan,
        hasAvailabilityToken: /availabilitydata/i.test(text),
        headMasked: text
          .slice(0, 200)
          .replace(/\d/g, '#')
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[redacted]'),
      };
    }, searchBody);

    // Quote trials if we have a roomtype
    const roomtype = osress.roomtype || hdrStruct.upperCodes[0] || null;
    const rateplan = osress.rateplan || null;
    const quoteTrials: Array<Record<string, unknown>> = [];
    if (roomtype) {
      const one = await page.evaluate(
        async (payload) => {
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
            roomtypes: payload.roomtype,
            rateplans: payload.rateplan || '',
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
            status: r.status,
            bytes: text.length,
            hasAvailabilitydata: /availabilitydata/i.test(text),
            hasRoomTypeInvArray: /roomTypeInvArray/i.test(text),
            msg: msgMatch ? msgMatch[1] : null,
            successFalse: /"success"\s*:\s*false/.test(text),
          };
        },
        { roomtype, rateplan },
      );
      quoteTrials.push({ roomtype, rateplan, ...one });
    }

    const out = {
      schemaVersion: 1,
      confirmationUsed: conf,
      hdrStruct,
      osress,
      resolved: { roomtype, rateplan },
      quoteTrials,
      searchBodyKeys: Object.keys(searchBody),
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
