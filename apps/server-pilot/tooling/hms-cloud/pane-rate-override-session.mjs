import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { currentLabtestRecord } from './labtest-record.mjs';
import { expectedLabtestAmendRecord } from './pane-amend-session.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { compareSavedStayRateOverrideReadback, isPreparedSavedStayRateOverride, isSavedStayRateOverrideReview,
  matchesSavedStayRateOverrideRequest, readSavedStayRateReasons,
  compareSavedStayRateOverrideReason } from './saved-stay-rate-override.mjs';
import { readSavedStayNightlyRates } from './saved-stay-nightly-rates.mjs';

const UPDATE = '/web/base/OSSTWZ.UpdateStayWizard';
const labtestSessions = new WeakMap();
const recordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true,
  preserveUnsentRecipient: true, allowModelOnlyPrimaryPartyIds: true };
const isLabtest = selected => selected?.firstName === 'Proof' && selected?.lastName === 'Labtest' &&
  selected.arrival >= '2027-01-01';

function verifiedRecordOptions(record, allowRealGuest) {
  if (!allowRealGuest) return recordOptions;
  const fields = record?.details?.fields?.filter(field => field.name === 'guaranteetype');
  const code = record?.nativePreimage?.guaranteeCode, display = fields?.length === 1 ? fields[0].value : null;
  if (!/^[A-Z0-9]{1,20}$/.test(code || '') || typeof display !== 'string' || !display.trim()) {
    throw new Error('NATIVE_GUARANTEE_UNVERIFIED');
  }
  return { ...recordOptions, allowRealGuest: true, expectedGuarantee: { code, display } };
}

// Stable business fields only: session IDs and unrelated native form fields
// can change between browsers and do not define this review.
const visibleBusinessNames = ['sourceofbusinessdesc', 'reasonforstay', 'track', 'marketsegment', 'roomtypecharge',
  'caller', 'udfchar06', 'guestoptin4', 'billingreference'];
function preservedFields(selected, expected, state, fields) {
  const { source, propertyCode, confirmation, reservationStayId, reservationId, recordId, guestId,
    status, firstName, lastName, arrival, departure, roomType, ratePlan, adults, children, childAges } = selected;
  const visibleBusiness = {};
  for (const name of visibleBusinessNames) {
    const matches = Array.isArray(fields) ? fields.filter(field => field?.name === name) : [];
    if (matches.length === 1 && matches[0].value !== undefined) visibleBusiness[name] = matches[0].value;
  }
  return structuredClone({ source, propertyCode, confirmation, reservationStayId, reservationId, recordId, guestId,
    status, firstName, lastName, arrival, departure, roomType, ratePlan, adults, children, childAges,
    sourceBusinessCode: selected.sourceBusinessCode ?? null, visibleBusiness,
    note: expected.note, guarantee: state.expectedGuarantee, parties: state.partyPreimage,
    cmsSend: state.cmsSend, cmsMessageId: state.cmsMessageId, cmsRecipient: state.cmsRecipient,
    guestEmail: state.guestEmail });
}

/** Independently owned, exact-confirmation session. Closure is part of the result. */
export async function withRateOverrideSavedStay(input, operation) {
  const { selected } = input, allowRealGuest = input.allowRealGuest === true;
  if (input.target?.propertyCode !== 'HRCEN' || input.target.browserSlot !== 'centurion' ||
      input.target.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' ||
      selected?.propertyCode !== 'HRCEN' || (!allowRealGuest && !isLabtest(selected)) ||
      typeof operation !== 'function') throw new Error('RATE_OVERRIDE_SCOPE_UNSUPPORTED');
  let guarded = null, started = false;
  return withCenturionStay360Page(async page => {
    if (page.context() !== guarded) throw new Error('RATE_OVERRIDE_READ_GUARD_MISSING');
    await readShallow(page, selected.confirmation, { arrivalDate: selected.arrival });
    const record = await readRecord(page, selected.confirmation, { nativePropertyCode: 'HRCEN' });
    const expected = expectedLabtestAmendRecord(record, selected, { allowRealGuest });
    if (!expected) throw new Error('RATE_OVERRIDE_SELECTED_STAY_CHANGED');
    const state = await currentLabtestRecord(page, expected, verifiedRecordOptions(record, allowRealGuest));
    if (isLabtest(selected) && state.cmsSend !== false) throw new Error('RATE_OVERRIDE_CMS_MUST_BE_OFF');
    const session = Object.freeze({ page, state, selected: record.nativePreimage,
      preserved: preservedFields(record.nativePreimage, expected, state, record.details.fields) });
    const proof = { active: true, used: false, page, frame: state.frame, allowRealGuest, selected: structuredClone(selected) };
    labtestSessions.set(session, proof);
    try { return await operation(session); }
    finally { proof.active = false; }
  }, { headless: true, blockServiceWorkers: true, cloudTargetKey: input.cloudTargetKey,
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000),
    prepareContext: async context => {
      if (started || context._options?.serviceWorkers !== 'block' || context.serviceWorkers().length) {
        throw new Error('RATE_OVERRIDE_BROWSER_UNSAFE');
      }
      started = true;
      await installSavedStayReadGuard(context, { confirmation: selected.confirmation });
      guarded = context;
    } });
}

/** Offer one actual native Submit while it is still paused. No prompt retries. */
export async function submitRateOverrideOnce(session, stage, onPaused, { signal } = {}) {
  const proof = labtestSessions.get(session), target = stage?.review?.target, selected = proof?.selected;
  if (!proof?.active || proof.used || proof.allowRealGuest || session.page !== proof.page || session.state?.frame !== proof.frame ||
      !isPreparedSavedStayRateOverride(stage, proof.frame) || typeof onPaused !== 'function' ||
      !target || target.propertyCode !== 'HRCEN' || target.firstName !== 'Proof' || target.lastName !== 'Labtest' ||
      target.confirmation !== selected.confirmation || target.guestId !== selected.guestId ||
      target.nativeStayId !== selected.reservationStayId || target.arrival !== selected.arrival ||
      target.departure !== selected.departure || target.arrival < '2027-01-01') {
    throw new Error('RATE_OVERRIDE_SCOPE_UNSUPPORTED');
  }
  // An attempted submit cannot be retried in this browser, including after a timeout.
  proof.used = true;
  const { page } = session;
  const fence = await installPageRequestFence(page, [UPDATE, '/web/base/OSRESV.HDR']);
  const scope = fence.open();
  let armed = false, calls = 0, blocked = false, chain, stopSignal, onStop;
  try {
    chain = await installLabtestSaveRouteChain(page, { frame: stage.frame, savePath: UPDATE, fence, scope,
      isArmed: () => armed && !signal?.aborted,
      matches: (request, frame) => matchesSavedStayRateOverrideRequest(request, frame, stage.review),
      onBlocked: () => { blocked = true; },
      dispatchCandidate: async (request, continueOnce) => {
        if (++calls !== 1 || signal?.aborted) throw new Error('RATE_OVERRIDE_SUBMIT_ALREADY_ATTEMPTED');
        if (!isPreparedSavedStayRateOverride(stage, proof.frame)) throw new Error('RATE_OVERRIDE_STAGE_CHANGED');
        // HMS is waiting on this request; reading its page here can deadlock.
        // Revalidation ran immediately before the click, and the paused request
        // is matched against the reviewed target and change by the route chain.
        await onPaused(request, continueOnce);
      } });
    await stage.revalidate();
    if (signal?.aborted) throw new Error('RATE_OVERRIDE_STOPPED');
    const wizard = stage.frame.locator('.x-window:visible:not(.x-menu)').filter({ hasText: /Stay Wizard/ });
    const submit = wizard.locator('a.x-btn:visible').filter({ hasText: /^\s*Submit\s*$/ });
    if (await wizard.count() !== 1 || await submit.count() !== 1) throw new Error('RATE_OVERRIDE_SUBMIT_UNVERIFIED');
    armed = true;
    stopSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    const stopped = new Promise((_, reject) => {
      onStop = () => reject(new Error('RATE_OVERRIDE_DISPATCH_TIMEOUT'));
      if (stopSignal.aborted) onStop();
      else stopSignal.addEventListener('abort', onStop, { once: true });
    });
    void stopped.catch(() => {});
    const response = page.waitForResponse(res => res.request() === chain.candidate(), { timeout: 90_000 });
    void response.catch(() => {});
    await Promise.race([submit.click({ timeout: 90_000 }), stopped]);
    const dispatch = chain.waitForDispatch();
    const saved = await Promise.race([
      response,
      dispatch.then(dispatched => {
        if (!dispatched) throw new Error('RATE_OVERRIDE_DISPATCH_NOT_CONFIRMED');
        return response;
      }),
      stopped,
    ]);
    const dispatched = await Promise.race([dispatch, stopped]);
    armed = false;
    const drained = await chain.drain();
    return { httpStatus: saved.status(), dispatchCallbacksDrained: dispatched === true && drained && calls === 1 && !blocked };
  } finally {
    if (stopSignal && onStop) stopSignal.removeEventListener('abort', onStop);
    armed = false;
    fence.quarantine();
    await chain?.close();
    await chain?.drain();
    scope.close();
  }
}

/** Reopen by the reviewed identity; do not require the old full preimage after a write. */
export async function readBackSavedStayRateOverride(review, { target, cloudTargetKey, signal, beforePreserved,
  expectedReasonDescription = null } = {}) {
  const bound = structuredClone(review), reviewed = bound?.target;
  if (!isSavedStayRateOverrideReview(bound) || reviewed.firstName !== 'Proof' || reviewed.lastName !== 'Labtest' ||
      reviewed.arrival < '2027-01-01' || target?.propertyCode !== 'HRCEN' || target.browserSlot !== 'centurion' ||
      target.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com') throw new Error('RATE_OVERRIDE_SCOPE_UNSUPPORTED');
  let guarded = null, started = false;
  return withCenturionStay360Page(async page => {
    if (page.context() !== guarded) throw new Error('RATE_OVERRIDE_READ_GUARD_MISSING');
    await readShallow(page, reviewed.confirmation, { arrivalDate: reviewed.arrival });
    const record = await readRecord(page, reviewed.confirmation, { nativePropertyCode: 'HRCEN' });
    const native = record?.nativePreimage;
    if (!native || native.propertyCode !== reviewed.propertyCode || native.confirmation !== reviewed.confirmation ||
        native.guestId !== reviewed.guestId || native.reservationStayId !== reviewed.nativeStayId ||
        native.firstName !== reviewed.firstName || native.lastName !== reviewed.lastName ||
        native.arrival !== reviewed.arrival || native.departure !== reviewed.departure) {
      throw new Error('RATE_OVERRIDE_READBACK_TARGET_CHANGED');
    }
    const expected = expectedLabtestAmendRecord(record, native);
    if (!expected) throw new Error('RATE_OVERRIDE_READBACK_TARGET_UNVERIFIED');
    const state = await currentLabtestRecord(page, expected, recordOptions);
    if (state.cmsSend !== false) throw new Error('RATE_OVERRIDE_CMS_MUST_BE_OFF');
    const rates = await readSavedStayNightlyRates(page, state, reviewed);
    const comparison = compareSavedStayRateOverrideReadback(bound, rates);
    const reasons = await readSavedStayRateReasons(page, state, reviewed);
    const reason = compareSavedStayRateOverrideReason(bound, reasons, expectedReasonDescription);
    comparison.reasonReadback = reason.codeStatus;
    if (beforePreserved) {
      // HMS can change recordId when it saves a stay. Keep it in the pre-submit
      // drift check, but compare the stable stay identity and business fields
      // separately when reading back the saved result.
      const { recordId: beforeRecordId, ...beforeFields } = beforePreserved;
      const { recordId: afterRecordId, ...afterFields } = preservedFields(native, expected, state, record.details.fields);
      const same = JSON.stringify(beforeFields) === JSON.stringify(afterFields);
      comparison.nativeRecordId = beforeRecordId === afterRecordId ? 'MATCHED' : 'CHANGED';
      const unknownChildAges = beforePreserved.children > 0 && beforePreserved.childAges === 'unknown';
      comparison.preservedFields = same ? (unknownChildAges ? 'PARTIAL' : 'MATCHED') : 'CHANGED';
      comparison.preservedScope = ['identity', 'dates', 'room', 'ratePlan', 'occupancy', 'note',
        'guarantee', 'parties', 'cms', 'guestEmail', 'visibleBusiness'];
      if (unknownChildAges) comparison.unknownPreservedFields = ['childAges'];
      comparison.otherStayFields = 'UNKNOWN';
    }
    return { rates, reason, comparison, observedAt: new Date().toISOString() };
  }, { headless: true, blockServiceWorkers: true, cloudTargetKey,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000),
    prepareContext: async context => {
      if (started || context._options?.serviceWorkers !== 'block' || context.serviceWorkers().length) {
        throw new Error('RATE_OVERRIDE_BROWSER_UNSAFE');
      }
      started = true;
      await installSavedStayReadGuard(context, { confirmation: reviewed.confirmation });
      guarded = context;
    } });
}
