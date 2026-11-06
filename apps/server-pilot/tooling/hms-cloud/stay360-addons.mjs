import { randomUUID } from 'node:crypto';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';
import { parseAssociationResponse } from './cancel-association-scope.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from './stay360-notes.mjs';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';

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
    if (!['save', 'edit', 'remove'].includes(pending.kind) ||
        !exact(url.searchParams, 'pageaction', pending.kind === 'remove' ? 'DELETE' : 'SAVE') ||
        [...url.searchParams].some(([key, value]) => key.toLowerCase() === 'action' ||
          (key.toLowerCase() === 'pageaction' && key !== 'pageaction') ||
          (body.has(key) && !exact(body, key, value)))) return false;
  }
  if (pending.kind === 'lookup' || pending.kind === 'more') {
    if (!['/web/base/LOVPOP', '/web/base/GRIDDATA'].includes(url.pathname) ||
        body.get('GRID_NAME') !== 'LVENHANCEDEXPERIENCE' || body.get('LOV_TAGNAME') !== 'itemorbundlecode') return false;
    const a = aliases(body);
    return a?.get('param.propertycode') === 'HRCEN' && a.get('param.itemtype') === (pending.itemType || 'ITEM') &&
      a.get('param.reservationstayid') === state.native.stayId && a.get('param.account') === state.native.account &&
      !body.has('pageaction') && !body.has('action');
  }
  if (!exact(body, 'propertycode', 'HRCEN') || !exact(body, 'SYSTEM_FUNCTION_NAME', 'OSENEX') ||
      !exact(body, 'USER_FUNCTION_NAME', 'OSENEX') || !noConfirmation(body)) return false;
  if (pending.kind === 'open' || pending.kind === 'open_unsaved') {
    const identity = pending.kind === 'open_unsaved'
      ? exact(body, 'reservationstayid', '') && exact(body, 'account', '')
      : /^\d+$/.test(body.get('reservationstayid') || '') && /^\d+$/.test(body.get('account') || '');
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') && identity;
  }
  if (!exact(body, 'reservationstayid', state.native.stayId) || !exact(body, 'account', state.native.account)) return false;
  if (pending.kind === 'type') {
    return url.pathname === `${PATH}.itemtypechange` && !body.has('pageaction') && !body.has('action') &&
      exact(body, 'ONLY_DATA_REQUIRED', 'true') && exact(body, 'itemtype', pending.itemType) && !clean(body.get('recordid')) &&
      !clean(body.get('enhexpsequencekey')) && !clean(body.get('itemorbundlecode'));
  }
  if (pending.kind === 'inspect') {
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') &&
      exact(body, 'ONLY_DATA_REQUIRED', 'true') && exact(body, 'enhexpsequencekey', pending.nativeId);
  }
  if (pending.kind === 'reset') {
    return url.pathname === PATH && !body.has('pageaction') && !body.has('action') &&
      exact(body, 'ONLY_DATA_REQUIRED', 'true') && !clean(body.get('enhexpsequencekey'));
  }
  if (!exact(body, 'itemtype', 'ITEM') || !exact(body, 'itemorbundlecode', pending.code) ||
      !exact(body, 'itemid', pending.itemId)) return false;
  if (pending.nativeId) {
    if (!exact(body, 'enhexpsequencekey', pending.nativeId) ||
        !exact(body, 'PKID', `${pending.nativeId}#HRCEN#ITEM`) ||
        body.getAll('recordid').length > 1 || (body.has('recordid') && !exact(body, 'recordid', pending.recordId))) return false;
  } else if (['recordid', 'enhexpsequencekey'].some(key => body.getAll(key).length > 1 || clean(body.get(key)))) return false;
  if (pending.kind === 'calculate') {
    return url.pathname === `${PATH}.getenhancedexperiencecalculations` && !body.has('pageaction') && !body.has('action');
  }
  if (!['save', 'edit', 'remove'].includes(pending.kind) || url.pathname !== PATH ||
      !exact(body, 'pageaction', pending.kind === 'remove' ? 'DELETE' : 'SAVE') || body.has('action')) return false;
  if (pending.kind !== 'save' && !pending.nativeId) return false;
  // A primary key for an existing item must never turn an approved insert into
  // an update, even if the visible fields still look like a new record.
  if (pending.kind === 'save' && (body.getAll('PKID').length > 1 || (clean(body.get('PKID')) &&
      !exact(body, 'PKID', '@[EMPTY]#HRCEN#ITEM')))) return false;
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
    target: null, prepared: new Map(), approvals, dispatched: false, nativeDialog: null, callbacks: new Set(), attempts: [], grid: null, rowDirty: false };
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
    if (pending.kind === 'open' || pending.kind === 'open_unsaved') {
      state.native = { stayId: body.get('reservationstayid'), account: body.get('account') };
    }
    if (['save', 'edit', 'remove'].includes(pending.kind)) {
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
        state.attempts.push(pending.kind === 'save'
          ? { index: pending.dispatch.index, item: structuredClone(pending.dispatch.item), itemId: pending.itemId, nativeId: null }
          : { ...structuredClone(pending.dispatch), dispatched: true, nativeId: pending.nativeId });
        state.approvals.add(request);
      } catch { pending.rejected = true; return route.abort(); }
    }
    return route.fallback();
  });
  return state;
}

async function assertNoUnexpectedWindows(page, state) {
  if (!state.nativeDialog) {
    const warning = await withDeadline(page.locator('.x-window:visible:not(.x-menu)').evaluateAll(windows => {
      const shown = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      let recordFrames = 0;
      for (const window of windows) {
        if (window.matches('[data-testid="popup-OSENEX"],[data-testid="popup-LOVPOP"]') ||
            window.querySelector('[data-testid="popup-OSENEX"],[data-testid="popup-LOVPOP"]')) continue;
        const frames = [...window.querySelectorAll('iframe')].filter(shown);
        if (frames.length === 1) {
          const url = new URL(frames[0].src, location.href);
          if (url.origin === location.origin && url.searchParams.get('initpath') === 'OSRESV' && ++recordFrames === 1) continue;
        }
        return { type: 'hms_window', title: window.querySelector('.x-window-header-text')?.innerText.trim() || '',
          message: window.innerText.trim().slice(0, 4000) };
      }
      return null;
    }), 10000, 'ADDONS_DIALOG_CHECK_TIMEOUT');
    if (warning) state.nativeDialog = warning;
  }
  if (state.nativeDialog) fail('ADDONS_DIALOG_REQUIRES_REVIEW', 'uncertain', { nativeDialog: state.nativeDialog });
}

async function step(page, state, spec, action) {
  if (state.quarantined || state.pending) fail('ADDONS_FRESH_SESSION_REQUIRED');
  const pending = { ...spec, request: null };
  state.pending = pending;
  const received = page.waitForResponse(response => response.request() === pending.request, { timeout: 25000 }).catch(() => null);
  try {
    await assertNoUnexpectedWindows(page, state);
    await action();
    const response = await received;
    if (!response || response.status() !== 200 || pending.rejected) fail(pending.rejected ? 'ADDONS_DISPATCH_REFUSED' : 'ADDONS_RESPONSE_UNVERIFIED');
    const data = nativeResponse(await withDeadline(response.text(), 25000, 'ADDONS_RESPONSE_BODY_TIMEOUT'));
    if (['edit', 'remove'].includes(spec.kind) && !data.values) fail('ADDONS_RESPONSE_UNVERIFIED');
    const grid = nativeGrid(data);
    if (grid?.METADATA?.GRIDNAME === 'OSENEX') state.grid = structuredClone(grid);
    if (data.values) {
      const v = data.values;
      if (clean(v.propertycode) !== 'HRCEN' || clean(v.reservationstayid) !== state.native.stayId ||
          clean(v.account) !== state.native.account) fail('ADDONS_NATIVE_TARGET_MISMATCH');
      state.values = v;
    }
    if (['reset', 'inspect', 'save', 'edit', 'remove'].includes(spec.kind)) state.rowDirty = false;
    await settled(page);
    await assertNoUnexpectedWindows(page, state);
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

function uniqueFormValue(fields, name) {
  const matches = fields.filter(field => field && field.name === name);
  return matches.length === 1 ? String(matches[0].value ?? '').trim() : null;
}

async function bindUnsavedCreate(page, state, expected, readForm) {
  if (typeof readForm !== 'function') fail('ADDONS_CREATE_FORM_READER_REQUIRED', 'needs_input');
  const read = await readForm();
  if (read?.outcome !== 'ok' || !Array.isArray(read.fields)) fail('ADDONS_CREATE_FORM_READBACK_REQUIRED', 'needs_input');
  const fields = read.fields;
  const confirmation = uniqueFormValue(fields, 'confirmationnumber');
  const guestId = uniqueFormValue(fields, 'guestid');
  const firstName = uniqueFormValue(fields, 'firstname'), lastName = uniqueFormValue(fields, 'lastname');
  const arrival = day(uniqueFormValue(fields, 'arrivaldate')), departure = day(uniqueFormValue(fields, 'departuredate'));
  const adults = uniqueFormValue(fields, 'adults'), children = uniqueFormValue(fields, 'children');
  const expectedChildren = expected?.stay?.childAges?.length;
  const childrenMatch = Number.isInteger(expectedChildren) &&
    (children === String(expectedChildren) || (expectedChildren === 0 && children === ''));
  const roomType = uniqueFormValue(fields, 'roomtype'), ratePlan = uniqueFormValue(fields, 'rateplan');
  const averageRate = uniqueFormValue(fields, 'averagerate'), totalRate = uniqueFormValue(fields, 'totalrate');
  const property = await page.evaluate(() => document.documentElement.dataset.propertyCode ??
    /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1] ?? null);
  if (property !== 'HRCEN' || confirmation !== '' || guestId !== String(expected?.guest?.profileId ?? '') ||
      firstName !== expected?.guest?.firstName || lastName !== expected?.guest?.lastName ||
      arrival !== expected?.stay?.arrival || departure !== expected?.stay?.departure ||
      adults !== String(expected?.stay?.adults ?? '') || !childrenMatch ||
      roomType !== expected?.room?.roomType || ratePlan !== expected?.room?.ratePlan || !averageRate || !totalRate) {
    fail('ADDONS_CREATE_CONTEXT_MISMATCH', 'needs_input');
  }
  const target = { kind: 'unsaved_create', propertyCode: 'HRCEN', guest: {
    nativeId: guestId, firstName, lastName,
  }, stay: { arrival, departure, adults: Number(adults), childAges: structuredClone(expected.stay.childAges) },
  room: { roomType, ratePlan }, createRateReadback: { averageRate, totalRate } };
  if (state.target && JSON.stringify(state.target) !== JSON.stringify(target)) fail('ADDONS_TARGET_CHANGED');
  if (state.native && (state.native.stayId !== '' || state.native.account !== '')) fail('ADDONS_TARGET_CHANGED');
  state.target = target;
  state.native = { stayId: '', account: '' };
  return target;
}

async function ensureUnsavedCreateOpen(page, state, expected, readForm) {
  const current = await bindUnsavedCreate(page, state, expected, readForm);
  if (await popup(page).count()) {
    if (!state.target || JSON.stringify(state.target) !== JSON.stringify(current)) fail('ADDONS_UNOWNED_POPUP');
    return current;
  }
  await dismissNotesOrThrow(page);
  const card = page.locator('.gs-panel:visible').filter({ has: page.locator('.x-panel-header-text').filter({ hasText: /^Add-Ons$/ }) });
  const open = card.locator('a.gs-header-btn:visible').filter({ has: page.locator('[data-testid="btn_ADDONS"]') });
  if (await open.count() !== 1) fail('ADDONS_BUTTON_NOT_UNIQUE', 'needs_input');
  await step(page, state, { kind: 'open_unsaved' }, () => open.click());
  await popup(page).waitFor({ state: 'visible', timeout: 20000 });
  return current;
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

async function catalogue(page, state, itemType = 'ITEM') {
  if (await picker(page).count()) fail('ADDONS_PICKER_ALREADY_OPEN');
  const input = popup(page).locator('input[name="itemorbundlecode"]:visible');
  const trigger = input.locator('xpath=ancestor::table[contains(@class,"x-form-trigger-wrap")][1]').locator('.x-form-lov-trigger:visible');
  if (await trigger.count() !== 1) fail('ADDONS_ITEM_LOOKUP_UNAVAILABLE');
  const data = await step(page, state, { kind: 'lookup', itemType }, () => trigger.click());
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
  const found = await catalogue(page, state);
  if (found.coverage?.complete !== true) fail('ADDONS_CATALOGUE_INCOMPLETE', 'needs_input', {
    options: found.candidates.map(({ code, name, itemId }) => ({ code, name, itemId })), coverage: found.coverage,
  });
  const matches = found.candidates.filter(item => item.code === code);
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
  state.rowDirty = true;
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
  } else await step(page, state, { kind: 'calculate', code: item.code, itemId: item.itemId,
    nativeId: item.nativeId, recordId: item.recordId }, edit);
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
      if (typeof item[key] === 'string' && [...item[key]].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
      })) fail('ADDONS_FIELD_INVALID', 'needs_input', { field: key });
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

async function inspectRow(page, state, nativeId) {
  // Native Clear reloads an empty form without requiring insertion permission.
  // It discards staged values and permits the same saved row to load again.
  if (state.rowDirty || clean(state.values?.enhexpsequencekey) === nativeId) {
    await step(page, state, { kind: 'reset' }, () => button(page, 'clear'));
  }
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
  return { nativeId, fields: await form(page, state) };
}

export async function readStay360AddOns(page, confirmation, { detailIds = [] } = {}) {
  return run(page, async state => {
    if (!Array.isArray(detailIds) || detailIds.some(id => typeof id !== 'string' || !id || /[\p{Cc}]/u.test(id))) fail('ADDONS_DETAIL_IDS_INVALID', 'needs_input');
    await ensureOpen(page, state, confirmation);
    const loaded = await loadedRows(page, 'listdetailgrid', popup(page));
    const details = [];
    for (const nativeId of detailIds) details.push(await inspectRow(page, state, nativeId));
    return { outcome: 'ok', confirmation, propertyCode: 'HRCEN', target: structuredClone(state.target),
      rows: loaded.rows, columns: loaded.columns, details,
      items: loaded.rows.map(row => ({ nativeId: clean(row.enhexpsequencekey), code: clean(row.itemorbundlecode) || null,
        name: clean(row.itemdesc), itemId: clean(row.itemid), quantity: decimal(row.quantity),
        startDate: day(row.startdate), endDate: day(row.enddate), totalCost: decimal(row.totalcost),
        currency: clean(row.enxcurrency) || null, unitPrice: decimal(row.unitprice),
        frequency: clean(row.frequency) || null, pricingControl: clean(row.pricingcontrol) || null,
        folio: clean(row.folio) || null, comment: row.comment == null ? null : String(row.comment) })).map(item => {
          const fields = details.find(detail => detail.nativeId === item.nativeId)?.fields;
          return fields ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fields[key] ?? value])) : item;
        }),
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

async function setCatalogueType(page, state, itemType) {
  const options = state.values?.itemtype?.option || [];
  const matching = options.filter(option => option.value === itemType);
  if (matching.length !== 1) fail('ADDONS_TYPE_REQUIRED', 'needs_input', { options });
  const input = popup(page).locator('input[name="itemtype"]:visible');
  if (await input.count() !== 1) fail('ADDONS_TYPE_CONTROL_UNVERIFIED');
  const current = await input.evaluate(element => {
    const cmp = Ext.getCmp(element.id.replace(/-inputEl$/, ''));
    return { value: cmp?.getValue?.(), editable: !element.disabled && !element.readOnly && !cmp?.readOnly && !cmp?.disabled };
  });
  if (current.value === itemType) return;
  if (!current.editable) fail('ADDONS_FRESH_TYPE_FORM_REQUIRED', 'needs_input');
  await input.locator('xpath=ancestor::table[contains(@class,"x-form-trigger-wrap")][1]')
    .locator('.x-form-arrow-trigger:visible').click();
  const candidates = await page.locator('.x-boundlist:visible .x-boundlist-item').all();
  const chosen = [];
  for (const option of candidates) if ((await option.innerText()).trim() === matching[0].display) chosen.push(option);
  if (chosen.length !== 1) fail('ADDONS_TYPE_OPTION_AMBIGUOUS');
  await step(page, state, { kind: 'type', itemType }, () => chosen[0].click());
  if (await input.evaluate(element => Ext.getCmp(element.id.replace(/-inputEl$/, ''))?.getValue?.()) !== itemType) {
    fail('ADDONS_TYPE_SELECTION_UNVERIFIED');
  }
}

/** Read current Meal Plan, Non-Room Bundle or Non-Room Item definitions. */
export async function listStay360AddOnCatalogue(page, confirmation, { itemType = 'ITEM' } = {}) {
  return run(page, async state => {
    if (!['MEAL', 'PACK', 'ITEM'].includes(itemType)) fail('ADDONS_TYPE_REQUIRED', 'needs_input');
    await ensureOpen(page, state, confirmation);
    // Changing the catalogue invalidates an earlier prepared form, never its authority.
    state.prepared.clear();
    await setCatalogueType(page, state, itemType);
    const found = await catalogue(page, state, itemType);
    await closePicker(page);
    await setCatalogueType(page, state, 'ITEM');
    return { confirmation, itemType, ...found };
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
    const preparedId = randomUUID(), prepared = { kind: 'add', preparedId, confirmation, target: structuredClone(state.target),
      native: structuredClone(state.native), items: structuredClone(previews), requestedItems: structuredClone(items),
      baseline: baseline.rows, baselineCoverage: coverage(state, baseline.rows) };
    state.prepared.set(preparedId, prepared);
    return { outcome: 'prepared', preparedId, confirmation, propertyCode: 'HRCEN', items: previews,
      baselineCoverage: prepared.baselineCoverage, availabilityVerified: false, saved: false };
  });
}

/** Preview Add-Ons against the exact, unsaved New Guest Stay currently owned by Create.
 * This never returns a save capability or session/prepared token; each caller must
 * run a fresh saved-target Prepare before any future Add-On Save.
 */
export async function previewUnsavedStay360AddOns(page, { expectedCreate, readForm, items } = {}) {
  try { items = structuredClone(items); } catch { return { outcome: 'needs_input', issue: 'ADDONS_ITEM_INVALID' }; }
  return run(page, async state => {
    validateItems(items);
    const target = await ensureUnsavedCreateOpen(page, state, expectedCreate, readForm);
    const previews = [];
    for (const requested of items) {
      try {
        const item = await stageOne(page, state, requested);
        previews.push({ outcome: 'prepared', requested: structuredClone(requested), item });
      } catch (error) {
        const issueResult = problem(error);
        const options = Array.isArray(issueResult.options)
          ? issueResult.options.map(candidate => ({ code: candidate.code, name: candidate.name, itemId: candidate.itemId })) : undefined;
        previews.push({ outcome: issueResult.outcome, issue: issueResult.issue,
          ...(issueResult.preview ? { item: issueResult.preview } : {}), ...(options ? { options } : {}) });
        if (state.quarantined) break;
      }
    }
    const complete = previews.length === items.length && previews.every(preview => preview.outcome === 'prepared');
    return { outcome: complete ? 'prepared' : 'partial', propertyCode: 'HRCEN', unsaved: true, saved: false,
      target, items: previews };
  });
}

/** Read the current native ITEM catalogue from the same verified unsaved New Guest Stay. */
export async function listUnsavedStay360AddOnItems(page, { expectedCreate, readForm } = {}) {
  return run(page, async state => {
    const target = await ensureUnsavedCreateOpen(page, state, expectedCreate, readForm);
    const found = await catalogue(page, state, 'ITEM');
    await closePicker(page);
    return { outcome: 'ok', propertyCode: 'HRCEN', unsaved: true, target,
      candidates: found.candidates.map(({ code, name, itemId }) => ({ code, name, itemId })),
      coverage: found.coverage };
  });
}

const approvedValues = item => Object.fromEntries([...Object.keys(FIELDS), 'currency', 'totalCost'].map(key => [key, item[key]]));

async function freshBaseline(prepared) {
  return withCenturionStay360Page(async page => {
    await readConfirmationFromStay360(page, prepared.confirmation, {
      guestName: prepared.target.guestName, arrivalDate: prepared.target.arrival,
    });
    const listing = await readStay360AddOns(page, prepared.confirmation);
    if (listing.outcome !== 'ok' || !prepared.changes) return listing;
    const present = new Set(listing.rows.map(row => clean(row.enhexpsequencekey)));
    const detailIds = prepared.changes.map(change => change.nativeId).filter(id => present.has(id));
    return detailIds.length ? readStay360AddOns(page, prepared.confirmation, { detailIds }) : listing;
  }, { headless: true, blockServiceWorkers: true });
}

export async function saveStay360AddOns(page, confirmation, preparedId, options = {}) {
  return run(page, async state => {
    const prepared = state.prepared.get(preparedId);
    if (!prepared || prepared.kind !== 'add' || prepared.confirmation !== confirmation) fail('ADDONS_PREPARED_ID_REQUIRED');
    if (typeof options.authorize !== 'function') fail('ADDONS_SAVE_AUTHORIZATION_REQUIRED');
    await ensureOpen(page, state, confirmation);
    if (JSON.stringify(state.target) !== JSON.stringify(prepared.target) || JSON.stringify(state.native) !== JSON.stringify(prepared.native)) fail('ADDONS_TARGET_CHANGED');
    if (await options.authorize(structuredClone(prepared)) !== true) fail('ADDONS_SAVE_NOT_AUTHORIZED');
    const baseline = await (options.readBaseline || freshBaseline)(structuredClone(prepared));
    if (baseline?.outcome !== 'ok' || baseline.coverage?.complete !== true || !Array.isArray(baseline.rows)) {
      fail('ADDONS_BASELINE_INCOMPLETE', 'needs_input');
    }
    if (JSON.stringify(baseline.target) !== JSON.stringify(prepared.target)) fail('ADDONS_TARGET_CHANGED');
    if (JSON.stringify(await target(page, confirmation)) !== JSON.stringify(prepared.target)) fail('ADDONS_TARGET_CHANGED');
    state.prepared.delete(preparedId);
    const receipts = [];
    state.attempts = [];
    try {
      for (let index = 0; index < prepared.items.length; index += 1) {
        const approved = prepared.items[index];
        const requested = prepared.requestedItems[index];
        const current = await stageOne(page, state, requested);
        if (current.itemId !== approved.itemId || current.name !== approved.name ||
            JSON.stringify(approvedValues(current)) !== JSON.stringify(approvedValues(approved))) {
          fail('ADDONS_PRICE_OR_FIELDS_CHANGED', 'needs_input', { preview: current });
        }
        const dispatch = { operation: 'addOns', preparedId, confirmation, index, item: approvedValues(approved), target: prepared.target,
          baselineIds: baseline.rows.map(row => clean(row.enhexpsequencekey)).filter(Boolean), baselineCoverage: baseline.coverage };
        const previousIds = new Set([...dispatch.baselineIds, ...receipts.map(receipt => receipt.nativeId).filter(Boolean)]);
        const data = await step(page, state, { kind: 'save', code: approved.code, itemId: approved.itemId,
          item: approved, beforeDispatch: options.beforeDispatch, dispatch }, () => button(page, 'submit'));
        // Submit resets the form; its values need not retain the inserted ID.
        // Resolve the new native grid row, then require full fresh readback.
        const after = await loadedRows(page, 'listdetailgrid', popup(page));
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
        attempts: structuredClone(state.attempts), requestedCount: prepared.items.length, baseline: baseline.rows,
        baselineCoverage: baseline.coverage };
    } catch (error) {
      state.quarantined = true; state.prepared.clear();
      return { ...problem(error), outcome: state.dispatched || state.callbacks.size ? 'uncertain' : problem(error).outcome,
        confirmation, preparedId, receipts, requestedCount: prepared.items.length,
        attempts: structuredClone(state.attempts), baseline: baseline.rows, baselineCoverage: baseline.coverage, next: 'fresh_readback' };
    } finally {
      // Quarantine prevents a late callback from sending its paused request.
      // Keep the caller's reservation lock until its journal callback settles.
      await Promise.allSettled(state.callbacks);
    }
  });
}

const recordValues = fields => ({ ...approvedValues(fields), itemId: fields.itemId, name: fields.name, status: fields.status });
const sameRecord = (left, right) => JSON.stringify(recordValues(left)) === JSON.stringify(recordValues(right));

async function actionAvailable(page, name) {
  return popup(page).evaluate((root, wanted) => {
    const nodes = [...root.querySelectorAll(`[data-testid="${wanted}"]`)];
    const anchor = nodes.length === 1 ? nodes[0].closest('a') : null;
    return Boolean(anchor && !anchor.classList.contains('x-item-disabled') && !Ext.getCmp(anchor.id)?.disabled);
  }, name);
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) fail('ADDONS_CHANGES_REQUIRED', 'needs_input');
  const ids = new Set();
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        !['edit', 'remove'].includes(change.operation) || typeof change.nativeId !== 'string' || !/^\d+$/.test(change.nativeId)) {
      fail('ADDONS_CHANGE_INVALID', 'needs_input');
    }
    if (ids.has(change.nativeId)) fail('ADDONS_DUPLICATE_ROW_CHANGE', 'needs_input');
    ids.add(change.nativeId);
    const keys = change.operation === 'edit' ? ['operation', 'nativeId', 'patch'] : ['operation', 'nativeId'];
    const unsupported = Object.keys(change).filter(key => !keys.includes(key));
    if (unsupported.length) fail('ADDONS_FIELDS_UNSUPPORTED', 'unsupported', { fields: unsupported });
    if (change.operation === 'edit') {
      const patch = change.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) fail('ADDONS_PATCH_REQUIRED', 'needs_input');
      if (Object.hasOwn(patch, 'code')) fail('ADDONS_FIELD_NOT_EDITABLE', 'unsupported', { field: 'code' });
      for (const key of ['frequency', 'pricingControl', 'folio', 'comment']) {
        if (Object.hasOwn(patch, key) && typeof patch[key] !== 'string') fail('ADDONS_FIELD_INVALID', 'needs_input', { field: key });
      }
      // Reuse the business-field validator; the code is resolved from the saved row.
      validateItems([{ ...patch, code: 'existing-row' }]);
    }
  }
}

async function stageChange(page, state, change) {
  let before;
  try { before = await inspectRow(page, state, change.nativeId); } catch (error) {
    if (error.message === 'ADDONS_DETAIL_NOT_LOADED') fail('ADDONS_RECORD_NOT_FOUND', 'needs_input', { nativeId: change.nativeId });
    throw error;
  }
  if (scalar(state.values?.itemtype) !== 'ITEM') fail('ADDONS_ITEM_TYPE_UNSUPPORTED', 'unsupported');
  const identity = { code: before.fields.code, itemId: before.fields.itemId, nativeId: change.nativeId,
    recordId: clean(state.values?.recordid) };
  if (!identity.code || !identity.itemId) fail('ADDONS_ROW_IDENTITY_UNVERIFIED');
  if (!await actionAvailable(page, change.operation === 'edit' ? 'submit' : 'removerecord')) {
    fail('ADDONS_CONTROL_UNAVAILABLE', 'unsupported', { nativeId: change.nativeId, operation: change.operation });
  }
  if (change.operation === 'remove') return { before, after: null, identity };
  for (const key of ['quantity', 'startDate', 'endDate', 'frequency', 'pricingControl', 'unitPrice', 'folio', 'comment']) {
    if (Object.hasOwn(change.patch, key)) await setField(page, state, identity, key, change.patch[key]);
  }
  const fields = await form(page, state);
  await assertNoUnexpectedWindows(page, state);
  const mismatch = Object.keys(change.patch).filter(key => fields[key] !== requestedValue(key, change.patch[key]));
  if (mismatch.length) fail('ADDONS_REQUESTED_FIELDS_CHANGED', 'needs_input', { fields: mismatch, preview: fields });
  if (fields.itemId !== identity.itemId || fields.code !== identity.code || clean(state.values?.enhexpsequencekey) !== change.nativeId) {
    fail('ADDONS_ROW_IDENTITY_UNVERIFIED');
  }
  if (fields.status !== 'VALID') fail('ADDONS_NATIVE_VALIDATION_REQUIRED', 'needs_input', { preview: fields });
  return { before, after: { nativeId: change.nativeId, fields }, identity };
}

/** Prepare exact-row partial edits or removal, without dispatching Submit/Delete. */
export async function prepareStay360AddOnChanges(page, confirmation, changes) {
  try { changes = structuredClone(changes); } catch { return { outcome: 'needs_input', issue: 'ADDONS_CHANGE_INVALID' }; }
  return run(page, async state => {
    validateChanges(changes);
    await ensureOpen(page, state, confirmation);
    state.prepared.clear();
    const preparedChanges = [];
    for (const [index, requested] of changes.entries()) {
      const staged = await stageChange(page, state, requested);
      preparedChanges.push({ index, ...requested, ...staged });
    }
    const preparedId = randomUUID();
    state.prepared.set(preparedId, { kind: 'changes', preparedId, confirmation, target: structuredClone(state.target),
      native: structuredClone(state.native), changes: structuredClone(preparedChanges) });
    return { outcome: 'prepared', preparedId, confirmation, propertyCode: 'HRCEN', saved: false,
      changes: preparedChanges.map(({ index, operation, nativeId, before, after }) => ({ index, operation, nativeId, before, after,
        changedFields: after ? Object.keys(recordValues(after.fields)).filter(key => recordValues(before.fields)[key] !== recordValues(after.fields)[key]) : [],
        warnings: [], financialEffect: 'unknown' })) };
  });
}

/** Sequential corrections; trusted authorization is required, journal/lock callbacks are optional. */
export async function saveStay360AddOnChanges(page, confirmation, preparedId, options = {}) {
  return run(page, async state => {
    const prepared = state.prepared.get(preparedId);
    if (!prepared || prepared.kind !== 'changes' || prepared.confirmation !== confirmation) fail('ADDONS_PREPARED_ID_REQUIRED');
    if (typeof options.authorize !== 'function') fail('ADDONS_SAVE_AUTHORIZATION_REQUIRED');
    await ensureOpen(page, state, confirmation);
    if (JSON.stringify(state.target) !== JSON.stringify(prepared.target) || JSON.stringify(state.native) !== JSON.stringify(prepared.native)) fail('ADDONS_TARGET_CHANGED');
    if (await options.authorize(structuredClone(prepared)) !== true) fail('ADDONS_SAVE_NOT_AUTHORIZED');
    state.prepared.delete(preparedId);
    const attempts = [], receipts = [];
    state.attempts = attempts;
    state.dispatched = false;
    let baseline = null;
    const result = outcome => ({ outcome, kind: 'changes', confirmation, preparedId, requestedCount: prepared.changes.length,
      changes: prepared.changes.map(({ index, operation, nativeId, before, after }) => ({ index, operation, nativeId, before, after })),
      attempts: structuredClone(attempts), receipts: structuredClone(receipts), baseline: baseline?.rows || [], baselineCoverage: baseline?.coverage,
      target: prepared.target });
    try {
      for (const approved of prepared.changes) {
        const fresh = await (options.readBaseline || freshBaseline)({ ...structuredClone(prepared), changes: [structuredClone(approved)] });
        if (fresh?.outcome !== 'ok' || !Array.isArray(fresh.rows) ||
            (approved.operation === 'remove' && fresh.coverage?.complete !== true)) fail('ADDONS_BASELINE_INCOMPLETE', 'needs_input');
        if (JSON.stringify(fresh.target) !== JSON.stringify(prepared.target) ||
            JSON.stringify(await target(page, confirmation)) !== JSON.stringify(prepared.target)) fail('ADDONS_TARGET_CHANGED');
        baseline ||= fresh;
        const records = fresh.details?.filter(detail => detail.nativeId === approved.nativeId) || [];
        if (records.length !== 1 || !sameRecord(records[0].fields, approved.before.fields)) {
          fail('ADDONS_RECORD_CHANGED', 'needs_input', { nativeId: approved.nativeId, current: records[0] || null });
        }
        const staged = await stageChange(page, state, approved);
        if (!sameRecord(staged.before.fields, approved.before.fields)) fail('ADDONS_RECORD_CHANGED', 'needs_input', { current: staged.before });
        if (approved.after && !sameRecord(staged.after.fields, approved.after.fields)) {
          fail('ADDONS_PRICE_OR_FIELDS_CHANGED', 'needs_input', { preview: staged.after });
        }
        if (approved.after && sameRecord(approved.before.fields, approved.after.fields)) {
          receipts.push({ index: approved.index, operation: approved.operation, nativeId: approved.nativeId,
            status: 'unchanged', dispatched: false, before: approved.before, after: approved.after });
          continue;
        }
        const dispatch = { index: approved.index, operation: approved.operation, nativeId: approved.nativeId, confirmation, preparedId, target: prepared.target,
          before: approved.before, after: approved.after, baselineCoverage: fresh.coverage, baselineIds: fresh.rows.map(row => clean(row.enhexpsequencekey)).filter(Boolean) };
        const item = approved.after?.fields || approved.before.fields;
        await step(page, state, { kind: approved.operation, ...staged.identity, item, dispatch,
          beforeDispatch: options.beforeDispatch }, () => button(page, approved.operation === 'edit' ? 'submit' : 'removerecord'));
        const receipt = { ...dispatch, dispatched: true, status: 'awaiting_readback' };
        receipts.push(receipt);
        if (options.afterDispatch) await options.afterDispatch(structuredClone(receipt));
      }
      state.quarantined = true;
      return result(attempts.length ? 'awaiting_readback' : 'unchanged');
    } catch (error) {
      state.quarantined = true;
      const dispatched = attempts.length > 0 || state.callbacks.size > 0;
      return { ...result(dispatched ? 'uncertain' : problem(error).outcome), ...problem(error),
        outcome: dispatched ? 'uncertain' : problem(error).outcome,
        needsNativeReview: ['ADDONS_DIALOG_REQUIRES_REVIEW', 'ADDONS_NATIVE_RESPONSE_INVALID'].includes(error.message),
        next: dispatched ? 'reconcile_before_retry' : 'fresh_session' };
    } finally {
      state.quarantined = true;
      state.prepared.clear();
      await Promise.allSettled(state.callbacks);
    }
  });
}
