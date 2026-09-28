/**
 * A2 deepen: OSRESV.FOL (+ DATA_ONLY) after exact search.
 * Emit deposits/transactions/balance claimKeys (no amounts/PII values).
 * HMS_DISCOVERY_ALLOW_LIVE=1 + HMS_PROOF_EXACT_CANDIDATE_PATH.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function extractKeys(text: string, re: RegExp): string[] {
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))].sort();
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outDir =
    process.env.HMS_A2_DIR ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a2-payload';

  const raw = JSON.parse(await readFile(candPath, 'utf8')) as {
    kind?: string;
    value?: string;
  };
  if (raw.kind !== 'confirmation' || !raw.value) {
    throw new Error('exact confirmation candidate required');
  }
  const exactConf = raw.value;

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
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
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|\/post)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();

  await page.goto(secret.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .locator('input[name=userid], input[name=username], input[name=j_username]')
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

  const result = await page.evaluate(async (exact) => {
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh: 'yes',
        }).toString(),
      }).catch(() => undefined);
    }
    await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });

    const unused = '___NOMATCH___';
    const searchBody: Record<string, string> = {
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      GRID_ID: '1775',
      GRID_NAME: 'OSRESS',
      DATASPY_ID: '1941',
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'LST',
      MADDON_FILTER_ALIAS_NAME_1: 'departuredate',
      MADDON_FILTER_OPERATOR_1: '>=',
      MADDON_FILTER_JOINER_1: 'AND',
      MADDON_FILTER_SEQNUM_1: '1',
      MADDON_FILTER_VALUE_1: '-365',
      MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
      MADDON_FILTER_OPERATOR_2: '<=',
      MADDON_FILTER_JOINER_2: 'AND',
      MADDON_FILTER_SEQNUM_2: '2',
      MADDON_FILTER_VALUE_2: '+365',
      MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
      MADDON_FILTER_OPERATOR_3: 'BEGINS',
      MADDON_FILTER_JOINER_3: 'OR',
      MADDON_FILTER_SEQNUM_3: '3',
      MADDON_FILTER_VALUE_3: exact,
      MADDON_LPAREN_3: 'true',
      MADDON_FILTER_ALIAS_NAME_4: 'room',
      MADDON_FILTER_OPERATOR_4: '=',
      MADDON_FILTER_JOINER_4: 'OR',
      MADDON_FILTER_SEQNUM_4: '4',
      MADDON_FILTER_VALUE_4: unused,
      MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter',
      MADDON_FILTER_OPERATOR_5: 'BEGINS',
      MADDON_FILTER_JOINER_5: 'OR',
      MADDON_FILTER_SEQNUM_5: '5',
      MADDON_FILTER_VALUE_5: unused,
      MADDON_LPAREN_5: 'false',
      MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
      MADDON_FILTER_OPERATOR_6: 'BEGINS',
      MADDON_FILTER_JOINER_6: 'OR',
      MADDON_FILTER_SEQNUM_6: '6',
      MADDON_FILTER_VALUE_6: unused,
      MADDON_RPAREN_6: 'false',
      MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
      MADDON_FILTER_OPERATOR_7: 'BEGINS',
      MADDON_FILTER_JOINER_7: 'OR',
      MADDON_FILTER_SEQNUM_7: '7',
      MADDON_FILTER_VALUE_7: unused,
      MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
      MADDON_FILTER_OPERATOR_8: 'BEGINS',
      MADDON_FILTER_JOINER_8: 'OR',
      MADDON_FILTER_SEQNUM_8: '8',
      MADDON_FILTER_VALUE_8: unused,
      MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
      MADDON_FILTER_OPERATOR_9: 'BEGINS',
      MADDON_FILTER_JOINER_9: 'OR',
      MADDON_FILTER_SEQNUM_9: '9',
      MADDON_FILTER_VALUE_9: unused,
      MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
      MADDON_FILTER_OPERATOR_10: 'BEGINS',
      MADDON_FILTER_JOINER_10: 'OR',
      MADDON_FILTER_SEQNUM_10: '10',
      MADDON_FILTER_VALUE_10: unused,
      MADDON_RPAREN_10: 'true',
      externalconfirmation: unused,
    };

    const search = await fetch('/web/base/OSRESS.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(searchBody).toString(),
    });
    const searchText = await search.text();
    let stayId: string | null = null;
    let conf: string | null = null;
    try {
      const marker = 'pageData:';
      const idx = searchText.indexOf(marker);
      let i = idx + marker.length;
      while (i < searchText.length && /\s/.test(searchText[i]!)) i++;
      let depth = 0;
      let end = i;
      for (; end < searchText.length; end++) {
        if (searchText[end] === '{') depth++;
        else if (searchText[end] === '}') {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      const pageData = JSON.parse(searchText.slice(i, end)) as Record<
        string,
        unknown
      >;
      const grid = pageData.grid as Record<string, unknown>;
      const data = (
        (grid.GRIDRESULT as Record<string, unknown>).GRID as Record<
          string,
          unknown
        >
      ).DATA as Array<Record<string, unknown>>;
      const row = data[0];
      if (row) {
        stayId = row.id != null ? String(row.id) : null;
        conf =
          row.confirmationnumber != null
            ? String(row.confirmationnumber)
            : null;
      }
    } catch {
      /* ignore */
    }
    if (!conf) return { ok: false, searchBytes: searchText.length };

    const base: Record<string, string> = {
      confirmationnumber: conf,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    };
    if (stayId) {
      base.reservationstayid = stayId;
      base.id = stayId;
    }

    // Open HDR first (stay context), then FOL immediately (A3 unlock order)
    const hdrR = await fetch('/web/base/OSRESV.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...base, CURRENT_TAB_NAME: 'HDR' }).toString(),
    });
    const hdrText = await hdrR.text();

    const folR = await fetch('/web/base/OSRESV.FOL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...base, CURRENT_TAB_NAME: 'FOL' }).toString(),
    });
    const folText = await folR.text();

    const folDataR = await fetch('/web/base/OSRESV.FOL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...base,
        CURRENT_TAB_NAME: 'FOL',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'OSRESV',
      }).toString(),
    });
    const folDataText = await folDataR.text();

    // Common child grids seen on folio screens
    const gridNames = [
      'OSRESV',
      'OSFOLI',
      'OSLEDG',
      'FOLTXN',
      'FOLDEP',
      'OSDEPO',
      'DEPLDG',
    ];
    const gridProbes: Record<string, { status: number; bytes: number }> = {};
    const gridTexts: Record<string, string> = {};
    for (const gn of gridNames) {
      const r = await fetch('/web/base/OSRESV.FOL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...base,
          CURRENT_TAB_NAME: 'FOL',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: gn,
        }).toString(),
      });
      const t = await r.text();
      gridProbes[gn] = { status: r.status, bytes: t.length };
      if (r.status === 200 && t.length > 500) gridTexts[gn] = t;
    }

    return {
      ok: true,
      hdr: { status: hdrR.status, bytes: hdrText.length, text: hdrText },
      fol: { status: folR.status, bytes: folText.length, text: folText },
      folData: {
        status: folDataR.status,
        bytes: folDataText.length,
        text: folDataText,
      },
      gridProbes,
      gridTexts,
    };
  }, exactConf);

  if (!result.ok || !result.fol) {
    process.stdout.write(JSON.stringify({ ok: false, result }) + '\n');
    await browser.close();
    return;
  }

  const folText = result.fol.text;
  const hdrText = result.hdr!.text;
  const allText =
    folText +
    '\n' +
    (result.folData?.text || '') +
    '\n' +
    Object.values(result.gridTexts || {}).join('\n');

  const balanceKeys = extractKeys(
    allText,
    /"(folio[^"]*|balance[^"]*|currency[^"]*|nopost[^"]*|authorization[^"]*|guestbalance[^"]*|arbalance[^"]*|incidentals[^"]*)"/gi,
  );
  const depositKeys = extractKeys(
    allText,
    /"(deposit[^"]*|untransfer[^"]*|advance[^"]*|forfeit[^"]*|refund[^"]*)"/gi,
  );
  const txnKeys = extractKeys(
    allText,
    /"(transaction[^"]*|posting[^"]*|charge[^"]*|payment[^"]*|amount[^"]*|trx[^"]*|linetype[^"]*|description[^"]*|tran[^"]{0,30})"/gi,
  );
  const hdrDepositPolicy = extractKeys(
    hdrText,
    /"(deposit[^"]*|guarantee[^"]*|cancel[^"]*|policy[^"]*|rateplan[^"]*|rate[^"]*|price[^"]*)"/gi,
  );

  const balanceOk =
    result.fol.status === 200 &&
    result.fol.bytes > 2000 &&
    balanceKeys.some((k) => /balance|folio|currency/i.test(k));
  const depositsOk = depositKeys.length > 0;
  const txnsOk = txnKeys.length > 0;

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_read_folio',
    capturedAt: new Date().toISOString(),
    unlock: 'BSSTRT → OSRESS → OSRESS.search → OSRESV.HDR → OSRESV.FOL',
    sections: {
      balance: {
        status: balanceOk ? 'available' : 'unavailable',
        claimKeys: balanceKeys.slice(0, 50),
        source: 'OSRESV.FOL',
        folBytes: result.fol.bytes,
      },
      deposits: {
        status: depositsOk ? 'available' : 'SURFACE_UNPROVEN',
        claimKeys: depositKeys.slice(0, 50),
        source: depositsOk ? 'OSRESV.FOL' : null,
        hdrPolicyKeys: hdrDepositPolicy.slice(0, 30),
      },
      transactions: {
        status: txnsOk ? 'available' : 'SURFACE_UNPROVEN',
        claimKeys: txnKeys.slice(0, 60),
        source: txnsOk ? 'OSRESV.FOL' : null,
      },
    },
    gridProbes: result.gridProbes,
    allRequiredPass: balanceOk && depositsOk && txnsOk,
    verdict:
      balanceOk && depositsOk && txnsOk
        ? 'PASS_FOLIO_BALANCE_DEPOSITS_TXN'
        : balanceOk
          ? 'PARTIAL_FOLIO_BALANCE'
          : 'BLOCKED_FOLIO',
    digests: {
      folSha256: createHash('sha256').update(folText).digest('hex'),
      hdrSha256: createHash('sha256').update(hdrText).digest('hex'),
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${outDir}/osresv-fol.keys.v1.json`,
    `${JSON.stringify(
      {
        balanceKeys,
        depositKeys,
        txnKeys,
        hdrDepositPolicy,
        folBytes: result.fol.bytes,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      verdict: compare.verdict,
      allRequiredPass: compare.allRequiredPass,
      balance: compare.sections.balance,
      deposits: {
        status: compare.sections.deposits.status,
        claimKeys: compare.sections.deposits.claimKeys.slice(0, 25),
      },
      transactions: {
        status: compare.sections.transactions.status,
        claimKeys: compare.sections.transactions.claimKeys.slice(0, 25),
      },
      gridProbes: compare.gridProbes,
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    msg.replace(/arn:aws:\S+/gi, '[arn]').slice(0, 240) + '\n',
  );
  process.exit(1);
});
