import { readGuestStayForm } from './guest-stay-form.mjs';
import { parseResponse as parsePickerResponse } from './guest-stay-room-rate.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';

function fieldValues(fields) {
  return fields.map(({ name, type, value }) => JSON.stringify([name, type, value])).sort();
}

/** Read the native Track / Sub Segment picker without selecting a row or saving. */
export async function listTrackSubSegments(page, { propertyCode } = {}) {
  if (!page || propertyCode !== 'HRCEN') return { outcome: 'input_gap', issue: 'TRACK_PROPERTY_REQUIRED' };
  const before = await readGuestStayForm(page, { propertyCode });
  if (before.outcome !== 'ok' || new URL(page.url()).origin !== ORIGIN) return { outcome: 'execution_failure', issue: 'TRACK_FORM_UNAVAILABLE' };
  let gridName = null, blocked = false, nativeDialog = false, opened = false, changedFieldNames = [];
  const onDialog = () => { nativeDialog = true; };
  const guard = async route => {
    const request = route.request(), target = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const popup = request.method() === 'POST' && target.origin === ORIGIN && target.pathname === '/web/base/LOVPOP' &&
      body.get('LOV_TAGNAME') === 'track' && body.get('GRID_NAME') === 'LVTRACKCODE' && !target.search && !target.hash;
    const pageRead = request.method() === 'POST' && target.origin === ORIGIN && target.pathname === '/web/base/GETCACHE' &&
      gridName && body.get('GRID_NAME') === gridName && !target.search && !target.hash;
    if (popup) gridName = body.get('GRID_NAME');
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
        body.get('LOV_TAGNAME') === 'track' && body.get('GRID_NAME') === 'LVTRACKCODE';
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
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('TRACK_PICKER_UNVERIFIED');
    const ready = await page.waitForFunction(id => {
      const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
      const store = grids.length === 1 ? grids[0].getStore?.() : null;
      return Boolean(store && typeof store.isLoading === 'function' && !store.isLoading() && store.getCount() > 0);
    }, windowId, { timeout: 20000 });
    await ready.dispose();
    let nativeGrid = null;
    try {
      let timer;
      const text = await Promise.race([reply.text(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TRACK_RESPONSE_TIMEOUT')), 10000);
      })]).finally(() => clearTimeout(timer));
      const grid = parsePickerResponse(text)?.grid?.GRIDRESULT?.GRID;
      if (Array.isArray(grid?.DATA) && grid.METADATA?.GRIDNAME === 'LVTRACKCODE' &&
          grid.DATA.every(row => Object.hasOwn(row, 'trackcode') && Object.hasOwn(row, 'tcddesc'))) nativeGrid = grid;
    } catch { /* Coverage remains unknown without a verified native response. */ }
    let footer = null;
    if (await win.count() === 1) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        footer = await win.evaluate(el => {
          const match = el.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
          return match ? { loaded: Number(match[1]), total: Number(match[2]) } : null;
        });
        if (!footer || footer.loaded >= footer.total || !gridName) break;
        const response = page.waitForResponse(res => {
          const request = res.request(), body = new URLSearchParams(request.postData() || '');
          return request.method() === 'POST' && new URL(request.url()).pathname === '/web/base/GETCACHE' && body.get('GRID_NAME') === gridName;
        }, { timeout: 8000 }).catch(() => null);
        await win.locator('.x-grid-view:visible').last().evaluate(el => { el.scrollTop = el.scrollHeight; });
        const next = await response;
        if (!next) break;
        if (!next.ok() || blocked || nativeDialog) throw new Error('TRACK_PAGE_UNVERIFIED');
        await page.waitForTimeout(200);
      }
    }
    const candidates = await win.evaluate(element => {
      const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
      if (grids.length !== 1) return null;
      const grid = grids[0], store = grid.getStore?.(), view = grid.getView?.();
      if (!store || store.isLoading?.() || !view?.getRecord) return null;
      const rows = [...element.querySelectorAll('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row')];
      return rows.flatMap(row => {
        const data = view.getRecord(row)?.data;
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
    const correlated = nativeGrid && JSON.stringify(nativeGrid.DATA.map(key).sort()) === JSON.stringify(candidates.map(key).sort());
    const marker = String(nativeGrid?.METADATA?.MORERECORDPRESENT ?? '').trim();
    const total = /^\d+$/.test(String(nativeGrid?.METADATA?.RECORDS)) ? Number(nativeGrid.METADATA.RECORDS) : null;
    const complete = correlated && marker === '-' && total === candidates.length ? true
      : marker === '+' || (total != null && total > candidates.length) ? false : null;
    if (!await closePicker()) throw new Error('TRACK_CANCEL_UNAVAILABLE');
    await page.unroute('**/*', guard);
    const after = await readGuestStayForm(page, { propertyCode });
    if (after.outcome !== 'ok' || JSON.stringify(fieldValues(after.fields)) !== JSON.stringify(fieldValues(before.fields)) || blocked || nativeDialog) {
      if (after.outcome === 'ok') {
        const names = new Set([...before.fields, ...after.fields].map(field => field.name).filter(Boolean));
        changedFieldNames = [...names].filter(name => JSON.stringify(fieldValues(before.fields.filter(field => field.name === name))) !==
          JSON.stringify(fieldValues(after.fields.filter(field => field.name === name))));
      }
      throw new Error('TRACK_FORM_CHANGED');
    }
    return { outcome: 'ok', observedAt: new Date().toISOString(), criteria: { propertyCode, scope: 'unfiltered' },
      coverage: { loaded: candidates.length, total: total != null && total >= candidates.length ? total
        : footer && footer.total >= candidates.length ? footer.total : null,
        complete, possiblyTruncated: complete !== true, nativeResponseCorrelated: Boolean(correlated) }, candidates };
  } catch (error) {
    const cleanup = await closePicker().catch(() => false);
    return { outcome: 'execution_failure', issue: /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'TRACK_READ_FAILED',
      ...(changedFieldNames.length ? { changedFieldNames } : {}), ...(cleanup ? {} : { cleanupRequired: true }), candidates: [] };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
  }
}
