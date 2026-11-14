// Open cancellation on a verified saved stay and require a separate staff decision for any charge.
import { createHash } from 'node:crypto';
import {
  currentLabtestRecord,
  snapshotLabtestRecord as recordSnapshot,
  cleanLabtestRecord,
  blankLabtestParties,
  unchangedLabtestBusinessParties,
  unchangedLabtestRecord as unchangedExcept,
  matchesLabtestBody as bodyMatchesSnapshot,
} from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const OPEN_PATH = '/web/base/OSCNRS';
const financialFields = ['guaranteetype', 'araccountname', 'arprofileid', 'araccountid',
  'guaranteecreditcardid', 'leaseguaranteecreditcardid'];
const preservedFields = ['arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'adults', 'children',
  'childages', 'track', 'reservationnote', 'firstname', 'lastname',
  'emailaddress', 'bookername', 'bookercontact', 'caller', 'udfchar06',
  'udfchkbox04', 'udfchar09', 'udfchar13'];
const usedPages = new WeakSet();
const pendingPages = new WeakMap();
const zeroPenaltyNotice = 'Cancellation Penalty of 0.00 may be added to account.';
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'CANCEL_UNVERIFIED';
// A missing field stays unknown; duplicate fields never establish a match.
async function depositDisplayMatches(frame, expected) {
  return frame.evaluate((wanted) => {
    const fields = [...document.querySelectorAll('input[name="depositreceived"]')].filter((el) =>
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    return wanted === null ? fields.length === 0 : fields.length === 1 && fields[0].value.trim() === wanted;
  }, expected.depositReceived);
}
// These controls can request a separate profile write. An omitted control is not a write.
const noProfileWrite = (body, keys) => ['savecctoprofile', 'savesettlementcctoprofile'].every((key) => {
  const names = keys.filter((name) => name.toLowerCase() === key);
  return !names.length || (names.length === 1 && names[0] === key && body.get(key) === '0');
});
const isNativeSaveUrl = (url) => {
  const actions = [...url.searchParams].filter(([key]) => key.toLowerCase() === 'pageaction');
  return url.origin === ORIGIN && url.pathname === '/web/base/OSRESV.HDR' && !url.hash &&
    actions.length === 1 && actions[0][0] === 'pageaction' && actions[0][1] === 'SAVE';
};

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
  const onDialog = (dialog) => {
    const observed = { type: dialog.type(), message: dialog.message() };
    const reject = () => { stop('NATIVE_DIALOG', observed); void dialog.dismiss().catch(() => {}); };
    if (hooks.onNativeCharge && observed.type === 'confirm' && /penalt|fee|charge|deposit/i.test(observed.message)) {
      void (async () => {
        if (await hooks.onNativeCharge(observed) !== true || stopped) return reject();
        await dialog.accept();
      })().catch(reject);
      return;
    }
    reject();
  };
  page.on('dialog', onDialog);
  const timer = setTimeout(() => stop('ACTION_TIMEOUT'), timeoutMs);
  return {
    interrupted,
    isStopped() { return stopped !== null; },
    check() { if (stopped) { hooks.quarantine(); throw new Error(stopped); } },
    finish() { clearTimeout(timer); page.off?.('dialog', onDialog); },
  };
}

function cleanSnapshot(snapshot) {
  return Boolean(cleanLabtestRecord(snapshot) &&
    snapshot.data.cancelreason === '' && snapshot.data.cancellationnote === '' &&
    snapshot.data.reservationstaystatus === 'CONFIRMED');
}

function pendingSnapshot(snapshot) {
  return Boolean(snapshot?.data && snapshot.data.cancelreason === '' && snapshot.data.cancellationnote === '' &&
    snapshot.data.reservationstaystatus === 'CONFIRMED');
}

const isCloudCancellation = (expected) => typeof expected?.allowRealGuest === 'boolean' &&
  typeof expected?.cmsSend === 'boolean' && Boolean(expected?.expectedGuarantee);
const readySnapshot = (snapshot, expected) => isCloudCancellation(expected) ? pendingSnapshot(snapshot) : cleanSnapshot(snapshot);

function recordOptions(expected) {
  return {
    allowRealGuest: true, ...(isCloudCancellation(expected) ? { allowCancelFinancialChanges: true }
      : { expectedGuarantee: expected.expectedGuarantee }),
    allowBlankNote: true, allowUnchangedBusinessParties: true,
    preserveUnsentRecipient: true, allowModelOnlyPrimaryPartyIds: true,
  };
}

async function currentCancellationRecord(page, expected) {
  if (!isCloudCancellation(expected)) {
    return currentLabtestRecord(page, expected, expected?.allowRealGuest === true ? recordOptions(expected) : {});
  }
  if (expected?.allowRealGuest === false) {
    // Keep fake-write admission explicit while allowing native financial changes.
    if (expected.firstName !== 'Proof' || expected.lastName !== 'Labtest' ||
        expected.arrival < '2027-01-01' || expected.cmsSend !== false) throw new Error('LABTEST_RECORD_INPUT_INVALID');
  }
  const state = await currentLabtestRecord(page, expected, recordOptions(expected));
  if (state.cmsSend !== expected.cmsSend) throw new Error('CANCEL_CMS_CHANGED');
  return state;
}

function sameParties(state, snapshot, expected) {
  return state.allowRealGuest
    ? unchangedLabtestBusinessParties(state.partyPreimage, snapshot, { allowModelOnlyPrimaryPartyIds: true,
      allowRealGuest: true, allowCancelFinancialChanges: isCloudCancellation(expected) })
    : blankLabtestParties(snapshot);
}

function cancellationBusinessSnapshot(snapshot, expected) {
  const data = { ...snapshot?.data };
  delete data.cancelpolicyoverride;
  if (isCloudCancellation(expected)) for (const key of financialFields) delete data[key];
  return { ...snapshot, data };
}

function unchangedCancellationFields(before, after, expected) {
  if (!isCloudCancellation(expected)) return true;
  return ['values', 'data'].every((part) => {
    const a = before?.[part], b = after?.[part];
    const keys = new Set([...preservedFields, ...Object.keys(a ?? {}).filter(key => /^child\d+(?:status|label)?$/i.test(key)),
      ...Object.keys(b ?? {}).filter(key => /^child\d+(?:status|label)?$/i.test(key))]);
    return a && b && [...keys].every((key) => {
      const has = Object.hasOwn(a, key);
      return has === Object.hasOwn(b, key) && (!has || JSON.stringify(a[key]) === JSON.stringify(b[key]));
    });
  });
}

function cancelReasons(policy) {
  if (!Array.isArray(policy?.cancelReasons) || !policy.cancelReasons.length || policy.cancelReasons.length > 100) return null;
  const result = policy.cancelReasons.map((item) => ({ value: item?.value, display: item?.display }));
  if (result.some((item) => typeof item.value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(item.value) ||
      typeof item.display !== 'string' || !item.display.trim() || item.display !== item.display.trim() ||
      item.display.length > 120 || /[\p{Cc}]/u.test(item.display)) ||
      new Set(result.map((item) => item.value)).size !== result.length ||
      new Set(result.map((item) => item.display)).size !== result.length) return null;
  return result;
}

/** Report native facts without treating a policy flag or balance as proof of a fee. */
function cancellationPolicyFacts(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return [];
  const facts = [];
  if (typeof policy.applyCancelPolicy === 'boolean') {
    facts.push(`HMS cancellation policy applies: ${policy.applyCancelPolicy ? 'Yes' : 'No'}`);
  }
  if (typeof policy.allowCancelPolicyOverride === 'boolean') {
    facts.push(`HMS allows policy override: ${policy.allowCancelPolicyOverride ? 'Yes' : 'No'}`);
  }
  for (const [key, value] of Object.entries(policy)) {
    if (!/penalty|fee|charge/i.test(key) || !['string', 'number'].includes(typeof value)) continue;
    const text = String(value).trim();
    if (!text || text.length > 200 || /[\p{Cc}]/u.test(text)) continue;
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    facts.push(`${label}: ${text}`);
    if (facts.length === 12) break;
  }
  return facts;
}

/** Exact paused Save request, including its wire bytes, destination and type. */
export function cancellationRequestDigest(request) {
  try {
    const url = new URL(request.url()), contentType = request.headers()['content-type'] || '';
    const bytes = request.postDataBuffer();
    if (request.method() !== 'POST' || !isNativeSaveUrl(url) ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) || !Buffer.isBuffer(bytes) ||
        !bytes.length || bytes.length > 1024 * 1024) return null;
    return createHash('sha256').update(JSON.stringify(['POST', url.href, contentType])).update('\0').update(bytes).digest('hex');
  } catch { return null; }
}

function matchesOpen(request, frame, expected) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = { SYSTEM_FUNCTION_NAME: 'OSCNRS', USER_FUNCTION_NAME: 'OSCNRS', confirmationnumber: expected.confirmation, propertycode: expected.propertyCode };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN && url.pathname === OPEN_PATH &&
      !url.search && !url.hash &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
  } catch { return false; }
}

/** Opens only the initial cancellation form. It never chooses a reason or confirms cancellation. */
export async function openLabtestCancellation(page, expected = {}, { timeoutMs = 20_000, awaitChargeApproval,
  prepareChargeWithAuthority, continuationAllowed = () => true, bindDepositReceived = false } = {}) {
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let armed = false, dispatched = false, nativeDialog = null, response = null, authorizedRequest;
  let fence, scope, interactionStarted = false, openedReady = false, baselineVerified = false;
  let preChargeStarted = false, preChargeText = null;
  const blocked = [];
  const forwarded = new WeakSet();
  const approvePreCharge = async (dialog) => {
    preChargeText = dialog.text;
    if (!baselineVerified || typeof awaitChargeApproval !== 'function' || typeof prepareChargeWithAuthority !== 'function' ||
        continuationAllowed() !== true || await awaitChargeApproval(dialog) !== true || action.isStopped() ||
        continuationAllowed() !== true) return false;
    await prepareChargeWithAuthority();
    preChargeStarted = true;
    action.check();
    return continuationAllowed() === true && Boolean(fence && !fence.isQuarantined());
  };
  const action = actionDeadline(page, timeoutMs, {
    disarm: () => { armed = false; }, recordDialog: (dialog) => { nativeDialog = dialog; },
    quarantine: () => { fence?.quarantine(); scope?.close(); },
    result: (reason, dialog) => ({ outcome: preChargeStarted ? 'fee_accepted_unconfirmed' :
      preChargeText || (dialog && /penalt|fee|charge|deposit/i.test(dialog.message)) ? 'fee_dialog_pending' :
      dispatched ? 'uncertain' : dialog ? 'unexpected_dialog' : 'not_dispatched', issue: reason,
    requestDispatched: dispatched, httpStatus: response?.status() || null, nativeDialog,
    penaltyText: dialog?.message ?? preChargeText, blockedRequests: [...blocked] }),
    onNativeCharge: async (dialog) => approvePreCharge({ text: dialog.message, button: 'OK' }),
  });
  const work = (async () => { try {
    const policyPath = `/api/booking/${encodeURIComponent(expected.propertyCode)}/cancelPolicy/${encodeURIComponent(expected.confirmation)}`;
    fence = await installPageRequestFence(page, [OPEN_PATH, policyPath]);
    action.check();
    scope = fence.open();
    const state = await currentCancellationRecord(page, expected), frame = state.frame;
    if (bindDepositReceived && !await depositDisplayMatches(frame, expected)) throw new Error('CANCEL_DEPOSIT_CHANGED');
    const baseline = await recordSnapshot(frame);
    action.check();
    if (!cleanSnapshot(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!sameParties(state, baseline, expected)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    if (expected.allowRealGuest && state.native.reservationstayid !== expected.nativeStayId) {
      throw new Error('CANCEL_TARGET_UNVERIFIED');
    }
    if (await page.locator('.x-window:visible:not(.x-menu)').count() !== 1 ||
        await frame.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    const cancel = frame.locator('[data-qtip="Cancel Reservation"]:visible');
    if (await cancel.count() !== 1) throw new Error('CANCEL_CONTROL_NOT_UNIQUE');
    baselineVerified = true;
    action.check();
    await page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '', policyRead = false;
      try {
        const url = new URL(request.url());
        pathname = url.pathname;
        action = url.searchParams.get('pageaction') || '';
        policyRead = request.method() === 'GET' && url.origin === ORIGIN && !url.hash &&
          pathname === policyPath && !url.search;
      }
      catch { /* Block unparseable targets. */ }
      if (policyRead && scope.allow(request)) return route.fallback();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !/save|delete|cancel|checkin|checkout|send|email|mail|crs|charge|fee|penalt|payment/i.test(pathname) &&
          !(pathname === '/web/base/OSRESV.HDR' && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (forwarded.delete(request) && !fence.isQuarantined()) return route.fallback();
      if (armed && !nativeDialog && !fence.isQuarantined() && matchesOpen(request, frame, expected) && scope.allow(request)) {
        armed = false;
        authorizedRequest = request;
        dispatched = true;
        return route.fallback();
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
          url.pathname === policyPath && !url.search;
      } catch { return false; }
    }, { timeout: timeoutMs }).catch(() => null);
    action.check();
    armed = true;
    interactionStarted = true;
    await cancel.click({ timeout: timeoutMs, noWaitAfter: true });
    action.check();
    response = await pending;
    const policyResponse = await policyPending;
    const policy = policyResponse?.status() === 200 ? await policyResponse.json().catch(() => null) : null;
    action.check();
    armed = false;
    // A response can precede the reason/fee dialog. Retain the observation
    // window until a terminal native handler state excludes a later dialog.
    await page.waitForTimeout(1_000);
    const windows = frame.locator('.x-window:visible:not(.x-menu)');
    let dialogs = await windows.evaluateAll((windows) =>
      windows.map((window) => window.innerText.trim())).catch(() => []);
    let fee = dialogs.some((text) => /penalt|fee|charge|deposit/i.test(text) && !/cancellation reason/i.test(text)) ||
      Boolean(nativeDialog && /penalt|fee|charge|deposit/i.test(nativeDialog.message));
    const reasons = cancelReasons(policy);
    const policyReady = Boolean(reasons && (expected.allowRealGuest === true || reasons.some((item) =>
      item.value === 'TEST' && item.display === 'Test Reservations')));
    let afterOpen = await recordSnapshot(frame);
    if (fee && !nativeDialog && policyReady && dispatched && response?.status() === 200 && !blocked.length &&
        readySnapshot(afterOpen, expected) && sameParties(state, afterOpen, expected) && unchangedExcept(baseline, afterOpen, {}) &&
        unchangedCancellationFields(baseline, afterOpen, expected) &&
        typeof awaitChargeApproval === 'function' && typeof prepareChargeWithAuthority === 'function') {
      const charge = windows.filter({ hasText: /penalt|fee|charge|deposit/i });
      if (await charge.count() === 1) {
        const text = (await charge.innerText()).trim();
        const button = charge.locator('.x-btn:visible').filter({ hasText: /^\s*(?:OK|Yes|Accept)\s*$/i });
        if (text.length <= 2000 && !/cancellation reason/i.test(text) && await button.count() === 1 &&
            await chargeTargetIsCurrent(frame, expected)) {
          const label = (await button.innerText()).trim();
          preChargeText = text;
          const approved = await awaitChargeApproval({ text, button: label });
          action.check();
          if (approved === true && continuationAllowed() === true && await charge.count() === 1 &&
              (await charge.innerText()).trim() === text && await button.count() === 1 &&
              (await button.innerText()).trim() === label && await chargeTargetIsCurrent(frame, expected)) {
            await prepareChargeWithAuthority();
            preChargeStarted = true;
            preChargeText = text;
            if (continuationAllowed() !== true || await charge.count() !== 1 ||
                (await charge.innerText()).trim() !== text || await button.count() !== 1 ||
                (await button.innerText()).trim() !== label || !await chargeTargetIsCurrent(frame, expected)) {
              throw new Error('CANCEL_CHARGE_CHANGED');
            }
            await button.click({ timeout: timeoutMs, noWaitAfter: true });
            // Fee acceptance has no established terminal dialog signal.
            await page.waitForTimeout(1_000);
            dialogs = await windows.evaluateAll((items) => items.map((item) => item.innerText.trim())).catch(() => []);
            fee = dialogs.some((value) => /penalt|fee|charge|deposit/i.test(value) && !/cancellation reason/i.test(value));
            afterOpen = await recordSnapshot(frame);
          }
        }
      }
    }
    action.check();
    const reasonReady = !fee && policyReady && dispatched && response?.status() === 200 &&
      dialogs.length === 1 && /cancellation reason/i.test(dialogs[0]) && !nativeDialog &&
      readySnapshot(afterOpen, expected) && sameParties(state, afterOpen, expected) &&
      unchangedExcept(baseline, afterOpen, {}) && unchangedCancellationFields(baseline, afterOpen, expected) &&
      !blocked.length && !fence.isQuarantined();
    if (reasonReady) pendingPages.set(page, { frame, expected: { ...expected }, native: { ...state.native }, track: state.track,
      blocked, baseline: afterOpen, fence, forwarded, reasons, partyPreimage: state.partyPreimage,
      noCancelPolicy: policy?.applyCancelPolicy === false && policy?.allowCancelPolicyOverride === false,
      chargeApproved: preChargeStarted, penaltyText: preChargeText, dialogSeen: () => nativeDialog });
    openedReady = reasonReady;
    return { outcome: preChargeStarted && !reasonReady ? 'fee_accepted_unconfirmed' : fee ? 'fee_dialog_pending' : reasonReady ? 'reason_ready' : policy && !policyReady ? 'policy_requires_review' :
      dispatched && dialogs.length ? 'unexpected_dialog' : dispatched ? 'uncertain' : 'not_dispatched',
    httpStatus: response?.status() || null, reasons: reasons ?? [], policy: policy ? { applyCancelPolicy: policy.applyCancelPolicy,
      allowCancelPolicyOverride: policy.allowCancelPolicyOverride } : null, policyFacts: cancellationPolicyFacts(policy),
    penaltyText: preChargeText ?? dialogs.find((text) => /penalt|fee|charge|deposit/i.test(text)) ?? nativeDialog?.message ?? null,
    chargeApproved: preChargeStarted, dialogs, nativeDialog, blockedRequests: blocked };
  } catch (error) {
    armed = false;
    return { outcome: preChargeStarted ? 'fee_accepted_unconfirmed' : preChargeText ? 'fee_dialog_pending' :
      dispatched ? 'uncertain' : 'not_dispatched', issue: issue(error), penaltyText: preChargeText,
      httpStatus: response?.status() || null, nativeDialog, blockedRequests: blocked };
  } finally {
    if (!openedReady && interactionStarted) fence?.quarantine();
    scope?.close();
  } })();
  try { return await Promise.race([work, action.interrupted]); }
  finally { action.finish(); }
}

export function matchesCancellation(request, frame, expected, state, reasonCode, cancellationNote, snapshot) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    // HMS may serialize or update its policy override while cancelling; the observed fee dialog has its own approval.
    const changes = { cancelreason: reasonCode, cancellationnote: cancellationNote, reservationstaystatus: 'CANCELED' };
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: expected.propertyCode, status: 'Reserved', firstname: state.expectedFirstName, lastname: state.expectedLastName, confirmationnumber: expected.confirmation,
      guestid: expected.guestId, arrivaldate: state.arrivalWire, departuredate: state.departureWire,
      roomtype: expected.roomType, rateplan: expected.ratePlan, track: state.track, reservationnote: expected.note,
      cancelreason: reasonCode, cancellationnote: cancellationNote, reservationstaystatus: 'CANCELED',
      udfchkbox04: state.cmsSend ? '1' : '0', udfchar13: state.cmsRecipient, emailaddress: state.guestEmail, pagemode: 'view',
      ...(!isCloudCancellation(expected) ? { guaranteetype: state.expectedGuarantee.code } : {}),
      ...state.native,
    };
    return request.method() === 'POST' && request.frame() === frame && isNativeSaveUrl(url) &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      noProfileWrite(body, keys) && Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      bodyMatchesSnapshot(body, cancellationBusinessSnapshot(snapshot, expected), changes);
  } catch { return false; }
}

// A charge continuation may arrive after HMS has changed the status and its policy override.
// The observed dialog supplies that choice; all other saved business fields remain bound.
function matchesChargeSave(request, frame, expected, state, reasonCode, cancellationNote, snapshot) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: expected.propertyCode, confirmationnumber: expected.confirmation, guestid: expected.guestId,
      reservationstayid: expected.nativeStayId, ...state.native };
    const status = body.get('status');
    if (!['Reserved', 'Cancelled', 'Canceled'].includes(status)) return false;
    return request.method() === 'POST' && request.frame() === frame && isNativeSaveUrl(url) &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      noProfileWrite(body, keys) && Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      bodyMatchesSnapshot(body, cancellationBusinessSnapshot(snapshot, expected), { status, cancelreason: reasonCode,
        cancellationnote: cancellationNote, reservationstaystatus: 'CANCELED' });
  } catch { return false; }
}

async function chargeTargetIsCurrent(frame, expected) {
  return frame.evaluate((target) => {
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
      getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
    if (guests.length !== 1) return false;
    const form = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form');
    const data = form?.getRecord?.()?.data;
    return Boolean(data && String(data.propertycode) === target.propertyCode &&
      String(data.confirmationnumber) === target.confirmation && String(data.guestid) === target.guestId &&
      String(data.reservationstayid) === target.nativeStayId);
  }, expected).catch(() => false);
}

/** Confirm one observed reason. A later charge requires a second staff decision on the same dialog. */
export async function confirmLabtestCancellation(page, expected = {}, { cancellationNote = '', reasonCode,
  reasonLabel, timeoutMs = 20_000, beforeDispatch, dispatchWithAuthority, continuationAllowed = () => true,
  onDispatched, awaitChargeApproval, prepareChargeWithAuthority, dispatchChargeWithAuthority, bindDepositReceived = false } = {}) {
  const opened = pendingPages.get(page);
  pendingPages.delete(page);
  if (!opened) return { outcome: 'refused', issue: 'CANCEL_REASON_NOT_CURRENT' };
  if (typeof cancellationNote !== 'string' || cancellationNote.length > 200 || /[\p{Cc}]/u.test(cancellationNote)) {
    return { outcome: 'input_gap', issue: 'CANCELLATION_NOTE_INVALID' };
  }
  if (expected.allowRealGuest !== true) {
    reasonCode ??= 'TEST'; reasonLabel ??= 'Test Reservations';
  }
  if (!opened.reasons?.some((item) => item.value === reasonCode && item.display === reasonLabel) ||
      (expected.allowRealGuest && (typeof beforeDispatch !== 'function' || typeof dispatchWithAuthority !== 'function'))) {
    return { outcome: 'refused', issue: 'CANCEL_REASON_UNVERIFIED' };
  }
  let armed = false, dispatched = false, nativeDialog = null, response = null, authorizedRequest, sendRequests = 0;
  let chargeArmed = false, chargeApproved = opened.chargeApproved === true, chargeDispatched = false, chargeRequest, chargeResponse;
  let chargeText = opened.penaltyText ?? null;
  let pendingDispatch = 0, preparedSnapshot = null;
  let fence, scope, interactionStarted = false;
  const blocked = [];
  const captureChargeResponse = (item) => { if (item.request() === chargeRequest) chargeResponse = item; };
  page.on('response', captureChargeResponse);
  const action = actionDeadline(page, timeoutMs, {
    disarm: () => { armed = false; chargeArmed = false; }, recordDialog: (dialog) => { nativeDialog = dialog; },
    quarantine: () => { fence?.quarantine(); scope?.close(); },
    result: (reason, dialog) => ({ outcome: chargeApproved ? 'fee_accepted_unconfirmed' :
      chargeText || (dialog && /penalt|fee|charge|deposit/i.test(dialog.message)) ? 'fee_dialog_pending' :
      dispatched ? 'uncertain' : dialog ? 'unexpected_dialog' : 'not_dispatched', issue: reason,
    requestDispatched: dispatched, httpStatus: response?.status() || null, nativeDialog,
    penaltyText: dialog?.message ?? chargeText, blockedRequests: [...blocked],
    browserSendRequests: sendRequests, dispatchCallbacksDrained: pendingDispatch === 0 }),
    onNativeCharge: async (dialog) => {
      // A JS confirm pauses the verified form. Before Save, hold the target before accepting it;
      // after Save, the separate charge request must use its existing dispatch authority.
      const beforeSave = !dispatched;
      if (typeof awaitChargeApproval !== 'function' || (beforeSave
        ? (!armed || !preparedSnapshot || typeof prepareChargeWithAuthority !== 'function')
        : typeof dispatchChargeWithAuthority !== 'function')) return false;
      chargeText = dialog.message;
      if (await awaitChargeApproval({ text: dialog.message, button: 'OK' }) !== true ||
          action.isStopped() || continuationAllowed() !== true) return false;
      if (beforeSave) {
        if (dispatched || !armed || !preparedSnapshot || !fence || fence.isQuarantined()) return false;
        await prepareChargeWithAuthority();
        chargeApproved = true;
        return !action.isStopped() && continuationAllowed() === true && !dispatched && armed && !fence.isQuarantined();
      }
      chargeApproved = true;
      chargeArmed = true;
      return true;
    },
  });
  const work = (async () => { try {
    fence = await installPageRequestFence(page, ['/web/base/OSRESV.HDR']);
    action.check();
    if (fence !== opened.fence || fence.isQuarantined()) throw new Error('PAGE_ACTION_UNCERTAIN');
    scope = fence.open();
    const names = ['propertyCode', 'confirmation', 'guestId', 'nativeStayId', 'firstName', 'lastName', 'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'allowRealGuest'];
    if (names.some((name) => opened.expected[name] !== expected[name]) || opened.blocked.length || opened.dialogSeen()) {
      throw new Error('CANCEL_REASON_STALE');
    }
    const state = await currentCancellationRecord(page, expected), frame = state.frame;
    if (bindDepositReceived && !await depositDisplayMatches(frame, expected)) throw new Error('CANCEL_DEPOSIT_CHANGED');
    if (frame !== opened.frame || JSON.stringify(state.native) !== JSON.stringify(opened.native) || state.track !== opened.track) {
      throw new Error('LABTEST_RECORD_CHANGED');
    }
    const before = await recordSnapshot(frame);
    action.check();
    if (!readySnapshot(before, expected)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!sameParties(state, before, expected)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    if (expected.allowRealGuest && state.native.reservationstayid !== expected.nativeStayId) {
      throw new Error('CANCEL_TARGET_UNVERIFIED');
    }
    if (!unchangedExcept(opened.baseline, before, {}) || !unchangedCancellationFields(opened.baseline, before, expected)) {
      throw new Error('RECORD_HAS_DIRTY_FIELDS');
    }
    const windows = frame.locator('.x-window:visible:not(.x-menu)');
    const dialog = windows.filter({ hasText: /Cancellation Reason/i });
    if (await windows.count() !== 1 || await dialog.count() !== 1) throw new Error('CANCEL_DIALOG_UNEXPECTED');
    const reason = dialog.locator('input[name="cancelreason"]:visible');
    const note = dialog.locator('textarea[name="cancellationnote"]:visible');
    const arrow = dialog.locator('.x-form-arrow-trigger:visible');
    const ok = dialog.locator('.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
    if (await reason.count() !== 1 || await note.count() !== 1 || await arrow.count() !== 1 || await ok.count() !== 1) {
      throw new Error('CANCEL_REASON_CONTROL_NOT_UNIQUE');
    }
    const optionsVerified = await reason.evaluate((el, selected) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const matches = component?.getStore?.()?.getRange?.().filter((row) =>
        row.data?.value === selected.value && row.data?.display === selected.display) || [];
      return matches.length === 1 && !component.getValue();
    }, { value: reasonCode, display: reasonLabel });
    action.check();
    if (!optionsVerified) throw new Error('CANCEL_REASON_UNVERIFIED');
    await page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '';
      try { const url = new URL(request.url()); pathname = url.pathname; action = url.searchParams.get('pageaction') || ''; }
      catch { /* Block unparseable targets. */ }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !/save|delete|cancel|checkin|checkout|send|email|mail|crs|charge|fee|penalt|payment/i.test(pathname) &&
          !(pathname === '/web/base/OSRESV.HDR' && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (/send|email|mail/i.test(pathname)) sendRequests += 1;
      // An unfamiliar charge endpoint stays blocked and the outcome remains uncertain.
      if (chargeArmed && !fence.isQuarantined() && preparedSnapshot &&
          matchesChargeSave(request, frame, expected, state, reasonCode, cancellationNote, preparedSnapshot) && scope.allow(request)) {
        chargeArmed = false;
        chargeRequest = request;
        const requestDigest = cancellationRequestDigest(request);
        let released = false;
        pendingDispatch += 1;
        const continueOnce = async () => {
          if (released || fence.isQuarantined() || continuationAllowed() !== true) throw new Error('CANCEL_CHARGE_DISARMED');
          released = true;
          chargeDispatched = true;
          opened.forwarded.add(request);
          return route.fallback();
        };
        try {
          if (!requestDigest || typeof dispatchChargeWithAuthority !== 'function') return route.abort();
          return await dispatchChargeWithAuthority(continueOnce, requestDigest, request);
        } catch { return released ? undefined : route.abort(); }
        finally { pendingDispatch -= 1; }
      }
      if (armed && !nativeDialog && !opened.dialogSeen() && !fence.isQuarantined() &&
          preparedSnapshot && matchesCancellation(request, frame, expected, state, reasonCode, cancellationNote,
            preparedSnapshot) && scope.allow(request)) {
        armed = false;
        authorizedRequest = request;
        const requestDigest = cancellationRequestDigest(request);
        let released = false;
        pendingDispatch += 1;
        const continueOnce = async () => {
          if (released || nativeDialog || opened.dialogSeen() || fence.isQuarantined() || continuationAllowed() !== true) {
            throw new Error('CANCEL_DISPATCH_DISARMED');
          }
          released = true; dispatched = true; onDispatched?.();
          opened.forwarded.add(request);
          return route.fallback();
        };
        try {
          if (!requestDigest || (beforeDispatch && await beforeDispatch() !== true)) return route.abort();
          return dispatchWithAuthority
            ? await dispatchWithAuthority(continueOnce, requestDigest, request)
            : await continueOnce();
        } catch { return released ? undefined : route.abort(); }
        finally { pendingDispatch -= 1; }
      }
      armed = false;
      chargeArmed = false;
      blocked.push({ method: request.method(), path: /^[A-Za-z0-9/_.-]{1,180}$/.test(pathname) ? pathname : 'other' });
      return route.abort();
    });
    action.check();
    interactionStarted = true;
    await arrow.click();
    action.check();
    const choice = frame.locator('.x-boundlist-item:visible').filter({
      hasText: new RegExp(`^${reasonLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    });
    if (await choice.count() !== 1) throw new Error('CANCEL_REASON_NOT_UNIQUE');
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
    const selected = await reason.evaluate((el, expectedReason) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.getValue?.() === expectedReason.value && el.value.trim() === expectedReason.display;
    }, { value: reasonCode, display: reasonLabel });
    const after = await currentCancellationRecord(page, expected);
    const afterFields = await recordSnapshot(frame);
    action.check();
    // The dialog and Save request separately verify the requested reason and note.
    if (!filled || !selected || blocked.length || opened.blocked.length || nativeDialog || opened.dialogSeen() ||
        frame !== after.frame || JSON.stringify(state.native) !== JSON.stringify(after.native) ||
        !sameParties(state, afterFields, expected) || !unchangedCancellationFields(before, afterFields, expected) ||
        !unchangedExcept(before, afterFields, {}) || fence.isQuarantined() || await windows.count() !== 1) {
      throw new Error('CANCEL_REASON_CHANGED');
    }
    preparedSnapshot = afterFields;
    const reasonText = (await dialog.innerText()).trim();
    if (/penalt|fee|charge|deposit/i.test(reasonText)) {
      chargeText = reasonText;
      const label = (await ok.innerText()).trim();
      if (reasonText.length > 2000 || typeof awaitChargeApproval !== 'function' ||
          typeof prepareChargeWithAuthority !== 'function' || !await chargeTargetIsCurrent(frame, expected) ||
          await awaitChargeApproval({ text: reasonText, button: label }) !== true || continuationAllowed() !== true) {
        throw new Error('CANCEL_CHARGE_NOT_APPROVED');
      }
      action.check();
      if (await windows.count() !== 1 || await dialog.count() !== 1 || (await dialog.innerText()).trim() !== reasonText ||
          await ok.count() !== 1 || (await ok.innerText()).trim() !== label || !await chargeTargetIsCurrent(frame, expected)) {
        throw new Error('CANCEL_CHARGE_CHANGED');
      }
      await prepareChargeWithAuthority();
      chargeApproved = true;
      action.check();
      if (continuationAllowed() !== true || await windows.count() !== 1 || await dialog.count() !== 1 ||
          (await dialog.innerText()).trim() !== reasonText || await ok.count() !== 1 ||
          (await ok.innerText()).trim() !== label || !await chargeTargetIsCurrent(frame, expected)) {
        throw new Error('CANCEL_CHARGE_CHANGED');
      }
    }
    if (bindDepositReceived && !await depositDisplayMatches(frame, expected)) throw new Error('CANCEL_DEPOSIT_CHANGED');
    action.check();
    if (continuationAllowed() !== true || fence.isQuarantined()) throw new Error('CANCEL_DISPATCH_DISARMED');
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    action.check();
    armed = true;
    await ok.click({ timeout: timeoutMs, noWaitAfter: true });
    action.check();
    response = await pending;
    action.check();
    armed = false;
    // A Save response does not establish absence of a later penalty notice.
    await page.waitForTimeout(1_500);
    let dialogs = await windows.evaluateAll((items) => items.map((item) => item.innerText.trim())).catch(() => []);
    action.check();
    let fee = dialogs.some((text) => /penalt|fee|charge|deposit/i.test(text)) ||
      Boolean(nativeDialog && /penalt|fee|charge|deposit/i.test(nativeDialog.message));
    if (fee) chargeText = dialogs.find((text) => /penalt|fee|charge|deposit/i.test(text)) ?? nativeDialog?.message ?? null;
    // This one native post-Save notice was observed without any policy or charge action.
    // Do not click its button: the separate fresh readback still decides cancellation success.
    let zeroNotice = false;
    if (fee && opened.noCancelPolicy && !opened.chargeApproved && typeof dispatchWithAuthority === 'function' &&
        dispatched && authorizedRequest && response?.status() === 200 && pendingDispatch === 0 &&
        !chargeApproved && !chargeDispatched && !nativeDialog && !blocked.length && !opened.blocked.length &&
        !sendRequests && dialogs.length === 1 &&
        dialogs[0].replace(/\s+/g, ' ').trim() === `${zeroPenaltyNotice} OK` && await windows.count() === 1) {
      const buttons = windows.locator('.x-btn:visible');
      zeroNotice = await buttons.count() === 1 && (await buttons.innerText()).trim() === 'OK';
    }
    if (fee && !zeroNotice && dispatched && !nativeDialog && typeof awaitChargeApproval === 'function' &&
        typeof dispatchChargeWithAuthority === 'function') {
      const charge = windows.filter({ hasText: /penalt|fee|charge|deposit/i });
      if (await charge.count() === 1) {
        const text = (await charge.innerText()).trim();
        const button = charge.locator('.x-btn:visible').filter({ hasText: /^\s*(?:OK|Yes|Accept)\s*$/i });
        if (text.length <= 2000 && !/cancellation reason/i.test(text) && await button.count() === 1 &&
            await chargeTargetIsCurrent(frame, expected)) {
          const label = (await button.innerText()).trim();
          chargeText = text;
          const approved = await awaitChargeApproval({ text, button: label });
          action.check();
          if (approved === true && continuationAllowed() === true && await charge.count() === 1 &&
              (await charge.innerText()).trim() === text && await button.count() === 1 &&
              (await button.innerText()).trim() === label && await chargeTargetIsCurrent(frame, expected)) {
            chargeApproved = true;
            chargeArmed = true;
            await button.click({ timeout: timeoutMs, noWaitAfter: true });
            // Dismissal/HTTP success does not prove a posted charge or no next dialog.
            await page.waitForTimeout(1_500);
            dialogs = await windows.evaluateAll((items) => items.map((item) => item.innerText.trim())).catch(() => []);
            fee = dialogs.some((value) => /penalt|fee|charge|deposit/i.test(value));
          }
        }
      }
    }
    if (chargeApproved && chargeDispatched && !chargeResponse) {
      chargeResponse = await page.waitForResponse((item) => item.request() === chargeRequest,
        { timeout: Math.min(10_000, timeoutMs) }).catch(() => null);
    }
    action.check();
    // A dismissed dialog or a 200 response does not prove that HMS posted the charge.
    const chargeUnconfirmed = chargeApproved;
    return { outcome: chargeUnconfirmed ? 'fee_accepted_unconfirmed' : zeroNotice ? 'zero_notice_awaiting_readback' : fee ? 'fee_dialog_pending' : dispatched && response?.status() === 200 &&
      !nativeDialog && !dialogs.length && !blocked.length && !sendRequests
      ? 'awaiting_readback' : dispatched ? 'uncertain' : 'not_dispatched',
    httpStatus: response?.status() || null, reason: reasonLabel, requestDispatched: dispatched,
    dispatchCallbacksDrained: pendingDispatch === 0, dialogs, nativeDialog, blockedRequests: blocked,
    browserSendRequests: sendRequests, penaltyText: chargeText, chargeApproved, chargeDispatched,
    ...(zeroNotice ? { zeroPenaltyNotice } : {}) };
  } catch (error) {
    armed = false;
    return { outcome: chargeText ? chargeApproved ? 'fee_accepted_unconfirmed' : 'fee_dialog_pending'
      : dispatched ? 'uncertain' : 'not_dispatched', issue: issue(error), penaltyText: chargeText,
      httpStatus: response?.status() || null, requestDispatched: dispatched, dispatchCallbacksDrained: pendingDispatch === 0,
      nativeDialog, blockedRequests: blocked, browserSendRequests: sendRequests };
  } finally {
    page.off?.('response', captureChargeResponse);
    if (interactionStarted) fence?.quarantine();
    scope?.close();
  } })();
  try { return await Promise.race([work, action.interrupted]); }
  finally { action.finish(); }
}
