/** Soft-open GSGRPB (group) + FSOGPF (org/company). Digests only. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';

const OUT = process.env.HMS_READ_100_GC_OUT || '/tmp/hms-read-100-group-company.json';

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[name=userid], input[name=username], input[name=j_username]').first().fill(secret.username);
  await page.locator('input[name=password]').fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
      await page.locator('input[name=password]').press('Enter');
    }),
  ]);
  await page.waitForTimeout(4000);
  const probes = await page.evaluate(async () => {
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const text = await r.text();
      return {
        path,
        bytes: text.length,
        hasPageData: /pageData/i.test(text),
        loadLocalized: /loadLocalizedPage/i.test(text),
        securityDeny: /sufficient security rights|do not have sufficient/i.test(text),
        errorMsg: /error has occurred while processing/i.test(text),
      };
    };
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await post(path, { SYSTEM_FUNCTION_NAME: 'BSSTRT', USER_FUNCTION_NAME: 'BSSTRT', CURRENT_TAB_NAME: 'HDR', FUNCTION_CLASS: 'WEBL' }).catch(() => null);
    }
    const paths = [
      ['/web/base/GSGRPB.HDR', { SYSTEM_FUNCTION_NAME: 'GSGRPB', USER_FUNCTION_NAME: 'GSGRPB', CURRENT_TAB_NAME: 'HDR', FUNCTION_CLASS: 'WEBL' }],
      ['/web/base/GSGRPB.LST', { SYSTEM_FUNCTION_NAME: 'GSGRPB', USER_FUNCTION_NAME: 'GSGRPB', CURRENT_TAB_NAME: 'LST', FUNCTION_CLASS: 'WEBL', ONLY_DATA_REQUIRED: 'true' }],
      ['/web/base/FSOGPF.HDR', { SYSTEM_FUNCTION_NAME: 'FSOGPF', USER_FUNCTION_NAME: 'FSOGPF', CURRENT_TAB_NAME: 'HDR', FUNCTION_CLASS: 'WEBL' }],
      ['/web/base/FSOGPF.LST', { SYSTEM_FUNCTION_NAME: 'FSOGPF', USER_FUNCTION_NAME: 'FSOGPF', CURRENT_TAB_NAME: 'LST', FUNCTION_CLASS: 'WEBL', ONLY_DATA_REQUIRED: 'true' }],
    ];
    const out = [];
    for (const [path, body] of paths) out.push(await post(path, body));
    return out;
  });
  const digest = {
    when: new Date().toISOString(),
    probes,
    groupOk: probes.some((p) => p.path.includes('GSGRPB') && p.hasPageData && !p.loadLocalized && !p.securityDeny),
    companyOk: probes.some((p) => p.path.includes('FSOGPF') && p.hasPageData && !p.loadLocalized && !p.securityDeny),
    note: 'Surface soft-open reverify; unique-email count for group/company is census-limited — Wave A already GREEN on GSGRPB.LST / FSOGPF',
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.log(JSON.stringify({ phase: 'done', ...digest }));
  await browser.close();
}
main().catch((e) => { console.error(String(e?.stack||e)); process.exit(1); });
