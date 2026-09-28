/**
 * 2h read-close burn: quote OSRRAV soft-open + A1 HDR soft-open on find hits.
 * Digests only (conf tails). Sequential soft-opens — NOT a parallel scheduler.
 *
 * Env:
 *   HMS_DISCOVERY_ALLOW_LIVE=1
 *   HMS_READ_SECRET_ARN
 *   HMS_CHROMIUM_EXECUTABLE_PATH
 *   HMS_FIND_REAL_CANDIDATES_PATH — JSON [{kind,value}]
 *   HMS_READ_CLOSE_OUT — digest path
 *   HMS_READ_CLOSE_FIND_N=8
 *   HMS_READ_CLOSE_QUOTE_N=6
 *   HMS_READ_CLOSE_RELOGIN_EVERY=1
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
const FIND_N = Math.max(1, Math.min(24, Number(process.env.HMS_READ_CLOSE_FIND_N || 8) || 8));
const QUOTE_N = Math.max(1, Math.min(20, Number(process.env.HMS_READ_CLOSE_QUOTE_N || 6) || 6));
const RELOGIN_EVERY = Math.max(
  0,
  Number(process.env.HMS_READ_CLOSE_RELOGIN_EVERY ?? 1) || 0,
);
const CAND_PATH = process.env.HMS_FIND_REAL_CANDIDATES_PATH;
const OUT =
  process.env.HMS_READ_CLOSE_OUT ||
  '/tmp/hms-read-close-2h-burn.json';

const ROOM_CODES = ['DLXQN', 'DLXTWN', 'STQN', 'EXKNG', 'LUXKNG', 'SUITE'];

function loadCandidates() {
  if (!CAND_PATH) throw new Error('HMS_FIND_REAL_CANDIDATES_PATH required');
  const raw = JSON.parse(readFileSync(CAND_PATH, 'utf8'));
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const value = String(row?.value || '').trim();
    if (!value || seen.has(value)) continue;
    if (!/^\d{5,12}(-\d)?$/.test(value)) continue;
    seen.add(value);
    out.push({ kind: 'confirmation', value, src: String(row?.src || '').slice(0, 40) });
  }
  if (!out.length) throw new Error('no conf candidates');
  return out;
}

function mmddyyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
}

function futureDates() {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 14);
  const arr = base.toISOString().slice(0, 10);
  const dep = new Date(base);
  dep.setUTCDate(dep.getUTCDate() + 2);
  return { arrivalIso: arr, departureIso: dep.toISOString().slice(0, 10) };
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
        }).toString(),
      }).catch(() => null);
    }
  });
}

/** Same OSRESS.search body as hms-find-real-wave / gold-fact. */
function searchBodyFor(conf) {
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
    MADDON_FILTER_VALUE_3: conf,
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
    MADDON_FILTER_VALUE_5: UNUSED,
    MADDON_LPAREN_5: 'false',
    MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
    MADDON_FILTER_OPERATOR_6: 'BEGINS',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: UNUSED,
    MADDON_RPAREN_6: 'false',
    MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: UNUSED,
    MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
    MADDON_FILTER_OPERATOR_8: 'BEGINS',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: UNUSED,
    MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
    MADDON_FILTER_OPERATOR_9: 'BEGINS',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: UNUSED,
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'BEGINS',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: UNUSED,
    MADDON_RPAREN_10: 'true',
    externalconfirmation: UNUSED,
  };
}

async function findOne(page, conf) {
  const t0 = Date.now();
  const text = await page.evaluate(async (body) => {
    const r = await fetch('/web/base/OSRESS.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return r.text();
  }, searchBodyFor(conf));
  const loadLocalized = /loadLocalizedPage/i.test(text);
  const loginBounce = /type=["']password["']/i.test(text);
  const hasPageData = /pageData/i.test(text);
  let stayId = null;
  let confirmation = conf;
  const m = text.match(/"reservationstayid"\s*:\s*"?(\d+)"?/i);
  if (m) stayId = m[1];
  const c = text.match(/"confirmationnumber"\s*:\s*"([^"]+)"/i);
  if (c) confirmation = c[1];
  const rowish =
    /"RECORDS"\s*:\s*"?[1-9]/i.test(text) ||
    /reservationstayid/i.test(text) ||
    Boolean(stayId);
  let status = 'not_found';
  if (loginBounce) status = 'login';
  else if (loadLocalized || text.length === 813) status = 'loadLocalized';
  else if (hasPageData && rowish) status = 'hit';
  else if (hasPageData) status = 'not_found';
  else status = 'error';
  return {
    confTail: String(conf).slice(-8),
    status,
    stayIdPresent: Boolean(stayId),
    _confirmation: confirmation,
    _stayId: stayId,
    bytes: text.length,
    stub813: text.length === 813 || loadLocalized,
    ms: Date.now() - t0,
  };
}

async function softOpenHdr(page, hit) {
  const confirmation = hit._confirmation || '';
  const stayId = hit._stayId || '';
  if (!confirmation && !stayId) return { status: 'skipped', ms: 0 };
  const t0 = Date.now();
  const base = {
    confirmationnumber: confirmation,
    propertycode: 'HRCEN',
    MENU_MODULE_KEY: '0',
    removescreenflows: 'yes',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
  };
  if (stayId) {
    base.reservationstayid = stayId;
    base.id = stayId;
  }
  const result = await page.evaluate(async (fields) => {
    const post = async (path, extra) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...fields, ...extra }).toString(),
      });
      return r.text();
    };
    await post('/web/base/OSRESV.HDR', { CURRENT_TAB_NAME: 'HDR' });
    const tabs = ['HDR', 'GST', 'RATE'];
    const probes = [];
    for (const tab of tabs) {
      const text = await post(`/web/base/OSRESV.${tab}`, { CURRENT_TAB_NAME: tab });
      const keys = [
        ...text.matchAll(
          /"(arrival[^"]*|departure[^"]*|roomtype[^"]*|ratecode[^"]*|rateamount[^"]*|guestname[^"]*|status[^"]*|polic[^"]*|cancellation[^"]*|nightly[^"]*|confirmationnumber[^"]*|reservationstayid[^"]*)"/gi,
        ),
      ].map((m) => m[1]);
      const uniq = [...new Set(keys)].slice(0, 40);
      probes.push({
        tab,
        bytes: text.length,
        hasPageData: /pageData/i.test(text),
        loadLocalized: /loadLocalizedPage/i.test(text) && text.length < 2000,
        keyHitN: uniq.length,
        keySample: uniq.slice(0, 12),
        binds:
          (fields.confirmationnumber && text.includes(fields.confirmationnumber)) ||
          (fields.reservationstayid && text.includes(String(fields.reservationstayid))),
      });
    }
    return probes;
  }, base);
  const ok = result.some(
    (p) => p.hasPageData && !p.loadLocalized && p.binds && (p.keyHitN > 0 || p.bytes > 800),
  );
  const coreKeys = new Set();
  for (const p of result) for (const k of p.keySample || []) coreKeys.add(String(k).toLowerCase());
  return {
    status: ok ? 'ok' : 'mismatch',
    confTail: String(confirmation).slice(-8),
    stayIdPresent: Boolean(stayId),
    probes: result.map((p) => ({
      tab: p.tab,
      bytes: p.bytes,
      hasPageData: p.hasPageData,
      stub813: p.loadLocalized || p.bytes === 813,
      binds: p.binds,
      keyHitN: p.keyHitN,
      keySample: p.keySample,
    })),
    fieldHits: {
      arrival: [...coreKeys].some((k) => k.includes('arrival')),
      departure: [...coreKeys].some((k) => k.includes('departure')),
      roomType: [...coreKeys].some((k) => k.includes('roomtype')),
      rate: [...coreKeys].some((k) => k.includes('rate')),
      guest: [...coreKeys].some((k) => k.includes('guest')),
      policy: [...coreKeys].some((k) => k.includes('polic') || k.includes('cancel')),
    },
    ms: Date.now() - t0,
  };
}

async function softOpenQuote(page, { roomType, arrivalIso, departureIso }) {
  const t0 = Date.now();
  void departureIso;
  const start = mmddyyyy(arrivalIso) || '09/29/2026';
  const hotel = start;
  const result = await page.evaluate(
    async ({ roomType, start, hotel }) => {
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
      const nightlyKeys = [
        ...text.matchAll(
          /"(availability[^"]*|rate[^"]*|night[^"]*|inventory[^"]*|restriction[^"]*|roomtype[^"]*|amount[^"]*)"/gi,
        ),
      ].map((m) => m[1]);
      const uniq = [...new Set(nightlyKeys)].slice(0, 30);
      return {
        bytes: text.length,
        hasPageData: /pageData/i.test(text),
        hasAvailability: /availabilitydata/i.test(text),
        loadLocalized: /loadLocalizedPage/i.test(text),
        loginBounce: /type=["']password["']/i.test(text),
        keyHitN: uniq.length,
        keySample: uniq.slice(0, 15),
      };
    },
    { roomType, start, hotel },
  );
  const ok =
    result.hasPageData &&
    result.hasAvailability &&
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

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const pool = loadCandidates().slice(0, FIND_N);
  const dates = futureDates();
  const quotePlan = ROOM_CODES.slice(0, QUOTE_N).map((roomType) => ({
    roomType,
    ...dates,
  }));

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
  let loginMsTotal = 0;
  let softSinceLogin = 0;

  const relogin = async () => {
    const t0 = Date.now();
    if (page && !page.isClosed()) await page.close().catch(() => null);
    page = await ctx.newPage();
    await login(page, secret);
    await warmBsstrt(page);
    loginCycles += 1;
    loginMsTotal += Date.now() - t0;
    softSinceLogin = 0;
    console.log(JSON.stringify({ phase: 'login', loginCycles, loginMs: Date.now() - t0 }));
  };

  const maybeRelogin = async () => {
    if (RELOGIN_EVERY > 0 && softSinceLogin >= RELOGIN_EVERY) await relogin();
  };

  await relogin();

  const quoteRows = [];
  for (const q of quotePlan) {
    await maybeRelogin();
    const row = await softOpenQuote(page, q);
    softSinceLogin += 1;
    quoteRows.push(row);
    console.log(
      JSON.stringify({
        phase: 'quote',
        roomType: row.roomType,
        status: row.status,
        bytes: row.bytes,
        keyHitN: row.keyHitN,
        ms: row.ms,
      }),
    );
  }

  const findRows = [];
  const hdrRows = [];
  for (const cand of pool) {
    await maybeRelogin();
    const fr = await findOne(page, cand.value);
    softSinceLogin += 1;
    findRows.push({
      confTail: fr.confTail,
      status: fr.status,
      stayIdPresent: fr.stayIdPresent,
      stub813: fr.stub813,
      ms: fr.ms,
    });
    console.log(JSON.stringify({ phase: 'find', ...findRows[findRows.length - 1] }));
    if (fr.status !== 'hit') continue;
    await maybeRelogin();
    const hdr = await softOpenHdr(page, fr);
    softSinceLogin += 1;
    hdrRows.push(hdr);
    console.log(
      JSON.stringify({
        phase: 'a1_hdr',
        confTail: hdr.confTail,
        status: hdr.status,
        fieldHits: hdr.fieldHits,
        ms: hdr.ms,
      }),
    );
  }

  const digest = {
    when: new Date().toISOString(),
    via: 'evaluate',
    reloginEvery: RELOGIN_EVERY,
    loginCycles,
    loginMsTotal,
    quote: {
      attempted: quoteRows.length,
      ok: quoteRows.filter((r) => r.status === 'ok').length,
      tails: quoteRows.map((r) => ({
        roomType: r.roomType,
        arrival: r.arrival,
        status: r.status,
        bytes: r.bytes,
        hasAvailability: r.hasAvailability,
        keyHitN: r.keyHitN,
        keySample: r.keySample,
        ms: r.ms,
      })),
    },
    find: {
      attempted: findRows.length,
      hits: findRows.filter((r) => r.status === 'hit').length,
      tails: findRows,
    },
    a1Hdr: {
      attempted: hdrRows.length,
      ok: hdrRows.filter((r) => r.status === 'ok').length,
      fieldHitRates: (() => {
        const keys = ['arrival', 'departure', 'roomType', 'rate', 'guest', 'policy'];
        const n = hdrRows.length || 1;
        const out = {};
        for (const k of keys) {
          out[k] = hdrRows.filter((r) => r.fieldHits?.[k]).length / n;
        }
        return out;
      })(),
      tails: hdrRows.map((r) => ({
        confTail: r.confTail,
        status: r.status,
        stayIdPresent: r.stayIdPresent,
        fieldHits: r.fieldHits,
        probes: r.probes,
        ms: r.ms,
      })),
    },
    note: 'Sequential soft-open only — no parallel tool scheduler',
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.log(JSON.stringify({ phase: 'done', out: OUT, quoteOk: digest.quote.ok, a1Ok: digest.a1Hdr.ok }));
  await browser.close();
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
