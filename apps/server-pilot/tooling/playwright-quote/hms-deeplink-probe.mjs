// HMS record-link probe. Read-only: GET navigations in NEW tabs of the borrowed, already-owned browser context,
// plus DOM reads. No clicks, no fills (the shared login helper is the only form submit), no POST, no save.
// One JSON line per probe on stdout. Credentials, cookies, tokens, URLs and confirmation values are never printed.
// Screenshots can show guest data, so they go to a private run directory under .private/playwright-quote/.
// Normally run by scripts/v8-live-checks.ts (deeplink). Directly:
//   HMS_STAGEHAND_CDP_URL=http://127.0.0.1:<port> HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed \
//   HMS_QUOTE_SECRET_PATH=<secret.json> node hms-deeplink-probe.mjs --property CODE --conf <labtest confirmation> [--stay-id <id>]
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { parseStayProperty } from './property-profile.mjs';
import { lookupActiveProperty, withReadCliPage } from './read-cli-lease.mjs';

export { withReadCliPage as withLeasedReadPage };

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const PRIVATE_QUOTE_ROOT = resolve(REPO_ROOT, '.private/playwright-quote');
const DEFAULT_RUN_ROOT = join(PRIVATE_QUOTE_ROOT, 'deeplink-probe');
const CONFIRMATION = /^\d+-\d+$/;
const STAY_ID = /^\d{1,12}$/;
const FUNCTION_QUERY = 'FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV';
const SHOWN_QUERY_VALUE = /^[A-Z_]{1,40}$/;
const SHOWN_QUERY_KEYS = new Set(['FUNCTION_CLASS', 'USER_FUNCTION_NAME']);
const RECORD_WAIT_MS = 12000;

// Loopback CDP only, with no credentials, query or fragment. Returns the normalised URL or null.
export function loopbackCdpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostOk = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const shapeOk = ['http:', 'ws:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  return hostOk && shapeOk ? url.href : null;
}

// Every probe is a GET. Confirmation and stay id go to HMS only; they are never part of a printed field.
export function probePlan({ origin, conf, stayId = '' }) {
  const enc = encodeURIComponent;
  const plan = [
    ['P0_common_bare', `${origin}/web/base/COMMON`],
    ['P1_logindisp_tenant_logged_in', `${origin}/web/base/logindisp?tenant=HMS_LEGACY`],
    ['P2_osresv_get_no_key', `${origin}/web/base/OSRESV?${FUNCTION_QUERY}`],
    ['P3_osresv_get_confirmation', `${origin}/web/base/OSRESV?${FUNCTION_QUERY}&confirmationnumber=${enc(conf)}`],
    ['P3c_osresv_get_bogus_conf_control', `${origin}/web/base/OSRESV?${FUNCTION_QUERY}&confirmationnumber=ZZPROBE000000`],
  ];
  if (stayId) plan.push(['P4_osresv_get_stayid', `${origin}/web/base/OSRESV?${FUNCTION_QUERY}&reservationstayid=${enc(stayId)}`]);
  plan.push(
    ['P5_osress_get_prefill_param', `${origin}/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS&search=${enc(conf)}`],
    ['P6_osresv_hdr_get_xhr_shape', `${origin}/web/base/OSRESV.HDR?confirmationnumber=${enc(conf)}`],
  );
  return plan;
}

// Query keys only. Only the two function names show a value, and only when it looks like a name. Digit runs in the
// path are replaced as well.
export function shapeOf(url) {
  const parsed = new URL(url);
  const keys = [...parsed.searchParams.keys()].map((key) => {
    const value = parsed.searchParams.get(key) ?? '';
    return SHOWN_QUERY_KEYS.has(key) && SHOWN_QUERY_VALUE.test(value) ? `${key}=${value}` : `${key}=<v>`;
  });
  const path = parsed.pathname.replace(/\/\d[\d-]*/g, '/<n>');
  return path + (keys.length ? `?${keys.join('&')}` : '');
}

// Playwright messages can carry the URL, and with it the confirmation. Keep one line, no URL, no long digit runs.
export function scrubNavError(message) {
  const text = String(message ?? '')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\d{4,}(-\d+)?/g, '<n>')
    .split('\n')[0]
    .slice(0, 120);
  return text === '' ? null : text;
}

// Maps what the page showed to one class. Order matters: a visible record wins over any login or error text.
export function classifyObservation({
  confVisible = false,
  confMatches = false,
  confEmpty = false,
  loginVisible = false,
  onLoginPath = false,
  contentType = '',
  searchVisible = false,
  errorish = false,
} = {}) {
  if (confVisible) {
    if (confMatches) return 'RECORD_OPEN_MATCH';
    return confEmpty ? 'RECORD_OPEN_CONF_UNREAD' : 'RECORD_OPEN_OTHER_CONF';
  }
  if (loginVisible || onLoginPath) return 'LOGIN_BOUNCE';
  if (/json|xml/.test(contentType)) return 'RAW_NON_UI';
  if (searchVisible) return 'SEARCH_ONLY_NO_RECORD';
  if (errorish) return 'ERROR_TEXT';
  return 'SHELL_OR_BLANK';
}

// Runs inside the page. It returns flags and counts. The confirmation value comes back to Node only for comparison.
function snapshotPage() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const conf = [...document.querySelectorAll('input[name="confirmationnumber"]')].find(visible);
  const pwd = [...document.querySelectorAll('input[type="password"], input[name="password"]')].some(visible);
  const search = [
    ...document.querySelectorAll('input[name="search"], input[name="ff_confirmationnumber"], input[placeholder*="Confirmation" i]'),
  ].some(visible);
  const text = (document.body?.innerText ?? '').slice(0, 4000);
  return {
    pwd,
    search,
    confVisible: !!conf,
    confValue: conf ? conf.value : '',
    rows: document.querySelectorAll('.x-grid3-row, .x-grid-row').length,
    contentType: document.contentType,
    errorish: /unable to retrieve|not found|expired|invalid|error/i.test(text),
  };
}

async function observe(page, { id, url, conf, runDir, evidence }) {
  const started = Date.now();
  let response = null;
  let navError = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    navError = scrubNavError(error?.message ?? error);
  }
  let redirects = 0;
  for (let hop = response?.request() ?? null; hop?.redirectedFrom(); hop = hop.redirectedFrom()) redirects += 1;
  let snap = {};
  const deadline = Date.now() + RECORD_WAIT_MS;
  while (Date.now() < deadline) {
    snap = await page.evaluate(snapshotPage).catch(() => ({}));
    if (snap.pwd || snap.confVisible || snap.search) break;
    await page.waitForTimeout(800);
  }
  const klass = classifyObservation({
    confVisible: !!snap.confVisible,
    confMatches: snap.confValue === conf,
    confEmpty: snap.confValue === '',
    loginVisible: !!snap.pwd,
    onLoginPath: /logindisp/.test(page.url()),
    contentType: snap.contentType ?? '',
    searchVisible: !!snap.search,
    errorish: !!snap.errorish,
  });
  await page.screenshot({ path: join(runDir, `${id}.png`) }).catch(() => {});
  return {
    id,
    httpStatus: response ? response.status() : null,
    navError,
    redirects,
    finalPath: shapeOf(page.url()),
    rows: snap.rows ?? null,
    class: klass,
    outcome: navError ? 'navigation_error' : 'observed',
    evidence,
    ms: Date.now() - started,
  };
}

async function makeRunDir(root) {
  const base = resolve(root);
  if (base !== PRIVATE_QUOTE_ROOT && !base.startsWith(`${PRIVATE_QUOTE_ROOT}/`)) {
    throw new Error('OUTPUT_MUST_BE_PRIVATE_PLAYWRIGHT_QUOTE_DIRECTORY');
  }
  const dir = join(base, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Validates everything before the run directory, the secret or the browser is touched.
export async function runDeeplinkProbe({
  env = process.env,
  conf = '',
  stayId = '',
  propertyCode = '',
  runRoot = DEFAULT_RUN_ROOT,
  emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
} = {}) {
  const cdp = loopbackCdpUrl(env.HMS_STAGEHAND_CDP_URL ?? '');
  if (!cdp) throw new Error('LOOPBACK_CDP_REQUIRED');
  if (env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_OWNERSHIP_REQUIRED');
  if (!CONFIRMATION.test(conf)) throw new Error('CONFIRMATION_REQUIRED');
  if (stayId && !STAY_ID.test(stayId)) throw new Error('STAY_ID_INVALID');
  if (!lookupActiveProperty(propertyCode)) throw new Error('PROPERTY_REQUIRED');
  process.umask(0o077);
  const runDir = await makeRunDir(runRoot);
  const evidence = relative(REPO_ROOT, runDir);
  const secret = await readSecret(env);
  const origin = new URL(secret.loginUrl).origin;
  const records = [];
  const browser = await playwright().chromium.connectOverCDP(cdp, { timeout: 20000 });
  let context;
  try {
    // A new context inside the borrowed browser. ignoreHTTPSErrors stays off, like the staff tools.
    context = await newBorrowedContext(browser, { viewport: { width: 1600, height: 1000 } }, env);
    await withReadCliPage({ propertyCode, secret, context, browser, env }, async ({ page: seed }) => {
      await seed.close().catch(() => {});
      for (const [id, url] of probePlan({ origin, conf, stayId })) {
        const page = await context.newPage();
        try {
          const record = await observe(page, { id, url, conf, runDir, evidence });
          records.push(record);
          emit(record);
        } finally {
          await page.close().catch(() => {});
        }
      }
    });
  } finally {
    await context?.close().catch(() => {});
    // Pinned Playwright connectOverCDP closes its transport, not the owner's Chromium (see fetch-quote.mjs).
    await browser.close().catch(() => {});
  }
  return records;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const property = parseStayProperty(args);
  if (!property.ok) {
    console.error(property.error);
    process.exitCode = property.exitCode ?? 2;
  } else {
    runDeeplinkProbe({
      env: process.env,
      conf: argValue(property.rest, '--conf'),
      stayId: argValue(property.rest, '--stay-id'),
      propertyCode: property.propertyCode,
    })
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        console.error(`deeplink probe failed: ${scrubNavError(error?.message ?? error) ?? 'unknown'}`);
        process.exitCode = 2;
      });
  }
}
