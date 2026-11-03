import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { currentLabtestRecord } from './labtest-record.mjs';
import { attachLabtestDocument, createDocumentUploadGate, documentUploadRequestDigest, documentValidationFields, exactDocumentParams, matchesDocumentMultipart,
  matchesDocumentUpload } from './stay360-document-attach.mjs';

const fields = ['documentcode', 'description', 'organization', 'filename', 'filepath', 'multiorg', 'typecode',
  'uploaddoc', 'pagemode', 'recordid', 'uploadorcreatedoc', 'daeRentity', 'daeType', 'daeCode', 'pages', 'filetype'];
const file = { name: 'synthetic.txt', documentCode: 'NAVA123', description: 'Synthetic only',
  mimeType: 'text/plain', bytes: Buffer.from('synthetic test bytes\n') };
const payload = new Map(fields.map((name) => [name, '']));
for (const [key, value] of Object.entries({ documentcode: file.documentCode, description: file.description,
  organization: 'HRCEN', filename: `C:\\fakepath\\${file.name}`, typecode: 'U', uploaddoc: 'U',
  uploadorcreatedoc: 'U', daeRentity: 'RESV', daeCode: '123#456-1#HRCEN' })) payload.set(key, value);
const frame = {};
const child = { parentFrame: () => frame, name: () => 'ext-gen1234', url: () => 'about:blank' };
const token = new URLSearchParams({ requestToken: 'session-token', browserTabID: '1' });

function multipart(values = payload, data = file.bytes, name = file.name, contentType = file.mimeType) {
  const boundary = 'test-boundary';
  const parts = fields.map((key) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${Buffer.from(values.get(key), 'utf8').toString('latin1')}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${Buffer.from(name, 'utf8').toString('latin1')}"\r\nContent-Type: ${contentType}\r\n\r\n${data.toString('latin1')}\r\n`);
  return { body: Buffer.from(parts.join('') + `--${boundary}--\r\n`, 'latin1'),
    contentType: `multipart/form-data; boundary=${boundary}` };
}
function upload(overrides = {}) {
  const query = new URLSearchParams();
  for (const key of fields.filter((key) => key !== 'filetype')) query.set(key, payload.get(key));
  query.set('requestToken', token.get('requestToken')); query.set('browserTabID', '1'); query.set('isPopup', 'true');
  overrides.query?.(query);
  const part = multipart(overrides.values, overrides.bytes, overrides.filename, overrides.mimeType);
  return { method: () => overrides.method || 'POST', isNavigationRequest: () => overrides.navigation ?? true,
    frame: () => overrides.frame || child, url: () => `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/BSUPLD.upload?${query}`,
    headers: () => ({ 'content-type': overrides.contentType || part.contentType }), postDataBuffer: () => part.body };
}

test('native validation fields use the model and each staged submit value', () => {
  const snapshot = { data: { code: '', count: 0, checked: false, nullable: null },
    fields: [{ name: 'code', submit: 'STAGED' }, { name: 'count', submit: null }] };
  const value = documentValidationFields(snapshot);
  assert.deepEqual([...value], [['code', 'STAGED'], ['count', '0'], ['checked', 'false'], ['nullable', ''],
    ['SYSTEM_FUNCTION_NAME', 'BSUPLD'], ['USER_FUNCTION_NAME', 'BSUPLD']]);
  assert.equal(documentValidationFields({ ...snapshot, fields: [{ name: 'code' }, { name: 'CODE' }] }), null);
  assert.equal(documentValidationFields({ data: { code: {}, CODE: '' }, fields: [] }), null);
  assert.equal(documentValidationFields({ data: { code: '' }, fields: [{ name: 'code', submit: {} }] }), null);
  assert.equal(documentValidationFields({ data: { SYSTEM_FUNCTION_NAME: 'X' }, fields: [] }), null);
});

test('form matching rejects duplicates, unexpected keys and changed values', () => {
  const expected = new Map([['a', '1'], ['b', '2']]);
  assert.equal(exactDocumentParams(new URLSearchParams('a=1&b=2'), expected), true);
  for (const value of ['a=1&b=2&b=2', 'a=1&c=2', 'a=1&b=3', 'a=1']) {
    assert.equal(exactDocumentParams(new URLSearchParams(value), expected), false);
  }
});

test('multipart and query bind the current frame, target, token, name and exact bytes', () => {
  assert.equal(matchesDocumentMultipart(upload(), payload, file), true);
  assert.equal(matchesDocumentUpload(upload(), frame, payload, file, token), true);
  for (const request of [
    upload({ bytes: Buffer.from('other') }), upload({ filename: 'other.txt' }),
    upload({ mimeType: 'application/pdf' }), upload({ method: 'GET' }), upload({ navigation: false }),
    upload({ frame: { ...child, parentFrame: () => ({}) } }),
    upload({ frame: { ...child, url: () => 'https://example.invalid' } }),
    upload({ query: (q) => q.set('requestToken', 'other') }),
    upload({ query: (q) => q.set('browserTabID', '2') }),
    upload({ query: (q) => q.set('daeCode', 'other#stay#HRCEN') }),
    upload({ query: (q) => q.append('daeCode', q.get('daeCode')) }),
    upload({ query: (q) => q.set('unreviewed', 'true') }),
    upload({ contentType: 'multipart/form-data' }),
  ]) assert.equal(matchesDocumentUpload(request, frame, payload, file, token), false);
});

test('dispatch digest binds target, content type and the exact multipart bytes', () => {
  const original = documentUploadRequestDigest(upload());
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(documentUploadRequestDigest(upload()), original);
  for (const request of [upload({ bytes: Buffer.from('changed') }),
    upload({ query: (q) => q.set('requestToken', 'changed') }), upload({ contentType: 'multipart/form-data; boundary=changed' })]) {
    assert.notEqual(documentUploadRequestDigest(request), original);
  }
  assert.equal(documentUploadRequestDigest(upload({ method: 'GET' })), null);
});

test('exact upload bytes may contain text that resembles a form action', () => {
  const bytes = Buffer.from('Synthetic &pageaction=SAVE& bytes');
  const request = upload({ bytes });
  assert.equal(matchesDocumentUpload(request, frame, payload, { ...file, bytes }, token), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: request.method(), url: request.url(),
    postData: request.postDataBuffer().toString('utf8') }), true);
});

test('upload gate releases only the exact candidate once, after exclusive intent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
  try {
    let dispatched = 0, failed = 0, continued = 0, aborted = 0;
    const bytes = Buffer.from('Synthetic &pageaction=SAVE& bytes'), gatedFile = { ...file, bytes };
    const gate = createDocumentUploadGate({ frame, fields: payload, file: gatedFile, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => { failed++; } });
    const request = upload({ bytes });
    const route = (req) => ({ request: () => req, continue: () => {
      const intent = JSON.parse(readFileSync(join(dir, 'dispatch-intent.json'), 'utf8'));
      assert.equal(intent.confirmation, '456-1'); assert.equal(intent.documentCode, file.documentCode);
      assert.equal(intent.filename, file.name); assert.equal(intent.sha256, createHash('sha256').update(bytes).digest('hex'));
      continued++; return 'continued';
    }, abort: () => { aborted++; return 'aborted'; } });
    const ready = { candidate: request, armed: true, checkStatus: 200 };
    assert.equal(gate(route(request), { ...ready, candidate: upload({ bytes }) }), null);
    assert.equal(gate(route(request), { ...ready, armed: false }), null);
    assert.equal(gate(route(request), { ...ready, checkStatus: 500 }), null);
    assert.equal(gate(route(request), { ...ready, blocked: 1 }), null);
    for (const altered of [
      upload({ bytes, frame: { ...child, parentFrame: () => ({}) } }),
      upload({ bytes, query: q => q.set('requestToken', 'different') }),
      upload({ bytes, query: q => q.set('browserTabID', 'different') }),
      upload({ bytes, query: q => q.set('daeCode', 'different') }),
      upload({ bytes, values: new Map([...payload, ['description', 'different']]) }),
      upload({ bytes: Buffer.from('different') }),
      upload({ bytes, filename: 'different.txt' }),
    ]) assert.equal(gate(route(altered), { ...ready, candidate: altered }), null);
    assert.equal(gate(route(request), ready).result, 'continued');
    assert.equal(gate(route(request), ready), null);
    assert.equal(dispatched, 1); assert.equal(continued, 1); assert.equal(failed, 0); assert.equal(aborted, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict dispatch sends once without following an upload redirect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
  try {
    let dispatched = 0, sent = 0, aborted = 0;
    const { fulfillGuestLookupRequest } = await import('./pane-guest-search.mjs');
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => assert.fail('intent failed'),
      dispatchRequest: fulfillGuestLookupRequest });
    const request = upload(), route = { request: () => request,
      fetch: async (options) => { sent++; assert.equal(options.maxRedirects, 0); assert.equal(options.maxRetries, 0);
        return { status: () => 307 }; },
      abort: () => { aborted++; return 'aborted'; }, fulfill: () => assert.fail('redirect was fulfilled') };
    const ready = { candidate: request, armed: true, checkStatus: 200 };
    assert.equal(await gate(route, ready).result, 'aborted');
    assert.equal(gate(route, ready), null);
    assert.equal(dispatched, 1); assert.equal(sent, 1); assert.equal(aborted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native upload stays paused inside dispatch authority and never resumes after expiry', async () => {
  for (const scenario of ['allow', 'deny', 'expired', 'commit-failed']) {
    const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
    try {
      let entered, release, armed = true, sent = 0, aborted = 0, dispatched = 0, authorityErrors = 0;
      const started = new Promise((resolve) => { entered = resolve; });
      const readyToContinue = new Promise((resolve) => { release = resolve; });
      const request = upload(), route = { request: () => request,
        continue: () => { sent++; return 'continued'; }, abort: () => { aborted++; return 'aborted'; } };
      const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
        confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => assert.fail('intent failed'),
        stillArmed: () => armed, onAuthorityError: () => { authorityErrors++; },
        dispatchWithAuthority: async (continueOnce) => {
          entered(); await readyToContinue;
          if (scenario === 'deny') throw new Error('authority revoked');
          const result = await continueOnce();
          if (scenario === 'commit-failed') throw new Error('transaction commit failed');
          return result;
        } });
      const ready = { candidate: request, armed: true, checkStatus: 200 };
      const pending = gate(route, ready).result;
      await started; assert.equal(sent, 0); assert.equal(gate(route, ready), null);
      if (scenario === 'expired') armed = false;
      release();
      assert.equal(await pending, scenario === 'allow' ? 'continued' : scenario === 'commit-failed' ? undefined : 'aborted');
      assert.equal(sent, ['allow', 'commit-failed'].includes(scenario) ? 1 : 0);
      assert.equal(dispatched, sent);
      assert.equal(aborted, ['deny', 'expired'].includes(scenario) ? 1 : 0);
      assert.equal(authorityErrors, scenario === 'allow' ? 0 : 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a delayed timeout callback cannot release an upload past its monotonic deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-deadline-test-'));
  try {
    let enter, release, sent = 0, aborted = 0;
    const entered = new Promise((resolve) => { enter = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const request = upload(), route = { request: () => request,
      continue: () => { sent++; return 'continued'; }, abort: () => { aborted++; return 'aborted'; } };
    const deadline = performance.now() + 20;
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir, deadline,
      confirmation: '456-1', onDispatch: () => {}, onIntentError: () => {}, onAuthorityError: () => {},
      stillArmed: () => true, dispatchWithAuthority: async (next) => { enter(); await waiting; return next(); } });
    const pending = gate(route, { candidate: request, armed: true, checkStatus: 200 }).result;
    await entered;
    while (performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    assert.equal(await pending, 'aborted');
    assert.equal(sent, 0); assert.equal(aborted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the final continuation fails closed when its completion budget expires or is unreadable', async () => {
  for (const scenario of ['expired', 'throws']) {
    const dir = mkdtempSync(join(tmpdir(), 'document-finish-budget-'));
    try {
      let sent = 0, aborted = 0, armed = true;
      const request = upload(), route = { request: () => request,
        continue: () => { sent++; return 'continued'; }, abort: () => { aborted++; return 'aborted'; } };
      const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
        confirmation: '456-1', onDispatch: () => assert.fail('must not dispatch'), onIntentError: () => {},
        onAuthorityError: () => {}, continuationAllowed: () => {
          if (scenario === 'throws') throw new Error('deadline unavailable');
          return armed;
        }, dispatchWithAuthority: async (next) => { armed = false; return next(); } });
      assert.equal(await gate(route, { candidate: request, armed: true, checkStatus: 200 }).result, 'aborted');
      assert.equal(sent, 0); assert.equal(aborted, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an authority callback cannot continue the same upload twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
  try {
    let sent = 0, authorityErrors = 0;
    const request = upload(), route = { request: () => request,
      continue: () => { sent++; return 'continued'; }, abort: () => 'aborted' };
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => {}, onIntentError: () => assert.fail('intent failed'),
      onAuthorityError: () => { authorityErrors++; }, dispatchWithAuthority: async (proceed) => {
        assert.equal(await proceed(), 'continued');
        assert.equal(await proceed(), undefined);
        return 'done';
      } });
    assert.equal(await gate(route, { candidate: request, armed: true, checkStatus: 200 }).result, 'done');
    assert.equal(sent, 1); assert.equal(authorityErrors, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disarm drains a pending authority callback and prevents a late upload', async () => {
  for (const phase of ['before', 'authority']) {
    const dir = mkdtempSync(join(tmpdir(), 'document-drain-test-'));
    try {
      let enter, release, sent = 0, aborted = 0;
      const entered = new Promise((resolve) => { enter = resolve; });
      const waiting = new Promise((resolve) => { release = resolve; });
      const request = upload(), route = { request: () => request,
        continue: () => { sent++; return 'continued'; }, abort: () => { aborted++; return 'aborted'; } };
      const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
        confirmation: '456-1', onDispatch: () => {}, onIntentError: () => {}, onAuthorityError: () => {},
        ...(phase === 'before' ? { beforeDispatch: async () => { enter(); await waiting; return true; } }
          : { dispatchWithAuthority: async (next) => { enter(); await waiting; return next(); } }) });
      const pending = gate(route, { candidate: request, armed: true, checkStatus: 200 }).result;
      await entered;
      assert.equal(await gate.drain(5), false); // Disarm is required first.
      gate.disarm();
      assert.equal(await gate.drain(5), false); // A stalled callback is not quiescent.
      assert.equal(gate(route, { candidate: request, armed: true, checkStatus: 200 }), null);
      release();
      assert.equal(await pending, 'aborted');
      assert.equal(await gate.drain(100), true);
      assert.equal(sent, 0); assert.equal(aborted, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('drain waits for the native request even if authority fails to await it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-drain-test-'));
  try {
    let release, sent = 0;
    const network = new Promise((resolve) => { release = resolve; });
    const request = upload(), route = { request: () => request,
      continue: () => { sent++; return network; }, abort: () => 'aborted' };
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => {}, onIntentError: () => {},
      dispatchWithAuthority: (next) => { void next(); return 'callback-finished'; } });
    assert.equal(await gate(route, { candidate: request, armed: true, checkStatus: 200 }).result, 'callback-finished');
    gate.disarm();
    assert.equal(await gate.drain(5), false);
    release('sent');
    assert.equal(await gate.drain(100), true);
    assert.equal(sent, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('page fence blocks unapproved and quarantined uploads before the release gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
  try {
    let pageRoute, continued = 0, aborted = 0, dispatched = 0;
    const page = { route: async (_pattern, handler) => { pageRoute = handler; } };
    const fence = await installPageRequestFence(page, ['/web/base/BSUPLD.upload']);
    const scope = fence.open(), request = upload();
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => assert.fail('intent failed') });
    const route = { request: () => request, abort: () => { aborted++; return 'aborted'; },
      continue: () => { continued++; return 'continued'; },
      fallback: () => gate(route, { candidate: request, armed: true, checkStatus: 200 })?.result };
    assert.equal(await pageRoute(route), 'aborted');
    assert.equal(scope.allow(request), true);
    assert.equal(await pageRoute(route), 'continued');
    fence.quarantine();
    assert.equal(scope.allow(request), false);
    assert.equal(await pageRoute(route), 'aborted');
    assert.equal(dispatched, 1); assert.equal(continued, 1); assert.equal(aborted, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upload gate aborts if exclusive dispatch intent already exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-gate-test-'));
  try {
    const path = join(dir, 'dispatch-intent.json'); writeFileSync(path, 'existing');
    let dispatched = 0, failed = 0, continued = 0, aborted = 0;
    const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
      confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => { failed++; } });
    const request = upload(), route = { request: () => request, continue: () => { continued++; },
      abort: () => { aborted++; return 'aborted'; } };
    const ready = { candidate: request, armed: true, checkStatus: 200 };
    assert.equal(gate(route, ready).result, 'aborted'); assert.equal(gate(route, ready), null);
    assert.equal(readFileSync(path, 'utf8'), 'existing');
    assert.equal(dispatched, 0); assert.equal(continued, 0); assert.equal(failed, 1); assert.equal(aborted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multipart compares UTF-8 field bytes without accepting a changed description', () => {
  const description = 'Café booking';
  const values = new Map(payload); values.set('description', description);
  const unicodeFile = { ...file, description };
  const request = upload({ values, query: (q) => q.set('description', description) });
  assert.equal(matchesDocumentUpload(request, frame, values, unicodeFile, token), true);
  const tampered = new Map(values); tampered.set('description', 'Cafe booking');
  assert.equal(matchesDocumentUpload(upload({ values: tampered, query: (q) => q.set('description', description) }),
    frame, values, unicodeFile, token), false);
});

test('multipart compares an exact UTF-8 filename', () => {
  const name = "Café O'Neil [voucher].pdf";
  const values = new Map(payload); values.set('filename', `C:\\fakepath\\${name}`);
  const request = upload({ filename: name, values, query: (q) => q.set('filename', values.get('filename')) });
  assert.equal(matchesDocumentUpload(request, frame, values, { ...file, name }, token), true);
  assert.equal(matchesDocumentUpload(request, frame, values, { ...file, name: 'Cafe voucher.pdf' }, token), false);
});

test('the upload stays paused until authority is confirmed and aborts if authority is lost', async () => {
  for (const scenario of ['allow', 'deny', 'timeout', 'throw']) {
    const dir = mkdtempSync(join(tmpdir(), 'document-authority-test-'));
    try {
      let release, armed = true, continued = 0, aborted = 0, dispatched = 0, authorityErrors = 0;
      const check = new Promise((resolve, reject) => { release = scenario === 'throw' ? () => reject(new Error('lost')) : resolve; });
      const gate = createDocumentUploadGate({ frame, fields: payload, file, token, evidenceDir: dir,
        confirmation: '456-1', onDispatch: () => { dispatched++; }, onIntentError: () => assert.fail('intent failed'),
        beforeDispatch: () => check, stillArmed: () => armed, onAuthorityError: () => { authorityErrors++; } });
      const request = upload(), route = { request: () => request, continue: () => { continued++; return 'continued'; },
        abort: () => { aborted++; return 'aborted'; } };
      const ready = { candidate: request, armed: true, checkStatus: 200 };
      const pending = gate(route, ready).result;
      assert.equal(continued, 0);
      assert.equal(gate(route, ready), null);
      if (scenario === 'timeout') armed = false;
      release(scenario === 'allow' || scenario === 'timeout');
      assert.equal(await pending, scenario === 'allow' ? 'continued' : 'aborted');
      assert.equal(continued, scenario === 'allow' ? 1 : 0);
      assert.equal(dispatched, continued);
      assert.equal(aborted, scenario === 'allow' ? 0 : 1);
      assert.equal(authorityErrors, aborted);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('multipart fields cannot diverge from the validated form or repeat a field', () => {
  const changed = new Map(payload);
  changed.set('daeCode', 'other#stay#HRCEN');
  assert.equal(matchesDocumentUpload(upload({ values: changed }), frame, payload, file, token), false);
  const original = upload(), body = original.postDataBuffer().toString('latin1');
  const duplicate = { ...original, postDataBuffer: () => Buffer.from(body.replace('name="pages"', 'name="daeCode"'), 'latin1') };
  const truncated = { ...original, postDataBuffer: () => Buffer.from(body.slice(0, -8), 'latin1') };
  assert.equal(matchesDocumentUpload(duplicate, frame, payload, file, token), false);
  assert.equal(matchesDocumentUpload(truncated, frame, payload, file, token), false);
});

test('explicit blank note can be verified but an omitted note is refused', async () => {
  const page = { url: () => 'https://invalid.example', title: async () => '' };
  const expected = { confirmation: '123456-1', guestId: '123', arrival: '2027-10-12', departure: '2027-10-13',
    roomType: 'STQN', ratePlan: 'BAR', note: '' };
  await assert.rejects(currentLabtestRecord(page, expected, { allowBlankNote: true }), /PROPERTY_OR_ORIGIN_MISMATCH/);
  await assert.rejects(currentLabtestRecord(page, { ...expected, note: undefined }, { allowBlankNote: true }),
    /LABTEST_RECORD_INPUT_INVALID/);
  await assert.rejects(currentLabtestRecord(page, expected), /LABTEST_RECORD_INPUT_INVALID/);
});

test('refuses invalid files and contexts before any browser action', async () => {
  assert.deepEqual(await attachLabtestDocument(null, {}, { ...file, name: '../guest.txt' }, { evidenceRoot: '/tmp' }),
    { outcome: 'input_gap', issue: 'DOCUMENT_INPUT_INVALID' });
  for (const name of ['Proof  Labtest.pdf', ' Proof Labtest.pdf', 'Proof\u00a0Labtest.pdf']) {
    assert.deepEqual(await attachLabtestDocument(null, {}, { ...file, name }, { evidenceRoot: '/tmp' }),
      { outcome: 'input_gap', issue: 'DOCUMENT_INPUT_INVALID' });
  }
  assert.deepEqual(await attachLabtestDocument(null, {}, file, { evidenceRoot: '/tmp' }),
    { outcome: 'refused', issue: 'DOCUMENT_PAGE_UNAVAILABLE' });
  const page = { context: () => ({ _options: { serviceWorkers: 'allow' } }) };
  assert.deepEqual(await attachLabtestDocument(page, {}, file, { evidenceRoot: '/tmp' }),
    { outcome: 'refused', issue: 'DOCUMENT_CONTEXT_UNSAFE' });
  const incomplete = { context: () => ({ _options: { serviceWorkers: 'block' } }) };
  assert.deepEqual(await attachLabtestDocument(incomplete, {}, file, { evidenceRoot: '/tmp' }),
    { outcome: 'refused', issue: 'DOCUMENT_CONTEXT_UNSAFE' });
});
