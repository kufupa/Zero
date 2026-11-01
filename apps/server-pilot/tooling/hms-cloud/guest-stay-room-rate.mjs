// Current room/rate catalogs and explicit room selection on an unsaved HRCEN Guest Stay.
import { randomUUID } from 'node:crypto';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const PROPERTY = 'HRCEN';
const HMS_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const UNAVAILABLE_MESSAGE = 'Selected criteria is not available for these dates.';
const ROOM_CHANGE_PATHS = ['/web/base/OSRESV.HDR.roomtypechange', '/web/base/OSRESV.HDR.attributerefresh'];
const SPECS = {
  roomType: { title: 'Room Types', grid: 'LVROOMTYPE2', code: 'roomtypecode', id: 'roomtypeid', name: 'roomtypedesc' },
  ratePlan: { title: 'Rate Plans', grid: 'LVMULTIRATEPLANS3', code: 'rateplancode', name: 'rateplanname' },
};
const searches = new WeakMap(), guards = new WeakMap();
const busy = new WeakSet();
const clean = (v) => String(v ?? '').trim();
const validCode = (v) => /^[A-Z][A-Z0-9_]{2,100}$/.test(v);
const issue = (error, fallback) => validCode(clean(error?.message).split('\n')[0])
  ? clean(error.message).split('\n')[0] : fallback;
const picker = (page, title) => page.locator('.x-window:visible:not(.x-menu)').filter({
  has: page.locator('.x-window-header-text').filter({ hasText: new RegExp(`^${title}$`) }),
}).last();

async function assertWindows(page, allowed, nativeDialog, allowUnavailableMessage = false) {
  if (nativeDialog()) throw new Error('UNEXPECTED_DIALOG');
  const wins = page.locator('.x-window:visible:not(.x-menu)');
  const titles = [];
  for (let i = 0; i < await wins.count(); i += 1) {
    const win = wins.nth(i);
    if (allowUnavailableMessage && await win.evaluate((el) => el.matches('.x-message-box'))) continue;
    const headers = await win.locator('.x-window-header-text:visible').allTextContents();
    if (headers.length !== 1 || !allowed.includes(headers[0].trim())) throw new Error('UNEXPECTED_DIALOG');
    titles.push(headers[0].trim());
  }
  if (new Set(titles).size !== titles.length) throw new Error('UNEXPECTED_DIALOG');
}
async function dismissUnavailableMessage(page, nativeDialog, allowedWindows, timeout = 0) {
  const dialog = page.locator('.x-message-box:visible').filter({
    has: page.getByText(UNAVAILABLE_MESSAGE, { exact: true }),
  });
  if (timeout) await dialog.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  const count = await dialog.count();
  if (!count) return false;
  if (count !== 1) throw new Error('UNAVAILABLE_DIALOG_AMBIGUOUS');
  if (await page.locator('.x-message-box:visible').count() !== count) throw new Error('UNEXPECTED_DIALOG');
  await assertWindows(page, allowedWindows, nativeDialog, true);
  const ok = dialog.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (await ok.count() !== 1) throw new Error('UNAVAILABLE_DIALOG_AMBIGUOUS');
  await ok.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  return true;
}
async function formFields(page) {
  if (new URL(page.url()).origin !== HMS_ORIGIN) throw new Error('TARGET_MISMATCH');
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight) && !el.closest('.x-window');
    const properties = [...document.querySelectorAll('[data-qtip="Property"]')].filter(visible);
    const confirmations = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(visible);
    const agency = [...document.querySelectorAll('input[name="ta1"]')].filter(visible);
    if (properties.length !== 1 || properties[0].textContent.trim().toUpperCase() !== 'HRCEN') {
      throw new Error('PROPERTY_MISMATCH');
    }
    if (confirmations.length !== 1 || confirmations[0].value.trim() || agency.length !== 1) {
      throw new Error('NOT_A_NEW_GUEST_STAY');
    }
    let root = agency[0];
    while (root && !root.contains(confirmations[0])) root = root.parentElement;
    if (!root) throw new Error('FORM_UNAVAILABLE');
    return [...root.querySelectorAll('input,textarea,select')]
      .filter((el) => visible(el) && !['hidden', 'password'].includes(el.type))
      .map((el) => ({ id: el.id || null, name: el.name || null,
        label: el.closest('.x-form-item,.x-field')?.querySelector('label')?.innerText?.trim() || null,
        type: el.type || el.tagName.toLowerCase(),
        value: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value,
        disabled: el.disabled, readOnly: Boolean(el.readOnly) }));
  });
}
async function readWindow(page, id) {
  return page.evaluate((windowId) => {
    const win = Ext.getCmp(windowId);
    const element = document.getElementById(windowId);
    const grid = win?.query('grid,readonlygrid')?.[0];
    const store = grid?.getStore?.();
    if (!win?.isVisible?.() || !element || !store || store.isLoading()) throw new Error('PICKER_UNAVAILABLE');
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
    const columns = grid.getColumnManager?.()?.getColumns?.() || grid.columns || [];
    const footer = element.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
    return { records: store.getRange().map((record) => ({ ...record.data })),
      columns: columns.map((column) => ({ label: column.text ?? null, field: column.dataIndex ?? null,
        hidden: Boolean(column.hidden) })),
      controls: [...element.querySelectorAll('input,textarea,select')].filter(visible).map((el) => ({
        name: el.name || null, value: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value,
      })), footer: footer ? { loaded: Number(footer[1]), total: Number(footer[2]) } : null };
  }, id);
}
async function shopControls(page) {
  const win = picker(page, 'Rate Shop');
  if (!await win.isVisible().catch(() => false)) throw new Error('RATE_SHOP_UNAVAILABLE');
  return win.locator('input:visible,textarea:visible,select:visible').evaluateAll((elements) =>
    elements.map((el) => ({ name: el.name || null,
      value: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value })));
}
async function responseText(response) {
  let timer;
  try { return await Promise.race([response.text(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PICKER_RESPONSE_TIMEOUT')), 20000); })]); }
  finally { clearTimeout(timer); }
}
// HMS returns a data-only JavaScript object literal with single-quoted strings.
// Normalize strings and keys without evaluating vendor-supplied code.
function parseResponse(body) {
  let badEscape = false;
  const strings = body.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (all, double, single) => {
    if (double) return double;
    const value = single.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (match, escape) => {
      const values = { "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r',
        t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (Object.hasOwn(values, escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      badEscape = true;
      return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) throw new Error('PICKER_RESPONSE_INVALID');
  const json = strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json);
  const data = payload?.pageData;
  const hasContent = (v) => Array.isArray(v) ? v.length > 0 : v != null && v !== false && v !== '';
  if (!data || [payload, data].some((part) => part &&
      ((Object.hasOwn(part, 'success') && part.success !== true) || hasContent(part.error) || hasContent(part.errors))) ||
      hasContent(data.messages)) throw new Error('PICKER_RESPONSE_INVALID');
  return data;
}
function responseGrid(data) {
  const grid = data?.grid?.GRIDRESULT?.GRID;
  if (!Array.isArray(grid?.DATA) || !grid.METADATA) throw new Error('PICKER_RESPONSE_INVALID');
  return { rows: grid.DATA, metadata: grid.METADATA };
}
function signature(rows, spec) {
  const keys = [spec.id, spec.code, spec.name].filter(Boolean);
  return JSON.stringify(rows.map((row) => JSON.stringify(keys.map((key) => clean(row[key])))).sort());
}
function coverage(metadata, loaded) {
  const more = clean(metadata.MORERECORDPRESENT);
  const serverMoreRecords = more === '+' ? true : more === '-' ? false : null;
  const reported = clean(metadata.RECORDS);
  const number = /^\d+$/.test(reported) ? Number(reported) : null;
  const total = number != null && number >= loaded ? number : null;
  const complete = total === loaded && serverMoreRecords === false ? true
    : serverMoreRecords === true || (total != null && total > loaded) ? false : null;
  return { loaded, total, reportedTotal: metadata.RECORDS ?? null, serverMoreRecords,
    complete, possiblyTruncated: complete !== true };
}
function propertyAlias(body) {
  return [...body.entries()].some(([key, value]) => /^LOV_ALIAS_VALUE_\d+$/.test(key) && value === PROPERTY);
}
function allowedSearch(request, kind, origin) {
  const url = new URL(request.url());
  if (url.origin !== origin || request.method() !== 'POST') return false;
  if (url.search && (url.pathname !== '/api/internalBooking/rateshop/inquiryForGrid' || url.search !== '?houseAvailabilityOnly=true')) return false;
  const body = new URLSearchParams(request.postData() || '');
  const spec = SPECS[kind];
  if (url.pathname === '/web/base/GETCACHE') return body.get('GRID_NAME') === spec.grid;
  if (kind === 'roomType') return url.pathname === '/web/base/LOVPOP' &&
    body.get('GRID_NAME') === spec.grid && body.get('LOV_TAGNAME') === 'roomtype' && propertyAlias(body);
  if (url.pathname === '/web/base/BSMSLV') return body.get('GRID_NAME') === spec.grid && propertyAlias(body);
  if (url.pathname === '/web/base/OSRASD' || url.pathname === '/web/base/OSRASD.RatePlanChange') {
    return body.getAll('property').length === 1 && body.getAll('confirmationnumber').length === 1 &&
      body.get('property') === PROPERTY && !clean(body.get('confirmationnumber'));
  }
  if (url.pathname === '/api/internalBooking/rateshop/inquiryForGrid') {
    try {
      const input = JSON.parse(request.postData() || '{}');
      return clean(input.propertyCodes).toUpperCase() === PROPERTY && !clean(input.reservationStayID) &&
        clean(input.launchedFrom).toLowerCase() === 'gueststay';
    } catch { return false; }
  }
  return false;
}
function roomFilterResetRequest(request, origin, metadata) {
  if (!metadata) return false;
  const url = new URL(request.url());
  const body = new URLSearchParams(request.postData() || '');
  const gridId = clean(metadata.GRIDID), dataSpyId = clean(metadata.DATASPYID);
  const expected = { GRID_ID: gridId, GRID_NAME: SPECS.roomType.grid, DATASPY_ID: dataSpyId,
    USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
    LOV_TAGNAME: 'roomtype', LOV_ALIAS_NAME_1: 'param.propertycode', LOV_ALIAS_VALUE_1: PROPERTY, LOV_ALIAS_TYPE_1: 'text' };
  return request.method() === 'POST' && url.origin === origin && url.pathname === '/web/base/GRIDDATA' && !url.search && !url.hash &&
    /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
    /^\d+$/.test(gridId) && /^\d+$/.test(dataSpyId) && [...body.keys()].length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value);
}
async function withFence(page, allowed, action, scope = null, quarantine = null) {
  const effects = [];
  const requests = new Map();
  const inFlight = new Set();
  let blocked = false, failed = false;
  const origin = new URL(page.url()).origin;
  const onResponse = (response) => {
    const effect = requests.get(response.request());
    if (effect) effect.status = response.status();
  };
  const onFinished = (request) => { inFlight.delete(request); };
  const onFailed = (request) => {
    if (inFlight.delete(request) && requests.get(request)?.permitted) failed = true;
  };
  const handler = async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.fallback();
    const path = new URL(request.url()).pathname;
    const permitted = method === 'POST' && allowed(request, origin);
    const effect = { method, path, permitted };
    effects.push(effect);
    requests.set(request, effect);
    inFlight.add(request);
    if (!permitted) { blocked = true; return route.abort(); }
    if (scope && !scope.allow(request)) { blocked = true; return route.abort(); }
    return route.fallback();
  };
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  await page.route('**/*', handler);
  let verified = false;
  try {
    let result;
    try { result = await action(); }
    catch (error) { if (blocked) throw new Error('UNEXPECTED_REQUEST_BLOCKED'); throw error; }
    const deadline = Date.now() + 10000;
    while (inFlight.size && Date.now() < deadline) await page.waitForTimeout(100);
    if (blocked) throw new Error('UNEXPECTED_REQUEST_BLOCKED');
    if (inFlight.size || failed || effects.some((effect) => effect.permitted && (!effect.status || effect.status >= 400))) {
      throw new Error('PICKER_NETWORK_UNVERIFIED');
    }
    verified = true;
    return { result, effects };
  } finally {
    if (!verified) quarantine?.();
    scope?.close();
    await page.unroute('**/*', handler).catch(() => {});
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}
async function waitGrid(page, id, count, timeout = 15000) {
  await page.waitForFunction(({ id, count }) => {
    const store = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.();
    return store && !store.isLoading() && store.getCount() === count;
  }, { id, count }, { timeout });
}
async function collectCatalog(page, kind, nativeDialog, allowReset) {
  const spec = SPECS[kind];
  const dismissUnavailable = async (timeout = 0) => {
    const state = searches.get(page);
    if (nativeDialog()) throw new Error('UNEXPECTED_DIALOG');
    if (kind !== 'ratePlan' || state?.kind !== 'ratePlan' || !state.shopId) throw new Error('SEARCH_STALE');
    return dismissUnavailableMessage(page, nativeDialog,
      ['Rate Shop', ...(state.windowId ? ['Rate Plans'] : [])], timeout);
  };
  await assertWindows(page, [], nativeDialog);
  const form = await formFields(page), formState = JSON.stringify(form);
  let initial;
  if (kind === 'ratePlan') {
    const inquiry = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === '/api/internalBooking/rateshop/inquiryForGrid' &&
        allowedSearch(request, kind, new URL(page.url()).origin);
    }, { timeout: 20000 }).catch(() => null);
    const rate = page.locator('input[name="rateplan"]:visible').first();
    await rate.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible').click();
    const shop = picker(page, 'Rate Shop');
    await shop.waitFor({ state: 'visible', timeout: 20000 });
    const shopId = await shop.getAttribute('id'); if (!shopId) throw new Error('PICKER_UNAVAILABLE');
    searches.set(page, { kind, shopId, formState, cleanupOnly: true });
    const response = await inquiry;
    if (!response || response.status() !== 200) throw new Error('RATE_SHOP_INQUIRY_UNVERIFIED');
    await responseText(response);
    if (await dismissUnavailable(1000)) return { criteriaUnavailable: true };
    try { await assertWindows(page, ['Rate Shop'], nativeDialog); }
    catch (error) {
      if (await dismissUnavailable()) return { criteriaUnavailable: true };
      throw error;
    }
    initial = page.waitForResponse((response) => {
      const req = response.request();
      return new URL(req.url()).pathname === '/web/base/BSMSLV' && allowedSearch(req, kind, new URL(page.url()).origin);
    }, { timeout: 20000 }).catch(() => null);
    const ratePlans = shop.locator('input[name="rateplans"]:visible').first();
    try { await ratePlans.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible').click({ timeout: 20000 }); }
    catch (error) {
      if (await dismissUnavailable()) return { criteriaUnavailable: true };
      throw error;
    }
  } else {
    initial = page.waitForResponse((response) => {
      const req = response.request();
      return new URL(req.url()).pathname === '/web/base/LOVPOP' && allowedSearch(req, kind, new URL(page.url()).origin);
    }, { timeout: 20000 }).catch(() => null);
    const room = page.locator('input[name="roomtype"]:visible').first();
    await room.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible').click();
  }
  const win = picker(page, spec.title);
  try { await win.waitFor({ state: 'visible', timeout: 20000 }); }
  catch (error) {
    if (kind === 'ratePlan' && await dismissUnavailable()) return { criteriaUnavailable: true };
    throw error;
  }
  const id = await win.getAttribute('id'); if (!id) throw new Error('PICKER_UNAVAILABLE');
  searches.set(page, { kind, windowId: id, shopId: searches.get(page)?.shopId, formState, cleanupOnly: true });
  if (kind === 'ratePlan' && await dismissUnavailable()) return { criteriaUnavailable: true };
  const response = await initial;
  if (kind === 'ratePlan' && await dismissUnavailable()) return { criteriaUnavailable: true };
  if (!response || response.status() !== 200) throw new Error('PICKER_REQUEST_UNVERIFIED');
  let nativeFilters = kind === 'roomType'
    ? [...new URLSearchParams(response.request().postData() || '')]
      .filter(([name]) => /filter/i.test(name)).map(([name, value]) => ({ name, value }))
    : [];
  const initialNativeFilters = nativeFilters.map((item) => ({ ...item }));
  let nativeFilterReset = false;
  let { rows, metadata } = responseGrid(parseResponse(await responseText(response)));
  let initialMetadata = metadata;
  if (clean(metadata.GRIDNAME) !== spec.grid) throw new Error('PICKER_RESPONSE_INVALID');
  await waitGrid(page, id, rows.length);
  let current = await readWindow(page, id);
  const roomFields = form.filter((field) => field.name === 'roomtype');
  const roomCode = roomFields.length === 1 ? clean(roomFields[0].value) : '';
  const filterValue = (name) => nativeFilters.filter((item) => item.name === name).map((item) => item.value);
  const controls = (name) => current.controls.filter((control) => control.name === name).map((control) => clean(control.value));
  const only = (values, value) => values.length === 1 && values[0] === value;
  const emptyGridFilters = ['ff_roomtypecode', 'ff_roomtypedesc', 'ff_unittypecode', 'ff_minadults', 'ff_maxadults',
    'ff_maxchildren', 'ff_bedtype'].every((name) => only(controls(name), ''));
  const resetKnownFilter = kind === 'roomType' && roomCode && nativeFilters.length === 3 &&
    only(filterValue('filterfields'), 'roomtypecode') && only(filterValue('filteroperator'), 'CONTAINS') &&
    only(filterValue('filtervalue'), roomCode) && only(controls('filterfields'), 'Room Type') &&
    only(controls('selfiltervaluectrl'), roomCode) && only(controls('dataspylist'), '(default)') &&
    emptyGridFilters && current.controls.filter((control) => control.name?.startsWith('ff_')).every((control) => !clean(control.value)) &&
    /^\d+$/.test(clean(metadata.GRIDID)) && /^\d+$/.test(clean(metadata.DATASPYID));
  if (resetKnownFilter) {
    const input = win.locator('input[name="selfiltervaluectrl"]:visible');
    const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
    if (await input.count() === 1 && await input.isEditable() && await run.count() === 1) {
      await assertWindows(page, [spec.title], nativeDialog);
      allowReset(metadata);
      await input.fill('');
      if (await input.inputValue() !== '') throw new Error('ROOM_FILTER_RESET_UNVERIFIED');
      const pending = page.waitForResponse((res) => roomFilterResetRequest(res.request(), HMS_ORIGIN, initialMetadata),
        { timeout: 20000 }).catch(() => null);
      await assertWindows(page, [spec.title], nativeDialog);
      await run.click({ timeout: 10000 });
      const reset = await pending;
      if (!reset || reset.status() !== 200 || nativeDialog()) throw new Error('ROOM_FILTER_RESET_UNVERIFIED');
      ({ rows, metadata } = responseGrid(parseResponse(await responseText(reset))));
      if (['GRIDID', 'GRIDNAME', 'DATASPYID'].some((key) => clean(metadata[key]) !== clean(initialMetadata[key]))) {
        throw new Error('ROOM_FILTER_RESET_UNVERIFIED');
      }
      await waitGrid(page, id, rows.length);
      current = await readWindow(page, id);
      if (!only(controls('selfiltervaluectrl'), '') ||
          JSON.stringify(await formFields(page)) !== formState) throw new Error('ROOM_FILTER_RESET_UNVERIFIED');
      nativeFilters = [];
      nativeFilterReset = true;
      initialMetadata = metadata;
    }
  }
  for (let attempt = 0; attempt < 20 && coverage(metadata, rows.length).complete === false; attempt += 1) {
    const next = page.waitForResponse((res) => new URL(res.url()).pathname === '/web/base/GETCACHE' &&
      allowedSearch(res.request(), kind, new URL(page.url()).origin), { timeout: 8000 }).catch(() => null);
    await win.locator('.x-grid-view:visible').last().evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const res = await next;
    if (!res) break;
    if (res.status() !== 200) throw new Error('PICKER_PAGE_FAILED');
    const pageData = responseGrid(parseResponse(await responseText(res)));
    if (!pageData.rows.length || ['GRIDID', 'GRIDNAME', 'DATASPYID', 'RECORDS']
      .some((key) => clean(pageData.metadata[key]) !== clean(initialMetadata[key]))) {
      throw new Error('PICKER_PAGE_INVALID');
    }
    rows.push(...pageData.rows);
    metadata = pageData.metadata;
    await waitGrid(page, id, rows.length);
    current = await readWindow(page, id);
  }
  await assertWindows(page, kind === 'ratePlan' ? ['Rate Shop', spec.title] : [spec.title], nativeDialog);
  if (signature(rows, spec) !== signature(current.records, spec)) throw new Error('PICKER_GRID_MISMATCH');
  const c = coverage(metadata, rows.length);
  if (current.footer && (current.footer.loaded !== rows.length ||
      (c.total != null && current.footer.total !== c.total))) throw new Error('PICKER_COVERAGE_MISMATCH');
  const catalogCoverage = kind !== 'roomType' ? c : nativeFilters.length
    ? { ...c, total: null, complete: false, possiblyTruncated: true, nativeFiltered: true,
      filteredResultTotal: c.total, filteredResultComplete: c.complete }
    : { ...c, nativeFiltered: false };
  const key = (row) => signature([row], spec);
  const candidates = rows.map((row) => {
    const matches = current.records.filter((record) => key(record) === key(row));
    return { nativeId: spec.id ? clean(row[spec.id]) || null : null,
      code: clean(row[spec.code]) || null, name: clean(row[spec.name]) || null,
      responseData: row, gridData: matches.length === 1 ? matches[0] : null,
      ...(matches.length > 1 ? { possibleGridData: matches } : {}) };
  });
  return { windowId: id, shopId: searches.get(page)?.shopId, observedAt: new Date().toISOString(), candidates, coverage: catalogCoverage,
    nativeFilters, initialNativeFilters, nativeFilterReset,
    columns: current.columns, metadata, pickerState: JSON.stringify(current),
    formState: JSON.stringify(await formFields(page)),
    shopState: kind === 'ratePlan' ? JSON.stringify(await shopControls(page)) : null };
}
async function assertCurrent(page, state, nativeDialog) {
  const spec = SPECS[state.kind];
  await assertWindows(page, state.kind === 'ratePlan' ? ['Rate Shop', spec.title] : [spec.title], nativeDialog);
  const win = picker(page, spec.title);
  if (!await win.isVisible().catch(() => false) || await win.getAttribute('id') !== state.windowId ||
      JSON.stringify(await formFields(page)) !== state.formState ||
      JSON.stringify(await readWindow(page, state.windowId)) !== state.pickerState ||
      (state.kind === 'ratePlan' && JSON.stringify(await shopControls(page)) !== state.shopState)) {
    throw new Error('SEARCH_STALE');
  }
}
function options(input) {
  const query = input?.query ?? '';
  const offset = input?.offset ?? 0;
  const limit = input?.limit ?? 20;
  if (typeof query !== 'string' || query.length > 200 || /[\r\n]/.test(query) ||
      !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('INVALID_SEARCH_OPTIONS');
  }
  return { query: query.trim(), offset, limit };
}
async function search(page, kind, input = {}) {
  let filter;
  try { filter = options(input); } catch { return { outcome: 'input_gap', issue: 'INVALID_SEARCH_OPTIONS' }; }
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'PICKER_IN_PROGRESS' };
  busy.add(page);
  let native = false;
  const onDialog = () => { native = true; };
  page.on('dialog', onDialog);
  try {
    const context = page.context();
    if (!guards.has(context)) guards.set(context, installReadOnlyGuard(context).catch((error) => { guards.delete(context); throw error; }));
    await guards.get(context);
    let state = searches.get(page);
    let effects = [];
    if (state?.cleanupOnly || (state && state.kind !== kind)) throw new Error('PICKER_CLOSE_REQUIRED');
    if (state?.kind === kind) {
      await assertCurrent(page, state, () => native);
    } else {
      let resetMetadata = null;
      const capture = await withFence(page, (req, origin) => allowedSearch(req, kind, origin) ||
        (kind === 'roomType' && roomFilterResetRequest(req, origin, resetMetadata)),
      () => collectCatalog(page, kind, () => native, (metadata) => { resetMetadata = metadata; }));
      if (capture.result?.criteriaUnavailable) return {
        outcome: 'criteria_unavailable', kind, issue: 'RATE_SHOP_CRITERIA_UNAVAILABLE',
        message: UNAVAILABLE_MESSAGE, criteria: { propertyCode: PROPERTY, scope: 'guest_stay_rate_shop_catalog' },
        cleanupRequired: true, effects: capture.effects,
      };
      state = { kind, ...capture.result };
      effects = capture.effects;
    }
    const needle = filter.query.toLocaleLowerCase();
    const matches = state.candidates.filter((candidate) =>
      [candidate.nativeId, candidate.code, candidate.name].some((v) => clean(v).toLocaleLowerCase().includes(needle)));
    const searchId = randomUUID();
    searches.set(page, { ...state, searchId });
    const outcome = matches.length ? 'matches' : state.coverage.complete === true ? 'no_match' : 'incomplete';
    return { outcome, kind, searchId, observedAt: state.observedAt,
      criteria: { propertyCode: PROPERTY, scope: kind === 'ratePlan' ? 'guest_stay_rate_shop_catalog' : 'guest_stay_room_catalog',
        query: filter.query, offset: filter.offset, limit: filter.limit,
        ...(kind === 'roomType' ? { nativeFilters: state.nativeFilters.map((item) => ({ ...item })),
          ...(state.nativeFilterReset ? { nativeFilterReset: true,
            initialNativeFilters: state.initialNativeFilters.map((item) => ({ ...item })) } : {}) } : {}),
        ...(state.shopState ? { rateShopControls: JSON.parse(state.shopState) } : {}) },
      coverage: { ...state.coverage, matchingLoaded: matches.length, returned: Math.min(filter.limit, Math.max(0, matches.length - filter.offset)) },
      columns: state.columns, metadata: state.metadata, candidates: matches.slice(filter.offset, filter.offset + filter.limit), effects };
  } catch (error) {
    if (searches.has(page)) searches.set(page, { ...searches.get(page), searchId: null, cleanupOnly: true });
    return { outcome: 'execution_failure', kind, issue: issue(error, 'PICKER_SEARCH_FAILED') };
  } finally {
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}
export const searchRoomTypes = (page, input) => search(page, 'roomType', input);
export const searchRatePlans = (page, input) => search(page, 'ratePlan', input);
function matchingCandidates(state, input) {
  const nativeId = clean(input?.nativeId);
  const code = clean(input?.code);
  if (!nativeId && !code) throw new Error('IDENTIFIER_REQUIRED');
  return state.candidates.filter((candidate) => (!nativeId || candidate.nativeId === nativeId) &&
    (!code || candidate.code === code));
}
export async function inspectRoomRateCandidate(page, input = {}) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'PICKER_IN_PROGRESS' };
  busy.add(page);
  let native = false;
  const onDialog = () => { native = true; };
  page.on('dialog', onDialog);
  try {
    const state = searches.get(page);
    if (!state || !input.searchId || input.searchId !== state.searchId) throw new Error('SEARCH_STALE');
    await assertCurrent(page, state, () => native);
    const candidates = matchingCandidates(state, input);
    return { outcome: candidates.length === 1 ? 'match' : candidates.length ? 'ambiguous' : 'not_in_loaded_results',
      kind: state.kind, searchId: state.searchId, observedAt: state.observedAt, coverage: state.coverage, candidates };
  } catch (error) {
    return { outcome: 'execution_failure', issue: issue(error, 'INSPECTION_FAILED') };
  } finally { page.off('dialog', onDialog); busy.delete(page); }
}
function changedFields(before, after) {
  const key = (field, index) => field.id || `${field.name}:${index}`;
  const previous = new Map(before.map((field, index) => [key(field, index), field]));
  const current = new Map(after.map((field, index) => [key(field, index), field]));
  return [...new Set([...previous.keys(), ...current.keys()])].flatMap((id) => {
    const old = previous.get(id) ?? null;
    const field = current.get(id) ?? null;
    return JSON.stringify(old) === JSON.stringify(field) ? [] : [{ before: old, after: field }];
  });
}
export async function selectRoomType(page, input = {}, { timeoutMs = 20000 } = {}) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'PICKER_IN_PROGRESS' };
  busy.add(page);
  let native = false, attempted = false, fence, scope;
  const onDialog = () => { native = true; };
  const responses = [];
  const onResponse = (response) => { if (ROOM_CHANGE_PATHS.includes(new URL(response.url()).pathname)) responses.push(response); };
  page.on('dialog', onDialog);
  try {
    fence = await installPageRequestFence(page, ROOM_CHANGE_PATHS);
    scope = fence.open();
    const state = searches.get(page);
    if (!state || state.kind !== 'roomType' || !input.searchId || input.searchId !== state.searchId) throw new Error('SEARCH_STALE');
    await assertCurrent(page, state, () => native);
    const candidates = matchingCandidates(state, input);
    if (candidates.length !== 1 || !candidates[0].nativeId || !candidates[0].code) throw new Error('CANDIDATE_NOT_UNIQUE');
    const chosen = candidates[0];
    const win = picker(page, 'Room Types');
    const rows = win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row');
    const indexes = await rows.evaluateAll((elements, id) => elements.flatMap((el, index) => {
      const grid = (Ext.ComponentQuery.query('grid,readonlygrid') || []).find((g) => g.getEl?.()?.dom?.contains(el));
      return String(grid?.getView?.()?.getRecord?.(el)?.data?.roomtypeid ?? '').trim() === id ? [index] : [];
    }), chosen.nativeId);
    if (indexes.length !== 1) throw new Error('CANDIDATE_NOT_UNIQUE');
    const before = await formFields(page);
    page.on('response', onResponse);
    const { result: after, effects } = await withFence(page, (request, origin) => {
      const url = new URL(request.url());
      const body = new URLSearchParams(request.postData() || '');
      const keys = ['propertycode', 'confirmationnumber', 'PKID', 'recordid', 'reservationid', 'roomtype', 'roomtypeid', 'ONLY_DATA_REQUIRED'];
      const bodyKeys = [...body.keys()];
      return url.origin === origin && !url.search && ROOM_CHANGE_PATHS.includes(url.pathname) &&
        keys.every((key) => body.getAll(key).length === 1 && bodyKeys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
        body.get('propertycode') === PROPERTY && !clean(body.get('confirmationnumber')) &&
        body.get('PKID') === `@[EMPTY]#@[EMPTY]#${PROPERTY}#` && !clean(body.get('recordid')) &&
        !clean(body.get('reservationid')) && body.get('ONLY_DATA_REQUIRED') === 'true' &&
        body.get('roomtype') === chosen.code && body.get('roomtypeid') === chosen.nativeId;
    }, async () => {
      attempted = true;
      await rows.nth(indexes[0]).click({ timeout: timeoutMs });
      const selected = await page.evaluate((id) => Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]
        ?.getSelectionModel?.()?.getSelection?.().map((row) => row.data) || [], state.windowId);
      if (selected.length !== 1 || clean(selected[0].roomtypeid) !== chosen.nativeId ||
          JSON.stringify(await readWindow(page, state.windowId)) !== state.pickerState) throw new Error('PICKER_SELECTION_CHANGED');
      await assertWindows(page, ['Room Types'], () => native);
      await win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ }).click({ timeout: timeoutMs });
      await win.waitFor({ state: 'hidden', timeout: timeoutMs }); searches.delete(page);
      await page.waitForFunction(() => !Ext.Ajax.isLoading(), null, { timeout: timeoutMs });
      await assertWindows(page, [], () => native);
      for (const path of ROOM_CHANGE_PATHS) {
        const matched = responses.filter((response) => new URL(response.url()).pathname === path);
        if (matched.length !== 1 || matched[0].status() !== 200) throw new Error('ROOM_CHANGE_UNVERIFIED');
        const values = parseResponse(await responseText(matched[0])).values;
        if (!values || !['propertycode', 'confirmationnumber', 'recordid', 'reservationid', 'roomtype', 'roomtypeid']
          .every((key) => Object.hasOwn(values, key)) || clean(values.propertycode) !== PROPERTY ||
          clean(values.confirmationnumber) || clean(values.recordid) || clean(values.reservationid) ||
          clean(values.roomtype) !== chosen.code || clean(values.roomtypeid) !== chosen.nativeId) throw new Error('ROOM_CHANGE_UNVERIFIED');
      }
      const fields = await formFields(page);
      if (clean(fields.find((item) => item.name === 'roomtype')?.value) !== chosen.code) throw new Error('ROOM_READBACK_MISMATCH');
      return fields;
    }, scope, () => { if (attempted) fence.quarantine(); });
    searches.delete(page);
    return { outcome: 'selected_unsaved', searchId: state.searchId, observedAt: state.observedAt,
      nativeId: chosen.nativeId, code: chosen.code, selectedField: after.find((field) => field.name === 'roomtype'),
      nativeIdEvidence: 'form_change_and_attribute_refresh_responses',
      form: { fields: after, changedFields: changedFields(before, after) }, effects };
  } catch (error) {
    if (attempted) fence?.quarantine();
    if (attempted && searches.has(page)) searches.set(page, { ...searches.get(page), searchId: null, cleanupOnly: true });
    return { outcome: attempted ? 'selection_uncertain' : 'execution_failure', issue: issue(error, 'ROOM_SELECTION_FAILED') };
  } finally { scope?.close(); page.off('response', onResponse); page.off('dialog', onDialog); busy.delete(page); }
}

/** Explicitly discard the open picker (and Rate Shop's pending selection). */
export async function closeRoomRatePicker(page) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'PICKER_IN_PROGRESS' };
  busy.add(page);
  let native = false, cancelAttempted = false;
  const onDialog = () => { native = true; };
  page.on('dialog', onDialog);
  try {
    const state = searches.get(page);
    if (!state) throw new Error('SEARCH_STALE');
    if (state.cleanupOnly) {
      await assertWindows(page, state.kind === 'ratePlan' ? ['Rate Shop', ...(state.windowId ? ['Rate Plans'] : [])] : state.windowId ? ['Room Types'] : [], () => native);
      if (JSON.stringify(await formFields(page)) !== state.formState ||
          (state.windowId && await picker(page, SPECS[state.kind].title).getAttribute('id') !== state.windowId) ||
          (state.shopId && await picker(page, 'Rate Shop').getAttribute('id') !== state.shopId)) throw new Error('SEARCH_STALE');
    } else await assertCurrent(page, state, () => native);
    const result = await withFence(page, (req, origin) => {
      const url = new URL(req.url());
      if (state.kind !== 'ratePlan' || url.origin !== origin || url.search ||
          url.pathname !== `/api/internalBooking/${PROPERTY}/rateshop/rateSelection`) return false;
      try { return JSON.parse(req.postData() || '{}').action === 'CANCEL'; } catch { return false; }
    }, async () => {
      if (state.windowId) {
        const win = picker(page, SPECS[state.kind].title);
        await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ }).click();
        await win.waitFor({ state: 'hidden', timeout: 10000 }); state.windowId = null;
      }
      if (state.kind === 'ratePlan' && state.shopId) {
        const shop = picker(page, 'Rate Shop');
        const close = shop.locator('.x-tool-close:visible');
        if (await close.count() !== 1) throw new Error('RATE_SHOP_CLOSE_UNAVAILABLE');
        cancelAttempted = true; await close.click();
        await shop.waitFor({ state: 'hidden', timeout: 10000 }); state.shopId = null;
      }
      await assertWindows(page, [], () => native);
      await formFields(page);
    });
    searches.delete(page);
    return { outcome: state.cancelUncertain ? 'close_uncertain' : 'closed_unsaved',
      ...(state.cancelUncertain ? { issue: 'RATE_SHOP_CANCEL_UNVERIFIED' } : {}), effects: result.effects };
  } catch (error) {
    const state = searches.get(page);
    if (state && cancelAttempted && !native && !await picker(page, 'Rate Shop').isVisible().catch(() => true)) state.shopId = null;
    if (state) searches.set(page, { ...state, searchId: null, cleanupOnly: true, cancelUncertain: state.cancelUncertain || cancelAttempted });
    return { outcome: cancelAttempted || state?.cancelUncertain ? 'close_uncertain' : 'execution_failure', issue: issue(error, 'PICKER_CLOSE_FAILED') };
  } finally { page.off('dialog', onDialog); busy.delete(page); }
}
