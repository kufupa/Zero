/**
 * Live ramp: one login → concurrent OSRESS.search at rising P.
 * Digests only. Finds HMS/session cliff (813, login bounce, wall blowup).
 *
 * Env:
 *   HMS_DISCOVERY_ALLOW_LIVE=1
 *   HMS_READ_SECRET_ARN
 *   HMS_CHROMIUM_EXECUTABLE_PATH
 *   HMS_FIND_RAMP_LEVELS=8,16,32 (default)
 *   HMS_FIND_RAMP_REPEAT=1
 *   HMS_FIND_RAMP_FRESH_LOGIN_EACH=0|1 — new login before every P (isolates cliff poison)
 *   HMS_FIND_RAMP_SUSTAIN=0..10 — after ramp, N bursts at highest viable P
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';
import { classifyOsressResponse } from './gold-fact-live-find-status.mjs';

const UNUSED = '___NOMATCH___';
const LEVELS = String(process.env.HMS_FIND_RAMP_LEVELS || '8,16,32')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 1 && n <= 128);
const REPEAT = Math.max(1, Math.min(3, Number(process.env.HMS_FIND_RAMP_REPEAT || 1) || 1));
const FRESH_LOGIN_EACH = process.env.HMS_FIND_RAMP_FRESH_LOGIN_EACH === '1';
const SUSTAIN = Math.max(0, Math.min(10, Number(process.env.HMS_FIND_RAMP_SUSTAIN || 0) || 0));

/** Unique synthetic conf tokens — HMS still returns pageData JSON (empty grid OK). */
function candidatesFor(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'confirmation', value: `RAMP${String(i).padStart(6, '0')}-1` });
  }
  return out;
}

function searchBodyFor(candidate) {
  const v = String(candidate.value);
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
    MADDON_FILTER_VALUE_3: v,
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
    MADDON_FILTER_JOINER_6: 'AND',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: UNUSED,
    MADDON_RPAREN_6: 'true',
    MADDON_FILTER_ALIAS_NAME_7: 'firstname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'AND',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: UNUSED,
  };
}

function classifyText(text) {
  const hasPageData = /pageData\s*:/.test(text) || /"pageData"\s*:/.test(text);
  const responseClass = classifyOsressResponse(
    text,
    hasPageData ? 'ok' : /loadLocalizedPage/i.test(text) ? 'no_pagedata' : 'no_pagedata',
  );
  return {
    bytes: text.length,
    hasPageData,
    responseClass,
    stub813: text.length === 813 || responseClass === 'loadLocalized',
  };
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

async function burst(ctx, origin, n) {
  const cands = candidatesFor(n);
  const t0 = Date.now();
  const results = await Promise.all(
    cands.map(async (c) => {
      try {
        const res = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
          form: searchBodyFor(c),
          timeout: 60_000,
        });
        const text = await res.text();
        const cls = classifyText(text);
        return { http: res.status(), ...cls, err: null };
      } catch (e) {
        return {
          http: 0,
          bytes: 0,
          hasPageData: false,
          responseClass: 'error',
          stub813: false,
          err: String(e?.message || e).slice(0, 80),
        };
      }
    }),
  );
  const wallMs = Date.now() - t0;
  const pageData = results.filter((r) => r.hasPageData).length;
  const stub813 = results.filter((r) => r.stub813).length;
  const loginBounce = results.filter((r) => r.responseClass === 'login').length;
  const errors = results.filter((r) => r.err).length;
  return {
    P: n,
    wallMs,
    thrPerSec: n / (wallMs / 1000),
    pageData,
    stub813,
    loginBounce,
    errors,
    okRate: pageData / n,
  };
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const levels = [];
  const sustain = [];
  let ctx = null;
  let page = null;
  let loginMs = 0;
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
    const ms = Date.now() - loginT0;
    loginMs += ms;
    loginCycles += 1;
    console.log(JSON.stringify({ phase: 'login', loginMs: ms, loginCycles }));
    return ms;
  }

  try {
    console.log(
      JSON.stringify({
        phase: 'start',
        levels: LEVELS,
        repeat: REPEAT,
        freshLoginEach: FRESH_LOGIN_EACH,
        sustain: SUSTAIN,
      }),
    );
    await openSession();

    let highestViable = null;
    for (const P of LEVELS) {
      if (FRESH_LOGIN_EACH && loginCycles > 0) {
        // Always fresh before each P except we already logged in for first —
        // re-login when starting a new P after the first.
        if (levels.length > 0) await openSession();
      }
      let cliffed = false;
      for (let r = 0; r < REPEAT; r++) {
        const row = await burst(ctx, origin, P);
        levels.push({ ...row, repeat: r, loginCycles });
        console.log(JSON.stringify({ phase: 'burst', ...row, repeat: r, loginCycles }));
        if (row.stub813 > 0 || row.loginBounce > 0 || row.okRate < 0.5) {
          console.log(JSON.stringify({ phase: 'cliff', atP: P, reason: 'quality_drop' }));
          cliffed = true;
          break;
        }
        highestViable = P;
      }
      if (cliffed && !FRESH_LOGIN_EACH) {
        // Session poisoned — stop ascending on shared session.
        break;
      }
    }

    if (SUSTAIN > 0 && highestViable) {
      await openSession();
      for (let s = 0; s < SUSTAIN; s++) {
        const row = await burst(ctx, origin, highestViable);
        sustain.push({ ...row, sustainIdx: s });
        console.log(JSON.stringify({ phase: 'sustain', ...row, sustainIdx: s, P: highestViable }));
        if (row.stub813 > 0 || row.loginBounce > 0 || row.okRate < 0.5) {
          console.log(JSON.stringify({ phase: 'sustain_cliff', atP: highestViable, afterBurst: s + 1 }));
          break;
        }
      }
    }

    const viable = levels.filter((r) => r.okRate >= 0.95 && r.stub813 === 0 && r.errors === 0);
    const best = [...(viable.length ? viable : levels)].sort((a, b) => b.thrPerSec - a.thrPerSec)[0];
    const cliffAt = levels.find((r) => r.okRate < 0.5 || r.stub813 > 0)?.P ?? null;
    const sustainOk = sustain.filter((r) => r.okRate >= 0.95 && r.stub813 === 0).length;
    const proj =
      best && best.okRate >= 0.95
        ? {
            findOnly3949Min: (40 + 3949 / best.thrPerSec) / 60,
            findOnly2115Min: (40 + 2115 / best.thrPerSec) / 60,
            atP: best.P,
            thrPerSec: best.thrPerSec,
            highestViable,
            caveat: 'synthetic_empty_grids; cliffAt=' + cliffAt,
          }
        : null;
    console.log(
      JSON.stringify(
        {
          phase: 'summary',
          loginCycles,
          loginMsTotal: loginMs,
          levels,
          sustain,
          sustainOk,
          sustainN: sustain.length,
          highestViable,
          best,
          cliffAt,
          proj3949: proj,
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
