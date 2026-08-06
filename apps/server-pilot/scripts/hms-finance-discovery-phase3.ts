/**
 * Phase-3: OSLEDG tab/list shape + OSRESS/OSACCT field readOnly flags for finance keys.
 * Structure/flags only — masks any digit runs in sampled values.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function maskDigits(s: string): string {
  return s.replace(/\d/g, '#');
}

function keys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

/** Extract field meta near finance key names — never raw values. */
function fieldMeta(text: string, fieldNames: string[]) {
  const metas: Array<Record<string, unknown>> = [];
  for (const name of fieldNames) {
    const re = new RegExp(
      `["']?${name}["']?[^\\n]{0,400}`,
      'i',
    );
    const m = text.match(re);
    if (!m) {
      metas.push({ field: name, present: false });
      continue;
    }
    const snippet = maskDigits(m[0]!.slice(0, 280));
    metas.push({
      field: name,
      present: true,
      readOnly:
        /readOnly["'\s:=]+true/i.test(snippet) ||
        /"readonly"\s*:\s*true/i.test(snippet),
      disabled: /disabled["'\s:=]+true/i.test(snippet),
      hasValueToken: /"value"\s*:/i.test(snippet),
      snippetFlags: {
        hasBalanceWord: /balance/i.test(snippet),
        hasCurrencyWord: /currenc/i.test(snippet),
        hasCardWord: /card|vcc|pan/i.test(snippet),
      },
    });
  }
  return metas;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_FINANCE_DISCOVERY_OUT ?? '/tmp/hms-finance-discovery-p3.json';
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|postpayment|transfer)/i.test(
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

    // --- OSLEDG deep tabs ---
    await page.evaluate(async () => {
      await fetch('/web/base/OSLEDG', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          USER_FUNCTION_NAME: 'OSLEDG',
          SYSTEM_FUNCTION_NAME: 'OSLEDG',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
        credentials: 'same-origin',
      });
    });

    const ledgTabs = [
      '',
      'HDR',
      'DTL',
      'LST',
      'LIST',
      'DEP',
      'DEPOSIT',
      'LEDGER',
      'SUM',
      'SUMMARY',
    ];
    const ledgTabResults: Array<Record<string, unknown>> = [];
    for (const tab of ledgTabs) {
      const path = tab ? `/web/base/OSLEDG.${tab}` : '/web/base/OSLEDG';
      const result = await page.evaluate(
        async ({ path, tab }) => {
          const body = new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: tab || 'HDR',
          });
          const r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            credentials: 'same-origin',
          });
          return { status: r.status, text: await r.text() };
        },
        { path, tab },
      );
      const allKeys = keys(result.text);
      ledgTabResults.push({
        tab: tab || '(root)',
        path,
        status: result.status,
        bytes: result.text.length,
        hasGrid: /GRIDRESULT/i.test(result.text),
        titles: [
          ...new Set(
            [
              ...(result.text.match(/Deposit Ledger/gi) || []),
              ...(result.text.match(/Property Ledger/gi) || []),
              ...(result.text.match(/Advance Deposit/gi) || []),
            ].map((s) => s.replace(/\s+/g, ' ')),
          ),
        ],
        financeKeys: allKeys.filter((k) =>
          /balance|deposit|due|paid|refund|forfeit|transfer|currency|opening|closing|newdeposit|amount|activity/i.test(
            k,
          ),
        ),
        actionKeys: allKeys.filter((k) =>
          /post|settle|refund|void|save|submit|print|email|transfer/i.test(k),
        ),
        gridKeysSample: (() => {
          const m = result.text.match(/GRIDRESULT[\s\S]{0,8000}/i);
          if (!m) return [];
          return keys(m[0]!).filter((k) =>
            /balance|deposit|due|paid|refund|forfeit|transfer|currency|amount|activity|name|confirm/i.test(
              k,
            ),
          );
        })(),
      });
    }

    // --- OSRESS open + finance field meta ---
    const osressOpen = await page.evaluate(async () => {
      const r = await fetch('/web/base/OSRESS', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          USER_FUNCTION_NAME: 'OSRESS',
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
        credentials: 'same-origin',
      });
      return { status: r.status, text: await r.text() };
    });
    const osressFinanceFields = [
      'foliobalance',
      'propertycurrency',
      'depositamount',
      'depositreceived',
      'depositduedate',
      'company',
      'companyname',
      'bookingagency',
      'bookingagency2name',
      'cardnumber',
      'cardnumber1',
      'paymentterms',
      'billingmode',
      'contractstatus',
      'directbill',
    ];
    const osressMeta = fieldMeta(osressOpen.text, osressFinanceFields);

    // Try OSRESS FOLIO tab if exists
    const folioTab = await page.evaluate(async () => {
      const candidates = [
        '/web/base/OSRESS.FOLIO',
        '/web/base/OSRESS.FOL',
        '/web/base/OSPFOL',
      ];
      const out = [];
      for (const path of candidates) {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: path.includes('OSPFOL') ? 'OSPFOL' : 'OSRESS',
            USER_FUNCTION_NAME: path.includes('OSPFOL') ? 'OSPFOL' : 'OSRESS',
            CURRENT_TAB_NAME: 'FOLIO',
          }).toString(),
          credentials: 'same-origin',
        });
        const text = await r.text();
        const allKeys = [];
        const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
        let m;
        while ((m = re.exec(text))) {
          if (!allKeys.includes(m[1])) allKeys.push(m[1]);
        }
        allKeys.sort();
        out.push({
          path,
          status: r.status,
          bytes: text.length,
          financeKeys: allKeys.filter((k) =>
            /balance|deposit|currency|total|amount|folio/i.test(k),
          ),
          actionKeys: allKeys
            .filter((k) =>
              /post|settle|refund|void|transfer|print|email|save/i.test(k),
            )
            .slice(0, 30),
          hasGrid: /GRIDRESULT/i.test(text),
        });
      }
      return out;
    });

    // OSACCT HDR company/billing field meta
    const osacctHdr = await page.evaluate(async () => {
      await fetch('/web/base/OSACCT', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          USER_FUNCTION_NAME: 'OSACCT',
          SYSTEM_FUNCTION_NAME: 'OSACCT',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
        credentials: 'same-origin',
      });
      const r = await fetch('/web/base/OSACCT.HDR', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSACCT',
          USER_FUNCTION_NAME: 'OSACCT',
          CURRENT_TAB_NAME: 'HDR',
        }).toString(),
        credentials: 'same-origin',
      });
      return { status: r.status, text: await r.text() };
    });
    const companyFields = [
      'balance',
      'balancecurr',
      'billingmode',
      'paymentterms',
      'paymentterm',
      'contractstatus',
      'creditlimit',
      'creditstatus',
      'contactemail',
      'contactname',
      'account',
      'accountnumber',
      'arbillingreference',
      'company',
      'agency',
    ];
    const osacctMeta = fieldMeta(osacctHdr.text, companyFields);
    const osacctAllFinance = keys(osacctHdr.text).filter((k) =>
      /bill|term|contract|credit|contact|account|balance|payment|mode|status|company|agency/i.test(
        k,
      ),
    );

    const report = {
      osledg: ledgTabResults,
      osressMeta,
      folioTab,
      osacctMeta,
      osacctAllFinance: osacctAllFinance.slice(0, 60),
    };
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          outPath,
          osledgOk: ledgTabResults.filter((t) => t.status === 200),
          osressMeta,
          folioTab,
          osacctMeta,
          osacctBillingish: osacctAllFinance.filter((k) =>
            /bill|term|contract|mode|payment/i.test(k),
          ),
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
