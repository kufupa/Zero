// Open cancellation on a verified saved Labtest stay; never accept a fee dialog.
import {
  currentLabtestRecord,
  snapshotLabtestRecord as recordSnapshot,
  cleanLabtestRecord,
  unchangedLabtestRecord as unchangedExcept,
  matchesLabtestBody as bodyMatchesSnapshot,
} from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const OPEN_PATH = '/web/base/OSCNRS';
const usedPages = new WeakSet();
const pendingPages = new WeakMap();
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'CANCEL_UNVERIFIED';

// Playwright operations can remain pending while a native dialog is open.
// Disarm and quarantine synchronously before returning from the race.
function actionDeadline(page, timeoutMs, hooks) {
  let stopped = null, resolveInterruption;
  const interrupted = new Promise((resolve) => { resolveInterruption = resolve; });
  const stop = (reason, dialog = null) => {
    if (stopped) return;
    stopped = reason;
    hooks.disarm();
    if (dialog) hooks.recordDialog(dialog);
    hooks.quarantine();
    resolveInterruption(hooks.result(reason, dialog));
  };
  page.on('dialog', (dialog) => stop('NATIVE_DIALOG', { type: dialog.type(), message: dialog.message() }));
  const timer = setTimeout(() => stop('ACTION_TIMEOUT'), timeoutMs);
  return {
    interrupted,
    check() { if (stopped) { hooks.quarantine(); throw new Error(stopped); } },
    finish() { clearTimeout(timer); },
  };
}

function cleanSnapshot(snapshot) {
  return Boolean(cleanLabtestRecord(snapshot) &&
    snapshot.data.cancelreason === '' && snapshot.data.cancellationnote === '' &&
    snapshot.data.reservationstaystatus === 'CONFIRMED' && snapshot.data.cancelpolicyoverride === '');
}

function matchesOpen(request, frame, confirmation) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = { SYSTEM_FUNCTION_NAME: 'OSCNRS', USER_FUNCTION_NAME: 'OSCNRS', confirmationnumber: confirmation, propertycode: 'HRCEN' };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN && url.pathname === OPEN_PATH &&
      !url.search && !url.hash && keys.length === Object.keys(required).length &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value);
  } catch { return false; }
}

/** Opens only the initial cancellation form. It never chooses a reason or confirms cancellation. */
export async function openLabtestCancellation(page, expected = {}, { timeoutMs = 20_000 } = {}) {
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let armed = false, dispatched = false, nativeDialog = null, response = null, authorizedRequest;
  let fence, scope, interactionStarted = false, openedReady = false;
  const blocked = [];
  const action = actionDeadline(page, timeoutMs, {
    disarm: () => { armed = false; }, recordDialog: (dialog) => { nativeDialog = dialog; },
    quarantine: () => { fence?.quarantine(); scope?.close(); },
    result: (reason, dialog) => ({ outcome: dialog && /penalt|fee|charge|deposit/i.test(dialog.message) ? 'fee_dialog_pending' :
      dispatched ? 'uncertain' : dialog ? 'unexpected_dialog' : 'not_dispatched', issue: reason,
    requestDispatched: dispatched, httpStatus: response?.status() || null, nativeDialog, blockedRequests: [...blocked] }),
  });
  const work = (async () => { try {
    fence = await installPageRequestFence(page, [OPEN_PATH]);
    action.check();
    scope = fence.open();
    const state = await currentLabtestRecord(page, expected), frame = state.frame;
    const baseline = await recordSnapshot(frame);
    action.check();
    if (!cleanSnapshot(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (await page.locator('.x-window:visible:not(.x-menu)').count() !== 1 ||
        await frame.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    const cancel = frame.locator('[data-qtip="Cancel Reservation"]:visible');
    if (await cancel.count() !== 1) throw new Error('CANCEL_CONTROL_NOT_UNIQUE');
    action.check();
    await page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '', policyRead = false;
      try {
        const url = new URL(request.url());
        pathname = url.pathname;
        action = url.searchParams.get('pageaction') || '';
        policyRead = request.method() === 'GET' && url.origin === ORIGIN && !url.hash &&
          pathname === `/api/booking/HRCEN/cancelPolicy/${encodeURIComponent(expected.confirmation)}`;
      }
      catch { /* Block unparseable targets. */ }
      if (policyRead) return route.fallback();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !/save|delete|cancel|checkin|checkout|send|email|mail|crs/i.test(pathname) &&
          !(pathname === '/web/base/OSRESV.HDR' && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (armed && !nativeDialog && !fence.isQuarantined() && matchesOpen(request, frame, expected.confirmation) && scope.allow(request)) {
        armed = false;
        authorizedRequest = request;
        dispatched = true;
        return route.continue();
      }
      armed = false;
      blocked.push({ method: request.method(), path: /^\/web\/base\/[A-Za-z0-9_.-]+$/.test(pathname) ? pathname : 'other' });
      return route.abort();
    });
    action.check();
    usedPages.add(page);
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    const policyPending = page.waitForResponse((item) => {
      try {
        const url = new URL(item.url());
        return item.request().method() === 'GET' && url.origin === ORIGIN &&
          url.pathname === `/api/booking/HRCEN/cancelPolicy/${encodeURIComponent(expected.confirmation)}`;
      } catch { return false; }
    }, { timeout: timeoutMs }).catch(() => null);
    action.check();
    armed = true;
    interactionStarted = true;
    await cancel.click({ timeout: 5_000, noWaitAfter: true });
    action.check();
    response = await pending;
    const policyResponse = await policyPending;
    const policy = policyResponse?.status() === 200 ? await policyResponse.json().catch(() => null) : null;
    action.check();
    armed = false;
    await page.waitForTimeout(1_000);
    const dialogs = await frame.locator('.x-window:visible:not(.x-menu)').evaluateAll((windows) =>
      windows.map((window) => window.innerText.trim())).catch(() => []);
    const fee = dialogs.some((text) => /penalt|fee|charge|deposit/i.test(text)) ||
      Boolean(nativeDialog && /penalt|fee|charge|deposit/i.test(nativeDialog.message));
    const policyReady = policy?.applyCancelPolicy === false && policy?.allowCancelPolicyOverride === false &&
      Array.isArray(policy.cancelReasons) && policy.cancelReasons.filter((item) =>
        item.value === 'TEST' && item.display === 'Test Reservations').length === 1;
    const afterOpen = await recordSnapshot(frame);
    action.check();
    const reasonReady = !fee && policyReady && dispatched && response?.status() === 200 &&
      dialogs.length === 1 && /cancellation reason/i.test(dialogs[0]) && !nativeDialog &&
      cleanSnapshot(afterOpen) && unchangedExcept(baseline, afterOpen, {}) && !fence.isQuarantined();
    if (reasonReady) pendingPages.set(page, { frame, expected: { ...expected }, native: { ...state.native }, track: state.track,
      blocked, baseline: afterOpen, fence, dialogSeen: () => nativeDialog });
    openedReady = reasonReady;
    return { outcome: fee ? 'fee_dialog_pending' : reasonReady ? 'reason_ready' : policy && !policyReady ? 'policy_requires_review' :
      dispatched && dialogs.length ? 'unexpected_dialog' : dispatched ? 'uncertain' : 'not_dispatched',
    httpStatus: response?.status() || null, policy: policy ? { applyCancelPolicy: policy.applyCancelPolicy,
      allowCancelPolicyOverride: policy.allowCancelPolicyOverride } : null, dialogs, nativeDialog, blockedRequests: blocked };
  } catch (error) {
    armed = false;
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', issue: issue(error),
      httpStatus: response?.status() || null, nativeDialog, blockedRequests: blocked };
  } finally {
    if (!openedReady && interactionStarted) fence?.quarantine();
    scope?.close();
  } })();
  try { return await Promise.race([work, action.interrupted]); }
  finally { action.finish(); }
}

function matchesCancellation(request, frame, expected, state, cancellationNote, snapshot) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', confirmationnumber: expected.confirmation,
      guestid: expected.guestId, arrivaldate: state.arrivalWire, departuredate: state.departureWire,
      roomtype: expected.roomType, rateplan: expected.ratePlan, track: state.track, reservationnote: expected.note,
      cancelreason: 'TEST', cancellationnote: cancellationNote, reservationstaystatus: 'CANCELED', canceldate: '', cancelnumber: '',
      cancelpolicy: '', cancelpolicytext: '', cancelpolicyoverride: '0', applycxlpolicy: '',
      udfchkbox04: '0', udfchar13: '', emailaddress: '', guaranteetype: 'NGI', pagemode: 'view',
      savecctoprofile: '0', savesettlementcctoprofile: '0', ...state.native,
    };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === '/web/base/OSRESV.HDR' && !url.hash && [...url.searchParams].length === 1 &&
      url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      bodyMatchesSnapshot(body, snapshot, { cancelreason: 'TEST', cancellationnote: cancellationNote,
        reservationstaystatus: 'CANCELED', cancelpolicyoverride: '0' });
  } catch { return false; }
}

/** Confirm the observed Test Reservations reason once. A later fee dialog is never touched. */
export async function confirmLabtestCancellation(page, expected = {}, { cancellationNote, timeoutMs = 20_000 } = {}) {
  const opened = pendingPages.get(page);
  pendingPages.delete(page);
  if (!opened) return { outcome: 'refused', issue: 'CANCEL_REASON_NOT_CURRENT' };
  if (typeof cancellationNote !== 'string' || !cancellationNote.trim() || cancellationNote.length > 200) {
    return { outcome: 'input_gap', issue: 'CANCELLATION_NOTE_INVALID' };
  }
  let armed = false, dispatched = false, nativeDialog = null, response = null, authorizedRequest, sendRequests = 0;
  let fence, scope, interactionStarted = false;
  const blocked = [];
  const action = actionDeadline(page, timeoutMs, {
    disarm: () => { armed = false; }, recordDialog: (dialog) => { nativeDialog = dialog; },
    quarantine: () => { fence?.quarantine(); scope?.close(); },
    result: (reason, dialog) => ({ outcome: dialog && /penalt|fee|charge|deposit/i.test(dialog.message) ? 'fee_dialog_pending' :
      dispatched ? 'uncertain' : dialog ? 'unexpected_dialog' : 'not_dispatched', issue: reason,
    requestDispatched: dispatched, httpStatus: response?.status() || null, nativeDialog,
    blockedRequests: [...blocked], browserSendRequests: sendRequests }),
  });
  const work = (async () => { try {
    fence = await installPageRequestFence(page, ['/web/base/OSRESV.HDR']);
    action.check();
    if (fence !== opened.fence || fence.isQuarantined()) throw new Error('PAGE_ACTION_UNCERTAIN');
    scope = fence.open();
    const names = ['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note'];
    if (names.some((name) => opened.expected[name] !== expected[name]) || opened.blocked.length || opened.dialogSeen()) {
      throw new Error('CANCEL_REASON_STALE');
    }
    const state = await currentLabtestRecord(page, expected), frame = state.frame;
    if (frame !== opened.frame || JSON.stringify(state.native) !== JSON.stringify(opened.native) || state.track !== opened.track) {
      throw new Error('LABTEST_RECORD_CHANGED');
    }
    const before = await recordSnapshot(frame);
    action.check();
    if (!cleanSnapshot(before) || !unchangedExcept(opened.baseline, before, {})) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    const windows = frame.locator('.x-window:visible:not(.x-menu)');
    const dialog = windows.filter({ hasText: /Cancellation Reason/i });
    if (await windows.count() !== 1 || await dialog.count() !== 1 ||
        /penalt|fee|charge|deposit/i.test(await dialog.innerText())) throw new Error('FEE_OR_DIALOG_UNEXPECTED');
    const reason = dialog.locator('input[name="cancelreason"]:visible');
    const note = dialog.locator('textarea[name="cancellationnote"]:visible');
    const arrow = dialog.locator('.x-form-arrow-trigger:visible');
    const ok = dialog.locator('.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
    if (await reason.count() !== 1 || await note.count() !== 1 || await arrow.count() !== 1 || await ok.count() !== 1) {
      throw new Error('CANCEL_REASON_CONTROL_NOT_UNIQUE');
    }
    const optionsVerified = await reason.evaluate((el) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const matches = component?.getStore?.()?.getRange?.().filter((row) =>
        row.data?.value === 'TEST' && row.data?.display === 'Test Reservations') || [];
      return matches.length === 1 && !component.getValue();
    });
    action.check();
    if (!optionsVerified) throw new Error('TEST_REASON_UNVERIFIED');
    await page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '';
      try { const url = new URL(request.url()); pathname = url.pathname; action = url.searchParams.get('pageaction') || ''; }
      catch { /* Block unparseable targets. */ }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !(pathname === '/web/base/OSRESV.HDR' && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (/send|email|mail/i.test(pathname)) sendRequests += 1;
      if (armed && !nativeDialog && !opened.dialogSeen() && !fence.isQuarantined() &&
          matchesCancellation(request, frame, expected, state, cancellationNote, before) && scope.allow(request)) {
        armed = false;
        authorizedRequest = request;
        dispatched = true;
        return route.continue();
      }
      armed = false;
      blocked.push({ method: request.method(), path: /^[A-Za-z0-9/_.-]{1,180}$/.test(pathname) ? pathname : 'other' });
      return route.abort();
    });
    action.check();
    interactionStarted = true;
    await arrow.click();
    action.check();
    const choice = frame.locator('.x-boundlist-item:visible').filter({ hasText: /^Test Reservations$/ });
    if (await choice.count() !== 1) throw new Error('TEST_REASON_NOT_UNIQUE');
    action.check();
    await choice.click();
    action.check();
    const filled = await note.evaluate((el, value) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      if (!component?.setValue || el.disabled || el.readOnly) return false;
      component.setValue(value);
      component.fireEvent?.('blur', component);
      return el.value === value;
    }, cancellationNote);
    action.check();
    const selected = await reason.evaluate((el) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.getValue?.() === 'TEST' && el.value.trim() === 'Test Reservations';
    });
    const after = await currentLabtestRecord(page, expected);
    const afterFields = await recordSnapshot(frame);
    action.check();
    const changes = { cancelreason: 'TEST', cancellationnote: cancellationNote,
      reservationstaystatus: 'CANCELED', cancelpolicyoverride: '0' };
    if (!filled || !selected || blocked.length || opened.blocked.length || nativeDialog || opened.dialogSeen() ||
        frame !== after.frame || JSON.stringify(state.native) !== JSON.stringify(after.native) ||
        !unchangedExcept(before, afterFields, changes) || fence.isQuarantined() ||
        await windows.count() !== 1 || /penalt|fee|charge|deposit/i.test(await dialog.innerText())) {
      throw new Error('CANCEL_REASON_CHANGED');
    }
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    action.check();
    armed = true;
    await ok.click({ timeout: 5_000, noWaitAfter: true });
    action.check();
    response = await pending;
    action.check();
    armed = false;
    await page.waitForTimeout(1_500);
    const dialogs = await windows.evaluateAll((items) => items.map((item) => item.innerText.trim())).catch(() => []);
    action.check();
    const fee = dialogs.some((text) => /penalt|fee|charge|deposit/i.test(text)) ||
      Boolean(nativeDialog && /penalt|fee|charge|deposit/i.test(nativeDialog.message));
    return { outcome: fee ? 'fee_dialog_pending' : dispatched && response?.status() === 200 && !nativeDialog && !dialogs.length
      ? 'awaiting_readback' : dispatched ? 'uncertain' : 'not_dispatched',
    httpStatus: response?.status() || null, reason: 'Test Reservations', dialogs, nativeDialog, blockedRequests: blocked,
    browserSendRequests: sendRequests };
  } catch (error) {
    armed = false;
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', issue: issue(error),
      httpStatus: response?.status() || null, nativeDialog, blockedRequests: blocked, browserSendRequests: sendRequests };
  } finally {
    if (interactionStarted) fence?.quarantine();
    scope?.close();
  } })();
  try { return await Promise.race([work, action.interrupted]); }
  finally { action.finish(); }
}
