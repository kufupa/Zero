// A filing session permits Documents reads only for its already-verified Labtest record.
import { fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const keys = new Set(['system_function_name', 'user_function_name', 'current_tab_name', 'confirmationnumber',
  'reservationstayid', 'propertycode', 'guestfullname', 'account', 'guestid', 'hoteldate', 'lastname', 'firstname',
  'twitterid', 'facebookid', 'tripadvisorid', 'bookingdotcomid', 'room', 'daecode', 'daeparentpkcolumnnames',
  'daeparentpkkey', 'daerentity', 'labelnames', 'metadata']);
const staticFields = new Map([
  ['system_function_name', 'OSRESV'], ['user_function_name', 'OSRESV'], ['current_tab_name', 'DOC'],
  ['propertycode', 'HRCEN'], ['daerentity', 'RESV'], ['labelnames', 'DOC_LOV'],
  ['daeparentpkcolumnnames', 'CONFIRMATIONNUMBER,CODE,PROPERTYCODE'],
  ['daeparentpkkey', 'confirmationnumber,reservationstayid,propertycode,guestfullname,account,guestid,hoteldate,lastname,firstname,twitterid,facebookid,tripadvisorid,bookingdotcomid,room'],
  ['metadata', 'DOC_LOV,RESV,P,RSL,{null},{null},{null},{null},{null},{null},{null},{null},CODE,CONFIRMATIONNUMBER,PROPERTYCODE,{null},{null},{null},{null},{null}'],
]);

export function filingDocumentsMayRequest(request, { confirmation, native } = {}) {
  try {
    const url = new URL(request.url);
    if (String(request.method).toUpperCase() !== 'POST' || url.origin !== origin || url.username || url.password ||
        url.pathname !== '/web/base/OSRESV.DOC' || url.search || url.hash || typeof request.postData !== 'string' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '') ||
        !/^\d+-\d+$/.test(confirmation || '') || native?.propertyCode !== 'HRCEN' ||
        native.confirmation !== confirmation || native.firstName !== 'Proof' || native.lastName !== 'Labtest' ||
        native.status !== 'Reserved' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(native.arrival || '') || native.arrival < '2027-01-01' ||
        ![native.reservationStayId, native.reservationId, native.guestId].every((id) => /^\d{1,100}$/.test(id || ''))) return false;
    const body = new Map();
    for (const [key, value] of new URLSearchParams(request.postData)) {
      const normalized = key.toLowerCase();
      if (body.has(normalized) || !keys.has(normalized) || value.length > 512 || /[\p{Cc}]/u.test(value)) return false;
      body.set(normalized, value);
    }
    return body.size === keys.size && [...staticFields].every(([key, value]) => body.get(key) === value) &&
      body.get('confirmationnumber') === confirmation && body.get('reservationstayid') === native.reservationStayId &&
      body.get('guestid') === native.guestId && body.get('firstname') === native.firstName &&
      body.get('lastname') === native.lastName && body.get('daecode') === `${native.reservationId}#${confirmation}#HRCEN`;
  } catch { return false; }
}

/** Install before login. The callback remains empty until the selected record is independently verified. */
export async function installPaneAttachReadGuard(context, { confirmation, getNative } = {}) {
  if (typeof getNative !== 'function') throw new Error('DOCUMENT_IDENTITY_REQUIRED');
  await installSavedStayReadGuard(context, { confirmation });
  await context.route('**/*', async (route) => {
    const request = route.request();
    let path;
    try { path = new URL(request.url()).pathname; } catch { return route.abort(); }
    if (path !== '/web/base/OSRESV.DOC') return route.fallback();
    const allowed = filingDocumentsMayRequest({ method: request.method(), url: request.url(),
      postData: request.postData?.(), contentType: request.headers()['content-type'] }, { confirmation, native: getNative() });
    return allowed ? fulfillGuestLookupRequest(route) : route.abort();
  });
}
