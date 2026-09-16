/**
 * Full-path, read-only UI evidence for genuine HMS role/surface gates.
 *
 * HMS_ROLE_GATE_TOOL=A1|DOC|A7
 * HMS_DISCOVERY_ALLOW_LIVE=1
 * HMS_READ_SECRET_ARN
 * HMS_PROOF_EXACT_CANDIDATE_PATH (required for A1/DOC)
 * HMS_ROLE_GATE_OUT (private output directory)
 *
 * The video is intentionally kept full length: login -> normal navigation ->
 * exact surface/menu -> painted failure/empty state. No hidden Ext controls,
 * forced clicks, overlays, stitched screenshots, or write requests are used.
 */
import { mkdir, readFile, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../dist/hms/runtime.js';

const TOOL = String(process.env.HMS_ROLE_GATE_TOOL || '').toUpperCase();
const ALLOWED = new Set(['A1', 'DOC', 'A7']);
const OUT = process.env.HMS_ROLE_GATE_OUT || `/tmp/hms-role-gate-${TOOL.toLowerCase()}-${Date.now()}`;

function scrub(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/\b\d{7,}\b/g, '[n]');
}

async function secret() {
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'af-south-1' });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return hmsSecretSchema.parse(JSON.parse(result.SecretString || ''));
}

async function exactCandidate() {
  const candidatePath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candidatePath) return '';
  const value = JSON.parse(await readFile(candidatePath, 'utf8'));
  return String(value.value || value.confirmation || value.confirmationNumber || '').trim();
}

async function visibleClick(page, label, { hover = false } = {}) {
  return page.evaluate(({ label: expected, hover: doHover }) => {
    const selectors = '.x-menu-item-text,.x-btn-inner,.x-tab-inner,.x-tab,a,button,span';
    const nodes = [...document.querySelectorAll(selectors)];
    const node = nodes.find((item) => {
      if ((item.textContent || '').trim() !== expected) return false;
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < innerWidth && rect.top < innerHeight &&
        style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!node) return false;
    if (doHover) {
      node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }
    node.click();
    return true;
  }, { label, hover });
}

async function clickVisibleComponent(page, itemId) {
  const id = await page.evaluate((wanted) => {
    const item = window.Ext?.ComponentQuery?.query(`[itemId=${wanted}]`)?.[0] ||
      window.Ext?.ComponentQuery?.query(`#${wanted}`)?.[0];
    const dom = item?.getEl?.()?.dom;
    if (!dom) return '';
    const rect = dom.getBoundingClientRect();
    const style = getComputedStyle(dom);
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= innerWidth || rect.top >= innerHeight || style.visibility === 'hidden' || style.display === 'none') return '';
    return dom.id || '';
  }, itemId);
  if (!id) return false;
  const target = page.locator(`#${id}`).first();
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click();
  return true;
}

async function expandVisibleTreeNode(page, label) {
  const row = page.locator('tr.x-grid-row').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
  if (!(await row.isVisible().catch(() => false))) return false;
  const expander = row.locator('img.x-tree-expander, img.x-tree-elbow-img').first();
  if (!(await expander.isVisible().catch(() => false))) return false;
  const cls = await expander.getAttribute('class').catch(() => '');
  if (!/plus/.test(String(cls))) return true;
  await expander.click();
  await page.waitForTimeout(2500);
  return true;
}

async function menuPath(page, labels) {
  for (let i = 0; i < labels.length; i += 1) {
    if (i === 0) {
      const more = await visibleClick(page, 'More');
      if (more) await page.waitForTimeout(800);
    }
    const clicked = await visibleClick(page, labels[i], { hover: true });
    if (!clicked) throw new Error(`visible menu item unavailable: ${labels[i]}`);
    if (i < labels.length - 1) await expandVisibleTreeNode(page, labels[i]);
    await page.waitForTimeout(i < labels.length - 1 ? 1600 : 3000);
  }
}

async function login(page, value) {
  await page.goto(value.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[name=userid],input[name=username],input[name=j_username]').first().fill(value.username);
  await page.locator('input[name=password]').fill(value.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
      await page.locator('input[name=password]').press('Enter');
    }),
  ]);
  await page.waitForTimeout(8_000);
  if (!/COMMON/i.test(page.url())) throw new Error('login did not reach HMS COMMON');
}

async function openGuestStay(page, confirmation) {
  await menuPath(page, ['Front Desk', 'Guest Stay']);
  const field = page.locator('input[placeholder*="Search by Name, Confirmation" i]').first();
  if (confirmation && (await field.count())) {
    await field.fill(confirmation);
    await field.press('Enter');
  } else if (confirmation) {
    await page.evaluate((value) => {
      const fields = [...(window.Ext?.ComponentQuery?.query('textfield,field') || [])];
      const target = fields.find((item) => /confirmation/i.test(String(item.name || item.itemId || item.fieldLabel || '')));
      if (target?.setValue) target.setValue(value);
    }, confirmation);
  }
  await visibleClick(page, 'Run');
  await page.waitForTimeout(12_000);
  const row = page.locator('.x-grid-row,.x-grid3-row').filter({ visible: true }).first();
  if (await row.count()) await row.dblclick({ timeout: 10_000 });
  await page.waitForTimeout(10_000);
}

async function clickVisibleTab(page, label) {
  const clicked = await visibleClick(page, label);
  if (!clicked) return false;
  await page.waitForTimeout(8_000);
  return true;
}

async function screenSummary(page) {
  return page.evaluate(() => {
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1600);
    const visibleText = (label) => [...document.querySelectorAll('.x-tab,.x-tab-inner,.x-btn-inner,.x-menu-item-text,a,button,span')].some((node) => {
      if ((node.textContent || '').trim() !== label) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      urlPath: (() => { try { return new URL(location.href).pathname.slice(0, 100); } catch { return ''; } })(),
      title: (document.title || '').slice(0, 100),
      bodySha256: crypto.subtle ? null : null,
      bodySample: body.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]').replace(/\b\d{7,}\b/g, '[n]'),
      visibleRateDetails: visibleText('Rate Details'),
      visibleDocuments: visibleText('Documents'),
      visibleEvents: visibleText('Events'),
      visibleEventReservations: visibleText('Event Reservations'),
      activeTabs: [...document.querySelectorAll('.x-tab-strip-active,.x-tab-active,.x-tab')]
        .map((node) => (node.textContent || '').trim()).filter(Boolean).slice(0, 20),
    };
  });
}

async function visibleLabelDebug(page, labels) {
  if (process.env.HMS_ROLE_GATE_DEBUG !== '1') return undefined;
  return page.evaluate((wanted) => ({
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    components: [...(window.Ext?.ComponentQuery?.query('textfield,field,treepanel,gridpanel,button,menu') || [])]
      .slice(0, 80)
      .map((item) => {
        const readNumber = (method) => {
          try {
            const value = item[method]?.();
            return Number.isFinite(Number(value)) ? Number(value) : 0;
          } catch { return 0; }
        };
        return {
        itemId: String(item.itemId || '').slice(0, 80),
        id: String(item.id || item.getId?.() || '').slice(0, 100),
        name: String(item.name || '').slice(0, 80),
        text: String(item.text || item.fieldLabel || item.title || '').slice(0, 120),
        cls: String(item.cls || item.iconCls || '').slice(0, 120),
        handler: typeof item.handler === 'function' || Boolean(item.handler?.fn),
        hasMenu: Boolean(item.menu),
        hidden: Boolean(item.hidden),
        rendered: Boolean(item.rendered),
        x: readNumber('getX'),
        y: readNumber('getY'),
        width: readNumber('getWidth'),
        height: readNumber('getHeight'),
        };
      }),
    labels: wanted.map((label) => ({
    label,
    matches: [...document.querySelectorAll('*')]
      .filter((node) => (node.textContent || '').trim() === label)
      .slice(0, 20)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          tag: node.tagName,
          className: String(node.className || '').slice(0, 180),
          id: node.id || '',
          role: node.getAttribute('role') || '',
          aria: node.getAttribute('aria-label') || '',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          outer: node.outerHTML.slice(0, 500),
        };
      }),
    })),
  }), labels);
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused: HMS_DISCOVERY_ALLOW_LIVE=1 required');
  if (!ALLOWED.has(TOOL)) throw new Error('HMS_ROLE_GATE_TOOL must be A1, DOC, or A7');
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  const value = await secret();
  const origin = new URL(value.loginUrl).origin;
  const confirmation = TOOL === 'A7' ? '' : await exactCandidate();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: OUT, size: { width: 1600, height: 1000 } },
  });
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (!requestUrl.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send|resend)/i.test(new URL(requestUrl).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  let summary = null;
  let debug = undefined;
  try {
    await login(page, value);
    debug = await visibleLabelDebug(page, ['More', 'Group Sales', 'Front Desk', 'Guest Stay', 'Events']);
    await clickVisibleComponent(page, 'appheadericon');
    await page.waitForTimeout(1200);
    if (TOOL === 'A7') {
      // Group Sales is sometimes already painted in the Start Center menu;
      // hover the visible item to reveal its submenu, then leave it painted.
      const openedMore = await visibleClick(page, 'More');
      if (openedMore) await page.waitForTimeout(800);
      const groupSales = await visibleClick(page, 'Group Sales', { hover: true });
      if (!groupSales) throw new Error('visible Group Sales menu item unavailable');
      await expandVisibleTreeNode(page, 'Group Sales');
      await page.waitForTimeout(6_000);
    } else {
      await openGuestStay(page, confirmation);
      if (TOOL === 'DOC') await clickVisibleTab(page, 'Documents');
      if (TOOL === 'A1') await visibleClick(page, 'Rate Details');
      await page.waitForTimeout(8_000);
    }
    await page.waitForTimeout(12_000);
    summary = await screenSummary(page);
    if (process.env.HMS_ROLE_GATE_DEBUG === '1') {
      debug = { before: debug, after: await visibleLabelDebug(page, ['More', 'Group Sales', 'Front Desk', 'Guest Stay', 'Events']) };
    }
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  const files = (await readdir(OUT)).filter((file) => file.endsWith('.webm'));
  if (files.length === 0) throw new Error('recorded video missing');
  const source = path.join(OUT, files[0]);
  const full = path.join(OUT, `${TOOL}.full.webm`);
  if (source !== full) await copyFile(source, full);
  const video = await readFile(full);
  const metadata = {
    schemaVersion: 1,
    tool: TOOL,
    capturedAt: new Date().toISOString(),
    method: 'playwright-recordVideo-full-path',
    writeRoutesBlocked: true,
    forcedControls: false,
    stitchedFrames: false,
    video: { path: full, bytes: video.byteLength, sha256: createHash('sha256').update(video).digest('hex') },
    screen: summary,
    ...(debug ? { debug } : {}),
  };
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(OUT, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 }));
  process.stdout.write(`${JSON.stringify({ tool: TOOL, out: OUT, videoBytes: video.byteLength, videoSha256: metadata.video.sha256, screen: summary })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${scrub(error?.message || error)}\n`);
  process.exit(1);
});
