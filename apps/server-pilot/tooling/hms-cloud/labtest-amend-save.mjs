// Shared one-save lifecycle for fenced saved Labtest amendments.
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { isSavedChildStageRequestGate, SAVED_CHILD_STAGE_PATHS } from './saved-stay-child-request-gate.mjs';
import { isSavedRoomStageRequestGate, SAVED_ROOM_STAGE_PATHS } from './saved-stay-room-stage-gate.mjs';
import { isSavedRateStageRequestGate, SAVED_RATE_STAGE_PATHS } from './saved-stay-rate-stage-gate.mjs';
import { parseNativePricingJson } from './saved-stay-nightly-rates.mjs';

/** Native loadVault only initializes the card iframe. This POST remains aborted. */
export function isNativeCardEntryInitialization(request) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData?.() || '');
    const keys = ['parentUrl', 'vaultUrl', 'iframeID', 'token', 'readOnlyFlag', 'ccFormat', 'frame', 'requestToken', 'browserTabID'];
    return request.method() === 'POST' && url.origin === 'https://hmsvault.hms.eu1.inforcloudsuite.com' &&
      !url.username && !url.password && !url.hash && url.pathname === '/Vault/servlets/showCardEntryHandler' &&
      keys.every((key) => url.searchParams.getAll(key).length === 1) && body.getAll('binranges').length === 1 &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '');
  } catch { return false; }
}

/** Native hdr_getTaxRelatedValues refreshes five UI parameters; it remains aborted. */
export function isNativeTaxValuesRead(request, frame, expected) {
  try {
    const keys = ['reservationstayid', 'propertycode', 'arrivaldate', 'departuredate', 'currency'];
    if (!expected || !keys.every(key => Object.hasOwn(expected, key)) ||
        !/^\d{1,100}$/.test(expected.reservationstayid || '') || expected.propertycode !== 'HRCEN' ||
        !/^[A-Z]{3}$/.test(expected.currency || '') ||
        !['arrivaldate', 'departuredate'].every(key => /^\d{2}\/\d{2}\/\d{4} 00:00$/.test(expected[key] || ''))) return false;
    const url = new URL(request.url()), headers = request.headers(), body = new URLSearchParams(request.postData?.() || '');
    return request.method() === 'POST' && request.frame() === frame && url.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com' &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/web/base/OSRESV.HDR.gettaxrelatedvalues' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(headers['content-type'] || '') &&
      headers['request-type'] === 'XMLHTTP' && headers['request-source'] === 'XMLHTTP' &&
      keys.every(key => body.getAll(key).length === 1 && body.get(key) === expected[key]);
  } catch { return false; }
}

const SAVE_PATH = '/web/base/OSRESV.HDR';
const AVAILABILITY_PATH = '/web/base/OSRESV.HDR.getcheckavailability';
const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const usedPages = new WeakSet();
const stageContexts = new WeakSet();
export const isLabtestAmendStageContext = (value) => Boolean(value && stageContexts.has(value));

/** Match Check Availability to the selected stay and the staged business fields. */
export function matchesLabtestAvailability(request, frame, snapshot, { recipient = '', guestEmail = '', cmsSend = false,
  cmsMessageId = '', expected = null, allowRealGuest = false } = {}) {
  try {
    const data = snapshot?.data, url = new URL(request.url());
    if (!data || typeof data !== 'object' || Array.isArray(data) || request.method() !== 'POST' ||
        request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== AVAILABILITY_PATH || url.search || url.hash ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        typeof recipient !== 'string' || typeof guestEmail !== 'string' || typeof cmsMessageId !== 'string' ||
        typeof cmsSend !== 'boolean' || (!allowRealGuest && cmsSend)) return false;
    const body = new URLSearchParams(request.postData() || ''), fields = new Map();
    for (const [key, value] of body) {
      const name = key.toLowerCase();
      if (!fields.has(name)) fields.set(name, []);
      fields.get(name).push(value);
    }
    const exact = (key, value) => Object.hasOwn(data, key) && String(data[key] ?? '') === String(value ?? '') &&
      fields.get(key.toLowerCase())?.length === 1 && fields.get(key.toLowerCase())[0] === String(value ?? '');
    const firstName = expected?.firstName ?? 'Proof', lastName = expected?.lastName ?? 'Labtest';
    if (!allowRealGuest && (firstName !== 'Proof' || lastName !== 'Labtest')) return false;
    const fixed = { propertycode: 'HRCEN', firstname: firstName, lastname: lastName, status: 'Reserved',
      guaranteetype: expected?.guaranteeCode ?? 'NGI', udfchar13: recipient, emailaddress: guestEmail,
      ...(expected ? { confirmationnumber: expected.confirmation, reservationstayid: expected.reservationStayId,
        reservationid: expected.reservationId, recordid: expected.recordId, guestid: expected.guestId,
        arrivaldate: `${expected.arrival.slice(5, 7)}/${expected.arrival.slice(8, 10)}/${expected.arrival.slice(0, 4)}`,
        departuredate: `${expected.departure.slice(5, 7)}/${expected.departure.slice(8, 10)}/${expected.departure.slice(0, 4)}`,
        roomtype: expected.roomType, rateplan: expected.ratePlan, adults: expected.adults,
        ...(expected.children !== undefined ? { children: expected.children } : {}) } : {}) };
    if (!Object.entries(fixed).every(([key, value]) => value !== undefined && exact(key, value)) ||
        !/^\d{6,}-\d+$/.test(String(data.confirmationnumber ?? '')) || !/^\d+$/.test(String(data.guestid ?? ''))) return false;
    const yes = (value) => [true, 1, '1', 'true', 'on', 'yes', 'Y'].includes(value);
    if (yes(data.udfchkbox04) !== cmsSend || fields.get('udfchkbox04')?.length !== 1 ||
        yes(fields.get('udfchkbox04')[0]) !== cmsSend ||
        (cmsMessageId && !exact('udfchar09', cmsMessageId))) return false;
    if (expected && Array.isArray(expected.childAges)) {
      const ages = String(data.childages ?? '').trim();
      const actual = ages ? ages.split(',').map(Number).sort((a, b) => a - b) : [];
      if (JSON.stringify(actual) !== JSON.stringify([...expected.childAges].sort((a, b) => a - b))) return false;
    }
    return true;
  } catch { return false; }
}

export const labtestAmendIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')
  ? error.message
  : 'AMEND_UNVERIFIED';

export function labtestAmendOutcome({
  dispatched, possiblyDispatched, httpStatus, nativeDialog, dialogs, blockedAfterDispatch,
}) {
  if (dispatched && httpStatus === 200 && !nativeDialog && dialogs === 0 && blockedAfterDispatch === 0) {
    return 'awaiting_readback';
  }
  return possiblyDispatched ? 'uncertain' : 'not_dispatched';
}

/** One observed HMS question, not generic permission to answer any dialog. */
const RETAIN_QUESTION = 'Retain the current rates?';
const EXTEND_OVERRIDE_QUESTION = 'Extend the Rate Overrides to the new Dates?';
function isNativeRateQuestion(body, handler, message) {
  const data = body?.pageData, messages = data?.messages;
  if (!data || data.success !== false || !Array.isArray(messages) || messages.length !== 1) return false;
  const question = messages[0];
  return Boolean(question && typeof question === 'object' && !Array.isArray(question) &&
    question.type === 'question' && question.questiontype === 'YesNoCancel' &&
    question.handler === handler && question.msg === message);
}
export const isRetainRatesQuestion = body => isNativeRateQuestion(body, 'confirmRetainRates', RETAIN_QUESTION);
export const isExtendOverrideRatesQuestion = body => isNativeRateQuestion(body, 'confirmExtendOverrideRate', EXTEND_OVERRIDE_QUESTION);

export function isRetainRatesSaveSuccess(body) {
  const data = body?.pageData;
  const messages = data?.messages;
  const saved = Array.isArray(messages) && messages.length === 1 && messages[0] &&
    typeof messages[0] === 'object' && !Array.isArray(messages[0]) &&
    messages[0].type === 'confirm' && messages[0].msg === 'The record was successfully saved.';
  return Boolean(data && data.success === true && (messages === undefined ||
    (Array.isArray(messages) && messages.length === 0) || saved));
}

/** Verify the whole visible question before choosing the exact previously approved answer. */
async function nativeRateQuestionButton(frame, choice, bounded, questionText) {
  const dialogs = frame.locator('.x-window:visible:not(.x-menu)');
  await bounded(dialogs.first().waitFor({ state: 'visible', timeout: 5_000 }));
  if (await bounded(dialogs.count()) !== 1) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  const dialog = dialogs.first(), question = dialog.getByText(questionText, { exact: true });
  const text = (await bounded(dialog.innerText())).replace(/\s+/g, ' ').trim();
  if (await bounded(question.count()) !== 1 || !(await bounded(question.first().isVisible())) ||
      text !== `${questionText} Yes No Cancel`) {
    throw new Error('RETAIN_DIALOG_UNVERIFIED');
  }
  const buttons = dialog.locator('a.x-btn:visible');
  if (await bounded(buttons.count()) !== 3) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  const yes = buttons.filter({ hasText: /^\s*Yes\s*$/i });
  const no = buttons.filter({ hasText: /^\s*No\s*$/i });
  const cancel = buttons.filter({ hasText: /^\s*Cancel\s*$/i });
  if (await bounded(yes.count()) !== 1 || await bounded(no.count()) !== 1 || await bounded(cancel.count()) !== 1) {
    throw new Error('RETAIN_DIALOG_UNVERIFIED');
  }
  // Locators resolve at click time. Keep the question, button set and absence
  // of other dialogs in the locator, rather than retaining `dialogs.first()`
  // which could resolve to a replacement dialog after the async snapshot.
  const exactMessage = frame.getByText(questionText, { exact: true });
  const guardedDialog = frame.locator('body').filter({ hasNot: dialogs.nth(1) })
    .locator('.x-window:visible:not(.x-menu)')
    .filter({ has: exactMessage, hasNot: exactMessage.nth(1),
      hasNotText: /penalt|fee/i })
    .filter({ hasNot: frame.locator('a.x-btn:visible').nth(3) })
    .filter({ has: frame.locator('a.x-btn:visible').filter({ hasText: /^\s*Yes\s*$/i }) })
    .filter({ has: frame.locator('a.x-btn:visible').filter({ hasText: /^\s*No\s*$/i }) })
    .filter({ has: frame.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/i }) });
  return guardedDialog.locator('a.x-btn:visible')
    .filter({ hasText: choice === 'yes' ? /^\s*Yes\s*$/i : /^\s*No\s*$/i });
}

/**
 * Use a real Playwright click. Recheck the question synchronously in the
 * capturing click event as well: a dialog can change after locator resolution
 * or between pointer-down and click. An unverified event is cancelled.
 */
async function clickNativeRateQuestionButton(frame, choice, bounded, questionText) {
  if (!['yes', 'no'].includes(choice) || ![RETAIN_QUESTION, EXTEND_OVERRIDE_QUESTION].includes(questionText) ||
      (questionText === EXTEND_OVERRIDE_QUESTION && choice !== 'yes')) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  const button = await nativeRateQuestionButton(frame, choice, bounded, questionText);
  const installed = await bounded(frame.evaluate(({ selected, questionText }) => {
    const key = '__navaRetainRatesClickGuard';
    if (Object.hasOwn(window, key)) return false;
    const state = { result: 'pending', handler: null };
    const visible = (node) => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    state.handler = (event) => {
      const dialogs = [...document.querySelectorAll('.x-window:not(.x-menu)')].filter(visible);
      const dialog = dialogs.length === 1 ? dialogs[0] : null;
      const messages = dialog ? [...dialog.querySelectorAll('*')].filter((node) => visible(node) &&
        node.innerText?.trim() === questionText &&
        ![...node.children].some((child) => visible(child) && child.innerText?.trim() === questionText)) : [];
      const buttons = dialog ? [...dialog.querySelectorAll('a.x-btn')].filter(visible) : [];
      const labels = buttons.map((node) => node.innerText.trim().toLowerCase());
      const target = event.target instanceof Element ? event.target.closest('a.x-btn') : null;
      const expected = selected === 'yes' ? 'yes' : 'no';
      const allowed = event.isTrusted && dialog && messages.length === 1 &&
        messages[0].innerText.trim() === questionText &&
        dialog.innerText.replace(/\s+/g, ' ').trim() === `${questionText} Yes No Cancel` && buttons.length === 3 &&
        ['yes', 'no', 'cancel'].every((label) => labels.filter((value) => value === label).length === 1) &&
        target && buttons.includes(target) && target.innerText.trim().toLowerCase() === expected;
      state.result = allowed ? 'allowed' : 'blocked';
      if (!allowed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window[key] = state;
    window.addEventListener('click', state.handler, true);
    return true;
  }, { selected: choice, questionText }));
  if (!installed) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  try {
    await bounded(button.click({ timeout: 5_000, noWaitAfter: true }));
    const result = await bounded(frame.evaluate(() => window.__navaRetainRatesClickGuard?.result));
    if (result !== 'allowed') throw new Error('RETAIN_DIALOG_UNVERIFIED');
  } finally {
    await bounded(frame.evaluate(() => {
      const key = '__navaRetainRatesClickGuard', state = window[key];
      if (state) { window.removeEventListener('click', state.handler, true); delete window[key]; }
    })).catch(() => {});
  }
}
export const clickRetainRatesButton = (frame, choice, bounded) => clickNativeRateQuestionButton(frame, choice, bounded, RETAIN_QUESTION);
export const clickExtendOverrideRatesButton = (frame, bounded) => clickNativeRateQuestionButton(frame, 'yes', bounded, EXTEND_OVERRIDE_QUESTION);

/**
 * `prepare` resolves saved-record identity and controls; `stage` changes only the
 * requested field; `matches` and `validate` bind one exact Save to that full draft.
 */
export async function runLabtestAmendSave(page, {
  timeoutMs = 20_000,
  signal,
  resultFields = {},
  reportBlockedTargets = false,
  reportDispatchDrain = false,
  dispatchDrainTimeoutMs = 5_000,
  prepareOnly = false,
  prepare,
  stage,
  matches,
  validate,
  dispatchCandidate,
  beforeSave,
  availability,
  retainRate,
  extendRate,
  stageDetails = () => ({}),
} = {}) {
  let returnedResult;
  const result = (outcome, details = {}) => (returnedResult = { outcome, ...resultFields, ...details });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return result('input_gap', { issue: 'INVALID_TIMEOUT' });
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    return result('input_gap', { issue: 'INVALID_SIGNAL' });
  }
  if (signal?.aborted) return result('not_dispatched', { issue: 'AMEND_ABORTED' });
  if (typeof reportDispatchDrain !== 'boolean' || !Number.isFinite(dispatchDrainTimeoutMs) || dispatchDrainTimeoutMs < 0 ||
      (reportDispatchDrain && dispatchDrainTimeoutMs === 0)) {
    return result('input_gap', { issue: 'INVALID_DRAIN_TIMEOUT' });
  }
  if (typeof prepareOnly !== 'boolean') return result('input_gap', { issue: 'INVALID_PREPARE_ONLY' });
  if (!page || typeof page.route !== 'function' || typeof page.locator !== 'function' ||
      typeof page.on !== 'function' || typeof page.off !== 'function') {
    return result('input_gap', { issue: 'PAGE_REQUIRED' });
  }
  if (usedPages.has(page)) return result('refused', { issue: 'PAGE_WRITE_ALREADY_USED' });
  if ([prepare, stage, matches, validate].some((callback) => typeof callback !== 'function') ||
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function') ||
      (beforeSave !== undefined && typeof beforeSave !== 'function')) {
    return result('input_gap', { issue: 'AMEND_CALLBACKS_INVALID' });
  }
  if (availability !== undefined && (!availability || typeof availability !== 'object' ||
      (!prepareOnly && typeof dispatchCandidate !== 'function') || typeof availability.dispatchCandidate !== 'function' ||
      typeof availability.snapshot !== 'function' || typeof availability.click !== 'function' ||
      typeof availability.validate !== 'function' ||
      (availability.recipient !== undefined && (typeof availability.recipient !== 'string' ||
        availability.recipient.length > 1000 || /[\p{Cc}]/u.test(availability.recipient))))) {
    return result('input_gap', { issue: 'AMEND_AVAILABILITY_CALLBACKS_INVALID' });
  }
  if (retainRate !== undefined && (!retainRate || typeof retainRate !== 'object' || prepareOnly ||
      !['yes', 'no'].includes(retainRate.choice) || typeof dispatchCandidate !== 'function' ||
      typeof retainRate.snapshot !== 'function' || typeof retainRate.matches !== 'function' ||
      typeof retainRate.dispatchCandidate !== 'function')) {
    return result('input_gap', { issue: 'AMEND_RETAIN_CALLBACKS_INVALID' });
  }
  if (extendRate !== undefined && (!extendRate || typeof extendRate !== 'object' || prepareOnly ||
      retainRate?.choice !== 'yes' || typeof extendRate.snapshot !== 'function' ||
      typeof extendRate.matches !== 'function' || typeof extendRate.dispatchCandidate !== 'function')) {
    return result('input_gap', { issue: 'AMEND_EXTEND_CALLBACKS_INVALID' });
  }

  let armed = false, possiblyDispatched = false, dispatched = false, blockedAtDispatch = 0;
  let blocked = 0, sendRequests = 0, blockedCardEntry = 0, blockedTaxValues = 0, nativeDialog = null, response = null, authorizedRequest = null;
  let stopReason = null, scope, fence, routeChain, prepared, staged, inStage = false, childStageGate = null, roomStageGate = null, rateStageGate = null;
  let routeSetupSettled = true;
  let availabilityArmed = false, availabilityRequest = null, availabilityDispatched = false, availabilitySnapshot = null;
  let retainArmed = false, retainRequest = null, retainDispatched = false, retainSnapshot = null;
  let extendArmed = false, extendRequest = null, extendDispatched = false, extendSnapshot = null;
  const blockedTargets = new Set();
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (reason) => {
    stopReason ||= reason;
    armed = false;
    availabilityArmed = false;
    retainArmed = false;
    extendArmed = false;
    inStage = false;
    childStageGate?.close();
    roomStageGate?.close();
    rateStageGate?.close();
    routeChain?.disarm();
    fence?.quarantine();
    signalStop({ reason });
  };
  const bounded = async (action) => {
    const result = await Promise.race([
      Promise.resolve(action).then((value) => ({ value })),
      stopped,
    ]);
    if (result.reason) throw new Error(result.reason);
    return result.value;
  };
  const diagnostics = () => ({
    httpStatus: response?.status() || null,
    blockedRequests: blocked,
    ...(reportBlockedTargets ? { blockedTargets: [...blockedTargets] } : {}),
    browserSendRequests: sendRequests,
    blockedCardEntryRequests: blockedCardEntry,
    ...(blockedTaxValues ? { blockedTaxMetadataReadRequests: blockedTaxValues } : {}),
    nativeDialog,
  });
  const details = () => {
    try {
      const value = stageDetails(staged);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const deadlineAt = performance.now() + timeoutMs;
  const withinDeadline = () => {
    if (!stopReason && performance.now() >= deadlineAt) stop('AMEND_TIMEOUT');
    return !nativeDialog && !stopReason;
  };
  const timer = setTimeout(() => stop('AMEND_TIMEOUT'), timeoutMs);
  const onAbort = () => stop('AMEND_ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const onDialog = (dialog) => {
    nativeDialog = { type: dialog.type() };
    stop('UNEXPECTED_DIALOG');
  };
  page.on('dialog', onDialog);

  try {
    prepared = await bounded(prepare(bounded));
    if (prepared?.unchanged) return result('unchanged');
    if (!prepared?.frame || !prepared?.save) throw new Error('AMEND_CONTROL_NOT_UNIQUE');

    const candidateGate = prepared.childStageGate ?? null;
    if (candidateGate !== null && !isSavedChildStageRequestGate(candidateGate)) throw new Error('CHILD_STAGE_GATE_INVALID');
    childStageGate = candidateGate;
    roomStageGate = prepared.roomStageGate ?? null;
    if (roomStageGate !== null && !isSavedRoomStageRequestGate(roomStageGate)) throw new Error('ROOM_STAGE_GATE_INVALID');
    rateStageGate = prepared.rateStageGate ?? null;
    if (rateStageGate !== null && !isSavedRateStageRequestGate(rateStageGate)) throw new Error('RATE_STAGE_GATE_INVALID');
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH, ...(availability ? [AVAILABILITY_PATH] : []),
      ...(childStageGate ? SAVED_CHILD_STAGE_PATHS : []), ...(roomStageGate ? SAVED_ROOM_STAGE_PATHS : []),
      ...(rateStageGate ? SAVED_RATE_STAGE_PATHS : [])]));
    scope = fence.open();
    routeSetupSettled = false;
    const routeSetup = installLabtestSaveRouteChain(page, {
      frame: prepared.frame,
      fence,
      scope,
      isArmed: () => !prepareOnly && armed && withinDeadline(),
      childStageGate,
      roomStageGate,
      rateStageGate,
      isChildStageActive: () => inStage && withinDeadline(),
      dispatchCandidate,
      availability: availability ? {
        isArmed: () => availabilityArmed && withinDeadline(),
        matches: (request, requestFrame) => matchesLabtestAvailability(request, requestFrame, availabilitySnapshot,
          { recipient: availability.recipient ?? '', guestEmail: availability.guestEmail ?? '',
            cmsSend: availability.cmsSend === true, cmsMessageId: availability.cmsMessageId ?? '',
            expected: availability.expected ?? null, allowRealGuest: availability.allowRealGuest === true }),
        dispatchCandidate: availability.dispatchCandidate,
        onCandidate: (request) => { availabilityRequest = request; if (!prepareOnly) possiblyDispatched = true; },
        onDispatch: () => { availabilityDispatched = true; },
      } : null,
      secondSave: retainRate ? {
        isArmed: () => retainArmed && withinDeadline(),
        matches: (request, requestFrame) => staged !== undefined && retainSnapshot !== null &&
          retainRate.matches(request, requestFrame, prepared, staged, retainSnapshot, retainRate.choice),
        dispatchCandidate: retainRate.dispatchCandidate,
        onCandidate: (request) => { retainRequest = request; possiblyDispatched = true; },
        onDispatch: () => { retainDispatched = true; retainArmed = false; },
      } : null,
      thirdSave: extendRate ? {
        isArmed: () => extendArmed && withinDeadline(),
        matches: (request, requestFrame) => staged !== undefined && extendSnapshot !== null &&
          extendRate.matches(request, requestFrame, prepared, staged, extendSnapshot),
        dispatchCandidate: extendRate.dispatchCandidate,
        onCandidate: (request) => { extendRequest = request; possiblyDispatched = true; },
        onDispatch: () => { extendDispatched = true; extendArmed = false; },
      } : null,
      matches: (request, requestFrame) => staged !== undefined &&
        matches(request, requestFrame, prepared, staged),
      onCandidate: (request) => {
        authorizedRequest = request;
        possiblyDispatched = true;
      },
      onDispatch: (request) => {
        if (request === authorizedRequest) {
          dispatched = true;
          blockedAtDispatch = blocked;
          armed = false;
        }
      },
      onBlocked: (request) => {
        // Native re-render attempts to initialize the unsupported card-entry UI.
        // It remains aborted. It cannot count as an unapproved HMS business write.
        if (isNativeCardEntryInitialization(request)) { blockedCardEntry += 1; return; }
        if (isNativeTaxValuesRead(request, prepared.frame, prepared.taxMetadataReadValues)) { blockedTaxValues += 1; return; }
        blocked += 1;
        inStage = false;
        childStageGate?.close();
        roomStageGate?.close();
        rateStageGate?.close();
        try {
          const url = new URL(request.url());
          if (/send|email|mail/i.test(url.pathname)) sendRequests += 1;
          const path = url.pathname.replace(/\/(?:\d{4,}|[0-9a-f-]{20,})(?=\/|$)/gi, '/[id]');
          if (reportBlockedTargets && blockedTargets.size < 8) blockedTargets.add(`${request.method()} ${path}`);
        } catch { /* Malformed request targets remain blocked and are not logged. */ }
      },
    }).then(async (chain) => {
      if (stopReason) {
        // A late route registration must not leave its exact-save exception armed.
        usedPages.add(page);
        chain.disarm();
        await chain.close();
        return null;
      }
      return chain;
    }).finally(() => { routeSetupSettled = true; });
    // A timed-out registration may reject after bounded() has stopped waiting.
    void routeSetup.catch(() => {});
    routeChain = await bounded(routeSetup);
    if (!routeChain) throw new Error(stopReason || 'AMEND_TIMEOUT');
    usedPages.add(page);

    inStage = true;
    const stageContext = Object.freeze({ page, frame: prepared.frame, childStageGate, roomStageGate, rateStageGate,
      allowRealGuest: prepared.allowRealGuest === true,
      baseline: prepared.enableComposedStage === true && prepared.baseline ? structuredClone(prepared.baseline) : null,
      isActive: () => inStage && blocked === 0 && withinDeadline() && !fence.isQuarantined(),
      remainingMs: () => Math.max(0, deadlineAt - performance.now()),
      stop,
    });
    stageContexts.add(stageContext);
    staged = await bounded(stage(bounded, prepared, stageContext));
    inStage = false;
    childStageGate?.close();
    roomStageGate?.close();
    rateStageGate?.close();
    const verification = blocked || nativeDialog
      ? { ok: false, issue: 'AMEND_DRAFT_CHANGED' }
      : await bounded(validate(bounded, prepared, staged));
    if (verification !== true && verification?.ok !== true) {
      return result('not_dispatched', {
        issue: verification?.issue || 'AMEND_DRAFT_CHANGED',
        ...diagnostics(),
        ...details(),
      });
    }

    if (availability) {
      availabilitySnapshot = structuredClone(await bounded(availability.snapshot(bounded, prepared, staged)));
      const blockedBeforeAvailability = blocked;
      const pendingAvailability = page.waitForResponse((item) => item.request() === availabilityRequest,
        { timeout: timeoutMs }).catch(() => null);
      availabilityArmed = true;
      await bounded(availability.click(bounded, prepared, staged));
      const availabilityResponse = await bounded(pendingAvailability);
      if (!availabilityDispatched || !availabilityResponse || availabilityResponse.status() !== 200 ||
          !(await bounded(routeChain.waitForAvailability())) || !withinDeadline()) throw new Error('AVAILABILITY_UNCERTAIN');
      availabilityArmed = false;
      const verified = await bounded(availability.validate(bounded, prepared, staged, availabilityResponse, { fence, scope }));
      if ((verified !== true && verified?.ok !== true) || blocked !== blockedBeforeAvailability || nativeDialog ||
          await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
        throw new Error(verified?.issue || 'AVAILABILITY_UNVERIFIED');
      }
    }

    // Prepare may reprice but can never arm Save.
    if (prepareOnly) return result('not_dispatched', {
      issue: 'PREPARE_ONLY', ...diagnostics(), ...details(),
    });

    if (beforeSave) await bounded(beforeSave(bounded, prepared, staged, { fence, scope }));
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs })
      .catch(() => null);
    armed = true;
    await bounded(prepared.save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    // The native response can precede the server wrapper's completion. A
    // wrapper failure or timeout after dispatch is uncertain, never success.
    if (dispatched) {
      const wrapperCompleted = await bounded(routeChain.waitForDispatch());
      // A blocked event loop may delay the timer past the monotonic deadline.
      if (!withinDeadline()) throw new Error(stopReason || 'AMEND_TIMEOUT');
      if (!wrapperCompleted) throw new Error('SAVE_DISPATCH_UNCERTAIN');
    }
    await bounded(page.waitForTimeout(500));
    if (!withinDeadline()) throw new Error(stopReason || 'AMEND_TIMEOUT');
    if (retainRate) {
      if (!dispatched || !response || response.status() !== 200 || blocked !== blockedAtDispatch || nativeDialog) {
        throw new Error('RETAIN_QUESTION_UNVERIFIED');
      }
      const firstResponse = response.text ? parseNativePricingJson(await bounded(response.text())) : await bounded(response.json());
      if (!isRetainRatesQuestion(firstResponse) && !isRetainRatesSaveSuccess(firstResponse)) throw new Error('RETAIN_QUESTION_UNVERIFIED');
      if (isRetainRatesQuestion(firstResponse)) {
      retainSnapshot = structuredClone(await bounded(retainRate.snapshot(bounded, prepared, staged, { fence, scope })));
      if (!withinDeadline() || blocked !== blockedAtDispatch || nativeDialog) throw new Error('RETAIN_QUESTION_UNVERIFIED');
      const pendingRetain = page.waitForResponse((item) => item.request() === retainRequest, { timeout: timeoutMs })
        .catch(() => null);
      retainArmed = true;
      await clickRetainRatesButton(prepared.frame, retainRate.choice, bounded);
      response = await bounded(pendingRetain);
      retainArmed = false;
      if (!retainDispatched || !response || response.status() !== 200 ||
          !(await bounded(routeChain.waitForSecond())) || !withinDeadline()) throw new Error('RETAIN_SAVE_UNVERIFIED');
      const retainResponse = response.text ? parseNativePricingJson(await bounded(response.text())) : await bounded(response.json());
      if (extendRate && isExtendOverrideRatesQuestion(retainResponse)) {
        await bounded(page.waitForTimeout(500));
        extendSnapshot = structuredClone(await bounded(extendRate.snapshot(bounded, prepared, staged, { fence, scope })));
        if (!withinDeadline() || blocked !== blockedAtDispatch || nativeDialog) throw new Error('EXTEND_OVERRIDE_QUESTION_UNVERIFIED');
        const pendingExtend = page.waitForResponse(item => item.request() === extendRequest, { timeout: timeoutMs }).catch(() => null);
        extendArmed = true;
        await clickExtendOverrideRatesButton(prepared.frame, bounded);
        response = await bounded(pendingExtend);
        extendArmed = false;
        if (!extendDispatched || !response || response.status() !== 200 ||
            !(await bounded(routeChain.waitForThird())) || !withinDeadline() ||
            !isRetainRatesSaveSuccess(response.text ? parseNativePricingJson(await bounded(response.text())) : await bounded(response.json()))) throw new Error('EXTEND_OVERRIDE_SAVE_UNVERIFIED');
      } else if (!isRetainRatesSaveSuccess(retainResponse)) throw new Error('RETAIN_SAVE_UNVERIFIED');
      await bounded(page.waitForTimeout(500));
      if (!withinDeadline()) throw new Error(stopReason || 'AMEND_TIMEOUT');
      }
    }
    const dialogs = await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count());
    const blockedAfterDispatch = Math.max(0, blocked - blockedAtDispatch);
    const outcome = labtestAmendOutcome({
      dispatched, possiblyDispatched, httpStatus: response?.status() || null,
      nativeDialog, dialogs, blockedAfterDispatch,
    });
    const outcomeDetails = {
      ...diagnostics(),
      blockedRequestsAfterDispatch: blockedAfterDispatch,
      ...details(),
      visibleDialogCount: dialogs,
    };
    // The timer may still be queued after an awaited operation or synchronous
    // result preparation crosses the monotonic lifecycle deadline.
    if (!withinDeadline()) throw new Error(stopReason || 'AMEND_TIMEOUT');
    return result(outcome, outcomeDetails);
  } catch (error) {
    armed = false;
    retainArmed = false;
    extendArmed = false;
    routeChain?.disarm();
    if (possiblyDispatched) fence?.quarantine();
    // A click can fail after native continuation but before the server wrapper
    // settles. Keep the caller waiting until that wrapper finishes or the same
    // lifecycle deadline stops us; neither outcome makes the Save certain.
    if (dispatched && routeChain && withinDeadline()) {
      try { await bounded(routeChain.waitForDispatch()); withinDeadline(); }
      catch { /* Preserve uncertainty when the wrapper is still pending. */ }
    }
    if (availabilityDispatched && routeChain && withinDeadline()) {
      try { await bounded(routeChain.waitForAvailability()); withinDeadline(); }
      catch { /* The rate hold or response may still be in flight. */ }
    }
    if (retainDispatched && routeChain && withinDeadline()) {
      try { await bounded(routeChain.waitForSecond()); withinDeadline(); }
      catch { /* The continuation can still be in flight; retain uncertainty. */ }
    }
    if (extendDispatched && routeChain && withinDeadline()) {
      try { await bounded(routeChain.waitForThird()); withinDeadline(); }
      catch { /* Keep the same hold uncertain while its final continuation is pending. */ }
    }
    return result(possiblyDispatched ? 'uncertain' : 'not_dispatched', {
      issue: stopReason || labtestAmendIssue(error),
      ...diagnostics(),
      ...details(),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    inStage = false;
    availabilityArmed = false;
    retainArmed = false;
    extendArmed = false;
    childStageGate?.close();
    armed = false;
    routeChain?.disarm();
    scope?.close();
    let drained = routeSetupSettled;
    if (routeChain && reportDispatchDrain) {
      try { drained = await routeChain.drain({ timeoutMs: dispatchDrainTimeoutMs }); }
      catch { drained = false; }
    }
    await routeChain?.close();
    if (reportDispatchDrain && returnedResult) {
      returnedResult.dispatchCallbacksDrained = drained;
      if (!drained) {
        fence?.quarantine();
        returnedResult.outcome = 'uncertain';
        returnedResult.issue = 'DISPATCH_CALLBACKS_UNDRAINED';
      }
    }
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
