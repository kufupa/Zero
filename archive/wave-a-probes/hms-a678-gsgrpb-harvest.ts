/**
 * Harvest function tokens from open GSGRPB.HDR + probe OSORGP variants.
 * Then summarize GSGRPB.LST grid keys (no PII values). HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';
import { extractOsressPageData } from '../src/hms/live-guest-stay-driver.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A678_HARVEST_OUT ?? '/tmp/a678-gsgrpb-harvest.sanitized.v1.json';

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

    const harvest = await page.evaluate(async () => {
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

      const hdr = await fetch('/web/base/GSGRPB.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      });
      const hdrText = await hdr.text();
      const fns = [
        ...new Set(
          [...hdrText.matchAll(/\b((?:GS|OS|PS|AR|PR|CS|EV)[A-Z0-9]{3,8})\b/g)].map(
            (m) => m[1]!,
          ),
        ),
      ]
        .filter((f) => !/^(GSS|OSS|PSS)$/.test(f))
        .sort();

      const lst = await fetch('/web/base/GSGRPB.LST', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          CURRENT_TAB_NAME: 'LST',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_ID: '0',
          GRID_NAME: 'GSGRPB',
          ONLY_DATA_REQUIRED: 'true',
        }).toString(),
      });
      const lstText = await lst.text();

      return {
        hdr: { status: hdr.status, bytes: hdrText.length },
        lst: { status: lst.status, bytes: lstText.length },
        fnsFromHdr: fns.slice(0, 80),
        lstText,
      };
    });

    const pageData = extractOsressPageData(harvest.lstText);
    let dataKeys: string[] = [];
    let gridRows = 0;
    let sampleKeyPresence: Record<string, boolean> = {};
    if (pageData) {
      const grid = (pageData as { grid?: { GRIDRESULT?: { GRID?: { DATA?: unknown[] } } } })
        .grid?.GRIDRESULT?.GRID;
      const data = grid?.DATA;
      if (Array.isArray(data)) {
        gridRows = data.length;
        const row = data[0];
        if (row && typeof row === 'object') {
          dataKeys = Object.keys(row as object).sort();
          for (const k of [
            'groupcode',
            'groupname',
            'status',
            'startdate',
            'enddate',
            'arrivaldate',
            'departuredate',
            'con',
            'blk',
            'pickup',
            'remaining',
          ]) {
            sampleKeyPresence[k] = dataKeys.some((dk) => dk.toLowerCase() === k);
          }
        }
      }
    }

    // Probe harvested event/org-ish codes
    const probeFns = harvest.fnsFromHdr
      .filter((f) => /EV|ORG|COMP|BEO|MEET|PROF|ACCT|BOOK/i.test(f))
      .slice(0, 25);
    const probes: Record<string, { status: number; bytes: number; stub813: boolean }> = {};
    for (const fn of probeFns) {
      for (const path of [fn, `${fn}.HDR`, `${fn}.LST`]) {
        probes[path] = await page.evaluate(async (p) => {
          const name = p.split('.')[0]!;
          const tab = p.includes('.') ? p.split('.')[1]! : '';
          const url = p.includes('.')
            ? `/web/base/${p}`
            : `/web/base/${p}?FUNCTION_CLASS=WEBL`;
          const body: Record<string, string> = {
            SYSTEM_FUNCTION_NAME: name,
            USER_FUNCTION_NAME: name,
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          };
          if (tab) body.CURRENT_TAB_NAME = tab;
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body).toString(),
          });
          const text = await r.text();
          return {
            status: r.status,
            bytes: text.length,
            stub813: text.length === 813,
          };
        }, path);
      }
    }

    const realProbes = Object.entries(probes)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
      .map(([fn, v]) => ({ fn, bytes: v.bytes }));

    const out = {
      schemaVersion: 1,
      hdr: harvest.hdr,
      lst: { status: harvest.lst.status, bytes: harvest.lst.bytes },
      fnsFromHdr: harvest.fnsFromHdr,
      gridRows,
      dataKeys,
      sampleKeyPresence,
      pageDataFound: Boolean(pageData),
      realProbes,
      probes,
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
