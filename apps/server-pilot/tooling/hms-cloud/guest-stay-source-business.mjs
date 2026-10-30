// Source of Business on one guarded, unsaved HRCEN Guest Stay.
import { randomUUID } from 'node:crypto';
import { readUnsavedGuestStay } from './booking-lookup-session.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const TITLE = 'Global Codes - Source of Business';
const COMMON = {
  CURRENT_TAB_NAME: 'HDR', GRID_NAME: 'LVCODEVALUE', GRID_TYPE: 'LOV',
  LOV_TAGNAME: 'sourceofbusinessdesc', LOV_ALIAS_NAME_1: 'param.codetypevalue',
  LOV_ALIAS_VALUE_1: 'SOURCE', LOV_ALIAS_TYPE_1: 'text', LOV_ALIAS_NAME_2: 'param.lovtitlecode',
  LOV_ALIAS_VALUE_2: 'SOURCE', LOV_ALIAS_TYPE_2: 'text', USER_FUNCTION_NAME: 'OSRESV',
};
const scopes = new WeakMap();
const busy = new WeakSet();
const clean = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
const same = (a, b) => (clean(a) || '').toLocaleLowerCase() === (clean(b) || '').toLocaleLowerCase();
const issue = (error, fallback) => /^[A-Z][A-Z0-9_]{2,100}$/.test(String(error?.message || '')) ? error.message : fallback;
const rowKey = (row) => JSON.stringify(['id', 'codevalue', 'description'].map((key) => clean(row[key])));
const signature = (rows) => JSON.stringify(rows.map(rowKey).sort());
const timeout = (options) => Number.isInteger(options?.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 60000
  ? options.timeoutMs : 20000;

function exactParams(body, expected, numeric = []) {
  const keys = [...body.keys()];
  const wanted = [...Object.keys(expected), ...numeric];
  return keys.length === wanted.length && new Set(keys.map((key) => key.toLowerCase())).size === keys.length &&
    wanted.every((key) => body.getAll(key).length === 1) &&
    Object.entries(expected).every(([key, value]) => body.get(key) === value) &&
    numeric.every((key) => /^\d+$/.test(body.get(key) || ''));
}

function matchesRequest(request, kind, query = '') {
  try {
    const url = new URL(request.url());
    if (request.method() !== 'POST' || url.origin !== ORIGIN || url.search || url.hash) return false;
    const body = new URLSearchParams(request.postData() || '');
    if (kind === 'popup') {
      const filter = query ? { filterfields: 'description', filteroperator: 'CONTAINS', filtervalue: query } : {};
      return url.pathname === '/web/base/LOVPOP' && exactParams(body, {
        ...COMMON, REQUEST_TYPE: 'LOV.HEAD_DATA.STORED', popup: 'true', ...filter,
      });
    }
    if (kind !== 'run' || url.pathname !== '/web/base/GRIDDATA') return false;
    const filter = query ? {
      MADDON_FILTER_ALIAS_NAME_1: 'description', MADDON_FILTER_VALUE_1: query,
      MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_OPERATOR_1: 'CONTAINS',
      MADDON_FILTER_SEQNUM_1: '1', MADDON_LPAREN_1: 'false', MADDON_RPAREN_1: 'false',
    } : {};
    return exactParams(body, { ...COMMON, REQUEST_TYPE: 'LOV.DATA_ONLY.STORED', ...filter }, ['GRID_ID', 'DATASPY_ID']);
  } catch { return false; }
}

function invalidate(scope) {
  const previous = scope?.search;
  if (!previous) return;
  scope.search = null;
  void previous.windowHandle.dispose().catch(() => {});
  void previous.fieldHandle.dispose().catch(() => {});
}

async function guardPage(page) {
  if (scopes.has(page)) return scopes.get(page);
  const scope = { search: null, expected: null, nativeDialog: false, blockedWrites: 0, blockedOther: 0 };
  scope.guard = async (route) => {
    const request = route.request();
    const expected = scope.expected;
    if (expected && !expected.used && matchesRequest(request, expected.kind, expected.query)) {
      expected.used = true;
      return route.fallback(); // The context read-only guard still gets the request.
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) scope.blockedOther += 1;
    else { scope.blockedWrites += 1; invalidate(scope); }
    return route.abort();
  };
  scope.onDialog = () => { scope.nativeDialog = true; };
  scope.onRequest = (request) => {
    try {
      if (request.method() === 'POST' && ['/web/base/GRIDDATA', '/web/base/LOVPOP'].includes(new URL(request.url()).pathname)) {
        invalidate(scope);
      }
    } catch { invalidate(scope); }
  };
  scope.onClose = () => { invalidate(scope); scopes.delete(page); };
  page.on('dialog', scope.onDialog);
  page.on('request', scope.onRequest);
  page.on('close', scope.onClose);
  try { await page.route('**/*', scope.guard); }
  catch (error) {
    page.off('dialog', scope.onDialog);
    page.off('request', scope.onRequest);
    page.off('close', scope.onClose);
    throw error;
  }
  scopes.set(page, scope);
  return scope;
}

async function release(page, scope) {
  await page.unroute('**/*', scope.guard);
  invalidate(scope);
  scopes.delete(page);
  page.off('dialog', scope.onDialog);
  page.off('request', scope.onRequest);
  page.off('close', scope.onClose);
}

function picker(page) {
  return page.locator('.x-window:visible:not(.x-menu)').filter({ has:
    page.locator('.x-window-header-text:visible').filter({ hasText: /^Global Codes - Source of Business$/ }) });
}

async function checkDialogs(page, scope) {
  if (scope.nativeDialog) throw new Error('UNEXPECTED_DIALOG');
  const windows = page.locator('.x-window:visible:not(.x-menu)');
  for (let i = 0; i < await windows.count(); i += 1) {
    const titles = await windows.nth(i).locator('.x-window-header-text:visible').allTextContents();
    if (titles.length !== 1 || titles[0].trim() !== TITLE) throw new Error('UNEXPECTED_DIALOG');
  }
  if (await picker(page).count() > 1) throw new Error('SOURCE_PICKER_NOT_UNIQUE');
}

async function readForm(page, scope) {
  await checkDialogs(page, scope);
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('HMS_TARGET_MISMATCH');
  const valid = await bounded(page.evaluate((property) => {
    const visible = (el) => Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const fields = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
    const confirmation = fields('confirmationnumber');
    return /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1] === property && confirmation.length === 1 &&
      !confirmation[0].value.trim() && fields('ta1').length === 1 && fields('sourceofbusinessdesc').length === 1;
  }, PROPERTY), 15000, 'FORM_READ_TIMEOUT');
  if (!valid) throw new Error('NOT_A_BLANK_HRCEN_GUEST_STAY');
  const result = await readUnsavedGuestStay(page);
  if (result.outcome !== 'ok' || result.notes?.length) throw new Error('GUEST_FORM_UNAVAILABLE');
  await checkDialogs(page, scope);
  return result.form.fields;
}

async function readGrid(page, id) {
  return bounded(page.evaluate((windowId) => {
    const win = Ext.getCmp(windowId), grid = win?.query('grid,readonlygrid')?.[0], store = grid?.getStore?.();
    if (!win?.isVisible?.() || !store) throw new Error('SOURCE_GRID_UNAVAILABLE');
    return { records: store.getRange().map(({ data }) => ({ ...data })),
      columns: (grid.getColumnManager?.()?.getColumns?.() || []).map((column) => ({
        label: column.text ?? null, field: column.dataIndex ?? null, hidden: Boolean(column.hidden),
      })) };
  }, id), 15000, 'SOURCE_GRID_TIMEOUT');
}

async function controls(win) {
  return bounded(win.locator('input:visible,select:visible,textarea:visible').evaluateAll((elements) => elements.map((el) => ({
    name: el.name || null, value: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value,
  }))), 15000, 'SOURCE_CONTROLS_TIMEOUT');
}

function parseResponse(text) {
  const json = text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json), data = payload?.pageData;
  const content = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  if (!data || [payload, data].some((part) => part && ((Object.hasOwn(part, 'success') && part.success !== true) ||
      content(part.error) || content(part.errors))) || content(data.messages)) throw new Error('SOURCE_RESPONSE_INVALID');
  const result = data.grid?.GRIDRESULT?.GRID;
  if (!Array.isArray(result?.DATA) || !result.METADATA || result.METADATA.GRIDNAME !== 'LVCODEVALUE' ||
      result.METADATA.REQUEST_TYPE_META !== 'LOV.DATA_ONLY.STORED') throw new Error('SOURCE_RESPONSE_INVALID');
  return result;
}

function bounded(promise, timeoutMs, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function coverage(metadata, loaded) {
  const marker = String(metadata.MORERECORDPRESENT ?? '').trim();
  const serverMoreRecords = marker === '+' ? true : marker === '-' ? false : null;
  const reportedTotal = metadata.RECORDS ?? null;
  const count = /^\d+$/.test(String(reportedTotal)) ? Number(reportedTotal) : null;
  const pageSize = /^\d+$/.test(String(metadata.CLIENTROWS)) ? Number(metadata.CLIENTROWS) : null;
  const inconsistent = count != null && count < loaded;
  const total = count != null && count >= loaded && !(serverMoreRecords && count === loaded) ? count : null;
  const complete = !inconsistent && serverMoreRecords === false &&
    ((total != null && total === loaded) || (pageSize != null && loaded < pageSize));
  const truncated = serverMoreRecords || (total != null && total > loaded) ? true : complete ? false : null;
  return { loaded, total, reportedTotal, pageSize, serverMoreRecords, truncated, possiblyTruncated: truncated !== false };
}

async function requireCurrent(page, scope, searchId) {
  const state = scope.search;
  if (!state || !searchId || state.searchId !== searchId) throw new Error('SOURCE_SEARCH_STALE');
  await checkDialogs(page, scope);
  const win = picker(page);
  if (await win.count() !== 1 || await win.getAttribute('id') !== state.windowId ||
      !await bounded(win.evaluate((el, saved) => el === saved, state.windowHandle), 15000, 'SOURCE_PICKER_TIMEOUT').catch(() => false)) throw new Error('SOURCE_SEARCH_STALE');
  const field = page.locator('input[name="sourceofbusinessdesc"]:visible');
  if (await field.count() !== 1 || !await bounded(field.evaluate((el, saved) => el === saved, state.fieldHandle), 15000, 'SOURCE_FIELD_TIMEOUT').catch(() => false)) {
    throw new Error('SOURCE_SEARCH_STALE');
  }
  const form = await readForm(page, scope), grid = await readGrid(page, state.windowId);
  if (JSON.stringify(form) !== state.form || JSON.stringify(grid.records) !== state.grid ||
      JSON.stringify(await controls(win)) !== state.controls || scope.search !== state) throw new Error('SOURCE_SEARCH_STALE');
  return { state, win, form, grid };
}

/** List or refine current Source of Business descriptions on the blank stay. */
export async function searchGuestStaySourceBusiness(page, input = {}, options = {}) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'SOURCE_LOOKUP_IN_PROGRESS', candidates: [] };
  busy.add(page);
  let scope, stage = 'validating';
  try {
    scope = scopes.get(page);
    invalidate(scope);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        (input.query !== undefined && typeof input.query !== 'string')) throw new Error('SOURCE_QUERY_INVALID');
    if (Object.keys(input).some((key) => !['field', 'query'].includes(key)) ||
        (input.field !== undefined && input.field !== 'description')) {
      return { outcome: 'unsupported', issue: 'SOURCE_FILTER_UNSUPPORTED', candidates: [] };
    }
    const query = (input.query || '').trim();
    if (query.length > 200 || /[\r\n]/.test(query)) throw new Error('SOURCE_QUERY_INVALID');
    scope = await guardPage(page);
    const blocked = scope.blockedWrites;
    const initialForm = await readForm(page, scope);
    let win = picker(page);
    if (!await win.count()) {
      stage = 'opening_picker';
      const field = page.locator('input[name="sourceofbusinessdesc"]:visible');
      const trigger = field.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible');
      if (await trigger.count() !== 1) throw new Error('SOURCE_TRIGGER_NOT_UNIQUE');
      const currentDescription = String(initialForm.find((field) => field.name === 'sourceofbusinessdesc')?.value ?? '');
      scope.expected = { kind: 'popup', query: currentDescription, used: false };
      const response = page.waitForResponse((r) => matchesRequest(r.request(), 'popup', currentDescription), { timeout: timeout(options) }).catch(() => null);
      await trigger.click();
      const opened = await response;
      if (!opened || opened.status() !== 200 || !scope.expected.used || scope.blockedWrites !== blocked) throw new Error('SOURCE_PICKER_UNVERIFIED');
      await win.waitFor({ state: 'visible', timeout: timeout(options) });
    }
    scope.expected = null;
    await checkDialogs(page, scope);
    const windowId = await win.getAttribute('id');
    const filter = win.locator('input[name="filterfields"]:visible');
    const value = win.locator('input[name="selfiltervaluectrl"]:visible');
    const columnFilter = win.locator('input[name="ff_description"]:visible');
    const dataspy = win.locator('input[name="dataspylist"]:visible');
    if (!windowId || await filter.count() !== 1 || await value.count() !== 1 ||
        await dataspy.count() !== 1 || (await dataspy.inputValue()).trim() !== '(default)' ||
        (await filter.inputValue()).trim() !== 'Description' || (await columnFilter.count() && (await columnFilter.inputValue()).trim())) {
      throw new Error('SOURCE_FILTER_UNSUPPORTED');
    }
    stage = 'running_search';
    await value.fill(query);
    if ((await value.inputValue()).trim() !== query) throw new Error('SOURCE_FILTER_NOT_APPLIED');
    const criteria = await controls(win);
    scope.expected = { kind: 'run', query, used: false };
    const response = page.waitForResponse((r) => matchesRequest(r.request(), 'run', query), { timeout: timeout(options) }).catch(() => null);
    const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
    if (await run.count() !== 1) throw new Error('SOURCE_RUN_NOT_UNIQUE');
    await run.click();
    const received = await response;
    if (!received || received.status() !== 200 || !scope.expected.used || scope.blockedWrites !== blocked) throw new Error('SOURCE_RUN_UNVERIFIED');
    scope.expected = null;
    stage = 'reading_results';
    const { DATA: rows, METADATA: metadata } = parseResponse(await bounded(received.text(), timeout(options), 'SOURCE_RESPONSE_TIMEOUT'));
    const requestBody = new URLSearchParams(received.request().postData() || '');
    if (String(metadata.GRIDID ?? '') !== requestBody.get('GRID_ID') ||
        String(metadata.DATASPYID ?? '') !== requestBody.get('DATASPY_ID')) throw new Error('SOURCE_GRID_SCOPE_UNVERIFIED');
    if (rows.some((row) => !Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'codevalue') || !Object.hasOwn(row, 'description'))) {
      throw new Error('SOURCE_RESPONSE_INVALID');
    }
    const match = await page.waitForFunction(({ id, expected }) => {
      const records = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.()?.getRange?.().map(({ data }) => data);
      const key = (row) => JSON.stringify(['id', 'codevalue', 'description'].map((name) => row[name] == null || String(row[name]).trim() === '' ? null : String(row[name]).trim()));
      return records && JSON.stringify(records.map(key).sort()) === JSON.stringify(expected.map(key).sort());
    }, { id: windowId, expected: rows }, { timeout: timeout(options) });
    await match.dispose();
    await checkDialogs(page, scope);
    const grid = await readGrid(page, windowId), form = await readForm(page, scope);
    if (signature(grid.records) !== signature(rows) || JSON.stringify(await controls(win)) !== JSON.stringify(criteria) ||
        JSON.stringify(form) !== JSON.stringify(initialForm) || scope.blockedWrites !== blocked) {
      throw new Error('SOURCE_RESULTS_UNVERIFIED');
    }
    const resultCoverage = coverage(metadata, grid.records.length);
    if (!rows.length && !(resultCoverage.serverMoreRecords === false && resultCoverage.total === 0)) throw new Error('SOURCE_EMPTY_UNVERIFIED');
    const candidates = rows.map((row) => {
      const matching = grid.records.filter((record) => rowKey(record) === rowKey(row));
      return { nativeCode: clean(row.codevalue), description: clean(row.description), responseData: row,
        gridData: matching.length === 1 ? matching[0] : null };
    });
    const searchId = randomUUID();
    const windowHandle = await win.elementHandle();
    const fieldHandle = await page.locator('input[name="sourceofbusinessdesc"]:visible').elementHandle();
    if (!windowHandle || !fieldHandle) {
      await windowHandle?.dispose();
      await fieldHandle?.dispose();
      throw new Error('SOURCE_PICKER_UNAVAILABLE');
    }
    const result = { outcome: candidates.length ? 'matches' : 'no_match', searchId, observedAt: new Date().toISOString(),
      criteria: { propertyCode: PROPERTY, field: 'description', query, controls: criteria,
        gridId: requestBody.get('GRID_ID'), dataspyId: requestBody.get('DATASPY_ID') }, coverage: resultCoverage,
      columns: grid.columns, metadata, candidates };
    scope.search = { searchId, windowId, windowHandle, fieldHandle, form: JSON.stringify(form), grid: JSON.stringify(grid.records),
      controls: JSON.stringify(criteria), result: structuredClone(result) };
    return { ...result, candidates: candidates.slice(0, 25), returned: Math.min(25, candidates.length), hasMoreLoaded: candidates.length > 25 };
  } catch (error) {
    invalidate(scope);
    return { outcome: error?.message === 'SOURCE_FILTER_UNSUPPORTED' ? 'unsupported' :
      error?.message === 'SOURCE_QUERY_INVALID' ? 'input_gap' : 'execution_failure',
      issue: issue(error, 'SOURCE_SEARCH_FAILED'), stage, candidates: [] };
  } finally {
    if (scope) scope.expected = null;
    busy.delete(page);
  }
}

/** Inspect a bounded slice of the current, already loaded results. */
export async function inspectGuestStaySourceBusiness(page, { searchId, nativeCode, offset = 0, limit = 25 } = {}) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'SOURCE_LOOKUP_IN_PROGRESS' };
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { outcome: 'input_gap', issue: 'SOURCE_INSPECTION_RANGE_INVALID' };
  }
  busy.add(page);
  try {
    const scope = scopes.get(page), { state } = await requireCurrent(page, scope || {}, searchId);
    const all = nativeCode == null ? state.result.candidates : state.result.candidates.filter((row) => row.nativeCode === clean(nativeCode));
    return structuredClone({ outcome: 'ok', searchId, coverage: state.result.coverage, offset, returned: Math.min(limit, Math.max(0, all.length - offset)),
      hasMoreLoaded: offset + limit < all.length, candidates: all.slice(offset, offset + limit) });
  } catch (error) {
    const scope = scopes.get(page);
    if (error?.message === 'SOURCE_SEARCH_STALE' && scope?.search?.searchId === searchId) invalidate(scope);
    return { outcome: 'execution_failure', issue: issue(error, 'SOURCE_INSPECTION_FAILED') };
  } finally { busy.delete(page); }
}

function changedFields(before, after) {
  const key = (field, index) => field.id || `${field.name || ''}\u0000${index}`;
  const previous = new Map(before.map((field, index) => [key(field, index), field]));
  const current = new Map(after.map((field, index) => [key(field, index), field]));
  return [...new Set([...previous.keys(), ...current.keys()])].flatMap((id) =>
    JSON.stringify(previous.get(id)) === JSON.stringify(current.get(id)) ? [] :
      [{ before: previous.get(id) ?? null, after: current.get(id) ?? null }]);
}

/** Select one current code and verify the visible description; no stay is saved. */
export async function selectGuestStaySourceBusiness(page, { searchId, nativeCode } = {}, options = {}) {
  const code = clean(nativeCode);
  if (!searchId || !code) return { outcome: 'input_gap', issue: 'SOURCE_SEARCH_ID_AND_CODE_REQUIRED' };
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'SOURCE_LOOKUP_IN_PROGRESS' };
  busy.add(page);
  const scope = scopes.get(page);
  let attempted = false, observed = null;
  try {
    const { state, win, form: before, grid } = await requireCurrent(page, scope || {}, searchId);
    const matches = state.result.candidates.filter((item) => item.nativeCode === code);
    if (matches.length !== 1 || !matches[0].description || grid.records.filter((row) => clean(row.codevalue) === code).length !== 1) {
      throw new Error('SOURCE_CODE_NOT_UNIQUE');
    }
    if (state.result.coverage.truncated !== false) throw new Error('SOURCE_RESULTS_INCOMPLETE');
    if (state.result.candidates.filter((item) => same(item.description, matches[0].description)).length !== 1) {
      throw new Error('SOURCE_DESCRIPTION_AMBIGUOUS');
    }
    const rows = win.locator('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row');
    const indexes = await bounded(rows.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
      const grid = Ext.ComponentQuery.query('grid,readonlygrid').find((item) => item.getEl?.()?.dom?.contains(element));
      return String(grid?.getView?.()?.getRecord?.(element)?.data?.codevalue ?? '').trim() === wanted ? [index] : [];
    }), code), 15000, 'SOURCE_ROW_TIMEOUT');
    if (indexes.length !== 1) throw new Error('SOURCE_CODE_NOT_UNIQUE');
    const blocked = scope.blockedWrites, blockedOther = scope.blockedOther;
    attempted = true;
    await rows.nth(indexes[0]).click();
    const selected = () => bounded(page.evaluate(({ windowId, wanted }) => {
      const list = Ext.getCmp(windowId)?.query('grid,readonlygrid')?.[0]?.getSelectionModel?.()?.getSelection?.() || [];
      return list.length === 1 && String(list[0].data?.codevalue ?? '').trim() === wanted;
    }, { windowId: state.windowId, wanted: code }), 15000, 'SOURCE_SELECTION_TIMEOUT');
    if (!await selected() || scope.blockedWrites !== blocked || scope.blockedOther !== blockedOther) throw new Error('SOURCE_ROW_UNVERIFIED');
    await requireCurrent(page, scope, searchId);
    if (!await selected()) throw new Error('SOURCE_ROW_UNVERIFIED');
    const ok = win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
    if (await ok.count() !== 1) throw new Error('SOURCE_OK_NOT_UNIQUE');
    await ok.click();
    const deadline = Date.now() + timeout(options);
    let snapshot = null, stableSince = Date.now();
    while (Date.now() < deadline) {
      await checkDialogs(page, scope);
      if (scope.blockedWrites !== blocked || scope.blockedOther !== blockedOther) throw new Error('SOURCE_CHANGE_REQUEST_BLOCKED');
      if (!await win.isVisible()) {
        const form = await readForm(page, scope), fields = form.filter((field) => field.name === 'sourceofbusinessdesc');
        if (fields.length !== 1) throw new Error('SOURCE_READBACK_UNAVAILABLE');
        observed = { selectedField: fields[0], changedFields: changedFields(before, form) };
        const current = JSON.stringify(form);
        if (snapshot !== current) stableSince = Date.now();
        else if (Date.now() - stableSince >= 500 && same(fields[0].value, matches[0].description)) {
          await release(page, scope);
          return { outcome: 'selected_unsaved', searchId, nativeCode: code, candidate: matches[0], ...observed,
            nativeCodeReadback: { outcome: 'unsupported', issue: 'SOURCE_CODE_NOT_EXPOSED_ON_FORM' },
            identityEvidence: 'unique_current_picker_row_and_description_readback' };
        }
        snapshot = current;
      }
      await page.waitForTimeout(200);
    }
    throw new Error('SOURCE_READBACK_UNVERIFIED');
  } catch (error) {
    if (attempted || (error?.message === 'SOURCE_SEARCH_STALE' && scope?.search?.searchId === searchId)) invalidate(scope);
    return { outcome: attempted ? 'selection_uncertain' : 'execution_failure', issue: issue(error, 'SOURCE_SELECTION_FAILED'),
      ...(observed ? { observed } : {}) };
  } finally { busy.delete(page); }
}

/** Cancel our picker and verify the visible draft remained unchanged. */
export async function closeGuestStaySourceBusinessPicker(page) {
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'SOURCE_LOOKUP_IN_PROGRESS' };
  const scope = scopes.get(page);
  if (!scope) return { outcome: 'not_open' };
  busy.add(page);
  let attempted = false;
  try {
    const before = await readForm(page, scope), win = picker(page), blocked = scope.blockedWrites;
    if (await win.count()) {
      const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
      if (await cancel.count() !== 1) throw new Error('SOURCE_CANCEL_NOT_UNIQUE');
      attempted = true;
      await cancel.click();
      await win.waitFor({ state: 'hidden', timeout: 10000 });
    }
    const after = await readForm(page, scope);
    if (JSON.stringify(before) !== JSON.stringify(after) || scope.blockedWrites !== blocked) throw new Error('SOURCE_CANCEL_UNVERIFIED');
    await release(page, scope);
    return { outcome: 'closed_unchanged' };
  } catch (error) {
    invalidate(scope);
    return { outcome: attempted ? 'close_uncertain' : 'execution_failure', issue: issue(error, 'SOURCE_CLOSE_FAILED') };
  } finally { busy.delete(page); }
}
