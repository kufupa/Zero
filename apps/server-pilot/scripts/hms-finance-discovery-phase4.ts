/**
 * Phase-4b: OSLEDG.LST + OSRESS.search DATA keys via Playwright page.request.
 * Keys only — values discarded immediately / never logged.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function collectKeys(text: string): string[] {
  const out: string[] = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out.sort();
}

/** First DATA object keys only — strip values before return. */
function firstDataObjectKeys(text: string): string[] {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 20000);
  const objStart = slice.indexOf('{');
  if (objStart < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = objStart; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const objText = slice.slice(objStart, end + 1);
  // Replace string values with empty to avoid accidental PII retention
  const scrubbed = objText.replace(/:\s*"[^"]*"/g, ':""').replace(/:\s*-?\d+(?:\.\d+)?/g, ':0');
  return collectKeys(scrubbed);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_FINANCE_DISCOVERY_OUT ?? '/tmp/hms-finance-discovery-p4.json';
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize)/i.test(
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

    async function post(path: string, fields: Record<string, string>) {
      const response = await page.request.post(`${origin}${path}`, {
        form: fields,
        timeout: 60_000,
      });
      return { status: response.status(), text: await response.text() };
    }

    await post('/web/base/OSLEDG', {
      USER_FUNCTION_NAME: 'OSLEDG',
      SYSTEM_FUNCTION_NAME: 'OSLEDG',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    const lst = await post('/web/base/OSLEDG.LST', {
      SYSTEM_FUNCTION_NAME: 'OSLEDG',
      USER_FUNCTION_NAME: 'OSLEDG',
      CURRENT_TAB_NAME: 'LST',
    });

    await post('/web/base/OSRESS', {
      USER_FUNCTION_NAME: 'OSRESS',
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    // Broad arrival window search — keys only from first DATA row.
    const search = await post('/web/base/OSRESS.search', {
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      USER_FUNCTION_NAME: 'OSRESS',
      GRID_NAME: 'OSRESS',
      ONLY_DATA_REQUIRED: 'true',
      MADDON_FILTER_ALIAS_NAME_1: 'arrivaldate',
      MADDON_FILTER_VALUE_1: '01-JAN-2020',
      MADDON_FILTER_ALIAS_NAME_2: 'departuredate',
      MADDON_FILTER_VALUE_2: '31-DEC-2030',
    });

    const lstDataKeys = firstDataObjectKeys(lst.text);
    const searchDataKeys = firstDataObjectKeys(search.text);
    const report = {
      lstStatus: lst.status,
      lstBytes: lst.text.length,
      lstHasGrid: /GRIDRESULT/i.test(lst.text),
      lstDataKeys,
      lstFinanceKeys: lstDataKeys.filter((k) =>
        /balance|deposit|due|paid|refund|forfeit|transfer|currency|confirm|name|amount|opening|closing|new|from|activity|date/i.test(
          k,
        ),
      ),
      lstAllFinanceish: collectKeys(lst.text).filter((k) =>
        /balance|deposit|due|paid|refund|forfeit|transfer|currency|confirm|name|amount|opening|closing|new|from|activity|date/i.test(
          k,
        ),
      ),
      searchStatus: search.status,
      searchBytes: search.text.length,
      searchHasGrid: /GRIDRESULT/i.test(search.text),
      searchDataKeys,
      searchFinanceKeys: searchDataKeys.filter((k) =>
        /folio|deposit|balance|currency|company|card|confirm/i.test(k),
      ),
      searchHasFoliobalance: searchDataKeys.includes('foliobalance'),
    };
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ outPath, ...report }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
