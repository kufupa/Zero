/**
 * Phase-2 communications discovery: PSSNEL envelope keys + tax invoice fn hunt.
 * Masked structure only — never row values / addresses / subjects / filenames.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function structureOnly(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bytes: text.length,
    hasPageData: /pageData/i.test(text),
    hasGridResult: /GRIDRESULT/i.test(text),
    hasSuccess: /"success"\s*:/i.test(text),
    functionEchoes: [...text.matchAll(/\b((?:PS|OS)[A-Z0-9]{3,8})\b/g)]
      .map((m) => m[1]!)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 20),
    fieldNames: [...text.matchAll(/name="([a-zA-Z0-9_]{2,48})"/g)]
      .map((m) => m[1]!)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 80),
    inputCount: (text.match(/<input\b/gi) || []).length,
    gridKeys: [] as string[],
    topKeys: [] as string[],
  };
  // Try extract pageData / GRIDRESULT keys without values.
  try {
    const m = text.match(/pageData\s*[:=]\s*(\{[\s\S]*\})\s*;?\s*<\/script>/i);
    const jsonish = m?.[1];
    if (jsonish) {
      // best-effort: replace single quotes carefully not needed; try JSON.parse soft
    }
  } catch {
    /* ignore */
  }
  const keyHits = [
    ...text.matchAll(/"(confirmationnumber|account|accountname|subject|emailaddress|attachment|userid|reportcode|reportparameterlist|error|emaildate|emailtime|emailtype|invoice|status|property|folio|generatedat|invoicenumber)"\s*:/gi),
  ].map((m) => m[1]!.toLowerCase());
  out.gridKeys = [...new Set(keyHits)].slice(0, 40);
  const top = [...text.matchAll(/"([a-zA-Z][a-zA-Z0-9_]{1,40})"\s*:/g)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i);
  out.topKeys = top.slice(0, 60);
  return out;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
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
      /(save|delete|settle|refund|print|export|generate|resend|finalize|void)/i.test(
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

    // Open PSSNEL shell
    const openHtml = await page.evaluate(async () => {
      const body = new URLSearchParams({
        USER_FUNCTION_NAME: 'PSSNEL',
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      const r = await fetch('/web/base/PSSNEL', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'same-origin',
      });
      return { status: r.status, text: await r.text() };
    });

    // Follow-up HDR / search abort-first signatures (keys only)
    const followUps = ['PSSNEL.HDR', 'PSSNEL.search', 'PSSNEL.HDR.search'];
    const followResults: Array<Record<string, unknown>> = [];
    for (const path of followUps) {
      const r = await page.evaluate(async (p) => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'PSSNEL',
          USER_FUNCTION_NAME: 'PSSNEL',
          CURRENT_TAB_NAME: 'HDR',
          ONLY_DATA_REQUIRED: 'true',
          pagemode: 'display',
        });
        const resp = await fetch(`/web/base/${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'same-origin',
        });
        const text = await resp.text();
        return { status: resp.status, text };
      }, path);
      followResults.push({
        path: `/web/base/${path}`,
        status: r.status,
        structure: structureOnly(r.text),
      });
    }

    // Tax invoice function hunt — broader codes
    const taxCandidates = [
      'OSTXI',
      'PSTXI',
      'OSTAX',
      'OSINV',
      'OSTIN',
      'OSTIV',
      'ARINV',
      'ARINVC',
      'OSTAXINV',
      'PSTAX',
      'OSFTXI',
      'OSPTXI',
      'OSARINV',
      'PSSNEL', // control
      'OSRESS', // control known-good
      'OSRRAV', // control known-good
    ];
    const taxOpen: Array<Record<string, unknown>> = [];
    for (const fn of taxCandidates) {
      const r = await page.evaluate(async (functionName) => {
        const body = new URLSearchParams({
          USER_FUNCTION_NAME: functionName,
          SYSTEM_FUNCTION_NAME: functionName,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        });
        const resp = await fetch(`/web/base/${functionName}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'same-origin',
        });
        const text = await resp.text();
        return { status: resp.status, bytes: text.length, text };
      }, fn);
      taxOpen.push({
        fn,
        status: r.status,
        bytes: r.bytes,
        okish: r.status === 200 && r.bytes > 500,
        structure: structureOnly(r.text),
      });
    }

    // Menu module expand: click tree expander near Front Desk
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.x-tree-node')];
      for (const n of nodes) {
        const text = (n.textContent || '').trim();
        if (/^Front Desk/i.test(text) || text.includes('Front Desk')) {
          const ec = n.querySelector(
            '.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus, img',
          ) as HTMLElement | null;
          ec?.click();
        }
      }
    });
    await page.waitForTimeout(2_000);
    const afterExpand = await page.evaluate(() => {
      const texts = [
        ...document.querySelectorAll('.x-tree-node-text, span, a'),
      ]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80);
      return [...new Set(texts)]
        .filter((t) =>
          /email|invoice|tax|folio|guest|sent|deposit|ledger|availability|room/i.test(
            t,
          ),
        )
        .slice(0, 80);
    });

    const payload = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      pssnelOpen: {
        status: openHtml.status,
        structure: structureOnly(openHtml.text),
      },
      followResults,
      taxOpen: taxOpen.map(({ fn, status, bytes, okish, structure }) => ({
        fn,
        status,
        bytes,
        okish,
        structure,
      })),
      afterExpand,
    };
    const out =
      process.env.HMS_COMMS_DISCOVERY_OUT ?? '/tmp/hms-comms-discovery-phase2.json';
    await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          out,
          pssnelBytes: openHtml.text.length,
          pssnelKeys: (payload.pssnelOpen.structure as { topKeys?: string[] })
            .topKeys,
          follow: followResults.map((f) => ({
            path: f.path,
            status: f.status,
            bytes: (f.structure as { bytes: number }).bytes,
            topKeys: (f.structure as { topKeys?: string[] }).topKeys?.slice(0, 20),
            gridKeys: (f.structure as { gridKeys?: string[] }).gridKeys,
          })),
          taxOk: taxOpen.filter((t) => t.okish).map((t) => t.fn),
          taxStatus: taxOpen.map((t) => ({
            fn: t.fn,
            status: t.status,
            bytes: t.bytes,
          })),
          afterExpand,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
