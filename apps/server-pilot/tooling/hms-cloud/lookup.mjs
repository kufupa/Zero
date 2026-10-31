// Live lookups on an authenticated, unsaved Guest Stay. The caller owns the page.
import { randomUUID } from 'node:crypto';
import { treeClickFallback } from '../playwright-quote/open-guest-stay.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const LOOKUPS = {
  agency: {
    title: 'Booking Agencies', field: 'ta1', label: 'Primary Booking Agency',
    filter: 'Booking Agency Name', alias: 'travelagencyname', id: 'travelagencyid', name: 'travelagencyname',
    changePath: '/web/base/OSRESV.HDR.changetravelagency', requestId: 'taid1',
  },
  organization: {
    title: 'Organizations', field: 'company', label: 'Organization',
    filter: 'Name', alias: 'companyname', id: 'companyid', name: 'companyname',
    changePath: '/web/base/OSRESV.HDR.changeorganization', requestId: 'companyid',
  },
  arAccount: {
    title: 'A/R Account', field: 'araccountname', label: 'A/R Account',
    filter: 'A/R Account', alias: 'araccountname', id: 'araccountid', name: 'araccountname',
    changePath: '/web/base/OSRESV.HDR.araccountchange', requestId: 'araccountid',
  },
};

const busyPages = new WeakSet();
const lastSearch = new WeakMap();
const verifiedArSelections = new WeakMap();
const clean = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
const rowKey = (row, columns) => JSON.stringify(columns.map((column) => clean(row[column])));
const signature = (rows, columns) => JSON.stringify(rows.map((row) => rowKey(row, columns)).sort());
const issue = (error, fallback) => {
  const message = String(error?.message || error).split('\n')[0];
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : fallback;
};

function forgetVerifiedAr(page) {
  const previous = verifiedArSelections.get(page);
  verifiedArSelections.delete(page);
  if (previous) void previous.record.dispose().catch(() => {});
}

// Retain the native record object, not a caller-supplied draft identifier.
async function arDraftRecord(page) {
  let record;
  try {
    record = await page.evaluateHandle((origin) => {
      if (location.origin !== origin) return null;
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const names = ['guaranteetype', 'araccountname', 'confirmationnumber'];
      const fields = names.map((name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible));
      if (fields.some((items) => items.length !== 1) || fields[2][0].value.trim()) return null;
      const component = (el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const form = component(fields[0][0])?.up?.('form');
      if (!form?.el?.dom || fields.some(([el]) => !form.el.dom.contains(el) || component(el)?.up?.('form') !== form)) return null;
      return form.getRecord?.() ?? null;
    }, ORIGIN);
    const session = await record.evaluate((item) => {
      const data = item?.data, keys = data && Object.keys(data);
      const exact = (key, value) => keys && Object.hasOwn(data, key) &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1 && String(data[key] ?? '').trim() === value;
      if (!exact('propertycode', 'HRCEN') || !exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') || !exact('status', 'New') ||
          !keys.includes('bookingsessionid') || keys.filter((key) => key.toLowerCase() === 'bookingsessionid').length !== 1) return null;
      return String(data.bookingsessionid ?? '').trim() || null;
    });
    if (session) return { record, session };
  } catch { /* A selection can still succeed without a guarantee proof. */ }
  await record?.dispose().catch(() => {});
  return null;
}

async function arRecordMatches(page, identity) {
  try {
    return await page.evaluate(({ origin, record, session, accountId, profileId }) => {
      if (location.origin !== origin) return false;
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const names = ['guaranteetype', 'araccountname', 'confirmationnumber'];
      const fields = names.map((name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible));
      if (fields.some((items) => items.length !== 1) || fields[2][0].value.trim()) return false;
      const component = (el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const form = component(fields[0][0])?.up?.('form');
      if (!form?.el?.dom || form.getRecord?.() !== record ||
          fields.some(([el]) => !form.el.dom.contains(el) || component(el)?.up?.('form') !== form)) return false;
      const data = record?.data, keys = data && Object.keys(data);
      const exact = (key, value) => keys && Object.hasOwn(data, key) &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1 && String(data[key] ?? '').trim() === value;
      return Boolean(exact('propertycode', 'HRCEN') && exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') && exact('status', 'New') &&
        exact('bookingsessionid', session) && exact('araccountid', accountId) && exact('arprofileid', profileId));
    }, { origin: ORIGIN, ...identity });
  } catch { return false; }
}

export async function verifiedArSelectionToken(page, identity) {
  const proof = verifiedArSelections.get(page);
  if (!proof || proof.session !== identity.session || proof.accountId !== identity.accountId || proof.profileId !== identity.profileId ||
      !await arRecordMatches(page, proof) || verifiedArSelections.get(page) !== proof) return null;
  return proof.token;
}

export function isVerifiedArSelectionCurrent(page, identity) {
  const proof = verifiedArSelections.get(page);
  return Boolean(proof && proof.token === identity.token && proof.session === identity.session &&
    proof.accountId === identity.accountId && proof.profileId === identity.profileId);
}

function lookupWindow(page, kind) {
  return page.locator('.x-window:visible').filter({ hasText: LOOKUPS[kind].title }).last();
}

async function assertExpectedDialogs(page, nativeDialog = false) {
  if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
  const windows = page.locator('.x-window:visible:not(.x-menu)');
  for (let index = 0; index < await windows.count(); index += 1) {
    const titles = await windows.nth(index).locator('.x-window-header-text:visible').allTextContents();
    if (titles.length !== 1 || !Object.values(LOOKUPS).some((spec) => titles[0].trim() === spec.title)) {
      throw new Error('UNEXPECTED_DIALOG');
    }
  }
}

async function clickTreeNode(node, hasNativeDialog) {
  for (const timeout of [2500, 17500]) {
    try {
      await node.click({ timeout });
      return;
    } catch (error) {
      await assertExpectedDialogs(node.page(), hasNativeDialog());
      const masked = await node.page().locator('.x-mask:visible, .x-mask-msg:visible').count();
      if (treeClickFallback(error) === 'dom' && !masked) return node.evaluate((element) => element.click());
      if (timeout === 17500) throw error;
    }
  }
}

async function assertNewGuestStay(page) {
  const agency = page.locator('input[name="ta1"]:visible').first();
  const confirmation = page.locator('input[name="confirmationnumber"]:visible').first();
  if (!await agency.isVisible() || !await confirmation.isVisible() || (await confirmation.inputValue()).trim()) {
    throw new Error('NOT_A_NEW_GUEST_STAY');
  }
}

async function assertSelectionProperty(page) {
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('HMS_TARGET_MISMATCH');
  const property = page.locator('[data-qtip="Property"]:visible');
  if (await property.count() !== 1 || (await property.innerText()).trim().toUpperCase() !== PROPERTY) {
    throw new Error('PROPERTY_MISMATCH');
  }
  return PROPERTY;
}

/** True only for the expected data-only change on the verified blank HRCEN stay. */
export function isSafePartySelectionRequest({ method, url, postData }, { kind, nativeId, propertyCode, pageOrigin } = {}) {
  try {
    const spec = LOOKUPS[kind];
    const target = new URL(url);
    if (!spec || !clean(nativeId) || method !== 'POST' || target.origin !== ORIGIN || target.origin !== pageOrigin ||
        target.pathname !== spec.changePath || target.search || target.hash || propertyCode !== PROPERTY) return false;
    const body = new URLSearchParams(postData || '');
    const required = ['PKID', 'confirmationnumber', 'propertycode', spec.requestId,
      'recordid', 'reservationid', 'ONLY_DATA_REQUIRED'];
    const keys = [...body.keys()].map((key) => key.toLowerCase());
    if (required.some((key) => keys.filter((actual) => actual === key.toLowerCase()).length !== 1 || !body.has(key))) {
      return false;
    }
    return body.get('PKID') === `@[EMPTY]#@[EMPTY]#${propertyCode}#` &&
      body.get('propertycode') === propertyCode && body.get(spec.requestId) === nativeId &&
      body.get('ONLY_DATA_REQUIRED') === 'true' &&
      ['confirmationnumber', 'recordid', 'reservationid'].every((key) => !clean(body.get(key)));
  } catch { return false; }
}

/** Open a new, unsaved Guest Stay on the supplied authenticated page. */
export async function openNewGuestStay(page) {
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    await assertExpectedDialogs(page, nativeDialog);
    const agency = page.locator('input[name="ta1"]:visible').first();
    if (!await agency.isVisible().catch(() => false)) {
      await page.locator('a.app-menu-trigger:visible').click();
      const nodes = page.locator('span.x-tree-node-text:visible');
      const guestStay = nodes.filter({ hasText: /^Guest Stay$/ });
      if (!await guestStay.isVisible().catch(() => false)) await clickTreeNode(nodes.filter({ hasText: /^Front Desk$/ }), () => nativeDialog);
      let opened = false;
      for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
        await page.waitForTimeout(800);
        if (!await guestStay.isVisible().catch(() => false)) await page.locator('a.app-menu-trigger:visible').click();
        await clickTreeNode(guestStay, () => nativeDialog);
        opened = await page.locator('input[name="ff_confirmationnumber"]:visible').first()
          .waitFor({ timeout: 8000 }).then(() => true, () => false);
        if (!opened) await assertExpectedDialogs(page, nativeDialog);
      }
      if (!opened) throw new Error('GUEST_STAY_NOT_OPENED');
      await assertExpectedDialogs(page, nativeDialog);
      await page.locator('[data-qtip="New Record (Ctrl+N)"]:visible').first().click();
      await agency.waitFor({ timeout: 25000 });
    }
    await assertExpectedDialogs(page, nativeDialog);
    await assertNewGuestStay(page);
  } finally {
    page.off('dialog', onDialog);
  }
}

async function openLookupWindow(page, kind, hasNativeDialog) {
  await assertExpectedDialogs(page, hasNativeDialog());
  const win = lookupWindow(page, kind);
  if (await win.isVisible().catch(() => false)) {
    await assertNewGuestStay(page);
    return win;
  }
  for (const other of Object.keys(LOOKUPS).filter((name) => name !== kind)) {
    const otherWindow = lookupWindow(page, other);
    if (await otherWindow.isVisible().catch(() => false)) {
      await otherWindow.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ }).first().click();
      await otherWindow.waitFor({ state: 'hidden', timeout: 10000 });
    }
  }
  await openNewGuestStay(page);
  const field = page.locator(`input[name="${LOOKUPS[kind].field}"]:visible`).first();
  const trigger = field.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible').first();
  await trigger.click();
  if (!await win.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) {
    await assertExpectedDialogs(page, hasNativeDialog());
    if (!await win.isVisible()) await trigger.click();
    await win.waitFor({ state: 'visible', timeout: 12000 });
  }
  await assertExpectedDialogs(page, hasNativeDialog());
  return win;
}

async function readGrid(page, windowId) {
  return page.evaluate((id) => {
    const win = Ext.getCmp(id);
    const grid = win?.query('grid,readonlygrid')?.[0];
    const store = grid?.getStore?.();
    if (!win?.isVisible?.() || !store) throw new Error('LOOKUP_GRID_UNAVAILABLE');
    const columns = grid.getColumnManager?.()?.getColumns?.() || grid.columns || [];
    return {
      records: store.getRange().map((record) => ({ ...record.data })),
      columns: columns.map((column) => ({
        label: column.text ?? null, field: column.dataIndex ?? null, hidden: Boolean(column.hidden),
      })),
    };
  }, windowId);
}

async function readCriteria(win) {
  return win.locator('input:visible, select:visible, textarea:visible').evaluateAll((elements) =>
    elements.map((element) => ({
      name: element.name || null,
      label: element.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim() || null,
      value: element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value,
      type: element.type || element.tagName.toLowerCase(),
    })));
}

function matchesRun(request, query, alias) {
  try {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/web/base/GRIDDATA') return false;
    const body = new URLSearchParams(request.postData() || '');
    return body.get('MADDON_FILTER_ALIAS_NAME_1') === alias &&
      body.get('MADDON_FILTER_VALUE_1')?.trim().toLocaleLowerCase() === query.toLocaleLowerCase();
  } catch {
    return false;
  }
}

function responseData(body) {
  const json = body.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json);
  const data = payload?.pageData;
  const hasContent = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  const failed = [payload, data].some((part) => part && ((Object.hasOwn(part, 'success') && part.success !== true) ||
    hasContent(part.error) || hasContent(part.errors)));
  if (!data || failed || hasContent(data.messages)) throw new Error('LOOKUP_RESPONSE_INVALID');
  return data;
}

async function waitForResponseRows(page, windowId, columns, rows, timeoutMs) {
  const result = await page.waitForFunction(({ id, baseKeys, responseRows }) => {
    const win = Ext.getCmp(id);
    const store = win?.query('grid,readonlygrid')?.[0]?.getStore?.();
    if (!win?.isVisible?.() || !store) return false;
    const records = store.getRange().map(({ data }) => data);
    const scalar = (value) => value == null || ['string', 'number', 'boolean'].includes(typeof value);
    const extraKeys = [...new Set(responseRows.flatMap((row) => Object.keys(row)))].filter((key) =>
      !/date|time/i.test(key) && records.some((record) => Object.hasOwn(record, key)) &&
      responseRows.every((row) => scalar(row[key])) && records.every((record) => scalar(record[key])));
    const keys = [...new Set([...baseKeys, ...extraKeys])].sort();
    const cleanValue = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();
    const sig = (items) => JSON.stringify(items.map((row) => JSON.stringify(keys.map((key) => cleanValue(row[key])))).sort());
    return sig(records) === sig(responseRows) ? keys : false;
  }, { id: windowId, baseKeys: columns, responseRows: rows }, { timeout: timeoutMs });
  const keys = await result.jsonValue();
  await result.dispose();
  return { keys, expected: signature(rows, keys) };
}

function candidate(row, records, kind, spec, keys) {
  const matches = records.filter((record) => rowKey(record, keys) === rowKey(row, keys));
  return {
    nativeId: clean(row[spec.id]), name: clean(row[spec.name]),
    ...(kind === 'agency' ? {
      referenceNumber: clean(row.iatanumber), referenceNumberType: clean(row.referencenumbertype),
      internalReferenceNumber: clean(row.internalreferencenumber),
    } : kind === 'organization' ? { corporateAccountNumber: clean(row.corporateaccountnumber) } : {
      accountNumber: clean(row.araccountnumber), status: clean(row.arstatuscodedesc),
      accountType: clean(row.accttype), accountStanding: clean(row.accountstanding),
    }),
    address: clean(row.address), city: clean(row.city), country: clean(row.country),
    contactFirstName: clean(kind === 'arAccount' ? row.firstname : row.contactfirstname),
    contactLastName: clean(kind === 'arAccount' ? row.lastname : row.contactlastname),
    contactPhone: clean(kind === 'arAccount' ? row.phonenumber : row.contactphone),
    responseData: row, gridData: matches.length === 1 ? matches[0] : null,
    ...(matches.length > 1 ? { possibleGridData: matches } : {}),
  };
}

function coverage(metadata, loaded) {
  const more = String(metadata.MORERECORDPRESENT ?? '').trim();
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

async function search(page, kind, input, { timeoutMs = 20000 } = {}) {
  const spec = LOOKUPS[kind];
  const query = typeof input === 'string' ? input.trim() : '';
  if (busyPages.has(page)) return { outcome: 'execution_failure', kind, query, candidates: [], issue: 'lookup_in_progress' };
  if (kind === 'arAccount') forgetVerifiedAr(page);
  if (!query || query.length > 200 || /[\r\n]/.test(query)) {
    lastSearch.delete(page);
    return { outcome: 'input_gap', candidates: [], issue: `${kind}_name_required` };
  }
  busyPages.add(page);
  lastSearch.delete(page);
  let captureRequest;
  let stage = 'opening_lookup';
  let nativeDialog = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const win = await openLookupWindow(page, kind, () => nativeDialog);
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('LOOKUP_WINDOW_UNAVAILABLE');
    stage = 'applying_filter';
    const selector = win.locator('input[name="filterfields"]:visible').first();
    if ((await selector.inputValue()).trim() !== spec.filter) {
      await selector.click();
      await page.locator('.x-boundlist-item:visible').filter({ hasText: new RegExp(`^\\s*${spec.filter}\\s*$`) }).first().click();
    }
    if ((await selector.inputValue()).trim() !== spec.filter) throw new Error('LOOKUP_FILTER_NOT_SELECTED');
    const inputField = win.locator('input[name="selfiltervaluectrl"]:visible').first();
    await inputField.fill(query);
    if ((await inputField.inputValue()).trim() !== query) throw new Error('LOOKUP_FILTER_NOT_APPLIED');
    const controls = await readCriteria(win);
    const requests = new Set();
    captureRequest = (request) => { if (matchesRun(request, query, spec.alias)) requests.add(request); };
    page.on('request', captureRequest);
    const responsePromise = page.waitForResponse((response) => requests.has(response.request()), { timeout: timeoutMs })
      .catch(() => null);
    stage = 'running_search';
    await assertExpectedDialogs(page, nativeDialog);
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ }).first().click();
    const response = await responsePromise;
    if (!response || response.status() !== 200) throw new Error('LOOKUP_SEARCH_UNVERIFIED');
    const requestFilters = [...new URLSearchParams(response.request().postData() || '')]
      .filter(([name]) => name.startsWith('MADDON_FILTER_'))
      .map(([name, value]) => ({ name, value }));
    stage = 'reading_response';
    let timer;
    const body = await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('LOOKUP_RESPONSE_TIMEOUT')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
    const { DATA: rows, METADATA: metadata } = responseData(body).grid?.GRIDRESULT?.GRID ?? {};
    if (!Array.isArray(rows) || !metadata) throw new Error('LOOKUP_RESPONSE_INVALID');
    stage = 'waiting_for_grid';
    const { keys, expected } = await waitForResponseRows(page, windowId, [spec.id, spec.name], rows, timeoutMs);
    await assertExpectedDialogs(page, nativeDialog);
    const externalError = page.getByText(/Cannot retrieve profile:\s*External system|External system unavailable/i)
      .filter({ visible: true });
    if (await externalError.count()) throw new Error('EXTERNAL_SYSTEM_UNAVAILABLE');
    const grid = await readGrid(page, windowId);
    if (signature(grid.records, keys) !== expected || JSON.stringify(await readCriteria(win)) !== JSON.stringify(controls)) {
      throw new Error('LOOKUP_RESULTS_UNVERIFIED');
    }
    const resultCoverage = coverage(metadata, grid.records.length);
    if (!rows.length && (resultCoverage.serverMoreRecords !== false || (resultCoverage.total != null && resultCoverage.total !== 0))) {
      throw new Error('LOOKUP_EMPTY_UNVERIFIED');
    }
    const candidates = rows.map((row) => candidate(row, grid.records, kind, spec, keys));
    const searchId = randomUUID();
    lastSearch.set(page, { kind, windowId, searchId, controls: JSON.stringify(controls), grid: JSON.stringify(grid.records),
      candidates: candidates.map(({ nativeId, name, referenceNumber }) => ({ nativeId, name,
        ...(kind === 'agency' ? { referenceNumber } : {}) })) });
    const unverified = (records) => [...new Set(records.flatMap((row) => Object.keys(row)))].filter((key) => !keys.includes(key));
    return {
      outcome: candidates.length ? 'matches' : 'no_match', kind, field: spec.label, query, searchId,
      criteria: { field: spec.filter, query, controls, requestFilters }, coverage: resultCoverage,
      loaded: resultCoverage.loaded, total: resultCoverage.total,
      possiblyTruncated: resultCoverage.possiblyTruncated, serverMoreRecords: resultCoverage.serverMoreRecords,
      columns: grid.columns, metadata, candidates,
      correlation: { verifiedFields: keys, unverifiedResponseFields: unverified(rows), unverifiedGridFields: unverified(grid.records) },
    };
  } catch (error) {
    return { outcome: 'execution_failure', kind, query, stage, candidates: [], issue: issue(error, 'LOOKUP_FAILED') };
  } finally {
    if (captureRequest) page.off('request', captureRequest);
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

async function readForm(page) {
  return page.evaluate(() => {
    const visible = (element) => (element.offsetWidth || element.offsetHeight) && !element.closest('.x-window');
    const agency = [...document.querySelectorAll('input[name="ta1"]')].find(visible);
    let root = agency;
    while (root && ![...root.querySelectorAll('input[name="confirmationnumber"]')].some(visible)) root = root.parentElement;
    if (!root) throw new Error('LOOKUP_FORM_UNAVAILABLE');
    const components = new Map(Ext.ComponentQuery.query('field').filter((field) => field.inputEl?.id)
      .map((field) => [field.inputEl.id, field]));
    return [...root.querySelectorAll('input:not([type="hidden"]):not([type="password"]), textarea, select')]
      .filter(visible).map((element) => {
        const component = components.get(element.id);
        const label = element.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim() ||
          [...(element.labels || [])].map((item) => item.innerText?.trim()).filter(Boolean).join(' ') ||
          element.getAttribute('aria-label') || component?.getFieldLabel?.() || component?.boxLabel || null;
        return {
          id: element.id || null, name: element.name || null, label,
          type: element.type || element.tagName.toLowerCase(),
          value: element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value,
          disabled: element.disabled, readOnly: element.readOnly || false,
        };
      });
  });
}

function changedFields(before, after) {
  const key = (field, index) => field.id || `${field.name || ''}\u0000${index}`;
  const previous = new Map(before.map((field, index) => [key(field, index), field]));
  const current = new Map(after.map((field, index) => [key(field, index), field]));
  return [...new Set([...previous.keys(), ...current.keys()])].flatMap((id) => {
    const oldField = previous.get(id) ?? null;
    const newField = current.get(id) ?? null;
    return JSON.stringify(oldField) === JSON.stringify(newField) ? [] : [{ before: oldField, after: newField }];
  });
}

async function select(page, kind, selection, { timeoutMs = 20000 } = {}, requireSearchId = true) {
  const spec = LOOKUPS[kind];
  const nativeId = clean(typeof selection === 'object' && selection !== null ? selection.nativeId : selection);
  const searchId = typeof selection === 'object' && selection !== null ? selection.searchId : null;
  if (!nativeId) return { outcome: 'input_gap', issue: `${kind}_id_required` };
  if (requireSearchId && !searchId) return { outcome: 'input_gap', issue: 'search_id_required' };
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'lookup_in_progress' };
  if (kind === 'arAccount') forgetVerifiedAr(page);
  busyPages.add(page);
  let attempted = false;
  let nativeDialog = false;
  let requestFailed = false;
  let observed = null;
  let nativeReadback = null;
  let arDraft = null, arRequestBound = false, arResponseIdentity = null;
  let requestProperty = null;
  let requestIdVerified = false;
  let changeResponseVerified = false;
  let pendingChangeResponses = 0;
  let pageProperty;
  let fence, scope;
  const inFlight = new Set();
  const onDialog = () => { nativeDialog = true; };
  const onRequest = (request) => { if (request.method() === 'POST') inFlight.add(request); };
  const onFinished = (request) => { inFlight.delete(request); };
  const onFailed = (request) => { if (inFlight.delete(request)) requestFailed = true; };
  const onResponse = (response) => {
    if (!inFlight.has(response.request())) return;
    if (new URL(response.url()).pathname === spec.changePath) {
      if (response.status() !== 200) requestFailed = true;
      else {
        pendingChangeResponses += 1;
        void response.text().then((body) => {
          const values = responseData(body).values;
          changeResponseVerified = Boolean(values && Object.hasOwn(values, 'confirmationnumber') &&
            !clean(values.confirmationnumber) && clean(values[spec.requestId]) === nativeId &&
            (kind !== 'arAccount' || (requestProperty && clean(values.propertycode) === requestProperty &&
              ['recordid', 'reservationid'].every((key) => Object.hasOwn(values, key) && !clean(values[key])))));
          if (changeResponseVerified && kind === 'arAccount') {
            nativeReadback = Object.fromEntries(['araccountid', 'araccountname', 'arstatuscodedesc']
              .filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
            const keys = Object.keys(values);
            const unique = (key) => Object.hasOwn(values, key) && keys.filter((name) => name.toLowerCase() === key).length === 1;
            if (arDraft && ['araccountid', 'arprofileid', 'bookingsessionid'].every(unique) &&
                clean(values.araccountid) === nativeId && clean(values.arprofileid) && clean(values.bookingsessionid) === arDraft.session) {
              arResponseIdentity = { session: arDraft.session, accountId: nativeId, profileId: clean(values.arprofileid) };
            }
          }
          if (!changeResponseVerified) requestFailed = true;
        }).catch(() => { requestFailed = true; }).finally(() => { pendingChangeResponses -= 1; });
      }
    } else if (response.status() >= 400) requestFailed = true;
  };
  const guardChange = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (kind === 'arAccount' && request.method() === 'POST' && url.pathname !== spec.changePath) {
      requestFailed = true;
      await route.abort();
      return;
    }
    if (request.method() === 'POST' && url.pathname === spec.changePath) {
      if (!attempted || requestIdVerified || !isSafePartySelectionRequest({ method: request.method(), url: request.url(), postData: request.postData() },
        { kind, nativeId, propertyCode: pageProperty, pageOrigin: new URL(page.url()).origin })) {
        requestFailed = true;
        await route.abort();
        return;
      }
      if (!scope?.allow(request)) {
        requestFailed = true;
        await route.abort();
        return;
      }
      if (kind === 'arAccount') {
        requestProperty = pageProperty;
        const body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
        arRequestBound = Boolean(arDraft && body.getAll('bookingsessionid').length === 1 &&
          keys.filter((key) => key.toLowerCase() === 'bookingsessionid').length === 1 && body.get('bookingsessionid') === arDraft.session);
      }
      requestIdVerified = true;
    }
    await route.fallback();
  };
  page.on('dialog', onDialog);
  try {
    fence = await installPageRequestFence(page, Object.values(LOOKUPS).map(({ changePath }) => changePath));
    scope = fence.open();
    const previous = lastSearch.get(page);
    if (previous?.kind !== kind || (searchId && searchId !== previous.searchId)) throw new Error('LOOKUP_STALE');
    const candidates = previous.candidates.filter((item) => item.nativeId === nativeId);
    if (candidates.length !== 1 || !candidates[0].name) throw new Error('LOOKUP_ID_NOT_UNIQUE');
    await assertExpectedDialogs(page);
    await assertNewGuestStay(page);
    pageProperty = await assertSelectionProperty(page);
    const win = lookupWindow(page, kind);
    if (!await win.isVisible() || await win.getAttribute('id') !== previous.windowId) throw new Error('LOOKUP_STALE');
    const grid = await readGrid(page, previous.windowId);
    if (JSON.stringify(grid.records) !== previous.grid || JSON.stringify(await readCriteria(win)) !== previous.controls) {
      throw new Error('LOOKUP_STALE');
    }
    const before = await readForm(page);
    if (kind === 'arAccount') arDraft = await arDraftRecord(page);
    const rows = win.locator('.x-grid-view .x-grid-row, .x-grid-view .x-grid-data-row');
    const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
      const grid = (Ext.ComponentQuery.query('grid,readonlygrid') || [])
        .find((item) => item.getEl?.()?.dom?.contains(element));
      const data = grid?.getView?.()?.getRecord?.(element)?.data;
      return String(data?.[wanted.key] ?? '').trim() === wanted.id ? [index] : [];
    }), { key: spec.id, id: nativeId });
    if (indexes.length !== 1) throw new Error('LOOKUP_ID_NOT_UNIQUE');
    page.on('request', onRequest);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    page.on('response', onResponse);
    await page.route('**/*', guardChange);
    attempted = true;
    await rows.nth(indexes[0]).click();
    const selectedId = await page.evaluate(({ id, key }) => {
      const selected = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getSelectionModel?.()?.getSelection?.() || [];
      return selected.length === 1 ? String(selected[0].data?.[key] ?? '').trim() : null;
    }, { id: previous.windowId, key: spec.id });
    if (selectedId !== nativeId || JSON.stringify((await readGrid(page, previous.windowId)).records) !== previous.grid) {
      throw new Error('LOOKUP_SELECTION_CHANGED');
    }
    await assertExpectedDialogs(page, nativeDialog);
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ }).first().click();
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await assertExpectedDialogs(page, nativeDialog);
      if (requestFailed) throw new Error('LOOKUP_CHANGE_REQUEST_FAILED');
      if (!await win.isVisible()) {
        await assertNewGuestStay(page);
        const value = await page.locator(`input[name="${spec.field}"]:visible`).first().inputValue();
        const fields = await readForm(page);
        observed = { selectedField: { label: spec.label, name: spec.field, value },
          form: { fields, changedFields: changedFields(before, fields) } };
        const snapshot = JSON.stringify(fields);
        if (snapshot !== lastSnapshot || inFlight.size) stableSince = Date.now();
        else if (requestIdVerified && changeResponseVerified && !pendingChangeResponses && Date.now() - stableSince >= 500 &&
            value.trim().toLocaleLowerCase() === candidates[0].name.toLocaleLowerCase()) {
          if (arDraft && arRequestBound && arResponseIdentity &&
              await arRecordMatches(page, { record: arDraft.record, ...arResponseIdentity }) &&
              !nativeDialog && !requestFailed && !inFlight.size) {
            verifiedArSelections.set(page, { record: arDraft.record, ...arResponseIdentity, token: randomUUID() });
            arDraft = null;
          }
          if (nativeDialog || requestFailed || inFlight.size) throw new Error('LOOKUP_SELECTION_NOT_CONFIRMED');
          lastSearch.delete(page);
          return {
            outcome: 'selected_unsaved', nativeId, searchId: previous.searchId,
            nativeIdEvidence: 'form_change_response',
            ...(kind === 'agency' ? { agencyIataNumber: candidates[0].referenceNumber } : {}),
            ...observed,
            ...(kind === 'agency' ? { displayedAgency: value } : kind === 'organization'
              ? { displayedOrganization: value } : { displayedArAccount: value, nativeReadback }),
          };
        }
        lastSnapshot = snapshot;
      }
      await page.waitForTimeout(200);
    }
    throw new Error('LOOKUP_SELECTION_NOT_CONFIRMED');
  } catch (error) {
    if (attempted) fence?.quarantine();
    if (attempted) lastSearch.delete(page);
    return { outcome: attempted ? 'selection_uncertain' : 'execution_failure', nativeId,
      issue: issue(error, 'LOOKUP_SELECTION_FAILED'), ...(observed ? { observed } : {}) };
  } finally {
    scope?.close();
    await page.unroute('**/*', guardChange).catch(() => {});
    await arDraft?.record.dispose().catch(() => {});
    page.off('dialog', onDialog);
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
    busyPages.delete(page);
  }
}

export const searchBookingAgencies = (page, query, options) => search(page, 'agency', query, options);
export const searchOrganizations = (page, query, options) => search(page, 'organization', query, options);
export const searchArAccounts = (page, query, options) => search(page, 'arAccount', query, options);
export const searchPrimaryBookingAgency = searchBookingAgencies;
export const searchOrganization = searchOrganizations;
export const searchArAccount = searchArAccounts;

/** Close the current party picker without choosing a candidate or changing the draft. */
export async function closeGuestStayPartyPicker(page, { propertyCode } = {}) {
  if (!page || typeof page.locator !== 'function' || typeof page.route !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (typeof propertyCode !== 'string' || !/^[A-Z0-9]+$/.test(propertyCode)) {
    return { outcome: 'input_gap', issue: 'PROPERTY_CODE_REQUIRED' };
  }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'lookup_in_progress' };
  busyPages.add(page);
  let attempted = false, nativeDialog = false, blocked = false;
  const onDialog = () => { nativeDialog = true; };
  const guard = async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        !/save|delete|cancel|duplicate|checkin|checkout|send|crs/i.test(pathname)) return route.fallback();
    blocked = true;
    return route.abort();
  };
  const checkDraft = async () => {
    const targetMatches = await page.evaluate((expected) => {
      const visible = (el) => Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const fields = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
      const confirmation = fields('confirmationnumber');
      const property = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
      return location.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com' && property === expected &&
        confirmation.length === 1 && !confirmation[0].value.trim() && fields('ta1').length === 1;
    }, propertyCode);
    if (!targetMatches) throw new Error('PROPERTY_OR_BLANK_STAY_MISMATCH');
  };
  page.on('dialog', onDialog);
  try {
    await checkDraft();
    await assertExpectedDialogs(page, nativeDialog);
    await assertNewGuestStay(page);
    if (await page.locator('.x-window[id^="childagespopup"]:visible').count()) throw new Error('UNEXPECTED_DIALOG');
    const windows = page.locator('.x-window:visible:not(.x-menu)');
    if (!await windows.count()) { lastSearch.delete(page); return { outcome: 'not_open' }; }
    if (await windows.count() !== 1) throw new Error('UNEXPECTED_DIALOG');
    const win = windows.first();
    const titles = await win.locator('.x-window-header-text:visible').allTextContents();
    const kind = Object.keys(LOOKUPS).find((key) => titles.length === 1 && titles[0].trim() === LOOKUPS[key].title);
    const windowId = await win.getAttribute('id'), previous = lastSearch.get(page);
    if (!kind || !windowId || (previous && (previous.kind !== kind || previous.windowId !== windowId)) ||
        !await win.evaluate((el) => Boolean(Ext.getCmp(el.id)?.query('grid,readonlygrid')?.[0]?.getStore?.()))) {
      throw new Error('PARTY_PICKER_UNAVAILABLE');
    }
    const before = await readForm(page);
    const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
    if (await cancel.count() !== 1) throw new Error('PARTY_CANCEL_NOT_UNIQUE');
    await page.route('**/*', guard);
    attempted = true;
    await cancel.click({ timeout: 5000 });
    await page.waitForFunction((id) => !Ext.getCmp(id)?.isVisible(), windowId, { timeout: 10000 });
    await win.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
    await assertExpectedDialogs(page, nativeDialog);
    await checkDraft();
    await assertNewGuestStay(page);
    const after = await readForm(page);
    if (blocked || await windows.count() || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('PARTY_CANCEL_UNVERIFIED');
    }
    lastSearch.delete(page);
    return { outcome: 'closed_unsaved', kind, draftUnchanged: true };
  } catch (error) {
    if (attempted) lastSearch.delete(page);
    return { outcome: attempted ? 'close_uncertain' : 'execution_failure',
      issue: nativeDialog ? 'UNEXPECTED_DIALOG' : issue(error, 'PARTY_CLOSE_FAILED') };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    busyPages.delete(page);
  }
}

// Legacy callers may still pass only an ID; field-named selection requires the search ID too.
export const selectBookingAgency = (page, selection, options = {}) =>
  select(page, 'agency', selection, options, false);
export const selectPrimaryBookingAgency = (page, selection, options) => select(page, 'agency', selection, options);
export const selectOrganization = (page, selection, options) => select(page, 'organization', selection, options);
export const selectArAccount = (page, selection, options) => select(page, 'arAccount', selection, options);
