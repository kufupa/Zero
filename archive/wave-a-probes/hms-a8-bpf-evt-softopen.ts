/**
 * Soft-open FSOGPF.BPF (Billing Profiles) + FSOGPF.EVT (Events) after Run/LST.
 * Capture keys/counts only. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A8_BPF_DIR ??
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

  // Inline evaluate — no nested helpers (tsx __name)
  const lstText = await page.evaluate(async () => {
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
    return await lst.text();
  });

  let orgId = '';
  let rowId = '';
  let profileId = '';
  try {
    const dataMatch = lstText.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (dataMatch?.[1]) {
      const rows = JSON.parse(dataMatch[1]) as Record<string, unknown>[];
      const row =
        rows.find((r) => {
          const f = r.billingprofilesflag;
          return f === true || f === '1' || f === 1 || f === 'Y' || f === 'true';
        }) ?? rows[0];
      if (row) {
        orgId = row.organizationid != null ? String(row.organizationid) : '';
        rowId = row.id != null ? String(row.id) : '';
        profileId = row.profileid != null ? String(row.profileid) : '';
      }
    }
  } catch {
    /* ignore */
  }

  // Stash ids in page for BPF/EVT posts
  await page.evaluate(
    ({ orgId, rowId, profileId }) => {
      (window as unknown as { __a8ids: Record<string, string> }).__a8ids = {
        orgId,
        rowId,
        profileId,
      };
    },
    { orgId: orgId ? 'yes' : '', rowId: rowId ? 'yes' : '', profileId: profileId ? 'yes' : '' },
  );
  // Keep real ids only in browser
  await page.evaluate(
    ({ orgId, rowId, profileId }) => {
      (window as unknown as { __a8ids: Record<string, string> }).__a8ids = {
        orgId,
        rowId,
        profileId,
      };
    },
    { orgId, rowId, profileId },
  );

  const bpfText = await page.evaluate(async () => {
    const ids = (window as unknown as { __a8ids: Record<string, string> }).__a8ids;
    const body: Record<string, string> = {
      SYSTEM_FUNCTION_NAME: 'FSOGPF',
      USER_FUNCTION_NAME: 'FSOGPF',
      CURRENT_TAB_NAME: 'BPF',
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      GRID_NAME: 'FSOGPF',
    };
    if (ids.rowId) {
      body.id = ids.rowId;
      body.SELECTED_ID = ids.rowId;
    }
    if (ids.orgId) body.organizationid = ids.orgId;
    if (ids.profileId) body.profileid = ids.profileId;
    const r = await fetch('/web/base/FSOGPF.BPF', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return await r.text();
  });

  const evtText = await page.evaluate(async () => {
    const ids = (window as unknown as { __a8ids: Record<string, string> }).__a8ids;
    const body: Record<string, string> = {
      SYSTEM_FUNCTION_NAME: 'FSOGPF',
      USER_FUNCTION_NAME: 'FSOGPF',
      CURRENT_TAB_NAME: 'EVT',
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      GRID_NAME: 'FSOGPF',
    };
    if (ids.rowId) {
      body.id = ids.rowId;
      body.SELECTED_ID = ids.rowId;
    }
    if (ids.orgId) body.organizationid = ids.orgId;
    if (ids.profileId) body.profileid = ids.profileId;
    const r = await fetch('/web/base/FSOGPF.EVT', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return await r.text();
  });

  // Also try GRID_NAME variants for BPF/EVT stores
  const bpfAlt = await page.evaluate(async () => {
    const ids = (window as unknown as { __a8ids: Record<string, string> }).__a8ids;
    const grids = ['FSOGPF_BPF', 'fsogpf_bpf', 'BPF', 'FSOGPF'];
    const out: Record<string, { status: number; bytes: number }> = {};
    for (const g of grids) {
      const body: Record<string, string> = {
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        CURRENT_TAB_NAME: 'BPF',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: g,
      };
      if (ids.rowId) body.id = ids.rowId;
      if (ids.orgId) body.organizationid = ids.orgId;
      const r = await fetch('/web/base/FSOGPF.BPF', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      out[g] = { status: r.status, bytes: (await r.text()).length };
    }
    return out;
  });

  function parseGrid(text: string): {
    rowCount: number;
    keys: string[];
    envelope: boolean;
  } {
    try {
      const dataMatch = text.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (dataMatch?.[1]) {
        const rows = JSON.parse(dataMatch[1]) as unknown[];
        if (Array.isArray(rows)) {
          const keys =
            rows[0] && typeof rows[0] === 'object'
              ? Object.keys(rows[0] as object).slice(0, 80)
              : [];
          return { rowCount: rows.length, keys, envelope: true };
        }
      }
    } catch {
      /* ignore */
    }
    const keyHits = [
      ...new Set(
        [
          ...text.matchAll(
            /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*|event[^"]*|status[^"]*|deposit[^"]*)"/gi,
          ),
        ].map((m) => m[1]!),
      ),
    ].slice(0, 60);
    return { rowCount: 0, keys: keyHits, envelope: /GRID|"DATA"/i.test(text) };
  }

  const bpf = parseGrid(bpfText);
  const evt = parseGrid(evtText);

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_company_account_read',
    surface: 'FSOGPF.BPF',
    capturedAt: new Date().toISOString(),
    unlock:
      'UI Run→select row harvested CURRENT_TAB_NAME=BPF path FSOGPF.BPF; soft-open after FSOGPF+LST',
    bpfBytes: bpfText.length,
    bpfSha256: sha256(bpfText),
    bpfStub813: bpfText.length === 813,
    bpf,
    evtBytes: evtText.length,
    evtSha256: sha256(evtText),
    evt,
    bpfAlt,
    idsPresent: {
      orgId: Boolean(orgId),
      rowId: Boolean(rowId),
      profileId: Boolean(profileId),
    },
    dodBillingTrio: {
      billingMode: bpf.keys.some((k) => /billingmode|billmode/i.test(k)),
      paymentTermClass: bpf.keys.some((k) =>
        /paymentterm|payterm|paymentterms/i.test(k),
      ),
      contractStatus: bpf.keys.some((k) => /contractstatus|contract/i.test(k)),
    },
    allRequiredPass:
      bpfText.length > 2000 &&
      bpfText.length !== 813 &&
      (bpf.rowCount > 0 || bpf.keys.length > 0),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/bpf-evt.compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      bpfBytes: bpfText.length,
      evtBytes: evtText.length,
      bpf,
      evt,
      bpfAlt,
      dodBillingTrio: compare.dodBillingTrio,
      allRequiredPass: compare.allRequiredPass,
      bpfSha256: compare.bpfSha256,
      evtSha256: compare.evtSha256,
      idsPresent: compare.idsPresent,
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
