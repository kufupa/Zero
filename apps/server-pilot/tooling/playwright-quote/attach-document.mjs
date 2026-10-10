#!/usr/bin/env node
// Attach one PDF to a lab Guest Stay (Labtest, arrival on or after 2027-01-01). The flow finds the stay, checks identity
// on the open record, opens Documents, uploads through Create/Upload Document, and reads the document list back.
// Usage: node attach-document.mjs --confirmation 57291630-1 --arrival 2027-09-14 --file <path.pdf> --document-name <name>.pdf --out <dir>
// Exit: 0 attached; 2 refused_* or not_found or usage; 1 any other outcome.
// ATTACH_VERIFIED stays false until U28-H2 captures the Documents selectors on a live Labtest stay. While it is false the
// driver refuses before any browser work, so no upload request is sent from an unverified flow.
// The route guard lets through only what attachRequestAllowed names: the HMS origin, /web/base endpoints, no write verb.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';
import { findStay, openGuestStay, openRecord, readRecord, shot } from './cancel-stay.mjs';
import { checkCdpEnv, identityCheck, parseIsoDate, squash } from './cancel-stay-rules.mjs';

// The read path's cap (ARTIFACT_MAX_INPUT_BYTES in src/mail/artifacts/read-artifact.ts). A TS test pins the equality.
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
// ponytail: flip to true only after U28-H2 captures the Documents tab, the upload popup and the list on a live Labtest stay.
export const ATTACH_VERIFIED = false;

const FLAGS = new Set(['--confirmation', '--arrival', '--file', '--document-name', '--out']);
const CONFIRMATION = /^\d+-\d+$/;
const PDF_MAGIC = Buffer.from('%PDF-');
const ASSET_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch']);
const HMS_ENDPOINT = /^\/web\/base\/[A-Za-z0-9._-]+$/;
const UPLOAD_PATH = '/web/base/BSUPLD.upload';
const UPLOAD_PATHS = new Set(['/web/base/BSUPLD.checkfile', UPLOAD_PATH]);
// Write verbs. A URL, or a non-upload body, containing one is refused, so only reads and the upload itself go out.
const WRITE_VERB = /\b(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|new)\b/i;

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

// The route guard's decision for one request. Only the HMS origin. A GET is allowed for page assets and reads whose URL
// holds no write verb. A POST is allowed only to an HMS /web/base endpoint whose path and body hold no write verb. The
// upload is a multipart body, which is not scanned, because the file bytes could match a verb by accident.
export function attachRequestAllowed({ method, url, resourceType, postData = '', contentType = '', origin }) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.origin !== origin) return false;
  const verb = String(method ?? '').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') {
    return ASSET_TYPES.has(resourceType) && !WRITE_VERB.test(`${target.pathname}${target.search}`);
  }
  if (verb !== 'POST' || !HMS_ENDPOINT.test(target.pathname) || WRITE_VERB.test(target.pathname)) return false;
  if (UPLOAD_PATHS.has(target.pathname) && /^multipart\/form-data/i.test(contentType)) return true;
  return !WRITE_VERB.test(postData);
}

// The outcome of one run. A refusal stands as is. Once the upload request left the browser, a list that does not show the
// document is unconfirmed, so the caller treats it as unknown rather than as not written.
export function attachOutcome({ refusal = null, uploadSent = false, listed = false }) {
  if (refusal) return refusal;
  if (!uploadSent) return 'execution_failure';
  return listed ? 'attached' : 'upload_unconfirmed';
}

export function exitCodeForAttach(outcome) {
  if (outcome === 'attached') return 0;
  return outcome.startsWith('refused_') || outcome === 'not_found' ? 2 : 1;
}

function refusedResult(outcome) {
  return { outcome, uploadSent: false, screenshots: [], error: null };
}

// ponytail: the Documents tab, the upload popup and the list are not captured from live HMS yet (U28-H2). Only reached
// once ATTACH_VERIFIED is true.
async function uploadDocument(ctx, args, state) {
  const { page } = ctx;
  await page.getByText(/^Documents$/).first().click();
  await page.waitForTimeout(800);
  const popupOpened = page.context().waitForEvent('page', { timeout: 20000 });
  await page.locator('button[action=upload]:visible').first().click();
  const popup = await popupOpened;
  await popup.waitForLoadState('domcontentloaded');
  await popup.locator('input[type=file]').setInputFiles(args.file);
  await popup.locator('input[name=filename]').fill(args.documentName);
  await shot({ ...ctx, page: popup }, 'before.png');
  await popup.getByRole('button', { name: /^Upload$/ }).click();
  // The popup's upload sets state.uploadSent in the route guard. A list that does not show the name leaves it unlisted.
  await page.getByText(args.documentName, { exact: true }).first().waitFor({ timeout: 30000 })
    .then(() => { state.listed = true; }, () => {});
  await shot(ctx, 'after.png');
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
  const state = { refusal: null, uploadSent: false, listed: false, error: null };
  let browser = null;
  let context = null;
  try {
    const cdp = checkCdpEnv(process.env);
    if (!cdp.ok) throw new Error(cdp.error);
    ctx.secret = await readSecret();
    const origin = new URL(ctx.secret.loginUrl).origin;
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    await context.route('**/*', (route) => {
      const request = route.request();
      const allowed = attachRequestAllowed({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        postData: request.postData() ?? '',
        contentType: request.headers()['content-type'] ?? '',
        origin,
      });
      if (allowed && request.method() === 'POST' && new URL(request.url()).pathname === UPLOAD_PATH) {
        state.uploadSent = true;
      }
      return allowed ? route.continue() : route.abort();
    });
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    await login(ctx.page, ctx.secret);
    await openGuestStay(ctx.page);
    await ctx.page.waitForTimeout(1500);
    const found = await findStay(ctx, { evidence: false });
    if (!found) {
      state.refusal = 'not_found';
    } else {
      if (found.locator) await openRecord(ctx.page, found.locator);
      const verdict = identityCheck(args, await readRecord(ctx.page));
      if (!verdict.ok) {
        state.refusal = verdict.outcome;
      } else {
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
    screenshots: ctx.result.screenshots.map((path) => basename(path)),
    error: state.error,
  };
}

// Runs one attach. Nothing is read or opened while ATTACH_VERIFIED is false.
export async function attachDocument(args, dir) {
  if (!ATTACH_VERIFIED) return refusedResult('refused_unverified');
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
