// Shared one-save lifecycle for fenced saved Labtest amendments.
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { isSavedChildStageRequestGate, SAVED_CHILD_STAGE_PATHS } from './saved-stay-child-request-gate.mjs';

const SAVE_PATH = '/web/base/OSRESV.HDR';
const AVAILABILITY_PATH = '/web/base/OSRESV.HDR.getcheckavailability';
const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const usedPages = new WeakSet();
const stageContexts = new WeakSet();
export const isLabtestAmendStageContext = (value) => Boolean(value && stageContexts.has(value));

/** Check Availability holds a rate. Match the complete staged fake-stay model, not just a few fields. */
export function matchesLabtestAvailability(request, frame, snapshot) {
  try {
    const data = snapshot?.data, url = new URL(request.url());
    if (!data || typeof data !== 'object' || Array.isArray(data) || request.method() !== 'POST' ||
        request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== AVAILABILITY_PATH ||
        url.search || url.hash || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const keys = Object.keys(data), body = new URLSearchParams(request.postData() || ''), names = [...body.keys()];
    if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length ||
        new Set(names.map((key) => key.toLowerCase())).size !== names.length ||
        names.length !== keys.length + 1 || !names.includes('ONLY_DATA_REQUIRED') ||
        body.get('ONLY_DATA_REQUIRED') !== 'true' || names.some((name) => name !== 'ONLY_DATA_REQUIRED' && !Object.hasOwn(data, name))) return false;
    const fixed = { propertycode: 'HRCEN', firstname: 'Proof', lastname: 'Labtest', status: 'Reserved',
      guaranteetype: 'NGI', udfchkbox04: '0', udfchar13: '', emailaddress: '' };
    if (!Object.entries(fixed).every(([key, value]) => Object.hasOwn(data, key) && String(data[key]) === value) ||
        !/^\d{6,}-\d+$/.test(String(data.confirmationnumber ?? '')) || !/^\d+$/.test(String(data.guestid ?? ''))) return false;
    const day = (value) => {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ''));
      if (!match) return null;
      const iso = `${match[3]}-${match[1]}-${match[2]}`, parsed = new Date(`${iso}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
    };
    const arrival = day(data.arrivaldate), departure = day(data.departuredate);
    if (!arrival || !departure || arrival < '2027-01-01' || arrival >= departure) return false;
    return keys.every((key) => {
      let value = data[key];
      if (key === 'sessionID' && value && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).length === 1 && typeof value.sessionID === 'string') value = value.sessionID;
      else if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) return false;
      return body.get(key) === String(value ?? '');
    });
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
export function isRetainRatesQuestion(body) {
  const data = body?.pageData, messages = data?.messages;
  if (!data || data.success !== false || !Array.isArray(messages) || messages.length !== 1) return false;
  const question = messages[0];
  return Boolean(question && typeof question === 'object' && !Array.isArray(question) &&
    Object.keys(question).length === 4 && question.type === 'question' && question.questiontype === 'YesNoCancel' &&
    question.handler === 'confirmRetainRates' && question.msg === 'Retain the current rates?');
}

export function isRetainRatesSaveSuccess(body) {
  const data = body?.pageData;
  return Boolean(data && data.success === true && (data.messages === undefined ||
    (Array.isArray(data.messages) && data.messages.length === 0)));
}

/** Verify the whole visible question before choosing the exact previously approved answer. */
async function retainRatesButton(frame, choice, bounded) {
  const dialogs = frame.locator('.x-window:visible:not(.x-menu)');
  await bounded(dialogs.first().waitFor({ state: 'visible', timeout: 5_000 }));
  if (await bounded(dialogs.count()) !== 1) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  const dialog = dialogs.first(), question = dialog.getByText('Retain the current rates?', { exact: true });
  const text = (await bounded(dialog.innerText())).replace(/\s+/g, ' ').trim();
  if (await bounded(question.count()) !== 1 || !(await bounded(question.first().isVisible())) ||
      text !== 'Retain the current rates? Yes No Cancel') {
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
  const exactMessage = frame.getByText('Retain the current rates?', { exact: true });
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
export async function clickRetainRatesButton(frame, choice, bounded) {
  if (!['yes', 'no'].includes(choice)) throw new Error('RETAIN_DIALOG_UNVERIFIED');
  const button = await retainRatesButton(frame, choice, bounded);
  const installed = await bounded(frame.evaluate((selected) => {
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
        node.innerText?.trim() === 'Retain the current rates?' &&
        ![...node.children].some((child) => visible(child) && child.innerText?.trim() === 'Retain the current rates?')) : [];
      const buttons = dialog ? [...dialog.querySelectorAll('a.x-btn')].filter(visible) : [];
      const labels = buttons.map((node) => node.innerText.trim().toLowerCase());
      const target = event.target instanceof Element ? event.target.closest('a.x-btn') : null;
      const expected = selected === 'yes' ? 'yes' : 'no';
      const allowed = event.isTrusted && dialog && messages.length === 1 &&
        messages[0].innerText.trim() === 'Retain the current rates?' &&
        dialog.innerText.replace(/\s+/g, ' ').trim() === 'Retain the current rates? Yes No Cancel' && buttons.length === 3 &&
        ['yes', 'no', 'cancel'].every((label) => labels.filter((value) => value === label).length === 1) &&
        target && buttons.includes(target) && target.innerText.trim().toLowerCase() === expected;
      state.result = allowed ? 'allowed' : 'blocked';
      if (!allowed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window[key] = state;
    window.addEventListener('click', state.handler, true);
    return true;
  }, choice));
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
  availability,
  retainRate,
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
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function')) {
    return result('input_gap', { issue: 'AMEND_CALLBACKS_INVALID' });
  }
  if (availability !== undefined && (!availability || typeof availability !== 'object' || prepareOnly ||
      typeof dispatchCandidate !== 'function' || typeof availability.dispatchCandidate !== 'function' ||
      typeof availability.snapshot !== 'function' || typeof availability.click !== 'function' ||
      typeof availability.validate !== 'function')) {
    return result('input_gap', { issue: 'AMEND_AVAILABILITY_CALLBACKS_INVALID' });
  }
  if (retainRate !== undefined && (!retainRate || typeof retainRate !== 'object' || prepareOnly ||
      !['yes', 'no'].includes(retainRate.choice) || typeof dispatchCandidate !== 'function' ||
      typeof retainRate.snapshot !== 'function' || typeof retainRate.matches !== 'function' ||
      typeof retainRate.dispatchCandidate !== 'function')) {
    return result('input_gap', { issue: 'AMEND_RETAIN_CALLBACKS_INVALID' });
  }

  let armed = false, possiblyDispatched = false, dispatched = false, blockedAtDispatch = 0;
  let blocked = 0, sendRequests = 0, nativeDialog = null, response = null, authorizedRequest = null;
  let stopReason = null, scope, fence, routeChain, prepared, staged, inStage = false, childStageGate = null;
  let routeSetupSettled = true;
  let availabilityArmed = false, availabilityRequest = null, availabilityDispatched = false, availabilitySnapshot = null;
  let retainArmed = false, retainRequest = null, retainDispatched = false, retainSnapshot = null;
  const blockedTargets = new Set();
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (reason) => {
    stopReason ||= reason;
    armed = false;
    availabilityArmed = false;
    retainArmed = false;
    inStage = false;
    childStageGate?.close();
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
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH, ...(availability ? [AVAILABILITY_PATH] : []),
      ...(childStageGate ? SAVED_CHILD_STAGE_PATHS : [])]));
    scope = fence.open();
    routeSetupSettled = false;
    const routeSetup = installLabtestSaveRouteChain(page, {
      frame: prepared.frame,
      fence,
      scope,
      isArmed: () => !prepareOnly && armed && withinDeadline(),
      childStageGate,
      isChildStageActive: () => inStage && withinDeadline(),
      dispatchCandidate,
      availability: availability ? {
        isArmed: () => availabilityArmed && withinDeadline(),
        matches: (request, requestFrame) => matchesLabtestAvailability(request, requestFrame, availabilitySnapshot),
        dispatchCandidate: availability.dispatchCandidate,
        onCandidate: (request) => { availabilityRequest = request; possiblyDispatched = true; },
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
        blocked += 1;
        inStage = false;
        childStageGate?.close();
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
    const stageContext = Object.freeze({ page, frame: prepared.frame, childStageGate,
      baseline: prepared.enableComposedStage === true && prepared.baseline ? structuredClone(prepared.baseline) : null,
      isActive: () => inStage && blocked === 0 && withinDeadline() && !fence.isQuarantined(),
      remainingMs: () => Math.max(0, deadlineAt - performance.now()),
      stop,
    });
    stageContexts.add(stageContext);
    staged = await bounded(stage(bounded, prepared, stageContext));
    inStage = false;
    childStageGate?.close();
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

    // A prepare-only operation cannot dispatch even if a callback wrongly approves it.
    if (prepareOnly) return result('not_dispatched', {
      issue: 'PREPARE_ONLY', ...diagnostics(), ...details(),
    });

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
      const verified = await bounded(availability.validate(bounded, prepared, staged, availabilityResponse));
      if ((verified !== true && verified?.ok !== true) || blocked !== blockedBeforeAvailability || nativeDialog ||
          await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
        throw new Error(verified?.issue || 'AVAILABILITY_UNVERIFIED');
      }
    }

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
      if (!dispatched || !response || response.status() !== 200 || blocked !== blockedAtDispatch || nativeDialog ||
          !isRetainRatesQuestion(await bounded(response.json()))) throw new Error('RETAIN_QUESTION_UNVERIFIED');
      retainSnapshot = structuredClone(await bounded(retainRate.snapshot(bounded, prepared, staged)));
      if (!withinDeadline() || blocked !== blockedAtDispatch || nativeDialog) throw new Error('RETAIN_QUESTION_UNVERIFIED');
      const pendingRetain = page.waitForResponse((item) => item.request() === retainRequest, { timeout: timeoutMs })
        .catch(() => null);
      retainArmed = true;
      await clickRetainRatesButton(prepared.frame, retainRate.choice, bounded);
      response = await bounded(pendingRetain);
      retainArmed = false;
      if (!retainDispatched || !response || response.status() !== 200 ||
          !(await bounded(routeChain.waitForSecond())) || !withinDeadline() ||
          !isRetainRatesSaveSuccess(await bounded(response.json()))) throw new Error('RETAIN_SAVE_UNVERIFIED');
      await bounded(page.waitForTimeout(500));
      if (!withinDeadline()) throw new Error(stopReason || 'AMEND_TIMEOUT');
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
