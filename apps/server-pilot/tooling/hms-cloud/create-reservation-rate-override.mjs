import { randomUUID } from 'node:crypto';
import { createReservation } from './create-reservation.mjs';
import { isCreateDate, isLabtestGuest } from './cloud-create-policy.mjs';
import { nativeMoneyCents, nativePriceDigest } from './saved-stay-nightly-rates.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { compareChargeRoomPricing } from './charge-room-pricing.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safeIssue = (error, fallback) => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : fallback;
const previousDay = value => {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
};
const identityKeys = ['source', 'propertyCode', 'confirmation', 'reservationStayId', 'reservationId', 'recordId',
  'guestId', 'status', 'firstName', 'lastName', 'arrival', 'departure', 'roomType', 'ratePlan', 'adults', 'children', 'childAges'];
const businessFields = ['reservationnote', 'guaranteetype', 'company', 'ta1', 'araccountname', 'billingreference',
  'sourceofbusinessdesc', 'reasonforstay', 'track', 'marketsegment', 'roomtypecharge', 'udfchkbox04', 'udfchar09',
  'udfchar13', 'emailaddress', 'caller', 'udfchar06', 'guestoptin4', 'child1', 'child2', 'child3'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const partyName = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : null;
const displayMoneyCents = value => typeof value === 'string' ?
  nativeMoneyCents(value.trim().replace(/^(?:ZAR|R)\s*/i, '').replace(/\s*ZAR$/i, '')) : null;
const oneField = (fields, name) => {
  const matches = Array.isArray(fields) ? fields.filter(field => field?.name === name) : [];
  if (matches.length !== 1) return undefined;
  return name === 'reservationnote' ? matches[0].rawValue : matches[0].value;
};

// Compare the business fields observable on both independent Record View reads.
function sameBusinessFields(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return false;
  return businessFields.every(name => {
    const count = first.filter(field => field?.name === name).length;
    if (!count) return !['reservationnote', 'guaranteetype', 'udfchkbox04'].includes(name);
    const before = oneField(first, name), after = oneField(second, name);
    return before !== undefined && after !== undefined && same(before, after);
  });
}

function matchesCreatedStay(native, request, confirmation) {
  const { guest, stay, room, parties = {} } = request;
  if (!native || native.source !== 'record_view_ext_model' || native.propertyCode !== request.propertyCode ||
      native.confirmation !== confirmation || native.status !== 'Reserved' || native.guestId !== guest.nativeId ||
      native.firstName !== guest.firstName || native.lastName !== guest.lastName || native.arrival !== stay.arrival ||
      native.departure !== stay.departure || native.roomType !== room.roomType || native.ratePlan !== room.ratePlan ||
      native.adults !== stay.adults || native.children !== stay.childAges.length || native.guaranteeCode !== request.guaranteeType ||
      (stay.childAges.length && (!Array.isArray(native.childAges) ||
        !same([...native.childAges].sort((a, b) => a - b), [...stay.childAges].sort((a, b) => a - b)))) ||
      (request.sourceOfBusiness && native.sourceBusinessCode !== request.sourceOfBusiness.nativeCode)) return false;
  return [['company', parties.organization], ['agency', parties.bookingAgency]].every(([key, wanted]) => {
    const observed = native.commercial?.[key];
    return wanted ? observed?.nativeId === wanted.nativeId && partyName(observed?.name) === partyName(wanted.name) : !observed;
  });
}

function matchesRatePreserved(preserved, baseline, fields, request) {
  if (!preserved || identityKeys.some(key => !Object.hasOwn(preserved, key) || !Object.hasOwn(baseline, key) ||
      !same(preserved[key], baseline[key])) || preserved.note !== request.note ||
      preserved.guarantee?.code !== request.guaranteeType || preserved.cmsSend !== false ||
      preserved.sourceBusinessCode !== (baseline.sourceBusinessCode ?? null)) return false;
  if (!preserved.visibleBusiness ||
      ['sourceofbusinessdesc', 'reasonforstay', 'track', 'marketsegment', 'roomtypecharge', 'caller', 'udfchar06',
        'guestoptin4', 'billingreference'].some(name => {
        const value = oneField(fields, name);
        return value !== undefined && !same(value, preserved.visibleBusiness[name]);
      })) return false;
  const parties = preserved.parties, wanted = request.parties || {};
  if (!parties || parties.companyid !== (wanted.organization?.nativeId ?? '') ||
      parties.taid1 !== (wanted.bookingAgency?.nativeId ?? '') ||
      parties.ta1 !== (wanted.bookingAgency?.name ?? '') ||
      (wanted.organization ? ![parties.company, parties.companyname].filter(Boolean).length ||
        [parties.company, parties.companyname].filter(Boolean).some(name => name !== wanted.organization.name) :
        Boolean(parties.company || parties.companyname))) return false;
  return [['udfchar09', 'cmsMessageId'], ['udfchar13', 'cmsRecipient'], ['emailaddress', 'guestEmail']]
    .every(([name, key]) => oneField(fields, name) === undefined || oneField(fields, name) === preserved[key]);
}

/**
 * One review covers a native Create and a subsequent whole-stay override.
 * Callbacks are host-owned authority, never request data. The host must retain
 * durable create and override attempt records and serialize their dispatches.
 */
export async function withNewStayRateOverrideSession(operation, {
  expectedGuest, cloudTargetKey, authorizeCandidate, dispatchCandidate, dispatchRateOverride,
  withSession, withSavedSession, partyReadback, census, verifyLabtestMatches,
  create = createReservation, savedSession = withSavedStayAgentSession,
} = {}) {
  if (typeof operation !== 'function' || typeof create !== 'function' || typeof savedSession !== 'function') {
    throw new Error('SESSION_CALLBACK_REQUIRED');
  }
  for (const callback of [authorizeCandidate, dispatchCandidate, dispatchRateOverride]) {
    if (callback !== undefined && typeof callback !== 'function') throw new Error('RATE_DISPATCH_INVALID');
  }
  let accepting = true, sealed = false, pending = null, tail = Promise.resolve();
  const execute = async request => {
    if (!object(request)) return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
    if (request.tool === 'prepareNewStayRateOverride') {
      pending = null;
      if (sealed) return { outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' };
      if (Object.keys(request).some(key => !['id', 'tool', 'reservation', 'rate'].includes(key)) ||
          !object(request.reservation) || Object.hasOwn(request.reservation, 'mode') ||
          (Object.hasOwn(request.reservation, 'cms') && !object(request.reservation.cms)) || !object(request.rate) ||
          Object.keys(request.rate).some(key => !['amountCents', 'currency', 'reasonCode', 'reasonDescription'].includes(key))) {
        return { outcome: 'input_gap', issue: 'RATE_OVERRIDE_INPUT_INVALID' };
      }
      const { reservation, rate } = request, { arrival, departure } = reservation.stay || {};
      if (typeof reservation.sourceOfBusiness !== 'string' || !reservation.sourceOfBusiness.trim()) {
        return { outcome: 'input_gap', issue: 'SOURCE_OF_BUSINESS_REQUIRED' };
      }
      if (!isCreateDate(arrival) || !isCreateDate(departure) || arrival >= departure ||
          typeof rate.amountCents !== 'string' || !/^[1-9]\d{0,13}$/.test(rate.amountCents) ||
          typeof rate.currency !== 'string' || !/^[A-Z]{3}$/.test(rate.currency) ||
          typeof rate.reasonCode !== 'string' || !/^[A-Z0-9]{1,20}$/.test(rate.reasonCode) ||
          typeof rate.reasonDescription !== 'string' || !rate.reasonDescription.trim() ||
          rate.reasonDescription !== rate.reasonDescription.trim() || rate.reasonDescription.length > 200 ||
          /[\p{Cc}]/u.test(rate.reasonDescription)) return { outcome: 'input_gap', issue: 'RATE_OVERRIDE_INPUT_INVALID' };
      if (reservation.cms?.send === true) return { outcome: 'unsupported', issue: 'RATE_OVERRIDE_REQUIRES_CONFIRMATION_OFF' };
      if (Object.hasOwn(reservation.cms || {}, 'send') && reservation.cms.send !== false) {
        return { outcome: 'input_gap', issue: 'RATE_OVERRIDE_INPUT_INVALID' };
      }
      const input = { ...reservation, cms: { ...reservation.cms, send: false } };
      const options = { ...(expectedGuest ? { allowRealGuest: true, expectedGuest } : {}),
        ...(cloudTargetKey ? { cloudTargetKey } : {}), ...(withSession ? { withSession } : {}) };
      let result;
      try { result = await create({ ...input, mode: 'prepare' }, options); }
      catch (error) { return { outcome: 'refused', issue: safeIssue(error, 'CREATE_PREPARATION_FAILED') }; }
      if (result?.outcome !== 'prepared' || !result.requestBinding?.digest || !result.requestBinding?.request ||
          result.requestBinding.request.sendHmsConfirmation?.kind !== 'never') {
        return { outcome: result?.outcome || 'refused', issue: result?.issue || 'CREATE_PREPARATION_UNVERIFIED', create: result };
      }
      const nativePrice = result.ratePlanAvailability;
      if (!nativePrice || nativePrice.currency !== rate.currency || displayMoneyCents(nativePrice.totalRate) === null ||
          !['averageRate', 'totalRate'].every(key => typeof nativePrice[key] === 'string' && nativePrice[key].trim())) {
        return { outcome: 'refused', issue: 'CREATE_RATE_UNVERIFIED', create: result };
      }
      if (isLabtestGuest(result.requestBinding.request.guest) && result.requestBinding.request.guaranteeType !== 'NGI') {
        return { outcome: 'unsupported', issue: 'RATE_LABTEST_GUARANTEE_UNSUPPORTED', create: result };
      }
      if (isLabtestGuest(result.requestBinding.request.guest) &&
          (result.requestBinding.request.stay.childAges.length || result.requestBinding.request.parties?.arAccount)) {
        return { outcome: 'unsupported', issue: 'RATE_LABTEST_STAY_UNSUPPORTED', create: result };
      }
      // Create may generate a fake-only note during preview. Commit must restage
      // the exact note that was included in the reviewed native request.
      if (input.note === undefined && typeof result.requestBinding.request.note === 'string') {
        input.note = result.requestBinding.request.note;
      }
      const change = { startDate: arrival, endDate: previousDay(departure), amountCents: rate.amountCents,
        currency: rate.currency, reasonCode: rate.reasonCode, reasonDescription: rate.reasonDescription };
      const review = { create: structuredClone(result.requestBinding),
        nativePrice: { averageRate: nativePrice.averageRate, totalRate: nativePrice.totalRate, currency: nativePrice.currency }, change };
      const preparedId = randomUUID(), reviewDigest = nativePriceDigest(review);
      pending = { preparedId, reviewDigest, review, input: structuredClone(input) };
      return { outcome: 'prepared_for_review', preparedId, reviewDigest, create: result, change: structuredClone(change),
        proposedTotals: null, nativeOverridePreparation: 'PENDING_SAVED_STAY', confirmationSend: 'off',
        writes: ['create', 'rate_override'] };
    }
    if (request.tool !== 'commitNewStayRateOverride') return { outcome: 'input_gap', issue: 'UNKNOWN_TOOL' };
    if (Object.keys(request).some(key => !['id', 'tool', 'preparedId'].includes(key))) {
      return { outcome: 'input_gap', issue: 'RATE_OVERRIDE_INPUT_INVALID' };
    }
    if (sealed) return { outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' };
    if (!pending || request.preparedId !== pending.preparedId) return { outcome: 'refused', issue: 'RATE_PREPARATION_STALE' };
    if (![authorizeCandidate, dispatchCandidate, dispatchRateOverride].every(value => typeof value === 'function')) {
      return { outcome: 'refused', issue: 'RATE_DISPATCH_AUTHORITY_REQUIRED' };
    }
    if (!isLabtestGuest(pending.review.create.request.guest) || pending.input.stay.arrival < '2027-01-01') {
      return { outcome: 'refused', issue: 'RATE_LABTEST_WRITE_ONLY' };
    }
    const prepared = pending;
    pending = null; sealed = true;
    const reviewContext = () => structuredClone({ preparedId: prepared.preparedId,
      reviewDigest: prepared.reviewDigest, review: prepared.review });
    let created;
    try {
      created = await create({ ...prepared.input, mode: 'commit' }, {
        expectedRequestDigest: prepared.review.create.digest, expectedRateAvailability: prepared.review.nativePrice,
        authorizeCandidate: request => authorizeCandidate(request, reviewContext()),
        dispatchCandidate: (nativeRequest, proceed, evidence) => {
          const fields = [...new URLSearchParams(nativeRequest.postData() || '')]
            .map(([name, value]) => ({ name: name.toLowerCase(), value }));
          const price = compareChargeRoomPricing(fields, prepared.review.nativePrice);
          if (Object.values(price).some(value => value !== 'MATCHED')) throw new Error('CREATE_REQUEST_PRICE_UNVERIFIED');
          return dispatchCandidate(nativeRequest, proceed, evidence, reviewContext());
        },
        ...(cloudTargetKey ? { cloudTargetKey } : {}), ...(withSession ? { withSession } : {}),
        ...(expectedGuest ? { expectedGuest } : {}),
        ...(withSavedSession ? { withSavedSession } : {}), ...(partyReadback ? { partyReadback } : {}),
        ...(census ? { census } : {}), ...(verifyLabtestMatches ? { verifyLabtestMatches } : {}),
      });
    } catch (error) {
      return { outcome: 'uncertain', issue: safeIssue(error, 'CREATE_ATTEMPT_UNCERTAIN'),
        next: 'reconcile_create_before_retry' };
    }
    if (created?.outcome !== 'saved' || !/^\d+-\d+$/.test(created.confirmation || '')) {
      return { outcome: created?.outcome === 'refused' || created?.outcome === 'needs_input' ? 'refused' : 'uncertain',
        issue: created?.issue || 'CREATE_UNVERIFIED', create: created, next: 'reconcile_create_before_retry' };
    }
    const partial = (issue, rate) => ({ outcome: 'created_rate_unverified', issue, confirmation: created.confirmation,
      create: created, ...(rate ? { rate } : {}), next: 'reconcile_saved_stay_before_retry' });
    const savedPrice = compareChargeRoomPricing(created.readback?.fields, prepared.review.nativePrice);
    if (Object.values(savedPrice).some(value => value !== 'MATCHED')) return partial('CREATED_PRICE_UNVERIFIED', savedPrice);
    let savedBaseline;
    try {
      return await savedSession(async ({ runTool }) => {
        const read = await runTool({ tool: 'read', confirmation: created.confirmation,
          arrivalDate: prepared.input.stay.arrival, view: 'record', includeNativePreimage: true });
        const native = read?.record?.nativePreimage, fields = read?.record?.details?.fields;
        if (read?.outcome !== 'ok' || !matchesCreatedStay(native, prepared.review.create.request, created.confirmation) ||
            !sameBusinessFields(created.readback.fields, fields) ||
            Object.values(compareChargeRoomPricing(fields, prepared.review.nativePrice)).some(value => value !== 'MATCHED')) {
          return partial('CREATED_STAY_CHANGED');
        }
        savedBaseline = { native: structuredClone(native), fields: structuredClone(fields) };
        const change = prepared.review.change;
        const staged = await runTool({ tool: 'prepareRateOverride', date: change.startDate, endDate: change.endDate,
          amountCents: change.amountCents, currency: change.currency, reasonCode: change.reasonCode });
        if (staged?.outcome !== 'prepared') return partial(staged?.issue || 'RATE_PREPARATION_FAILED', staged);
        if (staged.change?.reasonDescription !== change.reasonDescription) return partial('RATE_REASON_CHANGED', staged);
        if (staged.reviewedBaseline?.currency !== prepared.review.nativePrice.currency ||
            staged.reviewedBaseline?.totals?.subtotalCents !== displayMoneyCents(prepared.review.nativePrice.totalRate)) {
          return partial('CREATED_RATE_CHANGED', staged);
        }
        const committed = await runTool({ tool: 'commitRateOverride', preparedId: staged.preparedId });
        if (committed?.outcome !== 'partially_verified') return partial(committed?.issue || 'RATE_READBACK_UNVERIFIED', committed);
        return { outcome: 'partially_verified', confirmation: created.confirmation, create: created, rate: committed,
          next: 'review_rate_verification' };
      }, { ...(cloudTargetKey ? { cloudTargetKey } : {}),
        dispatchRateOverride: (nativeRequest, proceed, rateReview) => {
          const change = rateReview?.review?.change, expected = prepared.review.change;
          if (rateReview?.review?.target?.confirmation !== created.confirmation ||
              change?.startDate !== expected.startDate || change?.endDate !== expected.endDate ||
              change?.amountCents !== expected.amountCents || change?.currency !== expected.currency ||
              change?.reason !== expected.reasonCode || rateReview.reasonDescription !== expected.reasonDescription ||
              !savedBaseline || !matchesRatePreserved(rateReview.preserved, savedBaseline.native,
                savedBaseline.fields, prepared.review.create.request)) {
            throw new Error('RATE_REVIEW_CHANGED');
          }
          return dispatchRateOverride(nativeRequest, proceed, structuredClone({ ...reviewContext(), rateReview }));
        } });
    } catch (error) { return partial(safeIssue(error, 'RATE_ATTEMPT_UNCERTAIN')); }
  };
  const runTool = request => {
    let input, invalid = false;
    try { input = structuredClone(request); } catch { invalid = true; }
    const id = input?.id ?? null, tool = input?.tool ?? null;
    if (!accepting) return Promise.resolve({ id, tool, outcome: 'refused', issue: 'SESSION_CLOSED' });
    const result = tail.then(() => invalid ? { outcome: 'input_gap', issue: 'INVALID_REQUEST' } : execute(input))
      .then(value => ({ ...value, id, tool }));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  try { return await operation({ runTool }); }
  finally { accepting = false; await tail; pending = null; }
}
