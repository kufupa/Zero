/**
 * A8 deepen: FSOGPF billing-profiles / detail tabs + FSBAPF.LST agency list.
 * Structure keys only. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outDir =
    process.env.HMS_A8_DEEPEN_DIR ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a8-payload';

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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
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

  // FSOGPF: open + LST + HDR; harvest tab tokens from HDR; probe billing-ish tabs
  const orgHdr = await page.evaluate(async () => {
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
    await fetch('/web/base/FSOGPF?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const hdr = await fetch('/web/base/FSOGPF.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        CURRENT_TAB_NAME: 'HDR',
        FUNCTION_CLASS: 'WEBL',
      }).toString(),
    });
    return await hdr.text();
  });

  const tabTokens = [
    ...new Set(
      [
        ...orgHdr.matchAll(/\b([A-Z]{2,4})\b/g),
        ...orgHdr.matchAll(/CURRENT_TAB_NAME["'\s:=]+([A-Z0-9_]{1,16})/gi),
        ...orgHdr.matchAll(/tabName["'\s:=]+["']([A-Z0-9_]{1,16})["']/gi),
      ].map((m) => m[1]!.toUpperCase()),
    ),
  ].filter((t) =>
    /BILL|PAY|CONT|PROF|RATE|AUTO|NOTE|DTL|DET|HDR|LST|SUM|RVW|DAT|BPRF|BPFL|ATRF|NGRT/i.test(
      t,
    ),
  );

  const billingishTabs = [
    ...new Set([
      ...tabTokens,
      'BPRF',
      'BILL',
      'BPFL',
      'BLPR',
      'ATRF',
      'NGRT',
      'DTL',
      'DET',
      'RVW',
      'DAT',
      'SUM',
    ]),
  ];

  const tabProbes: Record<string, { status: number; bytes: number; keyHits: string[] }> =
    {};
  for (const tab of billingishTabs.slice(0, 20)) {
    tabProbes[tab] = await page.evaluate(async (tabName) => {
      const r = await fetch(`/web/base/FSOGPF.${tabName}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          CURRENT_TAB_NAME: tabName,
          FUNCTION_CLASS: 'WEBL',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'FSOGPF',
        }).toString(),
      });
      const text = await r.text();
      const keyHits = [
        ...new Set(
          [
            ...text.matchAll(
              /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*)"/gi,
            ),
          ].map((m) => m[1]!),
        ),
      ].slice(0, 40);
      return { status: r.status, bytes: text.length, keyHits };
    }, tab);
  }

  // Also scan HDR for billing field names
  const hdrBillingKeys = [
    ...new Set(
      [
        ...orgHdr.matchAll(
          /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*|credit[^"]*)"/gi,
        ),
      ].map((m) => m[1]!),
    ),
  ].slice(0, 60);

  // FSBAPF agency list
  const agency = await page.evaluate(async () => {
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
    const shell = await fetch('/web/base/FSBAPF?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSBAPF',
        USER_FUNCTION_NAME: 'FSBAPF',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
    const shellBytes = (await shell.text()).length;
    const lst = await fetch('/web/base/FSBAPF.LST', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSBAPF',
        USER_FUNCTION_NAME: 'FSBAPF',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'FSBAPF',
      }).toString(),
    });
    const lstText = await lst.text();
    let rowCount = 0;
    let gridKeys: string[] = [];
    let envelopeRecognized = false;
    try {
      const dataMatch = lstText.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (dataMatch?.[1]) {
        const rows = JSON.parse(dataMatch[1]) as unknown[];
        if (Array.isArray(rows)) {
          rowCount = rows.length;
          envelopeRecognized = true;
          if (rows[0] && typeof rows[0] === 'object') {
            gridKeys = Object.keys(rows[0] as object).slice(0, 80);
          }
        }
      }
    } catch {
      /* ignore */
    }
    return {
      shellBytes,
      lstBytes: lstText.length,
      lstSha256: null as null,
      rowCount,
      gridKeys,
      envelopeRecognized,
      lstText,
    };
  });

  const agencySha = sha256(agency.lstText);
  const compareDeepen = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_company_account_read',
    surface: 'FSOGPF+FSBAPF',
    capturedAt: new Date().toISOString(),
    orgHdrBytes: orgHdr.length,
    orgHdrSha256: sha256(orgHdr),
    hdrBillingKeys,
    tabTokens,
    tabProbes,
    agency: {
      shellBytes: agency.shellBytes,
      lstBytes: agency.lstBytes,
      lstSha256: agencySha,
      rowCount: agency.rowCount,
      gridKeys: agency.gridKeys,
      envelopeRecognized: agency.envelopeRecognized,
    },
    dodBillingTrioFromHdrTabs: {
      billingMode: [...hdrBillingKeys, ...Object.values(tabProbes).flatMap((t) => t.keyHits)].some(
        (k) => /billingmode|billmode/i.test(k),
      ),
      paymentTermClass: [
        ...hdrBillingKeys,
        ...Object.values(tabProbes).flatMap((t) => t.keyHits),
      ].some((k) => /paymentterm|payterm/i.test(k)),
      contractStatus: [
        ...hdrBillingKeys,
        ...Object.values(tabProbes).flatMap((t) => t.keyHits),
      ].some((k) => /contractstatus|contract/i.test(k)),
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/deepen.v1.json`,
    `${JSON.stringify(compareDeepen, null, 2)}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      orgHdrBytes: orgHdr.length,
      hdrBillingKeys,
      tabTokens,
      tabProbesSummary: Object.fromEntries(
        Object.entries(tabProbes).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/keys=${v.keyHits.length}`,
        ]),
      ),
      realTabs: Object.entries(tabProbes)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000)
        .map(([k, v]) => ({ tab: k, bytes: v.bytes, keyHits: v.keyHits })),
      agency: {
        shellBytes: agency.shellBytes,
        lstBytes: agency.lstBytes,
        rowCount: agency.rowCount,
        envelopeRecognized: agency.envelopeRecognized,
        gridKeys: agency.gridKeys,
        lstSha256: agencySha,
      },
      dodBillingTrioFromHdrTabs: compareDeepen.dodBillingTrioFromHdrTabs,
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) +
      '\n',
  );
  process.exit(1);
});
