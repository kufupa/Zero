import { isDeepStrictEqual } from 'node:util';
import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { cleanLabtestRecord, snapshotLabtestRecord } from './labtest-record.mjs';
import { isFirstGoCallbackAuthority } from './pane-amend-callback-authority.mjs';
import { isFinalGoCallbackAuthority } from './pane-amend-final-authority.mjs';
import { applySavedGuaranteeOnGo } from './guest-stay-amend-guarantee.mjs';
import { inspectSavedPartyForComposition, applySavedPartyOnGo } from './guest-stay-amend-party.mjs';
import { savedChildOccupancy, sameChildAgeMultiset, stageSavedChildrenForComposition } from './guest-stay-amend-children.mjs';
import { isSavedChildStageRequestGate } from './saved-stay-child-request-gate.mjs';
import { isSavedGuaranteeRequestGate, matchesSavedGuaranteeBefore, sameSavedGuaranteePreimage } from './saved-stay-guarantee-request-gate.mjs';
import { isSavedPartyStageRequestGate, savedPartyBeforeImage, savedPartySpec } from './saved-stay-party-request-gate.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const usedPages = new WeakSet();
const order = ['organization', 'bookingAgency', 'arAccount'];
const priceAmounts = new Set(['grandtotal', 'averagenightly', 'averagerate', 'totalrate', 'totalratewithtax',
  'enhancedexptotal', 'guesttotal', 'guesttax', 'guesttotalwithtax', 'tax', 'totalresortfee', 'ratetax']);
const priceAmount = name => priceAmounts.has(name.toLowerCase());
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\p{Cc}]/u.test(value);
const id = value => typeof value === 'string' && /^\d{1,100}$/.test(value);
const ages = value => Array.isArray(value) && value.length <= 9 &&
  Array.from(value).every(age => Number.isInteger(age) && age >= 0 && age <= 17);
const code = value => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value);
const pair = value => value && code(value.code) && text(value.display);
const commission = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === 1 && typeof value.ta1commission === 'string' &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.ta1commission) && Number(value.ta1commission) <= 100;
const issue = error => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'CALLBACK_PHASE_UNVERIFIED';

function validatePlan({ selected, expected, guarantee, parties, children, beforeImage }, { allowEmpty = false } = {}) {
  if (!selected || !expected || selected.source !== 'record_view_ext_model' ||
      !getPropertyRegistration(selected.propertyCode)?.active || expected.propertyCode !== selected.propertyCode ||
      selected.status !== 'Reserved' || !/^\d{6,}-\d+$/.test(selected.confirmation || '') ||
      !['guestId', 'reservationId', 'reservationStayId', 'recordId'].every(key => id(selected[key])) ||
      !['firstName', 'lastName'].every(key => text(selected[key])) ||
      !['confirmation', 'guestId', 'firstName', 'lastName', 'arrival', 'departure', 'roomType', 'ratePlan', 'adults']
        .every(key => isDeepStrictEqual(expected[key], selected[key])) ||
      expected.childCount !== selected.children || !pair(expected.expectedGuarantee) ||
      !Array.isArray(parties) || parties.length > order.length ||
      (parties.length ? !beforeImage?.data || !beforeImage?.values : beforeImage !== null) ||
      parties.some((party, index) => !party || !order.includes(party.kind) ||
        (index > 0 && order.indexOf(party.kind) <= order.indexOf(parties[index - 1].kind)) ||
        !id(party.nativeId) || !text(party.name) || !text(party.query) ||
        (party.expectedEffects !== undefined && (party.kind !== 'bookingAgency' || !commission(party.expectedEffects)))) ||
      !(guarantee === null || (pair(guarantee) && pair(guarantee.before) &&
        isDeepStrictEqual(guarantee.before, expected.expectedGuarantee) && guarantee.code !== guarantee.before.code)) ||
      !(children === null || (ages(children.beforeAges) && ages(children.nextAges) &&
        children.beforeAges.length === selected.children && ages(expected.childAges) &&
        isDeepStrictEqual(children.beforeAges, expected.childAges) &&
        !sameChildAgeMultiset(children.beforeAges, children.nextAges))) ||
      (!allowEmpty && !guarantee && parties.length === 0 && !children)) throw new Error('CALLBACK_PLAN_INVALID');
}

function withoutSession(image) {
  if (!image?.data || !image?.values) return null;
  const copy = structuredClone(image);
  delete copy.data.bookingsessionid;
  delete copy.values.bookingsessionid;
  return copy;
}

// Compare business fields and currency, allowing callback amounts to change
// only after dispatch; the owner verifies prices after native reprice.
function preserved(before, after, exempt, allowPriceChange = false) {
  const skip = new Set(exempt.map(name => name.toLowerCase()));
  const mask = snapshot => Object.fromEntries(['data', 'values'].map(part => [part,
    Object.fromEntries(Object.entries(snapshot?.[part] ?? {}).filter(([name]) =>
      !skip.has(name.toLowerCase()) && !(allowPriceChange && priceAmount(name))))]));
  return sameSavedGuaranteePreimage(mask(before), mask(after));
}

function partyImagePreserved(before, after, exempt, allowPriceChange = false) {
  const skip = new Set(exempt.map(name => name.toLowerCase()));
  const withoutExempt = snapshot => Object.fromEntries(['data', 'values'].map(part => [part,
    Object.fromEntries(Object.entries(snapshot?.[part] ?? {}).filter(([name]) => !skip.has(name.toLowerCase())))]));
  const a = savedPartyBeforeImage(withoutExempt(before)), b = savedPartyBeforeImage(withoutExempt(after));
  if (!a || !b) return false;
  const mask = image => Object.fromEntries(['data', 'values'].map(part => [part,
    Object.fromEntries(Object.entries(image[part]).filter(([name]) => !skip.has(name.toLowerCase()) &&
      !(allowPriceChange && priceAmount(name))))]));
  return isDeepStrictEqual(mask(a), mask(b));
}

/** Run only the approved callbacks; the owning host controls repricing and Save. */
export async function runCloudPaneAmendCallbacks(input, authority) {
  const context = input?.context;
  const effects = [];
  let snapshot, pending = null, blockedSave = false, callbacksReturned = false;
  const firstGo = isFirstGoCallbackAuthority(authority), finalGo = isFinalGoCallbackAuthority(authority);
  const validAuthority = firstGo !== finalGo;
  const bound = isLabtestAmendStageContext(context) ? context.callbackAuthority : null;
  const boundIsAuthority = isFirstGoCallbackAuthority(bound) || isFinalGoCallbackAuthority(bound);
  const possible = () => (validAuthority && authority.possiblyPersisted()) ||
    (bound !== authority && boundIsAuthority && bound.possiblyPersisted());
  const stop = reason => {
    if (validAuthority) authority.close();
    if (isLabtestAmendStageContext(context)) {
      if (bound !== authority && boundIsAuthority) bound.close();
      context.stop(reason);
    }
  };
  const active = () => {
    if (blockedSave || !context.isActive() || context.remainingMs() <= 0 || !authority.isActive()) {
      throw new Error(blockedSave ? 'CALLBACK_SAVE_FORBIDDEN' : 'CALLBACK_PHASE_STOPPED');
    }
  };
  try {
    if (!isLabtestAmendStageContext(context) || !validAuthority ||
        context.callbackAuthority !== authority || !context.page || !context.frame || !context.baseline || !context.isActive() ||
        context.remainingMs() <= 0 || !authority.isActive() || (finalGo && authority.mayAttemptSave())) {
      throw new Error('CALLBACK_CONTEXT_INVALID');
    }
    const { selected, expected, guarantee, parties, children, beforeImage } = structuredClone({
      selected: input.selected, expected: input.expected, guarantee: input.guarantee,
      parties: input.parties, children: input.children, beforeImage: input.beforeImage,
    });
    const plan = { selected, expected, guarantee, parties, children, beforeImage };
    validatePlan(plan, { allowEmpty: finalGo });
    if (!authority.matchesPlan(plan) || usedPages.has(context.page) ||
        (guarantee && !isSavedGuaranteeRequestGate(context.guaranteeStageGate)) ||
        (parties.length && !isSavedPartyStageRequestGate(context.partyStageGate)) ||
        (children && (!isSavedChildStageRequestGate(context.childStageGate) || context.childStageGate.isReadOnly()))) {
      throw new Error('CALLBACK_CONTEXT_INVALID');
    }
    const browser = context.page.context();
    if (browser?._options?.serviceWorkers !== 'block' || typeof browser.serviceWorkers !== 'function' ||
        browser.serviceWorkers().length !== 0) throw new Error('BROWSER_CONTEXT_UNSAFE');
    usedPages.add(context.page);
    // Keep this handler for the page lifetime, even after success or timeout.
    await context.page.route('**/*', async route => {
      let path;
      try { path = decodeURIComponent(new URL(route.request().url()).pathname).toLowerCase(); }
      catch { stop('CALLBACK_REQUEST_INVALID'); return route.abort(); }
      if (path === '/web/base/osresv.hdr') {
        if (finalGo && callbacksReturned && authority.isActive() && authority.mayAttemptSave() === true) return route.fallback();
        blockedSave = true;
        stop('CALLBACK_SAVE_FORBIDDEN');
        return route.abort();
      }
      return route.fallback();
    });
    active();
    snapshot = await snapshotLabtestRecord(context.frame);
    active();
    const guaranteeExpected = { ...expected, propertyCode: selected.propertyCode, reservationStayId: selected.reservationStayId,
      reservationId: selected.reservationId, recordId: selected.recordId,
      guaranteeCode: expected.expectedGuarantee.code, guaranteeDisplay: expected.expectedGuarantee.display };
    if (!Array.isArray(snapshot?.dirtyFields) || !Array.isArray(snapshot?.modifiedFields) ||
        !Array.isArray(context.baseline.dirtyFields) || !Array.isArray(context.baseline.modifiedFields) ||
        !cleanLabtestRecord(snapshot) || !matchesSavedGuaranteeBefore(snapshot, context.baseline,
          guaranteeExpected, expected.expectedGuarantee)) throw new Error('CALLBACK_PREIMAGE_UNVERIFIED');
    const initialOccupancy = savedChildOccupancy(snapshot);
    if (children && (!initialOccupancy.valid || initialOccupancy.count !== children.beforeAges.length)) {
      throw new Error('CALLBACK_CHILD_PREIMAGE_UNVERIFIED');
    }
    for (const party of parties) {
      const spec = savedPartySpec(party.kind);
      if (String(snapshot.data?.[spec.link] ?? '') === party.nativeId &&
          String(snapshot.data?.[spec.display] ?? '') === party.name) throw new Error('CALLBACK_NO_CHANGE');
    }
    if (parties.length) {
      const currentImage = savedPartyBeforeImage(snapshot);
      if (!currentImage || !isDeepStrictEqual(withoutSession(currentImage), beforeImage)) {
        throw new Error('CALLBACK_APPROVED_PREIMAGE_CHANGED');
      }
      const first = parties[0];
      const inspection = await inspectSavedPartyForComposition(context, { kind: first.kind, query: first.query });
      active();
      const fresh = await snapshotLabtestRecord(context.frame);
      active();
      if (!inspection.coverage?.complete || !isDeepStrictEqual(inspection.beforeImage, currentImage) ||
          !isDeepStrictEqual(withoutSession(inspection.beforeImage), beforeImage) ||
          !isDeepStrictEqual(savedPartyBeforeImage(fresh), currentImage) || !preserved(snapshot, fresh, [])) {
        throw new Error('CALLBACK_APPROVED_PREIMAGE_CHANGED');
      }
    }
    const updateBaseline = next => {
      if (!next?.data || !next?.values) throw new Error('CALLBACK_SNAPSHOT_UNVERIFIED');
      Object.assign(context.baseline, structuredClone(next));
      snapshot = structuredClone(next);
    };

    if (guarantee) {
      pending = { kind: 'guarantee', before: { ...guarantee.before, snapshot: savedPartyBeforeImage(snapshot) },
        after: null, partialEffect: 'none' };
      const result = await applySavedGuaranteeOnGo(context, { expected: guaranteeExpected,
        code: guarantee.code, display: guarantee.display }, {
        authorizeCandidate: async () => authority.isActive(), dispatchCandidate: authority.dispatchGuarantee,
      });
      pending.partialEffect = result.partialEffect === 'possible' ? 'possible' : 'none';
      if (result.outcome !== 'applied' || !isDeepStrictEqual(result.before, guarantee.before) ||
          !isDeepStrictEqual(result.actual, { code: guarantee.code, display: guarantee.display }) ||
          !result.snapshot || !preserved(snapshot, result.snapshot, ['guaranteetype'], true) ||
          !partyImagePreserved(snapshot, result.snapshot, ['guaranteetype', 'childages'], true) || !possible()) {
        throw new Error(result.issue || 'CALLBACK_GUARANTEE_UNVERIFIED');
      }
      active();
      pending.after = { ...result.actual, snapshot: savedPartyBeforeImage(result.snapshot) };
      effects.push(pending); pending = null; updateBaseline(result.snapshot);
    }

    for (const party of parties) {
      active();
      pending = { kind: party.kind, before: savedPartyBeforeImage(snapshot), after: null, partialEffect: 'none' };
      if (!pending.before) throw new Error('CALLBACK_PARTY_PREIMAGE_UNVERIFIED');
      const inspection = await inspectSavedPartyForComposition(context, { kind: party.kind, query: party.query });
      active();
      const fresh = await snapshotLabtestRecord(context.frame);
      active();
      if (!inspection.coverage?.complete || !isDeepStrictEqual(inspection.beforeImage, pending.before) ||
          !preserved(snapshot, fresh, []) || !isDeepStrictEqual(savedPartyBeforeImage(fresh), pending.before)) {
        throw new Error('CALLBACK_PARTY_PREIMAGE_UNVERIFIED');
      }
      const candidates = inspection.candidates.filter(row => row.nativeId === party.nativeId && row.name === party.name);
      if (candidates.length !== 1 || inspection.candidates.filter(row => row.nativeId === party.nativeId).length !== 1) {
        throw new Error('CALLBACK_PARTY_NOT_UNIQUE');
      }
      const candidate = candidates[0];
      if (party.expectedEffects) {
        if (candidate.row.commissionPercentage !== party.expectedEffects.ta1commission || candidate.row.payCommissionFlag !== '-1') {
          throw new Error('CALLBACK_COMMISSION_UNVERIFIED');
        }
        candidate.expectedEffects = structuredClone(party.expectedEffects);
      }
      const result = await applySavedPartyOnGo(context, { kind: party.kind, expected: inspection.beforeImage, candidate }, {
        authorizeCandidate: authority.authorizeParty, dispatchCandidate: authority.dispatchParty,
      });
      pending.partialEffect = result.partialEffect === 'possible' ? 'possible' : 'none';
      if (result.afterImage) pending.after = result.afterImage;
      const spec = savedPartySpec(party.kind);
      const exempt = [spec.link, spec.display, ...(party.kind === 'arAccount' ? ['arprofileid'] : []),
        ...(party.expectedEffects ? ['ta1commission'] : [])];
      if (result.outcome !== 'applied' || !isDeepStrictEqual(result.beforeImage, pending.before) ||
          !isDeepStrictEqual(result.afterImage, savedPartyBeforeImage(result.snapshot)) ||
          !preserved(snapshot, result.snapshot, exempt, true) || !possible()) {
        throw new Error(result.issue || 'CALLBACK_PARTY_UNVERIFIED');
      }
      active();
      effects.push(pending); pending = null; updateBaseline(result.snapshot);
    }

    if (children) {
      active();
      pending = { kind: 'children', before: { ages: children.beforeAges, bands: initialOccupancy.bands,
        snapshot: savedPartyBeforeImage(snapshot) }, after: null, partialEffect: 'none' };
      const next = await stageSavedChildrenForComposition(context, { ...expected,
        reservationStayId: selected.reservationStayId, adults: selected.adults,
        childCount: children.beforeAges.length, childAges: children.beforeAges }, children.nextAges);
      pending.partialEffect = 'possible';
      const occupancy = savedChildOccupancy(next);
      const exempt = ['children', 'childages', ...new Set(['data', 'values'].flatMap(part =>
        [...Object.keys(snapshot?.[part] ?? {}), ...Object.keys(next?.[part] ?? {})].filter(key => /^child\d+$/i.test(key))))];
      if (!occupancy.valid || occupancy.count !== children.nextAges.length ||
          !preserved(snapshot, next, exempt, true) || !partyImagePreserved(snapshot, next, exempt, true) || !possible()) {
        throw new Error('CALLBACK_CHILD_UNVERIFIED');
      }
      active();
      pending.after = { ages: children.nextAges, bands: occupancy.bands, snapshot: savedPartyBeforeImage(next) };
      effects.push(pending); pending = null; updateBaseline(next);
    }
    active();
    if (finalGo && (!authority.callbacksComplete() || authority.mayAttemptSave())) throw new Error('CALLBACK_PHASE_INCOMPLETE');
    callbacksReturned = true;
    return { outcome: 'applied', effects, snapshot, partialEffect: possible() ? 'possible' : 'none' };
  } catch (error) {
    const dispatched = Boolean(possible() || effects.some(effect => effect.partialEffect === 'possible') ||
      pending?.partialEffect === 'possible');
    if (pending) {
      if (dispatched) pending.partialEffect = 'possible';
      effects.push(pending);
    }
    const reason = blockedSave ? 'CALLBACK_SAVE_FORBIDDEN' : issue(error);
    stop(reason);
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', effects,
      ...(snapshot ? { snapshot } : {}), issue: reason, partialEffect: dispatched ? 'possible' : 'none' };
  }
}
