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
// A lookup store loads 50 rows. A full store can hide more matches, so the result is marked truncated.
export const HMS_LOOKUP_PAGE_ROWS = 50;
// A search whose grid neither changed nor showed the busy mask within this window is not verified.
export const LOOKUP_CHANGE_WINDOW_MS = 15000;
// A store still busy after this long is a failed lookup, never an empty one.
export const LOOKUP_IDLE_TIMEOUT_MS = 60000;


export function lookupTruncated(loaded) {
  return Number(loaded) >= HMS_LOOKUP_PAGE_ROWS;
}

// The one normalization for every name comparison (read-back, row matching, ranking). The server keeps the same function in
// src/ai/party-match.ts, and a test holds the two equal. Accents and case fold. Letters and digits in any script are kept,
// and every other run (spacing, punctuation, apostrophes) becomes one space: Société matches Societe, Pick ’n Pay matches
// Pick n Pay.
export function matchKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True only when a filter input reads back the query that was typed into it. */
export function filterReadsBack(query, readBack) {
  const key = matchKey(query);
  return key.length > 0 && matchKey(readBack) === key;
}

/** The lookup's filter never reached the window, so its grid is not the query's. Fails closed: never no_match. */
export function filterNotApplied() {
  return {
    outcome: 'execution_failure',
    candidates: [],
    truncated: false,
    issues: [{ code: 'EXECUTION_FAILURE', path: 'filter', reason: 'filter_not_applied' }],
  };
}

/** The store never settled: HMS was still busy at the timeout. A grid read then is no answer, so it fails closed. */
export function lookupBusyTimeout() {
  return {
    outcome: 'execution_failure',
    candidates: [],
    truncated: false,
    issues: [{ code: 'EXECUTION_FAILURE', path: 'lookup', reason: 'lookup_busy_timeout' }],
  };
}

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
  const raw = String(needle || '').trim().toLowerCase();
  const wanted = matchKey(needle);
  if (!raw) return rows;
  return rows.filter((row) => {
    const name = matchKey(row.displayName);
    const id = String(row.nativeId || '').toLowerCase();
    return (wanted.length > 0 && name.includes(wanted)) || id === raw || id.includes(raw);
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
    truncated: false,
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

// Rows from the lookup's Ext store. `loaded` counts every record the store holds, before the id and name filter.
async function readExtStore(page, kind) {
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
  return { rows: storeRowsForKind(kind, records), loaded: records.length };
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
  return filterReadsBack(value, got);
}

// Fills the lookup's filter with value. True only when a filter input reads the query back, so no grid is read that the
// query did not reach. Filling never runs the search: runLookupFilter does that.
async function fillLookupFilter(page, kind, value) {
  if (!filled(value)) return false;
  const win = await lookupWindow(page, kind);
  let held = false;
  for (const name of nameFieldsForKind(kind)) {
    if (await fillExt(win.locator(`input[name="${name}"]:visible`), value)) held = true;
  }
  const toolbar = win.locator('.x-toolbar input[type="text"]:visible');
  const n = await toolbar.count();
  for (const i of toolbarQueryOrder(n)) {
    const box = toolbar.nth(i);
    const current = await box.inputValue().catch(() => '');
    if (isLookupColumnLabel(current)) continue;
    const combo = await box.evaluate((el) => /combo/i.test(el.className || '') || /combo/i.test(el.parentElement?.className || '')).catch(() => false);
    if (combo) continue;
    if (!(await fillExt(box, value))) continue;
    held = true;
    // Enter submits a toolbar query. When it cannot be pressed, the query never reached the store.
    if (!(await box.press('Enter').then(() => true, () => false))) return false;
    break;
  }
  return held;
}

// Runs the lookup's search through its Run control. False when the window has no Run control or the click fails: the
// search did not run, so nothing may be read from the grid. It returns as soon as the click lands. The completion watchers
// (armLookupRun) are armed before the click, so a quick answer is not missed.
async function runLookupFilter(page, kind) {
  const win = await lookupWindow(page, kind);
  for (const name of dialogRunNames(kind)) {
    const btn = win.getByRole('button', { name });
    if (!(await btn.count())) continue;
    return btn.first().click().then(() => true, () => false);
  }
  return false;
}

/** Decodes a URL or form body for matching. Text that does not decode is matched as it is. */
function decodedText(value) {
  const text = String(value ?? '');
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * True when a response's URL or body carries the query as whole words, in any spelling matchKey folds. Only the query's own
 * request carries it, so a response to another search or a background call never completes this one.
 */
function responseCarriesQuery(response, needle) {
  const wanted = matchKey(needle);
  if (!wanted) return false;
  let body = '';
  try {
    body = response.request().postData() ?? '';
  } catch {
    body = '';
  }
  return ` ${matchKey(`${decodedText(response.url())} ${decodedText(body)}`)} `.includes(` ${wanted} `);
}

/**
 * Arms the completion watchers for one Run click. Call it before the click, so an answer or a mask that lands during the
 * click is never missed. `run.status` is 'answered' once the store answered 200 and the body is in (the response line alone
 * is not yet the rows), 'failed' for any other answer, and 'none' when no answer carried the query before the timeout.
 * `run.maskSeen` is set when the "Processing request" mask shows at any moment after arming.
 */
function armLookupRun(page, needle) {
  const run = { status: 'pending', maskSeen: false };
  page.waitForResponse((response) => responseCarriesQuery(response, needle), { timeout: LOOKUP_IDLE_TIMEOUT_MS }).then(
    async (response) => {
      if (response.status() !== 200) {
        run.status = 'failed';
        return;
      }
      const failure = typeof response.finished === 'function'
        ? await response.finished().catch((error) => error || true)
        : null;
      run.status = failure ? 'failed' : 'answered';
    },
    () => {
      run.status = 'none';
    },
  );
  page.getByText(/Processing request/i).first()
    .waitFor({ state: 'visible', timeout: LOOKUP_IDLE_TIMEOUT_MS })
    .then(() => {
      run.maskSeen = true;
    }, () => {});
  return run;
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

/** The search could not be verified as run and settled. A failure, never no_match. */
export function filterNotVerified(detail) {
  return {
    outcome: 'execution_failure',
    candidates: [],
    truncated: false,
    issues: [{ code: 'EXECUTION_FAILURE', path: 'filter', reason: 'filter_not_verified', detail }],
  };
}

// The grid as a read shows it: the row count and each row's id and name. Two reads with the same key show the same grid.
export function gridKey(grid) {
  const rows = (grid?.rows ?? []).map((row) => `${row.nativeId}\u0001${row.displayName}`);
  return `${Number(grid?.loaded) || 0}\u0002${rows.join('\u0003')}`;
}

/**
 * Decides whether a lookup's grid answers the search that was just run. With `run`, armed before the click, the search is
 * settled once the store answered 200, the mask is gone, and two reads of the grid agree: an unchanged or empty grid is
 * then a valid answer. Without a store answer, the grid is settled when the mask showed and then cleared, or when it changed
 * from `before`, the grid read before the run. A mask still up at the timeout is busy. With no answer, no mask and no change
 * inside the window, the answer is not verified. It is never read as no match.
 */
export async function waitForFreshGrid(page, kind, before, {
  now = Date.now,
  timeoutMs = LOOKUP_IDLE_TIMEOUT_MS,
  changeWindowMs = LOOKUP_CHANGE_WINDOW_MS,
  pollMs = 500,
  read = readVisibleGrid,
  run = null,
} = {}) {
  const start = now();
  let sawBusy = false;
  let previous = null;
  while (now() - start < timeoutMs) {
    if (run?.status === 'failed') return 'answer_failed';
    const busy = await busyMaskVisible(page);
    if (busy || run?.maskSeen) sawBusy = true;
    if (run?.status === 'answered') {
      if (busy) {
        previous = null;
      } else {
        const key = gridKey(await read(page, kind));
        if (key === previous) return 'settled';
        previous = key;
      }
    } else {
      if (sawBusy && !busy) return 'settled';
      if (!sawBusy && gridKey(await read(page, kind)) !== before) return 'settled';
      if (!sawBusy && now() - start >= changeWindowMs) return 'not_verified';
    }
    await page.waitForTimeout(pollMs);
  }
  return sawBusy ? 'busy' : 'not_verified';
}

/**
 * True when a "Processing request" mask is on screen. A hidden mask is left over from an earlier load, not a search in
 * progress, so it never holds the lookup busy.
 */
async function busyMaskVisible(page) {
  const masks = page.getByText(/Processing request/i);
  const count = await masks.count();
  for (let i = 0; i < count; i += 1) {
    if (await masks.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function snapshotGrid(page, kind) {
  return gridKey(await readVisibleGrid(page, kind));
}

/** A row answers the query when its name contains the query (in any script), or its id is the query. */
export function rowAnswersQuery(row, needle) {
  const query = String(needle ?? '').trim();
  if (!query) return true;
  const wanted = matchKey(query);
  const byName = wanted.length > 0 && matchKey(row.displayName).includes(wanted);
  return byName || String(row.nativeId ?? '') === query;
}

/** True only when every row of a grid answers the query. One row that does not means the grid was not filtered. */
export function gridAnswersQuery(rows, needle) {
  return (rows ?? []).every((row) => rowAnswersQuery(row, needle));
}

// Reads the lookup's rows: the Ext store first, then the dialog grid, then any visible window table.
// `loaded` is how many rows the grid held, which decides truncation.
async function readVisibleGrid(page, kind) {
  const fromStore = await readExtStore(page, kind);
  if (fromStore.rows.length) return fromStore;
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
      if (rows.length) return { rows, loaded: n };
    }
  }
  return page.evaluate((kindArg) => {
    const visible = (el) => !!el?.getClientRects?.().length && getComputedStyle(el).visibility !== 'hidden';
    const wins = [...document.querySelectorAll('.x-window')].filter(visible);
    const win = wins.find((w) => /Organizations|Booking|A\/R|Guest Search|Select a record/i.test(w.innerText || '')) || wins.at(-1);
    if (!win) return { rows: [], loaded: 0 };
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
    return { rows, loaded: dataRows.length };
  }, kind);
}

function queryNeedle(request) {
  const q = request?.query || {};
  return q.organizationName || q.bookingAgencyName || q.arAccountName || q.iataNumber
    || q.externalOrganizationId || q.lastName || '';
}

/** Rows to outcome for one kind. Call only on a grid the query filtered; `loaded` is the grid's row count before the id filter. */
export function classifyKindRows(kind, rows, request, loaded = rows.length) {
  const tagged = rows.map((row) => ({ ...row, kind }));
  const needle = queryNeedle(request);
  const narrowed = rowsMatchingQuery(tagged, needle);
  const found = needle && narrowed.length === 0
    ? classifyOutcome([])
    : classifyOutcome(narrowed.length ? narrowed : tagged);
  return { ...found, truncated: lookupTruncated(loaded) };
}

// Reads the grid once the search ran and settled: the external-system banner first, then the rows. Every row must
// answer the query, or the grid is not the answer to this search.
async function readSettledGrid(page, kind, request, needle) {
  if (await page.getByText(/Cannot retrieve profile:\s*External system/i).count()) {
    return { outcome: 'external_system_unavailable', candidates: [], truncated: false };
  }
  const grid = await readVisibleGrid(page, kind);
  if (!gridAnswersQuery(grid.rows, needle)) return filterNotVerified('rows_do_not_answer_query');
  return classifyKindRows(kind, grid.rows, request, grid.loaded);
}

// One filtered lookup, fail-closed. `fill` puts the query into the window. The grid is read only after the search ran and
// settled. Any step that cannot be verified is a failure, never no_match.
async function filteredLookup(page, kind, request, fill) {
  const before = await snapshotGrid(page, kind);
  if (!(await fill())) return filterNotApplied();
  const needle = queryNeedle(request);
  // Armed before the Run click, so an answer that lands during the click is never missed.
  const run = armLookupRun(page, needle);
  if (!(await runLookupFilter(page, kind))) return filterNotVerified('run_not_clicked');
  const settled = await waitForFreshGrid(page, kind, before, { run });
  if (settled === 'busy') return lookupBusyTimeout();
  if (settled === 'answer_failed') return filterNotVerified('store_answer_failed');
  if (settled !== 'settled') return filterNotVerified('grid_not_refreshed');
  return readSettledGrid(page, kind, request, needle);
}

/** Searches one lookup kind by the request's query. Every answer comes from a verified, settled grid. */
export async function searchKind(page, request) {
  if (await page.getByText(/Cannot retrieve profile:\s*External system/i).count()) {
    return { outcome: 'external_system_unavailable', candidates: [], truncated: false };
  }
  if (request.kind === 'organization') {
    await clickLov(page, 'company');
    const name = request.query.organizationName;
    const ext = request.query.externalOrganizationId;
    const extField = page.locator('input[name="externalorganizationid"]:visible');
    if (filled(ext) && (await extField.count())) {
      return filteredLookup(page, 'organization', request, async () =>
        (await fillExt(extField, ext)) && (await fillLookupFilter(page, 'organization', ext)));
    }
    return filteredLookup(page, 'organization', request, () => fillLookupFilter(page, 'organization', name));
  }
  if (request.kind === 'bookingAgency') {
    await clickLov(page, 'ta1');
    const name = request.query.bookingAgencyName;
    const iata = request.query.iataNumber;
    const iataField = page.locator('.x-window:visible input[name="ff_iatanumber"]:visible, .x-window:visible input[name="iatanumber"]:visible');
    if (filled(iata)) {
      return filteredLookup(page, 'bookingAgency', request, async () =>
        (await fillExt(iataField, iata)) && (await fillLookupFilter(page, 'bookingAgency', iata)));
    }
    return filteredLookup(page, 'bookingAgency', request, () => fillLookupFilter(page, 'bookingAgency', name));
  }
  if (request.kind === 'arAccount') {
    await clickLov(page, 'araccountname');
    return filteredLookup(page, 'arAccount', request, () => fillLookupFilter(page, 'arAccount', request.query.arAccountName));
  }
  // Guest search: the grid is read only after the Search control was clicked and the grid settled.
  await page.locator('[data-qtip="Guest Search"], [data-qtip="Search Guest"]').first().click({ timeout: 5000 }).catch(async () => {
    await page.getByRole('button', { name: /Guest Search/i }).first().click();
  });
  const guestWin = await lookupWindow(page, 'guest');
  const before = await snapshotGrid(page, 'guest');
  const typed = [];
  if (filled(request.query.lastName)) typed.push(await fillExt(guestWin.locator('input[name="lastname"]:visible'), request.query.lastName));
  if (filled(request.query.firstName)) typed.push(await fillExt(guestWin.locator('input[name="firstname"]:visible'), request.query.firstName));
  if (filled(request.query.email)) typed.push(await fillExt(guestWin.locator('input[name="emailaddress"]:visible'), request.query.email));
  if (filled(request.query.phone)) typed.push(await fillExt(guestWin.locator('input[name="phonenumber"]:visible'), request.query.phone));
  // No typed field, or a field that did not read back, means the search would run unfiltered: refuse before Search.
  if (!typed.length || typed.includes(false)) return filterNotApplied();
  const internal = guestWin.getByText(/Internal Search/);
  if (await internal.count()) await internal.first().click().catch(() => {});
  const searchBtn = guestWin.getByRole('button', { name: /^Search$/ });
  const searchText = guestWin.getByText(/^Search$/);
  const searchAnchor = guestWin.locator('a').filter({ hasText: /^Search$/ });
  const clicked = (locator) => locator.click().then(() => true, () => false);
  // Armed before the Search click, so an answer that lands during the click is never missed.
  const run = armLookupRun(page, queryNeedle(request));
  let searched;
  if (await searchBtn.count()) searched = await clicked(searchBtn.first());
  else if (await searchAnchor.count()) searched = await clicked(searchAnchor.last());
  else if (await searchText.count()) searched = await clicked(searchText.last());
  else searched = (await fillLookupFilter(page, 'guest', request.query.lastName)) && (await runLookupFilter(page, 'guest'));
  if (!searched) return filterNotVerified('search_not_clicked');
  const settled = await waitForFreshGrid(page, 'guest', before, { run });
  if (settled === 'busy') return lookupBusyTimeout();
  if (settled === 'answer_failed') return filterNotVerified('store_answer_failed');
  if (settled !== 'settled') return filterNotVerified('grid_not_refreshed');
  const profileErr = page.getByText(/Cannot retrieve profile:/i);
  if (await profileErr.count()) {
    const msg = await profileErr.first().innerText().catch(() => '');
    if (/required/i.test(msg)) return { outcome: 'input_gap', candidates: [], truncated: false };
    return { outcome: 'external_system_unavailable', candidates: [], truncated: false };
  }
  const grid = await readVisibleGrid(page, 'guest');
  // Guest search also matches on email and phone, so only a typed surname must appear in every row.
  const surname = filled(request.query.lastName) ? request.query.lastName : '';
  if (surname && !gridAnswersQuery(grid.rows, surname)) return filterNotVerified('rows_do_not_answer_query');
  return classifyKindRows('guest', grid.rows, request, grid.loaded);
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
