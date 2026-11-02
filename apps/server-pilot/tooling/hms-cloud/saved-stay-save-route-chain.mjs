// One exact saved-record Save may pass; keep every other context request fenced.
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { isSavedChildStageRequestGate, SAVED_CHILD_STAGE_PATHS } from './saved-stay-child-request-gate.mjs';

const SAVE_PATH = '/web/base/OSRESV.HDR';
const DANGEROUS_PATH = /save|delete|cancel|checkin|checkout|send|email|mail|crs/i;
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Install after the shared context read-only guard and the page request fence.
 * The page handler always falls back for the one exact candidate so the lifetime
 * fence checks it before the context exception.
 */
export async function installLabtestSaveRouteChain(page, {
  frame,
  fence,
  scope,
  isArmed,
  matches,
  authorizeCandidate,
  dispatchCandidate,
  onAuthorizationAttempt,
  childStageGate = null,
  isChildStageActive = () => false,
  onCandidate,
  onDispatch,
  onBlocked,
} = {}) {
  if (!page || typeof page.route !== 'function' || typeof page.context !== 'function' || !frame ||
      typeof fence?.isQuarantined !== 'function' || typeof scope?.allow !== 'function' ||
      typeof isArmed !== 'function' || typeof matches !== 'function' ||
      (authorizeCandidate !== undefined && typeof authorizeCandidate !== 'function') ||
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function') ||
      (onAuthorizationAttempt !== undefined && typeof onAuthorizationAttempt !== 'function') ||
      typeof isChildStageActive !== 'function' ||
      (childStageGate !== null && !isSavedChildStageRequestGate(childStageGate))) {
    throw new Error('AMEND_ROUTE_CHAIN_INPUT_INVALID');
  }

  const context = page.context();
  let active = true;
  let candidateRequest = null;
  let authorizing = false;
  let dispatching = false;
  let continuedRequest = null;
  const childCandidates = new WeakSet(), continuedChildren = new WeakSet();
  let finishDispatch;
  const dispatchFinished = new Promise((resolve) => { finishDispatch = resolve; });
  const observeBlocked = (request) => {
    try { onBlocked?.(request); } catch { /* Diagnostics cannot weaken the route decision. */ }
  };
  const isSameFrame = (request) => {
    try { return request.frame() === frame; } catch { return false; }
  };
  const denyUnapprovedContextRequest = async (route, request) => {
    const method = String(request.method() || '').toUpperCase();
    let sendEmailPath = false;
    try {
      sendEmailPath = /send|email|mail/i.test(new URL(request.url()).pathname);
    } catch { /* Invalid write targets are still rejected by method below. */ }
    let sharedGuardWouldBlock = false;
    try {
      sharedGuardWouldBlock = shouldAbortReadOnlyRequest({
        method: request.method(),
        url: request.url(),
        postData: request.postData?.(),
      });
    } catch { /* Diagnostics cannot weaken the route decision. */ }
    if (!SAFE_READ_METHODS.has(method) || sendEmailPath || sharedGuardWouldBlock) {
      observeBlocked(request);
      return route.abort();
    }
    return route.fallback();
  };
  const contextRoute = async (route) => {
    const request = route.request();
    if (active && !dispatching && candidateRequest === request && continuedRequest !== request &&
        isSameFrame(request) && isArmed() && !fence.isQuarantined()) {
      dispatching = true;
      let wrapperFinished = false;
      let attempted = false;
      let continuationSettled = false;
      let continuationSucceeded = false;
      let wrapperSucceeded = false;
      // The server wrapper must await this function while holding any source locks.
      // A delayed or repeated call cannot dispatch after it has returned.
      const continueOnce = () => {
        const task = (async () => {
          if (wrapperFinished || attempted || !active || !isArmed() || fence.isQuarantined() || !isSameFrame(request)) {
            throw new Error('SAVE_DISPATCH_NOT_AUTHORIZED');
          }
          attempted = true;
          continuedRequest = request;
          onDispatch?.(request);
          try {
            const result = await route.continue();
            continuationSucceeded = true;
            return result;
          } finally { continuationSettled = true; }
        })();
        // A buggy wrapper may fail to await the continuation. Its rejection is
        // still returned to a correct caller without becoming unhandled.
        void task.catch(() => {});
        return task;
      };
      try {
        const result = dispatchCandidate ? await dispatchCandidate(request, continueOnce) : await continueOnce();
        wrapperFinished = true;
        if (!attempted) {
          observeBlocked(request);
          return route.abort();
        }
        if (!continuationSettled) throw new Error('SAVE_DISPATCH_NOT_AWAITED');
        if (!continuationSucceeded) throw new Error('SAVE_DISPATCH_UNCERTAIN');
        wrapperSucceeded = true;
        return result;
      } catch (error) {
        wrapperFinished = true;
        if (attempted) throw error; // May have dispatched; retain needs-check.
        observeBlocked(request);
        return route.abort();
      } finally {
        dispatching = false;
        // A native response can arrive before the server wrapper completes.
        // Surface its eventual result without an unhandled rejection.
        finishDispatch(wrapperSucceeded);
      }
    }
    if (active && childStageGate && childCandidates.has(request) && !continuedChildren.has(request) &&
        isSameFrame(request) && isChildStageActive() && childStageGate.isActive() && !fence.isQuarantined()) {
      continuedChildren.add(request);
      // Retain the shared read-only guard after the page-lifetime fence.
      return route.fallback();
    }
    // Deny unexpected mutations and send/email paths throughout this context,
    // including popup/other-page requests the page-local route cannot see.
    return denyUnapprovedContextRequest(route, request);
  };
  const pageRoute = async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); }
    catch {
      observeBlocked(request);
      return route.abort();
    }
    const method = String(request.method() || '').toUpperCase();
    const pageAction = url.searchParams.get('pageaction') || '';
    if (SAVED_CHILD_STAGE_PATHS.some((path) => path.toLowerCase() === url.pathname.toLowerCase())) {
      let allowed = false;
      try {
        allowed = Boolean(active && childStageGate && isChildStageActive() && childStageGate.isActive() &&
          !fence.isQuarantined() && isSameFrame(request) && childStageGate.consume(request) && scope.allow(request));
      } catch { /* Refuse when the exact-match gate or page fence fails. */ }
      if (!allowed) { observeBlocked(request); return route.abort(); }
      childCandidates.add(request);
      return route.fallback(); // The page fence consumes this exact Request object.
    }
    if (SAFE_READ_METHODS.has(method) && url.pathname.toLowerCase() === SAVE_PATH.toLowerCase()) {
      // The lifetime fence rejects every non-approved request to this path,
      // including GET/HEAD reads. Count before falling through so a blocked
      // record refresh after dispatch cannot look like a clean save response.
      observeBlocked(request);
      return route.fallback();
    }
    const safeRead = SAFE_READ_METHODS.has(method) && url.pathname &&
      !DANGEROUS_PATH.test(url.pathname) &&
      !(url.pathname === SAVE_PATH && /^(SAVE|DELETE)$/i.test(pageAction));
    if (safeRead) return route.fallback();

    if (url.pathname === SAVE_PATH) {
      if (active && !authorizing && candidateRequest === null && isArmed() && !fence.isQuarantined() && isSameFrame(request) &&
          matches(request, frame)) {
        let allowed = false;
        authorizing = true;
        try {
          if (authorizeCandidate) {
            try { onAuthorizationAttempt?.(request); } catch { /* Diagnostics cannot weaken the route decision. */ }
            if (await authorizeCandidate(request) !== true || !active || !isArmed() || fence.isQuarantined()) {
              observeBlocked(request);
              return route.fallback();
            }
          }
          allowed = scope.allow(request);
        } catch { /* The lifetime fence stays fail-closed. */ }
        finally { authorizing = false; }
        if (allowed) {
          candidateRequest = request;
          try { onCandidate?.(request); } catch { /* The authorized request is still fenced. */ }
        } else observeBlocked(request);
      } else observeBlocked(request);
      // The shared page fence consumes the single allowed Request object or blocks it.
      return route.fallback();
    }

    observeBlocked(request);
    return route.abort();
  };

  let contextInstalled = false;
  let pageInstalled = false;
  try {
    // Registered after installReadOnlyGuard(context): only the exact candidate
    // may continue; unapproved mutations/send paths are denied context-wide.
    await context.route('**/*', contextRoute);
    contextInstalled = true;
    await page.route('**/*', pageRoute);
    pageInstalled = true;
  } catch (error) {
    active = false;
    if (pageInstalled) await page.unroute('**/*', pageRoute).catch(() => {});
    if (contextInstalled) await context.unroute('**/*', contextRoute).catch(() => {});
    throw error;
  }

  return {
    candidate: () => candidateRequest,
    continued: () => continuedRequest,
    waitForDispatch: () => dispatchFinished,
    disarm: () => { active = false; },
    async close() {
      active = false;
      // Keep both deny routes for the context lifetime. Only the one exact
      // candidate was ever eligible for the temporary context exception.
    },
  };
}
