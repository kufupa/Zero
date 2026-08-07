/**
 * Deposit Ledger re-prove phase-2: scrubbed response shapes + menu harvest.
 * No values logged. No mutations. view_only only.
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

function scrub(text) {
  return text
    .replace(/:\s*"[^"]{0,2000}"/g, ':""')
    .replace(/:\s*'[^']{0,2000}'/g, ":''")
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ':0')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{12,19}\b/g, '[pan?]');
}

function collectKeys(text) {
  const out = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

function columnHints(text) {
  const cols = new Set();
  for (const re of [
    /"column(?:Id|Name|Field|dataIndex|header)"\s*:\s*"([^"]{1,64})"/gi,
    /"dataIndex"\s*:\s*"([^"]{1,64})"/gi,
    /"header"\s*:\s*"([^"]{1,64})"/gi,
    /"fieldName"\s*:\s*"([^"]{1,64})"/gi,
    /"name"\s*:\s*"(ff_[^"]{1,64}|confirmation[^"]{0,32}|guest[^"]{0,32})"/gi,
  ]) {
    let m;
    while ((m = re.exec(text))) cols.add(m[1]);
  }
  return [...cols].sort().slice(0, 150);
}

function shape(label, status, text) {
  const s = scrub(text);
  const keys = collectKeys(text);
  return {
    label,
    status,
    bytes: text.length,
    hasGrid: /GRIDRESULT/i.test(text),
    hasDATA: /"DATA"\s*:/i.test(text),
    hasError: /"error"|"ERROR"|Exception|not authorized|Access Denied/i.test(
      text,
    ),
    errorSnips: [
      ...new Set(
        (text.match(/(?:error|message|exception|faultstring)["'\s:=]+[^"<\n]{0,80}/gi) || [])
          .map((x) => x.replace(/:\s*"[^"]*"/g, ':""').slice(0, 100)),
      ),
    ].slice(0, 8),
    titles: [
      ...new Set(
        [
          ...(text.match(/Deposit Ledger/gi) || []),
          ...(text.match(/Property Ledger/gi) || []),
          ...(text.match(/Advance Deposit/gi) || []),
          ...(text.match(/Confirmation Number/gi) || []),
          ...(text.match(/List View/gi) || []),
        ].map((t) => t.replace(/\s+/g, ' ')),
      ),
    ],
    confirmishKeys: keys.filter((k) =>
      /confirm|guestaccount|gueststay|accountid|toaccount|guestnumber/i.test(k),
    ),
    cardishKeys: keys.filter((k) => /cardnumber|ccnumber|pan\b/i.test(k)),
    financeKeys: keys.filter((k) =>
      /balance|deposit|due|paid|refund|forfeit|transfer|currency|opening|closing|amount|activity/i.test(
        k,
      ),
    ),
    columnHints: columnHints(text).filter((c) =>
      /confirm|guest|account|deposit|balance|amount|card|name|ledger|activity|currency/i.test(
        c,
      ),
    ),
    allKeysSample: keys.slice(0, 80),
    headScrubbed: s.slice(0, 400).replace(/\s+/g, ' '),
  };
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DEPOSIT_REPROVE_OUT ??
    '/tmp/hms-deposit-ledger-reprove-p2.json';

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
    await page.waitForTimeout(5_000);

    const urlAfterLogin = new URL(page.url()).pathname;

    // Menu harvest via COMMON / BSSTRT (same pattern as group-event probe)
    const menuHarvest = await page.evaluate(`(async () => {
      var paths = ['/web/base/COMMON', '/web/base/BSSTRT', '/web/base/BSSTRT.HDR', '/web/base/BSSTRT.LST'];
      var pairs = [];
      var labels = [];
      var fns = [];
      for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        try {
          var fnName = path.split('/').pop().split('.')[0];
          var r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: fnName,
              USER_FUNCTION_NAME: fnName,
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          var text = await r.text();
          var reLabel = /"itemLabel"\\s*:\\s*"([^"]{1,120})"/g;
          var m;
          while ((m = reLabel.exec(text))) {
            if (labels.indexOf(m[1]) === -1) labels.push(m[1]);
          }
          var chunks = text.split('{');
          for (var c = 0; c < chunks.length; c++) {
            var chunk = chunks[c];
            var labelM = /"itemLabel"\\s*:\\s*"([^"]+)"/.exec(chunk);
            var fnM = /"(?:userFunction|systemFunction|functionName|USER_FUNCTION_NAME)"\\s*:\\s*"([A-Z0-9]{3,12})"/.exec(chunk);
            if (labelM && fnM && /ledger|deposit|property|folio/i.test(labelM[1])) {
              pairs.push({ label: labelM[1], fn: fnM[1], src: path, status: r.status });
            }
          }
          var reFn = /\\b((?:OS|PS|AR)[A-Z0-9]{3,10})\\b/g;
          while ((m = reFn.exec(text))) {
            if (fns.indexOf(m[1]) === -1 && /LEDG|PLDG|DEP|FOL|PROP|ACCT/i.test(m[1])) fns.push(m[1]);
          }
        } catch (e) {}
      }
      // module key sweep 0..12 for Front Desk menus
      for (var k = 0; k <= 12; k++) {
        try {
          var r2 = await fetch('/web/base/BSSTRT', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: String(k),
              removescreenflows: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          var text2 = await r2.text();
          var reL2 = /"itemLabel"\\s*:\\s*"([^"]{1,120})"/g;
          var m2;
          while ((m2 = reL2.exec(text2))) {
            if (/ledger|deposit|property|folio|front desk/i.test(m2[1]) && labels.indexOf(m2[1]) === -1) {
              labels.push(m2[1] + '@mod' + k);
            }
          }
          var chunks2 = text2.split('{');
          for (var c2 = 0; c2 < chunks2.length; c2++) {
            var chunk2 = chunks2[c2];
            var labelM2 = /"itemLabel"\\s*:\\s*"([^"]+)"/.exec(chunk2);
            var fnM2 = /"(?:userFunction|systemFunction|functionName)"\\s*:\\s*"([A-Z0-9]{3,12})"/.exec(chunk2);
            if (labelM2 && fnM2 && /ledger|deposit|property|folio/i.test(labelM2[1])) {
              pairs.push({ label: labelM2[1], fn: fnM2[1], src: 'BSSTRT@' + k, status: r2.status });
            }
          }
        } catch (e) {}
      }
      return {
        labels: labels.filter(function (l) { return /ledger|deposit|property|folio|front/i.test(l); }).slice(0, 80),
        pairs: pairs.slice(0, 40),
        fns: fns.slice(0, 40),
      };
    })()`);

    // Tree click with Ext selectors
    const clickReport = [];
    async function treeClick(label) {
      const locators = [
        page.locator('.x-tree-node-text', { hasText: new RegExp(`^${label}$`) }).first(),
        page.getByText(label, { exact: true }).first(),
        page.locator(`text=${label}`).first(),
      ];
      for (let i = 0; i < locators.length; i++) {
        try {
          await locators[i].click({ force: true, timeout: 8_000 });
          clickReport.push({ label, strategy: i, ok: true });
          await page.waitForTimeout(2_500);
          return true;
        } catch {
          /* try next */
        }
      }
      clickReport.push({ label, strategy: -1, ok: false });
      return false;
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
                /ledger|deposit|property|folio|front|list|advance/i.test(t),
            ),
        ),
      ].slice(0, 80);
    });

    // page.evaluate fetch (same-origin) for OSLEDG family — mirrors phase3/4
    const prog = await page.evaluate(`(async () => {
      async function post(path, fields) {
        var r = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          credentials: 'same-origin',
        });
        return { status: r.status, text: await r.text(), path: path };
      }
      var out = [];
      var open = await post('/web/base/OSLEDG', {
        USER_FUNCTION_NAME: 'OSLEDG',
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      out.push(open);
      var bodies = [
        { SYSTEM_FUNCTION_NAME: 'OSLEDG', USER_FUNCTION_NAME: 'OSLEDG', CURRENT_TAB_NAME: 'LST' },
        { SYSTEM_FUNCTION_NAME: 'OSLEDG', USER_FUNCTION_NAME: 'OSLEDG', CURRENT_TAB_NAME: 'LST', COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: 'OSLEDG' },
        { SYSTEM_FUNCTION_NAME: 'OSLEDG', USER_FUNCTION_NAME: 'OSLEDG', CURRENT_TAB_NAME: 'LST', COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: 'OSLEDG', ONLY_DATA_REQUIRED: 'true' },
        { SYSTEM_FUNCTION_NAME: 'OSLEDG', USER_FUNCTION_NAME: 'OSLEDG', CURRENT_TAB_NAME: 'HDR' },
        { SYSTEM_FUNCTION_NAME: 'OSLEDG', USER_FUNCTION_NAME: 'OSLEDG', CURRENT_TAB_NAME: 'DTL' },
      ];
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        var tab = b.CURRENT_TAB_NAME || 'LST';
        var path = tab === '' ? '/web/base/OSLEDG' : '/web/base/OSLEDG.' + tab;
        out.push(Object.assign(await post(path, b), { bodyKeys: Object.keys(b) }));
      }
      // parent guesses
      var parents = ['OSPLDG', 'PSPLDG', 'OSPLG', 'OSPROP', 'PSLEDG'];
      for (var p = 0; p < parents.length; p++) {
        var fn = parents[p];
        out.push(await post('/web/base/' + fn, {
          USER_FUNCTION_NAME: fn,
          SYSTEM_FUNCTION_NAME: fn,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }));
        out.push(await post('/web/base/' + fn + '.LST', {
          SYSTEM_FUNCTION_NAME: fn,
          USER_FUNCTION_NAME: fn,
          CURRENT_TAB_NAME: 'LST',
        }));
      }
      return out.map(function (r) {
        return {
          path: r.path,
          status: r.status,
          bytes: r.text.length,
          bodyKeys: r.bodyKeys || null,
          text: r.text,
        };
      });
    })()`);

    const shaped = prog.map((r) =>
      shape(
        `${r.path}${r.bodyKeys ? ':' + r.bodyKeys.join('+') : ''}`,
        r.status,
        r.text,
      ),
    );

    // If menu pairs found Deposit Ledger fn, open that too
    const extraFns = [
      ...new Set([
        ...(menuHarvest.pairs || []).map((p) => p.fn),
        ...(menuHarvest.fns || []),
      ]),
    ].filter((fn) => /LEDG|PLDG|DEP/i.test(fn));

    const extraShaped = [];
    for (const fn of extraFns.slice(0, 8)) {
      if (fn === 'OSLEDG') continue;
      const r = await page.evaluate(
        async (functionName) => {
          const open = await fetch(`/web/base/${functionName}`, {
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
          const lst = await fetch(`/web/base/${functionName}.LST`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              CURRENT_TAB_NAME: 'LST',
            }).toString(),
            credentials: 'same-origin',
          });
          return {
            open: { status: open.status, text: await open.text() },
            lst: { status: lst.status, text: await lst.text() },
          };
        },
        fn,
      );
      extraShaped.push(shape(`menuFn:${fn}.open`, r.open.status, r.open.text));
      extraShaped.push(shape(`menuFn:${fn}.LST`, r.lst.status, r.lst.text));
    }

    const all = [...shaped, ...extraShaped];
    const confirmationColumnsFound = [
      ...new Set(all.flatMap((s) => [...s.confirmishKeys, ...s.columnHints.filter((c) => /confirm/i.test(c))])),
    ].sort();
    const cardColumnsFound = [
      ...new Set(all.flatMap((s) => s.cardishKeys)),
    ].sort();

    const reservationBindProven = confirmationColumnsFound.some((k) =>
      /confirmationnumber|^confirmation$/i.test(k),
    );

    const report = {
      ok: true,
      urlAfterLogin,
      clickReport,
      treeAfter,
      menuHarvest,
      confirmationColumnsFound,
      cardColumnsFound,
      reservationBindProven,
      shapes: all.map((s) => ({
        label: s.label,
        status: s.status,
        bytes: s.bytes,
        hasGrid: s.hasGrid,
        hasDATA: s.hasDATA,
        hasError: s.hasError,
        errorSnips: s.errorSnips,
        titles: s.titles,
        confirmishKeys: s.confirmishKeys,
        cardishKeys: s.cardishKeys,
        financeKeys: s.financeKeys,
        columnHints: s.columnHints,
        allKeysSample: s.allKeysSample,
        headScrubbed: s.headScrubbed,
      })),
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          outPath,
          reservationBindProven,
          confirmationColumnsFound,
          cardColumnsFound,
          clickReport,
          treeAfter,
          menuLabels: menuHarvest.labels,
          menuPairs: menuHarvest.pairs,
          menuFns: menuHarvest.fns,
          shapeSummary: all.map((s) => ({
            label: s.label,
            status: s.status,
            bytes: s.bytes,
            hasGrid: s.hasGrid,
            hasDATA: s.hasDATA,
            confirmishKeys: s.confirmishKeys,
            financeKeys: s.financeKeys,
            columnHints: s.columnHints,
            errorSnips: s.errorSnips,
            headScrubbed: s.headScrubbed.slice(0, 180),
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
