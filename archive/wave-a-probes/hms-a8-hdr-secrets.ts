/**
 * List HMS-ish secret names (no values) + extract FSOGPF.HDR billing action tokens.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A8_HDR_SECRETS_OUT ?? '/tmp/a8-hdr-secrets.sanitized.v1.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });

  const listed: string[] = [];
  let listError: string | null = null;
  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListSecretsCommand({ MaxResults: 100, NextToken: token }),
      );
      for (const s of page.SecretList ?? []) {
        if (s.Name) listed.push(s.Name);
      }
      token = page.NextToken;
    } while (token);
  } catch (e) {
    listError =
      e instanceof Error
        ? e.name + ':' + e.message.replace(/arn:aws:[^\s]+/gi, '[arn]').slice(0, 120)
        : 'list_fail';
  }
  const hmsish = listed.filter((n) =>
    /hms|hospitality|infor|view.?only|centurion|receptionist|reservation|navai|nava.?ai/i.test(
      n,
    ),
  );

  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;
  // username presence only — never log password
  const currentUserPresent = Boolean(secret.username);

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

  const hdr = await page.evaluate(async () => {
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
    const text = await r.text();
    const billCtx = [
      ...text.matchAll(
        /.{0,50}(?:billing|payment|contract|negotiat|auto.?transfer|billmode|payterm).{0,50}/gi,
      ),
    ]
      .map((m) =>
        m[0]
          .replace(/\s+/g, ' ')
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
          .slice(0, 140),
      )
      .slice(0, 50);
    const quotedFns = [
      ...new Set(
        [...text.matchAll(/"([A-Z]{2}[A-Z0-9]{3,10})"/g)].map((m) => m[1]!),
      ),
    ].sort();
    // tab / screenflow fragments
    const screenflows = [
      ...text.matchAll(/screenflows?[^"]{0,20}"[^"]{0,200}"/gi),
    ]
      .map((m) => m[0].slice(0, 180))
      .slice(0, 20);
    const labels = [
      ...new Set(
        [...text.matchAll(/"label"\s*:\s*"([^"]{2,60})"/g)].map((m) => m[1]!),
      ),
    ]
      .filter((l) =>
        /bill|pay|contract|negotiat|transfer|profile|mode|term/i.test(l),
      )
      .slice(0, 40);
    return {
      bytes: text.length,
      billCtx,
      quotedFns,
      screenflows,
      labels,
    };
  });

  // Soft-open quoted fns that look billing-related
  const softTargets = hdr.quotedFns.filter((fn) =>
    /BILL|PAY|CONT|PROF|NGRT|ATRF|BLPR|BPFL|BPRF|ARAC|ACCT/i.test(fn),
  );
  const soft: Record<string, { status: number; bytes: number }> = {};
  for (const fn of softTargets.slice(0, 20)) {
    soft[fn] = await page.evaluate(async (functionName) => {
      for (const path of ['/web/base/BSSTRT']) {
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

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    valuesCaptured: false,
    secrets: {
      total: listed.length,
      hmsish,
      listError,
      currentArnTail: arn.split(':').pop() ?? null,
      currentUserPresent,
    },
    hdr,
    softTargets,
    soft,
    softReal: Object.entries(soft)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000)
      .map(([fn, v]) => ({ fn, bytes: v.bytes })),
  };
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      secrets: out.secrets,
      hdrBytes: hdr.bytes,
      labels: hdr.labels,
      quotedFns: hdr.quotedFns,
      billCtx: hdr.billCtx.slice(0, 25),
      softReal: out.softReal,
      soft,
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  const safe = msg
    .replace(/arn:aws:[^\s"]+/gi, '[arn]')
    .replace(/password[=:]\s*\S+/gi, 'password=[redacted]')
    .slice(0, 240);
  process.stderr.write(safe + '\n');
  process.exit(1);
});
