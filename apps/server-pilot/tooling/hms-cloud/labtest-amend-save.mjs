// Shared one-save lifecycle for fenced saved Labtest amendments.
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();

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

/**
 * `prepare` resolves saved-record identity and controls; `stage` changes only the
 * requested field; `matches` and `validate` bind one exact Save to that full draft.
 */
export async function runLabtestAmendSave(page, {
  timeoutMs = 20_000,
  resultFields = {},
  reportBlockedTargets = false,
  prepare,
  stage,
  matches,
  validate,
  stageDetails = () => ({}),
} = {}) {
  const result = (outcome, details = {}) => ({ outcome, ...resultFields, ...details });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return result('input_gap', { issue: 'INVALID_TIMEOUT' });
  if (!page || typeof page.route !== 'function' || typeof page.locator !== 'function' ||
      typeof page.on !== 'function' || typeof page.off !== 'function') {
    return result('input_gap', { issue: 'PAGE_REQUIRED' });
  }
  if (usedPages.has(page)) return result('refused', { issue: 'PAGE_WRITE_ALREADY_USED' });
  if ([prepare, stage, matches, validate].some((callback) => typeof callback !== 'function')) {
    return result('input_gap', { issue: 'AMEND_CALLBACKS_INVALID' });
  }

  let armed = false, possiblyDispatched = false, dispatched = false, blockedAtDispatch = 0;
  let blocked = 0, sendRequests = 0, nativeDialog = null, response = null, authorizedRequest = null;
  let stopReason = null, scope, fence, routeChain, prepared, staged;
  const blockedTargets = new Set();
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (reason) => {
    stopReason ||= reason;
    armed = false;
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
  const timer = setTimeout(() => stop('AMEND_TIMEOUT'), timeoutMs);
  const onDialog = (dialog) => {
    nativeDialog = { type: dialog.type() };
    stop('UNEXPECTED_DIALOG');
  };
  page.on('dialog', onDialog);

  try {
    prepared = await bounded(prepare(bounded));
    if (prepared?.unchanged) return result('unchanged');
    if (!prepared?.frame || !prepared?.save) throw new Error('AMEND_CONTROL_NOT_UNIQUE');

    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    const routeSetup = installLabtestSaveRouteChain(page, {
      frame: prepared.frame,
      fence,
      scope,
      isArmed: () => armed && !nativeDialog && !stopReason,
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
    });
    routeChain = await bounded(routeSetup);
    if (!routeChain) throw new Error(stopReason || 'AMEND_TIMEOUT');
    usedPages.add(page);

    staged = await bounded(stage(bounded, prepared));
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

    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs })
      .catch(() => null);
    armed = true;
    await bounded(prepared.save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    await bounded(page.waitForTimeout(500));
    const dialogs = await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count());
    const blockedAfterDispatch = Math.max(0, blocked - blockedAtDispatch);
    return result(labtestAmendOutcome({
      dispatched, possiblyDispatched, httpStatus: response?.status() || null,
      nativeDialog, dialogs, blockedAfterDispatch,
    }), {
      ...diagnostics(),
      blockedRequestsAfterDispatch: blockedAfterDispatch,
      ...details(),
    });
  } catch (error) {
    armed = false;
    routeChain?.disarm();
    if (possiblyDispatched) fence?.quarantine();
    return result(possiblyDispatched ? 'uncertain' : 'not_dispatched', {
      issue: labtestAmendIssue(error),
      ...diagnostics(),
      ...details(),
    });
  } finally {
    clearTimeout(timer);
    armed = false;
    routeChain?.disarm();
    scope?.close();
    await routeChain?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
