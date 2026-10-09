#!/usr/bin/env node
// Read-only Guest Stay code mining. Search + row open only. Never save/cancel.
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';

const FIELD_NAMES = [
  'confirmationnumber',
  'status',
  'arrivaldate',
  'departuredate',
  'roomtype',
  'rateplan',
  'track',
  'guaranteetype',
  'sourceofbusiness',
  'sourceofbusinessdesc',
  'marketsegment',
  'company',
  'companyname',
  'bookingagency',
  'channel',
  'ta1',
  'bookingagencyname',
];

const MUTATE_PATH = /save|delete|cancel|duplicate|checkin|checkout|crs/i;
const GOV_RE = /dep(t|artment)|ministry|municipal|government|province|sapo|sars|saps/i;
const CAP = 40;
const PAUSE_MS = 2000;
const PER_RESERVATION_MS = 90_000;
const CONNECT_MS = 25000;

function repoRoot() {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function outDir() {
  return join(repoRoot(), '.private/luna-mvp/code-mining');
}

function parseArgs(argv) {
  const index = argv.indexOf('--input');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith('--')) {
    return { ok: false, error: 'Required: --input <path>' };
  }
  const capIndex = argv.indexOf('--cap');
  const capRaw = capIndex === -1 ? undefined : argv[capIndex + 1];
  const cap = capRaw && !capRaw.startsWith('--') ? Number(capRaw) : CAP;
  return { ok: true, input: value, cap: Number.isFinite(cap) && cap > 0 ? Math.min(100, cap) : CAP };
}

async function readIdentity(page) {
  return page.evaluate((names) => {
    const selected = (name) => {
      const select = document.querySelector(`select[name="${name}"]`);
      if (select && select.selectedIndex >= 0) {
        return (select.options[select.selectedIndex]?.text || '').trim();
      }
      const input = document.querySelector(`input[name="${name}"]`);
      return (input?.value || '').trim();
    };
    const out = {};
    for (const name of names) out[name] = selected(name);
    return out;
  }, FIELD_NAMES);
}

function classifyPartyClass(fields) {
  const agency = [fields.bookingagency, fields.bookingagencyname, fields.ta1]
    .map((value) => String(value || '').trim())
    .find(Boolean);
  if (agency) return 'agency';
  const companyBlob = `${fields.company || ''} ${fields.companyname || ''}`;
  if (GOV_RE.test(companyBlob)) return 'government';
  if (String(fields.company || '').trim()) return 'organization';
  return 'private';
}

async function openTarget(page, confirmation) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  if (await search.count()) {
    await search.click();
    await search.fill(confirmation);
  }
  await page.evaluate((conf) => {
    const Ext = window.Ext;
    const fields = Ext?.ComponentQuery?.query('textfield, field') ?? [];
    for (const field of fields) {
      const blob = String(field.name ?? field.itemId ?? field.fieldLabel ?? '');
      if (/^(ff_confirmationnumber|search)$/i.test(blob) && field.setValue) field.setValue(conf);
    }
  }, confirmation);
  const searchWait = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /OSRESS\.search/i.test(response.url()),
    { timeout: 20000 },
  ).catch(() => null);
  if (await search.count()) await search.press('Enter');
  const run = page.getByRole('button', { name: 'Run', exact: true });
  if (await run.count()) await run.click().catch(() => {});
  await searchWait;
  await page.waitForTimeout(1200);
  const opened = await page.evaluate((conf) => {
    const Ext = window.Ext;
    const grids = Ext?.ComponentQuery?.query('grid, gridpanel, readonlygrid') ?? [];
    const summary = { grids: grids.length, stores: [] };
    for (const grid of grids) {
      const store = grid.getStore?.();
      const count = store?.getCount?.() ?? 0;
      const sample = store?.getAt?.(0);
      const keys = sample ? Object.keys(sample.data || {}).filter((key) => !/name|first|last|guest|email|phone|address/i.test(key)).slice(0, 20) : [];
      summary.stores.push({ count, keys });
      if (!store?.getCount) continue;
      const records = store.getRange?.() ?? [];
      const hits = records
        .map((record, index) => ({
          index,
          confirmation: String(record.get?.('confirmationnumber') ?? record.data?.confirmationnumber ?? ''),
        }))
        .filter((row) => row.confirmation === conf);
      if (hits.length !== 1) continue;
      const node = grid.getView?.()?.getNode?.(hits[0].index);
      if (!node) continue;
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { opened: 'search-hit', summary };
    }
    return { opened: 'not-found', summary };
  }, confirmation);
  if (opened.opened === 'search-hit') return 'search-hit';
  const rows = page.locator('.x-grid-row, .x-grid3-row').filter({ hasText: confirmation });
  const n = await rows.count();
  if (n === 0) return `not-found:${JSON.stringify(opened.summary)}`;
  if (n !== 1) return `ambiguous:${n}`;
  await rows.first().dblclick();
  return 'search-hit';
}

async function returnToList(page) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  if (await search.count()) {
    await search.click().catch(() => {});
    return;
  }
  await openGuestStayScreen(page);
}

function partyClassCounts(rows) {
  const fields = ['track', 'sourceofbusinessdesc', 'guaranteetype', 'rateplan', 'roomtype'];
  const classes = ['agency', 'government', 'organization', 'private'];
  const table = {};
  for (const kind of classes) {
    table[kind] = { n: 0, fields: {} };
    for (const field of fields) table[kind].fields[field] = new Map();
  }
  for (const row of rows) {
    if (row.outcome !== 'read') continue;
    const kind = row.partyClass;
    if (!table[kind]) continue;
    table[kind].n += 1;
    for (const field of fields) {
      const value = String(row[field] || '').trim();
      if (!value) continue;
      const map = table[kind].fields[field];
      map.set(value, (map.get(value) || 0) + 1);
    }
  }
  return table;
}

function crosstabMarkdown(table) {
  const lines = [
    '# Booking code mining crosstab',
    '',
    'Codes and counts only. No guest names.',
    '',
    '| class | n | field | top | count | support |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [kind, block] of Object.entries(table)) {
    for (const [field, map] of Object.entries(block.fields)) {
      const ranked = [...map.entries()].sort((a, b) => b[1] - a[1]);
      const [top, count] = ranked[0] || [null, 0];
      const support = block.n ? count / block.n : 0;
      lines.push(`| ${kind} | ${block.n} | ${field} | ${top ?? ''} | ${count} | ${support.toFixed(2)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function loadDone(jsonlPath) {
  const done = new Set();
  let text = '';
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch {
    return done;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.confirmation) done.add(String(row.confirmation));
    } catch {
      /* skip bad line */
    }
  }
  return done;
}

async function loadCandidates(path, cap) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (row?.kind !== 'confirmation') continue;
    const value = String(row.value || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function installReadOnlyGuard(context) {
  return context.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const type = route.request().resourceType();
    if ((type === 'xhr' || type === 'fetch') && MUTATE_PATH.test(path)) {
      process.stdout.write(`abort_path=${path}\n`);
      await route.abort();
      return;
    }
    await route.continue();
  });
}

async function readOne(page, confirmation) {
  const opened = await openTarget(page, confirmation);
  if (String(opened).startsWith('not-found')) {
    return { confirmation, outcome: 'not_found', detail: String(opened).slice(0, 300) };
  }
  if (String(opened).startsWith('ambiguous')) {
    return { confirmation, outcome: 'ambiguous' };
  }
  await page.locator('input[name="confirmationnumber"]').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  const fields = await readIdentity(page);
  if (String(fields.confirmationnumber || '') !== confirmation) {
    return { confirmation, outcome: 'identity_mismatch' };
  }
  const partyClass = classifyPartyClass(fields);
  return {
    confirmation,
    outcome: 'read',
    partyClass,
    status: fields.status || '',
    arrivaldate: fields.arrivaldate || '',
    departuredate: fields.departuredate || '',
    roomtype: fields.roomtype || '',
    rateplan: fields.rateplan || '',
    track: fields.track || '',
    guaranteetype: fields.guaranteetype || '',
    sourceofbusiness: fields.sourceofbusiness || '',
    sourceofbusinessdesc: fields.sourceofbusinessdesc || '',
    marketsegment: fields.marketsegment || '',
    company: fields.company || '',
    companyname: fields.companyname || '',
    bookingagency: fields.bookingagency || fields.bookingagencyname || fields.ta1 || '',
    channel: fields.channel || '',
  };
}

async function writeCrosstab(dir, jsonlPath) {
  let text = '';
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch {
    text = '';
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  await writeFile(join(dir, 'crosstab.md'), crosstabMarkdown(partyClassCounts(rows)), { mode: 0o600 });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.umask(0o077);
  const dir = outDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const jsonlPath = join(dir, 'reservations.jsonl');
  const candidates = await loadCandidates(parsed.input, parsed.cap);
  const done = await loadDone(jsonlPath);
  const pending = candidates.filter((value) => !done.has(value));
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('PRIVATE_CDP_REQUIRED');
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: CONNECT_MS });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads: false,
    serviceWorkers: 'block',
    viewport: { width: 1600, height: 1000 },
  });
  await installReadOnlyGuard(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  let reads = 0;
  let failures = 0;
  try {
    await login(page, secret);
    const listSearch = page.waitForResponse(
      (response) => response.request().method() === 'POST' && /OSRESS\.search/i.test(response.url()),
      { timeout: 25000 },
    ).catch(() => null);
    await openGuestStayScreen(page);
    await page.getByPlaceholder(/Search by Name, Confirmation/i).first().waitFor({ timeout: 20000 });
    await listSearch;
    await page.waitForTimeout(1500);
    for (const confirmation of pending) {
      let row;
      try {
        row = await Promise.race([
          readOne(page, confirmation),
          delay(PER_RESERVATION_MS).then(() => ({ confirmation, outcome: 'timeout' })),
        ]);
      } catch (error) {
        row = { confirmation, outcome: 'execution_failure', error: String(error.message || error).slice(0, 180) };
      }
      if (row.outcome === 'read') reads += 1;
      else failures += 1;
      await appendFile(jsonlPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      process.stdout.write(`mined reads=${reads} other=${failures} remaining=${pending.length - reads - failures}\n`);
      await returnToList(page).catch(() => {});
      await delay(PAUSE_MS);
    }
  } finally {
    await writeCrosstab(dir, jsonlPath).catch(() => {});
    await context.close().catch(() => {});
    try {
      browser.disconnect();
    } catch {
      /* owner stays */
    }
  }
}

main().catch((error) => {
  const msg = String(error.message || error);
  process.stderr.write((/password|secret|cookie|jsessionid/i.test(msg) ? 'redacted_error' : msg.slice(0, 200)) + '\n');
  process.exit(1);
});
