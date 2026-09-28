/**
 * Soft-open diagnostic verifier for a bounded historical/assisted sample.
 * It records honest per-tool outcomes; it is not a promotion authority by itself.
 * Digests only.
 *
 * Session model (binding — login-per-phase forbidden):
 *   1 login → parallel context.request OSRESS finds → drain → serial soft
 *   Folio = OSRESS grid foliobalance/propertycurrency (production path)
 *   Recycle only on find poison / loadLocalized, after inflight drain
 *
 * Env: HMS_DISCOVERY_ALLOW_LIVE=1, HMS_READ_SECRET_ARN, HMS_CHROMIUM_EXECUTABLE_PATH
 *      HMS_READ_100_CANDIDATES_PATH — JSON [{email_id,kind,value}]
 *      HMS_READ_100_OUT — digest path
 *      HMS_READ_100_N=10
 *      HMS_READ_100_RELOGIN_EVERY=0  (default 0 = reuse; >0 = poison-style budget only)
 *      HMS_READ_100_FIND_PARALLEL=8
 *      HMS_READ_100_SCORE_EMAIL_BOUND=1  (default 1: email-bound candidates only;
 *                                         set 0 for documented assisted inputs)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';

const UNUSED = '___NOMATCH___';
const N = Math.max(10, Math.min(100, Number(process.env.HMS_READ_100_N || 10) || 10));
/** Default 0 = reuse session. Never default to 1 (login tax). */
const RELOGIN_EVERY = Math.max(
  0,
  Number(process.env.HMS_READ_100_RELOGIN_EVERY ?? 0) || 0,
);
const FIND_PARALLEL = Math.max(
  1,
  Math.min(32, Number(process.env.HMS_READ_100_FIND_PARALLEL || 4) || 4),
);
const SEARCH_BUDGET = Math.max(
  1,
  Number(process.env.HMS_READ_100_SEARCH_BUDGET || 8) || 8,
);
const CAND_PATH = process.env.HMS_READ_100_CANDIDATES_PATH;
const OUT =
  process.env.HMS_READ_100_OUT || '/tmp/hms-read-100-verify.json';
const SKIP_QUOTE = process.env.HMS_READ_100_SKIP_QUOTE === '1';
const SKIP_DETAIL = process.env.HMS_READ_100_SKIP_DETAIL === '1';
const SKIP_FIND = process.env.HMS_READ_100_SKIP_FIND === '1';
/** Default 1: only email-own / case_linked confs count for unique-email soft gates. */
const SCORE_EMAIL_BOUND = process.env.HMS_READ_100_SCORE_EMAIL_BOUND !== '0';

function isScorableCandidateSrc(src) {
  const s = String(src || '').trim();
  return (
    s === 'email_own' ||
    s === 'email_own_softok' ||
    s === 'case_linked' ||
    s === 'manual' ||
    s === 'gold' ||
    s === 'gold_derived' ||
    s === 'assisted' ||
    s === 'fallback' ||
    s === 'provided' ||
    s === ''
  );
}

function folioPayloadOk(input) {
  const bal = String(input?.folioBalance ?? '').trim();
  const cur = String(input?.currency ?? '').trim();
  return /^-?(?:0|[1-9]\d*)\.\d{2}$/.test(bal) && /^[A-Z]{3}$/.test(cur);
}

function loadCandidates() {
  if (!CAND_PATH) throw new Error('HMS_READ_100_CANDIDATES_PATH required');
  const raw = JSON.parse(readFileSync(CAND_PATH, 'utf8'));
  const out = [];
  const seenEmail = new Set();
  let skippedRotate = 0;
  for (const row of raw) {
    const emailId = String(row.email_id || row.src || '').trim();
    const value = String(row.value || '').trim();
    const src = String(row.src || '').trim();
    if (!emailId || seenEmail.has(emailId)) continue;
    if (!/^\d{5,12}(-\d)?$/.test(value)) continue;
    if (SCORE_EMAIL_BOUND && !isScorableCandidateSrc(src)) {
      // empty src allowed only when file is already email-own filtered
      if (src !== '') {
        skippedRotate += 1;
        continue;
      }
    }
    seenEmail.add(emailId);
    out.push({
      emailId,
      value,
      src: src || 'email_own',
      quoteRequest: quoteRequestFor(row),
    });
    if (out.length >= N) break;
  }
  if (out.length < 10) {
    throw new Error(
      `need ≥10 unique emails, got ${out.length}` +
        (SCORE_EMAIL_BOUND ? ` (skipped ${skippedRotate} non-email-bound; set HMS_READ_100_SCORE_EMAIL_BOUND=0 to bypass)` : ''),
    );
  }
  return out;
}

function mmddyyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
}

function quoteRequestFor(row) {
  const input = row?.quoteRequest ?? row?.quote ?? null;
  const roomType = String(input?.roomType ?? input?.roomTypeCode ?? '').trim();
  const arrivalIso = String(input?.arrivalIso ?? input?.arrival ?? '').trim();
  if (!roomType || !/^\d{4}-\d{2}-\d{2}$/.test(arrivalIso) || !mmddyyyy(arrivalIso)) {
    return null;
  }
  return { roomType, arrivalIso };
}

/** Same OSRESS.search body as gold-fact-backtest-29-live.mjs (BEGINS / +365). */
function searchBodyFor(conf) {
  const confVal = conf;
  const extVal = UNUSED;
  const lastnameVal = UNUSED;
  return {
    COMPONENT_INFO_TYPE: 'DATA_ONLY',
    GRID_ID: '1775',
    GRID_NAME: 'OSRESS',
    DATASPY_ID: '1941',
    SYSTEM_FUNCTION_NAME: 'OSRESS',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'LST',
    MADDON_FILTER_ALIAS_NAME_1: 'departuredate',
    MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_JOINER_1: 'AND',
    MADDON_FILTER_SEQNUM_1: '1',
    MADDON_FILTER_VALUE_1: '-365',
    MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
    MADDON_FILTER_OPERATOR_2: '<=',
    MADDON_FILTER_JOINER_2: 'AND',
    MADDON_FILTER_SEQNUM_2: '2',
    MADDON_FILTER_VALUE_2: '+365',
    MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
    MADDON_FILTER_OPERATOR_3: 'BEGINS',
    MADDON_FILTER_JOINER_3: 'OR',
    MADDON_FILTER_SEQNUM_3: '3',
    MADDON_FILTER_VALUE_3: confVal,
    MADDON_LPAREN_3: 'true',
    MADDON_FILTER_ALIAS_NAME_4: 'room',
    MADDON_FILTER_OPERATOR_4: '=',
    MADDON_FILTER_JOINER_4: 'OR',
    MADDON_FILTER_SEQNUM_4: '4',
    MADDON_FILTER_VALUE_4: UNUSED,
    MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter',
    MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_JOINER_5: 'OR',
    MADDON_FILTER_SEQNUM_5: '5',
    MADDON_FILTER_VALUE_5: lastnameVal,
    MADDON_LPAREN_5: 'false',
    MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
    MADDON_FILTER_OPERATOR_6: 'BEGINS',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: lastnameVal,
    MADDON_RPAREN_6: 'false',
    MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
    MADDON_FILTER_OPERATOR_8: 'BEGINS',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
    MADDON_FILTER_OPERATOR_9: 'BEGINS',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: UNUSED,
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'BEGINS',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: extVal,
    MADDON_RPAREN_10: 'true',
    externalconfirmation: extVal,
  };
}

function parseOsressRows(searchText) {
  let idx = searchText.indexOf('pageData:');
  let markerLen = 'pageData:'.length;
  if (idx < 0) {
    const m = /"pageData"\s*:/.exec(searchText);
    if (!m) return { rows: [], parse: 'no_pagedata' };
    idx = m.index;
    markerLen = m[0].length;
  }
  let i = idx + markerLen;
  while (i < searchText.length && /\s/.test(searchText[i])) i++;
  if (searchText[i] !== '{') return { rows: [], parse: 'pagedata_not_object' };
  let depth = 0;
  let end = i;
  for (; end < searchText.length; end++) {
    if (searchText[end] === '{') depth++;
    else if (searchText[end] === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  try {
    const pageData = JSON.parse(searchText.slice(i, end));
    const data =
      pageData?.grid?.GRIDRESULT?.GRID?.DATA ?? pageData?.GRIDRESULT?.GRID?.DATA ?? [];
    if (!Array.isArray(data)) return { rows: [], parse: 'no_data' };
    return {
      parse: 'ok',
      rows: data.map((row) => ({
        confirmation: row.confirmationnumber != null ? String(row.confirmationnumber) : null,
        arrival: row.arrivaldate != null ? String(row.arrivaldate) : null,
        departure: row.departuredate != null ? String(row.departuredate) : null,
        roomType: row.roomtype != null ? String(row.roomtype) : null,
        stayId: row.id != null ? String(row.id) : null,
        folioBalance:
          row.foliobalance != null
            ? String(row.foliobalance)
            : row.balance != null
              ? String(row.balance)
              : null,
        currency:
          row.propertycurrency != null
            ? String(row.propertycurrency)
            : row.currency != null
              ? String(row.currency)
              : null,
        guestName:
          row.guestname != null
            ? String(row.guestname)
            : row.lastname != null
              ? String(row.lastname)
              : null,
      })),
    };
  } catch {
    return { rows: [], parse: 'json_fail' };
  }
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  async function run() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

async function login(page, secret) {
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page
    .locator('input[name=userid], input[name=username], input[name=j_username]')
    .first()
    .fill(secret.username);
  await page.locator('input[name=password]').fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
      await page.locator('input[name=password]').press('Enter');
    }),
  ]);
  await page.waitForTimeout(3500);
}

async function warmBsstrt(page) {
  await page.evaluate(async () => {
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          manurefresh: 'yes',
        }).toString(),
      }).catch(() => null);
    }
  });
  await page.waitForTimeout(1000);
}

/** Production folio prelude: open OSRESS WEBL before search (may widen dataspy cols). */
async function openOsressWebl(ctx, origin) {
  await ctx.request.post(
    `${origin}/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS`,
    {
      form: {
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      timeout: 60_000,
    },
  ).catch(() => null);
}

async function softQuote(page, { roomType, arrivalIso }) {
  const t0 = Date.now();
  const start = mmddyyyy(arrivalIso);
  if (!roomType || !start) {
    return {
      status: 'unverified_negative',
      reason: 'missing_case_inputs',
      roomType: roomType || null,
      arrival: arrivalIso || null,
      ms: Date.now() - t0,
    };
  }
  const hotel = start;
  const result = await page.evaluate(
    async ({ roomType, start, hotel }) => {
      await fetch('/web/base/OSRRAV', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      }).catch(() => null);
      await fetch('/web/base/OSRRAV.HDR', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        }).toString(),
      }).catch(() => null);
      const body = {
        property: 'HRCEN',
        roomtypes: roomType,
        rateplans: '',
        salesstrategy: '',
        showunavailable: '0',
        ratetype: '',
        adults: '2',
        showexclusiverates: '0',
        showavailableforsale: 'on',
        children: '0',
        startdate: start,
        currency: 'ZAR',
        rowpagesize: '14',
        salesstrategy_display: '',
        currency_display: 'ZAR',
        adults_display: '2',
        children_display: '0',
        hoteldate: hotel,
        firstcolumndate: start,
        pagemode: 'display',
        ONLY_DATA_REQUIRED: 'true',
        USER_FUNCTION_NAME: 'OSRRAV',
        SYSTEM_FUNCTION_NAME: 'OSRRAV',
        CURRENT_TAB_NAME: 'HDR',
      };
      const r = await fetch('/web/base/OSRRAV.HDR.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const text = await r.text();
      const hasNonEmptyArray = (key) =>
        new RegExp(`(?:["']?${key}["']?)\\s*:\\s*\\[\\s*\\{`, 'i').test(text);
      return {
        bytes: text.length,
        hasPageData: /pageData/i.test(text),
        hasAvailability: /availabilitydata/i.test(text),
        loadLocalized: /loadLocalizedPage/i.test(text),
        loginBounce: /type=["']password["']/i.test(text),
        hasNightly:
          hasNonEmptyArray('roomTypeDailyInvArray') ||
          hasNonEmptyArray('ratePlanDailyInvArray'),
        hasRateValue:
          /(?:["']?(?:roomRate|rateAmount|displayedAmount|nightlyRate)["']?)\s*:\s*(?:["'][^"']*\d|[-+]?\d+(?:\.\d+)?)/i.test(
            text,
          ),
        hasCurrencyValue:
          /(?:["']?(?:uoc|currency|currency_display)["']?)\s*:\s*["'][A-Z]{3}["']/i.test(text),
      };
    },
    { roomType, start, hotel },
  );
  const ok =
    result.hasPageData &&
    result.hasAvailability &&
    result.hasNightly &&
    result.hasRateValue &&
    result.hasCurrencyValue &&
    !result.loadLocalized &&
    !result.loginBounce;
  return {
    status: ok ? 'ok' : result.loadLocalized ? 'loadLocalized' : 'mismatch',
    roomType,
    arrival: arrivalIso,
    ...result,
    ms: Date.now() - t0,
  };
}

async function findOneRequest(ctx, origin, conf) {
  const t0 = Date.now();
  const res = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
    form: searchBodyFor(conf),
    timeout: 60_000,
  });
  const text = await res.text();
  const parsed = parseOsressRows(text);
  const loadLocalized = /loadLocalizedPage/i.test(text) || text.length === 813;
  const target = String(conf).trim();
  const exactRows = parsed.rows.filter(
    (row) => String(row.confirmation ?? '').trim() === target,
  );
  const top = exactRows.length === 1 ? exactRows[0] : parsed.rows[0];
  const hit = parsed.parse === 'ok' && exactRows.length === 1;
  const status = loadLocalized
    ? 'loadLocalized'
    : hit
      ? 'hit'
      : exactRows.length > 1
        ? 'ambiguous'
        : parsed.rows.length > 0
          ? 'mismatch'
          : 'not_found';
  return {
    status,
    confTail: String(conf).slice(-8),
    exactMatch: hit,
    rowCount: parsed.rows.length,
    stayIdPresent: hit && Boolean(top?.stayId),
    roomType: hit ? top?.roomType ?? null : null,
    _confirmation: hit ? top?.confirmation ?? null : null,
    _stayId: hit ? top?.stayId ?? null : null,
    folioBalance: hit ? top?.folioBalance ?? null : null,
    currency: hit ? top?.currency ?? null : null,
    guestName: hit ? top?.guestName ?? null : null,
    bytes: text.length,
    parse: parsed.parse,
    ms: Date.now() - t0,
    via: 'context.request',
  };
}

function scoreDetailText(text, fields) {
  const entries = [
    ...text.matchAll(
      /"(arrival[^"]*|departure[^"]*|roomtype[^"]*|ratecode[^"]*|rateamount[^"]*|balance[^"]*|folio[^"]*|guestname[^"]*|polic[^"]*|cancellation[^"]*|confirmationnumber[^"]*|lastname[^"]*)"\s*:\s*(?:"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?)|(true|false)|(\[[^\]]+\]|\{[^}]+\}))/gi,
    ),
  ].map((m) => ({
    key: m[1].toLowerCase(),
    value: m[2] ?? m[3] ?? m[4] ?? m[5] ?? null,
  }));
  const useful = entries.filter(({ value }) => String(value ?? '').trim() !== '');
  const uniq = [...new Set(useful.map(({ key }) => key))];
  const has = (pattern) => useful.some(({ key }) => pattern.test(key));
  return {
    bytes: text.length,
    hasPageData: /pageData/i.test(text) || /"classPath"\s*:\s*"osresv_/i.test(text),
    stub813: text.length === 813 || (/loadLocalizedPage/i.test(text) && text.length < 2000),
    binds:
      Boolean(
        (fields.confirmationnumber && text.includes(String(fields.confirmationnumber))) ||
          (fields.reservationstayid && text.includes(String(fields.reservationstayid))),
      ),
    keyHitN: uniq.length,
    valueHitN: useful.length,
    fieldHits: {
      arrival: has(/arrival/i),
      departure: has(/departure/i),
      roomType: has(/roomtype/i),
      rate: has(/rate/i),
      folio: has(/folio|balance/i),
      guest: has(/guest|lastname/i),
      policy: has(/polic|cancel/i),
    },
  };
}

/** A1 HDR soft-open via context.request (serial; evaluate multi-tab poisons session). */
async function softHdrRequest(ctx, origin, hit) {
  const confirmation = hit._confirmation || '';
  const stayId = hit._stayId || '';
  const t0 = Date.now();
  const base = {
    confirmationnumber: confirmation,
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'HDR',
  };
  if (stayId) {
    base.reservationstayid = stayId;
    base.id = stayId;
  }
  const res = await ctx.request.post(`${origin}/web/base/OSRESV.HDR`, {
    form: base,
    timeout: 60_000,
  });
  const text = await res.text();
  const result = scoreDetailText(text, base);
  const supportingFields = [
    result.fieldHits?.roomType,
    result.fieldHits?.rate,
    result.fieldHits?.folio,
    result.fieldHits?.guest,
    result.fieldHits?.policy,
  ].filter(Boolean).length;
  const hdrOk =
    result.hasPageData &&
    !result.stub813 &&
    result.binds === true &&
    result.fieldHits?.arrival === true &&
    result.fieldHits?.departure === true &&
    supportingFields >= 1;
  return {
    hdrStatus: hdrOk ? 'ok' : 'mismatch',
    stayIdPresent: Boolean(stayId),
    confTail: String(confirmation).slice(-8),
    HDR: result,
    ms: Date.now() - t0,
    via: 'context.request',
  };
}

/** Folio deepen: OSRESV.FOL via request when OSRESS grid lacks foliobalance cols. */
async function softFolioRequest(ctx, origin, hit) {
  const confirmation = hit._confirmation || '';
  const stayId = hit._stayId || '';
  const t0 = Date.now();
  const base = {
    confirmationnumber: confirmation,
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'FOL',
  };
  if (stayId) {
    base.reservationstayid = stayId;
    base.id = stayId;
  }
  const res = await ctx.request.post(`${origin}/web/base/OSRESV.FOL`, {
    form: base,
    timeout: 60_000,
  });
  const text = await res.text();
  const scored = scoreDetailText(text, base);
  // Inline money extract (mirrors folio-fol-parse.ts) — verify.mjs has no TS import.
  let folioBalance = null;
  let currency = null;
  for (const m of text.matchAll(
    /"(foliobalance|balance|totalbalance|balancecurr|propertycurrency|currency)"\s*:\s*"([^"]*)"/gi,
  )) {
    const key = m[1].toLowerCase();
    const val = String(m[2] || '').trim();
    if (['foliobalance', 'balance', 'totalbalance'].includes(key) && /^-?(?:0|[1-9]\d*)\.\d{2}$/.test(val)) {
      folioBalance = val;
    }
    if (['balancecurr', 'propertycurrency', 'currency'].includes(key) && /^[A-Z]{3}$/i.test(val)) {
      currency = val.toUpperCase();
    }
  }
  const moneyOk = folioPayloadOk({ folioBalance, currency });
  return {
    status:
      scored.hasPageData &&
      !scored.stub813 &&
      scored.binds === true &&
      moneyOk
        ? 'ok'
        : 'mismatch',
    surface: 'OSRESV.FOL',
    folioBalance,
    currency,
    moneyOk,
    ...scored,
    ms: Date.now() - t0,
  };
}

function folioFromOsressFind(find, deepen = null) {
  const bal = find?.folioBalance;
  const cur = find?.currency;
  const moneyOk = folioPayloadOk({ folioBalance: bal, currency: cur });
  if (find?.status === 'hit' && moneyOk) {
    return {
      status: 'ok',
      surface: 'OSRESS.search',
      folioBalance: bal,
      currency: cur,
      fieldHits: {
        folio: true,
        currency: true,
        guest: Boolean(find?.guestName),
        stayId: Boolean(find?.stayIdPresent),
      },
      binds: Boolean(find?._confirmation || find?._stayId),
    };
  }
  const deepenMoney =
    deepen &&
    folioPayloadOk({
      folioBalance: deepen.folioBalance ?? bal,
      currency: deepen.currency ?? cur,
    });
  if (deepen && deepen.status === 'ok' && deepenMoney) {
    return {
      status: 'ok',
      surface: deepen.surface || 'OSRESV.FOL',
      folioBalance: deepen.folioBalance ?? bal,
      currency: deepen.currency ?? cur,
      fieldHits: deepen.fieldHits,
      binds: deepen.binds,
      bytes: deepen.bytes,
      note: 'OSRESS dataspy 1941 lacks foliobalance cols; FOL money parse used',
    };
  }
  if (deepen && deepen.status === 'ok' && !deepenMoney) {
    return {
      status: 'mismatch',
      surface: deepen.surface || 'OSRESV.FOL',
      folioBalance: deepen.folioBalance ?? bal ?? null,
      currency: deepen.currency ?? cur ?? null,
      fieldHits: deepen.fieldHits,
      binds: deepen.binds,
      bytes: deepen.bytes,
      note: 'FOL_OPEN_NO_MONEY',
    };
  }
  return {
    status: find?.status === 'hit' ? 'mismatch' : 'skipped_need_find',
    surface: moneyOk ? 'OSRESS.search' : deepen?.surface || 'OSRESS.search',
    folioBalance: bal ?? null,
    currency: cur ?? null,
    fieldHits: {
      folio: moneyOk,
      currency: moneyOk,
      guest: Boolean(find?.guestName),
      stayId: Boolean(find?.stayIdPresent),
    },
    binds: Boolean(find?._confirmation || find?._stayId),
  };
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const emails = loadCandidates();

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });

  let page = await ctx.newPage();
  let loginCycles = 0;
  let softSinceLogin = 0;
  let findPoisonRecycles = 0;

  const relogin = async (reason = 'start') => {
    if (page && !page.isClosed()) await page.close().catch(() => null);
    page = await ctx.newPage();
    const t0 = Date.now();
    await login(page, secret);
    await warmBsstrt(page);
    loginCycles += 1;
    softSinceLogin = 0;
    console.log(JSON.stringify({ phase: 'login', reason, loginCycles, loginMs: Date.now() - t0 }));
  };

  await relogin('start');
  await openOsressWebl(ctx, origin);

  // --- Phase 1: wave finds (parallel ≤ FIND_PARALLEL, recycle every SEARCH_BUDGET) ---
  const findResults = emails.map((em) => ({ em, find: SKIP_FIND ? { status: 'skipped' } : null }));
  if (!SKIP_FIND) {
  let findSinceRecycle = 0;
  for (let offset = 0; offset < findResults.length; offset += FIND_PARALLEL) {
    const slice = findResults.slice(offset, offset + FIND_PARALLEL);
    if (findSinceRecycle >= SEARCH_BUDGET) {
      findPoisonRecycles += 1;
      await relogin(`search_budget_${SEARCH_BUDGET}`);
      await openOsressWebl(ctx, origin);
      findSinceRecycle = 0;
    }
    await mapPool(slice, FIND_PARALLEL, async (row) => {
      row.find = await findOneRequest(ctx, origin, row.em.value);
      findSinceRecycle += 1;
      console.log(
        JSON.stringify({
          phase: 'find',
          emailTail: row.em.emailId.slice(-8),
          confTail: row.find.confTail,
          status: row.find.status,
          stayIdPresent: row.find.stayIdPresent,
          folioBalance: row.find.folioBalance,
          currency: row.find.currency,
          via: row.find.via,
          findSinceRecycle,
        }),
      );
    });
    const wavePoison = slice.filter((r) => r.find?.status === 'loadLocalized');
    if (wavePoison.length > 0) {
      findPoisonRecycles += 1;
      await relogin('wave_poison_drain');
      await openOsressWebl(ctx, origin);
      findSinceRecycle = 0;
      for (const row of wavePoison) {
        row.find = await findOneRequest(ctx, origin, row.em.value);
        findSinceRecycle += 1;
        console.log(
          JSON.stringify({
            phase: 'find_retry',
            emailTail: row.em.emailId.slice(-8),
            status: row.find.status,
            stayIdPresent: row.find.stayIdPresent,
          }),
        );
      }
    }
  }

  } // end !SKIP_FIND

  // Fresh session for soft phase — find waves poison Ext for detail soft-opens.
  await relogin('pre_soft_phase');
  await openOsressWebl(ctx, origin);

  // --- Phase 2: serial soft via context.request (quote page-eval; HDR+FOL request) ---
  const rows = [];
  for (let i = 0; i < findResults.length; i++) {
    const { em, find } = findResults[i];
    const quoteRequest = em.quoteRequest;

    if (RELOGIN_EVERY > 0 && softSinceLogin >= RELOGIN_EVERY) {
      await relogin(`soft_budget_${RELOGIN_EVERY}`);
      await openOsressWebl(ctx, origin);
    }
    // Soft budget: recycle every SEARCH_BUDGET soft opens (HDR/FOL count).
    if (softSinceLogin >= SEARCH_BUDGET) {
      findPoisonRecycles += 1;
      await relogin(`soft_search_budget_${SEARCH_BUDGET}`);
      await openOsressWebl(ctx, origin);
    }

    let quote = null;
    if (!SKIP_QUOTE) {
      quote = quoteRequest
        ? await softQuote(page, quoteRequest)
        : {
            status: 'unverified_negative',
            reason: 'missing_case_inputs',
            roomType: null,
            arrival: null,
          };
      if (quoteRequest) {
        softSinceLogin += 1;
        if (quote.status !== 'ok' && (quote.loadLocalized || (quote.bytes || 0) < 1000)) {
          findPoisonRecycles += 1;
          await relogin('quote_stub');
          await openOsressWebl(ctx, origin);
          quote = await softQuote(page, quoteRequest);
          softSinceLogin += 1;
        }
      }
      console.log(
        JSON.stringify({
          phase: 'quote',
          emailTail: em.emailId.slice(-8),
          status: quote.status,
          roomType: quoteRequest?.roomType ?? null,
          arrival: quoteRequest?.arrivalIso ?? null,
          reason: quote.reason ?? null,
          bytes: quote.bytes,
          hasNightly: quote.hasNightly,
          hasRateValue: quote.hasRateValue,
          hasCurrencyValue: quote.hasCurrencyValue,
        }),
      );
    }

    let detail = null;
    let folioDeepen = null;
    if (!SKIP_DETAIL && find?.status === 'hit') {
      detail = await softHdrRequest(ctx, origin, find);
      softSinceLogin += 1;
      console.log(
        JSON.stringify({
          phase: 'a1_hdr',
          emailTail: em.emailId.slice(-8),
          hdr: detail.hdrStatus,
          stayIdPresent: detail.stayIdPresent,
          bytes: detail.HDR?.bytes,
          via: detail.via,
        }),
      );
      folioDeepen = await softFolioRequest(ctx, origin, find);
      softSinceLogin += 1;
      console.log(
        JSON.stringify({
          phase: 'folio_deepen',
          emailTail: em.emailId.slice(-8),
          status: folioDeepen.status,
          surface: folioDeepen.surface,
          bytes: folioDeepen.bytes,
          folioField: folioDeepen.fieldHits?.folio,
        }),
      );
    }

    const folio = folioFromOsressFind(find, folioDeepen);
    console.log(
      JSON.stringify({
        phase: 'folio_osress',
        emailTail: em.emailId.slice(-8),
        status: folio.status,
        surface: folio.surface,
        folioBalance: folio.folioBalance,
        currency: folio.currency,
      }),
    );

    rows.push({
      emailId: em.emailId,
      confTail: find?.confTail,
      quote: quote
        ? {
            status: quote.status,
            reason: quote.reason ?? null,
            roomType: quoteRequest?.roomType ?? null,
            arrival: quoteRequest?.arrivalIso ?? null,
            bytes: quote.bytes,
            hasNightly: quote.hasNightly,
            hasRateValue: quote.hasRateValue,
            hasCurrencyValue: quote.hasCurrencyValue,
          }
        : { status: 'skipped' },
      find: {
        status: find?.status,
        stayIdPresent: find?.stayIdPresent,
        roomType: find?.roomType,
        parse: find?.parse,
        folioBalance: find?.folioBalance,
        currency: find?.currency,
      },
      a1: detail
        ? {
            hdrStatus: detail.hdrStatus,
            fieldHits: detail.HDR?.fieldHits,
            binds: detail.HDR?.binds,
            bytes: detail.HDR?.bytes,
          }
        : null,
      folio,
    });
  }

  const uniqueOk = (pred) => new Set(rows.filter(pred).map((r) => r.emailId)).size;
  const digest = {
    when: new Date().toISOString(),
    nEmails: rows.length,
    uniqueEmails: new Set(rows.map((r) => r.emailId)).size,
    loginCycles,
    reloginEvery: RELOGIN_EVERY,
    findParallel: FIND_PARALLEL,
    findPoisonRecycles,
    folioSurface: 'OSRESS.search',
    sessionModel: 'reuse_request_finds_serial_soft',
    gateSoftMinUnique: 10,
    quote: {
      uniqueOk: uniqueOk((r) => r.quote?.status === 'ok'),
      pass: uniqueOk((r) => r.quote?.status === 'ok') >= 10,
      skipped: rows.filter((r) => r.quote?.status === 'skipped').length,
    },
    a1: {
      uniqueOk: uniqueOk((r) => r.a1?.hdrStatus === 'ok'),
      pass: uniqueOk((r) => r.a1?.hdrStatus === 'ok') >= 10,
      stayIdRate: (() => {
        const hits = rows.filter((r) => r.find?.status === 'hit');
        if (hits.length === 0) return 0;
        return hits.filter((r) => r.find?.stayIdPresent).length / hits.length;
      })(),
    },
    folio: {
      uniqueOk: uniqueOk((r) => r.folio?.status === 'ok'),
      pass: uniqueOk((r) => r.folio?.status === 'ok') >= 10,
      surface: 'OSRESS.search+OSRESV.FOL',
      moneyGate: true,
    },
    find: {
      uniqueHit: uniqueOk((r) => r.find?.status === 'hit'),
      pass: uniqueOk((r) => r.find?.status === 'hit') >= 10,
    },
    scoreEmailBound: SCORE_EMAIL_BOUND,
    rows: rows.map((r) => ({
      emailTail: r.emailId.slice(-12),
      confTail: r.confTail,
      quote: r.quote?.status,
      find: r.find?.status,
      stayId: r.find?.stayIdPresent,
      a1: r.a1?.hdrStatus,
      folio: r.folio?.status,
      folioBalance: r.folio?.folioBalance,
      currency: r.folio?.currency,
      a1Fields: r.a1?.fieldHits,
      folioFields: r.folio?.fieldHits,
    })),
    note: SCORE_EMAIL_BOUND
      ? 'Reuse runner + email_own scoring. Folio ok requires money+ISO currency. Soft≥10 unique = done (no webm).'
      : 'Reuse runner: parallel request finds → drain → serial soft. Folio=OSRESS grid. Soft≥10 unique = done (no webm).',
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.log(
    JSON.stringify({
      phase: 'done',
      out: OUT,
      loginCycles: digest.loginCycles,
      quotePass: digest.quote.pass,
      a1Pass: digest.a1.pass,
      folioPass: digest.folio.pass,
      findPass: digest.find.pass,
      quoteUniqueOk: digest.quote.uniqueOk,
      a1UniqueOk: digest.a1.uniqueOk,
      folioUniqueOk: digest.folio.uniqueOk,
      findUniqueHit: digest.find.uniqueHit,
    }),
  );
  await browser.close();
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
