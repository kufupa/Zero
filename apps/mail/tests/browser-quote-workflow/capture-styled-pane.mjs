/**
 * Styled 380px production-pane capture. Uses built mail CSS + Chromium-1243 CDP.
 * Static dump + DOM events — not hydrated React. Interactive UI is not verified here.
 * Not a live Outlook session.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const outDir = path.join(root, 'tests/browser-quote-workflow');
const chrome = '/home/orca/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const assets = path.join(root, 'build/client/assets');
const cssName = readdirSync(assets).find((name) => name.startsWith('server-build-') && name.endsWith('.css'));
if (!cssName) throw new Error('missing built server-build-*.css; run mail build first');
const css = readFileSync(path.join(assets, cssName), 'utf8');
const sourceHtml = readFileSync(path.join(outDir, 'mounted-pane.html'), 'utf8');
const styled = sourceHtml.replace(
  '</style></head>',
  `</style><style id="built-mail-css">${css}</style></head>`,
);
const styledPath = path.join(outDir, 'styled-pane.html');
writeFileSync(styledPath, styled);

const port = 9229;
const chromeProc = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/quote-ui-chrome-${Date.now()}`,
    '--window-size=380,900',
    `file://${styledPath}`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitPort() {
  for (let i = 0; i < 40; i += 1) {
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
  throw new Error('chrome debug port did not open');
}

async function cdp(ws, method, params, sessionId) {
  const id = Math.floor(Math.random() * 1e9);
  const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 15000);
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

try {
  await waitPort();
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page) throw new Error(`no page target: ${JSON.stringify(pages)}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Runtime.enable');
  await sleep(400);
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const interaction = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => {
        const arrival = document.querySelector('input[aria-label="Arrival"]');
        const adults = document.querySelector('input[aria-label="Adults"]');
        if (!arrival || !adults) return { ok: false, reason: 'missing inputs' };
        arrival.focus();
        arrival.value = '2026-11-12';
        arrival.dispatchEvent(new Event('input', { bubbles: true }));
        arrival.dispatchEvent(new Event('change', { bubbles: true }));
        adults.focus();
        adults.value = '2';
        adults.dispatchEvent(new Event('input', { bubbles: true }));
        const pane = document.querySelector('#mounted-outlook-pane') || document.body;
        const overflowX = pane.scrollWidth - pane.clientWidth;
        return {
          ok: true,
          arrival: arrival.value,
          adults: adults.value,
          paneWidth: pane.getBoundingClientRect().width,
          overflowX,
          hasVerticalScroll: pane.scrollHeight > pane.clientHeight,
          hasAllocation: /Allocation/.test(document.body.innerText),
          hasFixturePdf: /Quote-fixture-not-live-hms/.test(document.body.innerText),
          hasUnavailable: /enqueueHmsRead|second PMS owner/.test(document.body.innerText),
        };
      })()`,
    returnByValue: true,
  });
  const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  const pngPath = path.join(outDir, 'styled-pane-380.png');
  writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
  const receipt = {
    at: new Date().toISOString(),
    chrome,
    css: cssName,
    html: styledPath,
    png: pngPath,
    viewport: { width: 380, height: 900 },
    interaction: interaction.result.value,
    note: 'Static HTML dump of production pane markup with built CSS inlined. Keyboard/input via raw DOM events — NOT hydrated React (no React state, no step Run). Does not prove interactive UI. React proof is happy-dom OutlookPanePage tests. Not Windows Outlook. Playwright 1.52 browser missing.',
  };
  writeFileSync(path.join(outDir, 'styled-pane-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.interaction.ok) process.exit(2);
  if (receipt.interaction.overflowX > 1) process.exit(3);
  if (receipt.interaction.hasAllocation || receipt.interaction.hasFixturePdf) process.exit(4);
  ws.close();
} finally {
  chromeProc.kill('SIGKILL');
}
