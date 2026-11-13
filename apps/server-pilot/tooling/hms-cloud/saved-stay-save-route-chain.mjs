// One exact saved-record Save may pass; keep every other context request fenced.
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { isSavedChildStageRequestGate, SAVED_CHILD_STAGE_PATHS } from './saved-stay-child-request-gate.mjs';
import { isSavedRoomStageRequestGate, SAVED_ROOM_STAGE_PATHS } from './saved-stay-room-stage-gate.mjs';
import { isSavedRateStageRequestGate, SAVED_RATE_STAGE_PATHS } from './saved-stay-rate-stage-gate.mjs';
import { isSavedGuaranteeRequestGate, SAVED_GUARANTEE_PATH } from './saved-stay-guarantee-request-gate.mjs';

const SAVE_PATH = '/web/base/OSRESV.HDR';
const AVAILABILITY_PATH = '/web/base/OSRESV.HDR.getcheckavailability';
const DANGEROUS_PATH = /save|delete|cancel|checkin|checkout|send|email|mail|crs/i;
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const neverDispatchedCreateProofs = new WeakMap();
const rateReadCapabilities = new WeakMap();
const RATE_DETAILS_PATH = '/web/base/OSRATD';
const RATE_DATA_PATH = '/api/internalBooking/HRCEN/rateshop/rateDetails';
const SELECTED_RATE_DATA_PATH = '/api/internalBooking/HRCEN/rateshop/selectedRates';

/** A native Rate Details read is a one-use exception, never a generic POST allowance. */
export function createSavedStayRateReadCapability(page, { frame, nativeStayId, bookingSessionId,
  mode = 'saved', timeoutMs = 30_000 } = {}) {
  if (!page || typeof page.context !== 'function' || !frame ||
      !/^\d{1,100}$/.test(nativeStayId || '') || typeof bookingSessionId !== 'string' ||
      !bookingSessionId.trim() || bookingSessionId.length > 256 || /[\p{Cc}]/u.test(bookingSessionId) ||
      !['saved', 'saved_direct', 'staged', 'selected'].includes(mode) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('RATE_READ_CAPABILITY_INVALID');
  }
  const capability = Object.freeze({});
  rateReadCapabilities.set(capability, { page, context: page.context(), frame, nativeStayId,
    bookingSessionId, mode, deadline: performance.now() + timeoutMs, opened: false, read: false, active: true });
  return capability;
}

export function closeSavedStayRateReadCapability(capability) {
  const state = rateReadCapabilities.get(capability);
  if (state) state.active = false;
}

/** Bind the native header as well as the exact frame, session and saved stay. */
export function consumeSavedStayRateReadCapability(capability, request, page) {
  const state = rateReadCapabilities.get(capability);
  try {
    if (!state?.active || state.read || state.page !== page || page.context() !== state.context ||
        request.frame() !== state.frame || performance.now() >= state.deadline) return false;
    const url = new URL(request.url()), method = request.method(), headers = request.headers();
    if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password || url.hash) return false;
    if (method === 'POST' && state.mode === 'saved' && !state.opened && url.pathname === RATE_DETAILS_PATH && !url.search) {
      const pairs = [...new URLSearchParams(request.postData() || '')], body = new Map(pairs.map(([k, v]) => [k.toLowerCase(), v]));
      const expected = { property: 'HRCEN', reservationstayid: state.nativeStayId, bookingsessionid: state.bookingSessionId,
        system_function_name: 'OSRATD', user_function_name: 'OSRATD' };
      if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(headers['content-type'] || '') ||
          pairs.length !== 5 || body.size !== 5 || !Object.entries(expected).every(([k, v]) => body.get(k) === v)) return false;
      state.opened = true;
      return true;
    }
    const pairs = [...url.searchParams], query = new Map(pairs);
    const dataPath = state.mode === 'selected' ? SELECTED_RATE_DATA_PATH : RATE_DATA_PATH;
    if (method !== 'GET' || url.pathname !== dataPath || request.postData?.() ||
        pairs.length !== query.size || headers.bookingclientsessionid !== state.bookingSessionId ||
        !/^\d{10,16}$/.test(query.get('_dc') || '')) return false;
    if (state.mode === 'saved' || state.mode === 'saved_direct' ?
      (state.mode === 'saved' && !state.opened) || query.size !== 2 || query.get('reservationStayID') !== state.nativeStayId :
      query.size !== 1 || !query.has('_dc')) return false;
    state.read = true;
    return true;
  } catch { return false; }
}

/** Run the exact read after the page-lifetime fence and before the shared context guard. */
export async function installSavedStayRateReadRouteChain(page, { frame, fence, scope, capability } = {}) {
  const state = rateReadCapabilities.get(capability);
  if (!state || state.page !== page || state.frame !== frame || typeof fence?.isQuarantined !== 'function' ||
      typeof scope?.allow !== 'function') throw new Error('RATE_READ_ROUTE_INVALID');
  const context = page.context(), candidates = new WeakSet(), continued = new WeakSet(), pending = new Set();
  let active = true;
  const contextRoute = async (route) => {
    const request = route.request();
    if (!active || !state.active || fence.isQuarantined() || !candidates.has(request) || continued.has(request)) return route.fallback();
    if (request.frame() !== frame || page.context() !== context || performance.now() >= state.deadline) return route.abort();
    continued.add(request);
    const operation = route.continue();
    pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  };
  const pageRoute = async (route) => {
    const request = route.request();
    let path;
    try { path = new URL(request.url()).pathname; } catch { return route.abort(); }
    if (![RATE_DETAILS_PATH, RATE_DATA_PATH, SELECTED_RATE_DATA_PATH].some((p) => p.toLowerCase() === path.toLowerCase())) return route.fallback();
    if (!active || fence.isQuarantined() || !consumeSavedStayRateReadCapability(capability, request, page) || !scope.allow(request)) return route.abort();
    candidates.add(request);
    return route.fallback();
  };
  await context.route('**/*', contextRoute);
  try { await page.route('**/*', pageRoute); }
  catch (error) { closeSavedStayRateReadCapability(capability); await context.unroute('**/*', contextRoute); throw error; }
  return Object.freeze({ close: async () => {
    active = false;
    closeSavedStayRateReadCapability(capability);
    await Promise.allSettled(pending);
    await page.unroute('**/*', pageRoute);
    await context.unroute('**/*', contextRoute);
  } });
}

// A proof can only originate from the exact disarmed native route below.
// Consume it once, and only for the same intercepted Request object.
export function consumeNeverDispatchedCreateProof(proof, request) {
  if (!proof || typeof proof !== 'object' || !neverDispatchedCreateProofs.has(proof) ||
      neverDispatchedCreateProofs.get(proof) !== request) return false;
  neverDispatchedCreateProofs.delete(proof);
  return true;
}

/**
 * Install after the shared context read-only guard and the page request fence.
 * The page handler always falls back for the one exact candidate so the lifetime
 * fence checks it before the context exception.
 */
export async function installLabtestSaveRouteChain(page, {
  frame,
  savePath = SAVE_PATH,
  fence,
  scope,
  isArmed,
  matches,
  authorizeCandidate,
  dispatchCandidate,
  onAuthorizationAttempt,
  childStageGate = null,
  roomStageGate = null,
  rateStageGate = null,
  guaranteeStageGate = null,
  onGuaranteeCandidate,
  isChildStageActive = () => false,
  availability = null,
  secondSave = null,
  thirdSave = null,
  onCandidate,
  onDispatch,
  onBlocked,
} = {}) {
  if (![SAVE_PATH, '/web/base/OSSTWZ.UpdateStayWizard'].includes(savePath) ||
      (savePath !== SAVE_PATH && (availability || secondSave || thirdSave || childStageGate || roomStageGate || rateStageGate || guaranteeStageGate)) ||
      !page || typeof page.route !== 'function' || typeof page.context !== 'function' || !frame ||
      typeof fence?.isQuarantined !== 'function' || typeof scope?.allow !== 'function' ||
      typeof isArmed !== 'function' || typeof matches !== 'function' ||
      (authorizeCandidate !== undefined && typeof authorizeCandidate !== 'function') ||
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function') ||
      (onAuthorizationAttempt !== undefined && typeof onAuthorizationAttempt !== 'function') ||
      typeof isChildStageActive !== 'function' ||
      [availability, secondSave, thirdSave].some((phase) => phase !== null && (!phase ||
        typeof phase.isArmed !== 'function' || typeof phase.matches !== 'function' ||
        typeof phase.dispatchCandidate !== 'function')) ||
      (thirdSave !== null && secondSave === null) ||
      (childStageGate !== null && !isSavedChildStageRequestGate(childStageGate)) ||
      (roomStageGate !== null && !isSavedRoomStageRequestGate(roomStageGate)) ||
      (rateStageGate !== null && !isSavedRateStageRequestGate(rateStageGate)) ||
      (guaranteeStageGate !== null && !isSavedGuaranteeRequestGate(guaranteeStageGate)) ||
      (onGuaranteeCandidate !== undefined && typeof onGuaranteeCandidate !== 'function')) {
    throw new Error('AMEND_ROUTE_CHAIN_INPUT_INVALID');
  }

  const context = page.context();
  let active = true;
  let candidateRequest = null;
  let authorizing = false;
  let dispatching = false;
  let continuedRequest = null;
  let availabilityRequest = null, continuedAvailability = null;
  let secondRequest = null, continuedSecond = null, primarySucceeded = false;
  let thirdRequest = null, continuedThird = null, secondarySucceeded = false;
  const pendingCallbacks = new Set();
  const trackCallback = (callback) => {
    const pending = Promise.resolve().then(callback);
    pendingCallbacks.add(pending);
    void pending.then(() => pendingCallbacks.delete(pending), () => pendingCallbacks.delete(pending));
    return pending;
  };
  const childCandidates = new WeakSet(), continuedChildren = new WeakSet();
  const roomCandidates = new WeakSet(), continuedRooms = new WeakSet();
  const rateCandidates = new WeakSet(), continuedRates = new WeakSet();
  const guaranteeCandidates = new WeakSet(), continuedGuarantees = new WeakSet();
  let finishDispatch;
  const dispatchFinished = new Promise((resolve) => { finishDispatch = resolve; });
  let finishAvailability, finishSecond, finishThird;
  const availabilityFinished = new Promise((resolve) => { finishAvailability = resolve; });
  const secondFinished = new Promise((resolve) => { finishSecond = resolve; });
  const thirdFinished = new Promise((resolve) => { finishThird = resolve; });
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
    const isAvailability = availability && availabilityRequest === request && continuedAvailability !== request;
    const isSecond = secondSave && secondRequest === request && continuedSecond !== request;
    const isThird = thirdSave && thirdRequest === request && continuedThird !== request;
    const phase = isAvailability ? availability : isThird ? thirdSave : isSecond ? secondSave : { isArmed, dispatchCandidate, onDispatch };
    if (active && !dispatching && (isAvailability || isSecond || isThird ||
        (candidateRequest === request && continuedRequest !== request)) &&
        isSameFrame(request) && phase.isArmed() && !fence.isQuarantined()) {
      dispatching = true;
      let wrapperFinished = false;
      let attempted = false;
      let continuationSettled = false;
      let continuationSucceeded = false;
      let wrapperSucceeded = false;
      // The server wrapper must await this function while holding any source locks.
      // A delayed or repeated call cannot dispatch after it has returned.
      const continueOnce = () => {
        const task = trackCallback(async () => {
          if (wrapperFinished || attempted || !active || !phase.isArmed() || fence.isQuarantined() || !isSameFrame(request) ||
              (isAvailability && !availability.matches(request, frame)) ||
              (isSecond && (!primarySucceeded || !secondSave.matches(request, frame))) ||
              (isThird && (!secondarySucceeded || !thirdSave.matches(request, frame)))) {
            throw new Error('SAVE_DISPATCH_NOT_AUTHORIZED');
          }
          attempted = true;
          if (isAvailability) continuedAvailability = request;
          else if (isThird) continuedThird = request;
          else if (isSecond) continuedSecond = request;
          else continuedRequest = request;
          phase.onDispatch?.(request);
          try {
            const result = await route.continue();
            continuationSucceeded = true;
            return result;
          } finally { continuationSettled = true; }
        });
        // A buggy wrapper may fail to await the continuation. Its rejection is
        // still returned to a correct caller without becoming unhandled.
        void task.catch(() => {});
        return task;
      };
      let noDispatchProved = false;
      continueOnce.proveNeverDispatched = () => {
        // Create has no effectful child route. Once disarmed, this exact Save
        // and any pending continuation are unable to reach route.continue().
        if (isAvailability || isSecond || isThird || childStageGate || roomStageGate || rateStageGate || guaranteeStageGate ||
            wrapperFinished || attempted || continuedRequest || noDispatchProved) return null;
        active = false;
        noDispatchProved = true;
        const proof = Object.freeze({});
        neverDispatchedCreateProofs.set(proof, request);
        return proof;
      };
      try {
        const result = phase.dispatchCandidate ? await phase.dispatchCandidate(request, continueOnce) : await continueOnce();
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
        if (isAvailability) finishAvailability(wrapperSucceeded);
        else if (isThird) finishThird(wrapperSucceeded);
        else if (isSecond) { secondarySucceeded = wrapperSucceeded; finishSecond(wrapperSucceeded); }
        else { primarySucceeded = wrapperSucceeded; finishDispatch(wrapperSucceeded); }
      }
    }
    if (active && guaranteeStageGate && guaranteeCandidates.has(request) && !continuedGuarantees.has(request) &&
        isSameFrame(request) && isChildStageActive() && guaranteeStageGate.isActive() && !fence.isQuarantined()) {
      continuedGuarantees.add(request);
      try {
        onGuaranteeCandidate?.(request);
        return await guaranteeStageGate.dispatch(request, () => route.continue());
      } catch { observeBlocked(request); return route.abort().catch(() => {}); }
    }
    if (active && childStageGate && childCandidates.has(request) && !continuedChildren.has(request) &&
        isSameFrame(request) && isChildStageActive() && childStageGate.isActive() && !fence.isQuarantined()) {
      continuedChildren.add(request);
      // The bounded child gate has verified the frame, stay and requested ages.
      return route.continue();
    }
    if (active && roomStageGate && roomCandidates.has(request) && !continuedRooms.has(request) &&
        isSameFrame(request) && isChildStageActive() && roomStageGate.isActive() && !fence.isQuarantined()) {
      continuedRooms.add(request);
      return route.continue();
    }
    if (active && rateStageGate && rateCandidates.has(request) && !continuedRates.has(request) &&
        isSameFrame(request) && isChildStageActive() && rateStageGate.isActive() && !fence.isQuarantined()) {
      continuedRates.add(request);
      if (!rateStageGate.isRequest('validation', request)) return route.continue();
      try {
        // Validate the read before releasing it: the native rate change is a synchronous XHR.
        const response = await route.fetch({ maxRedirects: 0 }), body = await response.text();
        if (!active || !isChildStageActive() || fence.isQuarantined() ||
            !rateStageGate.verifyValidation(response.status(), body)) throw new Error('RATE_VALIDATION_UNVERIFIED');
        return route.fulfill({ response, body });
      } catch {
        observeBlocked(request);
        return route.abort();
      }
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
    if (url.pathname.toLowerCase() === AVAILABILITY_PATH.toLowerCase()) {
      let allowed = false;
      try {
        allowed = Boolean(active && availability && availabilityRequest === null && availability.isArmed() &&
          !fence.isQuarantined() && isSameFrame(request) && availability.matches(request, frame) && scope.allow(request));
      } catch { /* The lifetime fence remains closed. */ }
      if (!allowed) { observeBlocked(request); return route.abort(); }
      availabilityRequest = request;
      try { availability.onCandidate?.(request); } catch { /* The request stays fenced. */ }
      return route.fallback();
    }
    if (url.pathname.toLowerCase() === SAVED_GUARANTEE_PATH.toLowerCase()) {
      let allowed = false;
      try {
        allowed = Boolean(active && guaranteeStageGate && isChildStageActive() && guaranteeStageGate.isActive() &&
          !fence.isQuarantined() && isSameFrame(request) && guaranteeStageGate.consume(request) && scope.allow(request));
      } catch { /* Refuse without the exact one-use gate and page fence. */ }
      if (!allowed) { observeBlocked(request); return route.abort(); }
      guaranteeCandidates.add(request);
      return route.fallback();
    }
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
    const roomPath = SAVED_ROOM_STAGE_PATHS.some((path) => path.toLowerCase() === url.pathname.toLowerCase());
    const ratePath = SAVED_RATE_STAGE_PATHS.some((path) => path.toLowerCase() === url.pathname.toLowerCase());
    if (roomPath || ratePath) {
      let allowed = false, gate = null;
      try {
        gate = roomPath && roomStageGate?.isActive() ? roomStageGate : ratePath && rateStageGate?.isActive() ? rateStageGate : null;
        allowed = Boolean(active && gate && isChildStageActive() && !fence.isQuarantined() &&
          isSameFrame(request) && gate.consume(request) && scope.allow(request));
      } catch { /* The page fence remains closed. */ }
      if (!allowed) { observeBlocked(request); return route.abort(); }
      if (gate === roomStageGate) roomCandidates.add(request); else rateCandidates.add(request);
      return route.fallback();
    }
    if (SAFE_READ_METHODS.has(method) && url.pathname.toLowerCase() === savePath.toLowerCase()) {
      // The lifetime fence rejects every non-approved request to this path,
      // including GET/HEAD reads. Count before falling through so a blocked
      // record refresh after dispatch cannot look like a clean save response.
      observeBlocked(request);
      return route.fallback();
    }
    const safeRead = SAFE_READ_METHODS.has(method) && url.pathname &&
      !DANGEROUS_PATH.test(url.pathname) &&
      !(url.pathname === savePath && /^(SAVE|DELETE)$/i.test(pageAction));
    if (safeRead) return route.fallback();

    if (url.pathname === savePath) {
      if (active && thirdSave && secondarySucceeded && thirdRequest === null && thirdSave.isArmed() &&
          !fence.isQuarantined() && isSameFrame(request) && thirdSave.matches(request, frame)) {
        let allowed = false;
        try { allowed = scope.allow(request); } catch { /* The lifetime fence remains closed. */ }
        if (allowed) {
          thirdRequest = request;
          try { thirdSave.onCandidate?.(request); } catch { /* The request stays fenced. */ }
        } else observeBlocked(request);
        return route.fallback();
      }
      if (active && secondSave && primarySucceeded && secondRequest === null && secondSave.isArmed() &&
          !fence.isQuarantined() && isSameFrame(request) && secondSave.matches(request, frame)) {
        let allowed = false;
        try { allowed = scope.allow(request); } catch { /* The lifetime fence remains closed. */ }
        if (allowed) {
          secondRequest = request;
          try { secondSave.onCandidate?.(request); } catch { /* The request stays fenced. */ }
        } else observeBlocked(request);
        return route.fallback();
      }
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

  // Register before invoking an effectful route. A drain also tracks its
  // asynchronous wrapper and any unawaited native continuation.
  const trackEffectfulRoute = (handler) => (route) => {
    let path;
    try { path = new URL(route.request().url()).pathname.toLowerCase(); }
    catch { return handler(route); }
    return path === savePath.toLowerCase() || path === AVAILABILITY_PATH.toLowerCase() || path === SAVED_GUARANTEE_PATH.toLowerCase() ||
      [...SAVED_CHILD_STAGE_PATHS, ...SAVED_ROOM_STAGE_PATHS, ...SAVED_RATE_STAGE_PATHS].some((item) => item.toLowerCase() === path)
      ? trackCallback(() => handler(route)) : handler(route);
  };
  const trackedContextRoute = trackEffectfulRoute(contextRoute);
  const trackedPageRoute = trackEffectfulRoute(pageRoute);
  let contextInstalled = false;
  let pageInstalled = false;
  try {
    // Registered after installReadOnlyGuard(context): only the exact candidate
    // may continue; unapproved mutations/send paths are denied context-wide.
    await context.route('**/*', trackedContextRoute);
    contextInstalled = true;
    await page.route('**/*', trackedPageRoute);
    pageInstalled = true;
  } catch (error) {
    active = false;
    if (pageInstalled) await page.unroute('**/*', trackedPageRoute).catch(() => {});
    if (contextInstalled) await context.unroute('**/*', trackedContextRoute).catch(() => {});
    throw error;
  }

  return {
    candidate: () => candidateRequest,
    continued: () => continuedRequest,
    waitForDispatch: () => dispatchFinished,
    waitForAvailability: () => availabilityFinished,
    waitForSecond: () => secondFinished,
    waitForThird: () => thirdFinished,
    disarm: () => { active = false; },
    async drain({ timeoutMs = 5_000 } = {}) {
      active = false;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
      const deadline = performance.now() + timeoutMs;
      while (pendingCallbacks.size) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        let timer;
        const settled = await Promise.race([
          Promise.allSettled(pendingCallbacks).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
        clearTimeout(timer);
        if (!settled) return false;
      }
      return true;
    },
    async close() {
      active = false;
      // Keep both deny routes for the context lifetime. Only the one exact
      // candidate was ever eligible for the temporary context exception.
    },
  };
}
