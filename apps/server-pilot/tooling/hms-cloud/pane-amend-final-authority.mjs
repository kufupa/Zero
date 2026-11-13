import { amendNativeRequestDigest } from './labtest-amend-dispatch.mjs';
import { callbackPartyRequestDigest, callbackPlanDigest } from './pane-amend-callback-authority.mjs';

const issued = new WeakSet();
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const partyPhases = ['organization', 'bookingAgency', 'arAccount'];
const order = ['guarantee', ...partyPhases, 'children', 'availability', 'save', 'retain'];

export const isFinalGoCallbackAuthority = value => Boolean(value && issued.has(value));

/** The transition to Save is held by the host, separate from the runner's authority. */
export function createFinalGoCallbackAuthority({ operationDigest, sourceDigest, targetDigest, approvedPlanDigest,
  reviewDigest, plan, phases, authorizeFirst, verifyFinal, isEnabled = () => true }) {
  if ([operationDigest, sourceDigest, targetDigest, approvedPlanDigest, reviewDigest].some(value => !HASH.test(value || '')) ||
      !plan || callbackPlanDigest(plan) !== approvedPlanDigest || !Array.isArray(phases) ||
      typeof authorizeFirst !== 'function' || typeof verifyFinal !== 'function' || typeof isEnabled !== 'function') {
    throw new Error('AMEND_FINAL_AUTHORITY_INVALID');
  }
  const planned = [...(plan.guarantee ? ['guarantee'] : []),
    ...(Array.isArray(plan.parties) ? plan.parties.map(party => party.kind) : []),
    ...(plan.children ? ['children'] : []), 'availability', 'save', 'retain'];
  if (JSON.stringify(planned) !== JSON.stringify(phases) || new Set(phases).size !== phases.length ||
      phases.some((phase, index) => !order.includes(phase) || (index > 0 && order.indexOf(phase) <= order.indexOf(phases[index - 1])))) {
    throw new Error('AMEND_FINAL_AUTHORITY_INVALID');
  }
  phases = Object.freeze([...phases]);
  let next = 0, handle = null, busy = false, closed = false, saveArmed = false, armUsed = false, possiblyPersisted = false;
  const active = () => !closed && isEnabled();
  const digest = (request, phase) => partyPhases.includes(phase)
    ? callbackPartyRequestDigest(request, phase) : amendNativeRequestDigest(request, phase);
  const eligible = (request, phase) => active() && !busy && phases[next] === phase &&
    (!['save', 'retain'].includes(phase) || saveArmed) && digest(request, phase);
  const dispatch = async (phase, request, proceed) => {
    const requestDigest = eligible(request, phase);
    if (!requestDigest || typeof proceed !== 'function') {
      closed = true;
      throw new Error('AMEND_FINAL_DISPATCH_UNAUTHORIZED');
    }
    busy = true;
    try {
      if (!handle) {
        const result = await authorizeFirst({ operationDigest, sourceDigest, targetDigest, approvedPlanDigest, reviewDigest,
          phase: partyPhases.includes(phase) ? `amend.party.${phase}` : `amend.${phase}`, requestDigest });
        if (!UUID.test(result?.holdId || '') || !HASH.test(result?.ownerToken || '')) throw new Error('AMEND_FINAL_CLAIM_UNVERIFIED');
        handle = Object.freeze({ holdId: result.holdId, ownerToken: result.ownerToken });
      }
      if (!active() || digest(request, phase) !== requestDigest) throw new Error('AMEND_FINAL_DISPATCH_UNAUTHORIZED');
      if (phase !== 'availability') possiblyPersisted = true;
      await proceed();
      next += 1;
    } catch (error) {
      closed = true;
      throw error;
    } finally { busy = false; }
  };
  const authority = Object.freeze({
    isActive: active,
    matchesPlan: value => active() && callbackPlanDigest(value) === approvedPlanDigest,
    authorizeParty: request => Boolean(partyPhases.includes(phases[next]) && eligible(request, phases[next])),
    dispatchParty: (request, proceed) => dispatch(phases[next], request, proceed),
    dispatchGuarantee: (request, proceed) => dispatch('guarantee', request, proceed),
    dispatchChildren: (request, proceed) => dispatch('children', request, proceed),
    dispatchAvailability: (request, proceed) => dispatch('availability', request, proceed),
    dispatchSave: (request, proceed) => dispatch('save', request, proceed),
    dispatchRetain: (request, proceed) => dispatch('retain', request, proceed),
    callbacksComplete: () => active() && !busy && phases[next] === 'availability',
    mayAttemptSave: () => active() && saveArmed,
    possiblyPersisted: () => possiblyPersisted,
    holdId: () => handle?.holdId ?? null,
    complete: () => active() && !busy && next >= phases.length - 1,
    close: () => { closed = true; },
  });
  issued.add(authority);
  const authorizeSave = (snapshot, prepared) => {
    if (armUsed || !active() || busy || phases[next] !== 'save' || verifyFinal(snapshot, prepared) !== true) {
      closed = true;
      throw new Error('AMEND_FINAL_REVIEW_UNVERIFIED');
    }
    armUsed = true;
    saveArmed = true;
  };
  return Object.freeze({ authority, authorizeSave });
}
