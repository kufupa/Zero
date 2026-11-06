// Staff surname search in an owned HRCEN browser, using the existing complete-panel parser.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { searchGuestOnOpenGuestStay } from '../playwright-quote/stay-lookup.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const common = ['system_function_name', 'user_function_name'];
// Exact login, menu and search requests observed for this lookup. A new HMS
// request shape fails closed until independently verified.
const posts = new Map([
  ['/web/base/login', { system: 'LOGIN', user: 'LOGIN', fields: [...common, 'csrftckt', 'password', 'resetpassword', 'tenant', 'userid'] }],
  ['/web/base/BSSTRT', { system: 'BSSTRT', user: 'BSSTRT', fields: [...common, 'menu_module_key', 'removescreenflows'] }],
  ['/web/base/BSSTRT.HDR', { system: 'BSSTRT', user: 'BSSTRT', fields: [...common, 'manurefresh'] }],
  ...['OSRESS', 'OSRESV'].map((name) => [`/web/base/${name}`, { system: name, user: name, tab: '',
    fields: [...common, 'current_tab_name', 'function_class', 'menu_module_key', 'removescreenflows'], menuQuery: true }]),
  ['/web/base/OSRESV.HDR', { system: 'OSRESV', user: 'OSRESV', tab: 'HDR', fields: [...common, 'current_tab_name',
    'account', 'bookingdotcomid', 'confirmationnumber', 'facebookid', 'firstname', 'guestfullname', 'guestid', 'hoteldate',
    'lastname', 'menu_module_key', 'propertycode', 'removescreenflows', 'reservationstayid', 'room', 'tripadvisorid', 'twitterid'] }],
  ['/web/base/OSRESV.LST', { system: 'OSRESV', user: 'OSRESV', tab: 'LST', fields: [...common, 'current_tab_name',
    'component_info_type', 'menu_module_key', 'removescreenflows'] }],
  ['/web/base/OSRESS.search', { system: 'OSRESS', user: 'OSRESV', tab: 'LST', search: true, fields: [...common,
    'component_info_type', 'current_tab_name', 'dataspy_id', 'externalconfirmation', 'grid_id', 'grid_name'] }],
]);
const searchField = /^maddon_(?:filter_(?:alias_name|joiner|operator|seqnum|value)|lparen|rparen)_\d{1,2}$/;
const mutatingPath = /save|delete|cancel|duplicate|checkin|checkout|upload|send|email|amend/i;
const assetPath = /^\/web\/resources\/(?:shared|inforhms)\/[a-z0-9_./-]+\.(?:css|js|svg|png|ttf)$/i;

function uniqueParams(params) {
  const values = new Map();
  for (const [key, value] of params) {
    const normalized = key.toLowerCase();
    if (values.has(normalized)) return null;
    values.set(normalized, value);
  }
  return values;
}

export function guestLookupMayRequest({ method, url, postData, contentType }) {
  try {
    const target = new URL(url), verb = String(method).toUpperCase();
    const decodedPath = decodeURIComponent(target.pathname);
    if (target.origin !== ORIGIN || target.username || target.password || decodedPath !== target.pathname ||
        shouldAbortReadOnlyRequest({ method: verb, url, postData })) return false;
    const query = uniqueParams(target.searchParams);
    if (!query) return false;
    if (verb === 'GET') {
      if (decodedPath === '/web/base/logindisp') return query.size === 1 && query.get('tenant') === 'THECENTURION_PRD';
      if (decodedPath === '/web/base/COMMON') {
        const key = query.get('req_key') || '';
        return query.size === 1 && key.length <= 1024 && key.length > 0 && !/[\p{Cc}]/u.test(key) && !mutatingPath.test(key);
      }
      if (query.size) return false;
      return ['/web/base/login-all.js', '/web/base/all-classes.js', '/web/jsp/interfaceStatusAlert.jsp'].includes(decodedPath) ||
        assetPath.test(decodedPath);
    }
    const rule = posts.get(target.pathname);
    if (verb !== 'POST' || mutatingPath.test(decodedPath) || !rule || typeof postData !== 'string' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType || '')) return false;
    const body = uniqueParams(new URLSearchParams(postData));
    if (!body || [...query.keys()].some((key) => !rule.menuQuery || !['function_class', 'user_function_name'].includes(key)) ||
        rule.fields.some((key) => !body.has(key)) ||
        [...body.keys()].some((key) => !rule.fields.includes(key) && !(rule.search && searchField.test(key)))) return false;
    if (rule.menuQuery && (query.size !== 2 || query.get('user_function_name') !== rule.user ||
        query.get('function_class') !== 'WEBL' || body.get('function_class') !== 'WEBL')) return false;
    if (decodedPath === '/web/base/login' && (body.get('tenant') !== 'THECENTURION_PRD' ||
        !body.get('csrftckt') || !body.get('userid') || !body.get('password') ||
        !['', 'false', '0'].includes(body.get('resetpassword').toLowerCase()))) return false;
    return body.get('system_function_name') === rule.system && body.get('user_function_name') === rule.user &&
      (rule.tab === undefined || body.get('current_tab_name') === rule.tab);
  } catch { return false; }
}

/** Fetch once without following a redirect; never hand a redirect back to the browser. */
export async function fulfillGuestLookupRequest(route) {
  try {
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
    if (response.status() >= 300 && response.status() < 400) return route.abort();
    return route.fulfill({ response });
  } catch { return route.abort(); }
}

export async function installGuestLookupGuard(context) {
  // A service worker or socket could bypass ordinary request routing.
  if (typeof context.routeWebSocket !== 'function') throw new Error('LOOKUP_SOCKET_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const allowed = guestLookupMayRequest({ method: request.method(), url: request.url(), postData: request.postData?.(),
      contentType: request.headers()['content-type'] });
    return allowed ? fulfillGuestLookupRequest(route) : route.abort();
  });
}

async function openGuestStay(page) {
  const node = (name) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${name}$`) });
  const trigger = page.locator('a.app-menu-trigger:visible');
  if (await trigger.count() !== 1) throw new Error('MENU_NOT_UNIQUE');
  await trigger.click({ timeout: 10_000 });
  // Children can take a moment to render; inspect the branch state instead of
  // toggling an expanded branch merely because Guest Stay is not visible yet.
  const front = node('Front Desk');
  await front.waitFor({ state: 'visible', timeout: 10_000 });
  if (await front.count() !== 1) throw new Error('FRONT_DESK_NOT_UNIQUE');
  const branch = await front.locator('xpath=ancestor::tr[1]').getAttribute('class');
  if (!branch || !branch.split(/\s+/).includes('x-grid-row')) throw new Error('FRONT_DESK_STATE_UNVERIFIED');
  if (!branch.split(/\s+/).includes('x-grid-tree-node-expanded')) await front.click({ timeout: 10_000 });
  const guest = node('Guest Stay');
  await guest.waitFor({ state: 'visible', timeout: 10_000 });
  if (await guest.count() !== 1) throw new Error('GUEST_STAY_NOT_UNIQUE');
  await guest.click({ timeout: 10_000 });
  await page.getByPlaceholder(/Search by Name, Confirmation/i).first().waitFor({ state: 'visible', timeout: 10_000 });
  const valid = await page.evaluate(() => {
    const property = document.documentElement.dataset.propertyCode ??
      /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
    return location.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com' && property === 'HRCEN';
  });
  if (!valid) throw new Error('GUEST_STAY_PROPERTY_UNVERIFIED');
}

/** No write operations; search result cap and unreadable-row handling remain with the existing parser. */
export async function searchGuestInCloud(input, { openSession = withCenturionStay360Page,
  guard = installGuestLookupGuard, navigate = openGuestStay, search = searchGuestOnOpenGuestStay, signal } = {}) {
  const timeout = AbortSignal.timeout(5 * 60_000);
  return openSession(async (page) => {
    await navigate(page);
    return search({ page, args: { mode: 'search-guest', lastName: input.lastName, arrival: input.arrival,
      departure: input.departure ?? null, debugHtml: false }, dir: input.dir, started: Date.now() });
  }, { headless: true, blockServiceWorkers: true, prepareContext: guard,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}
