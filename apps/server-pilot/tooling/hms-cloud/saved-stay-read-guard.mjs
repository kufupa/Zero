// The exact-confirmation reader owns a fresh context and admits only the
// observed login and Stay 360 navigation posts. Unknown requests fail closed.
import { fulfillGuestLookupRequest, guestLookupMayRequest } from './pane-guest-search.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { hasPageRequestAuthorization } from './page-request-fence.mjs';

const readPosts = new Set(['/web/base/login', '/web/base/BSSTRT', '/web/base/BSSTRT.HDR', '/web/base/LOVPOP']);
const recordQuery = new Map([
  ['current_tab_name', 'HDR'], ['fromlogin', 'yes'], ['hyperlinksource', 'F'],
  ['includeinitparams', 'true'], ['initpath', 'OSRESV'], ['menu_module_key', '-1'],
  ['popup', 'TRUE'], ['system_function_name', 'OSRESV'], ['uitheme', 'inforhms'],
  ['user_function_name', 'OSRESV'],
]);
const recordListFields = new Map([
  ['component_info_type', 'HEAD_DATA'], ['dataspy_id', ''], ['addons_required', 'true'],
  ['filterfields', 'confirmationnumber'], ['filteroperator', '='], ['run_ds', 'false'],
  ['addon_sort_element_alias_name', 'primaryguest'], ['addon_sort_element_type', 'DESC'],
  ['rememberdsandqf', 'false'], ['system_function_name', 'OSRESV'], ['user_function_name', 'OSRESV'],
  ['current_tab_name', 'LST'], ['menu_module_key', '0'], ['removescreenflows', 'yes'],
]);
const recordHeaderKeys = new Set(['system_function_name', 'user_function_name', 'current_tab_name',
  'confirmationnumber', 'reservationstayid', 'propertycode', 'guestfullname', 'account', 'guestid', 'hoteldate',
  'lastname', 'firstname', 'twitterid', 'facebookid', 'tripadvisorid', 'bookingdotcomid', 'room']);
// Captured HRCEN quick-search scaffold. The two date filters bracket an
// OR-group whose nine native identity filters all receive the selected token.
const staySearchSlots = [
  ['departuredate', '>=', 'AND'], ['arrivaldate', '<=', 'AND'],
  ['confirmationnumber', 'BEGINS', 'OR'], ['room', '=', 'OR'],
  ['lastname_filter', 'BEGINS', 'OR'], ['secondlastname', 'BEGINS', 'OR'],
  ['alternatelastname', 'BEGINS', 'OR'], ['aliaslastname', 'BEGINS', 'OR'],
  ['loyaltynumber', 'BEGINS', 'OR'], ['externalconfirmation', 'BEGINS', 'OR'],
  ['thirdpartyconfirmationnumber', 'BEGINS', 'OR'],
];
const staySearchParens = new Map([['maddon_lparen_3', 'true'], ['maddon_lparen_5', 'false'],
  ['maddon_rparen_6', 'false'], ['maddon_rparen_11', 'true']]);

function uniqueParams(params) {
  const values = new Map();
  for (const [key, value] of params) {
    const normalized = key.toLowerCase();
    if (values.has(normalized)) return null;
    values.set(normalized, value);
  }
  return values;
}

const validConfirmation = (value, allowBaseConfirmation = false) =>
  /^\d+-\d+$/.test(value || '') || (allowBaseConfirmation && /^\d{6,10}$/.test(value || ''));

function isSelectedRecordNavigation(url, confirmation, allowBaseConfirmation) {
  if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password ||
      url.hash || url.pathname !== '/web/base/loadmain' || !validConfirmation(confirmation, allowBaseConfirmation)) return false;
  const query = uniqueParams(url.searchParams);
  if (!query || query.size !== recordQuery.size + 2 ||
      [...recordQuery].some(([key, value]) => query.get(key) !== value) ||
      !/^(?:[a-z0-9]|%[a-f0-9]{2}){1,180}&browserTabID=[a-z0-9]{1,40}$/i.test(query.get('requesttoken') || '')) return false;
  const initial = uniqueParams(new URLSearchParams(query.get('initparams')));
  return initial?.size === 2 && initial.get('startupview') === 'right' &&
    initial.get('autotracepopupskipconfnum') === confirmation;
}

function isSelectedStaySearch(url, request, confirmation, allowBaseConfirmation) {
  if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password ||
      url.search || url.hash || !validConfirmation(confirmation, allowBaseConfirmation) || typeof request.postData !== 'string' ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return false;
  const body = uniqueParams(new URLSearchParams(request.postData));
  if (!body) return false;
  const fixed = new Map([['system_function_name', 'OSRESS'], ['user_function_name', 'OSRESS'],
    ['current_tab_name', 'LST'], ['component_info_type', 'DATA_ONLY'], ['grid_name', 'OSRESS'],
    ['externalconfirmation', confirmation], ...staySearchParens]);
  const expected = new Set([...fixed.keys(), 'dataspy_id', 'grid_id']);
  if ([...fixed].some(([key, value]) => body.get(key) !== value) ||
      !/^\d{1,12}$/.test(body.get('dataspy_id') || '') || !/^\d{1,12}$/.test(body.get('grid_id') || '')) return false;
  for (const [index, [alias, operator, joiner]] of staySearchSlots.entries()) {
    const n = index + 1;
    const keys = ['alias_name', 'operator', 'joiner', 'seqnum', 'value'].map((key) => `maddon_filter_${key}_${n}`);
    keys.forEach((key) => expected.add(key));
    const value = body.get(keys[4]);
    if (body.get(keys[0]) !== alias || body.get(keys[1]) !== operator || body.get(keys[2]) !== joiner ||
        body.get(keys[3]) !== String(n) ||
        (index < 2 ? !/^[+-]?\d{1,4}$/.test(value || '') || Math.abs(Number(value)) > 3660 : value !== confirmation)) return false;
  }
  return body.size === expected.size && [...expected].every((key) => body.has(key));
}

export function savedStayReadMayRequest(request, { confirmation, propertyCode = 'HRCEN', allowBaseConfirmation = false } = {}) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active) return false;
    const url = new URL(request.url);
    if (String(request.method).toUpperCase() === 'GET' && url.pathname === '/web/base/loadmain') {
      return isSelectedRecordNavigation(url, confirmation, allowBaseConfirmation) || guestLookupMayRequest({ ...request, propertyCode });
    }
    if (String(request.method).toUpperCase() === 'POST' && url.pathname === '/web/base/OSRESV.LST') {
      if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password ||
          url.search || url.hash || !validConfirmation(confirmation, allowBaseConfirmation) || typeof request.postData !== 'string' ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return false;
      const body = uniqueParams(new URLSearchParams(request.postData));
      return body?.size === recordListFields.size + 1 && body.get('filtervalue') === confirmation &&
        [...recordListFields].every(([key, value]) => body.get(key) === value);
    }
    if (String(request.method).toUpperCase() === 'POST' && url.pathname === '/web/base/OSRESV.HDR') {
      if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password ||
          url.search || url.hash || !validConfirmation(confirmation, allowBaseConfirmation) || typeof request.postData !== 'string' ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return false;
      const body = uniqueParams(new URLSearchParams(request.postData));
      if (!body) return false;
      const chrome = body.size === recordHeaderKeys.size + 2 && body.get('menu_module_key') === '0' &&
        body.get('removescreenflows') === 'yes';
      const recordReturn = body.size === recordHeaderKeys.size + 2 && body.get('scrollrow') === 'YES' &&
        body.get('only_data_required') === 'true';
      if (body.size !== recordHeaderKeys.size && !chrome && !recordReturn) return false;
      return [...recordHeaderKeys].every((key) => body.has(key)) && [...body].every(([key, value]) =>
        (recordHeaderKeys.has(key) || (chrome && ['menu_module_key', 'removescreenflows'].includes(key)) ||
          (recordReturn && ['scrollrow', 'only_data_required'].includes(key))) &&
        value.length <= 256 && !/[\p{Cc}]/u.test(value)) &&
        body.get('system_function_name') === 'OSRESV' && body.get('user_function_name') === 'OSRESV' &&
        body.get('current_tab_name') === 'HDR' && body.get('confirmationnumber') === confirmation &&
        body.get('propertycode') === propertyCode && /^\d{1,100}$/.test(body.get('reservationstayid') || '') &&
        /^\d{1,100}$/.test(body.get('guestid') || '');
    }
    if (String(request.method).toUpperCase() === 'POST' && url.pathname === '/web/base/OSRESV' && !url.search) {
      if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password || url.hash ||
          !validConfirmation(confirmation, allowBaseConfirmation) || typeof request.postData !== 'string' ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return false;
      const body = uniqueParams(new URLSearchParams(request.postData));
      return body?.size === 6 && body.get('system_function_name') === 'OSRESV' &&
        body.get('user_function_name') === 'OSRESV' && body.get('startupview') === 'right' &&
        body.get('autotracepopupskipconfnum') === confirmation && body.get('menu_module_key') === '0' &&
        body.get('removescreenflows') === 'yes';
    }
    if (String(request.method).toUpperCase() === 'POST' && url.pathname === '/web/jsp/7iosress_getstaydata.jsp') {
      if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.username || url.password || url.search || url.hash ||
          !validConfirmation(confirmation, allowBaseConfirmation) || typeof request.postData !== 'string' ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) return false;
      const body = [...new URLSearchParams(request.postData)];
      return body.length === 1 && body[0][0].toLowerCase() === 'confirmationnumber' && body[0][1] === confirmation;
    }
    if (String(request.method).toUpperCase() === 'POST' && url.pathname === '/web/base/OSRESS.search' &&
        typeof request.postData === 'string') {
      if (!isSelectedStaySearch(url, request, confirmation, allowBaseConfirmation)) return false;
      const body = new URLSearchParams(request.postData);
      const userKeys = [...body.keys()].filter((key) => key.toLowerCase() === 'user_function_name');
      const gridKeys = [...body.keys()].filter((key) => key.toLowerCase() === 'grid_name');
      if (userKeys.length !== 1 || body.get(userKeys[0]) !== 'OSRESS' ||
          gridKeys.length !== 1 || body.get(gridKeys[0]) !== 'OSRESS') return false;
      // Same observed read/search shape as the surname finder, but the Stay
      // 360 confirmation search identifies its user function as OSRESS.
      body.set(userKeys[0], 'OSRESV');
      return guestLookupMayRequest({ ...request, postData: body.toString(), propertyCode });
    }
    if (!guestLookupMayRequest({ ...request, propertyCode })) return false;
    if (String(request.method).toUpperCase() === 'GET') return true;
    if (String(request.method).toUpperCase() !== 'POST') return false;
    if (url.pathname === '/web/base/OSRESS') {
      const body = new URLSearchParams(request.postData);
      const value = (params) => [...params].find(([key]) => key.toLowerCase() === 'function_class')?.[1];
      return value(url.searchParams) === 'WEBL' && value(body) === 'WEBL';
    }
    return readPosts.has(url.pathname);
  }
  catch { return false; }
}

export async function installSavedStayReadGuard(context, { confirmation, propertyCode = 'HRCEN',
  getOwnedPage, forwardToCloud = false, allowAdditionalRead, allowBaseConfirmation = false } = {}) {
  if (!validConfirmation(confirmation, allowBaseConfirmation)) throw new Error('READ_CONFIRMATION_REQUIRED');
  if (!getPropertyRegistration(propertyCode)?.active) throw new Error('READ_PROPERTY_UNSUPPORTED');
  if (typeof allowBaseConfirmation !== 'boolean' || (allowBaseConfirmation && forwardToCloud) ||
      typeof forwardToCloud !== 'boolean' || (forwardToCloud && typeof getOwnedPage !== 'function')) throw new Error('READ_PAGE_SCOPE_INVALID');
  if (typeof context.routeWebSocket !== 'function') throw new Error('READ_SOCKET_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    let page;
    try { page = getOwnedPage?.(); } catch { return route.abort(); }
    // Login and the registered property switch remain subject to the Cloud
    // session guard; target reads are scoped as soon as it supplies its page.
    if (forwardToCloud && !page) return route.fallback();
    if (page && hasPageRequestAuthorization(request, page)) return route.fallback();
    const descriptor = { method: request.method(), url: request.url(),
      postData: request.postData?.(), contentType: request.headers()['content-type'] };
    let allowed;
    try { allowed = savedStayReadMayRequest(descriptor, { confirmation, propertyCode, allowBaseConfirmation }) ||
      (typeof allowAdditionalRead === 'function' && allowAdditionalRead(descriptor) === true); }
    catch { return route.abort(); }
    return allowed ? (forwardToCloud ? route.fallback() : fulfillGuestLookupRequest(route)) : route.abort();
  });
}
