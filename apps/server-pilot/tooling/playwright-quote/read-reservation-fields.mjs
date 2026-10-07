#!/usr/bin/env node
// Read-only Guest Stay field reader: OSRESS.search + OSRESV.HDR via context.request.
// Only allowlisted read endpoints are ever requested. Never saves, cancels or opens write flows.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';

const FIELDS = [
  'confirmationnumber', 'status', 'arrivaldate', 'departuredate', 'nights', 'adults', 'children',
  'roomtype', 'rateplan', 'mealplan', 'track', 'guaranteetype', 'sourceofbusinessdesc',
  'marketsegment', 'company', 'araccountname', 'ta1', 'ta1commission', 'groupname',
  'grouprateschedulecode', 'settlementtype', 'reasonforstay', 'promotioncode', 'averagerate',
  'totalrate', 'depositreceived', 'createdby', 'created', 'reservationdate', 'updatedby',
  'externalreference1', 'billingreference', 'caller', 'reservationnote', 'cancellationnote',
  'confidentialratecb', 'viplevel', 'revenuedesc',
];
export const ALLOWED_PATH = /^\/web\/base\/(OSRESS\.search|OSRESV\.HDR)$/;
const PAUSE_MS = 400;
export const OSRESS_OR_UNUSED_TOKEN = '___NOMATCH___';
export const SEP15_POSITIVE_CONTROL = '59898948-1';
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

export function queueConfirmations(confs) {
  const rest = [...confs].filter((c) => c !== SEP15_POSITIVE_CONTROL);
  return [SEP15_POSITIVE_CONTROL, ...rest];
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
    const menuDeadline = Date.now() + timeouts.frontDeskMs;
    while (!(await exactMenuLabel(page, 'Front Desk')) && Date.now() < menuDeadline) {
      await delay(timeouts.pollMs);
    }
    if (!(await exactMenuLabel(page, 'Front Desk'))) {
      if (attempt === 2) throw new Error('GUEST_STAY_NAV_NO_FRONT_DESK');
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

function pickFields(text) {
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

async function readOne(page, origin, conf) {
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
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'HDR',
    ...(row.id != null ? { reservationstayid: String(row.id), id: String(row.id) } : {}),
  };
  const hdr = await post(page, origin, '/web/base/OSRESV.HDR', form);
  const fields = pickFields(hdr);
  if (fields.confirmationnumber && fields.confirmationnumber !== conf) {
    return { conf, outcome: 'identity_mismatch', envelope };
  }
  const grid = {};
  for (const [k, v] of Object.entries(row)) if (v != null && String(v).trim() !== '') grid[k] = String(v);
  return {
    conf,
    outcome: Object.keys(fields).length > 3 ? 'read' : 'thin',
    fields,
    grid,
    hdrBytes: hdr.length,
    envelope,
    rowCount: 1,
  };
}

async function main() {
  const { input, out, cap } = args(process.argv.slice(2));
  process.umask(0o077);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const confs = queueConfirmations(JSON.parse(await readFile(input, 'utf8')).slice(0, cap));
  let done = new Set();
  try {
    done = resumeSkipped(await readFile(out, 'utf8'));
  } catch {
    /* fresh */
  }
  const url = assertBorrowedCdp(process.env);
  const secret = await readSecret();
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 25_000 });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: false, serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && /save|delete|cancel|duplicate|checkin|checkout|crs/i.test(path)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const counts = {};
  try {
    await login(page, secret);
    const origin = new URL(page.url()).origin;
    await navigateGuestStay(page, { ...NAV_TIMEOUTS, origin });
    for (const conf of confs.filter((c) => !done.has(c))) {
      const positiveControl = conf === SEP15_POSITIVE_CONTROL;
      let row;
      try {
        row = await readOne(page, origin, conf);
      } catch (error) {
        row = { conf, outcome: 'error', error: String(error.message || error).slice(0, 160), envelope: { type: 'error' } };
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
  main().catch((error) => {
    const msg = String(error.message || error);
    process.stderr.write((/password|secret|cookie|jsessionid/i.test(msg) ? 'redacted_error' : msg.slice(0, 200)) + '\n');
    process.exit(1);
  });
}
