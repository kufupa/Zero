/**
 * PSSNEL.HDR row-shape (keys/counts only) + Tax Invoice launch/fn hunt.
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|print\/|export|generate|resend|finalize|void)/i.test(
        path,
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await ctx.newPage();
  try {
    await page.goto(secret.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page
      .locator('input[name=userid], input[name=username]')
      .first()
      .fill(secret.username);
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    await page.waitForTimeout(3_000);

    // Open PSSNEL then HDR — row shape only
    await page.evaluate(async () => {
      await fetch('/web/base/PSSNEL', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          USER_FUNCTION_NAME: 'PSSNEL',
          SYSTEM_FUNCTION_NAME: 'PSSNEL',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
        credentials: 'same-origin',
      });
    });
    const hdrShape = await page.evaluate(async () => {
      const r = await fetch('/web/base/PSSNEL.HDR', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'PSSNEL',
          USER_FUNCTION_NAME: 'PSSNEL',
          CURRENT_TAB_NAME: 'HDR',
        }).toString(),
        credentials: 'same-origin',
      });
      const text = await r.text();
      const rowMatches = [
        ...text.matchAll(/"ROW"\s*:\s*\[/g),
        ...text.matchAll(/FIELDVALUES/g),
      ];
      // Count ROW objects without reading values
      const rowObjCount = (text.match(/\{[^{}]*"emailtype"/gi) || []).length;
      const hasAttachmentTrue = /"attachment"\s*:\s*true/i.test(text);
      const hasAttachmentFalse = /"attachment"\s*:\s*false/i.test(text);
      const hasAttachmentY = /"attachment"\s*:\s*"?Y"?/i.test(text);
      const errorClasses = [
        ...new Set(
          [...text.matchAll(/"error"\s*:\s*"([^"]*)"/gi)].map((m) =>
            m[1]!.length === 0 ? 'empty' : m[1]!.length > 0 ? 'nonempty' : 'empty',
          ),
        ),
      ];
      const emailTypes = [
        ...new Set(
          [...text.matchAll(/"emailtype"\s*:\s*"([^"]*)"/gi)].map((m) => {
            const v = m[1]!.toLowerCase();
            if (/transact/.test(v)) return 'transactional_like';
            if (/report/.test(v)) return 'report_like';
            if (/system/.test(v)) return 'system_like';
            return 'other_class';
          }),
        ),
      ];
      // Never emit raw subject/address — only presence flags
      const subjectPresent = /"subject"\s*:\s*"[^"]+"/i.test(text);
      const addressPresent = /"emailaddress"\s*:\s*"[^"]+@[^"]+"/i.test(text);
      const toolbarActions = [
        ...text.matchAll(/"TOOLBAR"[\s\S]{0,4000}/g),
      ]
        .slice(0, 1)
        .flatMap((block) =>
          [...block[0]!.matchAll(/"label"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!),
        )
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 40);
      return {
        status: r.status,
        bytes: text.length,
        rowObjCount,
        rowMarkerCount: rowMatches.length,
        hasAttachmentTrue,
        hasAttachmentFalse,
        hasAttachmentY,
        errorClasses,
        emailTypes,
        subjectPresent,
        addressPresent,
        toolbarActions,
      };
    });

    // Broader tax invoice function hunt including AR / FD prefixes
    const taxFns = [
      'OSTXI',
      'PSTXI',
      'OSTAX',
      'OSTINV',
      'PSTINV',
      'FDTXI',
      'FDTINV',
      'ARINV',
      'ARTXI',
      'ARTINV',
      'OSTAXIN',
      'PSTAXIN',
      'OSPTAX',
      'OSFTAX',
      'OSINVC',
      'OSINVCE',
      'OSIVCE',
      'OSIVC',
      'OSBILL',
      'OSARIV',
      'PSSNEL',
    ];
    const taxHits: Array<Record<string, unknown>> = [];
    for (const fn of taxFns) {
      const r = await page.evaluate(async (functionName) => {
        const resp = await fetch(`/web/base/${functionName}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            USER_FUNCTION_NAME: functionName,
            SYSTEM_FUNCTION_NAME: functionName,
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          }).toString(),
          credentials: 'same-origin',
        });
        const text = await resp.text();
        return {
          status: resp.status,
          bytes: text.length,
          title: ((text.match(/"title"\s*:\s*"([^"]{0,80})"/) || [])[1] || null),
          userFunction: ((text.match(/"userFunction"\s*:\s*"([^"]+)"/) || [])[1] || null),
          hasInvoice: /invoice/i.test(text.slice(0, 3000)),
        };
      }, fn);
      if (r.status === 200 && r.bytes > 400) {
        taxHits.push({ fn, ...r });
      }
    }

    // Launch Center / search box for "Tax Invoice" label → capture function if any
    const launch = await page.evaluate(async () => {
      const attempts: Array<Record<string, unknown>> = [];
      for (const path of [
        '/web/base/BSSTRT.search',
        '/web/base/COMMON.search',
        '/web/base/BSSTRT.HDR.search',
      ]) {
        try {
          const resp = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              searchtext: 'Tax Invoice',
              ONLY_DATA_REQUIRED: 'true',
            }).toString(),
            credentials: 'same-origin',
          });
          const text = await resp.text();
          const fns = [
            ...text.matchAll(/\b((?:PS|OS|AR|FD)[A-Z0-9]{3,10})\b/g),
          ].map((m) => m[1]!);
          attempts.push({
            path,
            status: resp.status,
            bytes: text.length,
            fns: [...new Set(fns)].slice(0, 30),
            hasTaxLabel: /Tax Invoice/i.test(text),
          });
        } catch {
          attempts.push({ path, error: true });
        }
      }
      return attempts;
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ hdrShape, taxHits, launch }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
