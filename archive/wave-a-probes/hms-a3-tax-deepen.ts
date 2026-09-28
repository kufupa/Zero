/**
 * A3: clean OSTXIV.HDR (+ LST/search variants) → tax_invoice compare.v1.
 * Sent Email remains prior PSSNEL packaging. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
  const outDir =
    process.env.HMS_A3_DIR ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a3-payload';

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
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(
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

  const result = await page.evaluate(async () => {
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
    await fetch('/web/base/OSTXIV?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSTXIV',
        USER_FUNCTION_NAME: 'OSTXIV',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const hdr = await fetch('/web/base/OSTXIV.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSTXIV',
        USER_FUNCTION_NAME: 'OSTXIV',
        CURRENT_TAB_NAME: 'HDR',
      }).toString(),
    });
    const hdrText = await hdr.text();

    const lstVariants: Record<string, { status: number; bytes: number }> = {};
    const lstBodies = [
      {
        tag: 'DATA_ONLY',
        body: {
          SYSTEM_FUNCTION_NAME: 'OSTXIV',
          USER_FUNCTION_NAME: 'OSTXIV',
          CURRENT_TAB_NAME: 'LST',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'OSTXIV',
        },
      },
      {
        tag: 'LST_plain',
        body: {
          SYSTEM_FUNCTION_NAME: 'OSTXIV',
          USER_FUNCTION_NAME: 'OSTXIV',
          CURRENT_TAB_NAME: 'LST',
        },
      },
    ];
    let bestLst = { status: 0, bytes: 0, text: '', tag: '' };
    for (const v of lstBodies) {
      const r = await fetch('/web/base/OSTXIV.LST', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(v.body).toString(),
      });
      const text = await r.text();
      lstVariants[v.tag] = { status: r.status, bytes: text.length };
      if (r.status === 200 && text.length > bestLst.bytes) {
        bestLst = { status: r.status, bytes: text.length, text, tag: v.tag };
      }
    }

    // Also try .search
    const search = await fetch('/web/base/OSTXIV.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSTXIV',
        USER_FUNCTION_NAME: 'OSTXIV',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'OSTXIV',
      }).toString(),
    });
    const searchText = await search.text();

    return {
      hdr: { status: hdr.status, bytes: hdrText.length, text: hdrText },
      lstVariants,
      bestLst: {
        status: bestLst.status,
        bytes: bestLst.bytes,
        tag: bestLst.tag,
        text: bestLst.text.slice(0, 50000),
      },
      search: {
        status: search.status,
        bytes: searchText.length,
        text: searchText.slice(0, 20000),
      },
    };
  });

  const hdrText = result.hdr.text;
  const taxKeys = extractKeys(
    hdrText + '\n' + (result.bestLst.text || '') + '\n' + (result.search.text || ''),
    /"(tax[^"]*|invoice[^"]*|folio[^"]*|balance[^"]*|gross[^"]*|vat[^"]*|net[^"]*|status[^"]*|currency[^"]*|amount[^"]*|type[^"]*|date[^"]*)"/gi,
  );

  const taxOk =
    result.hdr.status === 200 &&
    result.hdr.bytes > 5000 &&
    taxKeys.some((k) => /invoice|taxinv/i.test(k));

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_list_documents',
    capturedAt: new Date().toISOString(),
    unlock:
      'BSSTRT → OSTXIV open → OSTXIV.HDR; UI Front Desk → Tax Invoices harvests OSTXIV',
    sections: {
      sent_email: {
        status: 'available',
        note: 'Prior PSSNEL.HDR packaging PASS_SENT_EMAIL_SURFACE_VIDEO',
        source: 'PSSNEL',
      },
      tax_invoice: {
        status: taxOk ? 'available' : 'SURFACE_UNPROVEN',
        claimKeys: taxKeys.slice(0, 80),
        source: 'OSTXIV.HDR',
        hdrBytes: result.hdr.bytes,
        lstVariants: result.lstVariants,
        searchBytes: result.search.bytes,
        searchStatus: result.search.status,
      },
      hms_finalized_document: {
        status: taxOk ? 'partial' : 'SURFACE_UNPROVEN',
        note: 'Tax invoice list fields dump-proved; byte retrieval may remain mail/A4 path',
        claimKeys: taxKeys
          .filter((k) => /invoice|taxinv|status|folio/i.test(k))
          .slice(0, 40),
      },
    },
    allRequiredPass: taxOk,
    verdict: taxOk
      ? 'PASS_TAX_INVOICE_LIST_PAYLOAD'
      : 'SURFACE_UNPROVEN_TAX_INVOICE',
    digests: {
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
    `${outDir}/ostxiv-hdr.keys.v1.json`,
    `${JSON.stringify({ taxKeys, hdrBytes: result.hdr.bytes }, null, 2)}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      verdict: compare.verdict,
      allRequiredPass: compare.allRequiredPass,
      tax_invoice: {
        status: compare.sections.tax_invoice.status,
        claimKeysSample: compare.sections.tax_invoice.claimKeys.slice(0, 30),
        hdrBytes: result.hdr.bytes,
        lstVariants: result.lstVariants,
        searchBytes: result.search.bytes,
      },
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
