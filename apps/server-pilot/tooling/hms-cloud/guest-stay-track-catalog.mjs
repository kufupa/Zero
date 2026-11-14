import { readGuestStayForm } from './guest-stay-form.mjs';
import { parseResponse as parsePickerResponse } from './guest-stay-room-rate.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';

function fieldValues(fields) {
  return fields.map(({ name, type, value }) => JSON.stringify([name, type, value])).sort();
}

function trackPageRequest(request, metadata) {
  const target = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
  return request.method() === 'POST' && target.origin === ORIGIN && target.pathname === '/web/base/GETCACHE' &&
    !target.search && !target.hash && body.getAll('GRID_NAME').length === 1 && body.get('GRID_NAME') === 'LVTRACKCODE' &&
    Object.entries({ GRID_ID: 'GRIDID', DATASPY_ID: 'DATASPYID' }).every(([name, key]) => !body.has(name) ||
      (body.getAll(name).length === 1 && body.get(name) === String(metadata?.[key] ?? '')));
}

async function responseGrid(response) {
  let timer;
  const text = await Promise.race([response.text(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TRACK_RESPONSE_TIMEOUT')), 10000);
  })]).finally(() => clearTimeout(timer));
  const grid = parsePickerResponse(text)?.grid?.GRIDRESULT?.GRID;
  if (!Array.isArray(grid?.DATA) || grid.METADATA?.GRIDNAME !== 'LVTRACKCODE' ||
      grid.DATA.some(row => !Object.hasOwn(row, 'trackcode') || !Object.hasOwn(row, 'tcddesc'))) {
    throw new Error('TRACK_RESPONSE_INVALID');
  }
  return grid;
}

/** Read the native Track / Sub Segment picker without selecting a row or saving. */
export async function listTrackSubSegments(page, { propertyCode, selectCode } = {}) {
  if (!page || !getPropertyRegistration(propertyCode)?.active ||
      (selectCode !== undefined && !/^[A-Z0-9]{1,12}$/.test(selectCode))) return { outcome: 'input_gap', issue: 'TRACK_PROPERTY_REQUIRED' };
  const before = await readGuestStayForm(page, { propertyCode });
  if (before.outcome !== 'ok' || new URL(page.url()).origin !== ORIGIN) return { outcome: 'execution_failure', issue: 'TRACK_FORM_UNAVAILABLE' };
  let gridName = null, pageMetadata = null, pageReadArmed = false, blocked = false, nativeDialog = false, opened = false, changedFieldNames = [];
  const onDialog = dialog => { nativeDialog = true; void dialog.dismiss().catch(() => {}); };
  const guard = async route => {
    const request = route.request(), target = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const popup = request.method() === 'POST' && target.origin === ORIGIN && target.pathname === '/web/base/LOVPOP' &&
      body.get('LOV_TAGNAME') === 'track' && body.get('GRID_NAME') === 'LVTRACKCODE' && !target.search && !target.hash;
    const pageRead = pageReadArmed && pageMetadata && trackPageRequest(request, pageMetadata);
    if (popup) gridName = body.get('GRID_NAME');
    if (pageRead) pageReadArmed = false;
    if (popup || pageRead || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
    blocked = true;
    return route.abort();
  };
  page.on('dialog', onDialog);
  await page.route('**/*', guard);
  const closePicker = async () => {
    if (!opened || nativeDialog) return !opened;
    const win = page.locator('.x-window:visible:not(.x-menu)');
    const count = await win.count();
    if (count > 1) return false;
    if (count === 1) {
      const title = (await win.locator('.x-window-header-text:visible').allTextContents()).map(value => value.trim());
      if (title.length !== 1 || title[0] !== 'Track Code') return false;
      const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
      const close = win.locator('.x-tool-close:visible');
      if (await cancel.count() === 1) await cancel.click({ timeout: 5000 });
      else if (await close.count() === 1) await close.click({ timeout: 5000 });
      else return false;
      await win.waitFor({ state: 'hidden', timeout: 10000 });
    } else {
      await page.keyboard.press('Escape');
      if (await page.locator('.x-boundlist:visible').count()) return false;
    }
    opened = false;
    return true;
  };
  try {
    if (await page.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('TRACK_WINDOW_NOT_CLEAR');
    const input = page.locator('input[name="track"]:visible');
    if (await input.count() !== 1) throw new Error('TRACK_FIELD_UNAVAILABLE');
    const trigger = input.locator('xpath=ancestor::*[contains(@class,"x-form-item") or contains(@class,"x-field")][1]')
      .locator('.x-form-lov-trigger:visible, .x-form-search-trigger:visible, .x-form-trigger:visible').first();
    if (!await trigger.count()) throw new Error('TRACK_TRIGGER_UNAVAILABLE');
    const response = page.waitForResponse(res => {
      const request = res.request(), target = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
      return request.method() === 'POST' && target.origin === ORIGIN && target.pathname === '/web/base/LOVPOP' &&
        !target.search && !target.hash && body.get('LOV_TAGNAME') === 'track' && body.get('GRID_NAME') === 'LVTRACKCODE';
    }, { timeout: 10000 }).catch(() => null);
    opened = true;
    await trigger.click({ timeout: 10000 });
    const reply = await response;
    if (!reply?.ok()) throw new Error('TRACK_LOOKUP_UNVERIFIED');
    const win = page.locator('.x-window:visible:not(.x-menu)').filter({
      has: page.locator('.x-window-header-text').filter({ hasText: /^Track Code$/ }),
    });
    await win.first().waitFor({ timeout: 10000 });
    if (await win.count() !== 1 || await page.locator('.x-window:visible:not(.x-menu)').count() !== 1 || nativeDialog || blocked) {
      throw new Error('TRACK_PICKER_UNVERIFIED');
    }
    const requestParams = new URLSearchParams(reply.request().postData() || '');
    const requestFiltered = [...requestParams].some(([key, value]) =>
      /^(?:MADDON_FILTER_VALUE_\d+|filtervalue|selfiltervaluectrl)$/i.test(key) && value.trim());
    const pickerFiltered = await win.evaluate(element => [...element.querySelectorAll('input')].some(input =>
      (input.name === 'selfiltervaluectrl' || input.name.startsWith('ff_')) && input.value.trim()));
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('TRACK_PICKER_UNVERIFIED');
    const ready = await page.waitForFunction(id => {
      const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
      const store = grids.length === 1 ? grids[0].getStore?.() : null;
      return Boolean(store && typeof store.isLoading === 'function' && !store.isLoading() && store.getCount() > 0);
    }, windowId, { timeout: 20000 });
    await ready.dispose();
    let nativeGrid = null;
    try { nativeGrid = await responseGrid(reply); }
    catch { /* Coverage remains unknown without a verified native response. */ }
    const firstMetadata = nativeGrid?.METADATA;
    const nativeRows = nativeGrid ? [...nativeGrid.DATA] : null;
    pageMetadata = firstMetadata;
    let footer = null;
    if (await win.count() === 1) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        footer = await win.evaluate(el => {
          const match = el.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
          return match ? { loaded: Number(match[1]), total: Number(match[2]) } : null;
        });
        const more = nativeGrid?.METADATA?.MORERECORDPRESENT === '+' || (footer && footer.loaded < footer.total);
        if (!more || !gridName || !firstMetadata ||
            !/^\d+$/.test(String(firstMetadata.GRIDID ?? '')) || !/^\d+$/.test(String(firstMetadata.DATASPYID ?? ''))) break;
        const response = page.waitForResponse(res => {
          return trackPageRequest(res.request(), firstMetadata);
        }, { timeout: 8000 }).catch(() => null);
        pageReadArmed = true;
        await win.locator('.x-grid-view:visible').last().evaluate(el => { el.scrollTop = el.scrollHeight; });
        const next = await response;
        pageReadArmed = false;
        if (!next) break;
        if (!next.ok() || blocked || nativeDialog) throw new Error('TRACK_PAGE_UNVERIFIED');
        const pageGrid = await responseGrid(next);
        if (!pageGrid.DATA.length || ['GRIDID', 'GRIDNAME', 'DATASPYID', 'RECORDS'].some(name =>
          String(pageGrid.METADATA[name] ?? '') !== String(firstMetadata[name] ?? ''))) throw new Error('TRACK_PAGE_UNVERIFIED');
        nativeRows.push(...pageGrid.DATA);
        nativeGrid = pageGrid;
        const pageReady = await page.waitForFunction(({ id, expected }) => {
          const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
          const records = grids.length === 1 ? grids[0].getStore?.()?.getRange?.().map(record => record.data) : null;
          const key = row => JSON.stringify([String(row.trackcode ?? '').trim(), String(row.tcddesc ?? '').trim()]);
          return records && JSON.stringify(records.map(key).sort()) === JSON.stringify(expected.map(key).sort());
        }, { id: windowId, expected: nativeRows }, { timeout: 10000 });
        await pageReady.dispose();
      }
      footer = await win.evaluate(el => {
        const match = el.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
        return match ? { loaded: Number(match[1]), total: Number(match[2]) } : null;
      });
    }
    const candidates = await win.evaluate(element => {
      const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
      if (grids.length !== 1) return null;
      const store = grids[0].getStore?.();
      if (!store || store.isLoading?.() || !store.getRange) return null;
      return store.getRange().flatMap(row => {
        const data = row.data;
        const code = typeof data?.trackcode === 'string' ? data.trackcode.trim() : '';
        const description = typeof data?.tcddesc === 'string' ? data.tcddesc.trim() : '';
        return /^[A-Z0-9]{1,12}$/.test(code) && description && description.length <= 200 && !/[\p{Cc}]/u.test(description)
          ? [{ code, description }] : [];
      });
    });
    if (!Array.isArray(candidates) || !candidates.length || new Set(candidates.map(row => row.code)).size !== candidates.length) {
      throw new Error('TRACK_ROWS_UNVERIFIED');
    }
    const key = row => JSON.stringify([String(row.trackcode ?? row.code ?? '').trim(), String(row.tcddesc ?? row.description ?? '').trim()]);
    const correlated = nativeRows && JSON.stringify(nativeRows.map(key).sort()) === JSON.stringify(candidates.map(key).sort());
    const marker = String(nativeGrid?.METADATA?.MORERECORDPRESENT ?? '').trim();
    const total = /^\d+$/.test(String(nativeGrid?.METADATA?.RECORDS)) ? Number(nativeGrid.METADATA.RECORDS) : null;
    const footerMatches = !footer || (footer.loaded === candidates.length && footer.total === total);
    const complete = !requestFiltered && !pickerFiltered && correlated && footerMatches && marker === '-' && total === candidates.length ? true
      : marker === '+' || (total != null && total > candidates.length) ? false : null;
    let selected;
    if (selectCode !== undefined) {
      const matches = candidates.filter(candidate => candidate.code === selectCode);
      if (complete !== true || !correlated || matches.length !== 1) throw new Error('TRACK_CHOICE_UNAVAILABLE');
      selected = matches[0];
      const rows = win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row');
      const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((el, index) => {
        const grid = (globalThis.Ext?.ComponentQuery?.query('grid,readonlygrid') || []).find(item => item.getEl?.()?.dom?.contains(el));
        const data = grid?.getView?.()?.getRecord?.(el)?.data;
        return data?.trackcode === wanted.code && data?.tcddesc === wanted.description ? [index] : [];
      }), selected);
      if (indexes.length !== 1) throw new Error('TRACK_CHOICE_UNAVAILABLE');
      await rows.nth(indexes[0]).click();
      const nativeSelection = await win.evaluate(element => {
        const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
        return grids.length === 1 ? grids[0].getSelectionModel?.()?.getSelection?.().map(row => row.data) : null;
      });
      const ok = win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
      if (nativeSelection?.length !== 1 || nativeSelection[0].trackcode !== selected.code ||
          nativeSelection[0].tcddesc !== selected.description || await ok.count() !== 1) throw new Error('TRACK_SELECTION_UNVERIFIED');
      await ok.click();
      await win.waitFor({ state: 'hidden', timeout: 10000 });
      opened = false;
      const valid = await input.evaluate((element, display) => {
        const cmp = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
        return element.value === display && cmp?.getValue?.() === display && cmp?.getSubmitData?.()?.track === display &&
          !element.disabled && !element.readOnly && typeof cmp?.isValid === 'function' && cmp.isValid() === true;
      }, selected.description);
      if (!valid) throw new Error('TRACK_SELECTION_UNVERIFIED');
    } else if (!await closePicker()) throw new Error('TRACK_CANCEL_UNAVAILABLE');
    await page.unroute('**/*', guard);
    const after = await readGuestStayForm(page, { propertyCode });
    const preserved = field => selectCode === undefined || /^(?:guestid|firstname|lastname|arrivaldate|departuredate|roomtype|rateplan|adults|children|child\d+|childages|guaranteetype|reservationnote|guestoptin4)$/i.test(field.name || '');
    if (after.outcome !== 'ok' || JSON.stringify(fieldValues(after.fields.filter(preserved))) !==
        JSON.stringify(fieldValues(before.fields.filter(preserved))) || blocked || nativeDialog) {
      if (after.outcome === 'ok') {
        const names = new Set([...before.fields, ...after.fields].map(field => field.name).filter(Boolean));
        changedFieldNames = [...names].filter(name => JSON.stringify(fieldValues(before.fields.filter(field => field.name === name))) !==
          JSON.stringify(fieldValues(after.fields.filter(field => field.name === name))));
      }
      throw new Error('TRACK_FORM_CHANGED');
    }
    return { outcome: 'ok', observedAt: new Date().toISOString(),
      criteria: { propertyCode, scope: requestFiltered || pickerFiltered ? 'filtered_or_unknown' : 'unfiltered' },
      coverage: { loaded: candidates.length, total: total != null && total >= candidates.length ? total
        : footer && footer.total >= candidates.length ? footer.total : null,
        complete, possiblyTruncated: complete !== true, nativeResponseCorrelated: Boolean(correlated) }, candidates,
      ...(selected ? { selected } : {}) };
  } catch (error) {
    const cleanup = await closePicker().catch(() => false);
    return { outcome: 'execution_failure', issue: /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'TRACK_READ_FAILED',
      ...(changedFieldNames.length ? { changedFieldNames } : {}), ...(cleanup ? {} : { cleanupRequired: true }), candidates: [] };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
  }
}
