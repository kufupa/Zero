/**
 * Re-prove Deposit Ledger reservation scope via docs path:
 * Front Desk > Property Ledger > Deposit Ledger (not only direct OSLEDG open).
 * Keys-only — values scrubbed; cardnumber presence flagged, never logged.
 *
 * Run on EC2:
 *   HMS_DISCOVERY_ALLOW_LIVE=1 node scripts/hms-deposit-ledger-reprove.mjs
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const hmsSecretSchema = z
  .object({
    loginUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    credentialMode: z.enum(['view_only', 'write_capable']),
  })
  .passthrough();

const CONFIRM_RE =
  /confirm|guestaccount|gueststay|accountid|accountnumber|toaccount|guestnumber|reservation/i;
const CARD_RE = /cardnumber|card_number|ccnumber|pan\b/i;
const FINANCE_RE =
  /balance|deposit|due|paid|refund|forfeit|transfer|currency|opening|closing|newdeposit|amount|activity|name|confirm|account|guest/i;

function collectKeys(text) {
  const out = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

function firstDataObjectKeys(text) {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 40_000);
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
  const scrubbed = slice
    .slice(objStart, end + 1)
    .replace(/:\s*"[^"]*"/g, ':""')
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ':0');
  return collectKeys(scrubbed);
}

function classify(keys) {
  return {
    confirmationish: keys.filter((k) => CONFIRM_RE.test(k)),
    cardish: keys.filter((k) => CARD_RE.test(k)),
    financeish: keys.filter((k) => FINANCE_RE.test(k)),
  };
}

function summarizeResponse(label, status, text, extra = {}) {
  const keys = collectKeys(text);
  const dataKeys = firstDataObjectKeys(text);
  const cls = classify(keys);
  const dataCls = classify(dataKeys);
  return {
    label,
    status,
    bytes: text.length,
    hasGrid: /GRIDRESULT/i.test(text),
    hasPageData: /"PAGEDATA"|"pageData"|GRIDRESULT/i.test(text),
    titles: [
      ...new Set(
        [
          ...(text.match(/Deposit Ledger/gi) || []),
          ...(text.match(/Property Ledger/gi) || []),
          ...(text.match(/Advance Deposit/gi) || []),
          ...(text.match(/Confirmation Number/gi) || []),
        ].map((s) => s.replace(/\s+/g, ' ')),
      ),
    ],
    allConfirmish: cls.confirmationish,
    allCardish: cls.cardish,
    dataKeys,
    dataConfirmish: dataCls.confirmationish,
    dataCardish: dataCls.cardish,
    dataFinanceish: dataCls.financeish,
    ...extra,
  };
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DEPOSIT_REPROVE_OUT ?? '/tmp/hms-deposit-ledger-reprove.json';

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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|email|postdeposit|transfer)/i.test(
        path,
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const captured = [];
  const page = await ctx.newPage();
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.startsWith(origin)) return;
      const path = new URL(url).pathname;
      if (!/\/web\/base\/(OS|PS|AR)[A-Z0-9.]+/i.test(path)) return;
      if (!/OSLEDG|OSPLDG|PSPLDG|OSDEP|Property|Deposit|LEDG/i.test(path)) {
        // still capture OSLEDG-family only to limit volume
        if (!/LEDG|PLDG|DEP/i.test(path)) return;
      }
      const status = response.status();
      const text = await response.text().catch(() => '');
      if (text.length < 40) return;
      captured.push(
        summarizeResponse(`net:${path}`, status, text, {
          method: response.request().method(),
        }),
      );
    } catch {
      /* ignore */
    }
  });

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

    async function post(path, fields) {
      const response = await page.request.post(`${origin}${path}`, {
        form: fields,
        timeout: 60_000,
      });
      const text = await response.text();
      return { status: response.status(), text, path };
    }

    // --- Abort-first menu path: Front Desk > Property Ledger > Deposit Ledger ---
    const menuClicks = [];
    for (const label of ['Front Desk', 'Property Ledger', 'Deposit Ledger']) {
      const clicked = await page
        .getByText(label, { exact: true })
        .first()
        .click({ force: true, timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      menuClicks.push({ label, clicked });
      await page.waitForTimeout(2_500);
    }

    // Soft-capture tree labels near Property/Deposit
    const treeLabels = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, span.x-tree-node-text, .x-btn-inner',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(
              (t) =>
                t.length > 1 &&
                t.length < 80 &&
                /ledger|deposit|property|folio|front/i.test(t),
            ),
        ),
      ].slice(0, 60);
    });

    // DOM field names (names only) on current screen
    const domFieldNames = await page.evaluate(() => {
      const els = [
        ...document.querySelectorAll('input[name], select[name], textarea[name]'),
      ];
      return [
        ...new Set(
          els
            .map((e) => e.getAttribute('name') || '')
            .filter((n) => n.length > 0 && n.length < 64),
        ),
      ]
        .filter((n) =>
          /confirm|guest|account|deposit|ledger|card|amount|balance/i.test(n),
        )
        .sort();
    });

    // --- Programmatic Property Ledger parents then Deposit ---
    const parentFns = ['OSPLDG', 'PSPLDG', 'OSPLG', 'PSPLG', 'OSPROP'];
    const parentResults = [];
    for (const fn of parentFns) {
      const open = await post(`/web/base/${fn}`, {
        USER_FUNCTION_NAME: fn,
        SYSTEM_FUNCTION_NAME: fn,
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      parentResults.push(summarizeResponse(`open:${fn}`, open.status, open.text));
      if (open.status === 200 && open.text.length > 200) {
        for (const tab of ['LST', 'HDR', 'DTL']) {
          const r = await post(`/web/base/${fn}.${tab}`, {
            SYSTEM_FUNCTION_NAME: fn,
            USER_FUNCTION_NAME: fn,
            CURRENT_TAB_NAME: tab,
            COMPONENT_INFO_TYPE: 'DATA_ONLY',
            GRID_NAME: fn,
          });
          parentResults.push(
            summarizeResponse(`${fn}.${tab}`, r.status, r.text),
          );
        }
      }
    }

    // Direct OSLEDG (baseline) + detail tabs after Property Ledger context
    const osledgOpen = await post('/web/base/OSLEDG', {
      USER_FUNCTION_NAME: 'OSLEDG',
      SYSTEM_FUNCTION_NAME: 'OSLEDG',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    const osledgTabs = [];
    for (const tab of ['LST', 'HDR', 'DTL', 'DEP', 'ACT', 'TXN', 'DET']) {
      const r = await post(`/web/base/OSLEDG.${tab}`, {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: tab,
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'OSLEDG',
      });
      osledgTabs.push(summarizeResponse(`OSLEDG.${tab}`, r.status, r.text));
    }

    // Try LST without DATA_ONLY (UI-style) and with alternate grid names
    const altLists = [];
    for (const body of [
      {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'LST',
      },
      {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'OSLEDG',
        ONLY_DATA_REQUIRED: 'true',
      },
      {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'DTL',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'OSLEDG',
        ONLY_DATA_REQUIRED: 'true',
      },
    ]) {
      const r = await post('/web/base/OSLEDG.LST', body);
      altLists.push(
        summarizeResponse(`OSLEDG.LST:${JSON.stringify(body)}`, r.status, r.text),
      );
    }

    // After UI Deposit Ledger click — harvest any visible confirm field attrs
    const visibleConfirmAttrs = await page.evaluate(() => {
      const out = [];
      const els = [...document.querySelectorAll('[name],[data-qtip],[aria-label]')];
      for (const el of els) {
        const attrs = [
          el.getAttribute('name'),
          el.getAttribute('data-qtip'),
          el.getAttribute('aria-label'),
          el.getAttribute('id'),
        ]
          .filter(Boolean)
          .join('|');
        if (/confirm|guest.?account|to.?account/i.test(attrs)) {
          out.push(attrs.slice(0, 120));
        }
      }
      return [...new Set(out)].slice(0, 40);
    });

    const allSummaries = [
      ...parentResults,
      summarizeResponse('OSLEDG.open', osledgOpen.status, osledgOpen.text),
      ...osledgTabs,
      ...altLists,
      ...captured,
    ];

    const confirmationColumnsFound = [
      ...new Set(
        allSummaries.flatMap((s) => [
          ...(s.allConfirmish || []),
          ...(s.dataConfirmish || []),
        ]),
      ),
    ].sort();
    const cardColumnsFound = [
      ...new Set(
        allSummaries.flatMap((s) => [
          ...(s.allCardish || []),
          ...(s.dataCardish || []),
        ]),
      ),
    ].sort();
    const dataKeyHits = allSummaries
      .filter(
        (s) =>
          (s.dataConfirmish && s.dataConfirmish.length > 0) ||
          (s.dataKeys &&
            s.dataKeys.some((k) => CONFIRM_RE.test(k))),
      )
      .map((s) => ({
        label: s.label,
        status: s.status,
        dataConfirmish: s.dataConfirmish,
        dataCardish: s.dataCardish,
        dataFinanceish: (s.dataFinanceish || []).slice(0, 40),
      }));

    const reservationBindProven =
      confirmationColumnsFound.some((k) =>
        /^confirmation(number)?$/i.test(k),
      ) ||
      confirmationColumnsFound.some((k) =>
        /confirmationnumber|guestaccountid|gueststayid/i.test(k),
      );

    const report = {
      ok: true,
      path: 'Front Desk > Property Ledger > Deposit Ledger',
      menuClicks,
      treeLabels,
      domFieldNames,
      visibleConfirmAttrs,
      confirmationColumnsFound,
      cardColumnsFound,
      reservationBindProven,
      cardLeakRisk: cardColumnsFound.length > 0,
      denyNote:
        'Advance Deposit form / refunds / transfers / card number capture remain denied',
      dataKeyHits,
      osledgTabs: osledgTabs.map((t) => ({
        label: t.label,
        status: t.status,
        bytes: t.bytes,
        hasGrid: t.hasGrid,
        dataConfirmish: t.dataConfirmish,
        dataFinanceish: t.dataFinanceish,
        dataKeysSample: (t.dataKeys || []).slice(0, 50),
      })),
      parentHits: parentResults
        .filter((p) => p.status === 200 && p.bytes > 200)
        .map((p) => ({
          label: p.label,
          status: p.status,
          bytes: p.bytes,
          titles: p.titles,
          dataConfirmish: p.dataConfirmish,
          dataFinanceish: p.dataFinanceish,
          dataKeysSample: (p.dataKeys || []).slice(0, 40),
        })),
      netCaptureCount: captured.length,
      netConfirmHits: captured
        .filter((c) => (c.dataConfirmish || []).length > 0)
        .map((c) => ({
          label: c.label,
          dataConfirmish: c.dataConfirmish,
          dataCardish: c.dataCardish,
        })),
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    // stdout: keys only, no values
    console.log(
      JSON.stringify(
        {
          outPath,
          reservationBindProven: report.reservationBindProven,
          confirmationColumnsFound: report.confirmationColumnsFound,
          cardColumnsFound: report.cardColumnsFound,
          menuClicks: report.menuClicks,
          dataKeyHits: report.dataKeyHits,
          osledgTabs: report.osledgTabs,
          parentHits: report.parentHits,
          netConfirmHits: report.netConfirmHits,
          treeLabels: report.treeLabels,
          domFieldNames: report.domFieldNames,
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
