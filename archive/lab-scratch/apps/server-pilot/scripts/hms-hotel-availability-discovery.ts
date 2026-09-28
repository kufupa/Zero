/**
 * Read-only Hotel Availability surface discovery.
 * Captures only menu/function/path/body-key structure; never values or PII.
 * HMS_DISCOVERY_ALLOW_LIVE=1 is required. Mutation/Reserve/CRS routes abort.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page, type Request } from 'playwright';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/src/hms/runtime.js';

type RequestShape = {
  method: string;
  path: string;
  functionTokens: string[];
  bodyKeys: string[];
  bodyBytes: number;
  decision: 'continue' | 'abort';
  abortReason?: string;
};

function tokens(value: string): string[] {
  return [...new Set([...value.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,12})\b/gi)].map((m) => m[1]!.toUpperCase()))].slice(0, 20);
}

function shape(request: Request, decision: RequestShape['decision'], abortReason?: string): RequestShape {
  const url = new URL(request.url());
  const raw = request.postData() ?? '';
  const contentType = request.headers()['content-type'] ?? '';
  let bodyKeys: string[] = [];
  if (raw && (contentType.includes('x-www-form-urlencoded') || !contentType)) {
    bodyKeys = [...new URLSearchParams(raw).keys()].slice(0, 80);
  } else if (raw && contentType.includes('json')) {
    try { bodyKeys = Object.keys(JSON.parse(raw) as Record<string, unknown>).slice(0, 80); } catch { /* structural capture only */ }
  }
  return {
    method: request.method(),
    path: url.pathname,
    functionTokens: tokens(`${url.pathname} ${raw}`),
    bodyKeys,
    bodyBytes: Buffer.byteLength(raw),
    decision,
    ...(abortReason ? { abortReason } : {}),
  };
}

function mutationReason(path: string): string | null {
  if (/check.?availability|\/crs\//i.test(path)) return 'crs_check_availability';
  if (/reserve|save|delete|submit|checkin|checkout|amend|cancel|post|refund|settle|generate|print|send|export|newrecord/i.test(path)) return 'mutation_or_reserve';
  return null;
}

async function clickExact(page: Page, label: string): Promise<boolean> {
  const domClicked = await page.evaluate(String.raw`(want) => {
    const nodes = [...document.querySelectorAll('a,td,span,div,li,button')];
    for (const element of nodes) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== want) continue;
      const node = element;
      node.click();
      return true;
    }
    return false;
  }`, label).catch(() => false);
  if (domClicked) {
    await page.waitForTimeout(1_500);
    return true;
  }
  const exactText = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'i');
  const visibleNodes = page.locator('a,td,span,div,li,button').filter({ hasText: exactText });
  const visibleCount = await visibleNodes.count().catch(() => 0);
  for (let index = 0; index < visibleCount; index += 1) {
    const node = visibleNodes.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;
    await node.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    return true;
  }
  const candidates = [
    page.locator('.x-menu-item-text', { hasText: label }).filter({ hasText: label }).first(),
    page.getByText(label, { exact: true }).first(),
  ];
  for (const locator of candidates) {
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ force: true, timeout: 5_000 }).catch(async () => {
      await locator.hover({ force: true }).catch(() => undefined);
    });
    await page.waitForTimeout(1_500);
    return true;
  }
  return false;
}

async function hoverExact(page: Page, label: string): Promise<boolean> {
  const candidates = [
    page.locator('.x-menu-item-text', { hasText: label }).first(),
    page.getByText(label, { exact: true }).first(),
  ];
  for (const locator of candidates) {
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.hover({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath = process.env.HMS_HOTEL_AVAILABILITY_OUT ?? '/tmp/hms-hotel-availability-discovery.json';
  const videoDir = process.env.HMS_HOTEL_AVAILABILITY_VIDEO_DIR ?? `${outPath}.video`;
  const wantVideo = process.env.HMS_HOTEL_AVAILABILITY_VIDEO === '1';
  // OSMPAV is not inferred from generic shell tokens: it is supplied only by
  // the documented Infor Hotel Availability mapping after authenticated shell
  // discovery observed the same token. This remains an open/read probe; no
  // search or Reserve action is attempted here.
  const documentedFunction = (process.env.HMS_HOTEL_AVAILABILITY_DOCUMENTED_FUNCTION ?? '')
    .trim()
    .toUpperCase() || null;
  await mkdir(videoDir, { recursive: true, mode: 0o700 });

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(response.SecretString));
  if (secret.credentialMode !== 'view_only') throw new Error('credentialMode must be view_only');
  const origin = new URL(secret.loginUrl).origin;
  const requests: RequestShape[] = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    ...(wantVideo ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {}),
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.url().startsWith(origin)) {
      requests.push(shape(request, 'abort', 'cross_origin'));
      await route.abort();
      return;
    }
    const reason = mutationReason(new URL(request.url()).pathname);
    if (reason) {
      requests.push(shape(request, 'abort', reason));
      await route.abort();
      return;
    }
    requests.push(shape(request, 'continue'));
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const userInput = page.locator(
      'input[name=userid], input[name=username], input[name=j_username], input[id*=userid], input[id*=username], input[id*=user]',
    ).first();
    const passwordInput = page.locator('input[name=password], input[type=password], input[id*=password]').first();
    if (!(await userInput.isVisible().catch(() => false)) || !(await passwordInput.isVisible().catch(() => false))) {
      // Playwright serialises callback source.  tsx/esbuild may inject a
      // __name helper that does not exist in the HMS page, so browser snippets
      // are deliberately passed as plain strings.
      const loginSurface = await page.evaluate(String.raw`(() => ({
        urlPath: location.pathname,
        title: document.title,
        bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
        inputs: [...document.querySelectorAll('input')].map((el) => ({
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.getAttribute('id'),
          disabled: el.hasAttribute('disabled'),
        })).slice(0, 30),
      }))()`);
      throw new Error(`login_surface_missing:${JSON.stringify(loginSurface)}`);
    }
    await userInput.fill(secret.username);
    await passwordInput.fill(secret.password);
    await Promise.all([
      page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => { await page.locator('input[name=password]').press('Enter'); }),
    ]);
    await page.waitForTimeout(4_000);
    await page.evaluate(String.raw`(async () => {
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'BSSTRT', USER_FUNCTION_NAME: 'BSSTRT', manurefresh: 'yes' }).toString() }).catch(() => undefined);
      }
    })()`);
    await page.waitForTimeout(1_500);

    const clickLog: string[] = [];
    // The visible ExtJS tree is lazy and often hides menu items until a
    // module payload is requested.  Read the tenant's own BSSTRT menu
    // payloads (labels/function codes only) before trying UI navigation.  This
    // is discovery, not a guessed endpoint: every candidate below is
    // supplied by the authenticated menu response.
    const menuProbeResult = await page.evaluate(String.raw`(async () => {
      const items = [];
      const seen = new Set();
      const diagnostics = [];
      const add = (label, functionName, moduleKey) => {
        const clean = label.trim();
        if (!clean || clean.length > 120) return;
        const fn = functionName?.trim().toUpperCase() || null;
        const key = clean + '|' + (fn ?? '') + '|' + moduleKey;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ label: clean, functionName: fn, moduleKey });
      };
      for (let moduleKey = 0; moduleKey <= 20; moduleKey++) {
        try {
          const response = await fetch('/web/base/BSSTRT', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              MENU_MODULE_KEY: String(moduleKey),
              FUNCTION_CLASS: 'WEBL',
              manurefresh: 'yes',
            }).toString(),
          });
          const text = await response.text();
          const keys = [...new Set([...text.matchAll(/["']([A-Za-z][A-Za-z0-9_]{2,50})["']\s*:/g)].map((m) => m[1]))].slice(0, 120);
          const interestingStrings = [...new Set([...text.matchAll(/["']([^"']{2,120})["']/g)].map((m) => m[1]).filter((value) => /hotel|avail|rate|room|front|desk|child|adult|occup/i.test(value)))].slice(0, 80);
          const functionTokens = [...new Set([...text.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,12})\b/gi)].map((m) => m[1].toUpperCase()))].slice(0, 80);
          diagnostics.push({ moduleKey, status: response.status, bytes: text.length, keys, interestingStrings, functionTokens });
          const labels = [...text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
          const functionNames = [...text.matchAll(/"(?:userFunction|systemFunction|functionName|funcname)"\s*:\s*"([A-Z0-9]{2,16})"/gi)].map((m) => m[1]);
          for (const label of labels) {
            const nearby = text.slice(Math.max(0, text.indexOf(label) - 300), text.indexOf(label) + label.length + 300);
            const fn = nearby.match(/"(?:userFunction|systemFunction|functionName|funcname)"\s*:\s*"([A-Z0-9]{2,16})"/i)?.[1] ?? null;
            add(label, fn || functionNames[labels.indexOf(label)] || null, moduleKey);
          }
        } catch {
          /* structural probe only */
        }
      }
      return {
        items: items.filter((item) => /hotel|avail|rate|room|front desk|availability/i.test(item.label)),
        diagnostics,
      };
    })()`);
    const menuProbe = menuProbeResult.items;
    const menuDiagnostics = menuProbeResult.diagnostics;
    clickLog.push(`menuProbe:${menuProbe.length}`);
    await page.keyboard.press('Alt+KeyZ').catch(() => undefined);
    await page.waitForTimeout(1_500);
    const targetLabels = ['Hotel Availability', 'Hotel availability', 'Hotel Availability Search'];
    let targetClicked = false;
    clickLog.push('shortcut:Alt+Z');
    clickLog.push(`More:click:${await clickExact(page, 'More')}`);
    await page.waitForTimeout(1_000);
    // Ext menu children open on hover. Probe each documented top-level branch;
    // clicking a parent can close the previous submenu.
    for (const parent of ['Front Desk', 'Rate and Sales', 'Availability']) {
      if (targetClicked) break;
      const clickedParent = await clickExact(page, parent);
      const hovered = clickedParent || await hoverExact(page, parent);
      clickLog.push(`${parent}:click:${clickedParent}:hover:${hovered}`);
      if (!hovered) continue;
      const visibleMenuLabels = await page.evaluate(String.raw`(() => [...document.querySelectorAll('a,td,span,div,li,button')]
        .map((element) => {
          const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
          const rect = element.getBoundingClientRect();
          return { text, tag: element.tagName, id: element.id, className: element.className, visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden' };
        })
        .filter((value) => value.text.length > 1 && value.text.length < 100 && /hotel|avail|rate|room|front|desk|sales|shop|child|adult|occup/i.test(value.text))
        .filter((value, index, values) => values.findIndex((candidate) => candidate.text === value.text && candidate.visible === value.visible) === index)
        .slice(0, 120))()`);
      clickLog.push(`${parent}:labels:${JSON.stringify(visibleMenuLabels)}`);
      for (const label of targetLabels) {
        if (await clickExact(page, label)) {
          clickLog.push(`${parent}:${label}:true`);
          targetClicked = true;
          break;
        }
        clickLog.push(`${parent}:${label}:false`);
      }
    }
    // The tenant also exposes the application-menu search. Use it only as a
    // read-only navigation aid when nested menu labels are not rendered.
    if (!targetClicked) {
      const appSearch = page.locator('input[name=appmenusearch]').first();
      if (await appSearch.isVisible().catch(() => false) && await appSearch.isEnabled().catch(() => false)) {
        await appSearch.fill('Hotel Availability');
        await page.waitForTimeout(1_500);
        clickLog.push(`appMenuSearch:true`);
        for (const label of targetLabels) {
          if (await clickExact(page, label)) { clickLog.push(`search:${label}:true`); targetClicked = true; break; }
          clickLog.push(`search:${label}:false`);
        }
        if (!targetClicked) await appSearch.press('Enter').catch(() => undefined);
      } else {
        clickLog.push(`appMenuSearch:false_or_disabled`);
      }
    }
    // If the menu response supplied a target function, open only that exact
    // function.  This avoids inventing an Infor code while still allowing a
    // lazy/role-hidden menu to be tested.  We record structure, never values.
    const menuTarget = menuProbe.find((item) => /^hotel availability(?: search)?$/i.test(item.label) && item.functionName);
    let menuOpen: { label: string; functionName: string; status: number; bytes: number; title: string | null; inputNames: string[]; targetTextPresent: boolean } | null = null;
    if (menuTarget?.functionName) {
      const functionNameLiteral = JSON.stringify(menuTarget.functionName);
      menuOpen = await page.evaluate(String.raw`(async () => {
        const functionName = ${functionNameLiteral};
        try {
          const response = await fetch('/web/base/' + functionName + '?FUNCTION_CLASS=WEBL', {
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
          const text = await response.text();
          return {
            label: 'Hotel Availability',
            functionName,
            status: response.status,
            bytes: text.length,
            title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
            inputNames: [...new Set([...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 120),
            targetTextPresent: /hotel availability/i.test(text),
          };
        } catch {
          return { label: 'Hotel Availability', functionName, status: 0, bytes: 0, title: null, inputNames: [], targetTextPresent: false };
        }
      })()`);
      clickLog.push(`menuOpen:${menuTarget.functionName}:${menuOpen.status}:${menuOpen.bytes}`);
    }
    let documentedOpen: {
      functionName: string;
      status: number;
      bytes: number;
      title: string | null;
      inputNames: string[];
      targetTextPresent: boolean;
      genericShell: boolean;
      functionTokens: string[];
    } | null = null;
    let documentedTabOpen: {
      functionName: string;
      tab: string;
      status: number;
      bytes: number;
      title: string | null;
      inputNames: string[];
      targetTextPresent: boolean;
      genericShell: boolean;
      functionTokens: string[];
    } | null = null;
    if (documentedFunction) {
      const functionNameLiteral = JSON.stringify(documentedFunction);
      documentedOpen = await page.evaluate(String.raw`(async () => {
        const functionName = ${functionNameLiteral};
        try {
          const response = await fetch('/web/base/' + functionName + '?FUNCTION_CLASS=WEBL', {
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
          const text = await response.text();
          return {
            functionName,
            status: response.status,
            bytes: text.length,
            title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
            inputNames: [...new Set([...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 160),
            targetTextPresent: /hotel availability/i.test(text),
            genericShell: text.length === 729 || text.length === 730 || text.length === 813,
            functionTokens: [...new Set([...text.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,12})\b/gi)].map((m) => m[1].toUpperCase()))].slice(0, 80),
          };
      } catch {
        return { functionName, status: 0, bytes: 0, title: null, inputNames: [], targetTextPresent: false, genericShell: false, functionTokens: [] };
      }
      })()`);
      clickLog.push(`documentedOpen:${documentedFunction}:${documentedOpen.status}:${documentedOpen.bytes}`);
      documentedTabOpen = await page.evaluate(String.raw`(async () => {
        const functionName = ${functionNameLiteral};
        const tab = 'HDR';
        try {
          const response = await fetch('/web/base/' + functionName + '.' + tab + '?FUNCTION_CLASS=WEBL', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              CURRENT_TAB_NAME: tab,
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
            }).toString(),
          });
          const text = await response.text();
          return {
            functionName,
            tab,
            status: response.status,
            bytes: text.length,
            title: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
            inputNames: [...new Set([...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 160),
            targetTextPresent: /hotel availability/i.test(text),
            genericShell: text.length === 729 || text.length === 730 || text.length === 813,
            functionTokens: [...new Set([...text.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,12})\b/gi)].map((m) => m[1].toUpperCase()))].slice(0, 80),
          };
        } catch {
          return { functionName, tab, status: 0, bytes: 0, title: null, inputNames: [], targetTextPresent: false, genericShell: false, functionTokens: [] };
        }
      })()`);
      clickLog.push(`documentedTabOpen:${documentedFunction}.HDR:${documentedTabOpen.status}:${documentedTabOpen.bytes}`);
    }
    await page.waitForTimeout(3_000);
    const structural = await page.evaluate(String.raw`(() => {
      const html = document.documentElement?.innerHTML ?? '';
      const text = document.body?.innerText ?? '';
      const names = [...new Set([...html.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 160);
      const labels = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 100 && /hotel|avail|guest|adult|child|age|date|night|rate|room|currency|search|reserve/i.test(s)).slice(0, 120);
      const controls = [...document.querySelectorAll('button,a,[role=button],input')].map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? '').trim().slice(0, 80),
        title: el.getAttribute('title'),
        aria: el.getAttribute('aria-label'),
        name: el.getAttribute('name'),
        disabled: el.hasAttribute('disabled'),
      })).filter((v) => v.text || v.title || v.aria || v.name).slice(0, 160);
      const moreMatches = [...document.querySelectorAll('a,td,span,div,li,button')]
        .filter((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === 'More')
        .slice(0, 10)
        .map((el) => {
          const html = el;
          const rect = html.getBoundingClientRect();
          return {
            tag: html.tagName,
            id: html.id,
            className: html.className,
            href: html.getAttribute('href'),
            onclick: html.getAttribute('onclick'),
            display: getComputedStyle(html).display,
            visibility: getComputedStyle(html).visibility,
            width: rect.width,
            height: rect.height,
          };
        });
      return {
        urlPath: location.pathname,
        title: document.title,
        targetTextPresent: /Hotel Availability/i.test(text),
        forbiddenCrsText: /CRS Check Availability/i.test(text),
        names,
        labels,
        controls,
        moreMatches,
        functionTokens: [...new Set([...html.matchAll(/\b((?:OS|PS|AR|BS)[A-Z0-9]{3,12})\b/gi)].map((m) => m[1].toUpperCase()))].slice(0, 80),
      };
    })()`);
    const video = await page.video()?.path().catch(() => null);
    const result = {
      schemaVersion: 1,
      sourceSurface: 'hotel_availability',
      originHost: new URL(origin).host,
      valuesCaptured: false,
      targetClicked,
      clickLog,
      menuProbe,
      menuDiagnostics,
      menuOpen,
      documentedFunction,
      documentedOpen,
      documentedTabOpen,
      structural,
      requests: requests.slice(-240),
      requestCounts: { total: requests.length, aborted: requests.filter((r) => r.decision === 'abort').length },
      videoPath: video,
      videoSha256: null as string | null,
    };
    if (video) {
      const { readFile } = await import('node:fs/promises');
      result.videoSha256 = createHash('sha256').update(await readFile(video)).digest('hex');
    }
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ...result, videoPath: video ? '[private]' : null }) + '\n');
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'discovery_failed';
  process.stderr.write(/password|secret|arn:aws/i.test(message) ? 'redacted_error\n' : `${message.slice(0, 240)}\n`);
  process.exit(1);
});
