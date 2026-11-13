import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { snapshotLabtestRecord } from './labtest-record.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';

/** Select the exact currently offered Track row on one fenced saved-stay draft. */
export async function stageSavedTrackForComposition(context, target) {
  if (!isLabtestAmendStageContext(context) || !context.isActive() || !context.rateStageGate ||
      !target || !/^[A-Z0-9]{1,12}$/.test(target.lookupCode || '') || typeof target.display !== 'string') {
    throw new Error('TRACK_INPUT_INVALID');
  }
  const { page, frame, rateStageGate: gate } = context, before = await snapshotLabtestRecord(frame);
  const input = frame.locator('input[name="track"]:visible');
  if (await input.count() !== 1 || !gate.armTrack(before, target)) throw new Error('TRACK_PREIMAGE_UNVERIFIED');
  const trigger = input.locator('xpath=ancestor::*[contains(@class,"x-form-item") or contains(@class,"x-field")][1]')
    .locator('.x-form-lov-trigger:visible,.x-form-search-trigger:visible,.x-form-trigger:visible').first();
  if (await trigger.count() !== 1) throw new Error('TRACK_TRIGGER_UNAVAILABLE');
  const popupResponse = page.waitForResponse(response => gate.isRequest('track_popup', response.request()),
    { timeout: Math.min(15000, context.remainingMs()) });
  await trigger.click();
  const popup = await popupResponse;
  const metadata = parseSavedStayNativeResponse(await popup.text())?.grid?.GRIDRESULT?.GRID?.METADATA;
  if (!popup.ok() || !gate.armTrackReset(metadata) || !context.isActive()) throw new Error('TRACK_PICKER_UNVERIFIED');
  const win = frame.locator('.x-window:visible:not(.x-menu)').filter({
    has: frame.locator('.x-window-header-text').filter({ hasText: /^Track Code$/ }),
  });
  await win.waitFor({ timeout: Math.min(10000, context.remainingMs()) });
  if (await win.count() !== 1) throw new Error('TRACK_PICKER_UNVERIFIED');
  const filter = win.locator('input[name="selfiltervaluectrl"]:visible');
  const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
  if (await filter.count() !== 1 || await run.count() !== 1) throw new Error('TRACK_PICKER_UNVERIFIED');
  const rowsResponse = page.waitForResponse(response => gate.isRequest('track_reset', response.request()),
    { timeout: Math.min(15000, context.remainingMs()) });
  await filter.fill('');
  await run.click();
  const response = await rowsResponse;
  if (!gate.verifyTrackRows(response.status(), await response.text()) || !context.isActive()) throw new Error('TRACK_CHOICE_UNAVAILABLE');
  const rows = win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row');
  const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((el, index) => {
    const grid = (globalThis.Ext?.ComponentQuery?.query('grid,readonlygrid') || []).find(item => item.getEl?.()?.dom?.contains(el));
    const data = grid?.getView?.()?.getRecord?.(el)?.data;
    return data?.trackcode === wanted.lookupCode && data?.tcddesc === wanted.display ? [index] : [];
  }), target);
  if (indexes.length !== 1) throw new Error('TRACK_CHOICE_UNAVAILABLE');
  await rows.nth(indexes[0]).click();
  const selected = await win.evaluate(element => {
    const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
    return grids.length === 1 ? grids[0].getSelectionModel?.()?.getSelection?.().map(row => row.data) : null;
  });
  const ok = win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (selected?.length !== 1 || selected[0].trackcode !== target.lookupCode ||
      selected[0].tcddesc !== target.display || await ok.count() !== 1) throw new Error('TRACK_SELECTION_UNVERIFIED');
  await ok.click();
  await win.waitFor({ state: 'hidden', timeout: Math.min(10000, context.remainingMs()) });
  const synced = await input.evaluate((element, display) => {
    const cmp = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(node =>
      (node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.x-window'));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = form?.getRecord?.();
    if (!form?.el?.dom?.contains(element) || cmp?.up?.('form') !== form || !record ||
        element.disabled || element.readOnly || element.value !== display || cmp?.getValue?.() !== display ||
        cmp?.getSubmitData?.()?.track !== display || typeof form.updateRecord !== 'function') return false;
    form.updateRecord(record);
    return record.data?.track === display;
  }, target.display);
  if (!synced || !context.isActive() || !gate.completeTrack()) throw new Error('TRACK_SELECTION_UNVERIFIED');
  return snapshotLabtestRecord(frame);
}

/** Read the complete Track picker for this verified saved stay without selecting a row. */
export async function listSavedTrackChoices(context) {
  if (!isLabtestAmendStageContext(context) || !context.isActive() || !context.rateStageGate) throw new Error('TRACK_INPUT_INVALID');
  const { page, frame, rateStageGate: gate } = context, before = await snapshotLabtestRecord(frame);
  const input = frame.locator('input[name="track"]:visible');
  if (await input.count() !== 1 || !gate.armTrackRead(before)) throw new Error('TRACK_PREIMAGE_UNVERIFIED');
  const trigger = input.locator('xpath=ancestor::*[contains(@class,"x-form-item") or contains(@class,"x-field")][1]')
    .locator('.x-form-lov-trigger:visible,.x-form-search-trigger:visible,.x-form-trigger:visible').first();
  if (await trigger.count() !== 1) throw new Error('TRACK_TRIGGER_UNAVAILABLE');
  const popupResponse = page.waitForResponse(response => gate.isRequest('track_popup', response.request()),
    { timeout: Math.min(15000, context.remainingMs()) });
  await trigger.click();
  const popup = await popupResponse;
  const metadata = parseSavedStayNativeResponse(await popup.text())?.grid?.GRIDRESULT?.GRID?.METADATA;
  if (!popup.ok() || !gate.armTrackReset(metadata) || !context.isActive()) throw new Error('TRACK_PICKER_UNVERIFIED');
  const win = frame.locator('.x-window:visible:not(.x-menu)').filter({
    has: frame.locator('.x-window-header-text').filter({ hasText: /^Track Code$/ }),
  });
  await win.waitFor({ timeout: Math.min(10000, context.remainingMs()) });
  const filter = win.locator('input[name="selfiltervaluectrl"]:visible');
  const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
  if (await win.count() !== 1 || await filter.count() !== 1 || await run.count() !== 1) throw new Error('TRACK_PICKER_UNVERIFIED');
  const rowsResponse = page.waitForResponse(response => gate.isRequest('track_reset', response.request()),
    { timeout: Math.min(15000, context.remainingMs()) });
  await filter.fill('');
  await run.click();
  const response = await rowsResponse;
  if (!gate.verifyTrackRows(response.status(), await response.text()) || !context.isActive()) throw new Error('TRACK_CHOICES_UNVERIFIED');
  const candidates = gate.trackChoices();
  const visibleRows = await win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row').evaluateAll(elements =>
    elements.map(el => {
      const grid = (globalThis.Ext?.ComponentQuery?.query('grid,readonlygrid') || []).find(item => item.getEl?.()?.dom?.contains(el));
      const data = grid?.getView?.()?.getRecord?.(el)?.data;
      return { code: data?.trackcode, label: data?.tcddesc };
    }));
  if (!Array.isArray(candidates) || JSON.stringify(visibleRows) !== JSON.stringify(candidates)) throw new Error('TRACK_CHOICES_UNVERIFIED');
  const close = win.locator('.x-tool-close:visible');
  if (await close.count() !== 1) throw new Error('TRACK_PICKER_CLOSE_UNVERIFIED');
  await close.click();
  await win.waitFor({ state: 'hidden', timeout: Math.min(10000, context.remainingMs()) });
  if (!context.isActive() || !gate.completeTrack()) throw new Error('TRACK_PICKER_CLOSE_UNVERIFIED');
  const after = await snapshotLabtestRecord(frame);
  const fields = ['propertycode', 'status', 'confirmationnumber', 'reservationstayid', 'reservationid', 'recordid',
    'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'track',
    'adults', 'children', 'reservationnote', 'guaranteetype', 'udfchkbox04', 'udfchar13'];
  if (!after?.data || fields.some(key => String(after.data[key] ?? '') !== String(before.data[key] ?? '')) ||
      after.values?.track !== before.values?.track) throw new Error('TRACK_PICKER_CHANGED_STAY');
  return { candidates, coverage: { loaded: candidates.length, total: candidates.length, complete: true,
    possiblyTruncated: false, nativeResponseCorrelated: true } };
}
