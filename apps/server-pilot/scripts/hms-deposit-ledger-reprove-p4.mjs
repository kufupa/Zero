/**
 * Deposit Ledger p4: after Property Ledger > Deposit Ledger UI open,
 * soft-capture network on list row activate; harvest field/column defs from open+LST.
 * Keys only. No mutations. No card values.
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

function collectKeys(text) {
  const out = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

function confirmHits(text) {
  const keys = collectKeys(text);
  const fromKeys = keys.filter((k) =>
    /confirm|guestaccount|gueststay|accountid|toaccount|guestnumber/i.test(k),
  );
  const fromCols = [];
  for (const re of [
    /"dataIndex"\s*:\s*"([^"]+)"/gi,
    /"header"\s*:\s*"([^"]+)"/gi,
    /"fieldName"\s*:\s*"([^"]+)"/gi,
    /"displayName"\s*:\s*"([^"]+)"/gi,
    /"itemLabel"\s*:\s*"([^"]+)"/gi,
  ]) {
    let m;
    while ((m = re.exec(text))) {
      if (/confirm|guest account|to account|card number/i.test(m[1])) {
        fromCols.push(m[1]);
      }
    }
  }
  // literal field mentions in scrubbed form meta
  const lit = [
    ...new Set(
      (text.match(/confirmationnumber|ff_confirmationnumber|confirmation\s*number/gi) || []).map(
        (s) => s.toLowerCase(),
      ),
    ),
  ];
  return { fromKeys, fromCols: [...new Set(fromCols)], lit };
}

function cardHits(text) {
  return collectKeys(text).filter((k) => /cardnumber|ccnumber/i.test(k));
}

function firstDataKeys(text) {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 40_000);
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

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DEPOSIT_REPROVE_OUT ??
    '/tmp/hms-deposit-ledger-reprove-p4.json';

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

  const net = [];
  const page = await ctx.newPage();
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.startsWith(origin)) return;
      const path = new URL(url).pathname;
      if (!/\/web\/base\//i.test(path)) return;
      if (response.request().method() === 'GET' && !/LEDG|PLDG|DEP/i.test(path))
        return;
      const text = await response.text().catch(() => '');
      if (text.length < 80) return;
      const ch = confirmHits(text);
      const dataKeys = firstDataKeys(text);
      net.push({
        path,
        method: response.request().method(),
        status: response.status(),
        bytes: text.length,
        hasGrid: /GRIDRESULT/i.test(text),
        dataKeys,
        confirm: ch,
        cardKeys: cardHits(text),
        titles: [
          ...new Set(
            (
              text.match(
                /Deposit Ledger|Property Ledger|Confirmation Number|Guest Ledger|Advance Deposit/gi,
              ) || []
            ).map((s) => s.replace(/\s+/g, ' ')),
          ),
        ],
      });
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

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const html = await page.content();
      const title = await page.title();
      if (
        /"tenantid"\s*:/i.test(html) &&
        (/Infor HMS\s*-\s*[A-Z0-9]+/i.test(title) ||
          /"property"\s*:\s*"[A-Z0-9]{2,16}"/i.test(html))
      ) {
        break;
      }
      await page.waitForTimeout(400);
    }

    async function treeClick(label) {
      const ok = await page.evaluate((wanted) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        let n;
        while ((n = walker.nextNode())) {
          const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === wanted) {
            n.parentElement?.click();
            return true;
          }
        }
        return false;
      }, label);
      await page.waitForTimeout(2_800);
      return ok;
    }

    const clicks = {
      frontDesk: await treeClick('Front Desk'),
      propertyLedger: await treeClick('Property Ledger'),
      depositLedger: await treeClick('Deposit Ledger'),
    };
    await page.waitForTimeout(3_000);

    // DOM names after Deposit Ledger paint
    const domNames = await page.evaluate(() => {
      const els = [
        ...document.querySelectorAll(
          'input[name], select[name], textarea[name], [data-qtip]',
        ),
      ];
      const names = [];
      for (const el of els) {
        const n =
          el.getAttribute('name') ||
          el.getAttribute('data-qtip') ||
          el.getAttribute('aria-label') ||
          '';
        if (
          n &&
          /confirm|guest|account|deposit|ledger|card|amount|balance|name/i.test(
            n,
          )
        ) {
          names.push(n.slice(0, 80));
        }
      }
      return [...new Set(names)].sort().slice(0, 60);
    });

    // Try activate first grid row (Ext)
    const rowAct = await page.evaluate(() => {
      const rows = [
        ...document.querySelectorAll(
          '.x-grid3-row, .x-grid-row, tr.x-grid-row, .x-grid3-cell-inner',
        ),
      ];
      if (rows.length === 0) return { rows: 0, clicked: false };
      const row =
        document.querySelector('.x-grid3-row') ||
        document.querySelector('.x-grid-row');
      if (!row) return { rows: rows.length, clicked: false };
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
      return { rows: rows.length, clicked: true };
    });
    await page.waitForTimeout(4_000);

    // Also programmatic open+LST for field defs
    const prog = await page.evaluate(async () => {
      async function post(path, fields) {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          credentials: 'same-origin',
        });
        return { status: r.status, text: await r.text() };
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
      return { open, lst };
    });

    const openConfirm = confirmHits(prog.open.text);
    const lstConfirm = confirmHits(prog.lst.text);
    const lstDataKeys = firstDataKeys(prog.lst.text);

    const netConfirm = net.filter(
      (n) =>
        n.confirm.fromKeys.length ||
        n.confirm.fromCols.length ||
        n.confirm.lit.length ||
        n.dataKeys.some((k) => /confirm/i.test(k)),
    );

    const confirmationColumnsFound = [
      ...new Set([
        ...openConfirm.fromKeys,
        ...openConfirm.fromCols,
        ...openConfirm.lit,
        ...lstConfirm.fromKeys,
        ...lstConfirm.fromCols,
        ...lstConfirm.lit,
        ...net.flatMap((n) => [
          ...n.confirm.fromKeys,
          ...n.confirm.fromCols,
          ...n.confirm.lit,
        ]),
        ...domNames.filter((n) => /confirm/i.test(n)),
      ]),
    ].sort();

    const cardColumnsFound = [
      ...new Set([
        ...cardHits(prog.open.text),
        ...cardHits(prog.lst.text),
        ...net.flatMap((n) => n.cardKeys),
        ...domNames.filter((n) => /card/i.test(n)),
      ]),
    ].sort();

    const report = {
      ok: true,
      clicks,
      rowAct,
      domNames,
      lstDataKeys,
      openBytes: prog.open.text.length,
      lstBytes: prog.lst.text.length,
      openConfirm,
      lstConfirm,
      confirmationColumnsFound,
      cardColumnsFound,
      reservationBindProven: confirmationColumnsFound.some((k) =>
        /confirmationnumber|^confirmation$/i.test(String(k)),
      ),
      netCaptureCount: net.length,
      netConfirmHits: netConfirm.map((n) => ({
        path: n.path,
        status: n.status,
        bytes: n.bytes,
        confirm: n.confirm,
        dataKeysSample: n.dataKeys.slice(0, 30),
      })),
      netPaths: [...new Set(net.map((n) => n.path))].slice(0, 40),
      netWithData: net
        .filter((n) => n.dataKeys.length)
        .map((n) => ({
          path: n.path,
          status: n.status,
          bytes: n.bytes,
          dataKeys: n.dataKeys,
          confirm: n.confirm,
        })),
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
