/**
 * Phase-2 finance discovery: deep structure of OSPFOL/OSACCT/OSPTAX + ledger hunt.
 * Keys/flags only — never numeric balances, card PANs, names, account IDs.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function keys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

function classifyKeys(all: string[]) {
  const pick = (re: RegExp) => all.filter((k) => re.test(k)).slice(0, 40);
  return {
    balanceLike: pick(/balance|totalbal|outstanding|amountdue/i),
    depositLike: pick(/deposit|due|paid|refund|forfeit|transfer/i),
    currencyLike: pick(/currenc/i),
    cardLike: pick(/card|vcc|pan|cvv|token|credential/i),
    companyLike: pick(/company|agency|organiz|billing|paymentterm|contract/i),
    folioLike: pick(/folio/i),
    actionLike: pick(/post|settle|refund|void|transfer|print|email|save|submit/i),
  };
}

function titleHints(text: string): string[] {
  const hits = new Set<string>();
  for (const re of [
    /Folio Selection/gi,
    /\bFolios?\b/gi,
    /Deposit Ledger/gi,
    /Property Ledger/gi,
    /Advance Deposit/gi,
    /\bAccount\b/gi,
    /Guest Stay/gi,
    /Company/gi,
    /Agency/gi,
  ]) {
    for (const m of text.matchAll(re)) hits.add(m[0]!.replace(/\s+/g, ' '));
  }
  return [...hits].slice(0, 25);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_FINANCE_DISCOVERY_OUT ?? '/tmp/hms-finance-discovery-p2.json';
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

    const deepFns = [
      'OSPFOL',
      'OSPTAX',
      'OSACCT',
      'OSRESS',
      // Property ledger / deposit guesses
      'OSPLG',
      'PSPLG',
      'OSLEDG',
      'OSLED',
      'OSDEPL',
      'OSDEP',
      'OSPDEP',
      'PSDEP',
      'ARDEP',
      'OSPROP',
      'PSPROP',
      'OSPLDG',
      'PSPLDG',
      'OSBALL',
      'OSBAL',
      'PSBAL',
      'OSFOLL',
      'OSFOLI',
      'PSFOLI',
      'OSFSEL',
      'OSFOSL',
      // company / profile
      'OSCOMP',
      'OSCOM',
      'ARCOMP',
      'ARCOM',
      'OSPROF',
      'ARPROF',
      'PSCOMP',
      'OSORG',
      'ARORG',
    ];

    const deep: Array<Record<string, unknown>> = [];
    for (const fn of deepFns) {
      const open = await page.evaluate(async (functionName) => {
        try {
          const r = await fetch(`/web/base/${functionName}`, {
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
          return { status: r.status, text: await r.text() };
        } catch (e) {
          return {
            status: null,
            text: '',
            err: e instanceof Error ? e.message : 'err',
          };
        }
      }, fn);
      const hdr = await page.evaluate(async (functionName) => {
        try {
          const r = await fetch(`/web/base/${functionName}.HDR`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              CURRENT_TAB_NAME: 'HDR',
            }).toString(),
            credentials: 'same-origin',
          });
          return { status: r.status, text: await r.text() };
        } catch {
          return { status: null, text: '' };
        }
      }, fn);

      // Also try .search / list variants when open succeeds
      let search: { status: number | null; text: string } = {
        status: null,
        text: '',
      };
      if (open.status === 200) {
        search = await page.evaluate(async (functionName) => {
          try {
            const r = await fetch(`/web/base/${functionName}.HDR.search`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                SYSTEM_FUNCTION_NAME: functionName,
                USER_FUNCTION_NAME: functionName,
                CURRENT_TAB_NAME: 'HDR',
                GRID_NAME: functionName,
                ONLY_DATA_REQUIRED: 'true',
              }).toString(),
              credentials: 'same-origin',
            });
            return { status: r.status, text: await r.text() };
          } catch {
            return { status: null, text: '' };
          }
        }, fn);
      }

      const openKeys = keys(open.text);
      const hdrKeys = keys(hdr.text);
      const searchKeys = keys(search.text);
      deep.push({
        fn,
        openStatus: open.status,
        openBytes: open.text.length,
        openTitles: titleHints(open.text),
        openKeyClasses: classifyKeys(openKeys),
        openHasGrid: /GRIDRESULT/i.test(open.text),
        openHasEditable: /"readOnly"\s*:\s*false|"disabled"\s*:\s*false/i.test(
          open.text,
        ),
        hdrStatus: hdr.status,
        hdrBytes: hdr.text.length,
        hdrTitles: titleHints(hdr.text),
        hdrKeyClasses: classifyKeys(hdrKeys),
        hdrHasGrid: /GRIDRESULT/i.test(hdr.text),
        searchStatus: search.status,
        searchBytes: search.text.length,
        searchKeyClasses: classifyKeys(searchKeys),
        searchHasGrid: /GRIDRESULT/i.test(search.text),
      });
    }

    // Expand Front Desk deeply — dump tree node texts only
    await page.getByText('Front Desk', { exact: true }).first().click({
      force: true,
      timeout: 8_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_500);
    const tree = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-tree-node a span, span.x-tree-node-text',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 1 && t.length < 80),
        ),
      ].slice(0, 120);
    });

    const interesting = deep.filter(
      (d) =>
        d.openStatus === 200 ||
        d.hdrStatus === 200 ||
        (Array.isArray(d.openTitles) && d.openTitles.length > 0),
    );

    const report = { treeLabels: tree, deep, interesting };
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          outPath,
          treeFinanceHits: tree.filter((t) =>
            /folio|deposit|ledger|property|company|agency|account|bill/i.test(t),
          ),
          interesting: interesting.map((d) => ({
            fn: d.fn,
            openStatus: d.openStatus,
            hdrStatus: d.hdrStatus,
            searchStatus: d.searchStatus,
            openTitles: d.openTitles,
            hdrTitles: d.hdrTitles,
            openKeyClasses: d.openKeyClasses,
            hdrKeyClasses: d.hdrKeyClasses,
            searchKeyClasses: d.searchKeyClasses,
            openHasGrid: d.openHasGrid,
            hdrHasGrid: d.hdrHasGrid,
            searchHasGrid: d.searchHasGrid,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
