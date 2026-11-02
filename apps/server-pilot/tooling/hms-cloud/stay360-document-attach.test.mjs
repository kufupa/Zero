import assert from 'node:assert/strict';
import test from 'node:test';
import { attachLabtestDocument, documentValidationFields, exactDocumentParams, matchesDocumentMultipart,
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
  const parts = fields.map((key) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${values.get(key)}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n${data.toString('latin1')}\r\n`);
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

test('refuses invalid files and contexts before any browser action', async () => {
  assert.deepEqual(await attachLabtestDocument(null, {}, { ...file, name: '../guest.txt' }, { evidenceRoot: '/tmp' }),
    { outcome: 'input_gap', issue: 'DOCUMENT_INPUT_INVALID' });
  assert.deepEqual(await attachLabtestDocument(null, {}, file, { evidenceRoot: '/tmp' }),
    { outcome: 'refused', issue: 'DOCUMENT_PAGE_UNAVAILABLE' });
  const page = { context: () => ({ _options: { serviceWorkers: 'allow' } }) };
  assert.deepEqual(await attachLabtestDocument(page, {}, file, { evidenceRoot: '/tmp' }),
    { outcome: 'refused', issue: 'DOCUMENT_CONTEXT_UNSAFE' });
});
