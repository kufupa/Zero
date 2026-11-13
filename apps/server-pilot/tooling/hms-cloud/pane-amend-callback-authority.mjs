import { createHash } from 'node:crypto';
import { amendNativeRequestDigest } from './labtest-amend-dispatch.mjs';

const issued = new WeakSet();
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PARTY_PATHS = Object.freeze({
  organization: '/web/base/OSRESV.HDR.changeorganization',
  bookingAgency: '/web/base/OSRESV.HDR.changetravelagency',
  arAccount: '/web/base/OSRESV.HDR.araccountchange',
});

function partyDigest(request, kind) {
  try {
    const url = new URL(request.url()), contentType = request.headers()['content-type'];
    const body = request.postDataBuffer();
    if (request.method() !== 'POST' || url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' ||
        url.pathname !== PARTY_PATHS[kind] || url.search || url.hash ||
        typeof contentType !== 'string' || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) ||
        !Buffer.isBuffer(body) || body.length === 0 || body.length > 2 * 1024 * 1024) return null;
    const hash = createHash('sha256');
    hash.update('nava-amend-native-request/v1\0');
    for (const value of [`party:${kind}`, request.method(), url.href, contentType]) {
      hash.update(String(Buffer.byteLength(value))).update(':').update(value);
    }
    hash.update(String(body.length)).update(':').update(body);
    return hash.digest('hex');
  } catch { return null; }
}

const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const callbackPlanDigest = plan => createHash('sha256').update(JSON.stringify(sorted(plan))).digest('hex');
export const isFirstGoCallbackAuthority = value => Boolean(value && issued.has(value));

/** An issued source-bound capability; no native continuation can precede the durable claim. */
export function createFirstGoCallbackAuthority({ operationDigest, sourceDigest, targetDigest, approvedPlanDigest, plan, phases,
  authorizeFirst, isEnabled = () => true }) {
  if (!HASH.test(operationDigest || '') || !HASH.test(sourceDigest || '') || !HASH.test(targetDigest || '') ||
      !HASH.test(approvedPlanDigest || '') || !plan || callbackPlanDigest(plan) !== approvedPlanDigest ||
      !Array.isArray(phases) || phases.length < 2 || phases.at(-1) !== 'availability' ||
      phases.some(phase => !['guarantee', 'organization', 'bookingAgency', 'arAccount', 'children', 'availability'].includes(phase)) ||
      new Set(phases).size !== phases.length || typeof authorizeFirst !== 'function' || typeof isEnabled !== 'function') {
    throw new Error('AMEND_CALLBACK_AUTHORITY_INVALID');
  }
  const order = ['guarantee', 'organization', 'bookingAgency', 'arAccount', 'children', 'availability'];
  if (phases.some((phase, index) => index > 0 && order.indexOf(phase) <= order.indexOf(phases[index - 1]))) {
    throw new Error('AMEND_CALLBACK_AUTHORITY_INVALID');
  }
  const planned = Object.freeze([...phases]);
  const planPhases = [...(plan.guarantee ? ['guarantee'] : []),
    ...(Array.isArray(plan.parties) ? plan.parties.map(party => party.kind) : []),
    ...(plan.children ? ['children'] : []), 'availability'];
  if (JSON.stringify(planPhases) !== JSON.stringify(planned)) throw new Error('AMEND_CALLBACK_AUTHORITY_INVALID');
  let next = 0, handle = null, busy = false, closed = false, possiblyPersisted = false;
  const active = () => !closed && isEnabled();
  const digest = (request, phase) => Object.hasOwn(PARTY_PATHS, phase) ? partyDigest(request, phase) : amendNativeRequestDigest(request, phase);
  const eligible = (request, phase) => active() && !busy && planned[next] === phase && digest(request, phase);
  const dispatch = async (phase, request, proceed) => {
    const requestDigest = eligible(request, phase);
    if (!requestDigest || typeof proceed !== 'function') {
      closed = true;
      throw new Error('AMEND_CALLBACK_DISPATCH_UNAUTHORIZED');
    }
    busy = true;
    try {
      if (!handle) {
        const result = await authorizeFirst({ operationDigest, sourceDigest, targetDigest, approvedPlanDigest,
          phase: Object.hasOwn(PARTY_PATHS, phase) ? `amend.party.${phase}` : `amend.${phase}`, requestDigest });
        if (!UUID.test(result?.holdId || '') || !HASH.test(result?.ownerToken || '')) {
          throw new Error('AMEND_CALLBACK_CLAIM_UNVERIFIED');
        }
        handle = Object.freeze({ holdId: result.holdId, ownerToken: result.ownerToken });
      }
      if (!active() || digest(request, phase) !== requestDigest) throw new Error('AMEND_CALLBACK_DISPATCH_UNAUTHORIZED');
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
    authorizeParty: request => Boolean(eligible(request, planned[next]) && Object.hasOwn(PARTY_PATHS, planned[next])),
    dispatchParty: (request, proceed) => dispatch(planned[next], request, proceed),
    dispatchGuarantee: (request, proceed) => dispatch('guarantee', request, proceed),
    dispatchChildren: (request, proceed) => dispatch('children', request, proceed),
    dispatchAvailability: (request, proceed) => dispatch('availability', request, proceed),
    holdId: () => handle?.holdId ?? null,
    possiblyPersisted: () => possiblyPersisted,
    complete: () => active() && !busy && next === planned.length,
    close: () => { closed = true; },
  });
  issued.add(authority);
  return authority;
}
