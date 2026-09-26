/**
 * Wave A payload reopen: UI click-harvest for Infor menu paths.
 * Captures same-origin XHR/POST function codes while clicking receptionist paths.
 * Never mutates (route-abort save/delete/…). Requires HMS_DISCOVERY_ALLOW_LIVE=1.
 *
 * Paths (Exa/Infor):
 * - Front Desk > Availability > Room Type and Rate Availability (ALT+Z)
 * - Group Sales > Group Booking
 * - Group Sales > Events > Event Reservations
 * - Profiles > Organization Profiles
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page, type Request } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type CapturedReq = {
  method: string;
  path: string;
  functionTokens: string[];
  bodyKeys: string[];
  systemFn: string | null;
  userFn: string | null;
  menuModuleKey: string | null;
  bytes: number;
};

function extractFns(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,10})\b/g)].map((m) => m[1]!),
    ),
  ];
}

function parseBody(postData: string | null): {
  keys: string[];
  systemFn: string | null;
  userFn: string | null;
  menuModuleKey: string | null;
} {
  if (!postData) return { keys: [], systemFn: null, userFn: null, menuModuleKey: null };
  const params = new URLSearchParams(postData);
  const keys = [...params.keys()].slice(0, 40);
  return {
    keys,
    systemFn: params.get('SYSTEM_FUNCTION_NAME') || params.get('systemFunction') || null,
    userFn: params.get('USER_FUNCTION_NAME') || params.get('userFunction') || null,
    menuModuleKey: params.get('MENU_MODULE_KEY'),
  };
}

async function softOpen(page: Page, fn: string): Promise<{
  status: number;
  bytes: number;
  stub813: boolean;
  hasRoomtypes: boolean;
  title: string | null;
}> {
  return page.evaluate(async (functionName) => {
    try {
      const res = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
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
      const text = await res.text();
      return {
        status: res.status,
        bytes: text.length,
        stub813: text.length === 813,
        hasRoomtypes: /roomtypes|rateplans|ROOMTYPE|RATEPLAN/i.test(text),
        title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
      };
    } catch {
      return {
        status: 0,
        bytes: 0,
        stub813: false,
        hasRoomtypes: false,
        title: null,
      };
    }
  }, fn);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outDir =
    process.env.HMS_CLICK_HARVEST_OUT_DIR?.trim() || '/tmp/hms-click-harvest';
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const videoDir = join(outDir, 'video');
  await mkdir(videoDir, { recursive: true, mode: 0o700 });
  const wantVideo = process.env.HMS_CLICK_HARVEST_VIDEO !== '0';

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

  const captured: CapturedReq[] = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
    ...(wantVideo
      ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }
      : {}),
  });

  // Soft-allow chrome: block only mutate paths; allow module opens.
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      /(save|delete|duplicate|checkin|checkout|amend|cancel|settle|refund|send|print|export|submit|newrecord)/i.test(
        path,
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const onRequest = (req: Request) => {
    try {
      if (!req.url().startsWith(origin)) return;
      const u = new URL(req.url());
      const body = parseBody(req.postData());
      const tokens = extractFns(`${u.pathname} ${req.postData() ?? ''}`);
      if (
        tokens.length === 0 &&
        !body.systemFn &&
        !/\/web\/base\//.test(u.pathname)
      ) {
        return;
      }
      captured.push({
        method: req.method(),
        path: u.pathname,
        functionTokens: tokens.slice(0, 20),
        bodyKeys: body.keys,
        systemFn: body.systemFn,
        userFn: body.userFn,
        menuModuleKey: body.menuModuleKey,
        bytes: (req.postData() ?? '').length,
      });
    } catch {
      /* ignore */
    }
  };
  ctx.on('request', onRequest);

  const page = await ctx.newPage();
  const clickLog: string[] = [];
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
    await page.waitForTimeout(4_000);

    // Warm start center (A3 pattern) WITHOUT clicking Front Desk first.
    await page.evaluate(async () => {
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        try {
          await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
            }).toString(),
          });
        } catch {
          /* ignore */
        }
      }
    });
    await page.waitForTimeout(1_500);

    // EARLY soft-open BEFORE any menu clicks (A3 unlock). Include CSVAVL from Alt+Z capture.
    async function earlyOpen(
      fn: string,
      opts?: { viaEwsweb?: boolean },
    ): Promise<{
      status: number;
      bytes: number;
      stub813: boolean;
      hasRoomtypes: boolean;
      path: string;
      title: string | null;
      inputSample: string[];
    }> {
      return page.evaluate(
        async ({ functionName, viaEwsweb }) => {
          const path = viaEwsweb
            ? '/web/base/EWSWEB?FUNCTION_CLASS=WEBL'
            : `/web/base/${functionName}?FUNCTION_CLASS=WEBL`;
          const body = new URLSearchParams({
            SYSTEM_FUNCTION_NAME: viaEwsweb ? 'EWSWEB' : functionName,
            USER_FUNCTION_NAME: functionName,
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          });
          try {
            const res = await fetch(path, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            });
            const text = await res.text();
            const inputs = [
              ...new Set(
                [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
              ),
            ].slice(0, 40);
            return {
              status: res.status,
              bytes: text.length,
              stub813: text.length === 813,
              hasRoomtypes: /roomtypes|rateplans|ROOMTYPE|RATEPLAN|availability/i.test(
                text,
              ),
              path,
              title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
              inputSample: inputs,
            };
          } catch {
            return {
              status: 0,
              bytes: 0,
              stub813: false,
              hasRoomtypes: false,
              path,
              title: null,
              inputSample: [],
            };
          }
        },
        { functionName: fn, viaEwsweb: !!opts?.viaEwsweb },
      );
    }

    const earlyOpens: Record<string, Awaited<ReturnType<typeof earlyOpen>>> = {};
    for (const fn of [
      'OSRESS',
      'PSSNEL',
      'OSRRAV',
      'OSRTAV',
      'OSRPAV',
      'CSVAVL',
    ]) {
      earlyOpens[fn] = await earlyOpen(fn);
    }
    earlyOpens['EWSWEB:CSVAVL'] = await earlyOpen('CSVAVL', { viaEwsweb: true });
    // HDR chrome for quote
    earlyOpens['OSRRAV.HDR'] = await page.evaluate(async () => {
      try {
        const res = await fetch('/web/base/OSRRAV.HDR?FUNCTION_CLASS=WEBL', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSRRAV',
            USER_FUNCTION_NAME: 'OSRRAV',
            CURRENT_TAB_NAME: 'HDR',
            FUNCTION_CLASS: 'WEBL',
          }).toString(),
        });
        const text = await res.text();
        return {
          status: res.status,
          bytes: text.length,
          stub813: text.length === 813,
          hasRoomtypes: /roomtypes|rateplans/i.test(text),
          path: '/web/base/OSRRAV.HDR',
          title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
          inputSample: [
            ...new Set(
              [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
            ),
          ].slice(0, 40),
        };
      } catch {
        return {
          status: 0,
          bytes: 0,
          stub813: false,
          hasRoomtypes: false,
          path: '/web/base/OSRRAV.HDR',
          title: null,
          inputSample: [],
        };
      }
    });
    clickLog.push(
      `earlyOpens:real=${
        Object.entries(earlyOpens).filter(([, v]) => v.bytes > 2000 && !v.stub813).length
      }`,
    );

    // Dump top-level menu bar labels before clicks
    const menuBar = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-menu-item-text, .x-btn-inner, .x-tab-inner, [role="menuitem"], .mainMenu, .menu-item, a.x-menu-item',
        ),
      ];
      return [...new Set(nodes.map((n) => (n.textContent ?? '').trim()).filter((t) => t.length > 1 && t.length < 64))].slice(0, 100);
    });
    clickLog.push(`menuBarSample:${menuBar.slice(0, 20).join('|')}`);

    async function goStartCenter(): Promise<void> {
      await page.keyboard.press('Escape').catch(() => undefined);
      const sc = page.getByText('Start Center', { exact: true }).first();
      if (await sc.isVisible().catch(() => false)) {
        await sc.click({ force: true }).catch(() => undefined);
        clickLog.push('click:Start Center');
        await page.waitForTimeout(1_500);
      }
    }

    async function hoverClickMenu(pathLabels: string[]): Promise<void> {
      await goStartCenter();
      for (let i = 0; i < pathLabels.length; i++) {
        const label = pathLabels[i]!;
        // Prefer menu-item text nodes
        const menuItem = page.locator('.x-menu-item-text', { hasText: label }).first();
        const btn = page.locator('.x-btn-inner', { hasText: label }).first();
        const any = page.getByText(label, { exact: true }).first();
        let done = false;
        for (const loc of [menuItem, btn, any]) {
          const vis = await loc.isVisible().catch(() => false);
          if (!vis) continue;
          if (i < pathLabels.length - 1) {
            await loc.hover({ force: true }).catch(() => undefined);
            await page.waitForTimeout(800);
            await loc.click({ force: true }).catch(() => undefined);
          } else {
            await loc.click({ force: true }).catch(() => undefined);
          }
          clickLog.push(`nav:${label}`);
          done = true;
          await page.waitForTimeout(1_800);
          break;
        }
        if (!done) clickLog.push(`miss:${label}`);
      }
    }

    // A5: ALT+Z then menu path (after early opens already recorded)
    try {
      await page.keyboard.press('Alt+KeyZ');
      clickLog.push('shortcut:Alt+Z');
      await page.waitForTimeout(3_000);
    } catch {
      clickLog.push('shortcut:Alt+Z:fail');
    }

    await hoverClickMenu([
      'Front Desk',
      'Availability',
      'Room Type and Rate Availability',
    ]);
    await hoverClickMenu(['Group Sales', 'Group Booking']);
    await hoverClickMenu(['Group Sales', 'Events', 'Event Reservations']);
    await hoverClickMenu(['Profiles', 'Organization Profiles']);

    // Collect unique SYSTEM/USER function names from capture
    const harvested = [
      ...new Set(
        captured
          .flatMap((c) =>
            [c.systemFn, c.userFn, ...c.functionTokens].filter(
              (x): x is string =>
                !!x && /^(OS|PS|AR|CS)[A-Z0-9]{3,10}$/.test(x.toUpperCase()),
            ),
          )
          .map((x) => x.toUpperCase()),
      ),
    ].sort();

    // Soft-open newly harvested codes not already early-opened
    const opens: Record<string, Awaited<ReturnType<typeof softOpen>>> = {};
    for (const fn of harvested.slice(0, 30)) {
      if (earlyOpens[fn]) continue;
      opens[fn] = await softOpen(page, fn);
    }

    const realEarly = Object.entries(earlyOpens)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
      .map(([k, v]) => ({
        fn: k,
        bytes: v.bytes,
        hasRoomtypes: v.hasRoomtypes,
        inputs: v.inputSample.slice(0, 15),
      }));
    const realOpens = Object.entries(opens)
      .filter(([, v]) => v.status === 200 && v.bytes > 2000 && !v.stub813)
      .map(([k, v]) => ({ fn: k, bytes: v.bytes, hasRoomtypes: v.hasRoomtypes }));

    await page.waitForTimeout(1_000);
    await page.close();
    await ctx.close();

    let video: { hasVideo: boolean; sha256: string | null; bytes: number } = {
      hasVideo: false,
      sha256: null,
      bytes: 0,
    };
    if (wantVideo) {
      const files = await readdir(videoDir);
      const webms: { p: string; m: number }[] = [];
      for (const f of files) {
        if (!f.endsWith('.webm')) continue;
        const p = join(videoDir, f);
        const st = await stat(p);
        webms.push({ p, m: st.mtimeMs });
      }
      webms.sort((a, b) => b.m - a.m);
      if (webms[0]) {
        const { readFile } = await import('node:fs/promises');
        const buf = await readFile(webms[0].p);
        video = {
          hasVideo: true,
          sha256: createHash('sha256').update(buf).digest('hex'),
          bytes: buf.byteLength,
        };
      }
    }

    // Sanitize: no PII — codes/paths/sizes only
    const sanitized = {
      schemaVersion: 1,
      surface: 'click_harvest_playbook',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      valuesCaptured: false,
      playbooks: {
        a5: 'Front Desk > Availability > Room Type and Rate Availability (+ Alt+Z)',
        a6: 'Group Sales > Group Booking',
        a7: 'Group Sales > Events > Event Reservations',
        a8: 'Profiles > Organization Profiles',
      },
      clickLog,
      menuBarSample: menuBar,
      earlyOpens: Object.fromEntries(
        Object.entries(earlyOpens).map(([k, v]) => [
          k,
          {
            status: v.status,
            bytes: v.bytes,
            stub813: v.stub813,
            hasRoomtypes: v.hasRoomtypes,
            path: v.path,
            inputSample: v.inputSample.slice(0, 20),
          },
        ]),
      ),
      captureCount: captured.length,
      capturedSample: captured.slice(0, 80).map((c) => ({
        method: c.method,
        path: c.path,
        systemFn: c.systemFn,
        userFn: c.userFn,
        menuModuleKey: c.menuModuleKey,
        functionTokens: c.functionTokens,
        bodyKeyCount: c.bodyKeys.length,
      })),
      harvestedFns: harvested,
      opens: Object.fromEntries(
        Object.entries(opens).map(([k, v]) => [
          k,
          {
            status: v.status,
            bytes: v.bytes,
            stub813: v.stub813,
            hasRoomtypes: v.hasRoomtypes,
            title: v.title,
          },
        ]),
      ),
      realEarly,
      realOpens,
      video,
    };

    const outPath = join(outDir, 'click-harvest.sanitized.v1.json');
    await writeFile(outPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        clickLog,
        harvestedFns: harvested,
        realEarly,
        realOpens,
        video,
        captureCount: captured.length,
        earlySummary: Object.fromEntries(
          Object.entries(earlyOpens).map(([k, v]) => [
            k,
            { status: v.status, bytes: v.bytes, stub813: v.stub813 },
          ]),
        ),
      }) + '\n',
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'click_harvest_failed';
  const safe = /password|secret|cookie|arn:aws/i.test(msg)
    ? 'redacted_error'
    : msg.slice(0, 200);
  process.stderr.write(`${safe}\n`);
  process.exit(1);
});
