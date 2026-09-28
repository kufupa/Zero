/**
 * Soft-open A6–A8 surfaces with A3 unlock order (BSSTRT warm → early HDR/LST).
 * Known codes: GSGRPB (Group Booking). Probe event/org candidates.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

const CANDIDATES = [
  'GSGRPB',
  'GSGRPB.HDR',
  'GSGRPB.LST',
  'GSEVNT',
  'GSEVNT.HDR',
  'GSEVNT.LST',
  'GSEVRS',
  'GSEVRS.HDR',
  'GSEVRS.LST',
  'GSEVR',
  'GSBEO',
  'PRORGP',
  'PRORGP.HDR',
  'PRORGP.LST',
  'PRORG',
  'PRORG.HDR',
  'ARORGP',
  'ARORGP.HDR',
  'OSORGP',
  'OSORGP.HDR',
  'OSORGP.LST',
  'PSORGP',
  'PSORGP.HDR',
];

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A678_SOFT_OUT ?? '/tmp/a678-soft-open.sanitized.v1.json';

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
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
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

    // Warm only — then early-open each candidate before menu noise
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

    const opens: Record<string, Record<string, unknown>> = {};
    for (const path of CANDIDATES) {
      const result = await page.evaluate(async (p) => {
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
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body).toString(),
        });
        const text = await r.text();
        const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null;
        return {
          status: r.status,
          bytes: text.length,
          stub813: text.length === 813,
          hasLogin: /name="userid"|name="password"/i.test(text),
          title,
          hasPageData: /pageData/i.test(text),
          hasGrid: /GRIDRESULT/i.test(text),
          hasGroupToken: /group|block|allot/i.test(text),
          hasEventToken: /event/i.test(text),
          hasOrgToken: /organiz|compan|profile/i.test(text),
        };
      }, path);
      opens[path] = result;
    }

    const realOpens = Object.entries(opens)
      .filter(
        ([, v]) =>
          v.status === 200 &&
          typeof v.bytes === 'number' &&
          (v.bytes as number) > 2000 &&
          !v.stub813 &&
          !v.hasLogin,
      )
      .map(([fn, v]) => ({ fn, bytes: v.bytes, title: v.title, hasGrid: v.hasGrid }));

    const out = { schemaVersion: 1, opens, realOpens };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, outPath, realOpens, opens }) + '\n');
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
