// Attach one file to an already-open, verified HRCEN Proof Labtest stay.
// A dispatched upload is never retried on this page; reconcile it in a fresh session.
import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readDocumentsFromStay360 } from './stay360-documents.mjs';
import { cleanLabtestRecord, currentLabtestDocumentRecord, currentLabtestRecord, snapshotLabtestRecord } from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const OPEN = '/web/base/BSUPLD', CHECK = '/web/base/BSUPLD.checkfile';
const UPLOAD = '/web/base/BSUPLD.upload', REFRESH = '/web/base/OSRESV.DOC';
const FIELD_NAMES = ['documentcode', 'description', 'organization', 'filename', 'filepath', 'multiorg',
  'typecode', 'uploaddoc', 'pagemode', 'recordid', 'uploadorcreatedoc', 'daeRentity', 'daeType', 'daeCode', 'pages', 'filetype'];
const usedPages = new WeakSet();
const text = (v) => v == null ? '' : String(v);
const scalar = (v) => v == null || ['string', 'number', 'boolean'].includes(typeof v);
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'DOCUMENT_ACTION_FAILED';

// Derive all fields from the staged native model and controls, not a captured stay.
export function documentValidationFields(snapshot) {
  if (!snapshot?.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data) || !Array.isArray(snapshot.fields)) return null;
  const names = Object.keys(snapshot.data);
  if (!names.length || new Set(names.map((name) => name.toLowerCase())).size !== names.length ||
      names.some((name) => !scalar(snapshot.data[name]))) return null;
  const fields = new Map(names.map((name) => [name, text(snapshot.data[name])]));
  const seen = new Set();
  for (const field of snapshot.fields) {
    if (!field?.name || seen.has(field.name.toLowerCase())) return null;
    seen.add(field.name.toLowerCase());
    if (fields.has(field.name) && field.submit != null) {
      if (!scalar(field.submit)) return null;
      fields.set(field.name, text(field.submit));
    }
  }
  if (fields.has('SYSTEM_FUNCTION_NAME') || fields.has('USER_FUNCTION_NAME')) return null;
  fields.set('SYSTEM_FUNCTION_NAME', 'BSUPLD');
  fields.set('USER_FUNCTION_NAME', 'BSUPLD');
  return fields;
}

export function exactDocumentParams(params, expected) {
  const keys = [...params.keys()];
  return expected instanceof Map && keys.length === expected.size && new Set(keys).size === keys.length &&
    keys.every((key) => expected.has(key) && params.get(key) === expected.get(key));
}

export function matchesDocumentMultipart(request, expected, file) {
  try {
    const type = request.headers()['content-type'] || '';
    const match = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(type);
    const boundary = match?.[1] || match?.[2], data = request.postDataBuffer();
    if (!boundary || boundary.length > 70 || !data || data.length > file.bytes.length + 65536) return false;
    const body = data.toString('latin1'), delimiter = `--${boundary}`;
    if (!body.startsWith(`${delimiter}\r\n`) || !body.endsWith(`${delimiter}--\r\n`)) return false;
    const parts = body.slice(delimiter.length + 2, -(delimiter.length + 6)).split(`\r\n${delimiter}\r\n`);
    if (parts.length !== FIELD_NAMES.length + 1) return false;
    const values = new Map(); let fileCount = 0;
    for (const part of parts) {
      const split = part.indexOf('\r\n\r\n');
      if (split < 0 || split > 4096) return false;
      const lines = part.slice(0, split).split('\r\n'), payload = part.slice(split + 4);
      const dispositions = lines.filter((line) => /^content-disposition:/i.test(line));
      if (dispositions.length !== 1) return false;
      const name = /(?:^|;)\s*name="([^"\r\n]+)"/i.exec(dispositions[0])?.[1];
      const filename = /(?:^|;)\s*filename="([^"\r\n]*)"/i.exec(dispositions[0])?.[1];
      if (filename !== undefined) {
        const decodedFilename = Buffer.from(filename, 'latin1').toString('utf8');
        if (name !== 'filename' || decodedFilename !== file.name ||
            Buffer.from(decodedFilename, 'utf8').toString('latin1') !== filename || ++fileCount !== 1 ||
            !Buffer.from(payload, 'latin1').equals(file.bytes) ||
            lines.filter((line) => /^content-type:/i.test(line)).length !== 1 ||
            lines.find((line) => /^content-type:/i.test(line)).slice(13).trim().toLowerCase() !== file.mimeType.toLowerCase()) return false;
      } else {
        if (!FIELD_NAMES.includes(name) || values.has(name) ||
            !Buffer.from(payload, 'latin1').equals(Buffer.from(expected.get(name), 'utf8'))) return false;
        values.set(name, payload);
      }
    }
    return fileCount === 1 && values.size === FIELD_NAMES.length;
  } catch { return false; }
}

export function matchesDocumentUpload(request, frame, expected, file, token) {
  try {
    const url = new URL(request.url()), params = url.searchParams, child = request.frame();
    const queryFields = FIELD_NAMES.filter((name) => name !== 'filetype');
    const keys = [...queryFields, 'requestToken', 'browserTabID', 'isPopup'];
    return request.method() === 'POST' && request.isNavigationRequest() && child.parentFrame() === frame &&
      /^ext-gen\d+$/.test(child.name()) && child.url() === 'about:blank' && url.origin === ORIGIN &&
      url.pathname === UPLOAD && !url.hash && [...params.keys()].length === keys.length &&
      new Set(params.keys()).size === keys.length && [...params.keys()].every((key) => keys.includes(key)) &&
      queryFields.every((name) => params.get(name) === expected.get(name)) &&
      params.get('requestToken') === token.get('requestToken') && params.get('browserTabID') === token.get('browserTabID') &&
      params.get('isPopup') === 'true' && matchesDocumentMultipart(request, expected, file);
  } catch { return false; }
}

/** Hash the exact captured request without storing session tokens or document bytes. */
export function documentUploadRequestDigest(request) {
  try {
    const body = request.postDataBuffer(), contentType = request.headers()['content-type'];
    if (!Buffer.isBuffer(body) || !contentType || request.method() !== 'POST') return null;
    const parts = [Buffer.from(request.method()), Buffer.from(request.url()), Buffer.from(contentType), body];
    const hash = createHash('sha256');
    for (const part of parts) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(part.length));
      hash.update(length).update(part);
    }
    return hash.digest('hex');
  } catch { return null; }
}

// Called only after the lifetime page fence has approved this same Request.
// An intent is exclusive and is written before the one permitted continuation.
export function createDocumentUploadGate({ frame, fields, file, token, evidenceDir, confirmation, onDispatch, onIntentError,
  beforeDispatch, stillArmed = () => true, onAuthorityError = onIntentError, dispatchRequest = (route) => route.continue(),
  dispatchWithAuthority, deadline = Infinity }) {
  let consumed = false, disarmed = false;
  const pending = new Set();
  const track = (result) => {
    if (!result || typeof result.then !== 'function') return result;
    const task = Promise.resolve(result);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  const gate = (route, { candidate, armed, checkStatus, blocked }) => {
    const request = route.request();
    if (disarmed || consumed || request !== candidate || !armed || blocked || checkStatus !== 200 ||
        !matchesDocumentUpload(request, frame, fields, file, token)) return null;
    const requestDigest = documentUploadRequestDigest(request);
    if (!requestDigest) return null;
    consumed = true;
    const dispatch = () => {
      let released = false, continued = false;
      const continueOnce = () => {
        // Even a faulty authority callback cannot send this native request twice.
        if (continued) { onAuthorityError(); return undefined; }
        continued = true;
        if (disarmed || performance.now() >= deadline || !stillArmed()) { onAuthorityError(); return route.abort(); }
        try {
          writeFileSync(join(evidenceDir, 'dispatch-intent.json'), JSON.stringify({ confirmation,
            documentCode: file.documentCode, filename: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex') }),
          { flag: 'wx', mode: 0o600 });
        } catch { onIntentError(); return route.abort(); }
        released = true; onDispatch();
        // Track the actual request even if a faulty authority callback starts
        // it but neglects to await or return its promise.
        return track(dispatchRequest(route));
      };
      if (!dispatchWithAuthority) return continueOnce();
      return Promise.resolve().then(() => dispatchWithAuthority(continueOnce, requestDigest)).catch(() => {
        onAuthorityError();
        // Once released, the outcome is unknown; the browser may already have received a response.
        return released ? undefined : route.abort();
      });
    };
    if (!beforeDispatch) return { result: track(dispatch()) };
    // The server checks its live grant, lease, source and approved bytes while
    // this exact request is paused. A timeout or failed check cannot release it.
    return { result: track(Promise.resolve().then(beforeDispatch).then((allowed) => {
      if (disarmed || allowed !== true || performance.now() >= deadline || !stillArmed()) { onAuthorityError(); return route.abort(); }
      return dispatch();
    }, () => { onAuthorityError(); return route.abort(); })) };
  };
  // A timeout, shutdown or browser close must prevent delayed authority checks
  // from releasing this request. A caller may only use drain as one part of a
  // separate browser-quiescence and fresh-readback proof.
  gate.disarm = () => { disarmed = true; };
  gate.drain = async (timeoutMs = 5000) => {
    if (!disarmed || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
    if (!pending.size) return true;
    let timer;
    const settled = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    // A callback may start another tracked continuation before it settles.
    // A snapshot finishing alone is not proof that the whole gate drained.
    return settled && pending.size === 0;
  };
  return gate;
}

function matchesForm(request, path, frame, expected) {
  try {
    const url = new URL(request.url());
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === path && !url.search && !url.hash &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      exactDocumentParams(new URLSearchParams(request.postData() || ''), expected);
  } catch { return false; }
}

function validFile(file) {
  return file && typeof file === 'object' && typeof file.name === 'string' && file.name.length > 0 &&
    file.name.length <= 150 && file.name === file.name.replace(/\s+/g, ' ').trim() && !/["\\/\p{Cc}]/u.test(file.name) &&
    Buffer.from(file.name, 'utf8').toString('utf8') === file.name &&
    /^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(file.documentCode || '') &&
    typeof file.description === 'string' && file.description.trim() === file.description && file.description.length > 0 &&
    file.description.length <= 200 && ![...file.description].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    typeof file.mimeType === 'string' && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(file.mimeType) &&
    Buffer.isBuffer(file.bytes) && file.bytes.length > 0 && file.bytes.length <= 10 * 1024 * 1024;
}

/** Returns awaiting_readback, uncertain, or not_dispatched. A fresh session must reconcile every dispatch. */
export async function attachLabtestDocument(page, expected, file, { evidenceRoot, expectedOrganization, expectedDocumentContext, timeoutMs = 30000,
  beforeDispatch, finalAuthority, dispatchWithAuthority, onDispatched, strictNetwork = false } = {}) {
  if (!validFile(file) || typeof evidenceRoot !== 'string' || !isAbsolute(evidenceRoot) ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') ||
      (finalAuthority !== undefined && typeof finalAuthority !== 'function') ||
      (dispatchWithAuthority !== undefined && typeof dispatchWithAuthority !== 'function') ||
      (onDispatched !== undefined && typeof onDispatched !== 'function') ||
      (expectedDocumentContext !== undefined && expectedOrganization !== undefined) || typeof strictNetwork !== 'boolean') {
    return { outcome: 'input_gap', issue: 'DOCUMENT_INPUT_INVALID' };
  }
  if (!page || typeof page.context !== 'function' || usedPages.has(page)) return { outcome: 'refused', issue: 'DOCUMENT_PAGE_UNAVAILABLE' };
  file = { ...file, bytes: Buffer.from(file.bytes) };
  try { expected = structuredClone(expected); expectedOrganization = structuredClone(expectedOrganization);
    expectedDocumentContext = structuredClone(expectedDocumentContext); }
  catch { return { outcome: 'input_gap', issue: 'DOCUMENT_INPUT_INVALID' }; }
  const context = page.context();
  if (context?._options?.serviceWorkers !== 'block' || typeof context.serviceWorkers !== 'function' ||
      context.serviceWorkers().length || typeof context.pages !== 'function' || context.pages().length !== 1 ||
      typeof context.routeWebSocket !== 'function') return { outcome: 'refused', issue: 'DOCUMENT_CONTEXT_UNSAFE' };
  usedPages.add(page);
  let frame, fence, scope, refresh, refreshInvalid = false, refreshResponse, initAllowed = false, checkCandidate, uploadCandidate;
  let armed = false, possible = false, dispatched = false, checkStatus = null, uploadStatus = null, refreshCandidate, refreshStatus = null;
  let stopped = null, blocked = 0, evidenceDir = null, token, expectedFields, baseline, uploadGate;
  let notifyResponses;
  const responsesObserved = new Promise((resolve) => { notifyResponses = resolve; });
  let notifyStop;
  const interrupted = new Promise((resolve) => { notifyStop = resolve; });
  const stop = (reason) => { stopped ||= reason; armed = false; uploadGate?.disarm(); fence?.quarantine(); notifyStop(stopped); };
  const rejectRequest = () => { blocked++; if (!possible) stop('DOCUMENT_REQUEST_BLOCKED'); };
  const bounded = async (action) => {
    const result = await Promise.race([Promise.resolve(action).then((value) => ({ value })), interrupted.then((reason) => ({ reason }))]);
    if (result.reason) throw new Error(result.reason);
    return result.value;
  };
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => stop('DOCUMENT_TIMEOUT'), timeoutMs);
  const onDialog = () => stop('UNEXPECTED_DIALOG');
  const onWorker = () => stop('UNEXPECTED_SERVICE_WORKER');
  page.on('dialog', onDialog); context.on('serviceworker', onWorker);
  try {
    const root = await stat(evidenceRoot);
    if (!root.isDirectory() || (root.mode & 0o077)) throw new Error('EVIDENCE_ROOT_UNSAFE');
    evidenceDir = await mkdtemp(join(evidenceRoot, 'hms-document-'));
    const recordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true, ...(expectedOrganization ? { expectedOrganization } : {}) };
    const state = await bounded(expectedDocumentContext !== undefined
      ? currentLabtestDocumentRecord(page, expected, expectedDocumentContext)
      : currentLabtestRecord(page, expected, recordOptions)); frame = state.frame;
    baseline = await bounded(snapshotLabtestRecord(frame));
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_NOT_CLEAN');
    const onRequest = (request) => {
      try {
        const url = new URL(request.url());
        if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== REFRESH || url.search || url.hash) return;
        const params = new URLSearchParams(request.postData() || ''), keys = [...params.keys()];
        if (new Set(keys).size !== keys.length || params.get('CURRENT_TAB_NAME') !== 'DOC' ||
            params.get('confirmationnumber') !== expected.confirmation || params.get('reservationstayid') !== state.native.reservationstayid ||
            params.get('propertycode') !== 'HRCEN' || params.get('daeRentity') !== 'RESV' ||
            params.get('daeCode') !== `${state.native.reservationid}#${expected.confirmation}#HRCEN`) return;
        if (refresh || refreshInvalid) { refreshInvalid = true; return; }
        refresh = { request, body: new Map(params) };
      } catch { /* Treat incomplete request observations as unverified. */ }
    };
    const onResponse = (response) => {
      if (response.request() === refresh?.request) refreshResponse = response.status();
      if (response.request() === checkCandidate) checkStatus = response.status();
      if (response.request() === uploadCandidate) uploadStatus = response.status();
      if (response.request() === refreshCandidate) refreshStatus = response.status();
      if (uploadStatus !== null && refreshStatus !== null) notifyResponses();
    };
    page.on('request', onRequest); page.on('response', onResponse);
    const docs = await bounded(readDocumentsFromStay360(page, expected.confirmation));
    page.off('request', onRequest);
    if (!refresh || refreshInvalid || refreshResponse !== 200 || stopped || docs.documents.some((d) => d.name === file.name || d.documentCode === file.documentCode)) {
      throw new Error('DOCUMENT_BASELINE_UNVERIFIED');
    }
    fence = await bounded(installPageRequestFence(page, [CHECK, UPLOAD])); scope = fence.open();
    await bounded(context.routeWebSocket('**/*', (socket) => socket.close()));
    const init = new Map(Object.entries({ SYSTEM_FUNCTION_NAME: 'BSUPLD', USER_FUNCTION_NAME: 'BSUPLD', popup: 'true',
      pagemode: 'display', callerfunc: 'BSDOCA', organization: '', daeRentity: 'RESV',
      daeCode: `${state.native.reservationid}#${expected.confirmation}#HRCEN` }));
    const sameFrame = (request) => { try { return request.frame() === frame; } catch { return false; } };
    await context.route('**/*', async (route) => {
      const request = route.request(); let url;
      try { url = new URL(request.url()); } catch { rejectRequest(); return route.abort(); }
      if (!stopped && !initAllowed && matchesForm(request, OPEN, frame, init)) {
        initAllowed = true; return strictNetwork ? fulfillGuestLookupRequest(route) : route.fallback();
      }
      if (!stopped && request === checkCandidate && armed && matchesForm(request, CHECK, frame, expectedFields)) {
        return strictNetwork ? fulfillGuestLookupRequest(route) : route.fallback();
      }
      if (!stopped && uploadGate) {
        const release = uploadGate(route, { candidate: uploadCandidate, armed, checkStatus, blocked });
        if (release) return release.result;
      }
      if (!stopped && dispatched && !refreshCandidate && sameFrame(request) && matchesForm(request, REFRESH, frame, refresh.body)) {
        refreshCandidate = request; return route.fallback();
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.origin === ORIGIN &&
          !/save|delete|cancel|send|email|mail|upload|checkin|checkout/i.test(url.pathname) &&
          !shouldAbortReadOnlyRequest({ method: request.method(), url: request.url(), postData: request.postData?.() })) return route.fallback();
      rejectRequest(); return route.abort();
    });
    await page.route('**/*', async (route) => {
      const request = route.request(); let path;
      try { path = new URL(request.url()).pathname; } catch { rejectRequest(); return route.abort(); }
      if ([CHECK.toLowerCase(), UPLOAD.toLowerCase()].includes(path.toLowerCase())) {
        const match = !stopped && armed && (path === CHECK
          ? !checkCandidate && matchesForm(request, CHECK, frame, expectedFields)
          : !uploadCandidate && checkStatus === 200 && matchesDocumentUpload(request, frame, expectedFields, file, token));
        if (match && scope.allow(request)) {
          if (path === CHECK) checkCandidate = request; else uploadCandidate = request;
        } else rejectRequest();
      }
      return route.fallback();
    });
    const open = frame.getByText('Create/Upload Document', { exact: true });
    if (await open.count() !== 1) throw new Error('DOCUMENT_OPEN_NOT_UNIQUE');
    await bounded(open.click({ timeout: 5000 }));
    const popup = frame.locator('.x-window:visible').filter({ hasText: 'Create/Upload Document' });
    await bounded(popup.first().waitFor({ state: 'visible', timeout: 5000 }));
    if (await popup.count() !== 1) throw new Error('DOCUMENT_POPUP_NOT_UNIQUE');
    const code = popup.locator('input[name="documentcode"]'), description = popup.locator('input[name="description"]');
    const input = popup.locator('input[type="file"][name="filename"]');
    await bounded(code.first().waitFor({ state: 'visible', timeout: 5000 }));
    await bounded(description.first().waitFor({ state: 'visible', timeout: 5000 }));
    await bounded(input.first().waitFor({ state: 'attached', timeout: 5000 }));
    if (await code.count() !== 1 || await description.count() !== 1 || await input.count() !== 1) throw new Error('DOCUMENT_FIELDS_NOT_UNIQUE');
    await bounded(code.fill(file.documentCode)); await bounded(description.fill(file.description));
    await bounded(input.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.bytes }));
    const staged = await bounded(frame.evaluate(() => {
      const windows = (globalThis.Ext?.ComponentQuery?.query('window') || []).filter((w) => w.isVisible?.(true) && /Create\/Upload Document/i.test(w.title || ''));
      if (windows.length !== 1) return null;
      const forms = windows[0].query('form');
      if (forms.length !== 1) return null;
      const form = forms[0].getForm?.(), data = forms[0].getRecord?.()?.data, fields = form?.getFields?.()?.items;
      if (!data || !Array.isArray(fields)) return null;
      return { data, fields: fields.map((field) => ({ name: field.getName?.(), submit: field.getSubmitValue?.() })) };
    }));
    expectedFields = documentValidationFields(staged);
    if (!expectedFields || expectedFields.get('documentcode') !== file.documentCode || expectedFields.get('description') !== file.description ||
        expectedFields.get('filename') !== `C:\\fakepath\\${file.name}` || expectedFields.get('organization') !== 'HRCEN' ||
        expectedFields.get('callerorg') !== 'HRCEN' || expectedFields.get('daeRentity') !== 'RESV' ||
        expectedFields.get('daeCode') !== init.get('daeCode') || expectedFields.get('uploaddoc') !== 'U' ||
        expectedFields.get('typecode') !== 'U' || expectedFields.get('uploadorcreatedoc') !== 'U' || stopped || blocked) {
      throw new Error('DOCUMENT_DRAFT_UNVERIFIED');
    }
    token = new URLSearchParams(`requestToken=${await bounded(frame.evaluate(() => EAM.AppData.generateRequestToken()))}`);
    if ([...token.keys()].length !== 2 || token.getAll('requestToken').length !== 1 || token.getAll('browserTabID').length !== 1 ||
        !token.get('requestToken') || !token.get('browserTabID')) throw new Error('DOCUMENT_SESSION_TOKEN_UNVERIFIED');
    uploadGate = createDocumentUploadGate({ frame, fields: expectedFields, file, token, evidenceDir,
      confirmation: expected.confirmation, deadline,
      ...(strictNetwork ? { dispatchRequest: fulfillGuestLookupRequest } : {}),
      ...(dispatchWithAuthority ? { dispatchWithAuthority } : {}),
      onDispatch: () => { possible = true; dispatched = true; armed = false; onDispatched?.(); },
      onIntentError: () => stop('DISPATCH_INTENT_FAILED'),
      beforeDispatch: beforeDispatch && (async () => {
        if (await beforeDispatch() !== true) return false;
        // The record form is hidden on the Documents tab. The server's
        // independent fresh stay read supplies the post-prepare recheck.
        return !finalAuthority || await finalAuthority() === true;
      }),
      stillArmed: () => armed && !stopped && !blocked && checkStatus === 200,
      onAuthorityError: () => stop('DOCUMENT_AUTHORITY_LOST') });
    const before = join(evidenceDir, 'before.png');
    await bounded(writeFile(before, await bounded(page.screenshot({ fullPage: true })), { flag: 'wx', mode: 0o600 }));
    const submit = popup.getByText('Submit', { exact: true });
    if (await submit.count() !== 1 || stopped || blocked) throw new Error('DOCUMENT_SUBMIT_UNVERIFIED');
    armed = true; await bounded(submit.click({ timeout: 5000, noWaitAfter: true }).catch(() => {}));
    // The live approval check includes a fresh independent browser read.
    await bounded(Promise.race([responsesObserved, page.waitForTimeout(beforeDispatch ? 390000 : 10000)]));
    armed = false;
    const after = join(evidenceDir, 'after.png');
    await bounded(writeFile(after, await bounded(page.screenshot({ fullPage: true })), { flag: 'wx', mode: 0o600 }));
    const visibleDialogs = await bounded(frame.locator('.x-window:visible:not(.x-menu)').count());
    armed = false; uploadGate?.disarm();
    const dispatchCallbacksDrained = !uploadGate || await uploadGate.drain();
    return { outcome: dispatched && uploadStatus === 200 && refreshStatus === 200 && !visibleDialogs && !stopped && !blocked
      ? 'awaiting_readback' : possible ? 'uncertain' : 'not_dispatched',
      checkStatus, uploadStatus, refreshStatus, visibleDialogs, blockedRequests: blocked, evidenceDir, screenshots: [before, after],
      dispatchCallbacksDrained, baselineCoverage: docs.coverage };
  } catch (error) {
    armed = false; uploadGate?.disarm();
    const dispatchCallbacksDrained = !uploadGate || await uploadGate.drain();
    return { outcome: possible ? 'uncertain' : 'not_dispatched', issue: stopped || issue(error), checkStatus, uploadStatus, refreshStatus,
      blockedRequests: blocked, evidenceDir, dispatchCallbacksDrained };
  } finally {
    clearTimeout(timer); armed = false; uploadGate?.disarm(); fence?.quarantine(); scope?.close();
    // Keep the page/context fences and dialog watcher until the session closes.
  }
}
