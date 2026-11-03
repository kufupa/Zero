// Read-only guest-profile lookup for the staff pane. No selection or save is made here.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { fulfillGuestLookupRequest, guestLookupMayRequest } from './pane-guest-search.mjs';
import { openNewGuestStay } from './lookup.mjs';
import { inspectGuestProfileCandidates, searchGuestProfiles } from './guest-profile.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const blankFields = ['account', 'bookingdotcomid', 'confirmationnumber', 'facebookid', 'firstname', 'guestfullname',
  'guestid', 'hoteldate', 'lastname', 'propertycode', 'reservationstayid', 'room', 'tripadvisorid', 'twitterid'];
const blankKeys = [...blankFields, 'current_tab_name', 'only_data_required', 'scrollrow', 'system_function_name', 'user_function_name'];
const popupKeys = ['current_tab_name', 'grid_name', 'grid_type', 'lov_alias_name_1', 'lov_alias_type_1',
  'lov_alias_value_1', 'lov_tagname', 'request_type', 'user_function_name', 'popup'];
const gridKeys = ['current_tab_name', 'dataspy_id', 'grid_id', 'grid_name', 'grid_type', 'lov_alias_name_1',
  'lov_alias_type_1', 'lov_alias_value_1', 'lov_tagname', 'maddon_filter_alias_name_1', 'maddon_filter_joiner_1',
  'maddon_filter_operator_1', 'maddon_filter_seqnum_1', 'maddon_filter_value_1', 'maddon_lparen_1', 'maddon_rparen_1',
  'request_type', 'user_function_name'];
const validQuery = (value) => typeof value === 'string' && value === value.trim() && value.length >= 2 &&
  value.length <= 40 && /^\p{L}[\p{L} '-]*\p{L}$/u.test(value);

function form(request, keys) {
  if (request.method !== 'POST' || typeof request.postData !== 'string' ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return null;
  const result = new Map();
  for (const [key, value] of new URLSearchParams(request.postData)) {
    const name = key.toLowerCase();
    if (result.has(name)) return null;
    result.set(name, value);
  }
  return result.size === keys.length && keys.every((key) => result.has(key)) ? Object.fromEntries(result) : null;
}

/** Admit only the observed blank-form and surname-picker requests in addition to the existing read guard. */
export function guestProfileLookupMayRequest(request, query) {
  if (!validQuery(query)) return false;
  if (guestLookupMayRequest(request)) return true;
  try {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash ||
        decodeURIComponent(url.pathname) !== url.pathname) return false;
    if (url.pathname === '/web/base/OSRESV.HDR') {
      const data = form(request, blankKeys);
      return !!data && data.system_function_name === 'OSRESV' && data.user_function_name === 'OSRESV' &&
        data.current_tab_name === 'HDR' && data.only_data_required === 'true' && data.scrollrow === 'YES' &&
        blankFields.every((key) => data[key] === '');
    }
    if (url.pathname === '/web/base/LOVPOP') {
      const data = form(request, popupKeys);
      return !!data && data.current_tab_name === 'HDR' && data.user_function_name === 'OSRESV' &&
        data.grid_name === 'LVGUESTS' && data.grid_type === 'LOV' && data.request_type === 'LOV.HEAD_DATA.STORED' &&
        data.lov_tagname === 'lastname' && data.lov_alias_name_1 === 'param.propertycode' &&
        data.lov_alias_type_1 === 'text' && data.lov_alias_value_1 === 'HRCEN' && data.popup === 'true';
    }
    if (url.pathname === '/web/base/GRIDDATA') {
      const data = form(request, gridKeys);
      return !!data && data.current_tab_name === 'HDR' && data.user_function_name === 'OSRESV' &&
        data.grid_name === 'LVGUESTS' && data.grid_type === 'LOV' && /^\d{1,20}$/.test(data.grid_id) &&
        /^\d{1,20}$/.test(data.dataspy_id) && data.request_type === 'LOV.DATA_ONLY.STORED' &&
        data.lov_tagname === 'lastname' && data.lov_alias_name_1 === 'param.propertycode' &&
        data.lov_alias_type_1 === 'text' && data.lov_alias_value_1 === 'HRCEN' &&
        data.maddon_filter_alias_name_1 === 'lastname' && data.maddon_filter_operator_1 === 'CONTAINS' &&
        data.maddon_filter_joiner_1 === 'AND' && data.maddon_filter_seqnum_1 === '1' &&
        data.maddon_lparen_1 === 'false' && data.maddon_rparen_1 === 'false' &&
        data.maddon_filter_value_1.trim().toLocaleLowerCase() === query.toLocaleLowerCase();
    }
  } catch { /* Unparseable requests are not allowed. */ }
  return false;
}

export async function installGuestProfileLookupGuard(context, query) {
  if (!validQuery(query) || typeof context.routeWebSocket !== 'function') throw new Error('PROFILE_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const allowed = guestProfileLookupMayRequest({ method: request.method(), url: request.url(),
      postData: request.postData?.(), contentType: request.headers()['content-type'] }, query);
    return allowed ? fulfillGuestLookupRequest(route) : route.abort();
  });
}

const clean = (value) => typeof value === 'string' && value.trim() && value.length <= 200 &&
  !/[\p{Cc}]/u.test(value) ? value.trim() : null;

/** Results describe a correlated current lookup, not permission to select or create a guest. */
export async function searchGuestProfilesForPane(lastName, { openSession = withCenturionStay360Page,
  navigate = openNewGuestStay, search = searchGuestProfiles, inspect = inspectGuestProfileCandidates } = {}) {
  if (!validQuery(lastName)) return { status: 'unavailable' };
  try {
    return await openSession(async (page) => {
      await navigate(page);
      const property = page.locator('[data-qtip="Property"]:visible');
      if (await property.count() !== 1 || (await property.innerText()).trim() !== 'HRCEN') throw new Error('PROPERTY_MISMATCH');
      const found = await search(page, { field: 'lastName', query: lastName });
      const loaded = found.coverage?.loaded;
      if (!['matches', 'no_match'].includes(found.outcome) || !Number.isSafeInteger(loaded) || loaded < 0 || loaded > 10000 ||
          !Array.isArray(found.candidates) || found.candidates.length !== Math.min(loaded, 25)) throw new Error('PROFILE_SEARCH_UNVERIFIED');
      if (found.outcome === 'no_match' && (loaded !== 0 || found.coverage?.serverMoreRecords !== false ||
          found.coverage?.total !== 0)) throw new Error('PROFILE_SEARCH_UNVERIFIED');
      const rows = [...found.candidates];
      for (let offset = 25; offset < Math.min(loaded, 50); offset += 25) {
        const pageResult = await inspect(page, { searchId: found.searchId, offset, limit: 25 });
        if (pageResult.outcome !== 'current' || !Array.isArray(pageResult.candidates) ||
            pageResult.candidates.length !== Math.min(25, loaded - offset)) throw new Error('PROFILE_SEARCH_UNVERIFIED');
        rows.push(...pageResult.candidates);
      }
      const verified = new Set(found.correlation?.verifiedFields ?? []);
      if (!['guestid', 'firstname', 'lastname'].every((key) => verified.has(key))) throw new Error('PROFILE_SEARCH_UNVERIFIED');
      const candidates = rows.map((row) => ({ nativeId: /^\d{1,30}$/.test(row.nativeId ?? '') ? row.nativeId : null,
        firstName: clean(row.firstName), lastName: clean(row.lastName),
        city: verified.has('city') ? clean(row.city) : null, country: verified.has('country') ? clean(row.country) : null }));
      return { status: 'ok', candidates, moreAvailable: loaded > rows.length || found.coverage?.possiblyTruncated !== false };
    }, { headless: true, blockServiceWorkers: true,
      prepareContext: (context) => installGuestProfileLookupGuard(context, lastName), signal: AbortSignal.timeout(90_000) });
  } catch { return { status: 'unavailable' }; }
}
