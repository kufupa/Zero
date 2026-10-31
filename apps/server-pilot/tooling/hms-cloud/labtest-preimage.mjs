// A same-page, read-only census before creating a fake Labtest stay.
import { randomUUID } from 'node:crypto';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const proofs = new WeakMap();
const busy = new WeakSet();
const clean = (value) => String(value ?? '').trim();

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed : null;
}

function displayDate(value) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(clean(value));
  const month = match && MONTHS.findIndex((item) => item.slice(0, 3).toLowerCase() === match[2].toLowerCase());
  if (!match || month < 0) return null;
  const result = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]}`;
  return date(result) ? result : null;
}

function titleDate(value) {
  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(clean(value));
  const month = match && MONTHS.findIndex((item) => item.slice(0, 3).toLowerCase() === match[1].toLowerCase());
  if (!match || month < 0) return null;
  const result = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return date(result) ? result : null;
}

async function panel(page, box) {
  const deadline = Date.now() + 30_000;
  let emptySince;
  while (Date.now() < deadline) {
    const windows = page.locator('.x-window.x-menu:visible');
    const found = [];
    for (let i = 0; i < await windows.count(); i += 1) {
      const item = windows.nth(i), b = await item.boundingBox().catch(() => null);
      if (b && Math.abs(b.x - box.x) <= 20 && Math.abs(b.width - box.width) <= 40 &&
          b.y >= box.y + box.height - 5 && b.y <= box.y + box.height + 100) found.push(item);
    }
    if (found.length > 1) throw new Error('SEARCH_WINDOW_AMBIGUOUS');
    if (found.length === 1) {
      const state = await found[0].evaluate((el) => {
        const text = el.innerText || '', footer = text.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
        const shown = (node) => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
        return { displayed: footer ? Number(footer[1]) : null, total: footer ? Number(footer[2]) : null,
          history: /No previous searches/i.test(text), loading: [...el.querySelectorAll('.x-mask,.x-mask-msg,.x-loadmask')].some(shown) };
      });
      const count = await found[0].locator('.x-grid-row:visible').count();
      if (state.displayed !== null && !state.history && !state.loading && count >= state.displayed) {
        if (state.displayed > 0) return { popup: found[0], ...state, count };
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 500) return { popup: found[0], ...state, count };
      } else emptySince = undefined;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('SEARCH_TIMEOUT');
}

async function range(popup) {
  const title = popup.locator('[name="gridTitle"]:visible');
  if (await title.count() !== 1) throw new Error('SEARCH_DATE_RANGE_UNREADABLE');
  const parts = (await title.innerText()).split(/\s+-\s+/);
  const from = parts.length === 2 && titleDate(parts[0]), to = parts.length === 2 && titleDate(parts[1]);
  if (!from || !to || from > to) throw new Error('SEARCH_DATE_RANGE_UNREADABLE');
  return { from, to };
}

async function moveWindow(page, popup, arrival) {
  const start = new Date(arrival.getTime() - 14 * 86_400_000);
  const button = popup.locator('[data-testid="calendarbtn"]:visible');
  if (await button.count() !== 1) throw new Error('CALENDAR_NOT_UNIQUE');
  await button.click();
  const picker = page.locator('.x-datepicker:visible');
  await picker.waitFor({ state: 'visible', timeout: 10_000 });
  const title = picker.locator('.x-datepicker-month .x-btn-inner');
  for (let i = 0; i < 36; i += 1) {
    const current = (await title.innerText()).trim(), match = /^([A-Za-z]+)\s+(\d{4})$/.exec(current);
    const month = match && MONTHS.indexOf(match[1]);
    if (!match || month < 0) throw new Error('CALENDAR_UNREADABLE');
    const delta = (start.getUTCFullYear() - Number(match[2])) * 12 + start.getUTCMonth() - month;
    if (!delta) break;
    await picker.locator(delta < 0 ? '.x-datepicker-prev' : '.x-datepicker-next').click();
    await page.waitForFunction((previous) => [...document.querySelectorAll('.x-datepicker')].some((el) =>
      el.getBoundingClientRect().width > 0 && el.querySelector('.x-datepicker-month .x-btn-inner')?.textContent.trim() !== previous),
    current, { timeout: 5_000 });
  }
  if ((await title.innerText()).trim() !== `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`) {
    throw new Error('CALENDAR_MONTH_UNREACHED');
  }
  const label = `${MONTHS[start.getUTCMonth()]} ${String(start.getUTCDate()).padStart(2, '0')}, ${start.getUTCFullYear()}`;
  await picker.locator(`td[title="${label}"] a`).click();
  const prefix = `${MONTHS[start.getUTCMonth()].slice(0, 3)} ${String(start.getUTCDate()).padStart(2, '0')}, ${start.getUTCFullYear()} - `;
  await page.waitForFunction((value) => [...document.querySelectorAll('[name="gridTitle"]')].some((el) =>
    el.getBoundingClientRect().width > 0 && el.textContent.trim().startsWith(value)), prefix, { timeout: 10_000 });
}

function searchRequest(request) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    const exact = (key, value) => body.getAll(key).length === 1 && body.get(key) === value;
    return request.method() === 'POST' && url.origin === ORIGIN && url.pathname === '/web/base/OSRESS.search' &&
      exact('MADDON_FILTER_ALIAS_NAME_1', 'departuredate') && exact('MADDON_FILTER_OPERATOR_1', '>=') &&
      exact('MADDON_FILTER_ALIAS_NAME_2', 'arrivaldate') && exact('MADDON_FILTER_OPERATOR_2', '<=') &&
      exact('MADDON_FILTER_ALIAS_NAME_5', 'lastname_filter') && exact('MADDON_FILTER_OPERATOR_5', 'BEGINS') &&
      exact('MADDON_FILTER_VALUE_5', 'Labtest') && exact('GRID_NAME', 'OSRESS');
  } catch { return false; }
}

// HMS sends dates as day offsets; bind the response's request to the rendered range.
function requestCoversWindow(request, window) {
  try {
    const body = new URLSearchParams(request.postData() || '');
    const offset = (key) => {
      const names = [...body.keys()].filter((name) => name.toLowerCase() === key.toLowerCase());
      const value = body.get(key);
      return names.length === 1 && names[0] === key && /^[+-]?\d{1,5}$/.test(value || '') ? Number(value) : null;
    };
    const from = date(window.from)?.getTime(), to = date(window.to)?.getTime();
    const fromOffset = offset('MADDON_FILTER_VALUE_1'), toOffset = offset('MADDON_FILTER_VALUE_2');
    if (from === undefined || to === undefined || fromOffset === null || toOffset === null) return false;
    const fromBase = from - fromOffset * 86_400_000, toBase = to - toOffset * 86_400_000;
    const now = new Date(), utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const propertyDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const propertyToday = date(propertyDay)?.getTime();
    // Do not guess the offset anchor when the property and UTC dates differ.
    return propertyToday === utcToday && fromBase === utcToday && toBase === utcToday;
  } catch { return false; }
}

function searchResponse(text) {
  const json = text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (all, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json), data = payload?.pageData, grid = data?.grid?.GRIDRESULT?.GRID;
  if (!grid || data.messages || !Array.isArray(grid.DATA) || grid.METADATA?.GRIDNAME !== 'OSRESS' ||
      !/^\d+$/.test(String(grid.METADATA.RECORDS)) || Number(grid.METADATA.RECORDS) !== grid.DATA.length ||
      grid.METADATA.MORERECORDPRESENT !== '-') throw new Error('SEARCH_RESPONSE_INCOMPLETE');
  return grid.DATA.map((row) => ({ confirmation: clean(row.confirmationnumber), firstName: clean(row.firstname),
    lastName: clean(row.lastname), arrival: displayDate(row.arrivaldate), departure: displayDate(row.departuredate),
    status: clean(row.status) }));
}

function forget(page) {
  const previous = proofs.get(page);
  if (previous) page.off('request', previous.invalidate);
  proofs.delete(page);
}

// Returns private candidate data. A clear result is usable once, on this page, for five minutes.
export async function searchLabtestPreimage(page, { arrival, departure } = {}) {
  const start = date(arrival), end = date(departure);
  if (!start || !end || arrival < '2027-01-01' || arrival >= departure) return { outcome: 'input_gap', issue: 'INVALID_LABTEST_DATES' };
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  busy.add(page);
  forget(page);
  try {
    if (new URL(page.url()).origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(await page.title())) {
      throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
    }
    await installReadOnlyGuard(page.context());
    const search = page.locator('input[name="search"]:visible');
    await search.first().waitFor({ state: 'visible', timeout: 20_000 });
    if (await search.count() !== 1) throw new Error('SEARCH_NOT_UNIQUE');
    const box = await search.boundingBox();
    if (!box) throw new Error('SEARCH_NOT_VISIBLE');
    await search.fill('Labtest');
    const runs = page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ }), adjacent = [];
    for (let i = 0; i < await runs.count(); i += 1) {
      const b = await runs.nth(i).boundingBox().catch(() => null);
      if (b && Math.abs(b.y - box.y) <= 10 && b.x >= box.x + box.width && b.x <= box.x + box.width + 100) adjacent.push(runs.nth(i));
    }
    if (adjacent.length !== 1) throw new Error('RUN_NOT_UNIQUE');
    let response = page.waitForResponse((item) => searchRequest(item.request()), { timeout: 30_000 }).catch(() => null);
    await adjacent[0].click();
    let observed = await response, found = await panel(page, box), window = await range(found.popup);
    if (arrival < window.from || arrival > window.to) {
      response = page.waitForResponse((item) => searchRequest(item.request()), { timeout: 30_000 }).catch(() => null);
      await moveWindow(page, found.popup, start);
      observed = await response;
      found = await panel(page, box);
      window = await range(found.popup);
    }
    if (!observed || observed.status() !== 200 || arrival < window.from || arrival > window.to ||
        !requestCoversWindow(observed.request(), window)) throw new Error('SEARCH_RESPONSE_UNVERIFIED');
    const candidates = searchResponse(await observed.text());
    const uiRows = await found.popup.locator('.x-grid-row:visible').evaluateAll((rows) => rows.map((row) =>
      [...row.querySelectorAll('td,[role="gridcell"],.x-grid-cell')].filter((cell) => cell.closest('.x-grid-row') === row)
        .map((cell) => (cell.innerText || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean))));
    if (found.count !== found.displayed || found.total !== found.displayed || candidates.length !== found.displayed ||
        candidates.some((row) => !row.confirmation || !row.firstName || !row.lastName || !row.arrival || !row.departure) ||
        new Set(candidates.map((row) => row.confirmation)).size !== candidates.length ||
        candidates.some((row) => uiRows.filter((cells) => cells[0]?.includes(row.confirmation) &&
          cells[3]?.map(displayDate).includes(row.arrival) && cells[3]?.map(displayDate).includes(row.departure)).length !== 1)) {
      throw new Error('SEARCH_RESULTS_INCOMPLETE');
    }
    const sameArrival = candidates.filter((row) => row.firstName.toLowerCase() === 'proof' &&
      row.lastName.toLowerCase() === 'labtest' && row.arrival === arrival);
    const result = { outcome: sameArrival.length ? 'existing_matches' : 'clear', arrival, departure,
      searchedDateRange: window, coverage: { displayed: found.displayed, total: found.total, complete: true }, candidates, sameArrival };
    if (sameArrival.length) return result;
    const proof = { id: randomUUID(), arrival, departure, expiresAt: Date.now() + 5 * 60_000 };
    proof.invalidate = (request) => {
      try {
        const url = new URL(request.url());
        if (request.method() === 'POST' && (url.pathname === '/web/base/OSRESS.search' ||
            /save|delete|cancel|checkin|checkout/i.test(url.pathname) ||
            (url.pathname === '/web/base/OSRESV.HDR' && /^(SAVE|DELETE)$/i.test(url.searchParams.get('pageaction') || '')))) forget(page);
      } catch { forget(page); }
    };
    proofs.set(page, proof);
    page.on('request', proof.invalidate);
    return { ...result, preimageId: proof.id, expiresAt: new Date(proof.expiresAt).toISOString() };
  } catch (error) {
    const issue = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'SEARCH_UNVERIFIED';
    return { outcome: 'incomplete', issue };
  } finally { busy.delete(page); }
}

// Consuming a proof never asserts that another session cannot change HMS afterward.
export function consumeLabtestPreimage(page, { preimageId, arrival, departure } = {}) {
  const proof = proofs.get(page);
  forget(page);
  return Boolean(proof && proof.id === preimageId && proof.arrival === arrival && proof.departure === departure &&
    Date.now() <= proof.expiresAt);
}
