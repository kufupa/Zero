// Verify the complete native Associated Reservations response for one saved stay.
import { openStay360RecordTab } from './hms-readers.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const unique = (object, key) => object && Object.hasOwn(object, key) &&
  Object.keys(object).filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1;
const exact = (object, key, value) => unique(object, key) && object[key] === value;

// HMS returns data-only JavaScript literals; normalize strings and keys without evaluating code.
export function parseAssociationResponse(body) {
  if (typeof body !== 'string' || body.length > 2_000_000) return null;
  let badEscape = false;
  const strings = body.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (_all, double, single) => {
    const text = double ? double.slice(1, -1) : single;
    const value = text.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (_match, escape) => {
      const values = { "'": "'", '"': '"', '\\': '\\', '/': '/', '-': '-', n: '\n', r: '\r',
        t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (Object.hasOwn(values, escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      badEscape = true;
      return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) return null;
  const json = strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (_match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  try {
    const tokens = json.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) || [], stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1) instanceof Set) {
        const name = JSON.parse(token).toLowerCase(), keys = stack.at(-1);
        if (keys.has(name)) return null;
        keys.add(name);
      }
    }
    return JSON.parse(json);
  } catch { return null; }
}

// The header describes the current cancellation scope. Grid rows are informational:
// their presence, absence or count does not select the stay being cancelled.
export function matchesAssociationRequest(request, frame, expected) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = { CURRENT_TAB_NAME: 'RAN', SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV',
      propertycode: 'HRCEN', confirmationnumber: expected.confirmation, reservationstayid: expected.nativeStayId,
      guestid: expected.guestId, firstname: expected.firstName, lastname: expected.lastName };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === '/web/base/OSRESV.RAN' && !url.search && !url.hash &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => typeof value === 'string' &&
        body.getAll(key).length === 1 && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1 &&
        body.get(key) === value);
  } catch { return false; }
}

function currentOnlyScope(values, expected) {
  const empty = (key) => unique(values, key) && [null, '', '0', 0].includes(values[key]);
  const inactive = (key) => unique(values, key) && ['0', 0, false].includes(values[key]);
  // A native bulk selection is different from merely showing associated rows.
  const bulk = values?.associateconfnumbers;
  const currentSelection = !Object.hasOwn(values ?? {}, 'associateconfnumbers') ||
    (unique(values, 'associateconfnumbers') && [null, '', expected.confirmation].includes(bulk));
  return exact(values, 'propertycode', 'HRCEN') && exact(values, 'guestid', expected.guestId) &&
    exact(values, 'firstname', expected.firstName) && exact(values, 'lastname', expected.lastName) &&
    exact(values, 'parentconfirmationnumber', expected.confirmation) && currentSelection &&
    ['coordinatorreservationid', 'groupid', 'reservationshareid'].every(empty) &&
    ['coordinator', 'share', 'isparentreservationshare', 'isparentreservationprimaryshare'].every(inactive);
}

/** Hand native group/share operations to staff; an exact single-stay Save remains independently fenced. */
export async function verifySingleCancellationScope(page, expected) {
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) return false;
  const frame = await (await frames.elementHandle())?.contentFrame();
  if (!frame) return false;
  const pending = page.waitForResponse((response) => matchesAssociationRequest(response.request(), frame, expected),
    { timeout: 25_000 }).catch(() => null);
  try {
    await openStay360RecordTab(page, expected.confirmation, 'Associated Reservations');
    const response = await pending;
    if (!response || response.status() !== 200 ||
        !/^application\/json(?:;|$)/i.test(response.headers()['content-type'] || '')) return false;
    const header = parseAssociationResponse(await response.text());
    if (header?.classPath !== 'osresv_ran' || !currentOnlyScope(header.pageData?.values, expected)) return false;
    await openStay360RecordTab(page, expected.confirmation, 'Record View');
    return true;
  } catch { return false; }
}
