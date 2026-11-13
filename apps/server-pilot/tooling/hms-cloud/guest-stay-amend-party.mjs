import { isDeepStrictEqual } from 'node:util';
import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { snapshotLabtestRecord } from './labtest-record.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';
import { isSavedPartyStageRequestGate, savedPartyBeforeImage, savedPartySpec } from './saved-stay-party-request-gate.mjs';

const issue = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : 'PARTY_STAGE_UNVERIFIED';
const remaining = context => Math.max(1, Math.min(15_000, context.remainingMs()));
const active = context => {
  if (!isLabtestAmendStageContext(context) || !context.isActive() || context.remainingMs() <= 0 ||
      !isSavedPartyStageRequestGate(context.partyStageGate) || !context.partyStageGate.isActive()) {
    throw new Error('PARTY_STAGE_INACTIVE');
  }
};
const bodyWithin = async (context, response) => {
  let timer;
  try {
    return await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PARTY_RESPONSE_TIMEOUT')), remaining(context));
    })]);
  } finally { clearTimeout(timer); }
};

async function gridRows(win, spec, kind) {
  return win.evaluate((element, { spec, kind }) => {
    const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
    if (grids.length !== 1 || !grids[0].getStore?.()) throw new Error('PARTY_GRID_UNAVAILABLE');
    const read = (row, key) => {
      const keys = Object.keys(row).filter(name => name.toLowerCase() === key.toLowerCase());
      return keys.length === 1 && keys[0] === key ? String(row[key] ?? '') : null;
    };
    return grids[0].getStore().getRange().map(({ data }) => ({
      nativeId: read(data, spec.id), name: read(data, spec.name),
      ...(kind === 'arAccount' ? { profileId: read(data, 'profileid'), arProfileId: read(data, 'arprofileid'), accountNumber: read(data, 'araccountnumber') }
        : kind === 'bookingAgency' ? { referenceNumber: read(data, 'iatanumber') }
          : { corporateAccountNumber: read(data, 'corporateaccountnumber') }),
    }));
  }, { spec, kind });
}

async function picker(context, { kind, query }) {
  active(context);
  const { page, frame, partyStageGate: gate } = context, spec = savedPartySpec(kind);
  if (!spec || typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 200 ||
      /[\p{Cc}]/u.test(query)) throw new Error('PARTY_QUERY_INVALID');
  const before = await snapshotLabtestRecord(frame);
  active(context);
  if (!gate.armRead(before, { kind, query })) throw new Error('PARTY_PREIMAGE_UNVERIFIED');
  const input = frame.locator(`input[name="${spec.field}"]:visible`);
  if (await input.count() !== 1) throw new Error('PARTY_CONTROL_UNAVAILABLE');
  const belongsToStay = await input.evaluate((element, expected) => {
    const visible = node => (node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.x-window');
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
    const component = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    return Boolean(form?.el?.dom?.contains(element) && component?.up?.('form') === form &&
      typeof component.getValue === 'function' && String(component.getValue() ?? '') === expected && element.value === expected);
  }, String(before.values[spec.field] ?? ''));
  if (!belongsToStay) throw new Error('PARTY_CONTROL_UNVERIFIED');
  const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible');
  if (await trigger.count() !== 1) throw new Error('PARTY_TRIGGER_UNAVAILABLE');
  const popupWait = page.waitForResponse(response => gate.isRequest('popup', response.request()), { timeout: remaining(context) });
  void popupWait.catch(() => {});
  await trigger.click({ timeout: remaining(context) });
  const popup = await popupWait;
  const metadata = parseSavedStayNativeResponse(await bodyWithin(context, popup))?.grid?.GRIDRESULT?.GRID?.METADATA;
  active(context);
  if (!popup.ok() || !gate.armRows(metadata)) throw new Error('PARTY_PICKER_UNVERIFIED');
  const win = frame.locator('.x-window:visible:not(.x-menu)').filter({
    has: frame.locator('.x-window-header-text').filter({ hasText: new RegExp(`^${spec.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
  await win.waitFor({ state: 'visible', timeout: remaining(context) });
  if (await win.count() !== 1) throw new Error('PARTY_PICKER_UNVERIFIED');
  const filter = win.locator('input[name="filterfields"]:visible');
  const textFilter = win.locator('input[name="selfiltervaluectrl"]:visible');
  const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
  if (await filter.count() !== 1 || await textFilter.count() !== 1 || await run.count() !== 1 ||
      (await filter.inputValue()).trim() !== (kind === 'organization' ? 'Name' : kind === 'bookingAgency' ? 'Booking Agency Name' : 'A/R Account')) {
    throw new Error('PARTY_FILTER_UNVERIFIED');
  }
  await textFilter.fill(query);
  if (await textFilter.inputValue() !== query) throw new Error('PARTY_FILTER_UNVERIFIED');
  const rowsWait = page.waitForResponse(response => gate.isRequest('rows', response.request()), { timeout: remaining(context) });
  void rowsWait.catch(() => {});
  await run.click({ timeout: remaining(context) });
  const response = await rowsWait;
  const responseBody = await bodyWithin(context, response);
  active(context);
  if (!gate.verifyRows(response.status(), responseBody)) throw new Error('PARTY_CHOICES_UNVERIFIED');
  const result = gate.choices();
  if (!result) throw new Error('PARTY_CHOICES_UNVERIFIED');
  const winId = await win.getAttribute('id');
  const observed = await frame.waitForFunction(({ id, spec, kind, expected }) => {
    const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
    if (grids.length !== 1 || !grids[0].getStore?.()) return false;
    const read = (row, key) => {
      const keys = Object.keys(row).filter(name => name.toLowerCase() === key.toLowerCase());
      return keys.length === 1 && keys[0] === key ? String(row[key] ?? '') : null;
    };
    const rows = grids[0].getStore().getRange().map(({ data }) => ({
      nativeId: read(data, spec.id), name: read(data, spec.name),
      ...(kind === 'arAccount' ? { profileId: read(data, 'profileid'), arProfileId: read(data, 'arprofileid'), accountNumber: read(data, 'araccountnumber') }
        : kind === 'bookingAgency' ? { referenceNumber: read(data, 'iatanumber') }
          : { corporateAccountNumber: read(data, 'corporateaccountnumber') }),
    }));
    return JSON.stringify(rows) === JSON.stringify(expected);
  }, { id: winId, spec, kind, expected: result.candidates }, { timeout: remaining(context) });
  await observed.dispose();
  active(context);
  const filterName = kind === 'organization' ? 'Name' : kind === 'bookingAgency' ? 'Booking Agency Name' : 'A/R Account';
  if (!isDeepStrictEqual(await gridRows(win, spec, kind), result.candidates) ||
      await textFilter.inputValue() !== query || (await filter.inputValue()).trim() !== filterName) throw new Error('PARTY_CHOICES_CHANGED');
  return { result, before, win, spec, filter, textFilter, filterName };
}

async function closePicker(context, opened) {
  const cancel = opened.win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
  if (await cancel.count() !== 1) throw new Error('PARTY_PICKER_CLOSE_UNVERIFIED');
  await cancel.click({ timeout: remaining(context) });
  await opened.win.waitFor({ state: 'hidden', timeout: remaining(context) });
  active(context);
  const after = await snapshotLabtestRecord(context.frame);
  active(context);
  if (!isDeepStrictEqual(savedPartyBeforeImage(after), opened.result.beforeImage) ||
      !context.partyStageGate.finishRead()) throw new Error('PARTY_PICKER_CHANGED_STAY');
}

/** Search the current saved-stay picker without selecting a row or dispatching its callback. */
export async function inspectSavedPartyForComposition(context, input) {
  try {
    const opened = await picker(context, input ?? {});
    await closePicker(context, opened);
    const { result } = opened;
    return { outcome: result.candidates.length ? 'matches' : 'no_match', ...result,
      candidates: result.candidates.map(row => ({ ...row, kind: result.kind, query: result.query,
        sourceField: result.sourceField, row })) };
  } catch (error) {
    context?.stop?.(issue(error));
    throw new Error(issue(error));
  }
}

function changed(before, after, exempt) {
  const fields = [];
  for (const part of ['data', 'values']) for (const [name, old] of Object.entries(before?.[part] ?? {})) {
    if (!exempt.has(name) && !isDeepStrictEqual(old, after?.[part]?.[name])) fields.push(`${part}.${name}`);
  }
  return fields;
}

/** Requery one exact row on Go; a native callback can persist before the final Save. */
export async function applySavedPartyOnGo(context, input, authority = {}) {
  let attempted = false, beforeImage, afterImage, snapshot, changedFields;
  try {
    if (!input || !input.expected || !input.candidate || typeof authority.authorizeCandidate !== 'function' ||
        typeof authority.dispatchCandidate !== 'function') throw new Error('PARTY_GO_INPUT_INVALID');
    const opened = await picker(context, { kind: input.kind, query: input.candidate.query });
    const { result, before, win, spec, filter, textFilter, filterName } = opened, gate = context.partyStageGate;
    beforeImage = result.beforeImage;
    if (!isDeepStrictEqual(input.expected, result.beforeImage) || input.candidate.kind !== input.kind ||
        input.candidate.sourceField !== spec.field || !result.coverage.complete) throw new Error('PARTY_GO_PREIMAGE_CHANGED');
    const row = result.candidates.filter(item => item.nativeId === input.candidate.nativeId && item.name === input.candidate.name);
    if (row.length !== 1 || result.candidates.filter(item => item.nativeId === input.candidate.nativeId).length !== 1 ||
        !isDeepStrictEqual(row[0], input.candidate.row)) throw new Error('PARTY_CANDIDATE_STALE');
    const rows = win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row');
    const indexes = await rows.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
      const grid = (globalThis.Ext?.ComponentQuery?.query('grid,readonlygrid') || [])
        .find(item => item.getEl?.()?.dom?.contains(element));
      const data = grid?.getView?.()?.getRecord?.(element)?.data;
      return String(data?.[wanted.key] ?? '') === wanted.id ? [index] : [];
    }), { key: spec.id, id: row[0].nativeId });
    if (indexes.length !== 1) throw new Error('PARTY_CANDIDATE_NOT_UNIQUE');
    await rows.nth(indexes[0]).click({ timeout: remaining(context) });
    const selected = await win.evaluate(element => {
      const grids = globalThis.Ext?.getCmp?.(element.id)?.query?.('grid,readonlygrid') || [];
      return grids.length === 1 ? grids[0].getSelectionModel?.()?.getSelection?.().map(item => item.data) : null;
    });
    if (selected?.length !== 1 || String(selected[0][spec.id] ?? '') !== row[0].nativeId ||
        String(selected[0][spec.name] ?? '') !== row[0].name ||
        !isDeepStrictEqual(await gridRows(win, spec, input.kind), result.candidates) ||
        await textFilter.inputValue() !== input.candidate.query || (await filter.inputValue()).trim() !== filterName) {
      throw new Error('PARTY_SELECTION_UNVERIFIED');
    }
    const fresh = await snapshotLabtestRecord(context.frame);
    active(context);
    if (!gate.armCandidate(fresh, input.candidate, authority)) throw new Error('PARTY_GO_PREIMAGE_CHANGED');
    const ok = win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
    if (await ok.count() !== 1) throw new Error('PARTY_SELECT_CONTROL_UNAVAILABLE');
    const responseWait = context.page.waitForResponse(response => gate.isRequest('candidate', response.request()),
      { timeout: remaining(context) });
    void responseWait.catch(() => {});
    attempted = true;
    await ok.click({ timeout: remaining(context), noWaitAfter: true });
    const response = await responseWait;
    const payload = parseSavedStayNativeResponse(await bodyWithin(context, response));
    let drainTimer;
    const drained = await Promise.race([gate.drainCandidate(), new Promise((_, reject) => {
      drainTimer = setTimeout(() => reject(new Error('PARTY_CALLBACK_DRAIN_TIMEOUT')), remaining(context));
    })]).finally(() => clearTimeout(drainTimer));
    active(context);
    if (!drained) throw new Error('PARTY_CALLBACK_DRAIN_UNVERIFIED');
    const values = payload?.values;
    if (!response.ok() || !values || String(values[spec.link] ?? '') !== row[0].nativeId ||
        String(values.confirmationnumber ?? '') !== String(before.data.confirmationnumber) ||
        (input.kind === 'arAccount' && String(values.arprofileid ?? '') !== row[0].profileId)) {
      throw new Error('PARTY_CALLBACK_RESPONSE_UNVERIFIED');
    }
    await win.waitFor({ state: 'hidden', timeout: remaining(context) });
    await context.frame.waitForFunction(() => typeof globalThis.Ext?.Ajax?.isLoading === 'function' &&
      !globalThis.Ext.Ajax.isLoading() && ![...document.querySelectorAll('.x-mask,.x-mask-msg,.x-loadmask')].some(element =>
        (element.offsetWidth || element.offsetHeight) && getComputedStyle(element).visibility !== 'hidden'),
    null, { timeout: remaining(context) });
    active(context);
    snapshot = await snapshotLabtestRecord(context.frame);
    active(context);
    if (String(snapshot.data?.[spec.link] ?? '') !== row[0].nativeId ||
        String(snapshot.data?.[spec.display] ?? '') !== row[0].name ||
        String(snapshot.values?.[spec.display] ?? '') !== row[0].name ||
        (input.kind === 'arAccount' && String(snapshot.data?.arprofileid ?? '') !== row[0].profileId)) {
      throw new Error('PARTY_CALLBACK_READBACK_UNVERIFIED');
    }
    afterImage = savedPartyBeforeImage(snapshot);
    const exemption = new Set([spec.link, spec.display, ...(input.kind === 'arAccount' ? ['arprofileid'] : [])]);
    changedFields = changed(result.beforeImage, afterImage, exemption);
    if (changedFields.length) throw new Error('PARTY_CALLBACK_OTHER_FIELDS_CHANGED');
    if (!gate.finishCandidate()) throw new Error('PARTY_CALLBACK_STATE_UNVERIFIED');
    return { outcome: 'applied', snapshot, beforeImage: result.beforeImage, afterImage,
      partialEffect: 'possible', needsRecovery: true, pricing: 'recheck_required' };
  } catch (error) {
    context?.stop?.(issue(error));
    if (attempted) return { outcome: 'uncertain', issue: issue(error), partialEffect: 'possible',
      needsRecovery: true, pricing: 'recheck_required', ...(beforeImage ? { beforeImage } : {}),
      ...(afterImage ? { afterImage } : {}), ...(changedFields ? { changedFields } : {}) };
    throw new Error(issue(error));
  }
}
