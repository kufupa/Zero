/**
 * Deep-inspect OSORGP shell + Group Sales hover flyout labels/XHR.
 * Structure only. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
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
  const outPath =
    process.env.HMS_A78_DEEP_OUT ?? '/tmp/a78-deep-inspect.sanitized.v1.json';

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
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const xhr: { path: string; postKeys: string[] }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,24})/i.exec(req.url());
    if (!m) return;
    const body = req.postData() ?? '';
    const keys = [...body.matchAll(/([A-Z_]{3,40})=/g)].map((x) => x[1]!);
    xhr.push({
      path: m[1]!.toUpperCase(),
      postKeys: [...new Set(keys)].slice(0, 40),
    });
  });

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
      page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    await page.waitForTimeout(4_000);

    // OSORGP shell structure
    const osorgp = await page.evaluate(async () => {
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
      const shell = await fetch('/web/base/OSORGP?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSORGP',
          USER_FUNCTION_NAME: 'OSORGP',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      const text = await shell.text();
      const inputNames = [
        ...new Set(
          [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
        ),
      ].slice(0, 80);
      const tabs = [
        ...new Set(
          [
            ...text.matchAll(/CURRENT_TAB_NAME["'\s:=]+([A-Z0-9_]{1,16})/gi),
            ...text.matchAll(/tabName["'\s:=]+["']([A-Z0-9_]{1,16})["']/gi),
            ...text.matchAll(/\b(LST|HDR|DAT|RVW|LIST|DTL|DET|SUM)\b/g),
          ].map((m) => m[1]!.toUpperCase()),
        ),
      ];
      const fns = [
        ...new Set(
          [...text.matchAll(/\b([A-Z]{2}[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
        ),
      ]
        .filter((f) => !/^(HTTP|POST|HTML|TRUE|FALSE|NULL|GRID|DATA)$/.test(f))
        .slice(0, 80);
      const pathHints = [
        ...new Set(
          [...text.matchAll(/\/web\/base\/([A-Z][A-Z0-9.]{2,20})/g)].map(
            (m) => m[1]!,
          ),
        ),
      ];
      // Probe tab variants after shell open (same session, no re-warm)
      const tabProbes: Record<string, { status: number; bytes: number }> = {};
      for (const tab of [
        'LST',
        'HDR',
        'DAT',
        'RVW',
        'LIST',
        'DTL',
        'DET',
        'SUM',
        'ORG',
        'PROF',
        '',
      ]) {
        const url = tab ? `/web/base/OSORGP.${tab}` : '/web/base/OSORGP.LST';
        const body: Record<string, string> = {
          SYSTEM_FUNCTION_NAME: 'OSORGP',
          USER_FUNCTION_NAME: 'OSORGP',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: tab || 'LST',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'OSORGP',
        };
        try {
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body).toString(),
          });
          tabProbes[`${url}|${tab || 'LST'}`] = {
            status: r.status,
            bytes: (await r.text()).length,
          };
        } catch {
          tabProbes[`${url}|${tab || 'LST'}`] = { status: 0, bytes: 0 };
        }
      }
      // Also try without DATA_ONLY / different GRID
      for (const grid of ['OSORGP', 'OSORGP_LST', 'organization', 'ORGPROF']) {
        const r = await fetch('/web/base/OSORGP.LST', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSORGP',
            USER_FUNCTION_NAME: 'OSORGP',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: 'LST',
            GRID_NAME: grid,
          }).toString(),
        }).catch(() => null);
        if (r) {
          tabProbes[`OSORGP.LST|grid=${grid}|noDataOnly`] = {
            status: r.status,
            bytes: (await r.text()).length,
          };
        }
      }
      return {
        shellStatus: shell.status,
        shellBytes: text.length,
        inputNames,
        tabs,
        fns,
        pathHints,
        tabProbes,
        hasGrid: /GRID/i.test(text),
        // structure snippet scrubbed
        snippet: text
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
          .replace(/\d{6,}/g, '[n]')
          .slice(0, 1200),
      };
    });

    // Harvest tokens from GSGRPB.HDR for linked event/org actions
    const gsLinks = await page.evaluate(async () => {
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
      await fetch('/web/base/GSGRPB?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      const hdr = await fetch('/web/base/GSGRPB.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      });
      const text = await hdr.text();
      const eventCtx = [
        ...text.matchAll(
          /.{0,40}(?:event|organiz|agency|company|beo|meeting).{0,40}/gi,
        ),
      ]
        .map((m) =>
          m[0]
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
            .replace(/\d{6,}/g, '[n]')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .slice(0, 40);
      const actionFns = [
        ...new Set(
          [
            ...text.matchAll(
              /"(?:userFunction|systemFunction|functionName|actionFunction)"\s*:\s*"([A-Z0-9]{3,12})"/gi,
            ),
          ].map((m) => m[1]!.toUpperCase()),
        ),
      ];
      return {
        hdrBytes: text.length,
        actionFns,
        eventCtx,
      };
    });

    // UI hover flyout for Group Sales / Profiles
    const uiXhrStart = xhr.length;
    async function hoverClick(label: string): Promise<string[]> {
      const loc = page.getByText(label, { exact: true }).first();
      const vis = await loc.isVisible().catch(() => false);
      if (!vis) return [`miss:${label}`];
      const box = await loc.boundingBox().catch(() => null);
      await loc.hover({ force: true }).catch(() => undefined);
      await page.waitForTimeout(2_500);
      // also mouse move slightly below to catch flyout
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height + 20);
        await page.waitForTimeout(1_200);
      }
      const labels = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '.x-menu-item-text, .x-menu-list-item, .x-tree-node-text, .x-btn-inner, [class*="menu"] span, [class*="Menu"] span',
          ),
        ];
        return [
          ...new Set(
            nodes
              .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
              .filter((t) => t.length > 1 && t.length < 80),
          ),
        ].slice(0, 120);
      });
      await loc.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      return [`hit:${label}`, ...labels.map((l) => `lbl:${l}`)];
    }

    const groupUi = await hoverClick('Group Sales');
    const profilesUi = await hoverClick('Profiles');
    // Try Rate and Sales too — sometimes Events live there
    const rateUi = await hoverClick('Rate and Sales');
    const frontUi = await hoverClick('Front Desk');

    const out = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      valuesCaptured: false,
      osorgp,
      gsLinks,
      groupUi: groupUi.slice(0, 80),
      profilesUi: profilesUi.slice(0, 80),
      rateUi: rateUi.slice(0, 80),
      frontUi: frontUi.slice(0, 40),
      xhrUi: xhr.slice(uiXhrStart).map((x) => x.path),
      xhrUiDetail: xhr.slice(uiXhrStart).slice(0, 40),
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        osorgp: {
          shellBytes: osorgp.shellBytes,
          tabs: osorgp.tabs,
          fns: osorgp.fns,
          pathHints: osorgp.pathHints,
          inputNames: osorgp.inputNames.slice(0, 40),
          tabProbes: osorgp.tabProbes,
          snippet: osorgp.snippet.slice(0, 600),
        },
        gsActionFns: gsLinks.actionFns,
        gsEventCtx: gsLinks.eventCtx.slice(0, 20),
        groupUi: groupUi.slice(0, 50),
        profilesUi: profilesUi.slice(0, 50),
        rateUi: rateUi.slice(0, 30),
        xhrUi: [...new Set(xhr.slice(uiXhrStart).map((x) => x.path))],
      }) + '\n',
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) +
      '\n',
  );
  process.exit(1);
});
