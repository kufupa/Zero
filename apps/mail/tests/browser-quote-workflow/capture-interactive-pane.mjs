/**
 * Hydrated React Chromium proof for production QuoteWorkflowPanel.
 * Uses existing cached Chromium-1243 CDP + Vite test entry + built mail CSS.
 * Labelled mock adapter/bridge. Not Outlook. Not live HMS. Not a second engine.
 *
 * Attempt 1: Chrome starts on Vite URL.
 * Attempt 2: Chrome about:blank, then CDP Page.navigate (same Vite, no new installs).
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mailRoot = path.resolve(here, '../..');
const chrome = '/home/orca/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const vitePort = 4181;
const cdpPort = 9230;
const origin = `http://127.0.0.1:${vitePort}`;
const diagnostics = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(label, detail) {
  diagnostics.push({ at: new Date().toISOString(), label, detail });
  console.error(`[capture] ${label}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function waitPort(port, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ port, host: '127.0.0.1' }, () => {
          socket.end();
          resolve(undefined);
        });
        socket.on('error', reject);
      });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`port ${port} did not open`);
}

async function waitHttp(url, attempts = 80) {
  let last = '';
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      last = `${res.status}`;
      if (res.ok) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`http ${url} not ready: ${last}`);
}

async function cdp(ws, method, params, sessionId) {
  const id = Math.floor(Math.random() * 1e9);
  const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 20000);
    const onMessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString();
      if (!text.startsWith('{')) return;
      const msg = JSON.parse(text);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

async function evalPage(ws, expression) {
  const result = await cdp(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

function startVite() {
  const child = spawn(
    'pnpm',
    ['exec', 'vite', '--config', 'tests/browser-quote-workflow/vite.interactive-pane.config.ts'],
    {
      cwd: mailRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: '', VITEST_ALLOW_PILOT_RDS: '' },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    logs: () => ({ stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }),
  };
}

function startChrome(url) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=/tmp/quote-ui-interactive-${Date.now()}`,
    '--window-size=380,900',
    url,
  ];
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    stderr += `\n[chrome-exit code=${code} signal=${signal}]\n`;
  });
  return { child, logs: () => ({ stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }) };
}

async function waitForPageTarget() {
  let last = '';
  for (let i = 0; i < 80; i += 1) {
    for (const pathName of ['/json/list', '/json']) {
      try {
        const pages = await fetch(`http://127.0.0.1:${cdpPort}${pathName}`).then((r) => r.json());
        last = `${pathName}:${JSON.stringify(pages)}`;
        if (!Array.isArray(pages)) continue;
        const page =
          pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl) ||
          pages.find((entry) => entry.webSocketDebuggerUrl);
        if (page) return page;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    await sleep(100);
  }
  throw new Error(`no page target: ${last}`);
}

async function connectPage() {
  const page = await waitForPageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return ws;
}

async function waitHydrated(ws) {
  for (let i = 0; i < 80; i += 1) {
    const ready = await evalPage(
      ws,
      `Boolean(document.querySelector('#interactive-quote-root[data-hydrated="true"]') && window.__quoteProof && window.__quoteProof.reactHydrated)`,
    );
    if (ready) return;
    await sleep(200);
  }
  const body = await evalPage(ws, `document.body ? document.body.innerText.slice(0, 800) : 'no-body'`);
  throw new Error(`react did not hydrate: ${body}`);
}

async function screenshot(ws, name) {
  const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  const pngPath = path.join(here, name);
  writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
  return pngPath;
}

const SET_ADULTS = `(() => {
  const inputs = document.querySelectorAll('input[aria-label="Adults"]');
  if (inputs.length < 2) return { ok: false, reason: 'need two Adults inputs', count: inputs.length };
  const first = inputs[0];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  first.focus();
  setter.call(first, '4');
  first.dispatchEvent(new Event('input', { bubbles: true }));
  first.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: first.value, count: inputs.length };
})()`;

const CLICK_PER_STEP = `(() => {
  const button = [...document.querySelectorAll('button')].find((el) => /^Run Search availability/i.test(el.textContent || ''));
  if (!button) return { ok: false, reason: 'missing per-step Run', texts: [...document.querySelectorAll('button')].map((el) => el.textContent) };
  if (button.disabled) return { ok: false, reason: 'Run disabled', text: button.textContent };
  button.click();
  return { ok: true, text: button.textContent };
})()`;

async function exercise(ws) {
  await waitHydrated(ws);
  const before = await evalPage(ws, `window.__quoteProof`);
  const edit = await evalPage(ws, SET_ADULTS);
  await sleep(250);
  const afterEdit = await evalPage(ws, `window.__quoteProof`);
  const run = await evalPage(ws, CLICK_PER_STEP);
  await sleep(500);
  const afterRun = await evalPage(ws, `window.__quoteProof`);
  await evalPage(
    ws,
    `([...document.querySelectorAll('h3')].find((el) => /Approved tool steps/i.test(el.textContent || '')) || document.getElementById('mock-banner'))?.scrollIntoView({ block: 'start' })`,
  );
  await sleep(150);
  const unavailablePng = await screenshot(ws, 'interactive-pane-unavailable-380.png');
  await cdp(ws, 'Page.navigate', { url: `${origin}/?scenario=select` });
  await sleep(800);
  await waitHydrated(ws);
  const selectBefore = await evalPage(ws, `window.__quoteProof`);
  const selectTwin = await evalPage(
    ws,
    `(() => {
      const twin = [...document.querySelectorAll('button')].find((el) => /Standard Twin/.test(el.textContent || ''));
      if (!twin) return { ok: false, reason: 'missing twin', text: document.body.innerText.slice(0, 400) };
      twin.click();
      return { ok: true };
    })()`,
  );
  await sleep(250);
  const selectQueen = await evalPage(
    ws,
    `(() => {
      const queen = [...document.querySelectorAll('button')].find((el) => /Standard Queen/.test(el.textContent || ''));
      if (!queen) return { ok: false, reason: 'missing queen', text: document.body.innerText.slice(0, 400) };
      queen.click();
      return { ok: true, pressed: queen.getAttribute('aria-pressed') };
    })()`,
  );
  await sleep(250);
  const selectAfter = await evalPage(ws, `window.__quoteProof`);
  await evalPage(
    ws,
    `([...document.querySelectorAll('h3')].find((el) => /Results/i.test(el.textContent || '')) || document.body).scrollIntoView({ block: 'start' })`,
  );
  await sleep(150);
  const selectPng = await screenshot(ws, 'interactive-pane-select-380.png');
  const banner = await evalPage(ws, `document.getElementById('mock-banner')?.textContent ?? null`);
  return {
    banner,
    before,
    edit,
    afterEdit,
    run,
    afterRun,
    selectBefore,
    selectClick: { twin: selectTwin, queen: selectQueen },
    selectAfter,
    png: { unavailable: unavailablePng, select: selectPng },
  };
}

async function runChrome(label, startUrl, navigateAfterConnect) {
  const chromeProc = startChrome(startUrl);
  try {
    await waitPort(cdpPort);
    const ws = await connectPage();
    if (navigateAfterConnect) {
      await cdp(ws, 'Page.navigate', { url: navigateAfterConnect });
      await sleep(400);
    }
    const exercised = await exercise(ws);
    ws.close();
    return { ...exercised, chromeLogs: chromeProc.logs() };
  } catch (error) {
    error.chromeLogs = chromeProc.logs();
    throw error;
  } finally {
    chromeProc.child.kill('SIGKILL');
    await sleep(400);
  }
}

function judge(result) {
  const afterEdit = result.afterEdit ?? {};
  const afterRun = result.afterRun ?? {};
  const selectAfter = result.selectAfter ?? {};
  const payload = JSON.stringify(afterEdit.steps ?? []);
  const checks = {
    reactHydrated: afterEdit.reactHydrated === true,
    mockedBanner: /MOCKED adapter\/bridge/.test(result.banner ?? ''),
    twoGroups: Array.isArray(afterEdit.groupIds) && afterEdit.groupIds.length === 2,
    adultsEdited: afterEdit.groups?.[0]?.adults === 4,
    payloadUpdated: /4 adults/.test(payload),
    perStepRun: result.run?.ok === true,
    unavailableNoOffers: afterRun.offerCount === 0,
    unavailableNoPdf: afterRun.canCreatePdf === false && afterRun.pdf == null,
    unavailableNoNative: Array.isArray(afterRun.nativeCalls) && afterRun.nativeCalls.length === 0,
    twoGroupSelect:
      Array.isArray(selectAfter.selectedOfferIds) &&
      selectAfter.selectedOfferIds.includes('mix-a') &&
      (selectAfter.selectedOfferIds.includes('mix-b') || selectAfter.selectedOfferIds.includes('mix-c')),
    selectDidNotCallNative: Array.isArray(selectAfter.nativeCalls) && selectAfter.nativeCalls.length === 0,
    notOutlook: afterRun.notOutlook === true && afterRun.mockedIntegrations === true,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { checks, failed, ok: failed.length === 0 };
}

function writeReceipt(body) {
  const receiptPath = path.join(here, 'interactive-pane-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(body, null, 2));
  return receiptPath;
}

const receiptPath = path.join(here, 'interactive-pane-receipt.json');
const vite = startVite();
try {
  await waitPort(vitePort);
  await waitHttp(`${origin}/?scenario=unavailable`);
  record('vite', 'ready');

  let result;
  let usedAttempt = 1;
  try {
    record('attempt', 1);
    result = {
      attempt: 1,
      engine: 'vite+chromium-1243 url-argv',
      css: 'built server-build-*.css via /built-mail.css',
      origin,
      ...(await runChrome('url-argv', `${origin}/?scenario=unavailable`, null)),
    };
  } catch (first) {
    record('attempt1-failed', {
      message: first instanceof Error ? first.stack ?? first.message : String(first),
      chromeLogs: first?.chromeLogs ?? null,
      viteLogs: vite.logs(),
    });
    record('attempt', 2);
    try {
      usedAttempt = 2;
      result = {
        attempt: 2,
        engine: 'vite+chromium-1243 about:blank then Page.navigate',
        css: 'built server-build-*.css via /built-mail.css',
        origin,
        ...(await runChrome('blank-navigate', 'about:blank', `${origin}/?scenario=unavailable`)),
      };
    } catch (second) {
      const receipt = writeReceipt({
        at: new Date().toISOString(),
        chrome,
        note: 'Harness unavailable after two targeted attempts. Browser UI with mocked integrations, not Outlook. No framework install binge.',
        styledPaneHtml: 'untracked generated dump; gitignored non-destructively; not this proof',
        diagnostics,
        attempt1: first instanceof Error ? first.stack ?? first.message : String(first),
        attempt1ChromeLogs: first?.chromeLogs ?? null,
        attempt2: second instanceof Error ? second.stack ?? second.message : String(second),
        attempt2ChromeLogs: second?.chromeLogs ?? null,
        viteLogs: vite.logs(),
      });
      console.error(JSON.stringify({ receipt, diagnostics }, null, 2));
      process.exit(3);
    }
  }

  const judged = judge(result);
  writeReceipt({
    at: new Date().toISOString(),
    chrome,
    note: 'Browser UI with mocked integrations, not Outlook. Production QuoteWorkflowPanel hydrated in Chromium. Adapter/bridge labelled MOCK. No DB/Windows/PMS.',
    styledPaneHtml: 'untracked generated dump; gitignored non-destructively; not this proof',
    diagnostics,
    usedAttempt,
    result: {
      attempt: result.attempt,
      engine: result.engine,
      origin: result.origin,
      banner: result.banner,
      edit: result.edit,
      run: result.run,
      selectClick: result.selectClick,
      png: result.png,
      before: result.before,
      afterEdit: result.afterEdit,
      afterRun: result.afterRun,
      selectBefore: result.selectBefore,
      selectAfter: result.selectAfter,
    },
    judged,
  });
  console.log(JSON.stringify({ ok: judged.ok, failed: judged.failed, png: result.png, usedAttempt, receipt: receiptPath }, null, 2));
  process.exit(judged.ok ? 0 : 2);
} finally {
  vite.child.kill('SIGKILL');
}
