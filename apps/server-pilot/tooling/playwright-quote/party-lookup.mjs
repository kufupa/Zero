import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit } from './audit.mjs';
import { login, playwright, readSecret } from './fetch-quote.mjs';

const KINDS = ['organization', 'bookingAgency', 'guest', 'arAccount'];
const KIND_SET = new Set(KINDS);
const KIND_FIELDS = {
  organization: ['organizationName', 'externalOrganizationId'],
  bookingAgency: ['bookingAgencyName', 'iataNumber'],
  arAccount: ['arAccountName'],
  guest: [
    'profileId',
    'lastName',
    'firstName',
    'email',
    'phone',
    'postalCode',
    'loyaltyProgramNumber',
    'rewardsNumber',
  ],
};

function filled(value) {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return String(value).trim().length > 0;
}

export const BORROWED_CLOSE_OWNER = false;
export const CONNECT_MS = 25000;

export function toolbarQueryOrder(count) {
  const n = Number(count) || 0;
  return Array.from({ length: n }, (_, i) => n - 1 - i);
}

export function windowTitleRe(kind) {
  return {
    organization: /Organizations/,
    bookingAgency: /Booking Agencies/,
    arAccount: /A\/R/,
    guest: /Guest Search/,
  }[kind];
}

export function dialogRunNames(kind) {
  if (kind === 'guest') return [/^Search$/];
  return [/^Run$/];
}

export function nameFieldsForKind(kind) {
  return {
    organization: ['ff_companyname', 'organizationname'],
    bookingAgency: ['ff_travelagencyname', 'bookingagencyname'],
    arAccount: ['ff_accountname', 'accountname', 'araccountname'],
    guest: ['lastname'],
  }[kind] ?? [];
}

export function isLookupColumnLabel(value) {
  return /^(name|organization id|booking agency name|iata\/reference number|\(default\))$/i.test(String(value || '').trim());
}

export function rowsMatchingQuery(rows = [], needle) {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const name = String(row.displayName || '').toLowerCase();
    const id = String(row.nativeId || '').toLowerCase();
    return name.includes(q) || id === q || id.includes(q);
  });
}

export function validateRequest(request) {
  const issues = [];
  if (!request || typeof request !== 'object') return ['request'];
  if (!KIND_SET.has(request.kind)) issues.push('kind');
  const query = request.query && typeof request.query === 'object' ? request.query : null;
  if (!query) {
    issues.push('query');
    return issues;
  }
  const allowed = KIND_FIELDS[request.kind] ?? [];
  const usable = allowed.some((key) => filled(query[key]));
  if (!usable) issues.push('query');
  return issues;
}

export function classifyOutcome(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return { outcome: 'no_match', candidates: [] };
  if (list.length === 1) return { outcome: 'resolved', candidates: list };
  return { outcome: 'ambiguous', candidates: list };
}

export function applyScreenshotContract(result) {
  const needsShot = ['resolved', 'ambiguous', 'no_match'].includes(result?.outcome);
  const criteria = result?.screenshots?.criteria;
  const results = result?.screenshots?.results;
  if (needsShot && (!criteria || !results)) {
    return {
      ...result,
      outcome: 'execution_failure',
      issues: [...(result.issues ?? []), { code: 'LOOKUP_SCREENSHOT_MISSING' }],
    };
  }
  return result;
}

export function resultEnvelope(partial = {}) {
  return {
    outcome: 'execution_failure',
    candidates: [],
    associationEffects: {},
    screenshots: {},
    ...partial,
  };
}

async function menu(page, names) {
  await page.locator('a.app-menu-trigger:visible').click();
  for (const name of names) {
    await page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
}

async function clickLov(page, field) {
  await page.locator(`input[name="${field}"]:visible`).locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger').click();
}

async function dismissUnsaved(page) {
  const cancel = page.locator('.x-window:visible').getByRole('button', { name: 'Cancel', exact: true });
  if (await cancel.count()) await cancel.click().catch(() => {});
  const no = page.getByRole('button', { name: /^No$/ }).first();
  if (await no.count()) await no.click().catch(() => {});
}

export function rowFromStoreData(data = {}) {
  const nativeId = String(
    data.companyid ?? data.organizationid ?? data.profileid ?? data.travelagencyid ?? data.accountid ?? data.id ?? '',
  );
  const displayName = String(
    data.companyname
    ?? data.organizationname
    ?? data.travelagencyname
    ?? data.accountname
    ?? data.name
    ?? [data.lastname, data.firstname].filter(Boolean).join(', ')
    ?? '',
  );
  return {
    nativeId,
    displayName,
    matchedOn: Object.keys(data).slice(0, 12),
  };
}

export function storeRowsForKind(kind, records = []) {
  const idOf = {
    organization: (d) => d.companyid ?? d.organizationid,
    bookingAgency: (d) => d.travelagencyid,
    arAccount: (d) => d.accountid,
    guest: (d) => d.profileid ?? d.guestid ?? d.id,
  }[kind];
  return records
    .filter((data) => data && (!idOf || idOf(data) != null && String(idOf(data)).length > 0))
    .map((data) => ({ ...rowFromStoreData(data), matchedOn: ['store'] }))
    .filter((row) => row.nativeId && row.displayName);
}

async function readExtStoreRows(page, kind) {
  const records = await page.evaluate(() => {
    if (typeof Ext === 'undefined') return [];
    const query = (sel) => {
      try { return Ext.ComponentQuery.query(sel) || []; } catch { return []; }
    };
    const wins = query('window').filter((w) => !w.isVisible || w.isVisible());
    const titled = wins.find((w) => /Organization|Booking|A\/R|Guest/i.test(String(w.title || w.header?.title || '')));
    const root = titled || wins.at(-1);
    const grids = root?.query ? root.query('grid, readonlygrid') : [...query('grid'), ...query('readonlygrid')];
    const out = [];
    for (const grid of grids || []) {
      const store = grid.getStore?.() || grid.store;
      if (!store?.getRange) continue;
      for (const rec of store.getRange()) {
        out.push(rec.data || (rec.getData && rec.getData()) || {});
      }
    }
    return out;
  }).catch(() => []);
  return storeRowsForKind(kind, records);
}

async function lookupWindow(page, kind) {
  const re = windowTitleRe(kind);
  const named = page.locator('.x-window:visible').filter({ hasText: re });
  if (re && await named.count()) return named.last();
  return page.locator('.x-window:visible').last();
}

async function fillExt(locator, value) {
  if (!(await locator.count())) return false;
  const field = locator.first();
  await field.click({ timeout: 2000 }).catch(() => {});
  try {
    await field.fill(String(value), { timeout: 2500 });
  } catch {
    await field.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const id = el.id?.replace(/-inputEl$/, '');
      if (typeof Ext !== 'undefined' && id && Ext.getCmp(id)?.setValue) Ext.getCmp(id).setValue(v);
    }, String(value)).catch(() => {});
  }
  const got = await field.inputValue().catch(() => '');
  return String(got).toLowerCase().includes(String(value).toLowerCase().slice(0, 8));
}

async function applyLookupFilter(page, kind, value) {
  if (!filled(value)) return;
  const win = await lookupWindow(page, kind);
  for (const name of nameFieldsForKind(kind)) {
    await fillExt(win.locator(`input[name="${name}"]:visible`), value);
  }
  const toolbar = win.locator('.x-toolbar input[type="text"]:visible');
  const n = await toolbar.count();
  for (const i of toolbarQueryOrder(n)) {
    const box = toolbar.nth(i);
    const current = await box.inputValue().catch(() => '');
    if (isLookupColumnLabel(current)) continue;
    const combo = await box.evaluate((el) => /combo/i.test(el.className || '') || /combo/i.test(el.parentElement?.className || '')).catch(() => false);
    if (combo) continue;
    const ok = await fillExt(box, value);
    if (ok) {
      await box.press('Enter').catch(() => {});
      break;
    }
  }
  for (const name of dialogRunNames(kind)) {
    const btn = win.getByRole('button', { name });
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }
  await page.waitForTimeout(1200);
}

const GRID_HEADER_RE = /^(organization id|name|guest id|account|iata\/reference number|booking agency name|address|city|country|external id|last name|first name|second last name|restricted reason|email type|email address|contact last name)$/i;

export function cellsToRow(cells = [], { kind } = {}) {
  const raw = [...cells].map((c) => String(c ?? '').replace(/\s+/g, ' ').trim());
  const filledCells = raw.filter(Boolean);
  if (!filledCells.length) return null;
  if (filledCells.every((c) => c.endsWith(':'))) return null;
  if (filledCells.some((c) => c.endsWith(':')) && !filledCells.some((c) => /\d/.test(c))) return null;
  if (GRID_HEADER_RE.test(raw[0]) && (raw.length < 2 || GRID_HEADER_RE.test(raw[1]))) return null;
  if (kind === 'guest') {
    const nativeId = raw[0];
    const last = raw[2] || '';
    const first = raw[4] || '';
    const displayName = [last, first].filter(Boolean).join(', ') || last || nativeId;
    if (!nativeId || nativeId.endsWith(':')) return null;
    return { nativeId, displayName, matchedOn: ['dom'] };
  }
  const idCol = raw[0] || '';
  const nameCol = raw[1] || '';
  const displayName = nameCol || idCol;
  const nativeId = idCol || nameCol;
  if (!nativeId || !displayName) return null;
  return { nativeId, displayName, matchedOn: ['dom'] };
}

async function waitLookupIdle(page) {
  const deadline = Date.now() + 60000;
  let sawBusy = false;
  while (Date.now() < deadline) {
    const busy = await page.getByText(/Processing request/i).count();
    if (busy) sawBusy = true;
    const rows = await page.locator('.x-window:visible .x-grid-view .x-grid-row, .x-window:visible .x-grid-item').count();
    if (sawBusy && !busy) return;
    if (!busy && rows > 0 && sawBusy) return;
    await page.waitForTimeout(500);
  }
}

async function readVisibleGrid(page, kind) {
  const fromStore = await readExtStoreRows(page, kind);
  if (fromStore.length) return fromStore;
  const dialog = page.locator('.x-window:visible').filter({ hasText: /Select a record and click OK|Search Criteria|Guest Search/i }).last();
  if (await dialog.count()) {
    const locators = [
      dialog.locator('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row'),
      dialog.locator('.x-grid-item'),
    ];
    for (const loc of locators) {
      const n = Math.min(await loc.count(), 80);
      const rows = [];
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.locator('input').count()) continue;
        const line = await el.evaluate((node) => (
          [...node.querySelectorAll('td, .x-grid-cell')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim())
        )).catch(() => []);
        const row = cellsToRow(line, { kind });
        if (row) rows.push(row);
      }
      if (rows.length) return rows;
    }
  }
  return page.evaluate((kindArg) => {
    const visible = (el) => !!el?.getClientRects?.().length && getComputedStyle(el).visibility !== 'hidden';
    const wins = [...document.querySelectorAll('.x-window')].filter(visible);
    const win = wins.find((w) => /Organizations|Booking|A\/R|Guest Search|Select a record/i.test(w.innerText || '')) || wins.at(-1);
    if (!win) return [];
    const headerRe = /^(organization id|name|guest id|account|iata\/reference number|booking agency name)$/i;
    const rows = [];
    const dataRows = win.querySelectorAll('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row, .x-grid-item');
    for (const tr of dataRows) {
      if (tr.closest('.x-grid-header-ct')) continue;
      if (tr.querySelector('input')) continue;
      const cells = [...tr.querySelectorAll('td, .x-grid-cell')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
      const filled = cells.filter(Boolean);
      if (!filled.length) continue;
      if (filled.every((c) => c.endsWith(':'))) continue;
      if (headerRe.test(cells[0] || '')) continue;
      if (kindArg === 'guest') {
        const nativeId = cells[0] || '';
        if (!nativeId || nativeId.endsWith(':')) continue;
        const displayName = [cells[2], cells[4]].filter(Boolean).join(', ') || cells[2] || nativeId;
        rows.push({ nativeId, displayName, matchedOn: ['table'] });
        continue;
      }
      const nativeId = cells[0] || cells[1] || '';
      const displayName = cells[1] || cells[0] || '';
      if (!nativeId || !displayName) continue;
      rows.push({ nativeId, displayName, matchedOn: ['table'] });
    }
    return rows;
  }, kind);
}

function queryNeedle(request) {
  const q = request?.query || {};
  return q.organizationName || q.bookingAgencyName || q.arAccountName || q.iataNumber
    || q.externalOrganizationId || q.lastName || '';
}

export function classifyKindRows(kind, rows, request) {
  const tagged = rows.map((row) => ({ ...row, kind }));
  const needle = queryNeedle(request);
  const narrowed = rowsMatchingQuery(tagged, needle);
  if (needle && narrowed.length === 0) return classifyOutcome([]);
  return classifyOutcome(narrowed.length ? narrowed : tagged);
}

async function searchKind(page, request) {
  if (await page.getByText(/Cannot retrieve profile:\s*External system/i).count()) {
    return { outcome: 'external_system_unavailable', candidates: [] };
  }
  if (request.kind === 'organization') {
    await clickLov(page, 'company');
    const name = request.query.organizationName;
    const ext = request.query.externalOrganizationId;
    if (filled(ext) && await page.locator('input[name="externalorganizationid"]:visible').count()) {
      await fillExt(page.locator('input[name="externalorganizationid"]:visible'), ext);
      await applyLookupFilter(page, 'organization', ext);
    } else {
      await applyLookupFilter(page, 'organization', name);
    }
    if (await page.getByText(/Cannot retrieve profile:\s*External system/i).count()) {
      return { outcome: 'external_system_unavailable', candidates: [] };
    }
    return classifyKindRows('organization', await readVisibleGrid(page, 'organization'), request);
  }
  if (request.kind === 'bookingAgency') {
    await clickLov(page, 'ta1');
    const name = request.query.bookingAgencyName;
    const iata = request.query.iataNumber;
    if (filled(iata)) {
      const iataField = page.locator('.x-window:visible input[name="ff_iatanumber"]:visible, .x-window:visible input[name="iatanumber"]:visible');
      await fillExt(iataField, iata);
      await applyLookupFilter(page, 'bookingAgency', iata);
    } else {
      await applyLookupFilter(page, 'bookingAgency', name);
    }
    if (await page.getByText(/Cannot retrieve profile:\s*External system/i).count()) {
      return { outcome: 'external_system_unavailable', candidates: [] };
    }
    return classifyKindRows('bookingAgency', await readVisibleGrid(page, 'bookingAgency'), request);
  }
  if (request.kind === 'arAccount') {
    await clickLov(page, 'araccountname');
    await applyLookupFilter(page, 'arAccount', request.query.arAccountName);
    return classifyKindRows('arAccount', await readVisibleGrid(page, 'arAccount'), request);
  }
  await page.locator('[data-qtip="Guest Search"], [data-qtip="Search Guest"]').first().click({ timeout: 5000 }).catch(async () => {
    await page.getByRole('button', { name: /Guest Search/i }).first().click();
  });
  const guestWin = await lookupWindow(page, 'guest');
  if (filled(request.query.lastName)) await fillExt(guestWin.locator('input[name="lastname"]:visible'), request.query.lastName);
  if (filled(request.query.firstName)) await fillExt(guestWin.locator('input[name="firstname"]:visible'), request.query.firstName);
  if (filled(request.query.email)) await fillExt(guestWin.locator('input[name="emailaddress"]:visible'), request.query.email);
  if (filled(request.query.phone)) await fillExt(guestWin.locator('input[name="phonenumber"]:visible'), request.query.phone);
  const internal = guestWin.getByText(/Internal Search/);
  if (await internal.count()) await internal.first().click().catch(() => {});
  const searchBtn = guestWin.getByRole('button', { name: /^Search$/ });
  const searchText = guestWin.getByText(/^Search$/);
  const searchAnchor = guestWin.locator('a').filter({ hasText: /^Search$/ });
  if (await searchBtn.count()) await searchBtn.first().click().catch(() => {});
  else if (await searchAnchor.count()) await searchAnchor.last().click().catch(() => {});
  else if (await searchText.count()) await searchText.last().click().catch(() => {});
  else await applyLookupFilter(page, 'guest', request.query.lastName);
  await waitLookupIdle(page);
  const profileErr = page.getByText(/Cannot retrieve profile:/i);
  if (await profileErr.count()) {
    const msg = await profileErr.first().innerText().catch(() => '');
    if (/required/i.test(msg)) return { outcome: 'input_gap', candidates: [] };
    return { outcome: 'external_system_unavailable', candidates: [] };
  }
  return classifyKindRows('guest', await readVisibleGrid(page, 'guest'), request);
}

export async function lookupParty({ requestPath, outputDir, env = process.env } = {}) {
  process.umask(0o077);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const issues = validateRequest(request);
  if (issues.length) {
    return applyScreenshotContract(resultEnvelope({ outcome: 'input_gap', issues: issues.map((path) => ({ code: 'INPUT_GAP', path })) }));
  }
  if (!env.HMS_STAGEHAND_CDP_URL || env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') {
    return resultEnvelope({
      outcome: 'execution_failure',
      issues: [{ code: 'EXECUTION_FAILURE', path: 'cdp', reason: 'borrowed CDP required' }],
    });
  }
  const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)), '.private/pms-pipeline/party-lookup/out');
  const outputRoot = resolve(outputDir ?? root);
  if (outputRoot !== root && !outputRoot.startsWith(`${root}/`)) throw new Error('OUTPUT_MUST_BE_PRIVATE_PARTY_LOOKUP_DIRECTORY');
  const directory = join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const url = new URL(env.HMS_STAGEHAND_CDP_URL);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PRIVATE_CDP_REQUIRED');
  }
  const secret = await readSecret(env);
  let browser;
  let context;
  let page;
  let audit;
  let result;
  try {
    browser = await Promise.race([
      playwright().chromium.connectOverCDP(url.href, { timeout: CONNECT_MS }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), CONNECT_MS + 2000)),
    ]);
    context = await Promise.race([
      browser.newContext({
        ignoreHTTPSErrors: true,
        acceptDownloads: false,
        serviceWorkers: 'block',
        viewport: { width: 1280, height: 720 },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CONTEXT_TIMEOUT')), CONNECT_MS)),
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    audit = await createAudit(directory, { trace: false });
    await login(page, secret);
    await audit.start(page, [secret.password, secret.username, secret.loginUrl]);
    await menu(page, ['Front Desk', 'Guest Stay']);
    await page.locator('[data-qtip="New Record (Ctrl+N)"]').click();
    await page.locator('input[name="company"]:visible').waitFor();
    await audit.checkpoint('criteria');
    const found = await searchKind(page, request);
    await audit.checkpoint('results');
    await dismissUnsaved(page);
    result = applyScreenshotContract(resultEnvelope({
      ...found,
      screenshots: {
        criteria: 'screenshots/criteria.png',
        results: 'screenshots/results.png',
      },
      evidenceDirectory: directory,
    }));
  } catch (error) {
    result = resultEnvelope({
      outcome: 'execution_failure',
      issues: [{ code: 'EXECUTION_FAILURE', path: 'run', reason: String(error.message || error).slice(0, 180) }],
      evidenceDirectory: directory,
    });
    if (page) await dismissUnsaved(page).catch(() => {});
  } finally {
    try { await Promise.race([audit?.finish?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* keep result */ }
    try { await context?.close(); } catch { /* detach anyway */ }
    if (BORROWED_CLOSE_OWNER) {
      try { await browser.close(); } catch { /* owner stays */ }
    } else if (browser) {
      try { browser.disconnect(); } catch { /* owner stays */ }
    }
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node party-lookup.mjs --request <private.json> --output <.private/pms-pipeline/party-lookup/out>');
  } else {
    const requestPath = args[args.indexOf('--request') + 1];
    const outputDir = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
    if (!args.includes('--request') || !requestPath) {
      console.error('Required: --request <path>');
      process.exitCode = 2;
    } else {
      lookupParty({ requestPath, outputDir }).then((result) => {
        console.log(JSON.stringify(result));
        process.exit(['resolved', 'ambiguous', 'no_match', 'input_gap', 'external_system_unavailable'].includes(result.outcome) ? 0 : 2);
      }).catch((error) => {
        console.error(error.message);
        process.exit(2);
      });
    }
  }
}
