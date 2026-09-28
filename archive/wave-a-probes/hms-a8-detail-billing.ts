/**
 * A8: open first FSOGPF row detail + harvest billing tab XHR/keys.
 * Opaque ids stay in-browser only. HMS_DISCOVERY_ALLOW_LIVE=1.
 * No nested helpers inside page.evaluate (tsx __name).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outDir =
    process.env.HMS_A8_DETAIL_DIR ??
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

  // Step 1: get row0 key presence + opaque ids stay in page via evaluate returning only hashes/flags
  const rowMeta = await page.evaluate(async () => {
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
    let row0 = null;
    try {
      const dataMatch = lstText.match(/"DATA"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (dataMatch && dataMatch[1]) {
        const rows = JSON.parse(dataMatch[1]);
        row0 =
          rows.find((r) => {
            const f = r.billingprofilesflag;
            return f === true || f === '1' || f === 1 || f === 'Y' || f === 'true';
          }) ||
          rows[0] ||
          null;
      }
    } catch (e) {
      row0 = null;
    }
    if (!row0) {
      return { ok: false, rowKeys: [], id: '', organizationid: '', profileid: '' };
    }
    // Stash opaque ids on window for subsequent evaluates (not returned)
    (window as unknown as { __a8: Record<string, string> }).__a8 = {
      id: row0.id != null ? String(row0.id) : '',
      organizationid:
        row0.organizationid != null ? String(row0.organizationid) : '',
      profileid: row0.profileid != null ? String(row0.profileid) : '',
    };
    return {
      ok: true,
      rowKeys: Object.keys(row0),
      id: row0.id != null ? 'yes' : '',
      organizationid: row0.organizationid != null ? 'yes' : '',
      profileid: row0.profileid != null ? 'yes' : '',
    };
  });

  if (!rowMeta.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'no_row' }) + '\n');
    await browser.close();
    return;
  }

  // Step 2: probe detail opens using stashed ids
  const probes = await page.evaluate(async () => {
    const a8 = (window as unknown as { __a8: Record<string, string> }).__a8 || {
      id: '',
      organizationid: '',
      profileid: '',
    };
    const out: Record<
      string,
      { status: number; bytes: number; keyHits: string[]; stub813: boolean }
    > = {};
    const trials = [
      {
        label: 'HDR|id',
        url: '/web/base/FSOGPF.HDR',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: 'HDR',
          id: a8.id,
          SELECTED_ID: a8.id,
          recordid: a8.id,
        },
      },
      {
        label: 'find|id',
        url: '/web/base/FSOGPF.find',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          id: a8.id,
          SELECTED_ID: a8.id,
        },
      },
      {
        label: 'HDR|organizationid',
        url: '/web/base/FSOGPF.HDR',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: 'HDR',
          organizationid: a8.organizationid,
          SELECTED_ID: a8.organizationid,
        },
      },
      {
        label: 'find|organizationid',
        url: '/web/base/FSOGPF.find',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          organizationid: a8.organizationid,
        },
      },
      {
        label: 'HDR|profileid',
        url: '/web/base/FSOGPF.HDR',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: 'HDR',
          profileid: a8.profileid,
          SELECTED_ID: a8.profileid,
        },
      },
      {
        label: 'find|profileid',
        url: '/web/base/FSOGPF.find',
        body: {
          SYSTEM_FUNCTION_NAME: 'FSOGPF',
          USER_FUNCTION_NAME: 'FSOGPF',
          FUNCTION_CLASS: 'WEBL',
          profileid: a8.profileid,
        },
      },
    ];
    for (const t of trials) {
      if (!Object.values(t.body).some((v) => v && v.length > 0 && v !== 'FSOGPF' && v !== 'WEBL' && v !== 'HDR')) {
        out[t.label] = { status: 0, bytes: 0, keyHits: [], stub813: false };
        continue;
      }
      try {
        const r = await fetch(t.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(t.body).toString(),
        });
        const text = await r.text();
        const keyHits = [
          ...new Set(
            [
              ...text.matchAll(
                /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*|credit[^"]*|paperwork[^"]*)"/gi,
              ),
            ].map((m) => m[1]),
          ),
        ].slice(0, 50);
        out[t.label] = {
          status: r.status,
          bytes: text.length,
          keyHits,
          stub813: text.length === 813,
        };
      } catch (e) {
        out[t.label] = { status: 0, bytes: 0, keyHits: [], stub813: false };
      }
    }

    // Billing tab probes after find attempts
    const tabs = ['BILL', 'BPRF', 'BPFL', 'BLPR', 'ATRF', 'NGRT', 'PAY', 'CONT', 'PROF'];
    for (const tab of tabs) {
      const body: Record<string, string> = {
        SYSTEM_FUNCTION_NAME: 'FSOGPF',
        USER_FUNCTION_NAME: 'FSOGPF',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: tab,
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'FSOGPF',
      };
      if (a8.id) {
        body.id = a8.id;
        body.SELECTED_ID = a8.id;
      }
      if (a8.organizationid) body.organizationid = a8.organizationid;
      if (a8.profileid) body.profileid = a8.profileid;
      try {
        const r = await fetch(`/web/base/FSOGPF.${tab}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body).toString(),
        });
        const text = await r.text();
        const keyHits = [
          ...new Set(
            [
              ...text.matchAll(
                /"(billing[^"]*|payment[^"]*|contract[^"]*|term[^"]*|mode[^"]*|araccount[^"]*|credit[^"]*|paperwork[^"]*)"/gi,
              ),
            ].map((m) => m[1]),
          ),
        ].slice(0, 50);
        out[`tab|${tab}`] = {
          status: r.status,
          bytes: text.length,
          keyHits,
          stub813: text.length === 813,
        };
      } catch (e) {
        out[`tab|${tab}`] = {
          status: 0,
          bytes: 0,
          keyHits: [],
          stub813: false,
        };
      }
    }
    return out;
  });

  const allKeyHits = [
    ...new Set(Object.values(probes).flatMap((p) => p.keyHits)),
  ].sort();
  const realProbes = Object.entries(probes)
    .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
    .map(([k, v]) => ({ label: k, bytes: v.bytes, keyHits: v.keyHits }));

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    rowMeta,
    probeSummary: Object.fromEntries(
      Object.entries(probes).map(([k, v]) => [
        k,
        `${v.status}/${v.bytes}${v.stub813 ? '/813' : ''}/keys=${v.keyHits.length}`,
      ]),
    ),
    realProbes,
    allKeyHits,
    dodBillingTrio: {
      billingMode: allKeyHits.some((k) => /billingmode|billmode/i.test(k)),
      paymentTermClass: allKeyHits.some((k) =>
        /paymentterm|payterm|paymentterms/i.test(k),
      ),
      contractStatus: allKeyHits.some((k) =>
        /contractstatus|contract/i.test(k),
      ),
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/detail-billing.v1.json`,
    `${JSON.stringify(out, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ ok: true, outDir, ...out }) + '\n');
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
