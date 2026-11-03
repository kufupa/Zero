import { createHash } from 'node:crypto';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const AVAILABILITY_PATH = '/web/base/OSRESV.HDR.getcheckavailability';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Digest the exact intercepted request without retaining its private fields. */
export function amendNativeRequestDigest(request, phase) {
  try {
    const url = new URL(request.url());
    const contentType = request.headers()['content-type'];
    const body = request.postDataBuffer();
    if (request.method() !== 'POST' || url.origin !== ORIGIN || url.hash ||
        typeof contentType !== 'string' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) ||
        !Buffer.isBuffer(body) || body.length === 0 || body.length > 2 * 1024 * 1024) return null;
    if (phase === 'availability') {
      if (url.pathname !== AVAILABILITY_PATH || url.search) return null;
    } else if (phase === 'save' || phase === 'retain') {
      if (url.pathname !== SAVE_PATH || [...url.searchParams].length !== 1 ||
          url.searchParams.get('pageaction') !== 'SAVE') return null;
    } else return null;
    const hash = createHash('sha256');
    hash.update('nava-amend-native-request/v1\0');
    for (const value of [phase, request.method(), url.href, contentType]) {
      hash.update(String(Buffer.byteLength(value))).update(':').update(value);
    }
    hash.update(String(body.length)).update(':').update(body);
    return hash.digest('hex');
  } catch { return null; }
}

/**
 * One committed UNKNOWN hold covers an entire approved operation. This only
 * sequences intercepted requests: the caller must independently match their
 * full bodies and verify availability and the retain question before arming.
 */
export function createLabtestAmendDispatch({ operationDigest, requiresAvailability, authorizeFirst }) {
  if (!HASH.test(operationDigest || '') || typeof requiresAvailability !== 'boolean' ||
      typeof authorizeFirst !== 'function') {
    throw new Error('AMEND_DISPATCH_INPUT_INVALID');
  }
  let handle = null, busy = false, closed = false;
  let availabilityDone = false, saveDone = false, retainDone = false;

  const dispatch = async (phase, request, proceed) => {
    const eligible = !closed && !busy && typeof proceed === 'function' &&
      (phase === 'availability' ? requiresAvailability && !availabilityDone && !saveDone :
        phase === 'save' ? !saveDone && (!requiresAvailability || availabilityDone) :
          phase === 'retain' && saveDone && !retainDone);
    const requestDigest = eligible ? amendNativeRequestDigest(request, phase) : null;
    if (!eligible || !requestDigest) {
      closed = true;
      throw new Error('AMEND_DISPATCH_NOT_AUTHORIZED');
    }
    busy = true;
    try {
      const phaseName = phase === 'retain' ? 'amend.retain_rate' : `amend.${phase}`;
      if (!handle) {
        const result = await authorizeFirst({ operationDigest, phase: phaseName, requestDigest });
        // A timeout or ambiguous commit is never permission to continue. Any
        // committed UNKNOWN is deliberately left for separate reconciliation.
        if (!UUID.test(result?.holdId || '') || !HASH.test(result?.ownerToken || '')) {
          throw new Error('AMEND_DISPATCH_NOT_AUTHORIZED');
        }
        handle = Object.freeze({ holdId: result.holdId, ownerToken: result.ownerToken });
      }
      if (closed || amendNativeRequestDigest(request, phase) !== requestDigest) {
        throw new Error('AMEND_DISPATCH_NOT_AUTHORIZED');
      }
      await proceed();
      if (phase === 'availability') availabilityDone = true;
      else if (phase === 'save') saveDone = true;
      else retainDone = true;
    } catch (error) {
      closed = true;
      throw error;
    } finally {
      busy = false;
    }
  };

  return Object.freeze({
    availability: (request, proceed) => dispatch('availability', request, proceed),
    save: (request, proceed) => dispatch('save', request, proceed),
    retain: (request, proceed) => dispatch('retain', request, proceed),
    holdId: () => handle?.holdId ?? null,
    close: () => { closed = true; },
  });
}
