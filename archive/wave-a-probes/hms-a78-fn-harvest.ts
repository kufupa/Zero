/**
 * After GSGRPB early-open, harvest ALL function-like tokens from HDR HTML
 * and soft-open EV/ORG/PROF/COMP/BEO candidates. HMS_DISCOVERY_ALLOW_LIVE=1.
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
  const outPath =
    process.env.HMS_A78_HARVEST_OUT ?? '/tmp/a78-fn-harvest.sanitized.v1.json';

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
      await fetch('/web/base/GSGRPB?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
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
      const text = await hdr.text();
      const allFns = [
        ...new Set(
          [...text.matchAll(/\b([A-Z]{2}[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
        ),
      ].sort();
      const menuKeys = [
        ...new Set(
          [...text.matchAll(/MENU_MODULE_KEY["'\s:=]+([0-9A-Za-z_-]{1,32})/g)].map(
            (m) => m[1]!,
          ),
        ),
      ].slice(0, 20);
      const pathHints = [
        ...new Set(
          [...text.matchAll(/\/web\/base\/([A-Z][A-Z0-9.]{2,20})/g)].map((m) => m[1]!),
        ),
      ].slice(0, 40);
      return {
        hdrBytes: text.length,
        allFns,
        eventish: allFns.filter((f) => /EV|BEO|MEET|FUNC|CATER/i.test(f)),
        orgish: allFns.filter((f) => /ORG|COMP|PROF|ACCT|AGEN|BILL/i.test(f)),
        menuKeys,
        pathHints,
      };
    });

    // Also try known profile/event prefixes after GSGRPB session warm
    const extra = [
      'GSEVNT',
      'OSEVNT',
      'PSEVNT',
      'GSEVRS',
      'GSEVRE',
      'GSEVMA',
      'GSEVAV',
      'GSBEO',
      'OSORGP',
      'OSORGP.HDR',
      'OSORGP.LST',
      'PRORGP',
      'PRORGP.HDR',
      'PRORGP.LST',
      'PSORGP',
      'PSORGP.HDR',
      'PSORGP.LST',
      'ARORGP',
      'OSCOMP',
      'OSCOMP.HDR',
      'OSCOMP.LST',
      'PRCOMP',
      'PRPROF',
      'PRPROF.HDR',
      'PRPROF.LST',
      'OSPROF',
      'OSPROF.HDR',
      'OSPROF.LST',
      'CSORGP',
      'CSORGP.HDR',
      'CSORGP.LST',
      ...harvest.eventish,
      ...harvest.orgish,
      ...harvest.pathHints.filter((p) => !p.includes('.')),
    ];
    const unique = [...new Set(extra)];

    const opens: Record<string, { status: number; bytes: number; stub813: boolean }> = {};
    for (const path of unique.slice(0, 60)) {
      opens[path] = await page.evaluate(async (p) => {
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
        else {
          body.CURRENT_TAB_NAME = '';
          body.MENU_MODULE_KEY = '0';
        }
        try {
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
        } catch {
          return { status: 0, bytes: 0, stub813: false };
        }
      }, path);
    }

    const realOpens = Object.entries(opens)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
      .map(([fn, v]) => ({ fn, bytes: v.bytes }))
      .sort((a, b) => b.bytes - a.bytes);

    const out = {
      schemaVersion: 1,
      harvest,
      realOpens,
      opensSample: Object.fromEntries(
        Object.entries(opens).filter(([, v]) => v.bytes > 500 || v.status === 200),
      ),
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        hdrBytes: harvest.hdrBytes,
        eventish: harvest.eventish,
        orgish: harvest.orgish,
        pathHints: harvest.pathHints,
        realOpens,
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
