// Read the displayed Folio grid on an already-open stay; never change a folio.
import { randomUUID } from 'node:crypto';
import { openStay360RecordTab } from './stay360-record-tabs.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from './stay360-notes.mjs';
import { shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';

// The observed Cloud Folio grid uses a data-only response, not Ext store load().
// Parse its JSON-shaped wrapper as data, never execute server-supplied JavaScript.
async function matchesEmptyGridResponse(response, frame, confirmation) {
  const request = response.request();
  try {
    if (!response.ok() || request.frame() !== frame || request.method() !== 'POST' ||
        new URL(request.url()).pathname !== '/web/base/OSRESV.FOL.xmlhttp') return false;
    const fields = new URLSearchParams(request.postData() ?? '');
    const single = (name) => fields.getAll(name).length === 1 ? fields.get(name) : null;
    if (single('SYSTEM_FUNCTION_NAME') !== 'OSRESV' || single('CURRENT_TAB_NAME') !== 'FOL' ||
        single('GRID_NAME') !== 'OSFOLO' || single('COMPONENT_INFO_TYPE') !== 'DATA_ONLY' ||
        single('confirmationnumber') !== confirmation.trim() || !single('GRID_ID') || !single('DATASPY_ID')) return false;
    const text = await response.text();
    const data = JSON.parse(text.replace(/^(\s*\{\s*)pageData\s*:/, '$1"pageData":'))?.pageData;
    const result = data?.grid?.GRIDRESULT, grid = result?.GRID, meta = grid?.METADATA;
    return data?.fromCome === true && data?.messages === null && result?.type === 'LIST.DATA_ONLY.STORED' &&
      meta?.REQUEST_TYPE_META === 'LIST.DATA_ONLY.STORED' && meta.GRIDID === single('GRID_ID') &&
      meta.GRIDNAME === single('GRID_NAME') && meta.DATASPYID === single('DATASPY_ID') &&
      result.DATASPY?.id === single('DATASPY_ID') && String(meta.RECORDS) === '0' &&
      Array.isArray(grid.DATA) && grid.DATA.length === 0;
  } catch { return false; }
}

/** Returns only the current rendered page and displayed summary, not a ledger. */
export async function readFolioFromStay360(page, confirmation, { timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('INVALID_FOLIO_TIMEOUT');
  const { frame, notes } = await openStay360RecordTab(page, confirmation, 'Folio');
  const grids = frame.locator('.x-grid:visible').filter({
    has: frame.locator('.x-column-header-text:visible').filter({ hasText: /^Transaction$/ }),
  });
  try {
    await grids.first().waitFor({ state: 'visible', timeout: 25000 });
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return { status: 'not_loaded', reason: 'GRID_NOT_VISIBLE', columns: [], rows: [],
      paging: null, filters: null, summary: null, coverage: { complete: null, refreshVerified: false }, notes };
  }
  if (await grids.count() !== 1) throw new Error('FOLIO_GRID_NOT_UNIQUE');
  // A tab may appear before its initial asynchronous refresh has begun.
  await page.waitForTimeout(1200);
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  const run = grids.locator('a.x-btn:visible').filter({ hasText: /^Run$/ });
  if (await run.count() !== 1 || !(await run.isEnabled())) throw new Error('FOLIO_RUN_NOT_AVAILABLE');
  const key = `__navaFolio_${randomUUID().replaceAll('-', '')}`;
  const button = await run.elementHandle();
  const installed = await frame.evaluate(({ key, button }) => {
    const shown = (el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown).filter((grid) =>
      [...grid.querySelectorAll('.x-column-header-text')].some((h) => shown(h) && h.innerText.trim() === 'Transaction'));
    if (grids.length !== 1) return false;
    const store = globalThis.Ext?.getCmp?.(grids[0].id)?.getStore?.();
    if (!store || typeof store.on !== 'function' || typeof store.un !== 'function' ||
        typeof store.isLoading !== 'function' || store.isLoading()) return false;
    if (!button || !grids[0].contains(button)) return false;
    const candidateView = globalThis.Ext?.getCmp?.(grids[0].id)?.getView?.();
    const view = typeof candidateView?.on === 'function' && typeof candidateView?.un === 'function' ? candidateView : null;
    const state = { store, view, button, gridId: grids[0].id, clicked: false, clickedAt: null, beforeCount: 0, started: false, finished: false, success: null, changed: 0, refreshed: 0, renderedChange: 0 };
    state.click = () => { state.clicked = true; state.clickedAt = Date.now(); };
    state.before = () => { if (state.clicked) { state.started = true; state.beforeCount += 1; } };
    state.load = (_store, _records, success) => {
      if (state.started) { state.finished = true; state.success = success === true ? true : success === false ? false : null; }
    };
    state.change = () => { if (state.clicked) state.changed += 1; };
    state.refresh = () => { if (state.clicked && state.changed) state.refreshed += 1; };
    state.render = () => { if (state.clicked && state.changed) state.renderedChange = state.changed; };
    button.addEventListener('click', state.click, true);
    store.on('datachanged', state.change);
    store.on('refresh', state.refresh);
    store.on('beforeload', state.before);
    store.on('load', state.load);
    view?.on('refresh', state.render);
    globalThis[key] = state;
    return true;
  }, { key, button });
  if (!installed) {
    return { status: 'not_loaded', reason: 'STORE_UNAVAILABLE_OR_LOADING', columns: [], rows: [],
      paging: null, filters: null, summary: null, coverage: { complete: null, refreshVerified: false }, notes };
  }
  // The additional page fence limits the Run to Folio requests and falls through
  // to the shared context guard, which rejects write actions. Leave it installed
  // when the outcome is uncertain so a late request cannot escape the fence.
  const origin = new URL(frame.url()).origin;
  const folioPaths = new Set(['/web/base/OSRESV.FOL', '/web/base/OSRESV.FOL.xmlhttp']);
  let uncertain = true;
  let runIssued = false;
  const tracked = new Set(), pending = new Set(), wireChecks = [];
  const network = { requests: 0, failed: 0 };
  const onResponse = (response) => {
    const request = response.request();
    if (!tracked.has(request)) return;
    if (!response.ok()) network.failed += 1;
    if (new URL(request.url()).pathname === '/web/base/OSRESV.FOL.xmlhttp') {
      const startedAt = request.timing().startTime;
      wireChecks.push(matchesEmptyGridResponse(response, frame, confirmation).then((matches) => ({ matches, startedAt })));
    }
  };
  const onFinished = (request) => {
    if (tracked.has(request)) pending.delete(request);
  };
  const onFailure = (request) => {
    if (!tracked.has(request)) return;
    pending.delete(request);
    network.failed += 1;
  };
  const fence = async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { await route.abort(); return; }
    const method = request.method().toUpperCase();
    const folioPost = method === 'POST' && url.origin === origin && folioPaths.has(url.pathname);
    if (folioPost && runIssued && !shouldAbortReadOnlyRequest({ method, url: request.url(), postData: request.postData() })) {
      tracked.add(request); pending.add(request); network.requests += 1;
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method) || folioPost) await route.fallback();
    else await route.abort();
  };
  await page.route('**/*', fence);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailure);
  try {
    runIssued = true;
    await run.click();
    try {
      await frame.waitForFunction((key) => {
        const state = globalThis[key];
        return state?.finished === true || (state?.changed > 0 && state?.refreshed > 0);
      }, key, { timeout: timeoutMs });
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
    }
    // A store event can precede rendering. Observe this view's refresh for the
    // current data generation; legacy/unobserved paths retain their window.
    let viewReady = false;
    const renderDeadline = Date.now() + 1200;
    if (await frame.evaluate((key) => Boolean(globalThis[key]?.view), key)) {
      try {
        await frame.waitForFunction((key) => {
          const state = globalThis[key], grid = document.getElementById(state?.gridId);
          return state?.changed > 0 && state.renderedChange === state.changed &&
            !state.store.isLoading() && grid && globalThis.Ext?.getCmp?.(grid.id)?.getStore?.() === state.store &&
            globalThis.Ext?.getCmp?.(grid.id)?.getView?.() === state.view;
        }, key, { timeout: Math.min(timeoutMs, Math.max(1, renderDeadline - Date.now())) });
        viewReady = true;
      } catch (error) {
        if (error?.name !== 'TimeoutError') throw error;
      }
    }
    const remainingRenderWindow = Math.max(0, renderDeadline - Date.now());
    if (!viewReady && remainingRenderWindow) await page.waitForTimeout(remainingRenderWindow);
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));
    const headers = page.locator('h1.recordcode:visible');
    if (await headers.count() !== 1 || (await headers.innerText()).trim() !== confirmation.trim()) {
      throw new Error('CONFIRMATION_HEADER_MISMATCH');
    }
    // Requests completing during the grid snapshot cannot be correlated to it.
    const captureRequests = network.requests, capturePending = pending.size;
    const result = await frame.evaluate((key) => {
      const shown = (el) => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
      const state = globalThis[key];
      const grid = document.getElementById(state?.gridId);
      if (!state || !grid || !shown(grid) || globalThis.Ext?.getCmp?.(grid.id)?.getStore?.() !== state.store) {
        throw new Error('FOLIO_GRID_CHANGED');
      }
      const store = state.store;
      const columns = [...grid.querySelectorAll('.x-column-header-text')].filter(shown).map((h) => clean(h.innerText));
      const view = grid.querySelector('.x-grid-view');
      const inView = (row) => {
        if (!shown(row)) return false;
        if (!view) return true;
        const r = row.getBoundingClientRect(), v = view.getBoundingClientRect();
        return r.bottom > v.top && r.top < v.bottom;
      };
      const rows = [...grid.querySelectorAll('.x-grid-row')].filter(inView).map((row) =>
        [...row.querySelectorAll('.x-grid-cell')].filter((cell) => cell.closest('.x-grid-row') === row && shown(cell))
          .map((cell) => clean(cell.innerText)));
      const number = (v) => Number.isInteger(v) && v >= 0 ? v : null;
      const displayedRecordStatus = clean(grid.innerText).match(/Records:\s*[\d,]+\s+of\s+[\d,]+/i)?.[0] ?? null;
      const loaded = number(store.getCount?.());
      const total = number(store.getTotalCount?.());
      const currentPage = number(store.currentPage);
      const pageSize = number(store.getPageSize?.() ?? store.pageSize);
      const fields = [...grid.querySelectorAll('input,select,textarea')];
      const values = (name) => fields.filter((el) => el.name === name).map((el) => clean(el.value));
      let storeFilters = null;
      try {
        const collection = store.getFilters?.() ?? store.filters;
        if (Array.isArray(collection?.items)) storeFilters = collection.items.map((filter) => ({
          property: clean(filter.getProperty?.() ?? filter.property),
          value: clean(filter.getValue?.() ?? filter.value),
          disabled: filter.getDisabled?.() ?? filter.disabled ?? null,
        }));
      } catch { /* Unknown filters remain unknown. */ }
      const filters = {
        dataSpy: values('dataspylist'), field: values('filterfields'), value: values('selfiltervaluectrl'),
        columnInputs: fields.filter((el) => el.name?.startsWith('ff_')).map((el) => ({ name: el.name, value: clean(el.value) })),
        store: storeFilters, remoteFilter: typeof store.remoteFilter === 'boolean' ? store.remoteFilter : null,
        appliedScope: 'unknown',
      };
      filters.observedCriteriaPresent = filters.value.some(Boolean) || filters.columnInputs.some((item) => item.value) ||
        (storeFilters !== null && storeFilters.some((item) => item.disabled !== true));
      const summaryNames = [
        ['folioBalance', 'foliototal', 'foliototalcurr'],
        ['folioBalanceInGuestCurrency', 'guestcurrencyestimatetotal', 'guestestimatetotalcurr'],
        ['guestFolio1', 'guesttotal', 'guesttotalcurr'], ['guestFolio2', 'incidentaltotal', 'incidentaltotalcurr'],
        ['travelAgentCompanyFolio', 'folio4total', 'folio4totalcurr'], ['accountsReceivable', 'artotal', 'artotalcurr'],
        ['adjustment', 'folio5total', 'folio5totalcurr'], ['currencyExchange', 'folio7total', 'folio7totalcurr'],
        ['accounting', 'folio6total', 'folio6totalcurr'],
      ];
      const summary = Object.fromEntries(summaryNames.map(([name, amountName, currencyName]) => {
        const find = (field) => [...document.querySelectorAll('input')].filter((el) => el.name === field && shown(el));
        const amount = find(amountName), currency = find(currencyName);
        return [name, { value: amount.length === 1 ? clean(amount[0].value) : null,
          currency: currency.length === 1 ? clean(currency[0].value) : null }];
      }));
      const refreshVerified = Boolean(state.finished && state.success === true && state.beforeCount === 1 && !store.isLoading());
      const partial = loaded === null || total === null || currentPage === null || pageSize === null ||
        rows.length !== loaded || total !== loaded || currentPage !== 1 || rows.some((row) => row.length !== columns.length);
      const status = state.finished && state.success === false ? 'failed' : !refreshVerified ? 'not_loaded' :
        partial ? 'partial' : loaded === 0 ? 'loaded_empty' : 'loaded';
      return { status, reason: status === 'failed' ? 'STORE_LOAD_FAILED' :
        status === 'not_loaded' ? 'REFRESH_NOT_VERIFIED' : null,
        columns, rows, paging: { rendered: rows.length, loaded, total, currentPage, pageSize, displayedRecordStatus }, filters, summary,
        coverage: { complete: null, refreshVerified, responseRowCorrelation: 'not_verified',
          refreshSignals: { clickedAt: state.clickedAt, changed: state.changed, refreshed: state.refreshed, storeLoading: store.isLoading() } },
        captureScope: 'Rows intersecting the current grid viewport, including horizontally clipped rendered cells, and displayed Folio summary only; no complete ledger or cleared-funds claim.' };
    }, key);
    notes.push(...await takeHandledNotes(page));
    // Collect responses after the Notes/header/grid waits, then reject any that
    // arrive while the snapshot's checks are being awaited.
    const wire = await Promise.race([Promise.all(wireChecks), page.waitForTimeout(timeoutMs).then(() => null)]);
    const captureChanged = network.requests !== captureRequests || wire === null || wire.length !== wireChecks.length;
    result.coverage.folioRequests = { observed: network.requests, failed: network.failed, pending: pending.size };
    // This additional path is established only for an empty response. Nonempty
    // response-to-rendered-row mapping remains unverified and is never guessed.
    const signals = result.coverage.refreshSignals;
    const emptyWireRefresh = !captureChanged && !capturePending && result.status === 'not_loaded' && wire?.length === 1 && wire[0].matches === true && Number.isFinite(wire[0].startedAt) &&
      Number.isFinite(signals.clickedAt) && wire[0].startedAt >= signals.clickedAt && signals.changed === 1 && signals.refreshed === 1 && signals.storeLoading === false &&
      result.rows.length === 0 && result.paging.loaded === 0 && result.paging.total === 0;
    if (emptyWireRefresh) {
      result.coverage.refreshVerified = true;
      result.coverage.refreshMethod = 'matched_empty_folio_response_and_store_events';
      result.coverage.responseRowCorrelation = 'empty_response_and_empty_grid';
      result.status = result.paging.currentPage === 1 && result.paging.pageSize !== null ? 'loaded_empty' : 'partial';
      result.reason = null;
    }
    if (network.failed || capturePending || pending.size || captureChanged) {
      result.status = network.failed ? 'failed' : 'not_loaded';
      result.reason = network.failed ? 'FOLIO_REQUEST_FAILED' : capturePending || pending.size ?
        'FOLIO_REQUEST_PENDING' : 'FOLIO_RESPONSE_UNVERIFIED';
      result.coverage.refreshVerified = false;
    }
    uncertain = !result.coverage.refreshVerified;
    return { ...result, notes };
  } finally {
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailure);
    await frame.evaluate((key) => {
      const state = globalThis[key];
      if (!state) return;
      state.button.removeEventListener('click', state.click, true);
      state.store.un('datachanged', state.change);
      state.store.un('refresh', state.refresh);
      state.store.un('beforeload', state.before);
      state.store.un('load', state.load);
      state.view?.un('refresh', state.render);
      delete globalThis[key];
    }, key).catch(() => {});
    if (!uncertain) await page.unroute('**/*', fence);
  }
}
