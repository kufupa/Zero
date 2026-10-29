#!/usr/bin/env node
// Read-only Guest Stay field reader. HRCEN: OSRESS.search + OSRESV.HDR via fetch in the logged-in browser page;
// only allowlisted read endpoints are ever requested. HRDAV: the Guest Stay screen (stay-lookup find), then the
// visible record controls; no OSRESS request. Never saves, cancels or opens write flows.
// Input: JSON array of confirmations, or {conf, arrival: 'YYYY-MM-DD', lastName} rows; the screen path moves its
// quick-search window to the arrival (a stay outside the default window is otherwise not found).
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { parseStayProperty } from './property-profile.mjs';
import { withReadCliPage } from './read-cli-lease.mjs';
import { findOnOpenGuestStay } from './stay-lookup.mjs';

export { withReadCliPage as withLeasedReadPage };

const FIELDS = [
  'confirmationnumber', 'status', 'arrivaldate', 'departuredate', 'nights', 'adults', 'children',
  'roomtype', 'rateplan', 'mealplan', 'track', 'guaranteetype', 'sourceofbusinessdesc',
  'marketsegment', 'company', 'araccountname', 'ta1', 'ta1commission', 'groupname',
  'grouprateschedulecode', 'settlementtype', 'reasonforstay', 'promotioncode', 'averagerate', 'averageratecurr',
  'totalrate', 'totalratecurr', 'grandtotal', 'grandtotalcurr', 'bookingagency1iatanumber',
  'depositreceived', 'createdby', 'created', 'reservationdate', 'updatedby',
  'externalreference1', 'billingreference', 'caller', 'reservationnote', 'cancellationnote',
  'confidentialratecb', 'viplevel', 'revenuedesc',
  'child1', 'child2', 'child3', 'udfchar09', 'udfchar13', 'udfchkbox04', 'udfchar06',
  'guestoptin4', 'emailaddress', 'lastname',
];
// An IATA input elsewhere on the page cannot be bound to this stay by visibility alone.
const UI_FIELDS = FIELDS.filter((name) => name !== 'bookingagency1iatanumber');
export const BOOKING_STATE_KEYS = {
  guaranteeType: 'guaranteetype',
  depositReceived: 'depositreceived',
  arAccount: 'araccountname',
  agency: 'ta1',
  company: 'company',
};
export const ALLOWED_PATH = /^\/web\/base\/(OSRESS\.search|OSRESV\.HDR)$/;
const PAUSE_MS = 400;
export const OSRESS_OR_UNUSED_TOKEN = '___NOMATCH___';
export const SEP15_POSITIVE_CONTROL = '59898948-1';
// The Sep-15 control was added for HRCEN (2026-10-07). No HRDAV control is proven, so HRDAV queues none.
export const POSITIVE_CONTROLS = Object.freeze({ HRCEN: SEP15_POSITIVE_CONTROL });
// HRDAV logs the session out on the OSRESS shell POST and answers direct OSRESS/OSRESV fetches with a login stub
// (live 2026-10-28), so it reads through the screen. HRCEN keeps the fetch path.
export const UI_READ_PROPERTIES = new Set(['HRDAV']);
export function readMode(propertyCode) {
  return UI_READ_PROPERTIES.has(propertyCode) ? 'ui' : 'fetch';
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const NAV_TIMEOUTS = {
  frontDeskMs: 15_000,
  guestStayMs: 8_000,
  searchPaintMs: 15_000,
  pollMs: 300,
};

function args(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const input = get('--input');
  const out = get('--out');
  if (!input || !out) throw new Error('Usage: --input <json array of confirmations> --out <jsonl>');
  return { input, out, cap: Number(get('--cap') ?? 500) };
}

export function searchBody(conf) {
  const unused = OSRESS_OR_UNUSED_TOKEN;
  const filter = (n, alias, op, joiner, value, extra = {}) => ({
    [`MADDON_FILTER_ALIAS_NAME_${n}`]: alias,
    [`MADDON_FILTER_OPERATOR_${n}`]: op,
    [`MADDON_FILTER_JOINER_${n}`]: joiner,
    [`MADDON_FILTER_SEQNUM_${n}`]: String(n),
    [`MADDON_FILTER_VALUE_${n}`]: value,
    ...extra,
  });
  return {
    COMPONENT_INFO_TYPE: 'DATA_ONLY',
    GRID_ID: '1775',
    GRID_NAME: 'OSRESS',
    DATASPY_ID: '1941',
    SYSTEM_FUNCTION_NAME: 'OSRESS',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'LST',
    ...filter(1, 'departuredate', '>=', 'AND', '-365'),
    ...filter(2, 'arrivaldate', '<=', 'AND', '+365'),
    ...filter(3, 'confirmationnumber', 'BEGINS', 'OR', conf, { MADDON_LPAREN_3: 'true' }),
    ...filter(4, 'room', '=', 'OR', unused),
    ...filter(5, 'lastname_filter', 'BEGINS', 'OR', unused, { MADDON_LPAREN_5: 'false' }),
    ...filter(6, 'secondlastname', 'BEGINS', 'OR', unused, { MADDON_RPAREN_6: 'false' }),
    ...filter(7, 'alternatelastname', 'BEGINS', 'OR', unused),
    ...filter(8, 'aliaslastname', 'BEGINS', 'OR', unused),
    ...filter(9, 'loyaltynumber', 'BEGINS', 'OR', unused),
    ...filter(10, 'externalconfirmation', 'BEGINS', 'OR', unused, { MADDON_RPAREN_10: 'true' }),
    externalconfirmation: unused,
  };
}

export function hasSearch(html) {
  return /name="search"|ff_confirmationnumber|data-testid="results"/i.test(html);
}

export function envelopeShape(value, depth = 0) {
  if (depth > 8) return { type: 'truncated' };
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      item: value.length ? envelopeShape(value[0], depth + 1) : null,
    };
  }
  const t = typeof value;
  if (t !== 'object') return { type: t };
  const keys = Object.keys(value).sort();
  return {
    type: 'object',
    keys,
    fields: Object.fromEntries(keys.map((k) => [k, envelopeShape(value[k], depth + 1)])),
  };
}

export function stdoutPayload(row) {
  return {
    phase: row.phase,
    outcome: row.outcome,
    rowCount: row.rowCount ?? 0,
    envelope: row.envelope ?? null,
    positiveControl: Boolean(row.positiveControl),
    counts: row.counts,
  };
}

export function queueConfirmations(confs, control = SEP15_POSITIVE_CONTROL) {
  const rest = [...confs].filter((c) => c !== control);
  return control ? [control, ...rest] : rest;
}

// Input rows: a confirmation string, or {conf, arrival?, lastName?}. A malformed arrival is dropped, not guessed.
export function inputItems(rows) {
  const seen = new Set();
  return rows.flatMap((row) => {
    const item = typeof row === 'string' ? { conf: row } : row && typeof row === 'object' ? row : null;
    const conf = typeof item?.conf === 'string' ? item.conf.trim() : '';
    if (!conf || seen.has(conf)) return [];
    seen.add(conf);
    const lastName = typeof item.lastName === 'string' ? item.lastName.trim() : '';
    const arrival = ISO_DAY.test(String(item.arrival ?? '')) ? item.arrival : null;
    return [{ conf, arrival, lastName: lastName || null }];
  });
}

function isGreenControl(row) {
  return (
    (row.role === 'positive_control' || row.conf === SEP15_POSITIVE_CONTROL) &&
    (row.outcome === 'read' || row.outcome === 'thin')
  );
}

export function resumeSkipped(text) {
  const skipped = new Set();
  if (!text) return skipped;
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const controlGreen = rows.some(isGreenControl);
  const resumable = new Set(
    controlGreen
      ? ['read', 'not_found', 'ambiguous', 'identity_mismatch']
      : ['read', 'ambiguous', 'identity_mismatch'],
  );
  for (const row of rows) {
    if (row.conf === SEP15_POSITIVE_CONTROL) continue;
    if (resumable.has(row.outcome)) skipped.add(row.conf);
  }
  return skipped;
}

export function assertBorrowedCdp(env) {
  const url = new URL(env.HMS_STAGEHAND_CDP_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('PRIVATE_CDP_REQUIRED');
  if (env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  return url;
}

async function exactMenuLabel(page, label) {
  try {
    return await page.evaluate((want) => {
      const text = (globalThis.document?.body?.innerText ?? '');
      return text.split('\n').some((line) => line.trim() === want);
    }, label);
  } catch {
    return false;
  }
}

async function clickMenuExact(page, label) {
  const sel = `text=${label}`;
  try {
    await page.click(sel, { timeout: 4_000 });
    return true;
  } catch {
    try {
      await page.click(sel, { force: true, timeout: 4_000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function openAppMenu(page) {
  if (typeof page.locator !== 'function') return;
  try {
    const frontDesk = page
      .locator('span.x-tree-node-text:visible')
      .filter({ hasText: /^Front Desk$/ });
    if (typeof frontDesk.count === 'function' && (await frontDesk.count()) > 0) return;
    await page.locator('a.app-menu-trigger:visible').click({ timeout: 4_000 });
  } catch {
    /* already open */
  }
}

async function clickTreeLabel(page, label) {
  if (typeof page.locator === 'function') {
    try {
      await page
        .locator('span.x-tree-node-text:visible')
        .filter({ hasText: new RegExp(`^${label}$`) })
        .click({ timeout: 4_000 });
      return true;
    } catch {
      try {
        await page
          .locator('span.x-tree-node-text:visible')
          .filter({ hasText: new RegExp(`^${label}$`) })
          .click({ force: true, timeout: 4_000 });
        return true;
      } catch {
        /* fall through to text= walker */
      }
    }
  }
  return clickMenuExact(page, label);
}

async function openOsressShell(page, origin) {
  return page.evaluate(
    async ({ url, form }) => {
      const body = new URLSearchParams(form);
      const res = await fetch(url, {
        method: 'POST',
        body,
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      return res.text();
    },
    {
      url: `${origin}/web/base/OSRESS?FUNCTION_CLASS=WEBL`,
      form: {
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
    },
  );
}

export async function navigateGuestStay(page, timeouts = NAV_TIMEOUTS) {
  const html = await page.content().catch(() => '');
  if (hasSearch(html)) return { navigated: 'already_open' };
  if (timeouts.origin) {
    await openOsressShell(page, timeouts.origin);
    const xhrDeadline = Date.now() + timeouts.searchPaintMs;
    while (Date.now() < xhrDeadline) {
      if (hasSearch(await page.content().catch(() => ''))) return { navigated: 'osress_open' };
      await delay(timeouts.pollMs);
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A collapsed app menu hides Front Desk entirely; open it before waiting for the label.
    await openAppMenu(page);
    const menuDeadline = Date.now() + timeouts.frontDeskMs;
    while (!(await exactMenuLabel(page, 'Front Desk')) && Date.now() < menuDeadline) {
      await delay(timeouts.pollMs);
    }
    if (!(await exactMenuLabel(page, 'Front Desk'))) {
      if (attempt === 2) {
        // A signed-out page has no app menu; name that instead of a missing Front Desk.
        const loginForm = page.locator ? await page.locator('input[name="password"]:visible').count().catch(() => 0) : 0;
        throw new Error(loginForm > 0 ? 'GUEST_STAY_NAV_LOGIN_PAGE' : 'GUEST_STAY_NAV_NO_FRONT_DESK');
      }
      continue;
    }
    await openAppMenu(page);
    await clickTreeLabel(page, 'Front Desk');
    const guestDeadline = Date.now() + timeouts.guestStayMs;
    while (!(await exactMenuLabel(page, 'Guest Stay')) && Date.now() < guestDeadline) {
      await delay(timeouts.pollMs);
    }
    await clickTreeLabel(page, 'Guest Stay');
    const paintDeadline = Date.now() + timeouts.searchPaintMs;
    while (Date.now() < paintDeadline) {
      if (hasSearch(await page.content().catch(() => ''))) return { navigated: 'menu' };
      await delay(timeouts.pollMs);
    }
  }
  if (timeouts.origin) return { navigated: 'osress_open' };
  throw new Error('GUEST_STAY_NAV_NO_SEARCH');
}

function pageData(text) {
  const m = /(?:"pageData"|pageData)\s*:\s*/.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let end = i; end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(i, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function attrValue(attrs, attr) {
  const m = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

function pickDomNamedValue(html, name) {
  const tagRe = new RegExp(`<(input|select|textarea)\\b([^>]*\\bname\\s*=\\s*(?:"${name}"|'${name}'|${name})[^>]*)>`, 'gi');
  let chosen;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const type = (attrValue(attrs, 'type') || 'text').toLowerCase();
    let value = '';
    if (tag === 'select') {
      const end = html.toLowerCase().indexOf('</select>', m.index);
      const inner = end === -1 ? '' : html.slice(m.index, end);
      const selected = /<option\b([^>]*\bselected\b[^>]*)>([^<]*)/i.exec(inner);
      if (selected) value = (selected[2] || attrValue(selected[1], 'value') || '').trim();
    } else {
      value = (attrValue(attrs, 'value') ?? '').trim();
    }
    if (type === 'hidden') {
      if (chosen === undefined) chosen = value;
      continue;
    }
    if (value !== '') chosen = value;
    else if (chosen === undefined) chosen = '';
  }
  return chosen;
}

export function pickFields(text) {
  const out = {};
  for (const name of FIELDS) {
    const re = new RegExp(`"${name}"\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|(-?\\d+(?:\\.\\d+)?)|(true|false|null))`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === 'null' || raw === undefined) continue;
    let value = raw;
    try {
      value = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : raw;
    } catch {
      /* keep raw */
    }
    if (String(value).trim() !== '') out[name] = String(value).trim();
  }
  return out;
}

function firstNonEmpty(...vals) {
  for (const value of vals) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
}

export function bookingStateFields(text) {
  const fromJson = pickFields(text);
  const out = {};
  for (const [key, name] of Object.entries(BOOKING_STATE_KEYS)) {
    out[key] = firstNonEmpty(fromJson[name], pickDomNamedValue(text, name));
  }
  return out;
}

async function post(page, origin, path, form) {
  if (!ALLOWED_PATH.test(path)) throw new Error(`READ_ONLY_PATH_BLOCKED ${path}`);
  // Fetch inside the borrowed Chrome so HMS traffic uses EC2 VPN/hosts, not this host's DNS.
  return page.evaluate(
    async ({ url, form }) => {
      const body = new URLSearchParams(form);
      const res = await fetch(url, {
        method: 'POST',
        body,
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      return res.text();
    },
    { url: `${origin}${path}`, form },
  );
}

export async function readOne(page, origin, conf, propertyCode) {
  const searchText = await post(page, origin, '/web/base/OSRESS.search', searchBody(conf));
  const sessionStub = /loadLocalizedPage/i.test(searchText) && searchText.length < 2000;
  const data = pageData(searchText);
  const envelope = data
    ? envelopeShape(data)
    : { type: sessionStub ? 'session_stub' : 'unparsed', bytes: searchText.length };
  if (sessionStub) return { conf, outcome: 'session_stub', envelope };
  const rows = data?.grid?.GRIDRESULT?.GRID?.DATA ?? data?.GRIDRESULT?.GRID?.DATA ?? [];
  const exact = (Array.isArray(rows) ? rows : []).filter((r) => String(r.confirmationnumber ?? '').trim() === conf);
  if (exact.length !== 1) {
    return { conf, outcome: exact.length ? 'ambiguous' : 'not_found', rowCount: Array.isArray(rows) ? rows.length : 0, envelope };
  }
  const row = exact[0];
  const form = {
    confirmationnumber: conf,
    propertycode: propertyCode,
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'HDR',
    ...(row.id != null ? { reservationstayid: String(row.id), id: String(row.id) } : {}),
  };
  const hdr = await post(page, origin, '/web/base/OSRESV.HDR', form);
  const fields = pickFields(hdr);
  // The selected search row does not prove that the returned header is the same record.
  if (!fields.confirmationnumber) return { conf, outcome: 'identity_unconfirmed', envelope, rowCount: 1 };
  if (fields.confirmationnumber !== conf) {
    return { conf, outcome: 'identity_mismatch', envelope };
  }
  const bookingState = bookingStateFields(hdr);
  const grid = {};
  for (const [k, v] of Object.entries(row)) if (v != null && String(v).trim() !== '') grid[k] = String(v);
  return {
    conf,
    outcome: Object.keys(fields).length > 3 ? 'read' : 'thin',
    fields,
    bookingState,
    grid,
    hdrBytes: hdr.length,
    envelope,
    rowCount: 1,
  };
}

// Visible named controls on the open Guest Stay record. Self-contained for page.evaluate. A control not on screen is
// omitted; a shown but blank one is listed in keys only, so "blank in HMS" stays distinct from "not read".
export function visibleFieldValues(names, doc = document) {
  const fields = {};
  const keys = [];
  for (const name of names) {
    const el = [...doc.querySelectorAll(`input[name="${name}"], textarea[name="${name}"]`)]
      .find((node) => node.getClientRects().length > 0);
    if (!el) continue;
    keys.push(name);
    if (el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') {
      const on = el.type === 'checkbox'
        ? el.checked
        : el.getAttribute('aria-checked') === 'true'
          || Boolean(el.closest('.x-form-cb-checked, .x-form-checkbox-checked'));
      fields[name] = on ? 'true' : 'false';
      continue;
    }
    const value = String(el.value ?? '').replace(/\s+/g, ' ').trim();
    if (value) fields[name] = value;
  }
  return { fields, keys };
}

// Waits until no load mask shows (a quick search still "Processing request." masks its panel). True when settled.
export async function settleScreen(page, { timeoutMs = 15_000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await page.evaluate(() => [...document.querySelectorAll('.x-mask')]
      .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'))
      .catch(() => false);
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(pollMs);
  }
}

// One confirmation through the Guest Stay screen: stay-lookup find (header quick search; the arrival hint moves the
// window), then the visible record controls. Same row shape as readOne; no OSRESS/OSRESV request.
// The find runs in place (a new tab is not signed in on HRDAV). The quick panel can still show the previous search
// while the new one processes, and a masked panel blocks the window picker (live HRDAV 2026-10-28), so a miss or a
// thrown find is retried once after the screen settles; ambiguous and mismatch are not. Identity is re-checked on
// the opened record.
export async function readOneUi(page, hint, find = findOnOpenGuestStay, settle = settleScreen) {
  const { conf } = hint;
  const args = {
    mode: 'find', confirmation: conf, arrival: hint.arrival ?? null, departure: null, lastName: hint.lastName ?? null,
    debugHtml: false,
  };
  let found = null;
  let failure = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await settle(page);
    try {
      const ctx = { page, args, dir: tmpdir(), result: null, started: Date.now() };
      found = await find(ctx, { captureScreenshots: false });
      failure = null;
    } catch (error) {
      if (String(error?.message ?? error).startsWith('AMBIGUOUS_')) throw error;
      found = null;
      failure = error;
    }
    if (found && found.outcome !== 'not_found') break;
  }
  if (failure) throw failure;
  if (found?.outcome !== 'found') {
    const outcome = found?.reason === 'confirmation_mismatch' ? 'identity_mismatch'
      : ['not_found', 'ambiguous'].includes(found?.outcome) ? found.outcome : 'error';
    // Without an arrival the quick search covers only its default window (about today +/- 30 days on HRDAV).
    const envelope = { type: 'ui_form' };
    return { conf, outcome, reason: found?.reason ?? null, arrivalHint: args.arrival, rowCount: 0, envelope };
  }
  const { fields, keys } = await page.evaluate(visibleFieldValues, UI_FIELDS);
  const envelope = { type: 'ui_form', keys: [...keys].sort() };
  if (fields.confirmationnumber !== conf) return { conf, outcome: 'identity_mismatch', envelope };
  const foundConfirmation = typeof found.stay?.confirmation === 'string' ? found.stay.confirmation.trim() : '';
  if (foundConfirmation && foundConfirmation !== conf) return { conf, outcome: 'identity_mismatch', envelope };
  const bookingState = Object.fromEntries(
    Object.entries(BOOKING_STATE_KEYS).map(([key, name]) => [key, fields[name] ?? null]),
  );
  return {
    conf,
    outcome: Object.keys(fields).length > 3 ? 'read' : 'thin',
    fields,
    bookingState,
    ...(foundConfirmation && found.commercial ? {
      commercial: found.commercial,
      commercialConflicts: Array.isArray(found.conflicts) ? found.conflicts : null,
    } : {}),
    grid: {},
    findMethod: found.findMethod ?? null,
    envelope,
    rowCount: 1,
  };
}

async function main() {
  const property = parseStayProperty(process.argv.slice(2));
  if (!property.ok) {
    process.stderr.write(`${property.error}\n`);
    process.exitCode = property.exitCode ?? 2;
    return;
  }
  const { input, out, cap } = args(property.rest);
  process.umask(0o077);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const mode = readMode(property.propertyCode);
  const items = inputItems(JSON.parse(await readFile(input, 'utf8')).slice(0, cap));
  const hints = new Map(items.map((item) => [item.conf, item]));
  const confs = queueConfirmations(items.map((item) => item.conf), POSITIVE_CONTROLS[property.propertyCode] ?? null);
  let done = new Set();
  try {
    done = resumeSkipped(await readFile(out, 'utf8'));
  } catch {
    /* fresh */
  }
  const url = assertBorrowedCdp(process.env);
  const secret = await readSecret();
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 25_000 });
  const ctx = await newBorrowedContext(browser, {
    ignoreHTTPSErrors: true, acceptDownloads: false, serviceWorkers: 'block',
    ...(mode === 'ui' ? { viewport: { width: 1600, height: 1000 } } : {}),
  });
  await ctx.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && /save|delete|cancel|duplicate|checkin|checkout|crs/i.test(path)) {
      return route.abort();
    }
    return route.continue();
  });
  const counts = {};
  try {
    await withReadCliPage({
      propertyCode: property.propertyCode, secret, context: ctx, browser, env: process.env,
    }, async ({ page }) => {
      const origin = new URL(page.url()).origin;
      if (mode === 'ui') {
        page.setDefaultTimeout?.(20_000);
        await openGuestStayScreen(page);
        await page.waitForTimeout(1500);
      } else {
        await navigateGuestStay(page, { ...NAV_TIMEOUTS, origin });
      }
      for (const conf of confs.filter((c) => !done.has(c))) {
        const positiveControl = conf === SEP15_POSITIVE_CONTROL;
        let row;
        try {
          row = mode === 'ui'
            ? await readOneUi(page, hints.get(conf) ?? { conf })
            : await readOne(page, origin, conf, property.propertyCode);
        } catch (error) {
          const message = String(error.message || error);
          const outcome = message.startsWith('AMBIGUOUS_') ? 'ambiguous' : 'error';
          row = { conf, outcome, error: message.slice(0, 160), envelope: { type: 'error' } };
        }
        if (positiveControl) row.role = 'positive_control';
        counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
        await appendFile(out, `${JSON.stringify(row)}\n`, { mode: 0o600 });
        process.stdout.write(`${JSON.stringify(stdoutPayload({
          phase: 'search',
          outcome: row.outcome,
          rowCount: row.rowCount ?? 0,
          envelope: row.envelope,
          positiveControl,
          counts,
        }))}\n`);
        if (row.outcome === 'session_stub') break;
        if (positiveControl && row.outcome !== 'read' && row.outcome !== 'thin') break;
        await delay(PAUSE_MS);
      }
    });
  } finally {
    await Promise.race([ctx.close().catch(() => {}), delay(5_000)]);
    try {
      browser.disconnect?.();
    } catch {
      /* borrowed owner stays */
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit explicitly: CDP and lease handles keep Node alive after main returns (stay-lookup does the same).
  main().then(() => process.exit(process.exitCode ?? 0), (error) => {
    const msg = String(error.message || error);
    process.stderr.write((/password|secret|cookie|jsessionid/i.test(msg) ? 'redacted_error' : msg.slice(0, 200)) + '\n');
    process.exit(1);
  });
}
