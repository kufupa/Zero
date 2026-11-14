// Staff surname search in a property-scoped Cloud browser, using the existing complete-panel parser.
import { withCloudReadSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const common = ['system_function_name', 'user_function_name'];
// Exact login, menu and search requests observed for this lookup. A new HMS
// request shape fails closed until independently verified.
const posts = new Map([
  ['/web/base/login', { system: 'LOGIN', user: 'LOGIN', fields: [...common, 'csrftckt', 'password', 'resetpassword', 'tenant', 'userid'] }],
  ['/web/base/BSSTRT', { system: 'BSSTRT', user: 'BSSTRT', fields: [...common, 'menu_module_key', 'removescreenflows'] }],
  ['/web/base/BSSTRT.HDR', { system: 'BSSTRT', user: 'BSSTRT', fields: [...common, 'manurefresh'] }],
  ...['OSRESS', 'OSRESV'].map((name) => [`/web/base/${name}`, { system: name, user: name, tab: '',
    fields: [...common, 'current_tab_name', 'function_class', 'menu_module_key', 'removescreenflows'], menuQuery: true }]),
  ['/web/base/OSRESV.HDR', { system: 'OSRESV', user: 'OSRESV', tab: 'HDR', fields: [...common, 'current_tab_name',
    'account', 'bookingdotcomid', 'confirmationnumber', 'facebookid', 'firstname', 'guestfullname', 'guestid', 'hoteldate',
    'lastname', 'menu_module_key', 'propertycode', 'removescreenflows', 'reservationstayid', 'room', 'tripadvisorid', 'twitterid'] }],
  ['/web/base/OSRESV.LST', { system: 'OSRESV', user: 'OSRESV', tab: 'LST', fields: [...common, 'current_tab_name',
    'component_info_type', 'menu_module_key', 'removescreenflows'] }],
  ['/web/base/OSRESS.search', { system: 'OSRESS', user: 'OSRESV', tab: 'LST', search: true, fields: [...common,
    'component_info_type', 'current_tab_name', 'dataspy_id', 'externalconfirmation', 'grid_id', 'grid_name'] }],
]);
const searchField = /^maddon_(?:filter_(?:alias_name|joiner|operator|seqnum|value)|lparen|rparen)_\d{1,2}$/;
const mutatingPath = /save|delete|cancel|duplicate|checkin|checkout|upload|send|email|amend/i;
const assetPath = /^\/web\/resources\/(?:shared|inforhms)\/[a-z0-9_./-]+\.(?:css|js|svg|png|ttf)$/i;

function uniqueParams(params) {
  const values = new Map();
  for (const [key, value] of params) {
    const normalized = key.toLowerCase();
    if (values.has(normalized)) return null;
    values.set(normalized, value);
  }
  return values;
}

export function guestLookupMayRequest({ method, url, postData, contentType, propertyCode = 'HRCEN' }) {
  try {
    const property = getPropertyRegistration(propertyCode);
    if (!property?.active) return false;
    const target = new URL(url), verb = String(method).toUpperCase();
    const decodedPath = decodeURIComponent(target.pathname);
    if (target.origin !== property.origin || target.origin !== ORIGIN || target.username || target.password || target.hash || decodedPath !== target.pathname ||
        shouldAbortReadOnlyRequest({ method: verb, url, postData })) return false;
    const query = uniqueParams(target.searchParams);
    if (!query) return false;
    if (verb === 'GET') {
      if (decodedPath === '/web/base/logindisp') return query.size === 1 && query.get('tenant') === property.expectedTenant;
      if (decodedPath === '/web/base/loadmain' && propertyCode !== property.landingPropertyCode) {
        const fixed = new Map([['initpath', 'BSSTRT'], ['user_function_name', 'BSSTRT'],
          ['menu_module_key', '-1'], ['fromlogin', 'yes'], ['defaultproperty', propertyCode]]);
        const token = query.get('requesttoken') || '';
        return query.size === fixed.size + 1 && [...fixed].every(([key, value]) => query.get(key) === value) &&
          token.length > 0 && token.length <= 1024 && !/[\p{Cc}]/u.test(token);
      }
      if (decodedPath === '/web/base/COMMON') {
        const key = query.get('req_key') || '';
        return query.size === 1 && key.length <= 1024 && key.length > 0 && !/[\p{Cc}]/u.test(key) && !mutatingPath.test(key);
      }
      if (query.size) return false;
      return ['/web/base/login-all.js', '/web/base/all-classes.js', '/web/jsp/interfaceStatusAlert.jsp'].includes(decodedPath) ||
        assetPath.test(decodedPath);
    }
    // The native property chooser is a scoped LOV read, never a reservation form action.
    if (verb === 'POST' && decodedPath === '/web/base/LOVPOP' && propertyCode !== property.landingPropertyCode &&
        query.size === 0 && typeof postData === 'string' &&
        /^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType || '')) {
      const body = uniqueParams(new URLSearchParams(postData));
      const required = new Map([['system_function_name', 'SWITCHPROP'], ['user_function_name', 'SWITCHPROP'],
        ['grid_name', 'LVSORGALL'], ['grid_type', 'LOV'], ['request_type', 'LOV.HEAD_DATA.STORED'],
        ['lov_tagname', 'propertylookup'], ['popup', 'true']]);
      return Boolean(body && [...required].every(([key, value]) => body.get(key) === value) &&
        [...body].every(([key, value]) => key.length <= 100 && value.length <= 1024 && !/[\p{Cc}]/u.test(value) &&
          (required.has(key) || !/(?:action|operation|command|method|save|delete|cancel|update|insert|submit|create|write|upload|send)/i.test(key))));
    }
    const rule = posts.get(target.pathname);
    if (verb !== 'POST' || mutatingPath.test(decodedPath) || !rule || typeof postData !== 'string' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType || '')) return false;
    const body = uniqueParams(new URLSearchParams(postData));
    if (!body || [...query.keys()].some((key) => !rule.menuQuery || !['function_class', 'user_function_name'].includes(key)) ||
        rule.fields.some((key) => !body.has(key)) ||
        [...body.keys()].some((key) => !rule.fields.includes(key) && !(rule.search && searchField.test(key)))) return false;
    if (rule.menuQuery && (query.size !== 2 || query.get('user_function_name') !== rule.user ||
        query.get('function_class') !== 'WEBL' || body.get('function_class') !== 'WEBL')) return false;
    if (decodedPath === '/web/base/login' && (body.get('tenant') !== property.expectedTenant ||
        !body.get('csrftckt') || !body.get('userid') || !body.get('password') ||
        !['', 'false', '0'].includes(body.get('resetpassword').toLowerCase()))) return false;
    if (decodedPath === '/web/base/OSRESV.HDR' && body.get('propertycode') && body.get('propertycode') !== propertyCode) return false;
    return body.get('system_function_name') === rule.system && body.get('user_function_name') === rule.user &&
      (rule.tab === undefined || body.get('current_tab_name') === rule.tab);
  } catch { return false; }
}

/** Fetch once without following a redirect; never hand a redirect back to the browser. */
export async function fulfillGuestLookupRequest(route) {
  try {
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
    if (response.status() >= 300 && response.status() < 400) return await route.abort();
    return await route.fulfill({ response });
  } catch {
    try { return await route.abort(); } catch { return; }
  }
}

export async function installGuestLookupGuard(context, propertyCode = 'HRCEN') {
  if (!getPropertyRegistration(propertyCode)?.active) throw new Error('GUEST_STAY_PROPERTY_UNSUPPORTED');
  // A service worker or socket could bypass ordinary request routing.
  if (typeof context.routeWebSocket !== 'function') throw new Error('LOOKUP_SOCKET_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const allowed = guestLookupMayRequest({ method: request.method(), url: request.url(), postData: request.postData?.(),
      contentType: request.headers()['content-type'], propertyCode });
    return allowed ? fulfillGuestLookupRequest(route) : route.abort();
  });
}

async function openGuestStay(page, propertyCode, { forceMenu = false } = {}) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  const alreadyOpen = !forceMenu && typeof search.isVisible === 'function' && await search.isVisible();
  if (!alreadyOpen) {
    const node = (name) => page.locator('span.x-tree-node-text:visible')
      .filter({ hasText: new RegExp(`^${name}$`) });
    const trigger = page.locator('a.app-menu-trigger:visible');
    if (await trigger.count() !== 1) throw new Error('MENU_NOT_UNIQUE');
    await trigger.click({ timeout: 10_000 });
    // Children can take a moment to render; inspect the branch state instead of
    // toggling an expanded branch merely because Guest Stay is not visible yet.
    const front = node('Front Desk');
    await front.waitFor({ state: 'visible', timeout: 10_000 });
    if (await front.count() !== 1) throw new Error('FRONT_DESK_NOT_UNIQUE');
    const branch = await front.locator('xpath=ancestor::tr[1]').getAttribute('class');
    if (!branch || !branch.split(/\s+/).includes('x-grid-row')) throw new Error('FRONT_DESK_STATE_UNVERIFIED');
    if (!branch.split(/\s+/).includes('x-grid-tree-node-expanded')) await front.click({ timeout: 10_000 });
    const guest = node('Guest Stay');
    await guest.waitFor({ state: 'visible', timeout: 10_000 });
    if (await guest.count() !== 1) throw new Error('GUEST_STAY_NOT_UNIQUE');
    await guest.click({ timeout: 10_000 });
  }
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  const valid = await page.evaluate((expected) => {
    const header = document.querySelector('button.switchproperty')?.textContent?.trim();
    const property = document.documentElement.dataset.propertyCode ??
      /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1] ?? header;
    return location.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com' && property === expected;
  }, propertyCode);
  if (!valid) throw new Error('GUEST_STAY_PROPERTY_UNVERIFIED');
}


// The native quick-search parser and date-window actions used by the Cloud reader.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_PICKER_CLICKS = 60;
const QUICK_WAIT_MS = 8000;
const PICKER_OPEN = '.x-datepicker:visible, .x-date-picker:visible, .x-monthpicker:visible';
const PICKER_TITLE = '.x-datepicker-month .x-btn-inner, .x-datepicker-month';
const PICKER_NEXT = '.x-datepicker-next, .x-datepicker-next a';
const PICKER_PREV = '.x-datepicker-prev, .x-datepicker-prev a';
const WINDOW_LABEL_TEXT = /\w{3} \d{1,2}, \d{4} - \w{3} \d{1,2}, \d{4}/;
const PANEL_FOOTER = /Records:\s*\d+\s+of\s+\d+/i;
const PANEL_HISTORY = /No previous searches/i;

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();


function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[0];
}

// HMS shows arrival as DD-MON-YYYY (for example 14-SEP-2027). ISO input passes through.
function hmsDateToIso(value) {
  const text = squash(value);
  if (parseIsoDate(text)) return text;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return null;
  const month = HMS_MONTHS.indexOf(match[2].toUpperCase());
  if (month === -1) return null;
  return parseIsoDate(`${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
}

const HMS_DATE_TOKEN = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const CONFIRMATION_TOKEN = /^\d+-\d+$/;
// "Last, First" with no digits, so the "Sep 14, 2027 - Nov 13, 2027" window line never matches.
const GUEST_TOKEN = /^(\p{L}[\p{L}'’. -]*),\s*(\p{L}[\p{L}'’. -]*)?$/u;
// Status is words only: dates, "Records: 1 of 1" and ids never match.
const STATUS_TOKEN = /^\p{L}[\p{L} -]*$/u;
const WINDOW_LABEL = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})\s+-\s+([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/;

function monthNumber(word) {
  const index = HMS_MONTHS.indexOf(String(word).slice(0, 3).toUpperCase());
  return index === -1 ? null : index + 1;
}

function isoFromParts(year, month, day) {
  if (!month) return null;
  return parseIsoDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

// Quick-search window line, for example "Sep 14, 2027 - Nov 13, 2027". Returns inclusive ISO bounds or null.
function parseDateWindowLabel(text) {
  const match = WINDOW_LABEL.exec(squash(text));
  if (!match) return null;
  const from = isoFromParts(match[3], monthNumber(match[1]), match[2]);
  const to = isoFromParts(match[6], monthNumber(match[4]), match[5]);
  if (!from || !to || from > to) return null;
  return { from, to };
}

// True when the arrival day falls inside the window, both ends included.
function windowCovers(window, arrivalIso) {
  const day = parseIsoDate(arrivalIso);
  return Boolean(window && day && window.from <= day && day <= window.to);
}

// Reads one quick-search row from its cell texts in document order. Returns null unless the row has exactly
// one confirmation (equal to the expected one), exactly one "Last, First" guest, a status word after the guest,
// and HMS dates (arrival first, departure second). Dates stay in HMS form; identityCheck converts them.
// Non-empty squashed lines of the raw cell texts, in order. A cell whose text spans lines yields one entry per line.
function cellLines(cellTexts) {
  const cells = [];
  for (const raw of cellTexts ?? []) {
    for (const line of String(raw ?? '').split('\n')) {
      const cell = squash(line);
      if (cell) cells.push(cell);
    }
  }
  return cells;
}

function parseQuickSearchRow(cellTexts, confirmation) {
  const cells = cellLines(cellTexts);
  const expected = squash(confirmation);
  const confirmations = cells.filter((cell) => CONFIRMATION_TOKEN.test(cell));
  if (confirmations.length !== 1 || confirmations[0] !== expected) return null;
  const guests = cells.filter((cell) => GUEST_TOKEN.test(cell));
  if (guests.length !== 1) return null;
  const guest = GUEST_TOKEN.exec(guests[0]);
  const dates = cells.filter((cell) => HMS_DATE_TOKEN.test(cell));
  if (!dates[0] || !hmsDateToIso(dates[0])) return null;
  if (dates[1] && !hmsDateToIso(dates[1])) return null;
  const guestIndex = cells.indexOf(guests[0]);
  const status = cells
    .slice(guestIndex + 1)
    .find((cell) => STATUS_TOKEN.test(cell) && !HMS_DATE_TOKEN.test(cell));
  if (!status) return null;
  return {
    confirmation: expected,
    lastName: guest[1].trim(),
    firstName: (guest[2] ?? '').trim(),
    status,
    arrival: dates[0],
    departure: dates[1] ?? null,
  };
}


function pickerMonthSteps(title, targetIso) {
  const match = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(squash(title));
  const target = parseIsoDate(targetIso);
  if (!match || !target) return null;
  const word = match[1].slice(0, 3).toLowerCase();
  const month = MONTH_NAMES.findIndex((name) => name.slice(0, 3).toLowerCase() === word);
  if (month === -1) return null;
  const [targetYear, targetMonth] = target.split('-').map(Number);
  return (targetYear * 12 + targetMonth - 1) - (Number(match[2]) * 12 + month);
}


function parseRecordsFooter(text) {
  const match = /Records:\s*(\d+)\s+of\s+(\d+)/i.exec(squash(text));
  if (!match) return null;
  const shown = Number(match[1]);
  const total = Number(match[2]);
  return shown <= total ? { shown, total } : null;
}

// One dropdown row from its cell texts (a text may span lines). Null unless exactly one line is a confirmation and
// parseQuickSearchRow reads the rest of the row.
function parseDropdownRow(cellTexts) {
  const confirmations = cellLines(cellTexts).filter((cell) => CONFIRMATION_TOKEN.test(cell));
  return confirmations.length === 1 ? parseQuickSearchRow(cellTexts, confirmations[0]) : null;
}

function toPanelRow(row) {
  return {
    confirmation: row.confirmation,
    lastName: row.lastName,
    firstName: row.firstName,
    status: row.status,
    arrival: hmsDateToIso(row.arrival),
    departure: row.departure ? hmsDateToIso(row.departure) : null,
  };
}

// Snapshot from snapshotPanel (stay-lookup-dom.mjs). A candidate is a data row when one of its cell or line texts is a
// confirmation. Its cells are read first; when they do not parse, its lines are read. A row that parses neither way is
// unreadable and its texts come back for the dump. Each unresolved confirmation leaf is unreadable too.
function parsePanelSnapshot(snapshot) {
  const rows = [];
  const unreadableRows = [];
  let unreadable = snapshot?.unresolved ?? 0;
  for (const candidate of snapshot?.rows ?? []) {
    const texts = [...cellLines(candidate.cells), ...cellLines(candidate.lines)];
    if (!texts.some((text) => CONFIRMATION_TOKEN.test(text))) continue;
    const row = parseDropdownRow(candidate.cells) ?? parseDropdownRow(candidate.lines);
    if (row) {
      rows.push(toPanelRow(row));
    } else {
      unreadable += 1;
      unreadableRows.push(candidate);
    }
  }
  return { rows, unreadable, unreadableRows };
}

// Every panel row must be read, and the footer must account for all of them. Capped panels are not complete.
function searchGuestOutcome({ records, rows, unreadable }) {
  if (!records) return { outcome: 'execution_failure', reason: 'records_footer_missing' };
  if (records.shown < records.total) return { outcome: 'ambiguous_capped', reason: 'records_capped' };
  if (unreadable > 0) return { outcome: 'execution_failure', reason: 'rows_unreadable' };
  if (rows.length !== records.shown) return { outcome: 'execution_failure', reason: 'row_count_mismatch' };
  return { outcome: 'ok', reason: null };
}

// Rows for the same guest on the same dates: surname (case-insensitive), arrival, and departure when given.
function sameStayRows(rows, { lastName, arrival, departure = null }) {
  const surname = squash(lastName).toLowerCase();
  return rows.filter((row) => row.lastName.toLowerCase() === surname
    && row.arrival === arrival
    && (departure === null || row.departure === departure));
}


function snapshotPanel(root) {
  const ROW = 'tr, .x-grid-row, .x-grid-item, [role="row"]';
  const CELL = 'td, th, .x-grid-cell, [role="gridcell"], [role="cell"]';
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const rows = [];
  const captured = new Set();
  for (const row of root.querySelectorAll(ROW)) {
    if (!shown(row) || row.querySelector(ROW)) continue;
    const cells = [...row.querySelectorAll(CELL)].filter((cell) => shown(cell) && cell.closest(ROW) === row);
    rows.push({
      cells: cells.map((cell) => cell.innerText || cell.textContent || ''),
      lines: (row.innerText || row.textContent || '').split(/\t|\n/),
    });
    captured.add(row);
  }
  // Fallback for a panel without table rows (the same idea as rowCells in cancel-stay.mjs): a confirmation leaf outside
  // every captured row takes its nearest ancestor whose text holds a date. Anything left over is unresolved.
  const DATED = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/;
  const textOf = (node) => node.innerText || node.textContent || '';
  let unresolved = 0;
  for (const leaf of root.querySelectorAll('*')) {
    if (leaf.children.length !== 0 || !shown(leaf)) continue;
    if (!/^\d+-\d+$/.test(textOf(leaf).trim())) continue;
    const tableRow = leaf.closest(ROW);
    if (tableRow && captured.has(tableRow)) continue;
    let block = leaf.parentElement;
    while (block && block !== root && !DATED.test(textOf(block))) block = block.parentElement;
    if (!block || block === root) {
      unresolved += 1;
      continue;
    }
    if (captured.has(block)) continue;
    captured.add(block);
    rows.push({
      cells: [...block.querySelectorAll('*')].filter((node) => node.children.length === 0 && shown(node)).map(textOf),
      lines: textOf(block).split(/\t|\n/),
    });
  }
  const text = root.innerText || root.textContent || '';
  const footer = text.match(/Records:\s*\d+\s+of\s+\d+/i);
  const window = text.match(/\w{3} \d{1,2}, \d{4} - \w{3} \d{1,2}, \d{4}/);
  return { rows, unresolved, footer: footer ? footer[0] : '', window: window ? window[0] : '' };
}

async function shot(ctx, name) {
  const path = join(ctx.dir, name);
  await ctx.page.screenshot({ path, fullPage: true });
  ctx.result.screenshots.push(path);
}

async function visibleIndexes(locator) {
  const indexes = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) indexes.push(index);
  }
  return indexes;
}


function headerSearch(page) {
  return page.getByPlaceholder(/Search by Name, Confirmation/i).first();
}

async function typeHeaderSearch(page, text) {
  const search = headerSearch(page);
  await search.click({ force: true });
  await search.fill('');
  await search.pressSequentially(text, { delay: 40 });
  await page.waitForTimeout(500);
}

// The window picker opens on a real mouse click (cancel-now.mjs); a programmatic click does not open it.
// The window label nearest the bottom of the screen. Its calendar icon sits just to its right.
async function lowestWindowLabel(page) {
  const labels = page.getByText(WINDOW_LABEL_TEXT);
  let best = null;
  for (const index of await visibleIndexes(labels)) {
    const box = await labels.nth(index).boundingBox();
    if (box && box.width > 40 && (!best || box.y > best.box.y)) best = { locator: labels.nth(index), box };
  }
  return best;
}

async function readWindow(page) {
  const label = await lowestWindowLabel(page);
  return label ? parseDateWindowLabel(await label.locator.innerText()) : null;
}

async function openWindowPicker(page) {
  const label = await lowestWindowLabel(page);
  if (!label) throw new Error('NO_VISIBLE_DATE_WINDOW');
  const { box } = label;
  const midY = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width + 22, midY);
  await page.waitForTimeout(500);
  if ((await page.locator(PICKER_OPEN).count()) === 0) {
    await page.mouse.click(box.x + 8, midY);
    await page.waitForTimeout(400);
  }
  if ((await page.locator(PICKER_OPEN).count()) === 0) throw new Error('DATE_PICKER_NOT_OPEN');
}

// Steps the open picker by whole months inside the page: one round trip instead of one per month over the CDP tunnel.
// The arrow is pressed as mouse events (ExtJS repeats on mousedown). The loop in pickArrivalDay re-reads the title and
// corrects any miss, so this only has to get close.
async function stepPickerInPage(page, steps) {
  await page.evaluate(async ({ count, selector }) => {
    for (let index = 0; index < count; index += 1) {
      const arrow = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length > 0);
      if (!arrow) return;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        arrow.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
      await new Promise((done) => setTimeout(done, 80));
    }
  }, { count: Math.abs(steps), selector: steps > 0 ? '.x-datepicker-next' : '.x-datepicker-prev' }).catch(() => {});
  await page.waitForTimeout(200);
}

// Moves the open picker to the arrival month and clicks the arrival day.
async function pickArrivalDay(page, arrival) {
  const title = page.locator(PICKER_TITLE).first();
  let steps = pickerMonthSteps(await title.innerText(), arrival);
  if (steps !== null && Math.abs(steps) > 1) {
    await stepPickerInPage(page, steps);
    steps = pickerMonthSteps(await title.innerText(), arrival);
  }
  for (let clicks = 0; steps !== 0; clicks += 1) {
    if (steps === null) throw new Error(`DATE_PICKER_TITLE_UNKNOWN:${squash(await title.innerText()).slice(0, 40)}`);
    if (clicks >= MAX_PICKER_CLICKS) throw new Error('DATE_PICKER_MONTH_UNREACHED');
    await page.locator(steps > 0 ? PICKER_NEXT : PICKER_PREV).first().click();
    await page.waitForTimeout(150);
    steps = pickerMonthSteps(await title.innerText(), arrival);
  }
  const day = new RegExp(`^${Number(arrival.slice(8, 10))}$`);
  let cells = page.locator('.x-datepicker-cell:not(.x-datepicker-prevday):not(.x-datepicker-nextday) a').filter({ hasText: day });
  let hits = await visibleIndexes(cells);
  if (hits.length === 0) {
    cells = page.locator('.x-datepicker-date, .x-datepicker-cell a').filter({ hasText: day });
    hits = await visibleIndexes(cells);
  }
  if (hits.length !== 1) throw new Error(`DATE_PICKER_DAY_AMBIGUOUS:${hits.length}`);
  await cells.nth(hits[0]).click({ force: true });
  await page.waitForTimeout(300);
}

// Some pickers apply on the day click and show no Apply, so Apply is clicked only when it is on screen.
async function clickApplyIfShown(page) {
  const apply = page.locator('a.x-btn:visible').filter({ hasText: /^Apply$/ });
  if ((await apply.count()) === 0) return false;
  await apply.first().click({ force: true });
  await page.waitForTimeout(400);
  return true;
}

// Quick-search window: the calendar icon opens the picker and the arrival day moves the window.
async function setQuickWindow(page, arrival) {
  await openWindowPicker(page);
  await pickArrivalDay(page, arrival);
  await clickApplyIfShown(page);
  await page.waitForTimeout(600);
}

// Quick-search nudges. ArrowDown from inside the field opens the list of a search that has text; a click at the right of
// the field reopens it. Enter is never pressed: with one match it opens the record and closes the dropdown.
async function pressArrowDown(page) {
  await headerSearch(page).press('ArrowDown');
}

async function clickInsideSearch(page) {
  const box = await headerSearch(page).boundingBox();
  if (box) await page.mouse.click(box.x + box.width - 24, box.y + box.height / 2);
}

// The header Run only. The grid below has its own Run, which would run the grid instead of the quick search. Live HMS
// marks the header one with stay-360-search-btn; the position check is the fallback.
const HEADER_BOTTOM = 100;

async function clickHeaderRun(page) {
  const marked = page.locator('a.stay-360-search-btn:visible');
  if ((await marked.count()) === 1) {
    await marked.click({ force: true });
    await page.waitForTimeout(1000);
    return true;
  }
  const runs = page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ });
  for (const index of await visibleIndexes(runs)) {
    const box = await runs.nth(index).boundingBox();
    if (box && box.y < HEADER_BOTTOM) {
      await runs.nth(index).click({ force: true });
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

// The page actions quick-search.mjs runs for one term. Typing alone only shows the history list ("No previous
// searches."); the header Run executes the search, so the typed step always ends with it.
function quickActions(page, term) {
  return {
    type: async () => {
      await typeHeaderSearch(page, term);
      await clickHeaderRun(page);
    },
    arrowDown: () => pressArrowDown(page),
    clickInside: () => clickInsideSearch(page),
    headerRun: () => clickHeaderRun(page),
  };
}

// The quick-search dropdown: the nearest ancestor of its In-House tab that also holds the "Records:" footer.
// The record header and the grid are outside it, so the row lookup below cannot match them.
async function quickPanel(page) {
  const tabs = page.getByText(/^In.?House$/);
  const shownTabs = await visibleIndexes(tabs);
  if (shownTabs.length === 0) return null;
  const panel = tabs.nth(shownTabs[0]).locator('xpath=ancestor::*[contains(., "Records:")][1]');
  return (await panel.count()) === 1 ? panel : null;
}


const QUICK_NUDGES = ['arrowDown', 'clickInside', 'headerRun'];

// actions: { type(), arrowDown(), clickInside(), headerRun() }, each a page action. ready() waits for the panel and
// returns what it found; done(result) says whether that is enough. A result with executed set is a panel whose search
// ran (rows, or "There are no records to display"): nudges cannot change it, so none runs. Returns the last result, the
// stages that ran, and whether the search is done.
async function driveQuickSearch(actions, { ready, done }) {
  const stages = ['typed'];
  await actions.type();
  let result = await ready();
  for (const nudge of QUICK_NUDGES) {
    if (done(result) || result?.executed) break;
    await actions[nudge]();
    stages.push(nudge);
    result = await ready();
  }
  return { result, stages, done: done(result) };
}


function windowAction({ window, arrival, panelShown }) {
  if (!panelShown || !arrival || !window) return 'keep';
  return windowCovers(window, arrival) ? 'keep' : 'move';
}

function newLookupResult(args) {
  return {
    mode: args.mode,
    outcome: null,
    reason: null,
    confirmation: args.confirmation,
    arrival: args.arrival,
    departure: args.departure,
    lastName: args.lastName,
    findMethod: null,
    quickStages: [],
    arrivalMismatch: false,
    requestedArrival: args.arrival ?? null,
    hmsArrival: null,
    stay: null,
    commercial: null,
    conflicts: [],
    records: null,
    rows: [],
    matches: [],
    unreadable: 0,
    unreadableRows: [],
    screenshots: [],
    error: null,
    timings: {},
  };
}

function mark(ctx, name) {
  ctx.result.timings[name] = Date.now() - ctx.started;
}

function setOutcome(result, outcome, reason = null) {
  result.outcome = outcome;
  result.reason = reason;
}


async function waitForPanel(page) {
  const deadline = Date.now() + QUICK_WAIT_MS;
  for (;;) {
    const panel = await quickPanel(page);
    const text = panel ? await panel.innerText({ timeout: 2000 }).catch(() => '') : '';
    const executed = PANEL_FOOTER.test(text) && !PANEL_HISTORY.test(text);
    if (executed || Date.now() >= deadline) return { panel: PANEL_FOOTER.test(text) ? panel : null, executed };
    await page.waitForTimeout(500);
  }
}

async function failPanel(ctx, reason) {
  await shot(ctx, 'panel.png').catch(() => {});
  setOutcome(ctx.result, 'execution_failure', reason);
}

// The panel's outer HTML, for an offline re-test of the row parser. Written on failure, or on every run with --debug-html.
async function dumpPanelHtml(ctx, panel) {
  const html = await panel.evaluate((root) => root.outerHTML).catch(() => '');
  if (html) await writeFile(join(ctx.dir, 'panel.html'), html);
}


async function searchGuest(ctx) {
  const { page, args, result } = ctx;
  // The surname goes into the header search; quick-search.mjs nudges the panel open. Enter is never pressed.
  // A panel still showing the history list is enough to read and move its window: the move runs the search.
  const executedPanel = (state) => state.executed;
  const quick = await driveQuickSearch(quickActions(page, args.lastName), {
    ready: () => waitForPanel(page),
    done: executedPanel,
  });
  result.quickStages = quick.stages;
  let state = quick.result;
  if (!state.panel) return failPanel(ctx, 'panel_not_shown');
  let dateWindow = await readWindow(page);
  if (!dateWindow) return failPanel(ctx, 'window_unreadable');
  if (windowAction({ window: dateWindow, arrival: args.arrival, panelShown: true }) === 'move') {
    await setQuickWindow(page, args.arrival);
    const moved = await driveQuickSearch(quickActions(page, args.lastName), {
      ready: () => waitForPanel(page),
      done: executedPanel,
    });
    result.quickStages.push(...moved.stages.map((stage) => `window.${stage}`));
    state = moved.result;
    dateWindow = state.panel ? await readWindow(page) : null;
    if (!state.panel || !dateWindow || !windowCovers(dateWindow, args.arrival)) {
      return failPanel(ctx, 'window_not_covering_arrival');
    }
  }
  if (!state.executed) return failPanel(ctx, 'search_not_executed');
  const { panel } = state;
  mark(ctx, 'window');
  await shot(ctx, 'panel.png');
  const snapshot = await panel.evaluate(snapshotPanel);
  const parsed = parsePanelSnapshot(snapshot);
  const records = parseRecordsFooter(snapshot.footer);
  result.records = records;
  result.rows = parsed.rows;
  result.unreadable = parsed.unreadable;
  result.unreadableRows = parsed.unreadableRows;
  result.matches = sameStayRows(parsed.rows, args);
  const verdict = searchGuestOutcome({ records, rows: parsed.rows, unreadable: parsed.unreadable });
  setOutcome(result, verdict.outcome, verdict.reason);
  if (args.debugHtml || verdict.outcome !== 'ok') await dumpPanelHtml(ctx, panel);
  mark(ctx, 'read');
}

async function searchGuestOnOpenGuestStay(ctx) {
  if (!ctx.result) ctx.result = newLookupResult(ctx.args);
  await searchGuest(ctx);
  return ctx.result;
}


/** No write operations; search result cap and unreadable-row handling remain with the existing parser. */
export async function searchGuestInCloud(input, { openSession = withCloudReadSession,
  guard = installGuestLookupGuard, navigate = openGuestStay, search = searchGuestOnOpenGuestStay, signal, transportId, forceNavigate = false } = {}) {
  const propertyCode = input.propertyCode ?? 'HRCEN';
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active) throw new Error('GUEST_STAY_PROPERTY_UNSUPPORTED');
  const timeout = AbortSignal.timeout(5 * 60_000);
  return openSession(async (page, identity) => {
    if ((openSession === withCloudReadSession && !identity) || (identity &&
        (identity.propertyCode !== propertyCode || identity.tenantId !== property.expectedTenant ||
         identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin))) {
      throw new Error('GUEST_STAY_PROPERTY_UNVERIFIED');
    }
    await navigate(page, propertyCode, { forceMenu: forceNavigate });
    const result = await search({ page, args: { mode: 'search-guest', lastName: input.lastName, arrival: input.arrival,
      departure: input.departure ?? null, debugHtml: false }, dir: input.dir, started: Date.now() });
    return input.propertyCode === undefined ? result : { ...result, propertyCode };
  }, { propertyCode, startScreen: 'OSRESV', headless: true, blockServiceWorkers: true,
    prepareContext: (context) => guard(context, propertyCode),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(transportId !== undefined && { transportId }) });
}
