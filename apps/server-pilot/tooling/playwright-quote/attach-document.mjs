#!/usr/bin/env node
// Attach one PDF to a lab Guest Stay (Labtest, arrival on or after 2027-01-01). The flow finds the stay, checks identity
// on the open record, opens Documents, uploads through Create/Upload Document, and reads the document list back.
// Usage: node attach-document.mjs --confirmation 57291630-1 --arrival 2027-09-14 --file <path.pdf> --document-name <name>.pdf --out <dir>
// Exit: 0 attached; 2 refused_* or not_found or usage; 1 any other outcome.
// ATTACH_VERIFIED=true in the environment arms the driver. It is unset everywhere until U28-H2 captures the Documents
// flow on a live Labtest stay, and H2 sets it for its own run only. While it is unset the driver refuses before any
// browser work, so no upload request is sent from an unverified flow.
// The route guard is an explicit allowlist (attachRequestDecision): class A static GETs, the reviewed login, Guest Stay
// search and record-open reads, class B record tab loads, and the BSUPLD upload chain bound to this confirmation.
// Everything else is aborted. A write-verb scan runs on top as a second check.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';
import { findStay, openGuestStay, openRecord, readRecord, shot } from './cancel-stay.mjs';
import { checkCdpEnv, identityCheck, parseIsoDate, preflight, squash } from './cancel-stay-rules.mjs';

// The read path's cap (ARTIFACT_MAX_INPUT_BYTES in src/mail/artifacts/read-artifact.ts). A TS test pins the equality.
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACH_VERIFIED_ENV = 'ATTACH_VERIFIED';

// ponytail: armed per run by env until U28-H2 captures the Documents tab, the upload popup and the list on a live
// Labtest stay. After that the selectors are pinned and this stays an explicit opt-in.
export function attachVerified(env = process.env) {
  return env[ATTACH_VERIFIED_ENV] === 'true';
}

const FLAGS = new Set(['--confirmation', '--arrival', '--file', '--document-name', '--out']);
const CONFIRMATION = /^\d+-\d+$/;
const PDF_MAGIC = Buffer.from('%PDF-');
const UPLOAD_PATH = '/web/base/BSUPLD.upload';
const BLOCKED_LOG_MAX = 20;
// Write verbs in a path or query. A second check on top of the allowlist.
const WRITE_VERB = /\b(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|new|create|submit|autosave)\b/i;
// A form key or value that is exactly a write action. pageaction is the Ext store's SAVE/DELETE switch, so any use of it
// is refused (OSRESV.DOC?pageaction=SAVE and =DELETE).
const WRITE_TOKEN = /^(save|delete|cancel|duplicate|checkin|checkout|insert|update|commit|new|create|submit|autosave|amend|post)$/i;
const MUTATION_KEY = /^(pageaction|autosave)$/i;
// Class A: static resources, as the read-only probe allowed them (no query, not a document or XHR).
const STATIC_PREFIX = '/web/resources/';
const STATIC_EXCLUDED_TYPES = new Set(['xhr', 'fetch', 'document']);
// Reviewed reads the login, Guest Stay search and record open send (src/hms/live-read-manifest.ts, probe 2026-10-10).
const READ_GET_PATHS = new Set([
  '/web/base/logindisp',
  '/web/base/login-all.js',
  '/web/base/COMMON',
  '/web/base/all-classes.js',
  '/web/jsp/interfaceStatusAlert.jsp',
]);
const READ_POST_PATHS = new Set([
  '/web/base/login',
  '/web/base/BSSTRT',
  '/web/base/BSSTRT.HDR',
  '/web/base/OSRESS.search',
  '/web/base/OSRESV',
  '/web/base/OSRESV.HDR',
  '/web/base/OSRESV.LST',
]);
// Class B: one record tab load, POST /web/base/OSRESV.<TAB> naming its own function and tab. OSRESV.DOC.insert and
// .update (the "Add Document" popup) never match, because the path must end at the tab.
const TAB_LOAD = /^\/web\/base\/OSRESV\.([A-Z]{3})$/;
const TABS = new Set(['DOC', 'FOL', 'GST', 'NOT', 'TRC', 'REM', 'RAN', 'PRF', 'TIV']);
const UPLOAD_POPUP_PATH = '/web/base/BSUPLD';
const UPLOAD_CHECK_PATH = '/web/base/BSUPLD.checkfile';

// A file name HMS takes here: a .pdf with no path separator and no control character.
export function isPdfDocumentName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) return false;
  if (/[\\/]/.test(name) || !/\.pdf$/i.test(name)) return false;
  return [...name].every((char) => char.charCodeAt(0) >= 0x20);
}

function refuse(error) {
  return { ok: false, exitCode: 2, error };
}

export function parseAttachArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!FLAGS.has(flag)) return refuse(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || FLAGS.has(value)) return refuse(`Missing value for ${flag}`);
    if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
    values.set(flag, value);
  }
  const missing = [...FLAGS].find((flag) => !values.has(flag));
  if (missing) return refuse(`Required: ${missing}`);
  const confirmation = squash(values.get('--confirmation'));
  if (!CONFIRMATION.test(confirmation)) return refuse('--confirmation must look like 57291630-1');
  const arrival = parseIsoDate(values.get('--arrival'));
  if (!arrival) return refuse('--arrival must be a real calendar date, YYYY-MM-DD');
  const documentName = values.get('--document-name');
  if (!isPdfDocumentName(documentName)) return refuse('--document-name must be a .pdf file name');
  return {
    ok: true,
    exitCode: 0,
    args: { confirmation, arrival, file: values.get('--file'), documentName, out: values.get('--out') },
  };
}

// The %PDF- magic and the size cap, checked on the bytes the run is about to upload.
export function isPdfBytes(body) {
  return Buffer.isBuffer(body)
    && body.byteLength > 0
    && body.byteLength <= ATTACH_MAX_BYTES
    && body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function formMap(text) {
  try {
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

// True when a form key is the store's write switch, or a key or value is exactly a write action.
function formHasWrite(map) {
  for (const [key, value] of map) {
    if (MUTATION_KEY.test(key.trim()) || WRITE_TOKEN.test(key.trim()) || WRITE_TOKEN.test(value.trim())) return true;
  }
  return false;
}

function single(map, key) {
  const values = map.getAll(key);
  return values.length === 1 ? values[0] : null;
}

// The document key HMS binds an upload to: <stayid>#<confirmation>#<property>. Only this run's confirmation passes.
function boundToStay(daeCode, confirmation) {
  const match = /^(\d+)#([^#]+)#([A-Z0-9]+)$/.exec(daeCode ?? '');
  return Boolean(match && CONFIRMATION.test(confirmation) && match[2] === confirmation);
}

// One named text field of a multipart body, for the upload's binding when it is not in the query.
function multipartField(body, name) {
  const match = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`).exec(body);
  return match ? match[1] : null;
}

function uploadFieldsBound(fields, confirmation) {
  return fields.uploadorcreatedoc === 'U'
    && fields.daeRentity === 'RESV'
    && boundToStay(fields.daeCode, confirmation);
}

const ALLOW = (rule) => ({ allowed: true, rule });
const BLOCK = (code) => ({ allowed: false, code });

// The route guard's decision for one request. The allowlist is the control: a request is allowed only when it matches
// one reviewed shape, and every POST shape also passes the write scan. confirmation binds the upload chain to the stay.
export function attachRequestDecision({
  method,
  url,
  resourceType,
  postData = '',
  contentType = '',
  origin,
  confirmation,
}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return BLOCK('url_invalid');
  }
  if (target.origin !== origin) return BLOCK('origin');
  const path = target.pathname;
  const query = target.searchParams;
  const verb = String(method ?? '').toUpperCase();
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const body = postData ?? '';

  if (verb === 'GET' || verb === 'HEAD') {
    if (body !== '') return BLOCK('get_body');
    if (path.startsWith(STATIC_PREFIX)) {
      return target.search === '' && !STATIC_EXCLUDED_TYPES.has(resourceType) ? ALLOW('class_a_static') : BLOCK('static_shape');
    }
    if (!READ_GET_PATHS.has(path)) return BLOCK('path_not_allowed');
    if (WRITE_VERB.test(`${path}${target.search}`) || formHasWrite(query)) return BLOCK('write_verb');
    return ALLOW('reviewed_read_get');
  }
  if (verb !== 'POST') return BLOCK('method');
  if (WRITE_VERB.test(path) || formHasWrite(query)) return BLOCK('write_verb');

  if (path === UPLOAD_PATH) {
    // The one write: a multipart upload, bound to this stay, from the BSUPLD popup.
    if (type !== 'multipart/form-data') return BLOCK('upload_shape');
    if (query.get('isPopup') !== 'true' || !query.get('requestToken')) return BLOCK('upload_shape');
    const field = (name) => query.get(name) ?? multipartField(body, name);
    const fields = {
      uploadorcreatedoc: field('uploadorcreatedoc'),
      daeRentity: field('daeRentity'),
      daeCode: field('daeCode'),
    };
    return uploadFieldsBound(fields, confirmation) ? ALLOW('upload') : BLOCK('upload_binding');
  }

  // Every other POST is an empty or form-encoded body with no write in it.
  if (body !== '' && type !== 'application/x-www-form-urlencoded') return BLOCK('body_format');
  const form = formMap(body);
  if (!form || formHasWrite(form)) return BLOCK('write_verb');

  if (READ_POST_PATHS.has(path)) return ALLOW('reviewed_read_post');
  const tab = TAB_LOAD.exec(path);
  if (tab) {
    if (!TABS.has(tab[1])) return BLOCK('tab_not_allowed');
    return single(form, 'SYSTEM_FUNCTION_NAME') === 'OSRESV' && single(form, 'CURRENT_TAB_NAME') === tab[1]
      ? ALLOW('class_b_tab')
      : BLOCK('tab_shape');
  }
  if (path === UPLOAD_POPUP_PATH) {
    const fn = form.get('SYSTEM_FUNCTION_NAME');
    return fn === null || fn === 'BSUPLD' ? ALLOW('upload_popup') : BLOCK('popup_shape');
  }
  if (path === UPLOAD_CHECK_PATH) {
    const fields = {
      uploadorcreatedoc: single(form, 'uploadorcreatedoc'),
      daeRentity: single(form, 'daeRentity'),
      daeCode: single(form, 'daeCode'),
    };
    return uploadFieldsBound(fields, confirmation) ? ALLOW('upload_checkfile') : BLOCK('checkfile_binding');
  }
  return BLOCK('path_not_allowed');
}

export function attachRequestAllowed(request) {
  return attachRequestDecision(request).allowed;
}

// The outcome of one run. Once the upload request left the browser, the write may have happened, so only a list that
// shows the document is attached, and anything else is unconfirmed (the caller treats it as unknown). Before that, a
// refusal stands as is.
export function attachOutcome({ refusal = null, uploadSent = false, listed = false }) {
  if (uploadSent) return listed ? 'attached' : 'upload_unconfirmed';
  return refusal ?? 'execution_failure';
}

export function exitCodeForAttach(outcome) {
  if (outcome === 'attached') return 0;
  return outcome.startsWith('refused_') || outcome === 'not_found' ? 2 : 1;
}

function refusedResult(outcome) {
  return { outcome, uploadSent: false, screenshots: [], error: null };
}

// The upload form opens either as an Ext window in the page or as a new page. Whichever shows a file input first.
async function openUploadForm(page) {
  const opened = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null);
  // Exact text, so the "Add Document" icon button (OSRESV.DOC.insert/.update) is never the one clicked.
  await page.getByText(/^Create\/Upload Document$/).first().click();
  const inPage = page.locator('.x-window:visible input[type=file]').first()
    .waitFor({ state: 'attached', timeout: 20000 }).then(() => page, () => null);
  return new Promise((resolveForm, rejectForm) => {
    let pending = 2;
    const settle = (form) => {
      if (form) resolveForm(form);
      else if (--pending === 0) rejectForm(new Error('upload_form_not_opened'));
    };
    opened.then(settle);
    inPage.then(settle);
  });
}

// ponytail: the Documents tab and Create/Upload Document were captured live (U28-H2); the upload and list read-back are
// proven only once an H2 run attaches. Only reached once ATTACH_VERIFIED=true.
async function uploadDocument(ctx, args, state) {
  const { page } = ctx;
  await page.getByText(/^Documents$/).first().click();
  await page.waitForTimeout(800);
  const listedName = page.getByText(args.documentName, { exact: true });
  const listedBefore = await listedName.count();
  const form = await openUploadForm(page);
  await form.waitForLoadState('domcontentloaded');
  await shot({ ...ctx, page: form }, 'form.png');
  // In-page, every field is read from the popup window only, never from the record form behind it.
  const popup = form === page
    ? page.locator('.x-window:visible').filter({ has: page.locator('input[type=file]') }).last()
    : form.locator('body');
  // H5: uploadorcreatedoc U (upload) makes filename required; C sends no checkfile and needs a server path. The popup
  // opens without the radio in its params, so U is set the way a click sets it (client-side field states only).
  const radio = await form.evaluate(() => {
    const win = window.Ext?.ComponentQuery?.query('window[itemId=BSUPLD]')[0];
    const upload = win?.down('radio[name=uploadorcreatedoc][inputValue=U]');
    if (!upload) return 'absent';
    if (!upload.getValue()) upload.setValue(true);
    return upload.getValue() ? 'U' : 'unset';
  }).catch(() => 'absent');
  if (radio === 'unset') throw new Error('upload_radio_not_set');
  // H2 live: the form's filename field IS the file input, so the document name is the uploaded file's own name.
  await popup.locator('input[type=file]').first().setInputFiles({
    name: args.documentName,
    mimeType: 'application/pdf',
    buffer: await readFile(args.file),
  });
  // ponytail: description is optional in bsupld_processUpload; filled when the form shows it so the list reads clearly.
  const description = popup.locator('input[name=description]:visible');
  if (await description.count()) await description.first().fill(args.documentName);
  await shot({ ...ctx, page: form }, 'before.png');
  await popup.getByRole('button', { name: /^Upload$/ }).first().click();
  // The route guard sets state.uploadSent when the upload leaves. Listed only when one more row shows the name.
  await page.waitForFunction(
    ({ name, before }) => [...document.querySelectorAll('body *')]
      .filter((el) => el.childElementCount === 0 && el.textContent?.trim() === name).length > before,
    { name: args.documentName, before: listedBefore },
    { timeout: 30000 },
  ).then(() => { state.listed = true; }, () => {});
  await shot(ctx, 'after.png');
}

function routeFacts(request) {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    postData: request.postData() ?? '',
    contentType: request.headers()['content-type'] ?? '',
  };
}

async function attachLive(args, dir) {
  const ctx = {
    args,
    dir,
    result: { quickStages: [], screenshots: [], timings: {} },
    started: Date.now(),
    page: null,
    secret: null,
  };
  const state = { refusal: null, uploadSent: false, listed: false, error: null, blocked: [] };
  let browser = null;
  let context = null;
  try {
    const cdp = checkCdpEnv(process.env);
    if (!cdp.ok) throw new Error(cdp.error);
    ctx.secret = await readSecret();
    const origin = new URL(ctx.secret.loginUrl).origin;
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    // serviceWorkers block: a service worker's requests would not pass through context.route.
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1600, height: 1000 },
    });
    await context.route('**/*', (route) => {
      let decision;
      let facts = null;
      try {
        facts = routeFacts(route.request());
        decision = attachRequestDecision({ ...facts, origin, confirmation: args.confirmation });
      } catch {
        decision = { allowed: false, code: 'guard_failure' };
      }
      if (decision.allowed) {
        if (decision.rule === 'upload') state.uploadSent = true;
        return route.continue();
      }
      if (state.blocked.length < BLOCKED_LOG_MAX) {
        // Method, path and code only: queries and bodies can carry guest data.
        let path = '[unparsed]';
        try {
          path = new URL(facts?.url ?? '').pathname;
        } catch {
          /* keep the placeholder */
        }
        state.blocked.push({ method: facts?.method ?? '?', path, code: decision.code });
      }
      // A blocked non-GET before the upload ends the run: nothing more is clicked on a page that tried to write.
      if (!state.uploadSent && facts?.method !== 'GET' && facts?.method !== 'HEAD') {
        state.refusal ??= 'refused_request_blocked';
        void ctx.page?.close({ runBeforeUnload: false }).catch(() => {});
      }
      return route.abort('blockedbyclient');
    });
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    await login(ctx.page, ctx.secret);
    await openGuestStay(ctx.page);
    await ctx.page.waitForTimeout(1500);
    const found = await findStay(ctx, { evidence: false });
    if (!found) {
      state.refusal ??= 'not_found';
    } else {
      if (found.locator) await openRecord(ctx.page, found.locator);
      const verdict = identityCheck(args, await readRecord(ctx.page));
      if (!verdict.ok) {
        state.refusal ??= verdict.outcome;
      } else if (!state.refusal) {
        await shot(ctx, 'opened.png');
        await uploadDocument(ctx, args, state);
      }
    }
  } catch (error) {
    state.error = squash(error?.message || error).slice(0, 300);
  }
  if (context) await Promise.race([context.close().catch(() => {}), delay(4000)]);
  // The borrowed browser is never closed here. Only disconnect, when the pinned Playwright has it.
  if (browser && typeof browser.disconnect === 'function') browser.disconnect();
  return {
    outcome: attachOutcome(state),
    uploadSent: state.uploadSent,
    listed: state.listed,
    screenshots: ctx.result.screenshots.map((path) => basename(path)),
    blocked: state.blocked,
    error: state.error,
  };
}

// Runs one attach. Nothing is read or opened unless ATTACH_VERIFIED=true, the arrival is a 2027+ lab arrival and the
// file is a PDF under the cap.
export async function attachDocument(args, dir, env = process.env) {
  if (!attachVerified(env)) return refusedResult('refused_unverified');
  const lab = preflight(args);
  if (!lab.ok) return refusedResult(lab.outcome);
  const body = await readFile(args.file).catch(() => null);
  if (!isPdfBytes(body)) return refusedResult('refused_file_invalid');
  return attachLive(args, dir);
}

async function main() {
  const parsed = parseAttachArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return parsed.exitCode;
  }
  const dir = resolve(parsed.args.out);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const result = await attachDocument(parsed.args, dir);
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outcome: result.outcome,
    uploadSent: result.uploadSent,
    resultJson: join(dir, 'result.json'),
  })}\n`);
  return exitCodeForAttach(result.outcome);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.message || error}\n`);
      process.exit(1);
    },
  );
}
