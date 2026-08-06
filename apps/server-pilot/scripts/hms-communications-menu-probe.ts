/**
 * Deep menu + direct function open probe for communications surfaces.
 * Structure-only output — never subjects/addresses/filenames/row values.
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
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') {
    throw new Error('refuse: credentialMode must be view_only');
  }
  const origin = new URL(secret.loginUrl).origin;
  const aborted: Array<{ method: string; path: string; reason: string }> = [];
  const continuedPosts: string[] = [];

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
    const url = req.url();
    if (!url.startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(url).pathname;
    const method = req.method().toUpperCase();
    // Only abort POST mutation/delivery — never abort chrome GETs.
    if (
      method === 'POST' &&
      /(save|delete|settle|refund|print|export|generate|resend|finalize|void)/i.test(
        path,
      )
    ) {
      aborted.push({ method, path, reason: 'mutation' });
      await route.abort();
      return;
    }
    if (method === 'POST') continuedPosts.push(path);
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
    await page.waitForTimeout(4_000);
    await page
      .getByText('Front Desk', { exact: true })
      .first()
      .click({ force: true, timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3_000);

    const dump = await page.evaluate(() => {
      const texts = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-grid3-cell-inner, .x-menu-item-text, .x-btn-inner, span, a',
        ),
      ]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80);
      const uniq = [...new Set(texts)];
      const interesting = uniq.filter((t) =>
        /email|invoice|tax|folio|guest|sent|print|availability|room|rate|block|event|company|deposit|ledger/i.test(
          t,
        ),
      );
      return {
        interesting: interesting.slice(0, 120),
        totalUniq: uniq.length,
        sample: uniq.slice(0, 40),
      };
    });

    const candidates = [
      'PSSNEL',
      'OSTXI',
      'OSTAX',
      'OSINV',
      'OSTIN',
      'PSTXI',
      'OSTIV',
      'OSREML',
      'PSSNEM',
    ];
    const openResults: Array<Record<string, unknown>> = [];
    for (const fn of candidates) {
      try {
        const result = await page.evaluate(async (functionName) => {
          const body = new URLSearchParams({
            USER_FUNCTION_NAME: functionName,
            SYSTEM_FUNCTION_NAME: functionName,
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          });
          const r = await fetch(`/web/base/${functionName}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            credentials: 'same-origin',
          });
          const text = await r.text();
          return {
            status: r.status,
            bytes: text.length,
            hasPageData: /pageData|GRIDRESULT|success/i.test(text),
            echoesFn: text.includes(functionName),
            hasError: /error|not authorized|permission|denied/i.test(
              text.slice(0, 2000),
            ),
            titleHint: (text.match(/<title>([^<]{0,80})/i) || [])[1] || null,
            fieldNames: [
              ...text.matchAll(/name="([a-zA-Z0-9_]{2,40})"/g),
            ]
              .map((m) => m[1]!)
              .filter((n, i, a) => a.indexOf(n) === i)
              .filter((n) =>
                /email|subject|attach|invoice|status|account|report|error|date|property|search/i.test(
                  n,
                ),
              )
              .slice(0, 40),
          };
        }, fn);
        openResults.push({ fn, ...result });
      } catch {
        openResults.push({ fn, error: 'evaluate_failed' });
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          dump,
          continuedPosts: [...new Set(continuedPosts)].slice(0, 40),
          aborted: aborted.slice(0, 20),
          openResults,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
