/**
 * Deposit Ledger re-prove p3: wait for property shell, then OSLEDG.LST +
 * row-select detail hunt. Keys/column defs only. No card values. No mutations.
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
    expectedTenant: z.string().min(1).optional(),
    expectedPropertyCode: z.string().min(1).optional(),
  })
  .passthrough();

function collectKeys(text) {
  const out = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

function firstDataKeys(text) {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 60_000);
  const objStart = slice.indexOf('{');
  if (objStart < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = objStart; i < slice.length; i++) {
    if (slice[i] === '{') depth++;
    if (slice[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  return collectKeys(
    slice
      .slice(objStart, end + 1)
      .replace(/:\s*"[^"]*"/g, ':""')
      .replace(/:\s*-?\d+(?:\.\d+)?/g, ':0'),
  );
}

function columnHints(text) {
  const cols = new Set();
  for (const re of [
    /"column(?:Id|Name|Field|dataIndex|header)"\s*:\s*"([^"]{1,80})"/gi,
    /"dataIndex"\s*:\s*"([^"]{1,80})"/gi,
    /"header"\s*:\s*"([^"]{1,80})"/gi,
    /"fieldName"\s*:\s*"([^"]{1,80})"/gi,
    /"displayName"\s*:\s*"([^"]{1,80})"/gi,
  ]) {
    let m;
    while ((m = re.exec(text))) cols.add(m[1]);
  }
  return [...cols].sort();
}

function confirmish(keys) {
  return keys.filter((k) =>
    /confirm|guestaccount|gueststay|accountid|toaccount|guestnumber|reservation/i.test(
      k,
    ),
  );
}

function cardish(keys) {
  return keys.filter((k) => /cardnumber|ccnumber|pan\b/i.test(k));
}

function isLocaleShell(text) {
  return /loadLocalizedPage|allcookies|EWSLanguage/i.test(text) && text.length < 2000;
}

function summarize(label, status, text) {
  const keys = collectKeys(text);
  const dataKeys = firstDataKeys(text);
  const cols = columnHints(text);
  return {
    label,
    status,
    bytes: text.length,
    localeShell: isLocaleShell(text),
    hasGrid: /GRIDRESULT/i.test(text),
    hasDATA: /"DATA"\s*:/i.test(text),
    titles: [
      ...new Set(
        (text.match(/Deposit Ledger|Property Ledger|Advance Deposit|Confirmation Number|List View/gi) || []).map(
          (s) => s.replace(/\s+/g, ' '),
        ),
      ),
    ],
    dataKeys,
    dataConfirmish: confirmish(dataKeys),
    dataCardish: cardish(dataKeys),
    allConfirmish: confirmish(keys),
    allCardish: cardish(keys),
    columnConfirmish: cols.filter((c) => /confirm|guest|account|card|name/i.test(c)),
    columnHintsSample: cols.filter((c) =>
      /confirm|guest|account|deposit|balance|amount|card|name|ledger|activity|currency|date/i.test(
        c,
      ),
    ),
    financeData: dataKeys.filter((k) =>
      /balance|deposit|due|paid|refund|forfeit|transfer|currency|opening|closing|amount|activity|name|hoteldate/i.test(
        k,
      ),
    ),
  };
}

/** Extract first DATA row id only (numeric/string id) — discard other values. */
function firstRowId(text) {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return null;
  const slice = text.slice(idx, idx + 8000);
  const m = /"id"\s*:\s*"([^"]{1,64})"/i.exec(slice) || /"id"\s*:\s*(\d+)/i.exec(slice);
  return m ? m[1] : null;
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DEPOSIT_REPROVE_OUT ??
    '/tmp/hms-deposit-ledger-reprove-p3.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|email)/i.test(
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

    // Wait for property shell (mirror runtime.waitForAuthenticatedShell)
    const deadline = Date.now() + 45_000;
    let shellReady = false;
    let shellNote = 'timeout';
    while (Date.now() < deadline) {
      const html = await page.content();
      const title = await page.title();
      const hasTenant =
        /"tenantid"\s*:\s*"/i.test(html) || /data-tenant=/i.test(html);
      const hasProp =
        /"property"\s*:\s*"[A-Z0-9]{2,16}"/i.test(html) ||
        /data-property-code=/i.test(html) ||
        /Infor HMS\s*-\s*[A-Z0-9]+/i.test(title);
      if (hasTenant && hasProp) {
        shellReady = true;
        shellNote = `ready title=${title.slice(0, 60)}`;
        break;
      }
      await page.waitForTimeout(500);
    }

    // Menu path after shell
    const clickReport = [];
    async function treeClick(label) {
      // Ext text-walker first (runtime pattern)
      const walked = await page.evaluate((wanted) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        let n;
        while ((n = walker.nextNode())) {
          const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === wanted) {
            const el = n.parentElement;
            if (el) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }, label);
      if (walked) {
        clickReport.push({ label, ok: true, via: 'walker' });
        await page.waitForTimeout(2_500);
        return true;
      }
      try {
        await page
          .locator('.x-tree-node-text', { hasText: new RegExp(`^${label}$`) })
          .first()
          .click({ force: true, timeout: 6_000 });
        clickReport.push({ label, ok: true, via: 'xtree' });
        await page.waitForTimeout(2_500);
        return true;
      } catch {
        clickReport.push({ label, ok: false, via: 'none' });
        return false;
      }
    }

    await treeClick('Front Desk');
    await treeClick('Property Ledger');
    await treeClick('Deposit Ledger');

    const treeAfter = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, span.x-tab-inner',
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
                /ledger|deposit|property|folio|front|list|advance|confirm/i.test(
                  t,
                ),
            ),
        ),
      ].slice(0, 80);
    });

    async function post(path, fields) {
      return page.evaluate(
        async ({ path, fields }) => {
          const r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            credentials: 'same-origin',
          });
          return { status: r.status, text: await r.text() };
        },
        { path, fields },
      );
    }

    const open = await post('/web/base/OSLEDG', {
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

    const results = [
      summarize('OSLEDG.open', open.status, open.text),
      summarize('OSLEDG.LST', lst.status, lst.text),
    ];

    const rowId = firstRowId(lst.text);
    const detailTries = [];
    if (rowId && !isLocaleShell(lst.text)) {
      // Focus / select / detail variants — keys only
      const attempts = [
        {
          path: '/web/base/OSLEDG.LST',
          fields: {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: 'LST',
            SELECTED_ID: rowId,
          },
        },
        {
          path: '/web/base/OSLEDG.DTL',
          fields: {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: 'DTL',
            SELECTED_ID: rowId,
            RECORD_ID: rowId,
          },
        },
        {
          path: '/web/base/OSLEDG',
          fields: {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: 'LST',
            FOCUS_ID: rowId,
            ID: rowId,
          },
        },
        {
          path: '/web/base/OSLEDG.LST',
          fields: {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: 'LST',
            COMPONENT_INFO_TYPE: 'DATA_ONLY',
            GRID_NAME: 'OSLEDG',
            PARENT_ID: rowId,
            ONLY_DATA_REQUIRED: 'true',
          },
        },
        {
          path: '/web/base/OSLEDG.HDR',
          fields: {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            CURRENT_TAB_NAME: 'HDR',
            ID: rowId,
          },
        },
      ];
      for (const a of attempts) {
        const r = await post(a.path, a.fields);
        const s = summarize(
          `detail:${a.path}:keys=${Object.keys(a.fields).join('+')}`,
          r.status,
          r.text,
        );
        detailTries.push({
          ...s,
          // never echo rowId value in durable report — only presence
          hadRowId: true,
        });
        results.push(s);
      }
    }

    // Also try page.request (cookie jar) in case evaluate fetch differs
    const reqLst = await page.request.post(`${origin}/web/base/OSLEDG.LST`, {
      form: {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'LST',
      },
      timeout: 60_000,
    });
    const reqText = await reqLst.text();
    results.push(summarize('OSLEDG.LST:page.request', reqLst.status(), reqText));

    const confirmationColumnsFound = [
      ...new Set(
        results.flatMap((r) => [
          ...r.dataConfirmish,
          ...r.allConfirmish,
          ...r.columnConfirmish,
        ]),
      ),
    ].sort();
    const cardColumnsFound = [
      ...new Set(results.flatMap((r) => [...r.dataCardish, ...r.allCardish])),
    ].sort();
    const lstDataKeys =
      results.find((r) => r.label === 'OSLEDG.LST' && r.hasDATA)?.dataKeys ||
      results.find((r) => r.hasDATA)?.dataKeys ||
      [];

    const reservationBindProven = confirmationColumnsFound.some((k) =>
      /confirmationnumber|^confirmation$/i.test(String(k)),
    );

    const report = {
      ok: true,
      shellReady,
      shellNote,
      clickReport,
      treeAfter,
      rowIdPresent: Boolean(rowId),
      lstDataKeys,
      confirmationColumnsFound,
      cardColumnsFound,
      reservationBindProven,
      priorP4DataKeys:
        'charges,closingbalance,closingdate,currency,forfeits,fromdeposit,hoteldate,id,newdeposits,openingbalance,payments,property,refunds,toar,toguestledger',
      results,
      detailTries: detailTries.map((d) => ({
        label: d.label,
        status: d.status,
        bytes: d.bytes,
        localeShell: d.localeShell,
        hasGrid: d.hasGrid,
        dataConfirmish: d.dataConfirmish,
        dataKeys: d.dataKeys,
        columnConfirmish: d.columnConfirmish,
      })),
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          outPath,
          shellReady,
          shellNote,
          clickReport,
          treeAfter,
          rowIdPresent: Boolean(rowId),
          reservationBindProven,
          confirmationColumnsFound,
          cardColumnsFound,
          lstDataKeys,
          resultSummary: results.map((r) => ({
            label: r.label,
            status: r.status,
            bytes: r.bytes,
            localeShell: r.localeShell,
            hasGrid: r.hasGrid,
            hasDATA: r.hasDATA,
            dataConfirmish: r.dataConfirmish,
            columnConfirmish: r.columnConfirmish,
            financeData: r.financeData,
            dataKeys: r.dataKeys,
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
