import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_MAX_BYTES,
  attachDocument,
  attachOutcome,
  attachRequestAllowed,
  attachRequestDecision,
  attachVerified,
  countListedDocument,
  exitCodeForAttach,
  isPdfBytes,
  isPdfDocumentName,
  parseAttachArgs,
} from './attach-document.mjs';

const ORIGIN = 'https://hms.example.invalid';
const VALID_ARGV = [
  '--confirmation', '57291630-1',
  '--arrival', '2027-09-14',
  '--file', '/tmp/attach-document-test/upload.pdf',
  '--document-name', 'Confirmation.pdf',
  '--out', '/tmp/attach-document-test/out',
];

test('parseAttachArgs accepts a full set and normalizes the confirmation and arrival', () => {
  const parsed = parseAttachArgs(VALID_ARGV);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, {
    confirmation: '57291630-1',
    arrival: '2027-09-14',
    file: '/tmp/attach-document-test/upload.pdf',
    documentName: 'Confirmation.pdf',
    out: '/tmp/attach-document-test/out',
  });
});

test('parseAttachArgs refuses a missing flag, an unknown flag, a repeated flag, and a bad arrival or name', () => {
  const missingOut = VALID_ARGV.slice(0, -2);
  assert.match(parseAttachArgs(missingOut).error, /Required: --out/);
  assert.match(parseAttachArgs([...VALID_ARGV, '--mode', 'commit']).error, /Unknown argument|Missing value/);
  assert.match(parseAttachArgs([...VALID_ARGV, '--file', '/tmp/other.pdf']).error, /Repeated argument/);
  const badArrival = VALID_ARGV.map((value, index) => (VALID_ARGV[index - 1] === '--arrival' ? '2027-02-30' : value));
  assert.equal(parseAttachArgs(badArrival).ok, false);
  const badName = VALID_ARGV.map((value, index) => (VALID_ARGV[index - 1] === '--document-name' ? 'notes.txt' : value));
  assert.equal(parseAttachArgs(badName).ok, false);
});

test('isPdfDocumentName takes a .pdf name and refuses paths, control characters, other types and empty names', () => {
  assert.equal(isPdfDocumentName('Confirmation.pdf'), true);
  assert.equal(isPdfDocumentName('confirmation.PDF'), true);
  assert.equal(isPdfDocumentName('../Confirmation.pdf'), false);
  assert.equal(isPdfDocumentName('dir\\Confirmation.pdf'), false);
  assert.equal(isPdfDocumentName('Confirmation\u0007.pdf'), false);
  assert.equal(isPdfDocumentName('Confirmation.docx'), false);
  assert.equal(isPdfDocumentName(''), false);
});

test('isPdfBytes takes %PDF- bytes under the cap and refuses other magic, empty bytes and oversize bytes', () => {
  assert.equal(isPdfBytes(Buffer.from('%PDF-1.7\n%test')), true);
  assert.equal(isPdfBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isPdfBytes(Buffer.alloc(0)), false);
  assert.equal(isPdfBytes('%PDF-1.7'), false);
  const oversize = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(ATTACH_MAX_BYTES)]);
  assert.equal(isPdfBytes(oversize), false);
});

const CONF = '57291630-1';
const DAE = `39472#${CONF}#HRCEN`;
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
const guard = (request) => attachRequestAllowed({ origin: ORIGIN, confirmation: CONF, contentType: FORM, ...request });
const tabBody = (tab) => new URLSearchParams({
  SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: tab, daeRentity: 'RESV', daeCode: DAE,
}).toString();
const uploadQuery = (overrides = {}) => new URLSearchParams({
  uploadorcreatedoc: 'U', filename: 'Confirmation.pdf', daeRentity: 'RESV', daeCode: DAE,
  requestToken: 'tok', isPopup: 'true', ...overrides,
}).toString();

test('the allowlist takes class A static GETs and the reviewed reads, and nothing else on GET', () => {
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/resources/inforhms/HMS-min.css`, resourceType: 'stylesheet' }), true);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/resources/x.js?v=1`, resourceType: 'script' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/resources/x.json`, resourceType: 'xhr' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/COMMON?REQ_KEY=abc`, resourceType: 'document' }), true);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/logindisp`, resourceType: 'document' }), true);
  // Not on the list, even with no write verb: the allowlist is the control.
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/OSRESV?confirmationnumber=1`, resourceType: 'document' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/static/app.js`, resourceType: 'script' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/OSRESV.DOC?pageaction=SAVE`, resourceType: 'fetch' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/COMMON?action=new`, resourceType: 'document' }), false);
  assert.equal(guard({ method: 'GET', url: 'https://tracker.example.invalid/web/resources/a.png', resourceType: 'image' }), false);
  assert.equal(guard({ method: 'PUT', url: `${ORIGIN}/web/base/OSRESV.DOC`, resourceType: 'fetch' }), false);
});

test('the allowlist takes reviewed read POSTs and class B tab loads naming their own tab', () => {
  const post = (path, postData) => guard({ method: 'POST', url: `${ORIGIN}${path}`, resourceType: 'xhr', postData });
  assert.equal(post('/web/base/OSRESS.search', 'SYSTEM_FUNCTION_NAME=OSRESS&searchtext=57291630-1'), true);
  assert.equal(post('/web/base/OSRESV.HDR', 'SYSTEM_FUNCTION_NAME=OSRESV'), true);
  assert.equal(post('/web/base/OSRESV.DOC', tabBody('DOC')), true);
  assert.equal(post('/web/base/OSRESV.FOL', tabBody('FOL')), true);
  assert.equal(post('/web/base/OSRESV.DOC', tabBody('FOL')), false);
  assert.equal(post('/web/base/OSRESV.XYZ', tabBody('XYZ')), false);
  assert.equal(post('/web/base/OSRESS', 'a=b'), false);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/web/base/OSRESV.HDR`, resourceType: 'xhr', contentType: 'application/json', postData: '{"x":1}' }), false);
  assert.equal(guard({ method: 'POST', url: 'https://other.example.invalid/web/base/OSRESV.DOC', resourceType: 'xhr', postData: tabBody('DOC') }), false);
});

test('Documents save, delete, insert and update are refused in every shape', () => {
  const post = (url, postData = tabBody('DOC')) => attachRequestDecision({
    origin: ORIGIN, confirmation: CONF, contentType: FORM, method: 'POST', url: `${ORIGIN}${url}`, resourceType: 'xhr', postData,
  });
  for (const url of [
    '/web/base/OSRESV.DOC?pageaction=SAVE',
    '/web/base/OSRESV.DOC?pageaction=DELETE',
    '/web/base/OSRESV.DOC?pageaction=LIST',
    '/web/base/OSRESV.DOC.insert',
    '/web/base/OSRESV.DOC.update',
    '/web/base/BSDOCA.validate',
    '/web/base/BSDOCU.getdocument',
  ]) {
    assert.equal(post(url).allowed, false, url);
  }
  assert.equal(post('/web/base/OSRESV.DOC', `${tabBody('DOC')}&pageaction=SAVE`).allowed, false);
  assert.equal(post('/web/base/OSRESV.DOC', `${tabBody('DOC')}&pageaction=DELETE`).allowed, false);
  assert.equal(post('/web/base/OSRESV.DOC', `${tabBody('DOC')}&action=update`).allowed, false);
  assert.equal(post('/web/base/OSRESV', 'SYSTEM_FUNCTION_NAME=OSRESV&pageaction=SAVE').allowed, false);
  assert.equal(post('/web/base/OSRESV.cancel', '').allowed, false);
});

test('the upload chain passes only bound to this confirmation, as multipart from the popup', () => {
  const upload = (query, extra = {}) => attachRequestDecision({
    origin: ORIGIN, confirmation: CONF, method: 'POST', resourceType: 'document',
    url: `${ORIGIN}/web/base/BSUPLD.upload?${query}`,
    contentType: 'multipart/form-data; boundary=x', postData: 'the file bytes mention cancel and update', ...extra,
  });
  assert.deepEqual(upload(uploadQuery()), { allowed: true, rule: 'upload' });
  assert.equal(upload(uploadQuery({ daeCode: '39472#99999999-1#HRCEN' })).allowed, false);
  assert.equal(upload(uploadQuery({ daeRentity: 'GUEST' })).allowed, false);
  assert.equal(upload(uploadQuery({ uploadorcreatedoc: 'C' })).allowed, false);
  assert.equal(upload(uploadQuery({ isPopup: 'false' })).allowed, false);
  assert.equal(upload(uploadQuery({ requestToken: '' })).allowed, false);
  assert.equal(upload(uploadQuery({ pageaction: 'SAVE' })).allowed, false);
  assert.equal(upload(uploadQuery(), { contentType: 'text/plain', postData: 'x' }).allowed, false);
  // The binding may sit in the multipart body instead of the query.
  const body = ['uploadorcreatedoc', 'U', 'daeRentity', 'RESV', 'daeCode', DAE]
    .reduce((out, value, index, all) => (index % 2 ? out : `${out}--x\r\nContent-Disposition: form-data; name="${value}"\r\n\r\n${all[index + 1]}\r\n`), '');
  assert.equal(upload('requestToken=tok&isPopup=true', { postData: body }).allowed, true);
  assert.equal(upload('requestToken=tok&isPopup=true', { postData: body.replace(CONF, '99999999-1') }).allowed, false);

  const check = (fields) => guard({
    method: 'POST', url: `${ORIGIN}/web/base/BSUPLD.checkfile`, resourceType: 'xhr',
    postData: new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'BSUPLD', uploadorcreatedoc: 'U', daeRentity: 'RESV', daeCode: DAE, ...fields }).toString(),
  });
  assert.equal(check({}), true);
  assert.equal(check({ daeCode: '39472#99999999-1#HRCEN' }), false);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/web/base/BSUPLD`, resourceType: 'xhr', postData: 'SYSTEM_FUNCTION_NAME=BSUPLD&pagemode=display' }), true);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/web/base/BSUPLD`, resourceType: 'xhr', postData: 'SYSTEM_FUNCTION_NAME=OSRESV' }), false);
});

test('attachOutcome lets a refusal stand before the upload, and a sent upload is attached only when listed', () => {
  assert.equal(attachOutcome({ refusal: 'refused_not_lab' }), 'refused_not_lab');
  assert.equal(attachOutcome({ refusal: 'refused_request_blocked', uploadSent: true, listed: false }), 'upload_unconfirmed');
  assert.equal(attachOutcome({ uploadSent: false, listed: false }), 'execution_failure');
  assert.equal(attachOutcome({ uploadSent: true, listed: true }), 'attached');
  assert.equal(attachOutcome({ uploadSent: true, listed: false }), 'upload_unconfirmed');
});

test('exitCodeForAttach is 0 for attached, 2 for refusals and not_found, and 1 for anything else', () => {
  assert.equal(exitCodeForAttach('attached'), 0);
  assert.equal(exitCodeForAttach('refused_unverified'), 2);
  assert.equal(exitCodeForAttach('not_found'), 2);
  assert.equal(exitCodeForAttach('upload_unconfirmed'), 1);
});

test('attachDocument refuses unless ATTACH_VERIFIED=true, then refuses a pre-2027 arrival and a non-PDF before any browser work', async () => {
  // Fail closed: only an explicit true arms the driver. H2 sets it for its own run.
  assert.equal(attachVerified({}), false);
  assert.equal(attachVerified({ ATTACH_VERIFIED: '1' }), false);
  assert.equal(attachVerified({ ATTACH_VERIFIED: 'true' }), true);
  const parsed = parseAttachArgs(VALID_ARGV);
  const refused = { uploadSent: false, screenshots: [], error: null };
  assert.deepEqual(await attachDocument(parsed.args, '/tmp/attach-document-test/out', {}), { outcome: 'refused_unverified', ...refused });
  const armed = { ATTACH_VERIFIED: 'true' };
  assert.deepEqual(
    await attachDocument({ ...parsed.args, arrival: '2026-12-31' }, '/tmp/attach-document-test/out', armed),
    { outcome: 'refused_not_lab', ...refused },
  );
  assert.deepEqual(
    await attachDocument({ ...parsed.args, file: '/nonexistent/attach-document-test.pdf' }, '/tmp/attach-document-test/out', armed),
    { outcome: 'refused_file_invalid', ...refused },
  );
});

test('countListedDocument counts Documents rows as the name or "<code>: <name>", and nothing that only contains it', () => {
  const leaf = (text) => ({ childElementCount: 0, textContent: text });
  const rows = [
    leaf('31050: nava-h2-test.pdf'),
    leaf(' nava-h2-test.pdf '),
    leaf('Documents:39519 50231'),
    leaf('old-nava-h2-test.pdf'),
    leaf('x31050: nava-h2-test.pdf'),
    leaf('31050: nava-h2-test.pdf.bak'),
    { childElementCount: 1, textContent: '31050: nava-h2-test.pdf' },
  ];
  globalThis.document = { querySelectorAll: () => rows };
  try {
    assert.equal(countListedDocument('nava-h2-test.pdf'), 2);
    assert.equal(countListedDocument('other.pdf'), 0);
  } finally {
    delete globalThis.document;
  }
});
