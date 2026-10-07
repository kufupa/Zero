#!/usr/bin/env node
// Read-only Guest Stay field reader: OSRESS.search + OSRESV.HDR via context.request.
// Only allowlisted read endpoints are ever requested. Never saves, cancels or opens write flows.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
const ALLOWED_PATH = /^\/web\/base\/(OSRESS\.search|OSRESV\.HDR|OSRESS)$/;
const PAUSE_MS = 400;

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

function searchBody(conf) {
  const unused = '__NAVA_UNUSED__';
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
  if (/loadLocalizedPage/i.test(searchText) && searchText.length < 2000) return { conf, outcome: 'session_stub' };
  const data = pageData(searchText);
  const rows = data?.grid?.GRIDRESULT?.GRID?.DATA ?? data?.GRIDRESULT?.GRID?.DATA ?? [];
  const exact = (Array.isArray(rows) ? rows : []).filter((r) => String(r.confirmationnumber ?? '').trim() === conf);
  if (exact.length !== 1) return { conf, outcome: exact.length ? 'ambiguous' : 'not_found', rowCount: rows.length };
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
  if (fields.confirmationnumber && fields.confirmationnumber !== conf) return { conf, outcome: 'identity_mismatch' };
  const grid = {};
  for (const [k, v] of Object.entries(row)) if (v != null && String(v).trim() !== '') grid[k] = String(v);
  return { conf, outcome: Object.keys(fields).length > 3 ? 'read' : 'thin', fields, grid, hdrBytes: hdr.length };
}

async function main() {
  const { input, out, cap } = args(process.argv.slice(2));
  process.umask(0o077);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const confs = JSON.parse(await readFile(input, 'utf8')).slice(0, cap);
  const resumeDone = new Set(['read', 'not_found', 'ambiguous', 'identity_mismatch']);
  let done = new Set();
  try {
    done = new Set(
      (await readFile(out, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((row) => resumeDone.has(row.outcome))
        .map((row) => row.conf),
    );
  } catch {
    /* fresh */
  }
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('PRIVATE_CDP_REQUIRED');
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
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
    await post(page, origin, '/web/base/OSRESS', {
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      USER_FUNCTION_NAME: 'OSRESS',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    }).catch(() => null);
    for (const conf of confs.filter((c) => !done.has(c))) {
      let row;
      try {
        row = await readOne(page, origin, conf);
      } catch (error) {
        row = { conf, outcome: 'error', error: String(error.message || error).slice(0, 160) };
      }
      counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
      await appendFile(out, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify(counts)}\n`);
      if (row.outcome === 'session_stub') break;
      await delay(PAUSE_MS);
    }
  } finally {
    await ctx.close().catch(() => {});
    try {
      browser.disconnect?.();
    } catch {
      /* borrowed owner stays */
    }
  }
}

main().catch((error) => {
  const msg = String(error.message || error);
  process.stderr.write((/password|secret|cookie|jsessionid/i.test(msg) ? 'redacted_error' : msg.slice(0, 200)) + '\n');
  process.exit(1);
});
