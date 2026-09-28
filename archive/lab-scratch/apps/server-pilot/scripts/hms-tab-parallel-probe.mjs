/**
 * Live A/B: parallel OSRESS.search under ONE login / one BrowserContext.
 *
 * Modes via HMS_TAB_PROBE_MODE:
 *   full (default) — A serial then B concurrent request then optional C tabs then D
 *   request_only — fresh login → only concurrent context.request (no serial burn)
 *   serial_only — fresh login → only serial evaluate (budget baseline)
 *
 * Digests only.
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../../../../../apps/server-pilot/dist/hms/runtime.js';
import { classifyOsressResponse } from './gold-fact-live-find-status.mjs';

const UNUSED = '___NOMATCH___';
const N = Math.max(2, Math.min(16, Number(process.env.HMS_TAB_PROBE_N || 4) || 4));
const MODE = String(process.env.HMS_TAB_PROBE_MODE || 'full').toLowerCase();

const CANDIDATES = [
  { kind: 'confirmation', value: '17389451-1' },
  { kind: 'confirmation', value: '77200351-1' },
  { kind: 'confirmation', value: '25504965-1' },
  { kind: 'confirmation', value: '46461892-1' },
  { kind: 'confirmation', value: '29381171-1' },
  { kind: 'confirmation', value: '0311135' },
  { kind: 'confirmation', value: '99999999-1' },
  { kind: 'confirmation', value: '88888888-1' },
  { kind: 'confirmation', value: '11111111-1' },
  { kind: 'confirmation', value: '22222222-1' },
  { kind: 'confirmation', value: '33333333-1' },
  { kind: 'confirmation', value: '44444444-1' },
  { kind: 'confirmation', value: '55555555-1' },
  { kind: 'confirmation', value: '66666666-1' },
  { kind: 'confirmation', value: '77777777-1' },
  { kind: 'confirmation', value: '12121212-1' },
].slice(0, N);

function searchBodyFor(candidate) {
  const v = candidate.value;
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

function classifyText(text) {
  const hasPageData = text.includes('pageData:') || /"pageData"\s*:/.test(text);
  const loadLocalized = /loadLocalizedPage/i.test(text) && text.length < 2000;
  const responseClass = classifyOsressResponse(text, hasPageData ? 'ok' : 'no_pagedata');
  return {
    bytes: text.length,
    hasPageData,
    loadLocalized,
    responseClass: String(responseClass).slice(0, 48),
  };
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

async function searchEvaluate(page, candidate) {
  const t0 = Date.now();
  const body = searchBodyFor(candidate);
  try {
    const text = await page.evaluate(async (b) => {
      const res = await fetch('/web/base/OSRESS.search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(b).toString(),
      });
      return res.text();
    }, body);
    return { confTail: String(candidate.value).slice(-6), ms: Date.now() - t0, ...classifyText(text) };
  } catch (e) {
    return {
      confTail: String(candidate.value).slice(-6),
      ms: Date.now() - t0,
      bytes: 0,
      hasPageData: false,
      loadLocalized: false,
      responseClass: 'evaluate_error',
      error: String(e?.message || e).slice(0, 80),
    };
  }
}

async function searchRequest(ctx, origin, candidate) {
  const t0 = Date.now();
  const body = searchBodyFor(candidate);
  try {
    const res = await ctx.request.post(`${origin}/web/base/OSRESS.search`, {
      form: body,
      timeout: 60_000,
    });
    const text = await res.text();
    return {
      confTail: String(candidate.value).slice(-6),
      ms: Date.now() - t0,
      http: res.status(),
      ...classifyText(text),
    };
  } catch (e) {
    return {
      confTail: String(candidate.value).slice(-6),
      ms: Date.now() - t0,
      bytes: 0,
      hasPageData: false,
      loadLocalized: false,
      responseClass: 'request_error',
      error: String(e?.message || e).slice(0, 80),
    };
  }
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

function summarize(label, wallMs, results) {
  const pageData = results.filter((r) => r.hasPageData).length;
  const poisoned = results.filter(
    (r) =>
      r.loadLocalized ||
      r.responseClass === 'evaluate_error' ||
      (r.bytes > 0 && r.bytes < 1000 && !r.hasPageData),
  ).length;
  return {
    label,
    wallMs,
    n: results.length,
    pageData,
    poisoned,
    okRate: results.length ? Math.round((pageData / results.length) * 100) / 100 : 0,
    firstPoisonIdx: results.findIndex(
      (r) => r.loadLocalized || (r.bytes > 0 && r.bytes < 1000 && !r.hasPageData),
    ),
    results,
  };
}

function viable(arm, minOkFrac = 0.75) {
  return Boolean(
    arm && !arm.skipped && arm.poisoned === 0 && arm.pageData >= Math.ceil(arm.n * minOkFrac),
  );
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

  const report = { mode: MODE, n: N, candidates: CANDIDATES.map((c) => c.value.slice(-6)), arms: [] };

  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    });
    await installRoute(ctx, origin);
    const page0 = await ctx.newPage();
    const loginT0 = Date.now();
    await login(page0, secret);
    await warmBsstrt(page0);
    report.loginMs = Date.now() - loginT0;

    if (MODE === 'full') {
      const t0 = Date.now();
      const results = [];
      for (const c of CANDIDATES) results.push(await searchEvaluate(page0, c));
      report.arms.push(summarize('A_serial_evaluate', Date.now() - t0, results));
    }

    if (MODE === 'request_only' || MODE === 'full') {
      const t0 = Date.now();
      const results = await Promise.all(CANDIDATES.map((c) => searchRequest(ctx, origin, c)));
      report.arms.push(summarize('B_concurrent_context_request', Date.now() - t0, results));
    }

    if (MODE === 'serial_only') {
      const t0 = Date.now();
      const results = [];
      for (const c of CANDIDATES) results.push(await searchEvaluate(page0, c));
      report.arms.push(summarize('A_serial_evaluate', Date.now() - t0, results));
    }

    if (MODE === 'full' && process.env.HMS_TAB_PROBE_TABS === '1') {
      const shell = page0.url();
      const tabs = [page0];
      for (let i = 1; i < N; i++) {
        const p = await ctx.newPage();
        await p.goto(shell, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
        await p.waitForTimeout(1500);
        tabs.push(p);
      }
      const t0 = Date.now();
      const results = await Promise.all(tabs.map((p, i) => searchEvaluate(p, CANDIDATES[i])));
      report.arms.push(summarize('C_concurrent_n_tabs_evaluate', Date.now() - t0, results));
    }

    {
      const t0 = Date.now();
      const results = [];
      for (const c of CANDIDATES.slice(0, 2)) results.push(await searchEvaluate(page0, c));
      report.arms.push(summarize('D_serial_after', Date.now() - t0, results));
    }

    const a = report.arms.find((x) => x.label === 'A_serial_evaluate');
    const b = report.arms.find((x) => x.label === 'B_concurrent_context_request');
    const c = report.arms.find((x) => x.label === 'C_concurrent_n_tabs_evaluate');
    report.verdict = {
      serialOk: viable(a, 0.5),
      concurrentRequestViable: viable(b, 0.75),
      concurrentTabsViable: viable(c, 0.75),
      sessionPoisonedAfter: Boolean(
        report.arms.find((x) => x.label === 'D_serial_after' && x.poisoned > 0),
      ),
      speedupRequest:
        viable(b, 0.75) && a && a.wallMs > 0
          ? Math.round((a.wallMs / Math.max(1, b.wallMs)) * 10) / 10
          : null,
    };

    await ctx.close();
  } finally {
    await browser.close().catch(() => undefined);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 240));
  process.exit(1);
});
