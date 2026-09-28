/**
 * Soft-open FSOGPF.BPF / FSOGPF.EVT with exact UI body
 * (CURRENT_TAB_NAME + organizationid/name/externalid — no DATA_ONLY).
 * HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_BPF2_DIR ??
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
    const lst = await fetch('/web/base/FSOGPF.LST', {
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
    const lstText = await lst.text();
    let row: Record<string, unknown> | null = null;
    try {
      const dataMatch = lstText.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (dataMatch && dataMatch[1]) {
        const rows = JSON.parse(dataMatch[1]);
        row =
          rows.find((r: Record<string, unknown>) => {
            const f = r.billingprofilesflag;
            return f === true || f === '1' || f === 1 || f === 'Y' || f === 'true';
          }) ||
          rows.find((r: Record<string, unknown>) => {
            const f = r.eventsflag;
            return f === true || f === '1' || f === 1 || f === 'Y' || f === 'true';
          }) ||
          rows[0] ||
          null;
      }
    } catch (e) {
      row = null;
    }
    if (!row) {
      return {
        ok: false,
        bpfText: '',
        evtText: '',
        flags: {},
      };
    }
    const organizationid =
      row.organizationid != null ? String(row.organizationid) : '';
    const organizationname =
      row.organizationname != null ? String(row.organizationname) : '';
    const externalid = row.externalid != null ? String(row.externalid) : '';
    const flags = {
      billingprofilesflag: row.billingprofilesflag ?? null,
      eventsflag: row.eventsflag ?? null,
      autotransferflag: row.autotransferflag ?? null,
      negotiatedratesflag: row.negotiatedratesflag ?? null,
    };

    const common = {
      SYSTEM_FUNCTION_NAME: 'FSOGPF',
      USER_FUNCTION_NAME: 'FSOGPF',
      organizationid,
      organizationname,
      externalid,
    };
    const bpf = await fetch('/web/base/FSOGPF.BPF', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...common,
        CURRENT_TAB_NAME: 'BPF',
      }).toString(),
    });
    const evt = await fetch('/web/base/FSOGPF.EVT', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...common,
        CURRENT_TAB_NAME: 'EVT',
      }).toString(),
    });
    // Also NGR negotiated + ATR auto transfer if same pattern
    const ngr = await fetch('/web/base/FSOGPF.NGR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...common,
        CURRENT_TAB_NAME: 'NGR',
      }).toString(),
    });
    const atr = await fetch('/web/base/FSOGPF.ATR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...common,
        CURRENT_TAB_NAME: 'ATR',
      }).toString(),
    });

    return {
      ok: true,
      bpfText: await bpf.text(),
      evtText: await evt.text(),
      ngrBytes: (await ngr.text()).length,
      atrBytes: (await atr.text()).length,
      ngrStatus: ngr.status,
      atrStatus: atr.status,
      flags,
      hasOrgId: Boolean(organizationid),
      hasOrgName: Boolean(organizationname),
    };
  });

  if (!result.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'no_row' }) + '\n');
    await browser.close();
    return;
  }

  function analyze(text: string) {
    const keyHits = [
      ...new Set(
        [
          ...text.matchAll(
            /"([a-z][a-z0-9_]{2,40})"/gi,
          ),
        ]
          .map((m) => m[1]!.toLowerCase())
          .filter((k) =>
            /bill|pay|contract|term|mode|ar|agent|card|account|settlement|event|deposit|status|folio|guarantee/i.test(
              k,
            ),
          ),
      ),
    ].sort();
    let rowCount = 0;
    let gridKeys: string[] = [];
    let envelope = false;
    try {
      const dataMatch = text.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (dataMatch?.[1]) {
        const rows = JSON.parse(dataMatch[1]) as unknown[];
        if (Array.isArray(rows)) {
          rowCount = rows.length;
          envelope = true;
          if (rows[0] && typeof rows[0] === 'object') {
            gridKeys = Object.keys(rows[0] as object).slice(0, 80);
          }
        }
      }
    } catch {
      /* ignore */
    }
    // pageData / values keys
    const valuesKeys = [
      ...new Set(
        [...text.matchAll(/"([a-z][a-z0-9_]{2,40})"\s*:/gi)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      ),
    ]
      .filter((k) =>
        /bill|pay|contract|term|mode|ar|agent|card|account|settlement|event|deposit|folio/i.test(
          k,
        ),
      )
      .slice(0, 80);
    return {
      bytes: text.length,
      stub813: text.length === 813,
      rowCount,
      gridKeys,
      envelope,
      keyHits,
      valuesKeys,
      head: text
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\d{6,}/g, '[n]')
        .slice(0, 300),
    };
  }

  const bpf = analyze(result.bpfText);
  const evt = analyze(result.evtText);

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_company_account_read',
    surface: 'FSOGPF.BPF',
    capturedAt: new Date().toISOString(),
    unlock:
      'UI body FSOGPF.BPF CURRENT_TAB_NAME=BPF + organizationid/name/externalid (no DATA_ONLY)',
    flags: result.flags,
    bpf: { ...bpf, sha256: sha256(result.bpfText) },
    evt: { ...evt, sha256: sha256(result.evtText) },
    ngrBytes: result.ngrBytes,
    atrBytes: result.atrBytes,
    dodBillingTrio: {
      billingMode: [...bpf.keyHits, ...bpf.valuesKeys, ...bpf.gridKeys].some(
        (k) => /billingmode|billmode/i.test(k),
      ),
      paymentTermClass: [
        ...bpf.keyHits,
        ...bpf.valuesKeys,
        ...bpf.gridKeys,
      ].some((k) => /paymentterm|payterm|paymentterms/i.test(k)),
      contractStatus: [...bpf.keyHits, ...bpf.valuesKeys, ...bpf.gridKeys].some(
        (k) => /contractstatus|contract/i.test(k),
      ),
    },
    allRequiredPass:
      bpf.bytes > 2000 &&
      !bpf.stub813 &&
      (bpf.rowCount > 0 ||
        bpf.gridKeys.length > 0 ||
        bpf.valuesKeys.length > 0 ||
        bpf.keyHits.length > 0),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/bpf-evt-exact.compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      flags: result.flags,
      bpf: {
        bytes: bpf.bytes,
        rowCount: bpf.rowCount,
        gridKeys: bpf.gridKeys,
        keyHits: bpf.keyHits,
        valuesKeys: bpf.valuesKeys,
        head: bpf.head,
        sha256: compare.bpf.sha256,
      },
      evt: {
        bytes: evt.bytes,
        rowCount: evt.rowCount,
        gridKeys: evt.gridKeys,
        keyHits: evt.keyHits,
        valuesKeys: evt.valuesKeys,
        head: evt.head,
        sha256: compare.evt.sha256,
      },
      ngrBytes: result.ngrBytes,
      atrBytes: result.atrBytes,
      dodBillingTrio: compare.dodBillingTrio,
      allRequiredPass: compare.allRequiredPass,
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
