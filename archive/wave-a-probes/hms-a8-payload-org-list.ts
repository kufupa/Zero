/**
 * A8 payload: BSSTRT → FSOGPF open → FSOGPF.LST (click-harvested).
 * Also probe Booking Agency siblings FS*PF. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_PAYLOAD_DIR ??
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

  // Inline evaluate only — tsx injects __name into nested helpers and breaks Playwright.
  const shell = await page.evaluate(async () => {
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
    const r = await fetch('/web/base/FSOGPF?FUNCTION_CLASS=WEBL', {
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
    return { status: r.status, bytes: (await r.text()).length };
  });

  const hdrText = await page.evaluate(async () => {
    const r = await fetch('/web/base/FSOGPF.HDR', {
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
    return await r.text();
  });

  const lstText = await page.evaluate(async () => {
    const r = await fetch('/web/base/FSOGPF.LST', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'FSOGPF',
      }).toString(),
    });
    return await r.text();
  });

  let gridKeys: string[] = [];
  let rowCount = 0;
  let envelopeRecognized = false;
  let sampleKeyHits: string[] = [];
  try {
    const dataMatch = lstText.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    const gridMatch = lstText.match(/GRID[\s\S]{0,200}"DATA"\s*:\s*(\[[\s\S]*?\])/);
    const arrText = dataMatch?.[1] ?? gridMatch?.[1];
    if (arrText) {
      const rows = JSON.parse(arrText) as unknown[];
      if (Array.isArray(rows)) {
        rowCount = rows.length;
        envelopeRecognized = true;
        const first = rows[0];
        if (first && typeof first === 'object') {
          gridKeys = Object.keys(first as object).slice(0, 80);
        }
      }
    }
    sampleKeyHits = [
      ...new Set(
        [
          ...lstText.matchAll(
            /"(organization[^"]*|billing[^"]*|payment[^"]*|contract[^"]*|account[^"]*|status[^"]*|name[^"]*)"/gi,
          ),
        ].map((m) => m[1]!),
      ),
    ].slice(0, 60);
  } catch {
    /* parse soft-fail */
  }

  const agencyGuesses = [
    'FSAGPF',
    'FSBKPF',
    'FSTAPF',
    'FSBAPF',
    'FSBKAG',
    'FSAGNC',
    'BKAGEN',
    'FSBKAF',
    'FSTRAF',
  ];
  const agencyOpens: Record<string, { status: number; bytes: number }> = {};
  for (const fn of agencyGuesses) {
    agencyOpens[fn] = await page.evaluate(async (functionName) => {
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
      const r = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      return { status: r.status, bytes: (await r.text()).length };
    }, fn);
  }

  const eventGuesses = [
    'FSEVPF',
    'FSEVRS',
    'FSEVNT',
    'FSEVRE',
    'FSEVMA',
    'GSEVRS',
    'GSEVNT',
    'FSEVAV',
    'GSGRPA',
    'GSGRAV',
    'GSGAVL',
    'OSGAVL',
    'FSGAVL',
  ];
  const eventOpens: Record<string, { status: number; bytes: number }> = {};
  for (const fn of eventGuesses) {
    eventOpens[fn] = await page.evaluate(async (functionName) => {
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
      const r = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      return { status: r.status, bytes: (await r.text()).length };
    }, fn);
  }

  const result = {
    shell,
    hdrBytes: hdrText.length,
    lstBytes: lstText.length,
    lstStub813: lstText.length === 813,
    envelopeRecognized,
    rowCount,
    gridKeys,
    sampleKeyHits,
    agencyOpens,
    eventOpens,
    lstText,
    hdrText,
  };

  const lstSha = sha256(result.lstText);
  const hdrSha = sha256(result.hdrText);

  // Billing-relevant keys present?
  const billingKeys = result.gridKeys.filter((k) =>
    /bill|pay|contract|term|mode|account|ar|credit/i.test(k),
  );
  const identityKeys = result.gridKeys.filter((k) =>
    /org|name|id|status|code|ref/i.test(k),
  );

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_company_account_read',
    surface: 'FSOGPF.LST',
    capturedAt: new Date().toISOString(),
    unlock: 'BSSTRT → FSOGPF open → FSOGPF.LST DATA_ONLY (click-harvested from Profiles > Organization Profiles)',
    shellBytes: result.shell.bytes,
    hdrBytes: result.hdrBytes,
    lstBytes: result.lstBytes,
    lstSha256: lstSha,
    hdrSha256: hdrSha,
    envelopeRecognized: result.envelopeRecognized,
    rowCount: result.rowCount,
    gridKeys: result.gridKeys,
    identityKeys,
    billingKeys,
    sampleKeyHits: result.sampleKeyHits,
    agencyOpens: result.agencyOpens,
    eventOpens: Object.fromEntries(
      Object.entries(result.eventOpens).filter(([, v]) => v.bytes > 500 || v.status !== 400),
    ),
    eventOpensAll: result.eventOpens,
    // DoD trio: billingMode / paymentTermClass / contractStatus — mark presence only
    dodBillingTrio: {
      billingMode: result.gridKeys.some((k) => /billingmode|billmode/i.test(k)),
      paymentTermClass: result.gridKeys.some((k) => /paymentterm|payterm/i.test(k)),
      contractStatus: result.gridKeys.some((k) => /contractstatus|contract/i.test(k)),
    },
    allRequiredPass:
      result.envelopeRecognized &&
      result.rowCount > 0 &&
      result.lstBytes > 2000 &&
      !result.lstStub813,
    note: 'Organization Profiles list surface. Billing trio may need detail/HDR drill — list keys recorded.',
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );
  // structure-only sidecar (no row values)
  await writeFile(
    `${outDir}/surface.sanitized.v1.json`,
    `${JSON.stringify(
      {
        gridKeys: result.gridKeys,
        rowCount: result.rowCount,
        lstSha256: lstSha,
        hdrSha256: hdrSha,
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
      shell: result.shell,
      hdrBytes: result.hdrBytes,
      lstBytes: result.lstBytes,
      envelopeRecognized: result.envelopeRecognized,
      rowCount: result.rowCount,
      gridKeys: result.gridKeys,
      billingKeys,
      dodBillingTrio: compare.dodBillingTrio,
      allRequiredPass: compare.allRequiredPass,
      agencyReal: Object.entries(result.agencyOpens)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000)
        .map(([fn, v]) => ({ fn, bytes: v.bytes })),
      eventReal: Object.entries(result.eventOpens)
        .filter(([, v]) => v.status === 200 && v.bytes > 2000)
        .map(([fn, v]) => ({ fn, bytes: v.bytes })),
      lstSha256: lstSha,
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
