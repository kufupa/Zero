import { randomUUID } from 'node:crypto';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';
import { parseAssociationResponse } from './cancel-association-scope.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from './stay360-notes.mjs';

const TARGET = { propertyCode: 'HRCEN', origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' };
const PATH = '/web/base/OSENEX';
const states = new WeakMap(), contextApprovals = new WeakMap();
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const FIELDS = {
  code: 'itemorbundlecode', quantity: 'quantity', startDate: 'startdate', endDate: 'enddate',
  unitPrice: 'unitprice', frequency: 'frequency', pricingControl: 'pricingcontrol', folio: 'folio', comment: 'comment',
};
const COMBOS = new Set(['frequency', 'pricingControl', 'folio']);
const clean = value => String(value ?? '').trim();
const fail = (issue, outcome = 'refused', extra = {}) => { throw Object.assign(new Error(issue), { outcome, extra }); };
const problem = error => ({ outcome: error.outcome || 'execution_failure',
  issue: /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message || '') ? error.message : 'ADDONS_ACTION_FAILED', ...error.extra });
const decimal = value => {
  const text = clean(value).replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
};
function day(value) {
  const text = clean(value);
  let match = /(\d{4})-(\d{2})-(\d{2})$/.exec(text), iso = match && `${match[1]}-${match[2]}-${match[3]}`;
  if (!iso && (match = /(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(text))) {
    iso = `${match[3]}-${String(MONTHS.indexOf(match[2].toUpperCase()) + 1).padStart(2, '0')}-${match[1]}`;
  }
  if (!iso && (match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text))) iso = `${match[3]}-${match[1]}-${match[2]}`;
  const parsed = iso && new Date(`${iso}T00:00:00Z`);
  return parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}
const displayDate = iso => { const [year, month, date] = iso.split('-'); return `${date}-${MONTHS[Number(month) - 1]}-${year}`; };
const wireDate = iso => { const [year, month, date] = iso.split('-'); return `${month}/${date}/${year}`; };
const requestedValue = (key, value) => ['quantity', 'unitPrice'].includes(key) ? decimal(value) :
  ['startDate', 'endDate'].includes(key) ? day(value) : String(value);
async function withDeadline(task, milliseconds, issue) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(issue)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const popup = page => page.locator('[data-testid="popup-OSENEX"]:visible');
const picker = page => page.locator('[data-testid="popup-LOVPOP"]:visible');
const scalar = value => value && typeof value === 'object' && value.dd ? value.selected : value;
const nativeGrid = data => data?.grid?.GRIDRESULT?.GRID || data?.GRIDRESULT?.GRID || null;
function coverage(state, rows) {
  const grid = state.grid, metadata = grid?.METADATA;
  const total = metadata && Number(metadata.RECORDS);
  const ids = data => data.map(row => clean(row.enhexpsequencekey));
  const correlated = Array.isArray(grid?.DATA) && JSON.stringify(ids(grid.DATA)) === JSON.stringify(ids(rows));
  return { loaded: rows.length, reportedTotal: Number.isFinite(total) ? total : null,
    complete: correlated && metadata.MORERECORDPRESENT === '-' && total === rows.length ? true : null };
}
function nativeResponse(text) {
  try { return parseSavedStayNativeResponse(text); } catch {
    // Full native popup descriptions use JavaScript string escapes as well as
    // JSON escapes. Reuse the existing non-executing full-response parser.
    const payload = parseAssociationResponse(text), data = payload?.pageData;
    const content = value => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
    if (!data || [payload, data].some(part => (Object.hasOwn(part, 'success') && part.success !== true) || content(part.error) || content(part.errors)) || content(data.messages)) {
      fail('ADDONS_NATIVE_RESPONSE_INVALID');
    }
    return data;
  }
}

async function target(page, confirmation) {
  if (!/^\d+-\d+$/.test(confirmation || '')) fail('INVALID_CONFIRMATION', 'needs_input');
  if (new URL(page.url()).origin !== TARGET.origin) fail('HMS_ORIGIN_MISMATCH');
  const result = await page.evaluate(wanted => {
    const shown = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const headers = [...document.querySelectorAll('h1.recordcode')].filter(shown);
    const properties = [...document.querySelectorAll('[data-qtip="Property"]')].filter(shown);
    const value = name => {
      const fields = [...document.querySelectorAll(`.gs-panel [name="${name}"]`)].filter(shown);
      return fields.length === 1 ? String(fields[0].value ?? fields[0].innerText ?? '').trim() : null;
    };
    if (headers.length !== 1 || headers[0].innerText.trim() !== wanted || properties.length !== 1 ||
        properties[0].innerText.trim() !== 'HRCEN') return null;
    return { confirmation: wanted, propertyCode: 'HRCEN', guestName: value('guestfullname'),
      arrival: value('arrivaldate'), departure: value('departuredate'), status: value('status') };
  }, confirmation);
  if (!result) fail('CONFIRMATION_OR_PROPERTY_MISMATCH');
  return { ...result, arrival: day(result.arrival), departure: day(result.departure) };
}

async function settled(page) {
  await page.waitForFunction(() => {
    const shown = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const roots = [...document.querySelectorAll('[data-testid="popup-OSENEX"],[data-testid="popup-LOVPOP"]')].filter(shown);
    return typeof globalThis.Ext?.Ajax?.isLoading === 'function' && !Ext.Ajax.isLoading() &&
      roots.every(root => ![...root.querySelectorAll('.x-mask,.x-mask-msg,.x-loadmask')].some(shown));
  }, null, { timeout: 20000 });
}

function aliases(body) {
  const result = new Map();
  for (const [key, value] of body) {
    const match = /^LOV_ALIAS_NAME_(\d+)$/.exec(key);
    if (!match) continue;
    if (result.has(value)) return null;
    result.set(value, body.get(`LOV_ALIAS_VALUE_${match[1]}`));
  }
  return result;
}
const exact = (body, key, value) => body.getAll(key).length === 1 && body.get(key) === value;
const noConfirmation = body => ![...body].some(([key, value]) => /^confirm/i.test(key) && clean(value));

function matches(request, state, pending) {
  const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
  if (request.method() !== 'POST' || url.origin !== TARGET.origin || url.hash || !pending) return false;
  if (url.search) {
    // Native Submit carries SAVE in both the URL and the form. Check the
    // action and conflicting business values rather than pinning a URL shape.
    if (pending.kind !== 'save' || !exact(url.searchParams, 'pageaction', 'SAVE') ||
        [...url.searchParams].some(([key, value]) => key.toLowerCase() === 'action' ||
          (key.toLowerCase() === 'pageaction' && key !== 'pageaction') ||
          (body.has(key) && !exact(body, key, value)))) return false;
  }
  if (pending.kind === 'lookup' || pending.kind === 'more') {
    if (!['/web/base/LOVPOP', '/web/base/GRIDDATA'].includes(url.pathname) ||
        body.get('GRID_NAME') !== 'LVENHANCEDEXPERIENCE' || body.get('LOV_TAGNAME') !== 'itemorbundlecode') return false;
    const a = aliases(body);
    return a?.get('param.propertycode') === 'HRCEN' && a.get('param.itemtype') === 'ITEM' &&
      a.get('param.reservationstayid') === state.native.stayId && a.get('param.account') === state.native.account &&
      !body.has('pageaction') && !body.has('action');
  }
  if (!exact(body, 'propertycode', 'HRCEN') || !exact(body, 'SYSTEM_FUNCTION_NAME', 'OSENEX') ||
      !exact(body, 'USER_FUNCTION_NAME', 'OSENEX') || !noConfirmation(body)) return false;
  if (pending.kind === 'open') {
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') &&
      /^\d+$/.test(body.get('reservationstayid') || '') && /^\d+$/.test(body.get('account') || '');
  }
  if (!exact(body, 'reservationstayid', state.native.stayId) || !exact(body, 'account', state.native.account)) return false;
  if (pending.kind === 'inspect') {
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') &&
      exact(body, 'ONLY_DATA_REQUIRED', 'true') && exact(body, 'enhexpsequencekey', pending.nativeId);
  }
  if (pending.kind === 'reset') {
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') &&
      exact(body, 'ONLY_DATA_REQUIRED', 'true') && !clean(body.get('enhexpsequencekey'));
  }
  if (!exact(body, 'itemtype', 'ITEM') || !exact(body, 'itemorbundlecode', pending.code) ||
      !exact(body, 'itemid', pending.itemId) || ['recordid', 'enhexpsequencekey'].some(key =>
        body.getAll(key).length > 1 || clean(body.get(key)))) return false;
  if (pending.kind === 'calculate') {
    return url.pathname === `${PATH}.getenhancedexperiencecalculations` && !body.has('pageaction') && !body.has('action');
  }
  if (pending.kind !== 'save' || url.pathname !== PATH || !exact(body, 'pageaction', 'SAVE') || body.has('action')) return false;
  // A primary key for an existing item must never turn an approved insert into
  // an update, even if the visible fields still look like a new record.
  if (body.getAll('PKID').length > 1 || (clean(body.get('PKID')) &&
      !exact(body, 'PKID', '@[EMPTY]#HRCEN#ITEM'))) return false;
  const item = pending.item;
  return ['quantity', 'unitprice', 'totalcost'].every((key, i) => body.getAll(key).length === 1 && decimal(body.get(key)) ===
    [item.quantity, item.unitPrice, item.totalCost][i]) &&
    exact(body, 'startdate', wireDate(item.startDate)) && exact(body, 'enddate', wireDate(item.endDate)) &&
    exact(body, 'frequency', item.frequency) && exact(body, 'pricingcontrol', item.pricingControl) &&
    exact(body, 'folio', item.folio) && exact(body, 'comment', item.comment) &&
    exact(body, 'unitpricecurr', item.currency);
}

function stateFor(page) {
  let initialization = states.get(page);
  if (!initialization) {
    initialization = initializeState(page);
    states.set(page, initialization);
  }
  return initialization;
}

async function initializeState(page) {
  let approvals = contextApprovals.get(page.context());
  if (!approvals) { approvals = new WeakSet(); contextApprovals.set(page.context(), approvals); }
  await installReadOnlyGuard(page.context(), { approvedAddOnSaveRequests: approvals });
  const state = { busy: false, quarantined: false, pending: null, native: null, values: null,
    target: null, prepared: new Map(), approvals, dispatched: false, nativeDialog: null, callbacks: new Set(), attempts: [], grid: null };
  page.on('dialog', dialog => { state.nativeDialog = { type: dialog.type(), message: dialog.message() };
    state.quarantined = true; state.prepared.clear(); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const addon = url.origin === TARGET.origin && url.pathname.toLowerCase().startsWith('/web/base/osenex');
    const lookup = url.origin === TARGET.origin && ['/web/base/LOVPOP', '/web/base/GRIDDATA'].includes(url.pathname) &&
      (body.get('LOV_TAGNAME') === 'itemorbundlecode' || body.get('GRID_NAME') === 'LVENHANCEDEXPERIENCE');
    if (!addon && !lookup) return route.fallback();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
    const pending = state.pending;
    if (state.quarantined || pending?.request || !matches(request, state, pending)) {
      return route.abort();
    }
    pending.request = request;
    if (pending.kind === 'open') state.native = { stayId: body.get('reservationstayid'), account: body.get('account') };
    if (pending.kind === 'save') {
      try {
        if (pending.beforeDispatch) {
          const callback = Promise.resolve().then(() => pending.beforeDispatch(structuredClone(pending.dispatch)));
          state.callbacks.add(callback);
          let approved;
          try { approved = await callback; } finally { state.callbacks.delete(callback); }
          if (approved !== true) { pending.rejected = true; return route.abort(); }
        }
        if (state.quarantined) return route.abort();
        state.dispatched = true;
        state.attempts.push({ index: pending.dispatch.index, item: structuredClone(pending.dispatch.item),
          itemId: pending.itemId, nativeId: null });
        state.approvals.add(request);
      } catch { pending.rejected = true; return route.abort(); }
    }
    return route.fallback();
  });
  return state;
}

async function step(page, state, spec, action) {
  if (state.quarantined || state.pending) fail('ADDONS_FRESH_SESSION_REQUIRED');
  const pending = { ...spec, request: null };
  state.pending = pending;
  const received = page.waitForResponse(response => response.request() === pending.request, { timeout: 25000 }).catch(() => null);
  try {
    await action();
    const response = await received;
    if (!response || response.status() !== 200 || pending.rejected) fail(pending.rejected ? 'ADDONS_DISPATCH_REFUSED' : 'ADDONS_RESPONSE_UNVERIFIED');
    const data = nativeResponse(await withDeadline(response.text(), 25000, 'ADDONS_RESPONSE_BODY_TIMEOUT'));
    const grid = nativeGrid(data);
    if (grid?.METADATA?.GRIDNAME === 'OSENEX') state.grid = structuredClone(grid);
    if (data.values) {
      const v = data.values;
      if (clean(v.propertycode) !== 'HRCEN' || clean(v.reservationstayid) !== state.native.stayId ||
          clean(v.account) !== state.native.account) fail('ADDONS_NATIVE_TARGET_MISMATCH');
      state.values = v;
    }
    await settled(page);
    if (state.nativeDialog) fail('ADDONS_DIALOG_REQUIRES_REVIEW', 'uncertain', { nativeDialog: state.nativeDialog });
    return data;
  } catch (error) {
    state.quarantined = true; state.prepared.clear();
    error.extra = { ...error.extra, stage: spec.kind };
    throw error;
  } finally { state.pending = null; }
}

async function button(page, name) {
  const found = popup(page).locator(`[data-testid="${name}"]`).locator('xpath=ancestor::a[1]');
  if (await found.count() !== 1 || !await found.isEnabled()) fail('ADDONS_CONTROL_UNAVAILABLE', 'unsupported', { field: name });
  await found.click({ timeout: 10000 });
}

async function ensureOpen(page, state, confirmation) {
  const current = await target(page, confirmation);
  if (state.target && JSON.stringify(state.target) !== JSON.stringify(current)) fail('ADDONS_TARGET_CHANGED');
  if (await popup(page).count()) {
    if (!state.native || !state.target) fail('ADDONS_UNOWNED_POPUP');
    return;
  }
  await dismissNotesOrThrow(page);
  state.target = current;
  const card = page.locator('.gs-panel:visible').filter({ has: page.locator('.x-panel-header-text').filter({ hasText: /^Add-Ons$/ }) });
  const open = card.locator('a.gs-header-btn:visible').filter({ has: page.locator('[data-testid="btn_ADDONS"]') });
  if (await open.count() !== 1) fail('ADDONS_BUTTON_NOT_UNIQUE');
  await step(page, state, { kind: 'open' }, () => open.click());
  await popup(page).waitFor({ state: 'visible', timeout: 20000 });
}

async function loadedRows(page, testId, locator) {
  return locator.evaluate((element, wanted) => {
    const grids = (globalThis.Ext?.ComponentQuery?.query('grid') || []).filter(grid =>
      grid.el?.dom && element.contains(grid.el.dom) && grid.el.dom.querySelector(`[data-testid="${wanted}"]`));
    if (grids.length !== 1 || grids[0].getStore().isLoading()) throw new Error('ADDONS_GRID_UNVERIFIED');
    const grid = grids[0], store = grid.getStore();
    const value = v => v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` :
      v == null || ['string', 'number', 'boolean'].includes(typeof v) ? v : null;
    return { rows: store.getRange().map(record => Object.fromEntries(Object.entries(record.data).map(([k, v]) => [k, value(v)]))),
      columns: grid.columns.map(column => ({ label: column.text || '', field: column.dataIndex || null })),
      reportedTotal: Number.isFinite(store.getTotalCount()) ? store.getTotalCount() : null, text: element.innerText };
  }, testId);
}

async function catalogue(page, state) {
  if (await picker(page).count()) fail('ADDONS_PICKER_ALREADY_OPEN');
  const input = popup(page).locator('input[name="itemorbundlecode"]:visible');
  const trigger = input.locator('xpath=ancestor::table[contains(@class,"x-form-trigger-wrap")][1]').locator('.x-form-lov-trigger:visible');
  if (await trigger.count() !== 1) fail('ADDONS_ITEM_LOOKUP_UNAVAILABLE');
  const data = await step(page, state, { kind: 'lookup' }, () => trigger.click());
  await picker(page).waitFor({ state: 'visible', timeout: 20000 });
  const loaded = await loadedRows(page, 'lovgrid', picker(page)), grid = nativeGrid(data);
  if (!grid || !Array.isArray(grid.DATA)) fail('ADDONS_CATALOGUE_RESPONSE_UNVERIFIED');
  const candidates = loaded.rows.map(row => ({ code: clean(row.code), name: clean(row.description), itemId: clean(row.itemid), native: row }));
  if (candidates.some(item => !item.code || !/^\d+$/.test(item.itemId) ||
      grid.DATA.filter(row => clean(row.code) === item.code && clean(row.itemid) === item.itemId).length !== 1)) {
    fail('ADDONS_CATALOGUE_GRID_MISMATCH');
  }
  const footer = /Records:\s*(\d+)\s+of\s+(\d+)/i.exec(loaded.text);
  const total = footer ? Number(footer[2]) : Number(grid.METADATA?.RECORDS);
  const more = grid.MORERECORDS ?? grid.METADATA?.MORERECORDS;
  return { outcome: 'ok', propertyCode: 'HRCEN', candidates, columns: loaded.columns,
    coverage: { loaded: candidates.length, reportedTotal: Number.isFinite(total) ? total : loaded.reportedTotal,
      complete: (grid.METADATA?.MORERECORDPRESENT === '-' && total === candidates.length) ||
        (footer && Number(footer[1]) === candidates.length && total === candidates.length) ? true :
        (['false', false, '0', 0].includes(more) && total === candidates.length ? true : null) } };
}

async function closePicker(page) {
  const cancel = picker(page).locator('[data-testid="cancel"]').locator('xpath=ancestor::a[1]');
  if (await cancel.count() !== 1) fail('ADDONS_PICKER_CLOSE_UNAVAILABLE');
  await cancel.click();
  await picker(page).waitFor({ state: 'hidden', timeout: 10000 });
}

async function form(page, state) {
  const native = await popup(page).evaluate((element, names) => {
    const fields = {};
    for (const [key, name] of Object.entries(names)) {
      const controls = [...element.querySelectorAll('input,textarea,select')].filter(el => el.name === name);
      if (controls.length !== 1) throw new Error('ADDONS_FORM_FIELD_UNVERIFIED');
      const el = controls[0], cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
      let value = cmp?.getValue?.() ?? el.value;
      if (value instanceof Date) value = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
      fields[key] = { value, display: el.value, editable: !el.disabled && !el.readOnly && !cmp?.readOnly && !cmp?.disabled,
        required: cmp?.allowBlank === false };
    }
    return fields;
  }, FIELDS);
  const values = {};
  for (const [key, field] of Object.entries(native)) {
    const v = scalar(field.value);
    values[key] = ['quantity', 'unitPrice'].includes(key) ? decimal(v) : ['startDate', 'endDate'].includes(key) ? day(v) : String(v ?? '');
    const options = state.values?.[FIELDS[key]]?.option;
    if (options) field.options = options.map(({ value, display }) => ({ code: String(value), name: display }));
  }
  return { ...values, name: clean(state.values?.itemdesc), itemId: clean(state.values?.itemid),
    currency: clean(state.values?.unitpricecurr), averageDaily: decimal(state.values?.averagedailycost),
    totalCost: decimal(state.values?.totalcost), status: clean(scalar(state.values?.status)), controls: native };
}

async function selectItem(page, state, code) {
  const found = await catalogue(page, state), matches = found.candidates.filter(item => item.code === code);
  if (matches.length !== 1) {
    await closePicker(page);
    fail(matches.length ? 'ADDONS_ITEM_AMBIGUOUS' : 'ADDONS_ITEM_NOT_LOADED', 'needs_input', { options: found.candidates, coverage: found.coverage });
  }
  const item = matches[0];
  const row = picker(page).locator('.x-grid-row').filter({ has: page.getByText(code, { exact: true }) });
  const ok = picker(page).locator('[data-testid="ok"]').last().locator('xpath=ancestor::a[1]');
  if (await row.count() !== 1 || await ok.count() !== 1) fail('ADDONS_ITEM_NOT_IN_RENDERED_ROWS');
  await step(page, state, { kind: 'calculate', code, itemId: item.itemId }, async () => { await row.click(); await ok.click(); });
  await picker(page).waitFor({ state: 'hidden', timeout: 20000 });
  if (clean(state.values?.itemorbundlecode) !== code || clean(state.values?.itemid) !== item.itemId) fail('ADDONS_ITEM_SELECTION_UNVERIFIED');
  return item;
}

async function setField(page, state, item, key, requested) {
  let current = await form(page, state);
  const expected = requestedValue(key, requested);
  if (current[key] === expected) return;
  if (!current.controls[key].editable) fail('ADDONS_FIELD_NOT_EDITABLE', 'unsupported', { field: key });
  const input = popup(page).locator(`[name="${FIELDS[key]}"]:visible`);
  const edit = async () => {
    if (COMBOS.has(key)) {
      const options = current.controls[key].options || [], chosen = options.filter(option => option.code === expected);
      if (chosen.length !== 1) fail('ADDONS_OPTION_REQUIRED', 'needs_input', { field: key, options });
      const trigger = input.locator('xpath=ancestor::table[contains(@class,"x-form-trigger-wrap")][1]').locator('.x-form-arrow-trigger:visible');
      if (await trigger.count() !== 1) fail('ADDONS_DROPDOWN_UNAVAILABLE');
      await trigger.click();
      const option = page.locator('.x-boundlist:visible .x-boundlist-item').filter({ hasText: chosen[0].name });
      const exactOptions = await option.all();
      const matching = [];
      for (const candidate of exactOptions) if ((await candidate.innerText()).trim() === chosen[0].name) matching.push(candidate);
      if (matching.length !== 1) fail('ADDONS_DROPDOWN_OPTION_AMBIGUOUS');
      await matching[0].click();
    } else {
      await input.fill(['startDate', 'endDate'].includes(key) ? displayDate(expected) : String(requested));
      await input.press('Tab');
    }
  };
  if (key === 'comment' || key === 'folio') {
    // These controls do not change price in the observed native form.
    await edit(); await settled(page);
  } else await step(page, state, { kind: 'calculate', code: item.code, itemId: item.itemId }, edit);
  current = await form(page, state);
  if (current[key] !== expected) fail('ADDONS_FIELD_READBACK_MISMATCH', 'uncertain', { field: key });
}

function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('ADDONS_ITEMS_REQUIRED', 'needs_input');
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('ADDONS_ITEM_INVALID', 'needs_input');
    const unsupported = Object.keys(item).filter(key => !Object.hasOwn(FIELDS, key));
    if (unsupported.length) fail('ADDONS_FIELDS_UNSUPPORTED', 'unsupported', { fields: unsupported });
    if (typeof item.code !== 'string' || !item.code || item.code !== item.code.trim()) fail('ADDONS_CODE_REQUIRED', 'needs_input');
    for (const key of Object.keys(item).filter(key => key !== 'code')) {
      if (item[key] == null || !['string', 'number'].includes(typeof item[key])) fail('ADDONS_FIELD_INVALID', 'needs_input', { field: key });
      if (['startDate', 'endDate'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(item[key]) || !day(item[key]))) fail('ADDONS_DATE_INVALID', 'needs_input', { field: key });
      if (['quantity', 'unitPrice'].includes(key) && (!decimal(item[key]) || (key === 'quantity' && Number(decimal(item[key])) <= 0))) fail('ADDONS_NUMBER_INVALID', 'needs_input', { field: key });
      if (typeof item[key] === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item[key])) fail('ADDONS_FIELD_INVALID', 'needs_input', { field: key });
    }
  }
}

async function stageOne(page, state, requested) {
  if (await picker(page).count()) fail('ADDONS_PICKER_ALREADY_OPEN');
  await step(page, state, { kind: 'reset' }, () => button(page, 'addrecord'));
  const item = await selectItem(page, state, requested.code);
  for (const key of ['quantity', 'startDate', 'endDate', 'frequency', 'pricingControl', 'unitPrice', 'folio', 'comment']) {
    if (Object.hasOwn(requested, key)) await setField(page, state, item, key, requested[key]);
  }
  const actual = await form(page, state);
  const changed = Object.keys(requested).filter(key => actual[key] !== requestedValue(key, requested[key]));
  if (changed.length) fail('ADDONS_REQUESTED_FIELDS_CHANGED', 'needs_input', { fields: changed, preview: actual });
  if (actual.code !== item.code || actual.itemId !== item.itemId || !actual.startDate || !actual.endDate || !actual.quantity ||
      !actual.unitPrice || !actual.totalCost || !actual.currency) fail('ADDONS_PREVIEW_UNVERIFIED');
  if (actual.status !== 'VALID') fail('ADDONS_NATIVE_VALIDATION_REQUIRED', 'needs_input', { nativeStatus: actual.status, preview: actual });
  if (!Object.hasOwn(requested, 'unitPrice') && Number(actual.unitPrice) === 0) {
    fail('ADDONS_PRICE_REQUIRED', 'needs_input', { preview: actual });
  }
  return actual;
}

async function run(page, operation) {
  let state, acquired = false;
  try {
    state = await stateFor(page);
    if (state.busy) fail('ADDONS_ACTION_IN_PROGRESS');
    if (state.quarantined) fail('ADDONS_FRESH_SESSION_REQUIRED');
    state.busy = true;
    acquired = true;
    return await operation(state);
  } catch (error) { return problem(error); }
  finally { if (acquired) state.busy = false; }
}

export async function readStay360AddOns(page, confirmation, { detailIds = [] } = {}) {
  return run(page, async state => {
    if (!Array.isArray(detailIds) || detailIds.some(id => typeof id !== 'string' || !id || /[\p{Cc}]/u.test(id))) fail('ADDONS_DETAIL_IDS_INVALID', 'needs_input');
    await ensureOpen(page, state, confirmation);
    const loaded = await loadedRows(page, 'listdetailgrid', popup(page));
    const details = [];
    for (const nativeId of detailIds) {
      const recordId = await popup(page).evaluate((element, wanted) => {
        const grid = Ext.ComponentQuery.query('grid').find(g => g.el?.dom && element.contains(g.el.dom) && g.el.dom.querySelector('[data-testid="listdetailgrid"]'));
        const records = grid?.getStore().getRange().filter(record => String(record.data.enhexpsequencekey ?? record.data.recordid ?? record.data.id ?? '') === wanted);
        return records?.length === 1 ? records[0].internalId : null;
      }, nativeId);
      if (!recordId) fail('ADDONS_DETAIL_NOT_LOADED', 'needs_input', { nativeId });
      const row = popup(page).locator('.x-grid-row').filter({ has: page.locator(`[data-recordid="${recordId}"]`) });
      const direct = popup(page).locator(`.x-grid-row[data-recordid="${recordId}"]`);
      const selected = await direct.count() === 1 ? direct : row;
      if (await selected.count() !== 1) fail('ADDONS_DETAIL_ROW_NOT_VISIBLE');
      await step(page, state, { kind: 'inspect', nativeId }, () => selected.click());
      if (clean(state.values?.enhexpsequencekey) !== nativeId) fail('ADDONS_DETAIL_ID_MISMATCH');
      details.push({ nativeId, fields: await form(page, state) });
    }
    return { outcome: 'ok', confirmation, propertyCode: 'HRCEN', target: structuredClone(state.target),
      rows: loaded.rows, columns: loaded.columns, details,
      coverage: coverage(state, loaded.rows),
      notes: await takeHandledNotes(page) };
  });
}

export async function listStay360AddOnItems(page, confirmation) {
  return run(page, async state => {
    await ensureOpen(page, state, confirmation);
    const found = await catalogue(page, state);
    await closePicker(page);
    return { confirmation, ...found };
  });
}

export async function prepareStay360AddOns(page, confirmation, items) {
  // Freeze the caller's requested business values before asynchronous UI work.
  try { items = structuredClone(items); } catch { return { outcome: 'needs_input', issue: 'ADDONS_ITEM_INVALID' }; }
  return run(page, async state => {
    validateItems(items);
    await ensureOpen(page, state, confirmation);
    state.prepared.clear();
    const baseline = await loadedRows(page, 'listdetailgrid', popup(page)), previews = [];
    for (const requested of items) previews.push(await stageOne(page, state, requested));
    const preparedId = randomUUID(), prepared = { preparedId, confirmation, target: structuredClone(state.target),
      native: structuredClone(state.native), items: structuredClone(previews), requestedItems: structuredClone(items),
      baseline: baseline.rows, baselineCoverage: coverage(state, baseline.rows) };
    state.prepared.set(preparedId, prepared);
    return { outcome: 'prepared', preparedId, confirmation, propertyCode: 'HRCEN', items: previews,
      baselineCoverage: prepared.baselineCoverage, availabilityVerified: false, saved: false };
  });
}

const approvedValues = item => Object.fromEntries([...Object.keys(FIELDS), 'currency', 'totalCost'].map(key => [key, item[key]]));

export async function saveStay360AddOns(page, confirmation, preparedId, options = {}) {
  return run(page, async state => {
    const prepared = state.prepared.get(preparedId);
    if (!prepared || prepared.confirmation !== confirmation) fail('ADDONS_PREPARED_ID_REQUIRED');
    if (prepared.baselineCoverage.complete !== true) fail('ADDONS_BASELINE_INCOMPLETE', 'needs_input');
    if (typeof options.authorize !== 'function') fail('ADDONS_SAVE_AUTHORIZATION_REQUIRED');
    await ensureOpen(page, state, confirmation);
    if (JSON.stringify(state.target) !== JSON.stringify(prepared.target) || JSON.stringify(state.native) !== JSON.stringify(prepared.native)) fail('ADDONS_TARGET_CHANGED');
    if (await options.authorize(structuredClone(prepared)) !== true) fail('ADDONS_SAVE_NOT_AUTHORIZED');
    if (JSON.stringify(await target(page, confirmation)) !== JSON.stringify(prepared.target)) fail('ADDONS_TARGET_CHANGED');
    state.prepared.delete(preparedId);
    const receipts = [];
    state.attempts = [];
    try {
      for (let index = 0; index < prepared.items.length; index += 1) {
        const approved = prepared.items[index];
        const requested = prepared.requestedItems[index];
        let current = await form(page, state);
        if (clean(state.values?.enhexpsequencekey) || clean(state.values?.recordid) ||
            current.itemId !== approved.itemId || JSON.stringify(approvedValues(current)) !== JSON.stringify(approvedValues(approved))) {
          current = await stageOne(page, state, requested);
        }
        if (JSON.stringify(approvedValues(current)) !== JSON.stringify(approvedValues(approved))) {
          fail('ADDONS_PRICE_OR_FIELDS_CHANGED', 'needs_input', { preview: current });
        }
        const dispatch = { operation: 'addOns', preparedId, confirmation, index, item: approvedValues(approved), target: prepared.target };
        const before = await loadedRows(page, 'listdetailgrid', popup(page));
        const data = await step(page, state, { kind: 'save', code: approved.code, itemId: approved.itemId,
          item: approved, beforeDispatch: options.beforeDispatch, dispatch }, () => button(page, 'submit'));
        // Submit resets the form; its values need not retain the inserted ID.
        // Resolve the new native grid row, then require full fresh readback.
        const after = await loadedRows(page, 'listdetailgrid', popup(page));
        const previousIds = new Set(before.rows.map(row => clean(row.enhexpsequencekey)).filter(Boolean));
        const inserted = after.rows.filter(row => clean(row.enhexpsequencekey) && !previousIds.has(clean(row.enhexpsequencekey)) &&
          clean(row.itemid) === approved.itemId && day(row.startdate) === approved.startDate && day(row.enddate) === approved.endDate &&
          decimal(row.quantity) === approved.quantity && decimal(row.totalcost) === approved.totalCost &&
          clean(row.enxcurrency) === approved.currency && String(row.comment ?? '') === approved.comment);
        const receipt = { index, item: approvedValues(approved), itemId: approved.itemId,
          nativeId: clean(data.values?.enhexpsequencekey) || clean(data.values?.recordid) ||
            (inserted.length === 1 ? clean(inserted[0].enhexpsequencekey) : null) };
        receipts.push(receipt);
        state.attempts.find(attempt => attempt.index === index).nativeId = receipt.nativeId;
        if (options.afterDispatch) await options.afterDispatch(structuredClone(receipt));
      }
      state.quarantined = true;
      return { outcome: 'awaiting_readback', confirmation, preparedId, receipts,
        attempts: structuredClone(state.attempts), requestedCount: prepared.items.length, baseline: prepared.baseline,
        baselineCoverage: prepared.baselineCoverage };
    } catch (error) {
      state.quarantined = true; state.prepared.clear();
      return { ...problem(error), outcome: state.dispatched || state.callbacks.size ? 'uncertain' : problem(error).outcome,
        confirmation, preparedId, receipts, requestedCount: prepared.items.length,
        attempts: structuredClone(state.attempts), baseline: prepared.baseline, baselineCoverage: prepared.baselineCoverage, next: 'fresh_readback' };
    } finally {
      // Quarantine prevents a late callback from sending its paused request.
      // Keep the caller's reservation lock until its journal callback settles.
      await Promise.allSettled([...state.callbacks]);
    }
  });
}

