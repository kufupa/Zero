/**
 * A7/A8: full BSSTRT menu catalog harvest (all fn prefixes) + soft-open
 * Event Reservations / Organization / Booking Agency matches.
 * Soft-open BEFORE menu UI clicks. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type Pair = { label: string; fn: string };
type OpenResult = {
  status: number;
  bytes: number;
  stub813: boolean;
  hasGrid: boolean;
  titleHint: string | null;
};

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A78_CATALOG_OUT ?? '/tmp/a78-menu-catalog.sanitized.v1.json';

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
  const xhrFns: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (!req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,24})/i.exec(req.url());
    if (m) xhrFns.push(m[1]!.toUpperCase());
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

    const catalog = await page.evaluate(async () => {
      const blobs: string[] = [];
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'BSSTRT',
            USER_FUNCTION_NAME: 'BSSTRT',
            manurefresh: 'yes',
            FUNCTION_CLASS: 'WEBL',
          }).toString(),
        })
          .then(async (r) => blobs.push(await r.text()))
          .catch(() => undefined);
      }
      for (let k = 0; k <= 40; k++) {
        await fetch('/web/base/BSSTRT', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'BSSTRT',
            USER_FUNCTION_NAME: 'BSSTRT',
            manurefresh: 'yes',
            FUNCTION_CLASS: 'WEBL',
            MENU_MODULE_KEY: String(k),
          }).toString(),
        })
          .then(async (r) => blobs.push(await r.text()))
          .catch(() => undefined);
      }
      const pairs: Pair[] = [];
      const fns = new Set<string>();
      for (const text of blobs) {
        for (const chunk of text.split(/\{/g).slice(0, 20_000)) {
          const labelM = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk);
          const fnM =
            /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{3,12})"/i.exec(
              chunk,
            );
          if (labelM && fnM) {
            pairs.push({
              label: labelM[1]!,
              fn: fnM[1]!.toUpperCase(),
            });
            fns.add(fnM[1]!.toUpperCase());
          }
        }
        // All 5–10 char uppercase fn tokens (not OS/PS/AR only)
        for (const m of text.matchAll(/\b([A-Z]{2}[A-Z0-9]{3,8})\b/g)) {
          fns.add(m[1]!);
        }
      }
      const uniqPairs: Pair[] = [];
      const seen = new Set<string>();
      for (const p of pairs) {
        const k = `${p.label}::${p.fn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniqPairs.push(p);
      }
      const eventPairs = uniqPairs.filter((p) =>
        /event|beo|banquet|meeting|cater/i.test(p.label),
      );
      const orgPairs = uniqPairs.filter((p) =>
        /organiz|compan|agency|profil|account/i.test(p.label),
      );
      const groupPairs = uniqPairs.filter((p) =>
        /group|block|allot/i.test(p.label),
      );
      return {
        blobBytes: blobs.reduce((n, t) => n + t.length, 0),
        pairCount: uniqPairs.length,
        fnCount: fns.size,
        allPairs: uniqPairs.slice(0, 400),
        eventPairs,
        orgPairs,
        groupPairs,
        allFns: [...fns].sort(),
      };
    });

    const softTargets = [
      ...new Set([
        ...catalog.eventPairs.map((p) => p.fn),
        ...catalog.orgPairs.map((p) => p.fn),
        ...catalog.groupPairs.map((p) => p.fn),
        'GSGRPB',
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
      ]),
    ];

    const opens: Record<string, OpenResult> = {};
    for (const fn of softTargets) {
      for (const variant of [fn, `${fn}.HDR`, `${fn}.LST`]) {
        opens[variant] = await page.evaluate(async (p) => {
          const name = p.split('.')[0]!;
          const tab = p.includes('.') ? p.split('.')[1]! : '';
          const url = p.includes('.')
            ? `/web/base/${p}`
            : `/web/base/${p}?FUNCTION_CLASS=WEBL`;
          const body: Record<string, string> = {
            SYSTEM_FUNCTION_NAME: name,
            USER_FUNCTION_NAME: name,
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          };
          if (tab) {
            body.CURRENT_TAB_NAME = tab;
            if (tab === 'LST') {
              body.COMPONENT_INFO_TYPE = 'DATA_ONLY';
              body.GRID_NAME = name;
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
              /<(?:title|h1|h2)[^>]*>([^<]{3,80})</i.exec(text)?.[1]?.trim() ??
              /"screenTitle"\s*:\s*"([^"]+)"/i.exec(text)?.[1] ??
              null;
            return {
              status: r.status,
              bytes: text.length,
              stub813: text.length === 813,
              hasGrid: /GRID|"DATA"\s*:/i.test(text),
              titleHint,
            };
          } catch {
            return {
              status: 0,
              bytes: 0,
              stub813: false,
              hasGrid: false,
              titleHint: null,
            };
          }
        }, variant);
      }
    }

    // UI path: More → Group Sales → Events → Event Reservations; Profiles → Organization
    const clickTrace: string[] = [];
    async function tryClick(label: string): Promise<boolean> {
      const loc = page.getByText(label, { exact: false }).first();
      const vis = await loc.isVisible().catch(() => false);
      if (!vis) {
        clickTrace.push(`miss:${label}`);
        return false;
      }
      await loc.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_800);
      clickTrace.push(`hit:${label}`);
      return true;
    }

    await tryClick('More');
    await tryClick('Group Sales');
    await page.waitForTimeout(800);
    await tryClick('Events');
    await page.waitForTimeout(800);
    await tryClick('Event Reservations');
    await tryClick('Event Reservation');

    await tryClick('More');
    await tryClick('Profiles');
    await page.waitForTimeout(800);
    await tryClick('Organization Profiles');
    await tryClick('Organization Profile');
    await tryClick('Booking Agency Profiles');

    const realOpens = Object.entries(opens)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
      .map(([fn, v]) => ({ fn, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

    const out = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      valuesCaptured: false,
      catalog: {
        blobBytes: catalog.blobBytes,
        pairCount: catalog.pairCount,
        fnCount: catalog.fnCount,
        eventPairs: catalog.eventPairs,
        orgPairs: catalog.orgPairs,
        groupPairs: catalog.groupPairs,
        // Cap allPairs labels only (fn codes OK)
        allPairsSample: catalog.allPairs.slice(0, 200),
      },
      softTargets,
      realOpens,
      opensInteresting: Object.fromEntries(
        Object.entries(opens).filter(
          ([, v]) => v.status === 200 && (v.bytes > 1500 || v.hasGrid),
        ),
      ),
      clickTrace,
      xhrFns: [...new Set(xhrFns)].sort(),
    };
    await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        pairCount: catalog.pairCount,
        eventPairs: catalog.eventPairs,
        orgPairs: catalog.orgPairs.slice(0, 40),
        groupPairs: catalog.groupPairs.slice(0, 20),
        realOpens,
        clickTrace,
        xhrFns: [...new Set(xhrFns)].sort().slice(0, 60),
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
