// A filing session permits Documents reads only for its already-verified native stay.
import { fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { hasPageRequestAuthorization } from './page-request-fence.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const staticFields = new Map([
  ['system_function_name', 'OSRESV'], ['user_function_name', 'OSRESV'], ['current_tab_name', 'DOC'],
  ['daerentity', 'RESV'], ['labelnames', 'DOC_LOV'],
  ['daeparentpkcolumnnames', 'CONFIRMATIONNUMBER,CODE,PROPERTYCODE'],
]);
const checkedFields = new Set([...staticFields.keys(), 'propertycode', 'confirmationnumber', 'reservationstayid', 'guestid',
  'firstname', 'lastname', 'daecode', 'metadata']);
const mutationAction = /^(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|create|new|submit|send|upload|autosave|amend|post)$/i;

function matchesApprovedNativeIdentity(native, approved, confirmation) {
  return !!approved && approved.propertyCode === native.propertyCode && approved.confirmation === confirmation &&
    approved.reservationId === native.reservationId && approved.reservationStayId === native.reservationStayId &&
    approved.guestId === native.guestId && approved.firstName === native.firstName &&
    approved.lastName === native.lastName && approved.status === native.status &&
    approved.arrival === native.arrival && approved.departure === native.departure;
}

export function filingDocumentsMayRequest(request, { confirmation, native, propertyCode = 'HRCEN', allowRealGuest = false,
  approvedNativeIdentity } = {}) {
  try {
    const url = new URL(request.url);
    if (String(request.method).toUpperCase() !== 'POST' || url.origin !== origin || url.username || url.password ||
        url.pathname !== '/web/base/OSRESV.DOC' || url.search || url.hash || typeof request.postData !== 'string' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '') ||
        !getPropertyRegistration(propertyCode)?.active || !/^\d+-\d+$/.test(confirmation || '') || native?.propertyCode !== propertyCode ||
        native.confirmation !== confirmation || typeof native.status !== 'string' || !native.status.trim() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(native.arrival || '') ||
        ![native.reservationStayId, native.reservationId, native.guestId].every((id) => /^\d{1,100}$/.test(id || ''))) return false;
    const labtestGuest = native.firstName === 'Proof' && native.lastName === 'Labtest';
    const exactApprovedIdentity = approvedNativeIdentity === undefined ||
      matchesApprovedNativeIdentity(native, approvedNativeIdentity, confirmation);
    const labtestAllowed = labtestGuest && native.status === 'Reserved' && native.arrival >= '2027-01-01' && exactApprovedIdentity;
    const realGuestAllowed = allowRealGuest === true && !labtestGuest &&
      matchesApprovedNativeIdentity(native, approvedNativeIdentity, confirmation);
    if (!labtestAllowed && !realGuestAllowed) return false;
    const body = new Map();
    for (const [key, value] of new URLSearchParams(request.postData)) {
      const normalized = key.toLowerCase();
      if ((['action', 'pageaction'].includes(normalized) && mutationAction.test(value.trim())) ||
          (normalized === 'autosave' && !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase()))) return false;
      if (!checkedFields.has(normalized)) continue;
      if (body.has(normalized)) return false;
      if (normalized === 'metadata') {
        body.set(normalized, value.split(',').slice(0, 4).join(','));
        continue;
      }
      if (value.length > 512 || /[\p{Cc}]/u.test(value)) return false;
      body.set(normalized, value);
    }
    return [...staticFields].every(([key, value]) => body.get(key) === value) && body.get('propertycode') === propertyCode &&
      body.get('metadata') === 'DOC_LOV,RESV,P,RSL' &&
      body.get('confirmationnumber') === confirmation && body.get('reservationstayid') === native.reservationStayId &&
      body.get('guestid') === native.guestId && body.get('firstname') === native.firstName &&
      body.get('lastname') === native.lastName && body.get('daecode') === `${native.reservationId}#${confirmation}#${propertyCode}`;
  } catch { return false; }
}

/** Install before login. Identity remains empty until the selected native record is approved. */
export async function installPaneAttachReadGuard(context, { confirmation, getNative, propertyCode = 'HRCEN', getOwnedPage, forwardToCloud = false, allowRealGuest = false,
  getApprovedNativeIdentity } = {}) {
  if (typeof getNative !== 'function') throw new Error('DOCUMENT_IDENTITY_REQUIRED');
  const isAllowed = request => {
    const native = getNative();
    const approvedNativeIdentity = typeof getApprovedNativeIdentity === 'function'
      ? getApprovedNativeIdentity() : undefined;
    return filingDocumentsMayRequest(request, { confirmation, native, propertyCode, allowRealGuest, approvedNativeIdentity });
  };
  await installSavedStayReadGuard(context, { confirmation, propertyCode, getOwnedPage, forwardToCloud,
    allowAdditionalRead: isAllowed });
  await context.route('**/*', async (route) => {
    const request = route.request();
    let page;
    try { page = getOwnedPage?.(); } catch { return route.abort(); }
    if (forwardToCloud && !page || page && hasPageRequestAuthorization(request, page)) return route.fallback();
    let path;
    try { path = new URL(request.url()).pathname; } catch { return route.abort(); }
    if (path !== '/web/base/OSRESV.DOC') return route.fallback();
    let allowed;
    try {
      allowed = isAllowed({ method: request.method(), url: request.url(),
        postData: request.postData?.(), contentType: request.headers()['content-type'] });
    } catch { return route.abort(); }
    return allowed ? (forwardToCloud ? route.fallback() : fulfillGuestLookupRequest(route)) : route.abort();
  });
}
