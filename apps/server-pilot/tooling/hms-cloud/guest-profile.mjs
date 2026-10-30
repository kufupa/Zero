// Guest profiles on one authenticated, guarded, blank HRCEN Guest Stay.
import { randomUUID } from 'node:crypto';
import { readUnsavedGuestStay } from './booking-lookup-session.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const CHANGE_PATH = '/web/base/OSRESV.HDR.guestinfo';
const FILTERS = {
  address: ['Address', 'address'], city: ['City', 'city'], country: ['Country', 'country'],
  aliasFirstName: ['Alias First Name', 'aliasfirstname'], aliasLastName: ['Alias Last Name', 'aliaslastname'],
  firstName: ['First Name', 'firstname'], lastName: ['Last Name', 'lastname'],
  secondLastName: ['Second Last Name', 'secondlastname'], email: ['E-mail Address', 'emailaddress'],
  externalId: ['External ID', 'managedprofileid'], loyaltyNumber: ['Loyalty Number', 'loyaltynumber'],
  phoneNumber: ['Phone Number', 'phonenumber'], profileId: ['Profile ID', 'guestid'],
  restrictedReason: ['Restricted Reason', 'restrictedreason_display'], stateProvince: ['State / Province', 'statedesc'],
  title: ['Title', 'title'], vipLevel: ['VIP Level', 'viplevel'], vatId: ['Vat Id', 'taxid'],
};

const busy = new WeakSet();
const currentSearches = new WeakMap();
const clean = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
const sameText = (left, right) => (clean(left) || '').toLocaleLowerCase() === (clean(right) || '').toLocaleLowerCase();
const errorCode = (error, fallback) => /^[A-Z][A-Z0-9_]{2,100}$/.test(String(error?.message || ''))
  ? error.message : fallback;

function safeRead(request) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return false;
  const url = new URL(request.url());
  return url.origin !== ORIGIN || !/^\/web\/base\/.*(?:save|delete|cancel|checkin|checkout|duplicate|crs)/i.test(url.pathname);
}
function forget(page) {
  const state = currentSearches.get(page);
  if (!state) return;
  currentSearches.delete(page);
  page.off('request', state.invalidateOnRun);
  void state.handle.dispose().catch(() => {});
}
function guestWindow(page) {
  return page.locator('.x-window:visible:not(.x-menu)').filter({ has:
    page.locator('.x-window-header-text:visible').filter({ hasText: /^Guests$/ }) });
}

async function checkDialogs(page, nativeDialog, allowGuest = true) {
  if (nativeDialog()) throw new Error('UNEXPECTED_DIALOG');
  const windows = page.locator('.x-window:visible:not(.x-menu)');
  for (let i = 0; i < await windows.count(); i += 1) {
    const titles = await windows.nth(i).locator('.x-window-header-text:visible').allTextContents();
    if (!allowGuest || titles.length !== 1 || titles[0].trim() !== 'Guests') throw new Error('UNEXPECTED_DIALOG');
  }
  if (await guestWindow(page).count() > 1) throw new Error('GUEST_PICKER_NOT_UNIQUE');
}

async function readForm(page) {
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('HMS_TARGET_MISMATCH');
  const valid = await page.evaluate((property) => {
    const visible = (el) => Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' &&
      !el.closest('.x-window'));
    const find = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
    const confirmation = find('confirmationnumber');
    return /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1] === property &&
      confirmation.length === 1 && find('ta1').length === 1 && !confirmation[0].value.trim();
  }, PROPERTY);
  if (!valid) throw new Error('NOT_A_BLANK_HRCEN_GUEST_STAY');
  const result = await readUnsavedGuestStay(page);
  if (result.outcome !== 'ok') throw new Error('GUEST_FORM_UNAVAILABLE');
  if (result.notes?.length) throw new Error('UNEXPECTED_DIALOG');
  return { propertyCode: PROPERTY, fields: result.form.fields };
}

function uniqueField(form, name) {
  const fields = form.fields.filter((field) => field.name === name);
  return fields.length === 1 ? clean(fields[0].value) : undefined;
}
const formIdentity = (form) => ['guestid', 'firstname', 'lastname', 'confirmationnumber'].map((name) => uniqueField(form, name));

async function openPicker(page, nativeDialog) {
  await checkDialogs(page, nativeDialog);
  let win = guestWindow(page);
  if (await win.count()) return win;
  const root = page.locator('input[name="ta1"]:visible').first()
    .locator('xpath=ancestor::*[.//input[@name="confirmationnumber"]][1]');
  const field = root.locator('input[name="lastname"]:visible');
  if (await field.count() !== 1) throw new Error('GUEST_PICKER_TRIGGER_UNAVAILABLE');
  const trigger = field.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible');
  if (await trigger.count() !== 1) throw new Error('GUEST_PICKER_TRIGGER_UNAVAILABLE');
  await trigger.click();
  win = guestWindow(page);
  await win.waitFor({ state: 'visible', timeout: 15000 });
  await checkDialogs(page, nativeDialog);
  return win;
}

async function readCriteria(win) {
  return win.locator('input:visible,select:visible,textarea:visible').evaluateAll((elements) =>
    elements.map((element) => ({
      name: element.name || null,
      label: element.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim() || null,
      value: ['checkbox', 'radio'].includes(element.type) ? element.checked : element.value,
      type: element.type || element.tagName.toLowerCase(),
    })));
}
async function readGrid(page, windowId) {
  return page.evaluate((id) => {
    const win = Ext.getCmp(id);
    const grid = win?.query('grid,readonlygrid')?.[0];
    const store = grid?.getStore?.();
    if (!win?.isVisible?.() || !store) throw new Error('GUEST_GRID_UNAVAILABLE');
    const columns = grid.getColumnManager?.()?.getColumns?.() || grid.columns || [];
    return {
      records: store.getRange().map(({ data }) => ({ ...data })),
      columns: columns.map((column) => ({ label: column.text ?? null, field: column.dataIndex ?? null, hidden: Boolean(column.hidden) })),
    };
  }, windowId);
}

function responseData(text) {
  const json = text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json), data = payload?.pageData;
  const hasContent = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  if (!data || [payload, data].some((part) => part &&
      ((Object.hasOwn(part, 'success') && part.success !== true) || hasContent(part.error) || hasContent(part.errors))) ||
      hasContent(data.messages)) throw new Error('GUEST_RESPONSE_INVALID');
  return data;
}
async function responseText(response, timeoutMs) {
  let timer;
  return Promise.race([response.text(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('GUEST_RESPONSE_TIMEOUT')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function matchesRun(request, alias, query) {
  try {
    const url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    return request.method() === 'POST' && url.origin === ORIGIN && url.pathname === '/web/base/GRIDDATA' &&
      body.get('GRID_NAME') === 'LVGUESTS' && body.get('REQUEST_TYPE') === 'LOV.DATA_ONLY.STORED' &&
      body.get('LOV_ALIAS_VALUE_1') === PROPERTY && body.get('MADDON_FILTER_ALIAS_NAME_1') === alias &&
      sameText(body.get('MADDON_FILTER_VALUE_1'), query);
  } catch { return false; }
}
const rowKey = (row, keys) => JSON.stringify(keys.map((key) => clean(row[key])));
const signature = (rows, keys) => JSON.stringify(rows.map((row) => rowKey(row, keys)).sort());
async function correlateRows(page, windowId, rows, timeoutMs) {
  const handle = await page.waitForFunction(({ id, responseRows }) => {
    const store = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.();
    if (!store) return false;
    const records = store.getRange().map(({ data }) => data);
    const scalar = (value) => value == null || ['string', 'number', 'boolean'].includes(typeof value);
    const extra = [...new Set(responseRows.flatMap((row) => Object.keys(row)))].filter((key) =>
      !/date|time/i.test(key) && records.some((record) => Object.hasOwn(record, key)) &&
      responseRows.every((row) => scalar(row[key])) && records.every((record) => scalar(record[key])));
    const keys = [...new Set(['guestid', 'lastname', 'firstname', ...extra])].sort();
    const cleanValue = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
    const sig = (items) => JSON.stringify(items.map((row) => JSON.stringify(keys.map((key) => cleanValue(row[key])))).sort());
    return sig(records) === sig(responseRows) ? keys : false;
  }, { id: windowId, responseRows: rows }, { timeout: timeoutMs });
  const keys = await handle.jsonValue();
  await handle.dispose();
  return keys;
}

function coverage(metadata, loaded) {
  const marker = String(metadata.MORERECORDPRESENT ?? '').trim();
  const serverMoreRecords = marker === '+' ? true : marker === '-' ? false : null;
  const reportedTotal = metadata.RECORDS ?? null;
  const numericTotal = /^\d+$/.test(String(reportedTotal)) ? Number(reportedTotal) : null;
  const inconsistentTotal = numericTotal != null && numericTotal < loaded;
  const total = numericTotal != null && numericTotal >= loaded && !(serverMoreRecords && numericTotal === loaded)
    ? numericTotal : null;
  const pageSize = /^\d+$/.test(String(metadata.CLIENTROWS)) ? Number(metadata.CLIENTROWS) : null;
  const complete = !inconsistentTotal && serverMoreRecords === false &&
    ((total != null && total === loaded) || (pageSize != null && loaded < pageSize));
  const truncated = serverMoreRecords || (total != null && total > loaded) ? true : complete ? false : null;
  return { loaded, total, reportedTotal, pageSize, serverMoreRecords, truncated, possiblyTruncated: truncated !== false };
}
function candidate(row, grid, keys) {
  const matches = grid.filter((record) => rowKey(record, keys) === rowKey(row, keys));
  return {
    nativeId: clean(row.guestid), firstName: clean(row.firstname), lastName: clean(row.lastname),
    address: clean(row.address), city: clean(row.city), country: clean(row.country),
    email: clean(row.emailaddress), phoneNumber: clean(row.phonenumber),
    externalId: clean(row.managedprofileid), loyaltyNumber: clean(row.loyaltynumber),
    restrictedReason: clean(row.restrictedreason_display),
    responseData: row, gridData: matches.length === 1 ? matches[0] : null,
    ...(matches.length > 1 ? { possibleGridData: matches } : {}),
  };
}

async function requireCurrent(page, state, searchId, nativeDialog) {
  if (!state || !searchId || state.searchId !== searchId) throw new Error('GUEST_SEARCH_STALE');
  await checkDialogs(page, nativeDialog);
  const win = guestWindow(page);
  if (await win.count() !== 1 || await win.getAttribute('id') !== state.windowId ||
      !await win.evaluate((element, saved) => element === saved, state.handle).catch(() => false)) {
    throw new Error('GUEST_SEARCH_STALE');
  }
  const form = await readForm(page);
  const grid = await readGrid(page, state.windowId);
  if (JSON.stringify(await readCriteria(win)) !== state.criteria || JSON.stringify(grid.records) !== state.grid ||
      JSON.stringify(formIdentity(form)) !== state.formIdentity || currentSearches.get(page) !== state) {
    throw new Error('GUEST_SEARCH_STALE');
  }
  return { win, form, grid };
}

/** Search one observed Guests filter; repeat with another criterion to refine. */
export async function searchGuestProfiles(page, input, { timeoutMs = 20000 } = {}) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'GUEST_LOOKUP_IN_PROGRESS', candidates: [] };
  forget(page);
  const field = input?.field ?? 'lastName';
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const spec = Object.hasOwn(FILTERS, field) ? FILTERS[field] : null;
  if (!spec || !query || query.length > 200 || /[\r\n]/.test(query) || (field === 'profileId' && !/^\d+$/.test(query))) {
    return { outcome: 'input_gap', issue: 'GUEST_SEARCH_CRITERION_INVALID', candidates: [] };
  }
  busy.add(page);
  let stage = 'opening_picker', nativeDialog = false, blocked = false;
  const onDialog = () => { nativeDialog = true; };
  const guard = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const popup = request.method() === 'POST' && url.origin === ORIGIN && url.pathname === '/web/base/LOVPOP' &&
      body.get('GRID_NAME') === 'LVGUESTS' && body.get('REQUEST_TYPE') === 'LOV.HEAD_DATA.STORED' &&
      body.get('LOV_TAGNAME') === 'lastname' && body.get('LOV_ALIAS_VALUE_1') === PROPERTY;
    if (safeRead(request) || popup || matchesRun(request, spec[1], query)) {
      return route.fallback();
    }
    blocked = true;
    return route.abort();
  };
  page.on('dialog', onDialog);
  try {
    await page.route('**/*', guard);
    await readForm(page);
    const win = await openPicker(page, () => nativeDialog);
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('GUEST_PICKER_UNAVAILABLE');
    stage = 'applying_filter';
    const selector = win.locator('input[name="filterfields"]:visible').first();
    if ((await selector.inputValue()).trim() !== spec[0]) {
      const trigger = selector.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible');
      if (await trigger.count() !== 1) throw new Error('GUEST_FILTER_UNAVAILABLE');
      await trigger.click();
      const choices = page.locator('.x-boundlist-item:visible');
      await choices.first().waitFor({ state: 'visible', timeout: 5000 });
      const indexes = await choices.evaluateAll((elements, label) =>
        elements.flatMap((element, index) => element.textContent.trim() === label ? [index] : []), spec[0]);
      if (indexes.length !== 1) throw new Error('GUEST_FILTER_UNAVAILABLE');
      await choices.nth(indexes[0]).click();
    }
    if ((await selector.inputValue()).trim() !== spec[0]) throw new Error('GUEST_FILTER_NOT_SELECTED');
    const inputField = win.locator('input[name="selfiltervaluectrl"]:visible').first();
    await inputField.fill(query);
    if ((await inputField.inputValue()).trim() !== query) throw new Error('GUEST_FILTER_NOT_APPLIED');
    const criteria = await readCriteria(win);
    const responsePromise = page.waitForResponse((response) => matchesRun(response.request(), spec[1], query), { timeout: timeoutMs })
      .catch(() => null);
    stage = 'running_search';
    await checkDialogs(page, () => nativeDialog);
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ }).first().click();
    const response = await responsePromise;
    if (!response || response.status() !== 200 || blocked) throw new Error('GUEST_SEARCH_UNVERIFIED');
    const body = new URLSearchParams(response.request().postData() || '');
    const requestFilters = [...body].filter(([name]) => name.startsWith('MADDON_FILTER_'))
      .map(([name, value]) => ({ name, value }));
    stage = 'reading_response';
    const { DATA: rows, METADATA: metadata } = responseData(await responseText(response, timeoutMs)).grid?.GRIDRESULT?.GRID ?? {};
    if (!Array.isArray(rows) || !metadata) throw new Error('GUEST_RESPONSE_INVALID');
    const keys = await correlateRows(page, windowId, rows, timeoutMs);
    await checkDialogs(page, () => nativeDialog);
    const grid = await readGrid(page, windowId);
    if (signature(grid.records, keys) !== signature(rows, keys) || JSON.stringify(await readCriteria(win)) !== JSON.stringify(criteria)) {
      throw new Error('GUEST_RESULTS_UNVERIFIED');
    }
    const resultCoverage = coverage(metadata, grid.records.length);
    if (!rows.length && !(resultCoverage.serverMoreRecords === false && resultCoverage.total === 0)) {
      throw new Error('GUEST_EMPTY_UNVERIFIED');
    }
    const form = await readForm(page);
    const candidates = rows.map((row) => candidate(row, grid.records, keys));
    const searchId = randomUUID();
    const handle = await win.elementHandle();
    if (!handle) throw new Error('GUEST_PICKER_UNAVAILABLE');
    const result = {
      outcome: candidates.length ? 'matches' : 'no_match', searchId, observedAt: new Date().toISOString(),
      criteria: { field, label: spec[0], query, controls: criteria, requestFilters },
      coverage: resultCoverage, columns: grid.columns, metadata, candidates,
      correlation: {
        verifiedFields: keys,
        unverifiedResponseFields: [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !keys.includes(key)),
        unverifiedGridFields: [...new Set(grid.records.flatMap((row) => Object.keys(row)))].filter((key) => !keys.includes(key)),
      },
    };
    const state = { searchId, windowId, handle, criteria: JSON.stringify(criteria), grid: JSON.stringify(grid.records),
      formIdentity: JSON.stringify(formIdentity(form)), result: structuredClone(result) };
    state.invalidateOnRun = (request) => {
      try {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/web/base/GRIDDATA' &&
            currentSearches.get(page) === state) forget(page);
      } catch { forget(page); }
    };
    currentSearches.set(page, state);
    page.on('request', state.invalidateOnRun);
    return { ...result, candidates: candidates.slice(0, 25), returned: Math.min(25, candidates.length), hasMoreLoaded: candidates.length > 25 };
  } catch (error) {
    return { outcome: 'execution_failure', stage, issue: errorCode(error, 'GUEST_SEARCH_FAILED'), candidates: [] };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}

/** Recheck the live picker and return a bounded view of its current candidates. */
export async function inspectGuestProfileCandidates(page, { searchId, nativeId, offset = 0, limit = 25 } = {}) {
  if (!searchId || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { outcome: 'input_gap', issue: 'GUEST_INSPECTION_ARGUMENT_INVALID' };
  }
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'GUEST_LOOKUP_IN_PROGRESS' };
  busy.add(page);
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  let state;
  try {
    state = currentSearches.get(page);
    await requireCurrent(page, state, searchId, () => nativeDialog);
    const id = nativeId == null ? null : clean(nativeId);
    if (nativeId != null && !id) return { outcome: 'input_gap', issue: 'GUEST_ID_REQUIRED' };
    const candidates = id ? state.result.candidates.filter((item) => item.nativeId === id) : state.result.candidates;
    return structuredClone({ outcome: 'current', searchId, observedAt: state.result.observedAt,
      criteria: state.result.criteria, coverage: state.result.coverage,
      matched: candidates.length, offset, returned: Math.min(limit, Math.max(0, candidates.length - offset)),
      hasMoreLoaded: offset + limit < candidates.length, candidates: candidates.slice(offset, offset + limit) });
  } catch (error) {
    if (state?.searchId === searchId) forget(page);
    return { outcome: 'execution_failure', issue: errorCode(error, 'GUEST_INSPECTION_FAILED') };
  } finally {
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}

/** Cancel the Guests picker without changing the unsaved form. */
export async function closeGuestProfilePicker(page) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'GUEST_LOOKUP_IN_PROGRESS' };
  busy.add(page);
  let nativeDialog = false, blocked = false, attempted = false;
  const onDialog = () => { nativeDialog = true; };
  const guard = async (route) => {
    if (safeRead(route.request())) return route.fallback();
    blocked = true;
    return route.abort();
  };
  page.on('dialog', onDialog);
  try {
    await checkDialogs(page, () => nativeDialog);
    const before = await readForm(page);
    const win = guestWindow(page);
    if (await win.count() !== 1) throw new Error('GUEST_PICKER_UNAVAILABLE');
    await page.route('**/*', guard);
    attempted = true;
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ }).first().click();
    await win.waitFor({ state: 'hidden', timeout: 10000 });
    await checkDialogs(page, () => nativeDialog, false);
    const after = await readForm(page);
    if (blocked || JSON.stringify(before.fields) !== JSON.stringify(after.fields)) throw new Error('GUEST_FORM_CHANGED');
    forget(page);
    return { outcome: 'closed_unsaved', form: { fields: after.fields } };
  } catch (error) {
    if (attempted) forget(page);
    return { outcome: attempted ? 'close_uncertain' : 'execution_failure', issue: errorCode(error, 'GUEST_CLOSE_FAILED') };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}

/** True only for the observed, data-only change on a new HRCEN stay. */
export function isSafeGuestProfileChangeRequest({ method, url, postData }, nativeId) {
  try {
    const target = new URL(url);
    if (method !== 'POST' || target.origin !== ORIGIN || target.pathname !== CHANGE_PATH || !clean(nativeId)) return false;
    const body = new URLSearchParams(postData || '');
    const required = ['PKID', 'guestid', 'confirmationnumber', 'recordid', 'reservationid', 'propertycode',
      'ONLY_DATA_REQUIRED', 'newprofileclick', 'linkprofileflag', 'savecctoprofile', 'createinactiveprofileflag',
      'reqguestprofilelookup', 'pagemode', 'isafterreservationsave'];
    const keys = [...body.keys()];
    if (required.some((key) => keys.filter((actual) => actual.toLowerCase() === key.toLowerCase()).length !== 1 ||
        !body.has(key))) return false;
    return body.get('PKID') === '@[EMPTY]#@[EMPTY]#HRCEN#' && body.get('guestid') === clean(nativeId) &&
      body.get('propertycode') === PROPERTY && body.get('ONLY_DATA_REQUIRED') === 'true' && body.get('pagemode') === 'display' &&
      body.get('savecctoprofile') === '0' && body.get('createinactiveprofileflag') === '0' &&
      ['confirmationnumber', 'recordid', 'reservationid', 'newprofileclick', 'linkprofileflag',
        'reqguestprofilelookup', 'isafterreservationsave'].every((key) => !clean(body.get(key)));
  } catch { return false; }
}

function changedFields(before, after) {
  const key = (field, index) => field.id || `${field.name || ''}\u0000${index}`;
  const oldFields = new Map(before.map((field, index) => [key(field, index), field]));
  const newFields = new Map(after.map((field, index) => [key(field, index), field]));
  return [...new Set([...oldFields.keys(), ...newFields.keys()])].flatMap((id) => {
    const oldField = oldFields.get(id) ?? null;
    const newField = newFields.get(id) ?? null;
    return JSON.stringify(oldField) === JSON.stringify(newField) ? [] : [{ before: oldField, after: newField }];
  });
}

/** Select one unique ID from the current search; never save the stay or profile. */
export async function selectGuestProfile(page, { searchId, nativeId } = {}, { timeoutMs = 20000 } = {}) {
  const id = clean(nativeId);
  if (!searchId || !id) return { outcome: 'input_gap', issue: 'GUEST_SEARCH_ID_AND_NATIVE_ID_REQUIRED' };
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'GUEST_LOOKUP_IN_PROGRESS' };
  busy.add(page);
  let attempted = false, nativeDialog = false, blocked = false, allowedChanges = 0, observed = null;
  const onDialog = () => { nativeDialog = true; };
  const guard = async (route) => {
    const request = route.request();
    const method = request.method();
    if (safeRead(request)) return route.fallback();
    const safe = attempted && allowedChanges === 0 &&
      isSafeGuestProfileChangeRequest({ method, url: request.url(), postData: request.postData() }, id);
    if (safe) { allowedChanges += 1; return route.fallback(); }
    blocked = true;
    return route.abort();
  };
  page.on('dialog', onDialog);
  let state;
  try {
    state = currentSearches.get(page);
    const { win, form: before, grid } = await requireCurrent(page, state, searchId, () => nativeDialog);
    const candidates = state.result.candidates.filter((item) => item.nativeId === id);
    if (candidates.length !== 1 || (!candidates[0].firstName && !candidates[0].lastName) ||
        grid.records.filter((row) => clean(row.guestid) === id).length !== 1) throw new Error('GUEST_ID_NOT_UNIQUE');
    const rows = win.locator('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row');
    const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
      const grid = Ext.ComponentQuery.query('grid,readonlygrid').find((item) => item.getEl?.()?.dom?.contains(element));
      return String(grid?.getView?.()?.getRecord?.(element)?.data?.guestid ?? '').trim() === wanted ? [index] : [];
    }), id);
    if (indexes.length !== 1) throw new Error('GUEST_ID_NOT_UNIQUE');
    await page.route('**/*', guard);
    await rows.nth(indexes[0]).click();
    const selected = await page.evaluate(({ windowId, wanted }) => {
      const rows = Ext.getCmp(windowId)?.query('grid,readonlygrid')?.[0]?.getSelectionModel?.()?.getSelection?.() || [];
      return rows.length === 1 && String(rows[0].data?.guestid ?? '').trim() === wanted;
    }, { windowId: state.windowId, wanted: id });
    if (!selected || blocked) throw new Error('GUEST_ROW_SELECTION_UNVERIFIED');
    await requireCurrent(page, state, searchId, () => nativeDialog);
    const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).origin === ORIGIN && new URL(response.url()).pathname === CHANGE_PATH, { timeout: timeoutMs })
      .catch(() => null);
    attempted = true;
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ }).first().click();
    const response = await responsePromise;
    if (!response || response.status() !== 200 || allowedChanges !== 1 || blocked) throw new Error('GUEST_CHANGE_UNVERIFIED');
    const values = responseData(await responseText(response, timeoutMs)).values;
    if (!values || ['propertycode', 'guestid', 'confirmationnumber', 'recordid', 'reservationid', 'firstname', 'lastname']
      .some((key) => !Object.hasOwn(values, key)) || clean(values.propertycode) !== PROPERTY || clean(values.guestid) !== id ||
      ['confirmationnumber', 'recordid', 'reservationid'].some((key) => clean(values[key])) ||
      !sameText(values.firstname, candidates[0].firstName) || !sameText(values.lastname, candidates[0].lastName)) {
      throw new Error('GUEST_CHANGE_RESPONSE_MISMATCH');
    }
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await checkDialogs(page, () => nativeDialog);
      if (blocked) throw new Error('GUEST_CHANGE_REQUEST_BLOCKED');
      if (!await win.isVisible()) {
        const form = await readForm(page);
        observed = { form: { fields: form.fields, changedFields: changedFields(before.fields, form.fields) } };
        const snapshot = JSON.stringify(form.fields);
        if (snapshot !== last) stableSince = Date.now();
        else if (Date.now() - stableSince >= 500 && uniqueField(form, 'firstname') !== undefined &&
            uniqueField(form, 'lastname') !== undefined && uniqueField(form, 'guestid') === id &&
            sameText(uniqueField(form, 'firstname'), values.firstname) && sameText(uniqueField(form, 'lastname'), values.lastname)) {
          forget(page);
          return { outcome: 'selected_unsaved', searchId, nativeId: id, candidate: candidates[0],
            nativeReadback: Object.fromEntries(['propertycode', 'guestid', 'firstname', 'lastname', 'confirmationnumber', 'recordid', 'reservationid']
              .map((key) => [key, values[key]])), ...observed };
        }
        last = snapshot;
      }
      await page.waitForTimeout(200);
    }
    throw new Error('GUEST_FORM_READBACK_UNVERIFIED');
  } catch (error) {
    if ((attempted || error?.message === 'GUEST_SEARCH_STALE') && state?.searchId === searchId) forget(page);
    return { outcome: attempted ? 'selection_uncertain' : 'execution_failure',
      issue: errorCode(error, 'GUEST_SELECTION_FAILED'), ...(observed ? { observed } : {}) };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}
