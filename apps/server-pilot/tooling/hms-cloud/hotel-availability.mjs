// Read prices and inventory from cloud Hotel Availability on the caller's page.
import { randomUUID } from 'node:crypto';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { captureAvailabilityDisplay } from './availability-display.mjs';

const busyPages = new WeakSet();
const lastPartySearch = new WeakMap();
const selectedParties = new WeakMap();
const PARTY_PICKERS = {
  organization: { field: 'organization', title: 'Organizations', filter: 'Name', alias: 'companyname',
    id: 'companyid', name: 'companyname', requestField: 'organizationID' },
  bookingAgency: { field: 'travelagency', title: 'Booking Agencies', filter: 'Booking Agency Name', alias: 'travelagencyname',
    id: 'travelagencyid', name: 'travelagencyname', requestField: 'travelAgencyID' },
  group: { field: 'groupname', title: 'Groups', filter: 'Group Name', alias: 'groupsname',
    id: 'propgroupbookingid', name: 'groupsname', requestField: 'groupID' },
};
const clean = (value) => String(value ?? '').trim();
const codes = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const sameCodes = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const dayMs = 24 * 60 * 60 * 1000;

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function validate(input) {
  const arrival = calendarDay(input?.arrivalDate);
  const departure = calendarDay(input?.departureDate);
  const nights = arrival && departure ? (departure - arrival) / dayMs : 0;
  if (!arrival || !departure || nights < 1) throw new Error('INVALID_DATE_RANGE');
  if (!Number.isInteger(input.adults) || input.adults < 1 || !Array.isArray(input.childAges) ||
      input.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 99)) {
    throw new Error('OCCUPANCY_REQUIRED');
  }
  if (!clean(input.propertyCode)) throw new Error('PROPERTY_REQUIRED');
  for (const key of ['roomTypes', 'ratePlans']) {
    const value = input[key];
    if (value !== 'all' && (!Array.isArray(value) || !value.length ||
        value.some((code) => typeof code !== 'string' || !clean(code) || /[,\r\n]/.test(clean(code))) ||
        new Set(codes(value)).size !== value.length)) throw new Error('CODES_REQUIRED');
  }
  const party = input.partyContext === undefined ? {} : input.partyContext;
  if (!party || typeof party !== 'object' || Array.isArray(party) ||
      Object.entries(party).some(([key, value]) => !Object.hasOwn(PARTY_PICKERS, key) ||
        typeof value !== 'string' || !clean(value) || /[\r\n]/.test(value))) throw new Error('PARTY_CONTEXT_INVALID');
  return { nights, party: Object.fromEntries(Object.entries(party).map(([key, value]) => [key, clean(value)])) };
}

// The animated HMS menu can be visible while its tree is outside the viewport.
async function clickMenuNode(node) {
  try { await node.click({ timeout: 2500 }); }
  catch (error) {
    const message = String(error);
    if (/outside of the viewport/i.test(message) && !/intercepts pointer events/i.test(message)) {
      await node.evaluate((element) => element.click());
    } else if (error?.name === 'TimeoutError') {
      await node.click();
    } else throw error;
  }
}

async function availabilitySurface(page) {
  const matches = [];
  for (const frame of page.frames()) {
    const scope = frame === page.mainFrame() ? page : frame;
    const title = scope.locator('h1.pagetitle:visible').filter({ hasText: /^Hotel Availability$/ });
    const dates = scope.locator('input[name="dates"]:visible');
    if (await title.count().catch(() => 0) === 1 && await dates.count().catch(() => 0) === 1) matches.push(scope);
  }
  if (matches.length > 1) throw new Error('AVAILABILITY_SURFACE_AMBIGUOUS');
  return matches[0] || null;
}

async function waitForAvailabilitySurface(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const surface = await availabilitySurface(page);
    if (surface) return surface;
    await page.waitForTimeout(200);
  }
  return null;
}

/** Open Hotel Availability from Stay 360 or a new, unsaved Guest Stay, or reuse it. */
export async function openHotelAvailability(page) {
  await installReadOnlyGuard(page.context());
  const confirmation = page.locator('input[name="confirmationnumber"]:visible');
  const agency = page.locator('input[name="ta1"]:visible');
  if (await confirmation.count() === 1 && await agency.count() === 1 && clean(await confirmation.inputValue())) {
    throw new Error('NOT_A_NEW_GUEST_STAY');
  }
  const existing = await availabilitySurface(page);
  if (existing) return existing;
  if (await confirmation.count() === 1 && await agency.count() === 1) {
    const toolbar = page.locator('a[data-qtip="Hotel Availability"]:visible');
    if (await toolbar.count() !== 1) throw new Error('HOTEL_AVAILABILITY_TOOLBAR_UNAVAILABLE');
    await toolbar.click();
    const overlay = await waitForAvailabilitySurface(page, 20000);
    if (!overlay) throw new Error('HOTEL_AVAILABILITY_NOT_OPENED');
    return overlay;
  }
  // The Stay 360 bootstrap returns during navigation; wait for it to settle first.
  await page.locator('input[name="search"]:visible').first().waitFor({ timeout: 25000 });
  const node = (name) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${name}$`) });
  const menuOpen = () => node('Front Desk').evaluate((element) => {
    const box = element.closest('.x-tree-view')?.getBoundingClientRect();
    return Boolean(box && Math.min(innerWidth, box.right) - Math.max(0, box.left) >= box.width * 0.9);
  }).catch(() => false);
  const ensureMenuOpen = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await menuOpen()) return;
      await page.locator('a.app-menu-trigger:visible').click();
      await page.waitForTimeout(1200);
    }
    if (!await menuOpen()) throw new Error('MENU_NOT_OPENED');
  };
  const ensureExpanded = async (parent, child, delay) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await node(child).isVisible()) return;
      await clickMenuNode(node(parent));
      await page.waitForTimeout(delay);
    }
    if (!await node(child).isVisible()) throw new Error('MENU_NOT_EXPANDED');
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureMenuOpen();
    await ensureExpanded('Front Desk', 'Availability', 900);
    await ensureExpanded('Availability', 'Hotel Availability', 1200);
    await clickMenuNode(node('Hotel Availability'));
    const surface = await waitForAvailabilitySurface(page, 8000);
    if (surface) return surface;
  }
  throw new Error('HOTEL_AVAILABILITY_NOT_OPENED');
}

async function openPicker(page, name) {
  const input = page.locator(`input[name="${name}"]:visible`).first();
  await input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first().click();
  return input;
}

// Hotel Availability can collapse its extra filters after showing search results.
async function ensureAdvancedCriteria(page) {
  const expander = page.locator('[data-testid="subheaderexpander"]:visible');
  if (await expander.count() !== 1) throw new Error('CRITERIA_EXPANDER_UNAVAILABLE');
  const buttonId = await expander.evaluate((element) => element.closest('a')?.id);
  const pressed = await page.evaluate((id) => Ext.getCmp(id)?.pressed, buttonId);
  if (typeof pressed !== 'boolean') throw new Error('CRITERIA_EXPANDER_UNAVAILABLE');
  if (!pressed) await expander.click();
  await page.waitForFunction((id) => {
    const visible = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].some((element) =>
      (element.offsetWidth || element.offsetHeight) && getComputedStyle(element).visibility === 'visible');
    return Ext.getCmp(id)?.pressed === true && visible('roomtypes') && visible('rateplans');
  }, buttonId, { timeout: 10000 });
}

async function chooseDate(page, iso) {
  const picker = page.locator('.x-daterange:visible').last();
  const title = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: '2-digit', year: 'numeric',
  }).format(calendarDay(iso));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const exact = picker.locator(`td.x-datepicker-active[title="${title}"] a`);
    if (await exact.count() === 1) { await exact.click(); return; }
    const calendars = await picker.locator('.x-datepicker:visible').evaluateAll((elements) => elements.map((element) => {
      const anchor = [...element.querySelectorAll('td.x-datepicker-active[title]')]
        .find((cell) => cell.title !== 'Today');
      const date = anchor ? new Date(anchor.title) : null;
      const today = element.querySelector('td.x-datepicker-today');
      return { month: date && !Number.isNaN(date.getTime())
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : null,
      today: today ? Number.parseInt(today.innerText, 10) : null };
    }));
    const index = calendars.findIndex((calendar) => calendar.month === iso.slice(0, 7));
    if (index >= 0) {
      if (calendars[index].today !== Number(iso.slice(8))) throw new Error('DATE_NOT_SELECTABLE');
      await picker.locator('.x-datepicker:visible').nth(index).locator('td.x-datepicker-today a').click();
      return;
    }
    if (!calendars.length || calendars.some((calendar) => !calendar.month)) throw new Error('DATE_PICKER_UNAVAILABLE');
    const direction = iso.slice(0, 7) < calendars[0].month ? 'prev' : 'next';
    await picker.locator(`.x-daterange-${direction}:visible`).click();
    await page.waitForTimeout(100);
  }
  throw new Error('DATE_OUTSIDE_PICKER_RANGE');
}

async function setDates(page, input) {
  await openPicker(page, 'dates');
  await chooseDate(page, input.arrivalDate);
  await chooseDate(page, input.departureDate);
  const picker = page.locator('.x-daterange:visible').last();
  if (await picker.isVisible()) {
    await picker.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ }).click();
  }
}

async function setGuests(page, input) {
  await openPicker(page, 'guests');
  const picker = page.locator('.x-guestpicker:visible').last();
  const adults = picker.locator('input[name="adults"]:visible');
  const children = picker.locator('input[name="children"]:visible');
  await adults.fill(String(input.adults));
  await adults.press('Tab');
  await children.fill(String(input.childAges.length));
  await children.press('Tab');
  const ages = picker.locator('input:visible:not([name="adults"]):not([name="children"])');
  await page.waitForFunction(({ id, count }) => {
    const root = document.getElementById(id);
    return root && [...root.querySelectorAll('input:not([name="adults"]):not([name="children"])')]
      .filter((el) => el.offsetWidth || el.offsetHeight).length === count;
  }, { id: await picker.getAttribute('id'), count: input.childAges.length }, { timeout: 10000 });
  for (const [index, age] of input.childAges.entries()) {
    await ages.nth(index).locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first().click();
    await page.locator('.x-boundlist-item:visible').filter({ hasText: new RegExp(`^\\s*${age}\\s*$`) }).click();
  }
  await picker.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ }).click();
}

async function readCatalog(page, name, propertyCode) {
  await ensureAdvancedCriteria(page);
  await openPicker(page, name);
  const title = name === 'roomtypes' ? 'Room Types' : 'Rate Plans';
  const win = page.locator('.x-window:visible:not(.x-menu)').filter({
    has: page.locator('.x-window-header-text').filter({ hasText: new RegExp(`^${title}$`) }),
  }).last();
  await win.waitFor({ state: 'visible', timeout: 20000 });
  try {
    const state = () => win.evaluate((element) => {
      const store = Ext.getCmp(element.id)?.query('grid,readonlygrid')?.[0]?.getStore?.();
      const match = element.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
      return { records: store?.getRange?.().map((record) => ({ ...record.data })) ?? null,
        reportedLoaded: match ? Number(match[1]) : null, reportedTotal: match ? Number(match[2]) : null };
    });
    const windowId = await win.getAttribute('id');
    const waitForCatalog = async (minimum) => {
      await page.waitForFunction(({ id, minimum }) => {
        const element = document.getElementById(id);
        const store = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.();
        const match = element?.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
        const count = store?.getCount?.();
        return store && !store.isLoading() && !Ext.Ajax.isLoading() && match &&
          count >= minimum && Number(match[1]) === count;
      }, { id: windowId, minimum }, { timeout: 20000 });
    };
    await waitForCatalog(1);
    let current = await state();
    for (let pageNumber = 0; current.records && current.reportedTotal > current.records.length && pageNumber < 20; pageNumber += 1) {
      const previous = current.records.length;
      await win.locator('.x-grid-view:visible').last().evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await waitForCatalog(previous + 1);
      current = await state();
    }
    const codeField = name === 'roomtypes' ? 'roomtypecode' : 'rateplancode';
    const selectedCodes = (current.records || []).map((row) => clean(row[codeField]));
    const complete = current.reportedTotal !== null && current.reportedTotal === current.records?.length &&
      current.reportedLoaded === current.records?.length;
    if (!complete || !selectedCodes.length || selectedCodes.some((code) => !code || code.includes(',')) ||
        new Set(selectedCodes).size !== selectedCodes.length ||
        current.records.some((row) => clean(row.property).toUpperCase() !== propertyCode.toUpperCase())) {
      throw new Error('CATALOG_INCOMPLETE_OR_AMBIGUOUS');
    }
    return { ...current, complete, codes: selectedCodes };
  } finally {
    if (await win.isVisible().catch(() => false)) {
      await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ }).first().click({ timeout: 10000 });
      await win.waitFor({ state: 'hidden', timeout: 10000 });
    }
  }
}

async function setCodes(page, name, selected) {
  await ensureAdvancedCriteria(page);
  const input = page.locator(`input[name="${name}"]:visible`).first();
  await input.fill(selected.join(','));
  await input.press('Tab');
}

// This specific HMS message is informational; leave every other dialog alone.
async function dismissUnavailableDialog(page, timeout = 0) {
  const dialog = page.locator('.x-message-box:visible').filter({
    has: page.getByText('Selected criteria is not available for these dates.', { exact: true }),
  });
  if (timeout) await dialog.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  const count = await dialog.count();
  if (!count) return false;
  if (count !== 1) throw new Error('UNAVAILABLE_DIALOG_AMBIGUOUS');
  const ok = dialog.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (await ok.count() !== 1) throw new Error('UNAVAILABLE_DIALOG_AMBIGUOUS');
  await ok.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  return true;
}

function requestMatches(actual, input, selected, nights, party) {
  const appliedAges = !Object.hasOwn(actual, 'childAges') && clean(actual.childCount) === '0'
    ? [] : actual.childAges;
  return clean(actual.launchedFrom).toLowerCase() === 'hotelavailability' &&
    clean(actual.propertyCodes).toUpperCase() === clean(input.propertyCode).toUpperCase() &&
    clean(actual.startDate).slice(0, 10) === input.arrivalDate && Number(actual.numberOfDays) === nights &&
    Number(actual.adultCount) === input.adults && Number(actual.childCount) === input.childAges.length &&
    Array.isArray(appliedAges) && JSON.stringify(appliedAges) === JSON.stringify(input.childAges) &&
    sameCodes(clean(actual.roomTypeCodes).split(',').map(clean).filter(Boolean), selected.roomTypes) &&
    sameCodes(clean(actual.ratePlanCodes).split(',').map(clean).filter(Boolean), selected.ratePlans) &&
    Object.entries(PARTY_PICKERS).every(([kind, spec]) => Object.hasOwn(actual, spec.requestField) &&
      clean(actual[spec.requestField]) === (party[kind] || ''));
}

async function verifyPartySelections(page, surface, party, propertyCode) {
  await ensureAdvancedCriteria(surface);
  const state = selectedParties.get(page);
  for (const [kind, spec] of Object.entries(PARTY_PICKERS)) {
    const value = clean(await surface.locator(`input[name="${spec.field}"]:visible`).first().inputValue());
    if (!party[kind]) {
      if (value) throw new Error('UNREQUESTED_PARTY_CONTEXT');
      continue;
    }
    const selection = state?.surface === surface && state.propertyCode === clean(propertyCode).toUpperCase()
      ? state.values[kind] : null;
    if (!selection || selection.nativeId !== party[kind] || value.toLocaleLowerCase() !== selection.name.toLocaleLowerCase()) {
      throw new Error('PARTY_SELECTION_NOT_VERIFIED');
    }
  }
}

const partyWindow = (surface, spec) => surface.locator('.x-window:visible:not(.x-menu)').filter({
  has: surface.locator('.x-window-header-text').filter({ hasText: new RegExp(`^${spec.title}$`) }),
}).last();
const rowKey = (row, keys) => JSON.stringify(keys.map((key) => clean(row[key]) || null));
const rowSignature = (rows, keys) => JSON.stringify(rows.map((row) => rowKey(row, keys)).sort());

function parsePartyResponse(body) {
  const json = body.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json);
  const data = payload?.pageData;
  const hasContent = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  const failed = [payload, data].some((part) => part && ((Object.hasOwn(part, 'success') && part.success !== true) ||
    hasContent(part.error) || hasContent(part.errors)));
  const grid = data?.grid?.GRIDRESULT?.GRID;
  if (!data || failed || hasContent(data.messages) || !Array.isArray(grid?.DATA) || !grid?.METADATA) {
    throw new Error('PARTY_LOOKUP_RESPONSE_INVALID');
  }
  return grid;
}

async function readPartyGrid(surface, id) {
  return surface.evaluate((windowId) => {
    const win = Ext.getCmp(windowId);
    const grid = win?.query('grid,readonlygrid')?.[0];
    const store = grid?.getStore?.();
    if (!win?.isVisible?.() || !store) throw new Error('PARTY_LOOKUP_GRID_UNAVAILABLE');
    const columns = grid.getColumnManager?.()?.getColumns?.() || grid.columns || [];
    return { records: store.getRange().map((record) => ({ ...record.data })),
      columns: columns.map((column) => ({ label: column.text ?? null, field: column.dataIndex ?? null,
        hidden: Boolean(column.hidden) })) };
  }, id);
}

async function readPartyCriteria(win) {
  return win.locator('input:visible, select:visible, textarea:visible').evaluateAll((elements) =>
    elements.map((element) => ({ name: element.name || null,
      label: element.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim() || null,
      value: element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value,
      type: element.type || element.tagName.toLowerCase() })));
}

async function readAvailabilityFields(surface) {
  return surface.locator('input:visible, select:visible, textarea:visible').evaluateAll((elements) => elements
    .filter((element) => !element.closest('.x-window') && !['hidden', 'password'].includes(element.type))
    .map((element) => ({ id: element.id || null, name: element.name || null,
      label: element.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim() || null,
      value: element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value,
      type: element.type || element.tagName.toLowerCase(), disabled: element.disabled, readOnly: element.readOnly || false })));
}

function changedAvailabilityFields(before, after) {
  const prior = new Map(before.filter((field) => field.id).map((field) => [field.id, field]));
  const current = new Map(after.filter((field) => field.id).map((field) => [field.id, field]));
  return [...new Set([...prior.keys(), ...current.keys()])].flatMap((id) => {
    const oldField = prior.get(id) || null;
    const newField = current.get(id) || null;
    return JSON.stringify(oldField) === JSON.stringify(newField) ? [] : [{ before: oldField, after: newField }];
  });
}

async function waitForPartyRows(surface, windowId, baseKeys, responseRows, timeoutMs) {
  const handle = await surface.waitForFunction(({ id, base, rows }) => {
    const win = Ext.getCmp(id);
    const store = win?.query('grid,readonlygrid')?.[0]?.getStore?.();
    if (!win?.isVisible?.() || !store) return false;
    const records = store.getRange().map(({ data }) => data);
    const scalar = (value) => value == null || ['string', 'number', 'boolean'].includes(typeof value);
    const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) =>
      !/date|time/i.test(key) && records.some((record) => Object.hasOwn(record, key)) &&
      rows.every((row) => scalar(row[key])) && records.every((record) => scalar(record[key])));
    const keys = [...new Set([...base, ...extra])].sort();
    const normalized = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
    const signature = (items) => JSON.stringify(items.map((row) =>
      JSON.stringify(keys.map((key) => normalized(row[key])))).sort());
    return signature(records) === signature(rows) ? keys : false;
  }, { id: windowId, base: baseKeys, rows: responseRows }, { timeout: timeoutMs });
  const keys = await handle.jsonValue();
  await handle.dispose();
  return keys;
}

function partyCoverage(metadata, loaded) {
  const more = clean(metadata.MORERECORDPRESENT);
  const serverMoreRecords = more === '+' ? true : more === '-' ? false : null;
  const reportedTotal = metadata.RECORDS ?? null;
  const numericTotal = /^\d+$/.test(String(reportedTotal)) ? Number(reportedTotal) : null;
  const total = numericTotal != null && numericTotal >= loaded && !(serverMoreRecords && numericTotal === loaded)
    ? numericTotal : null;
  const pageSize = /^\d+$/.test(String(metadata.CLIENTROWS)) ? Number(metadata.CLIENTROWS) : null;
  const truncated = serverMoreRecords === true || (total != null && total > loaded) ? true
    : serverMoreRecords === false && ((total != null && total === loaded) || (pageSize != null && loaded < pageSize))
      ? false : null;
  return { loaded, total, reportedTotal, pageSize, serverMoreRecords, truncated, possiblyTruncated: truncated !== false };
}

function partyIssue(error) {
  const message = String(error?.message || error).split('\n')[0];
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'PARTY_LOOKUP_FAILED';
}

/** Search a Hotel Availability party picker; the caller explicitly selects a current candidate. */
export async function searchHotelAvailabilityParty(page, input, { timeoutMs = 20000 } = {}) {
  const kind = input?.kind;
  const spec = Object.hasOwn(PARTY_PICKERS, kind) ? PARTY_PICKERS[kind] : null;
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const propertyCode = typeof input?.propertyCode === 'string' ? clean(input.propertyCode).toUpperCase() : '';
  if (!page || typeof page.locator !== 'function' || typeof page.context !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  lastPartySearch.delete(page);
  if (!propertyCode || /[\r\n]/.test(propertyCode)) return { outcome: 'input_gap', issue: 'PROPERTY_REQUIRED' };
  if (!spec || !query || query.length > 200 || /[\r\n]/.test(query)) {
    return { outcome: 'input_gap', issue: 'PARTY_KIND_AND_QUERY_REQUIRED' };
  }
  busyPages.add(page);
  let stage = 'opening_picker';
  let captureRequest;
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const surface = await openHotelAvailability(page);
    await dismissUnavailableDialog(surface);
    const displayedProperty = clean(await surface.locator('input[name="propertycodes"]:visible').first().inputValue()).toUpperCase();
    if (displayedProperty !== propertyCode) throw new Error('PROPERTY_MISMATCH');
    await ensureAdvancedCriteria(surface);
    let win = partyWindow(surface, spec);
    const openWindows = surface.locator('.x-window:visible:not(.x-menu)');
    if (await openWindows.count() && !await win.isVisible()) throw new Error('UNEXPECTED_DIALOG');
    if (!await win.isVisible()) {
      await openPicker(surface, spec.field);
      win = partyWindow(surface, spec);
      await win.waitFor({ state: 'visible', timeout: timeoutMs });
    }
    if (await openWindows.count() !== 1) throw new Error('PARTY_PICKER_AMBIGUOUS');
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('PARTY_PICKER_UNAVAILABLE');
    stage = 'applying_filter';
    const selector = win.locator('input[name="filterfields"]:visible').first();
    if (clean(await selector.inputValue()) !== spec.filter) {
      await selector.click();
      await surface.locator('.x-boundlist-item:visible')
        .filter({ hasText: new RegExp(`^\\s*${spec.filter}\\s*$`) }).first().click();
    }
    if (clean(await selector.inputValue()) !== spec.filter) throw new Error('PARTY_FILTER_NOT_SELECTED');
    const inputField = win.locator('input[name="selfiltervaluectrl"]:visible').first();
    await inputField.fill(query);
    if (clean(await inputField.inputValue()) !== query) throw new Error('PARTY_FILTER_NOT_APPLIED');
    const controls = await readPartyCriteria(win);
    const requests = new Set();
    captureRequest = (request) => {
      try {
        const url = new URL(request.url());
        if (request.method() !== 'POST' || url.origin !== new URL(page.url()).origin || url.pathname !== '/web/base/GRIDDATA') return;
        const body = new URLSearchParams(request.postData() || '');
        if (body.get('MADDON_FILTER_ALIAS_NAME_1') === spec.alias &&
            clean(body.get('MADDON_FILTER_VALUE_1')).toLocaleLowerCase() === query.toLocaleLowerCase()) requests.add(request);
      } catch { /* Ignore unrelated requests. */ }
    };
    page.on('request', captureRequest);
    const responsePromise = page.waitForResponse((response) => requests.has(response.request()), { timeout: timeoutMs })
      .catch(() => null);
    stage = 'running_search';
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ }).first().click();
    const response = await responsePromise;
    if (!response || response.status() !== 200) throw new Error('PARTY_SEARCH_UNVERIFIED');
    const requestFilters = [...new URLSearchParams(response.request().postData() || '')]
      .filter(([name]) => name.startsWith('MADDON_FILTER_')).map(([name, value]) => ({ name, value }));
    stage = 'reading_response';
    let timer;
    const body = await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PARTY_RESPONSE_TIMEOUT')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
    const { DATA: rows, METADATA: metadata } = parsePartyResponse(body);
    stage = 'waiting_for_grid';
    const keys = await waitForPartyRows(surface, windowId, [spec.id, spec.name], rows, timeoutMs);
    const grid = await readPartyGrid(surface, windowId);
    if (nativeDialog || await openWindows.count() !== 1 || !await win.isVisible()) throw new Error('UNEXPECTED_DIALOG');
    if (rowSignature(grid.records, keys) !== rowSignature(rows, keys) ||
        JSON.stringify(await readPartyCriteria(win)) !== JSON.stringify(controls)) throw new Error('PARTY_RESULTS_UNVERIFIED');
    const coverage = partyCoverage(metadata, grid.records.length);
    if (!rows.length && (coverage.serverMoreRecords !== false || (coverage.total != null && coverage.total !== 0))) {
      throw new Error('PARTY_EMPTY_UNVERIFIED');
    }
    const candidates = rows.map((row) => {
      const matches = grid.records.filter((record) => rowKey(record, keys) === rowKey(row, keys));
      return { nativeId: clean(row[spec.id]) || null, name: clean(row[spec.name]) || null,
        ...(kind === 'group' ? { propertyCode: clean(row.propertycodes) || null } : {}),
        responseData: row, gridData: matches.length === 1 ? matches[0] : null,
        ...(matches.length > 1 ? { possibleGridData: matches } : {}) };
    });
    const searchId = randomUUID();
    lastPartySearch.set(page, { surface, kind, propertyCode, windowId, searchId, controls: JSON.stringify(controls),
      grid: JSON.stringify(grid.records), candidates: candidates.map(({ nativeId, name, propertyCode: candidateProperty }) =>
        ({ nativeId, name, propertyCode: candidateProperty })) });
    const unverified = (records) => [...new Set(records.flatMap((row) => Object.keys(row)))].filter((key) => !keys.includes(key));
    return { outcome: candidates.length ? 'matches' : 'no_match', kind, propertyCode, query, searchId,
      criteria: { field: spec.filter, query, controls, requestFilters }, coverage, columns: grid.columns, metadata, candidates,
      correlation: { verifiedFields: keys, unverifiedResponseFields: unverified(rows), unverifiedGridFields: unverified(grid.records) } };
  } catch (error) {
    return { outcome: 'execution_failure', kind, stage, issue: nativeDialog ? 'UNEXPECTED_DIALOG' : partyIssue(error) };
  } finally {
    if (captureRequest) page.off('request', captureRequest);
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

/** Select one native ID from the latest still-open search and read the field back. */
export async function selectHotelAvailabilityParty(page, input) {
  if (!page || typeof page.locator !== 'function' || typeof page.context !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  const kind = input?.kind;
  const nativeId = typeof input?.nativeId === 'string' ? clean(input.nativeId) : '';
  const searchId = typeof input?.searchId === 'string' ? clean(input.searchId) : '';
  if (!Object.hasOwn(PARTY_PICKERS, kind) || !nativeId || !searchId) return { outcome: 'input_gap', issue: 'PARTY_SELECTION_REQUIRED' };
  busyPages.add(page);
  let attempted = false;
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const previous = lastPartySearch.get(page);
    if (!previous || previous.kind !== kind || previous.searchId !== searchId) throw new Error('PARTY_LOOKUP_STALE');
    const candidates = previous.candidates.filter((item) => item.nativeId === nativeId);
    if (candidates.length !== 1 || !candidates[0].name) throw new Error('PARTY_ID_NOT_UNIQUE');
    if (kind === 'group' && clean(candidates[0].propertyCode).toUpperCase() !== previous.propertyCode) {
      throw new Error('GROUP_PROPERTY_UNVERIFIED');
    }
    const surface = await availabilitySurface(page);
    if (!surface || surface !== previous.surface) throw new Error('PARTY_LOOKUP_STALE');
    const confirmation = page.locator('input[name="confirmationnumber"]:visible');
    const agency = page.locator('input[name="ta1"]:visible');
    if (await confirmation.count() === 1 && await agency.count() === 1 && clean(await confirmation.inputValue())) {
      throw new Error('NOT_A_NEW_GUEST_STAY');
    }
    const displayedProperty = clean(await surface.locator('input[name="propertycodes"]:visible').first().inputValue()).toUpperCase();
    if (displayedProperty !== previous.propertyCode) throw new Error('PROPERTY_MISMATCH');
    const spec = PARTY_PICKERS[kind];
    const win = partyWindow(surface, spec);
    if (!await win.isVisible() || await win.getAttribute('id') !== previous.windowId ||
        await surface.locator('.x-window:visible:not(.x-menu)').count() !== 1) throw new Error('PARTY_LOOKUP_STALE');
    const grid = await readPartyGrid(surface, previous.windowId);
    if (JSON.stringify(grid.records) !== previous.grid || JSON.stringify(await readPartyCriteria(win)) !== previous.controls) {
      throw new Error('PARTY_LOOKUP_STALE');
    }
    const before = await readAvailabilityFields(surface);
    const rows = win.locator('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row');
    const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
      const grid = (Ext.ComponentQuery.query('grid,readonlygrid') || []).find((item) => item.getEl?.()?.dom?.contains(element));
      const data = grid?.getView?.()?.getRecord?.(element)?.data;
      return String(data?.[wanted.key] ?? '').trim() === wanted.id ? [index] : [];
    }), { key: spec.id, id: nativeId });
    if (indexes.length !== 1) throw new Error('PARTY_ID_NOT_UNIQUE');
    attempted = true;
    await rows.nth(indexes[0]).click();
    const selectedId = await surface.evaluate(({ id, key }) => {
      const selected = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getSelectionModel?.()?.getSelection?.() || [];
      return selected.length === 1 ? String(selected[0].data?.[key] ?? '').trim() : null;
    }, { id: previous.windowId, key: spec.id });
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    if (selectedId !== nativeId || JSON.stringify((await readPartyGrid(surface, previous.windowId)).records) !== previous.grid) {
      throw new Error('PARTY_SELECTION_CHANGED');
    }
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ }).first().click();
    await win.waitFor({ state: 'hidden', timeout: 20000 });
    if (nativeDialog || await surface.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    const displayed = clean(await surface.locator(`input[name="${spec.field}"]:visible`).first().inputValue());
    if (displayed.toLocaleLowerCase() !== candidates[0].name.toLocaleLowerCase()) throw new Error('PARTY_READBACK_MISMATCH');
    const propertyAfter = clean(await surface.locator('input[name="propertycodes"]:visible').first().inputValue()).toUpperCase();
    if (propertyAfter !== previous.propertyCode) throw new Error('PROPERTY_MISMATCH');
    const after = await readAvailabilityFields(surface);
    const state = selectedParties.get(page);
    const values = state?.surface === surface && state.propertyCode === previous.propertyCode ? state.values : {};
    selectedParties.set(page, { surface, propertyCode: previous.propertyCode,
      values: { ...values, [kind]: { nativeId, name: candidates[0].name } } });
    lastPartySearch.delete(page);
    return { outcome: 'selected', kind, nativeId, searchId, displayedValue: displayed,
      evidence: 'current_picker_and_field_readback', requestVerified: false,
      criteria: { fields: after, changedFields: changedAvailabilityFields(before, after) } };
  } catch (error) {
    if (attempted) lastPartySearch.delete(page);
    return { outcome: attempted ? 'selection_uncertain' : 'execution_failure', kind,
      issue: nativeDialog ? 'UNEXPECTED_DIALOG' : partyIssue(error) };
  } finally {
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

/** Close a current party picker without changing the selected field. */
export async function cancelHotelAvailabilityParty(page) {
  if (!page || typeof page.locator !== 'function' || typeof page.context !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  busyPages.add(page);
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const surface = await availabilitySurface(page);
    if (!surface) throw new Error('HOTEL_AVAILABILITY_NOT_OPENED');
    const windows = surface.locator('.x-window:visible:not(.x-menu)');
    if (!await windows.count()) { lastPartySearch.delete(page); return { outcome: 'no_picker' }; }
    const known = [];
    for (const spec of Object.values(PARTY_PICKERS)) if (await partyWindow(surface, spec).isVisible()) known.push(spec);
    if (known.length !== 1 || await windows.count() !== 1) throw new Error('UNEXPECTED_DIALOG');
    const win = partyWindow(surface, known[0]);
    const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
    if (await cancel.count() !== 1) throw new Error('PARTY_CANCEL_AMBIGUOUS');
    await cancel.click();
    await win.waitFor({ state: 'hidden', timeout: 10000 });
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    lastPartySearch.delete(page);
    return { outcome: 'cancelled' };
  } catch (error) {
    return { outcome: 'execution_failure', issue: nativeDialog ? 'UNEXPECTED_DIALOG' : partyIssue(error) };
  } finally {
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

/** Search without saving a booking. `all` loads the picker catalog; arrays request explicit codes. */
export async function searchHotelAvailability(page, input) {
  let validated;
  try { validated = validate(input); }
  catch (error) { return { outcome: 'input_gap', issue: error.message }; }
  if (!page || typeof page.locator !== 'function' || typeof page.context !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  busyPages.add(page);
  let stage = 'opening_screen';
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const surface = await openHotelAvailability(page);
    await dismissUnavailableDialog(surface);
    const property = await surface.locator('input[name="propertycodes"]:visible').first().inputValue();
    if (clean(property).toUpperCase() !== clean(input.propertyCode).toUpperCase()) throw new Error('PROPERTY_MISMATCH');
    stage = 'loading_catalogs';
    const catalogs = {};
    if (input.roomTypes === 'all') catalogs.roomTypes = await readCatalog(surface, 'roomtypes', input.propertyCode);
    if (input.ratePlans === 'all') catalogs.ratePlans = await readCatalog(surface, 'rateplans', input.propertyCode);
    const selected = {
      roomTypes: catalogs.roomTypes?.codes ?? codes(input.roomTypes),
      ratePlans: catalogs.ratePlans?.codes ?? codes(input.ratePlans),
    };
    stage = 'setting_criteria';
    await setDates(surface, input);
    await setGuests(surface, input);
    await setCodes(surface, 'roomtypes', selected.roomTypes);
    await setCodes(surface, 'rateplans', selected.ratePlans);
    await verifyPartySelections(page, surface, validated.party, input.propertyCode);
    stage = 'searching';
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      const url = new URL(response.url());
      return request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        /\/(?:rateshop|hotelAvail)\/inquiryForGrid$/i.test(url.pathname);
    }, { timeout: 60000 }).catch(() => null);
    await surface.locator('a.x-btn:visible').filter({ hasText: /^\s*Search\s*$/ }).first().click();
    const response = await responsePromise;
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    if (!response || response.status() !== 200 || await response.finished()) throw new Error('SEARCH_REQUEST_FAILED');
    const applied = JSON.parse(response.request().postData() || '{}');
    if (!requestMatches(applied, input, selected, validated.nights, validated.party)) throw new Error('SEARCH_CRITERIA_MISMATCH');
    let rawResponse = null;
    try { rawResponse = await response.text(); } catch { /* HMS sometimes returns no readable body. */ }
    let data = null;
    try { data = JSON.parse(rawResponse); } catch { /* An unavailable search can have no JSON body. */ }
    const { bookingSessionID: _session, ...appliedCriteria } = applied;
    const snapshot = { outcome: 'ok', observedAt: new Date().toISOString(), requestedCriteria: input,
      appliedCriteria, catalogs, response: data };
    if (!data?.availabilitydata || !Array.isArray(data.availabilitydata.children) ||
        !Array.isArray(data.availabilitydata.datesList)) {
      if (await dismissUnavailableDialog(surface, 15000)) {
        snapshot.outcome = 'criteria_unavailable';
        snapshot.message = 'Selected criteria is not available for these dates.';
        if (data === null) snapshot.rawResponse = rawResponse;
        return { outcome: 'criteria_unavailable', issue: 'SELECTED_CRITERIA_NOT_AVAILABLE', snapshot };
      }
      throw new Error('SEARCH_RESPONSE_INVALID');
    }
    snapshot.displayedPrices = await captureAvailabilityDisplay(surface, snapshot)
      .catch(() => ({ outcome: 'unavailable', source: 'visible_hms_grid' }));
    return { outcome: 'ok', snapshot };
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    return { outcome: 'execution_failure', stage,
      issue: nativeDialog ? 'UNEXPECTED_DIALOG' : /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'HOTEL_AVAILABILITY_FAILED' };
  } finally {
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

/** Return a smaller view while keeping the full snapshot available to the caller. */
export function filterHotelAvailability(snapshot, { roomTypes, ratePlans } = {}) {
  if ((roomTypes != null && !Array.isArray(roomTypes)) || (ratePlans != null && !Array.isArray(ratePlans))) {
    throw new TypeError('Filter roomTypes and ratePlans must be arrays.');
  }
  const roomSet = roomTypes && new Set(codes(roomTypes));
  const rateSet = ratePlans && new Set(codes(ratePlans));
  const original = snapshot.response.availabilitydata;
  const children = original.children.map((property) => {
    if (!property.isprop || property.issummary || !Array.isArray(property.children)) return property;
    return { ...property, children: property.children.filter((room) => !roomSet || roomSet.has(room.code))
      .map((room) => ({ ...room, children: (room.children || []).filter((rate) => !rateSet || rateSet.has(rate.code)) })) };
  });
  return { observedAt: snapshot.observedAt, requestedCriteria: snapshot.requestedCriteria,
    appliedCriteria: snapshot.appliedCriteria, filters: { roomTypes: roomTypes ?? null, ratePlans: ratePlans ?? null },
    availability: { ...original, children } };
}
