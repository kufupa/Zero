/**
 * Wave A6/A7/A8 soft menu probe: Group / Event / Company labels + open stubs.
 * Structure only — never body values. Requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type FetchProbe = {
  path: string;
  status: number;
  bytes: number;
  hasLoginFields: boolean;
  hasErrorMarker: boolean;
  inputNames: string[];
  titleMatch: string | null;
  functionTokens: string[];
};

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A678_PROBE_OUT ?? '/tmp/hms-a678-menu-probe.wavea.json';

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
      /(save|delete|duplicate|checkin|checkout|amend|cancel|settle|refund|send|print|export|submit)/i.test(
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
      .locator('input[name=userid], input[name=username], input[name=j_username]')
      .first()
      .fill(secret.username);
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/\/web\/base\/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    await page.waitForTimeout(3_000);

    const navProbe: string[] = [];
    for (const label of [
      'Group Sales',
      'Profiles',
      'Front Desk',
      'Events',
      'Group',
      'Company',
      'Accounts',
      'Allotment',
      'Banquet',
    ]) {
      const visible = await page
        .locator(`text=${label}`)
        .first()
        .isVisible()
        .catch(() => false);
      navProbe.push(`label:${label}:${visible ? 'visible' : 'absent'}`);
      if (visible) {
        await page
          .locator(`text=${label}`)
          .first()
          .click({ force: true, timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
    }

    const menuLabels = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, a, span',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((el) => (el.textContent ?? '').trim())
            .filter((t) => t.length > 2 && t.length < 64)
            .filter((t) =>
              /group|event|compan|account|block|allot|banquet|profile|front desk|guest/i.test(
                t,
              ),
            ),
        ),
      ].slice(0, 80);
    });

    async function probeOpen(fn: string): Promise<FetchProbe> {
      return page.evaluate(async (functionName) => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          FUNCTION_CLASS: 'WEBL',
          removescreenflows: 'yes',
        });
        try {
          const res = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const text = await res.text();
          const names = [
            ...new Set(
              [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
            ),
          ].slice(0, 60);
          return {
            path: `/web/base/${functionName}`,
            status: res.status,
            bytes: text.length,
            hasLoginFields:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
            hasErrorMarker:
              /not authorised|not authorized|access denied|permission|function not available|no authority/i.test(
                text,
              ),
            inputNames: names,
            titleMatch: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
            functionTokens: [
              ...new Set(
                [...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
              ),
            ].slice(0, 20),
          };
        } catch {
          return {
            path: `/web/base/${functionName}`,
            status: 0,
            bytes: 0,
            hasLoginFields: false,
            hasErrorMarker: false,
            inputNames: [],
            titleMatch: null,
            functionTokens: [],
          };
        }
      }, fn);
    }

    // Candidate function codes from prior catalogue / Infor naming.
    const opens: Record<string, FetchProbe> = {};
    for (const fn of [
      'PSSNEL',
      'OSGRP',
      'OSGBLK',
      'OSALLT',
      'OSEVT',
      'OSBEO',
      'OSACCT',
      'ARACCT',
      'OSCOMP',
    ]) {
      opens[fn] = await probeOpen(fn);
    }

    const payload = {
      schemaVersion: 1,
      surface: 'a678_menu_probe',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      valuesCaptured: false,
      navProbe,
      menuLabels,
      opens,
    };
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        menuLabelCount: menuLabels.length,
        openSummary: Object.fromEntries(
          Object.entries(opens).map(([k, v]) => [
            k,
            {
              status: v.status,
              bytes: v.bytes,
              login: v.hasLoginFields,
              err: v.hasErrorMarker,
              inputs: v.inputNames.length,
            },
          ]),
        ),
      }) + '\n',
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'probe_failed';
  const safe = /password|secret|cookie|arn:aws/i.test(msg)
    ? 'redacted_error'
    : msg.slice(0, 200);
  process.stderr.write(`${safe}\n`);
  process.exit(1);
});
