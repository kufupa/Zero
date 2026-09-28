/**
 * A7/A8 focused soft-open: fresh BSSTRT before EACH candidate.
 * Control GSGRPB first. Dump ALL open sizes. After Group Sales click,
 * harvest visible menu labels (no PII values). HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type OpenResult = {
  status: number;
  bytes: number;
  stub813: boolean;
  hasGrid: boolean;
  hasLogin: boolean;
  titleHint: string | null;
};

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A78_FOCUS_OUT ?? '/tmp/a78-focus-softopen.sanitized.v1.json';

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
    viewport: { width: 1440, height: 900 },
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
  const xhrPaths: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,24})/i.exec(req.url());
    if (m) xhrPaths.push(m[1]!.toUpperCase());
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

    // Inspect BSSTRT blob shape (structure only)
    const bsShape = await page.evaluate(async () => {
      const r = await fetch('/web/base/BSSTRT', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh: 'yes',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      });
      const text = await r.text();
      const keyHits = [
        'itemLabel',
        'userFunction',
        'systemFunction',
        'functionName',
        'MENU_MODULE',
        'screenflows',
        'menuitem',
        'menuItem',
        'GSGRPB',
        'Event',
        'Organization',
      ].map((k) => ({ k, n: (text.match(new RegExp(k, 'gi')) || []).length }));
      return { bytes: text.length, keyHits, head: text.slice(0, 400) };
    });

    async function warmThenOpen(fn: string, tab: '' | 'HDR' | 'LST'): Promise<OpenResult> {
      return page.evaluate(
        async ({ fn, tab }) => {
          for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
            await fetch(path, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                SYSTEM_FUNCTION_NAME: 'BSSTRT',
                USER_FUNCTION_NAME: 'BSSTRT',
                manurefresh: 'yes',
              }).toString(),
            }).catch(() => undefined);
          }
          const url =
            tab === ''
              ? `/web/base/${fn}?FUNCTION_CLASS=WEBL`
              : `/web/base/${fn}.${tab}`;
          const body: Record<string, string> = {
            SYSTEM_FUNCTION_NAME: fn,
            USER_FUNCTION_NAME: fn,
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          };
          if (tab) {
            body.CURRENT_TAB_NAME = tab;
            if (tab === 'LST') {
              body.COMPONENT_INFO_TYPE = 'DATA_ONLY';
              body.GRID_NAME = fn;
            }
          } else {
            body.CURRENT_TAB_NAME = '';
            body.MENU_MODULE_KEY = '0';
          }
          try {
            const r = await fetch(url, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams(body).toString(),
            });
            const text = await r.text();
            const titleHint =
              /"screenTitle"\s*:\s*"([^"]+)"/i.exec(text)?.[1] ??
              /<(?:title)[^>]*>([^<]{3,80})</i.exec(text)?.[1]?.trim() ??
              null;
            return {
              status: r.status,
              bytes: text.length,
              stub813: text.length === 813,
              hasGrid: /GRID|"DATA"\s*:/i.test(text),
              hasLogin: /j_password|userid|Sign in/i.test(text),
              titleHint,
            };
          } catch {
            return {
              status: 0,
              bytes: 0,
              stub813: false,
              hasGrid: false,
              hasLogin: false,
              titleHint: null,
            };
          }
        },
        { fn, tab },
      );
    }

    const candidates = [
      'GSGRPB', // control
      'SCMEET',
      'BKAGEN',
      'OSORGP',
      'PRORGP',
      'PSORGP',
      'GSEVNT',
      'GSEVRS',
      'GSEVRE',
      'GSEVMA',
      'OSEVNT',
      'OSEVRS',
      'PSEVNT',
      'SCEVNT',
      'SCEVRS',
      'SCEVRE',
      'EVGRES',
      'EVRES',
      'EVMAST',
      'OSEVT',
      'OSBEO',
      'GSBEO',
      'SCBEO',
      'OSACCT',
      'OSACBL',
      'PRCOMP',
      'OSCOMP',
      'OSPROF',
      'PRPROF',
      'CSPROF',
      'CSORGP',
      'ARORGP',
      'GSORGP',
      'SCORGP',
      'GSEVTP',
      'GSEVRM',
      'GSEVAV',
      'OSEVAV',
      'SCEVAV',
    ];

    const opens: Record<string, OpenResult> = {};
    for (const fn of candidates) {
      opens[fn] = await warmThenOpen(fn, '');
      if (opens[fn]!.status === 200 && opens[fn]!.bytes > 1500 && !opens[fn]!.stub813) {
        opens[`${fn}.HDR`] = await warmThenOpen(fn, 'HDR');
        opens[`${fn}.LST`] = await warmThenOpen(fn, 'LST');
      }
    }

    // UI: click Group Sales / Profiles and dump visible menu-ish text
    const beforeXhr = xhrPaths.length;
    const clickTrace: string[] = [];
    async function tryClick(label: string): Promise<boolean> {
      const loc = page.getByText(label, { exact: true }).first();
      const vis = await loc.isVisible().catch(() => false);
      if (!vis) {
        // fallback loose
        const loc2 = page.getByText(label, { exact: false }).first();
        const vis2 = await loc2.isVisible().catch(() => false);
        if (!vis2) {
          clickTrace.push(`miss:${label}`);
          return false;
        }
        await loc2.hover().catch(() => undefined);
        await page.waitForTimeout(600);
        await loc2.click({ force: true, timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        clickTrace.push(`hitLoose:${label}`);
        return true;
      }
      await loc.hover().catch(() => undefined);
      await page.waitForTimeout(600);
      await loc.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      clickTrace.push(`hit:${label}`);
      return true;
    }

    await tryClick('More');
    await tryClick('Group Sales');
    await page.waitForTimeout(1_000);
    const afterGroupSales = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-menu-item-text, .x-tree-node-text, .x-btn-inner, a, span, li, div',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
            .filter((t) => t.length > 2 && t.length < 80)
            .filter((t) =>
              /event|group|block|beo|banquet|meeting|organiz|agency|company|profile|account|allot|sales/i.test(
                t,
              ),
            ),
        ),
      ].slice(0, 100);
    });
    await tryClick('Events');
    await tryClick('Event Reservations');
    await tryClick('Event Reservation');
    await tryClick('Event Master');
    await tryClick('Event Room Availability');

    await tryClick('More');
    await tryClick('Profiles');
    await page.waitForTimeout(1_000);
    const afterProfiles = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-menu-item-text, .x-tree-node-text, .x-btn-inner, a, span, li, div',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
            .filter((t) => t.length > 2 && t.length < 80)
            .filter((t) =>
              /organiz|agency|company|guest|profile|account|contact/i.test(t),
            ),
        ),
      ].slice(0, 100);
    });
    await tryClick('Organization Profiles');
    await tryClick('Booking Agency Profiles');
    await tryClick('Guest Profiles');

    const realOpens = Object.entries(opens)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813 && !v.hasLogin)
      .map(([fn, v]) => ({ fn, bytes: v.bytes, hasGrid: v.hasGrid, titleHint: v.titleHint }))
      .sort((a, b) => b.bytes - a.bytes);

    const out = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      valuesCaptured: false,
      bsShape: {
        bytes: bsShape.bytes,
        keyHits: bsShape.keyHits,
        // head may contain no PII; still truncate hard
        headPreview: bsShape.head.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]').slice(0, 300),
      },
      opens,
      realOpens,
      clickTrace,
      afterGroupSales,
      afterProfiles,
      xhrAfterUi: [...new Set(xhrPaths.slice(beforeXhr))].sort(),
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        bsBytes: bsShape.bytes,
        keyHits: bsShape.keyHits,
        realOpens,
        openSummary: Object.fromEntries(
          Object.entries(opens).map(([k, v]) => [
            k,
            `${v.status}/${v.bytes}${v.stub813 ? '/813' : ''}${v.hasGrid ? '/GRID' : ''}`,
          ]),
        ),
        clickTrace,
        afterGroupSales,
        afterProfiles,
        xhrAfterUi: [...new Set(xhrPaths.slice(beforeXhr))].sort(),
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
