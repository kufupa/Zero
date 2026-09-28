/**
 * Live: one login → 2 waves of P concurrent OSRESS.search with REAL conf candidates.
 * Digests only (conf tails, not full values in summary).
 *
 * Env:
 *   HMS_DISCOVERY_ALLOW_LIVE=1
 *   HMS_READ_SECRET_ARN
 *   HMS_CHROMIUM_EXECUTABLE_PATH
 *   HMS_FIND_REAL_CANDIDATES_PATH — JSON array [{kind,value,src}]
 *   HMS_FIND_REAL_P=32
 *   HMS_FIND_REAL_WAVES=2
 *   HMS_FIND_REAL_RELOGIN_EACH_WAVE=0|1 — fresh login before every wave (needed for real grids)
 *   HMS_FIND_REAL_SOFTOPEN=0|1 — after each find wave, soft-open folio+notes on hits (same session)
 *   HMS_FIND_REAL_SOFTOPEN_MAX — cap soft-opens across whole run (default unlimited)
 *   HMS_FIND_REAL_SOFTOPEN_SLIM=1 — FOL+HDR + TRC+NTE only (faster wall)
 *   HMS_FIND_REAL_SOFTOPEN_VIA=request|evaluate — soft-open transport (default evaluate)
 *   HMS_FIND_REAL_SOFTOPEN_RELOGIN=1 — fresh login before soft-open batch (after find wave)
 *   HMS_FIND_REAL_SOFTOPEN_RELOGIN_EVERY=N — relogin after every N soft-opens (0=off; default 2 when softopen on)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';
import {
  classifyOsressResponse,
  statusForOsressFind,
} from './gold-fact-live-find-status.mjs';

const UNUSED = '___NOMATCH___';
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const P = Math.max(1, Math.min(64, Number(process.env.HMS_FIND_REAL_P || 32) || 32));
const WAVES = Math.max(1, Math.min(5, Number(process.env.HMS_FIND_REAL_WAVES || 2) || 2));
const CAND_PATH = process.env.HMS_FIND_REAL_CANDIDATES_PATH;
const RELOGIN_EACH_WAVE = process.env.HMS_FIND_REAL_RELOGIN_EACH_WAVE === '1';
const SOFTOPEN = process.env.HMS_FIND_REAL_SOFTOPEN === '1';
const SOFTOPEN_MAX = Math.max(
  0,
  Number(process.env.HMS_FIND_REAL_SOFTOPEN_MAX || 0) || 0,
);
const SOFTOPEN_SLIM = process.env.HMS_FIND_REAL_SOFTOPEN_SLIM !== '0';
const SOFTOPEN_VIA = (process.env.HMS_FIND_REAL_SOFTOPEN_VIA || 'evaluate').toLowerCase();
const SEARCH_VIA = (process.env.HMS_FIND_REAL_SEARCH_VIA || 'request').toLowerCase();
const NAVIGATE_GUEST_STAY = process.env.HMS_FIND_REAL_NAVIGATE === '1';
const NAVIGATE_OSRESV = process.env.HMS_FIND_REAL_NAVIGATE_OSRESV === '1';
const NAVIGATE_OSRESV_FALLBACK = process.env.HMS_FIND_REAL_NAVIGATE_OSRESV_FALLBACK === '1';
const SOFTOPEN_RELOGIN = process.env.HMS_FIND_REAL_SOFTOPEN_RELOGIN === '1';
const SOFTOPEN_RELOGIN_EVERY = (() => {
  if (process.env.HMS_FIND_REAL_SOFTOPEN_RELOGIN_EVERY != null) {
    return Math.max(0, Number(process.env.HMS_FIND_REAL_SOFTOPEN_RELOGIN_EVERY) || 0);
  }
  // A/B 2026-09-14: soft-opens cliff after ~2–3 on one session; every-1 proven bind-ok.
  return SOFTOPEN ? 1 : 0;
})();

function loadCandidates() {
  if (!CAND_PATH) throw new Error('HMS_FIND_REAL_CANDIDATES_PATH required');
  const raw = JSON.parse(readFileSync(CAND_PATH, 'utf8'));
  if (!Array.isArray(raw) || raw.length < 1) throw new Error('candidates empty');
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    const value = String(row?.value || '').trim();
    if (!value || seen.has(value) || value.startsWith('RAMP')) continue;
    const kind = row?.kind === 'surname_dates' ? 'surname_dates' : 'confirmation';
    if (kind === 'confirmation' && !/^\d{5,12}(-\d)?$/.test(value)) continue;
    seen.add(value);
    out.push({
      kind,
      value,
      surname: row?.surname,
      src: String(row?.src || '').slice(0, 80),
    });
  }
  if (out.length < 1) throw new Error('no usable real candidates');
  return out;
}

function buildWaves(pool, waves, p, { recycle = true } = {}) {
  if (!recycle) {
    const out = [];
    for (let i = 0; i < pool.length && out.length < waves; i += p) {
      out.push(pool.slice(i, i + p));
    }
    return out;
  }
  const need = waves * p;
  const expanded = [];
  for (let i = 0; i < need; i++) expanded.push(pool[i % pool.length]);
  const out = [];
  for (let w = 0; w < waves; w++) out.push(expanded.slice(w * p, (w + 1) * p));
  return out;
}

/** Same OSRESS.search body as gold-fact-backtest-29-live.mjs */
function searchBodyFor(candidate) {
  const isSurname = candidate.kind === 'surname_dates';
  const v = isSurname ? candidate.surname || candidate.value : candidate.value;
  const confVal = candidate.kind === 'confirmation' ? v : UNUSED;
  const extVal = candidate.kind === 'external_reference' ? v : UNUSED;
  const lastnameVal = isSurname ? v : UNUSED;
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
    if (!m) {
      return {
        rows: [],
        parse: /type=["']password["']/i.test(searchText)
          ? 'login_bounce'
          : /Unable to retrieve|success"\s*:\s*false/i.test(searchText)
            ? 'error_signal'
            : 'no_pagedata',
      };
    }
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
        roomType: row.roomtype != null ? String(row.roomtype) : null,
        lastName: row.lastname != null ? String(row.lastname) : null,
        stayId: row.id != null ? String(row.id) : null,
      })),
    };
  } catch {
    return { rows: [], parse: 'json_fail' };
  }
}

function correlate(rows, candidate) {
  if (!rows.length) return { outcome: 'not_found', rows: [] };
  let matched = rows;
  if (candidate.kind === 'confirmation') {
    const v = String(candidate.value).toUpperCase();
    matched = rows.filter((r) => (r.confirmation || '').toUpperCase().startsWith(v));
  }
  if (!matched.length) return { outcome: 'not_found', rows: [] };
  if (matched.length === 1) return { outcome: 'matched', rows: matched };
  return { outcome: 'ambiguous', rows: matched.slice(0, 5) };
}

async function installRoute(ctx, origin) {
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
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
  await page.waitForTimeout(4_000);
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
          manurefresh: 'yes',
        }).toString(),
      }).catch(() => undefined);
    }
  });
  await page.waitForTimeout(1000);
}

async function burst(ctx, page, origin, cands, waveIdx) {
  const t0 = Date.now();
  const results = await Promise.all(
    cands.map(async (c) => {
      try {
        let text;
        let http;
        if (SEARCH_VIA === 'evaluate') {
          const result = await page.evaluate(
            async ({ url, fields }) => {
              const response = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(fields).toString(),
                redirect: 'manual',
              });
              return { text: await response.text(), status: response.status };
            },
            { url: `${origin}/web/base/OSRESS.search`, fields: searchBodyFor(c) },
          );
          text = result.text;
          http = result.status;
        } else {
          const res = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
            form: searchBodyFor(c),
            timeout: 60_000,
          });
          text = await res.text();
          http = res.status();
        }
        const parsed = parseOsressRows(text);
        const corr = correlate(parsed.rows, c);
        const top = corr.rows[0];
        const responseClass = classifyOsressResponse(text, parsed.parse);
        const status = statusForOsressFind({
          parse: parsed.parse,
          corrOutcome: corr.outcome,
          responseClass,
          hasRoomType: Boolean(top?.roomType),
        });
        const stub813 = text.length === 813 || responseClass === 'loadLocalized';
        return {
          confTail: String(c.value).slice(-8),
          queryValue: c.value,
          src: c.src,
          http,
          bytes: text.length,
          parse: parsed.parse,
          responseClass,
          status,
          outcome: corr.outcome,
          rowCount: parsed.rows.length,
          matchedCount: corr.rows.length,
          confirmation: top?.confirmation ?? null,
          stayId: top?.stayId ?? null,
          hitConfTail: top?.confirmation ? String(top.confirmation).slice(-8) : null,
          stub813,
          err: null,
        };
      } catch (e) {
        return {
          confTail: String(c.value).slice(-8),
          src: c.src,
          http: 0,
          bytes: 0,
          parse: 'error',
          responseClass: 'error',
          status: 'error',
          outcome: null,
          rowCount: 0,
          matchedCount: 0,
          hitConfTail: null,
          stub813: false,
          err: String(e?.message || e).slice(0, 80),
        };
      }
    }),
  );
  const wallMs = Date.now() - t0;
  const pageData = results.filter((r) => r.parse === 'ok').length;
  const stub813 = results.filter((r) => r.stub813).length;
  const hits = results.filter((r) =>
    ['ok', 'partial', 'ambiguous'].includes(String(r.status)),
  ).length;
  const notFound = results.filter((r) => r.status === 'not_found').length;
  const errors = results.filter((r) => r.err || r.status === 'error').length;
  return {
    wave: waveIdx,
    P: cands.length,
    wallMs,
    thrPerSec: cands.length / (wallMs / 1000),
    pageData,
    stub813,
    hits,
    notFound,
    errors,
    okRate: pageData / cands.length,
    results: results.map((r) => ({
      confTail: r.confTail,
      http: r.http,
      bytes: r.bytes,
      parse: r.parse,
      status: r.status,
      outcome: r.outcome,
      rowCount: r.rowCount,
      matchedCount: r.matchedCount,
      hitConfTail: r.hitConfTail,
      confirmationTail: r.confirmation ? String(r.confirmation).slice(-8) : null,
      confirmationSha256: r.confirmation ? sha256(r.confirmation) : null,
      stayIdSha256: r.stayId ? sha256(r.stayId) : null,
      stayIdPresent: Boolean(r.stayId),
      stub813: r.stub813,
      err: r.err,
      // keep full keys only for soft-open handoff in-process (not logged in digests)
      _confirmation: r.confirmation,
      _stayId: r.stayId,
      _queryValue: r.queryValue,
    })),
  };
}

async function postForm(ctx, origin, path, fields) {
  const res = await ctx.request.post(`${origin}${path}`, {
    form: fields,
    timeout: 60_000,
  });
  const text = await res.text();
  return { text, bytes: text.length, http: res.status() };
}

async function postFormEvaluate(page, origin, path, fields) {
  return page.evaluate(
    async ({ url, fields }) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
      }).catch(() => null);
      const text = r ? await r.text() : '';
      return { text, bytes: text.length, http: r ? r.status : 0 };
    },
    { url: `${origin}${path}`, fields },
  );
}

function redactResult(r) {
  return {
    confTail: r.confTail,
    http: r.http,
    bytes: r.bytes,
    parse: r.parse,
    status: r.status,
    outcome: r.outcome,
    rowCount: r.rowCount,
    matchedCount: r.matchedCount,
    hitConfTail: r.hitConfTail,
    confirmationTail: r.confirmationTail,
    confirmationSha256: r.confirmationSha256 ?? null,
    stayIdSha256: r.stayIdSha256 ?? null,
    stayIdPresent: r.stayIdPresent,
    stub813: r.stub813,
    err: r.err,
  };
}

/** Folio + notes soft-open for one find hit. Digests only (tails). */
async function softOpenHit(transport, origin, hit) {
  const confirmation = hit._confirmation || hit._queryValue || '';
  const stayId = hit._stayId || '';
  if (!confirmation && !stayId) {
    return { status: 'skipped_need_find', folio: null, notes: null, ms: 0, via: SOFTOPEN_VIA };
  }
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

  const post = async (path, fields) => {
    if (SOFTOPEN_VIA === 'request') {
      return postForm(transport.ctx, origin, path, fields);
    }
    return postFormEvaluate(transport.page, origin, path, fields);
  };

  // Establish stay context before FOL/notes (Wave-A pattern: HDR then children).
  const hdrWarm = await post(`/web/base/OSRESV.HDR`, {
    CURRENT_TAB_NAME: 'HDR',
    MENU_MODULE_KEY: '0',
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    removescreenflows: 'yes',
    propertycode: 'HRCEN',
    ...(confirmation ? { confirmationnumber: confirmation } : {}),
    ...(stayId ? { reservationstayid: stayId, id: stayId } : {}),
  });
  const hdrWarmStub =
    hdrWarm.bytes === 813 ||
    (/loadLocalizedPage/i.test(hdrWarm.text) && hdrWarm.bytes < 2000);
  const confNeedle = confirmation ? String(confirmation) : '';
  const stayNeedle = stayId ? String(stayId) : '';
  const binds = (text) =>
    Boolean(
      (confNeedle && text.includes(confNeedle)) ||
        (stayNeedle && text.includes(stayNeedle)),
    );

  const folioTabs = SOFTOPEN_SLIM ? ['FOL', 'HDR'] : ['FOL', 'FOLO', 'FLIO', 'LED', 'HDR'];
  const folioProbes = [];
  for (const tab of folioTabs) {
    const { text, bytes } = await post(`/web/base/OSRESV.${tab}`, {
      ...base,
      CURRENT_TAB_NAME: tab,
    });
    const keyHitN = [
      ...text.matchAll(/"(balance[^"]*|amount[^"]*|folio[^"]*|payment[^"]*|total[^"]*|outstanding[^"]*)"/gi),
    ].length;
    const loadLocalized = /loadLocalizedPage/i.test(text) && bytes < 2000;
    folioProbes.push({
      tab,
      bytes,
      hasPageData: /pageData/i.test(text),
      keyHitN,
      stub813: bytes === 813 || loadLocalized,
      binds: binds(text),
    });
  }
  const folioOk = folioProbes.some(
    (p) =>
      p.hasPageData &&
      !p.stub813 &&
      p.binds &&
      (p.keyHitN > 0 || p.bytes > 500),
  );

  const notePaths = SOFTOPEN_SLIM
    ? ['OSRESV.TRC', 'OSRESV.NTE']
    : ['OSRESV.TRC', 'OSRESV.NTE', 'OSRESV.NOTE', 'OSRESV.HDR', 'OSRESS.TRC', 'OSRESS.NTE'];
  const notesProbes = [];
  for (const path of notePaths) {
    const [sys, tab] = path.split('.');
    const { text, bytes } = await post(`/web/base/${path}`, {
      ...base,
      SYSTEM_FUNCTION_NAME: sys,
      USER_FUNCTION_NAME: sys === 'OSRESS' ? 'OSRESV' : sys,
      CURRENT_TAB_NAME: tab,
    });
    const keyHitN = [
      ...text.matchAll(/"(trace[^"]*|note[^"]*|alert[^"]*|reservationnote[^"]*|tracestatus[^"]*)"/gi),
    ].length;
    const loadLocalized = /loadLocalizedPage/i.test(text) && bytes < 2000;
    notesProbes.push({
      path,
      bytes,
      hasPageData: /pageData/i.test(text),
      keyHitN,
      stub813: bytes === 813 || loadLocalized,
      binds: binds(text),
    });
  }
  const notesOk = notesProbes.some(
    (p) =>
      p.hasPageData &&
      !p.stub813 &&
      p.binds &&
      (p.keyHitN > 0 || p.bytes > 800),
  );

  return {
    confTail: hit.hitConfTail || hit.confTail,
    stayIdPresent: Boolean(stayId),
    hdrWarm: {
      bytes: hdrWarm.bytes,
      stub813: hdrWarmStub,
      binds: binds(hdrWarm.text),
      hasPageData: /pageData/i.test(hdrWarm.text),
    },
    folio: { status: folioOk ? 'ok' : 'mismatch', probes: folioProbes },
    notes: { status: notesOk ? 'ok' : 'mismatch', probes: notesProbes },
    ms: Date.now() - t0,
    via: SOFTOPEN_VIA,
  };
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const pool = loadCandidates();
  const noRecycle = process.env.HMS_FIND_REAL_NO_RECYCLE === '1' || RELOGIN_EACH_WAVE;
  const waveBudget =
    process.env.HMS_FIND_REAL_WAVES === 'all'
      ? Math.ceil(pool.length / P)
      : WAVES;
  const waves = buildWaves(pool, waveBudget, P, { recycle: !noRecycle });
  const uniqueInRun = new Set(waves.flat().map((c) => c.value)).size;

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  let ctx = null;
  let page = null;
  let loginMsTotal = 0;
  let loginCycles = 0;

  async function openSession() {
    if (ctx) await ctx.close().catch(() => undefined);
    ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    });
    await installRoute(ctx, origin);
    page = await ctx.newPage();
    const loginT0 = Date.now();
    await login(page, secret);
    await warmBsstrt(page);
    loginMsTotal += Date.now() - loginT0;
    loginCycles += 1;
    console.log(JSON.stringify({ phase: 'login', loginMs: Date.now() - loginT0, loginCycles }));
  }

  try {
    console.log(
      JSON.stringify({
        phase: 'start',
        P,
        wavesPlanned: waves.length,
        poolUnique: pool.length,
        uniqueInRun,
        recycled: uniqueInRun < waves.flat().length,
        reloginEachWave: RELOGIN_EACH_WAVE,
        noRecycle,
        softOpen: SOFTOPEN,
        softOpenMax: SOFTOPEN_MAX || null,
        softOpenSlim: SOFTOPEN_SLIM,
        softOpenVia: SOFTOPEN_VIA,
        navigateGuestStay: NAVIGATE_GUEST_STAY,
        navigateOsresv: NAVIGATE_OSRESV,
        softOpenRelogin: SOFTOPEN_RELOGIN,
        softOpenReloginEvery: SOFTOPEN_RELOGIN_EVERY || null,
      }),
    );
    await openSession();
    if (NAVIGATE_OSRESV) {
      await page.goto(`${origin}/web/base/OSRESV`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      if (NAVIGATE_OSRESV_FALLBACK) {
        await page.evaluate(
          async ({ url, fields }) => {
            await fetch(url, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams(fields).toString(),
              redirect: 'manual',
            });
          },
          {
            url: `${origin}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`,
            fields: {
              SYSTEM_FUNCTION_NAME: 'OSRESV',
              USER_FUNCTION_NAME: 'OSRESV',
              CURRENT_TAB_NAME: '',
              MENU_MODULE_KEY: '0',
              FUNCTION_CLASS: 'WEBL',
              removescreenflows: 'yes',
            },
          },
        ).catch(() => undefined);
      }
      await page.waitForTimeout(5_000);
      const landing = await page.content().catch(() => '');
      console.log(JSON.stringify({
        phase: 'landing',
        urlPath: (() => { try { return new URL(page.url()).pathname; } catch { return ''; } })(),
        bytes: landing.length,
        hasSearchInput: /name=["']search["']/i.test(landing),
        hasConfirmationInput: /ff_confirmationnumber/i.test(landing),
        hasFrontDesk: /Front Desk/i.test(landing),
        hasGuestStay: /Guest Stay/i.test(landing),
      }));
    }
    if (NAVIGATE_GUEST_STAY) {
      await page.waitForTimeout(12_000);
      await page
        .getByText('Front Desk', { exact: true })
        .first()
        .click({ force: true, timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(2_500);
      await page
        .getByText('Guest Stay', { exact: true })
        .first()
        .click({ force: true, timeout: 8_000 })
        .catch(() => undefined);
      await page.evaluate((wanted) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if ((node.textContent || '').trim() === wanted) {
            node.parentElement?.click();
            return true;
          }
          node = walker.nextNode();
        }
        return false;
      }, 'Guest Stay').catch(() => false);
      await page.waitForTimeout(5_000);
    }

    const waveRows = [];
    const softOpenRows = [];
    let softOpenDone = 0;
    let softOpenMsTotal = 0;
    let softOpenSinceLogin = 0;
    for (let i = 0; i < waves.length; i++) {
      if (RELOGIN_EACH_WAVE && i > 0) await openSession();
      const row = await burst(ctx, page, origin, waves[i], i);
      waveRows.push(row);
      console.log(
        JSON.stringify({
          phase: 'wave',
          wave: i,
          P: row.P,
          wallMs: row.wallMs,
          thrPerSec: row.thrPerSec,
          pageData: row.pageData,
          stub813: row.stub813,
          hits: row.hits,
          notFound: row.notFound,
          errors: row.errors,
          okRate: row.okRate,
          loginCycles,
        }),
      );

      if (SOFTOPEN && row.stub813 === 0) {
        const hits = row.results.filter((r) =>
          ['ok', 'partial', 'ambiguous'].includes(String(r.status)),
        );
        if (hits.length && SOFTOPEN_RELOGIN) {
          await openSession();
          softOpenSinceLogin = 0;
        }
        for (const hit of hits) {
          if (SOFTOPEN_MAX > 0 && softOpenDone >= SOFTOPEN_MAX) break;
          if (
            SOFTOPEN_RELOGIN_EVERY > 0 &&
            softOpenSinceLogin >= SOFTOPEN_RELOGIN_EVERY
          ) {
            await openSession();
            softOpenSinceLogin = 0;
          }
          const so = await softOpenHit({ ctx, page }, origin, hit);
          softOpenDone += 1;
          softOpenSinceLogin += 1;
          softOpenMsTotal += so.ms || 0;
          softOpenRows.push({ wave: i, ...so });
          console.log(
            JSON.stringify({
              phase: 'softopen',
              wave: i,
              n: softOpenDone,
              confTail: so.confTail,
              folio: so.folio?.status,
              notes: so.notes?.status,
              ms: so.ms,
              via: so.via,
              softOpenSinceLogin,
              hdrWarm: so.hdrWarm,
              folioStub: so.folio?.probes?.some((p) => p.stub813) || false,
              notesStub: so.notes?.probes?.some((p) => p.stub813) || false,
              folioBinds: (so.folio?.probes || []).some((p) => p.binds),
              notesBinds: (so.notes?.probes || []).some((p) => p.binds),
              folioBytes: (so.folio?.probes || []).map((p) => p.bytes),
              notesBytes: (so.notes?.probes || []).map((p) => p.bytes),
            }),
          );
        }
      }

      if (row.stub813 > 0 || row.okRate < 0.5) {
        console.log(JSON.stringify({ phase: 'cliff', atWave: i, reason: 'quality_drop' }));
        if (!RELOGIN_EACH_WAVE) break;
        // with per-wave login, cliff on a wave is fatal for that wave only — stop
        break;
      }
    }

    const allOk = waveRows.every((w) => w.okRate >= 0.95 && w.stub813 === 0);
    const hitsTotal = waveRows.reduce((s, w) => s + w.hits, 0);
    const pageDataTotal = waveRows.reduce((s, w) => s + w.pageData, 0);
    const folioOkN = softOpenRows.filter((s) => s.folio?.status === 'ok').length;
    const notesOkN = softOpenRows.filter((s) => s.notes?.status === 'ok').length;
    const folioBindN = softOpenRows.filter((s) =>
      (s.folio?.probes || []).some((p) => p.binds && !p.stub813),
    ).length;
    const notesBindN = softOpenRows.filter((s) =>
      (s.notes?.probes || []).some((p) => p.binds && !p.stub813),
    ).length;
    const softStubN = softOpenRows.filter(
      (s) =>
        s.folio?.probes?.some((p) => p.stub813) || s.notes?.probes?.some((p) => p.stub813),
    ).length;
    console.log(
      JSON.stringify(
        {
          phase: 'summary',
          loginMsTotal,
          loginCycles,
          P,
          wavesAttempted: waveRows.length,
          poolUnique: pool.length,
          uniqueInRun,
          hitsTotal,
          pageDataTotal,
          allOk,
          softOpen: {
            enabled: SOFTOPEN,
            slim: SOFTOPEN_SLIM,
            via: SOFTOPEN_VIA,
            reloginBefore: SOFTOPEN_RELOGIN,
            reloginEvery: SOFTOPEN_RELOGIN_EVERY || null,
            attempted: softOpenRows.length,
            folioOk: folioOkN,
            notesOk: notesOkN,
            folioBind: folioBindN,
            notesBind: notesBindN,
            stubHits: softStubN,
            msTotal: softOpenMsTotal,
            rows: softOpenRows,
          },
          waves: waveRows.map((w) => ({
            wave: w.wave,
            wallMs: w.wallMs,
            pageData: w.pageData,
            stub813: w.stub813,
            hits: w.hits,
            notFound: w.notFound,
            errors: w.errors,
            okRate: w.okRate,
            thrPerSec: w.thrPerSec,
            results: w.results.map(redactResult),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(String(e?.message || e).slice(0, 240));
  process.exit(1);
});
