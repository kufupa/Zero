import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_MAX_BYTES,
  ATTACH_VERIFIED,
  attachDocument,
  attachOutcome,
  attachRequestAllowed,
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

test('the route guard allows HMS assets and reads on the HMS origin and refuses everything else', () => {
  const guard = (request) => attachRequestAllowed({ origin: ORIGIN, ...request });
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/OSRESV?confirmationnumber=57291630-1`, resourceType: 'document' }), true);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/static/app.js`, resourceType: 'script' }), true);
  assert.equal(guard({ method: 'GET', url: 'https://tracker.example.invalid/pixel', resourceType: 'image' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/OSRESV?action=new`, resourceType: 'fetch' }), false);
  assert.equal(guard({ method: 'GET', url: `${ORIGIN}/web/base/x`, resourceType: 'websocket' }), false);
  assert.equal(guard({ method: 'PUT', url: `${ORIGIN}/web/base/OSRESV.DOC`, resourceType: 'fetch' }), false);
});

test('the route guard allows the documents load and refuses write actions in the path or body', () => {
  const guard = (request) => attachRequestAllowed({ origin: ORIGIN, ...request });
  const documents = `${ORIGIN}/web/base/OSRESV.DOC`;
  assert.equal(guard({ method: 'POST', url: documents, resourceType: 'fetch', postData: '{"action":"OSRESV.DOC.load"}' }), true);
  assert.equal(guard({ method: 'POST', url: documents, resourceType: 'fetch', postData: '{"action":"OSRESV.DOC.insert"}' }), false);
  assert.equal(guard({ method: 'POST', url: documents, resourceType: 'fetch', postData: '{"action":"OSRESV.DOC.update"}' }), false);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/web/base/OSRESV.cancel`, resourceType: 'fetch', postData: '' }), false);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/api/other`, resourceType: 'fetch', postData: '' }), false);
  assert.equal(guard({ method: 'POST', url: 'https://other.example.invalid/web/base/OSRESV.DOC', resourceType: 'fetch', postData: '' }), false);
});

test('the route guard lets the upload through as a multipart body, but not a non-multipart body with a write verb', () => {
  const guard = (request) => attachRequestAllowed({ origin: ORIGIN, ...request });
  const upload = `${ORIGIN}/web/base/BSUPLD.upload?uploadorcreatedoc=U`;
  assert.equal(guard({
    method: 'POST', url: upload, resourceType: 'fetch',
    contentType: 'multipart/form-data; boundary=x', postData: 'the file bytes mention cancel and update',
  }), true);
  assert.equal(guard({ method: 'POST', url: upload, resourceType: 'fetch', contentType: 'text/plain', postData: 'delete' }), false);
  assert.equal(guard({ method: 'POST', url: `${ORIGIN}/web/base/BSUPLD.checkfile`, resourceType: 'fetch', postData: '' }), true);
});

test('attachOutcome lets a refusal stand, reports an unsent upload as execution_failure, and marks a sent but unlisted upload unconfirmed', () => {
  assert.equal(attachOutcome({ refusal: 'refused_not_lab', uploadSent: true, listed: true }), 'refused_not_lab');
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

test('attachDocument refuses while the selectors are unverified and reads nothing from the file', async () => {
  // Fail closed: the flag flips only after U28-H2 captures the Documents selectors on a live Labtest stay.
  assert.equal(ATTACH_VERIFIED, false);
  const parsed = parseAttachArgs(VALID_ARGV);
  const result = await attachDocument(parsed.args, '/tmp/attach-document-test/out');
  assert.deepEqual(result, { outcome: 'refused_unverified', uploadSent: false, screenshots: [], error: null });
});
