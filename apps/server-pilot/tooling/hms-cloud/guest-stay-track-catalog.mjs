import { parseTrackLookupText } from '../playwright-quote/create-request.mjs';
import { readGuestStayForm } from './guest-stay-form.mjs';

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
      body.get('LOV_TAGNAME') === 'track' && !target.search && !target.hash;
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
      const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
      if (await cancel.count() !== 1) return false;
      await cancel.click({ timeout: 5000 });
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
    opened = true;
    await trigger.click({ timeout: 10000 });
    const rows = page.locator('.x-boundlist:visible .x-boundlist-item:visible, .x-window:visible .x-grid-row:visible, .x-window:visible .x-grid-data-row:visible');
    await rows.first().waitFor({ timeout: 10000 });
    const win = page.locator('.x-window:visible:not(.x-menu)');
    if (await win.count() > 1 || nativeDialog || blocked) throw new Error('TRACK_PICKER_UNVERIFIED');
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
    const texts = await rows.allTextContents();
    const candidates = texts.map(text => parseTrackLookupText(text)).filter(Boolean);
    const complete = footer && footer.loaded === footer.total && candidates.length === footer.total ? true
      : footer && footer.loaded < footer.total ? false : null;
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
      coverage: { loaded: candidates.length, total: footer?.total ?? null, complete, possiblyTruncated: complete !== true }, candidates };
  } catch (error) {
    const cleanup = await closePicker().catch(() => false);
    return { outcome: 'execution_failure', issue: /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'TRACK_READ_FAILED',
      ...(changedFieldNames.length ? { changedFieldNames } : {}), ...(cleanup ? {} : { cleanupRequired: true }), candidates: [] };
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
  }
}
