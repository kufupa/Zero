// One bounded child-age read and validation in a caller-owned saved-stay fence.
// This gate only identifies exact requests. It never routes, sends, or authorizes Save.
import { isDeepStrictEqual } from 'node:util';
import { matchesSavedChildAgeRead, matchesSavedChildAgeValidation, planSavedChildOccupancy } from './guest-stay-amend-children.mjs';

export const SAVED_CHILD_STAGE_PATHS = Object.freeze([
  '/web/base/OSRESV.HDR.getChildAges', '/web/base/OSRESV.HDR.validateChildAgeDetails',
]);
const issuedGates = new WeakSet();
export const isSavedChildStageRequestGate = (gate) => Boolean(gate && issuedGates.has(gate));

/**
 * Build from the current fenced page's verified native stay ID and occupancy preimage.
 * Callers must still use the page-lifetime fence and context read-only guard. A matched
 * request is consumed even if a downstream route fails, and can never be retried here.
 */
export function createSavedChildStageRequestGate({ frame, stayId, adults, priorAges, priorBands, nextAges, deadlineAt } = {}) {
  const prior = planSavedChildOccupancy({ childCount: Array.isArray(priorAges) ? priorAges.length : null, childAges: priorAges });
  const next = planSavedChildOccupancy({ childCount: Array.isArray(nextAges) ? nextAges.length : null, childAges: nextAges });
  if (!frame || typeof stayId !== 'string' || !/^\d+$/.test(stayId) || !Number.isInteger(adults) || adults < 1 || adults > 16 ||
      prior.outcome !== 'planned' || next.outcome !== 'planned' || next.childAges === null ||
      !priorBands || ['child1', 'child2', 'child3'].some((name) => !Number.isInteger(priorBands[name]) || priorBands[name] < 0 || priorBands[name] > 9) ||
      priorBands.child1 + priorBands.child2 + priorBands.child3 > 9 ||
      (prior.childAges !== null && !isDeepStrictEqual(prior.derivedBands, priorBands)) || !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    throw new Error('CHILD_STAGE_GATE_INPUT_INVALID');
  }
  const oldAges = prior.childAges === null ? null : [...prior.childAges], ages = [...next.childAges], bands = { ...priorBands };
  let state = 'ready', readRequest = null, validationRequest = null;
  const active = () => {
    if (performance.now() >= deadlineAt) state = 'closed';
    return state !== 'closed';
  };
  const gate = Object.freeze({
    armRead() {
      if (!active() || state !== 'ready') return false;
      state = 'read_armed';
      return true;
    },
    // The caller may transition only after the native response and popup preimage
    // have both been independently verified. This is not a response verifier.
    markReadVerified() {
      if (!active() || state !== 'read_consumed') return false;
      state = 'read_verified';
      return true;
    },
    armValidation() {
      if (!active() || state !== 'read_verified') return false;
      state = 'validation_armed';
      return true;
    },
    consume(request) {
      if (!active()) return false;
      if (state === 'read_armed' && matchesSavedChildAgeRead(request, frame, stayId, oldAges)) {
        state = 'read_consumed';
        readRequest = request;
        return true;
      }
      if (state === 'validation_armed' && matchesSavedChildAgeValidation(request, frame,
        { stayId, adults, priorBands: bands, ages })) {
        state = 'validation_consumed';
        validationRequest = request;
        return true;
      }
      // Any candidate passed here that does not match closes the gate.
      // The caller must also stop and reconcile rather than retry the page.
      state = 'closed';
      return false;
    },
    isReadRequest(request) { return readRequest !== null && request === readRequest; },
    isValidationRequest(request) { return validationRequest !== null && request === validationRequest; },
    isActive() { return active(); },
    close() { state = 'closed'; },
  });
  issuedGates.add(gate);
  return gate;
}
