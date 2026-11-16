import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approvedDocumentDispatch, approvedLabtestRecord, documentCodeForUuid, filingSnapshot, hasUniqueDocumentListing,
  provePositiveAttachRecovery, runCloudPaneAttach } from './pane-attach-session.mjs';

const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1', guestId: '123', firstName: 'Proof',
  lastName: 'Labtest', status: 'Reserved', guaranteeCode: 'NGI', arrival: '2027-10-12', departure: '2027-10-13',
  roomType: 'STQN', ratePlan: 'BAR', reservationStayId: '42', reservationId: '41' };
const record = { nativePreimage: native, details: { fields: [{ name: 'reservationnote', rawValue: '' },
  { name: 'udfchar13', value: '' }, { name: 'udfchkbox04', value: false }, { name: 'emailaddress', value: '' },
  { name: 'company', value: '' }, { name: 'ta1', value: '' }] } };
const stay = { ...native, nativeGuestId: native.guestId, nativeStayId: native.reservationStayId,
  organization: null, bookingAgency: null };
const snapshot = { cmsSend: false };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const writer = { host: 'b'.repeat(64), bootId: randomUUID(), pidNamespace: 'pid:[1]',
  node: { pid: 100, started: '10' }, browser: { pid: 200, started: '20' } };

test('30-character document codes preserve every UUID bit', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const samples = ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '12345678-9abc-4def-8abc-1234567890ab', ...Array.from({ length: 256 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`)];
  const codes = samples.map(documentCodeForUuid);
  assert.equal(new Set(codes).size, samples.length);
  for (const [index, code] of codes.entries()) {
    assert.match(code, /^NAVA[A-Z2-7]{25}[AEIMQUY4]$/);
    let bits = 0n;
    for (const char of code.slice(4)) bits = (bits << 5n) | BigInt(alphabet.indexOf(char));
    assert.equal(bits & 3n, 0n);
    assert.equal((bits >> 2n).toString(16).padStart(32, '0'), samples[index].replaceAll('-', ''));
  }
  for (const bad of ['', 'not-a-uuid', '00000000-0000-0000-0000-00000000000g']) {
    assert.throws(() => documentCodeForUuid(bad), /DOCUMENT_UUID_INVALID/);
  }
});

async function nativeScreenshots(root) {
  const evidenceDir = await mkdtemp(join(root, 'hms-document-'));
  const before = join(evidenceDir, 'before.png');
  const after = join(evidenceDir, 'after.png');
  await writeFile(before, png); await writeFile(after, png);
  return { evidenceDir, screenshots: [before, after] };
}

test('the selected fake booking matches property, guest and approved dates', () => {
  assert.deepEqual(filingSnapshot(record, stay), snapshot);
  assert.deepEqual(approvedLabtestRecord(record, stay), { propertyCode: native.propertyCode, confirmation: native.confirmation, guestId: native.guestId,
    nativeStayId: native.reservationStayId, firstName: native.firstName, lastName: native.lastName,
    status: native.status, allowRealGuest: false,
    arrival: native.arrival, departure: native.departure });
  for (const changed of [{ propertyCode: 'OTHER' }, { firstName: 'Real' }, { lastName: 'Other' },
    { status: 'Cancelled' }, { arrival: '2026-12-31' }, { arrival: '2027-02-30' },
    { departure: '2027-10-14' }, { confirmation: '999-1' }]) {
    assert.equal(approvedLabtestRecord({ ...record, nativePreimage: { ...native, ...changed } }, stay), null);
  }
  assert.ok(approvedLabtestRecord({ nativePreimage: { ...native, guestId: '' } }, stay));
});

test('the separate upload guard binds the native guest and no-send setting', () => {
  assert.ok(approvedDocumentDispatch(record, stay, snapshot));
  for (const guestId of ['', '124', '12x', 123]) {
    assert.equal(approvedDocumentDispatch({ ...record, nativePreimage: { ...native, guestId } }, stay, snapshot), null);
  }
  assert.equal(approvedDocumentDispatch({ ...record, details: { fields: [] } }, stay, snapshot), null);
  assert.equal(approvedDocumentDispatch({ ...record, details: { fields: [...record.details.fields, ...record.details.fields] } }, stay, snapshot), null);
  assert.equal(approvedDocumentDispatch(record, stay, { cmsSend: true }), null);
  const realNative = { ...native, firstName: 'Real', lastName: 'Guest', status: 'Cancelled',
    arrival: '2026-10-12', departure: '2026-10-13' };
  const realStay = { ...stay, firstName: realNative.firstName, lastName: realNative.lastName,
    arrival: realNative.arrival, departure: realNative.departure, allowRealGuest: true };
  const realRecord = { ...record, nativePreimage: realNative, details: { fields: record.details.fields.map((field) =>
    field.name === 'udfchkbox04' ? { ...field, value: true } : field) } };
  assert.deepEqual(filingSnapshot(realRecord), { cmsSend: true });
  assert.ok(approvedDocumentDispatch(realRecord, realStay, { cmsSend: true }));
  assert.equal(approvedDocumentDispatch(realRecord, realStay, { cmsSend: false }), null);
});

test('guarantee, linked parties, reservation notes and rates do not gate document upload', () => {
  const company = { nativeId: '41', name: 'Example Company' }, agency = { nativeId: '99', name: 'Example Agency' };
  const linkedStay = { ...stay, organization: company.name, bookingAgency: agency.name };
  const linked = { nativePreimage: { ...native, commercial: { company, agency } }, details: { fields: record.details.fields.map((field) =>
    field.name === 'udfchar13' ? { ...field, value: 'booker@example.invalid' } :
    field.name === 'company' ? { ...field, value: company.name } : field.name === 'ta1' ? { ...field, value: agency.name } : field) } };
  assert.deepEqual(filingSnapshot(linked), snapshot);
  assert.ok(approvedDocumentDispatch(linked, linkedStay, snapshot));
  const unrelated = { ...linked, nativePreimage: { ...linked.nativePreimage, guaranteeCode: 'GTDAGT',
    roomType: 'OTHER', ratePlan: 'OTHER' }, details: { fields: [{ name: 'udfchkbox04', value: false },
    { name: 'reservationnote', rawValue: 'one' }, { name: 'reservationnote', rawValue: 'two' },
    { name: 'emailaddress', value: 'guest@example.invalid' }] } };
  assert.ok(approvedDocumentDispatch(unrelated, linkedStay, snapshot));
  assert.equal(approvedDocumentDispatch({ ...unrelated, details: { fields: [{ name: 'udfchkbox04', value: true }] } }, linkedStay, snapshot), null);
});

test('fresh listing requires a unique exact code and filename', () => {
  const row = { documentCode: 'NAVA123', name: 'voucher.pdf' };
  const matches = (documents) => hasUniqueDocumentListing({ documents }, 'NAVA123', 'voucher.pdf');
  assert.equal(matches([row]), true);
  assert.equal(matches([]), false);
  assert.equal(matches([row, row]), false);
  assert.equal(matches([row, { ...row, name: 'different.pdf' }]), false);
  assert.equal(matches([row, { ...row, documentCode: 'NAVA456' }]), true);
  assert.equal(matches([{ ...row, name: 'different.pdf' }]), false);
  assert.equal(matches([{ ...row, documentCode: 'NAVA456' }]), false);
});

test('restart recovery requires a stopped writer and fresh exact unique document metadata on the same fake stay', async () => {
  const code = documentCodeForUuid(randomUUID());
  const stored = Buffer.from('%PDF-stored');
  const storedSha = createHash('sha256').update(stored).digest('hex');
  const intent = { operation: 'attach_document', propertyCode: 'HRCEN', transportId: 'transport-centurion', firstName: 'Proof', lastName: 'Labtest',
    nativeGuestId: native.guestId, recovery: { confirmation: native.confirmation, arrival: native.arrival,
      departure: native.departure, documentCode: code, documentName: 'voucher.pdf', pdfSha256: storedSha, writer: {} } };
  const row = { documentCode: code, name: 'voucher.pdf' };
  let shots = 0;
  const credentialLease = { signal: new AbortController().signal };
  const deps = { credentialLease, writerQuiesced: () => true, shallow: async () => {}, read: async () => record,
    documents: async () => ({ documents: [row] }), readStoredDocumentBytes: async () => stored, openSession: async (fn, options) => {
      assert.equal(options.propertyCode, 'HRCEN'); assert.equal(options.startScreen, 'OSRESS'); assert.equal(typeof options.prepareContext, 'function');
      assert.equal(options.credentialLease, credentialLease);
      return fn({ screenshot: async () => { shots++; return png; } });
    } };
  const positive = await provePositiveAttachRecovery(intent, deps);
  assert.equal(positive.outcome, 'verified');
  assert.equal(positive.actualStoredSha256, storedSha);
  assert.equal(positive.storedBytesHashVerified, true);
  assert.deepEqual(positive.readback, { confirmation: native.confirmation, nativeGuestId: native.guestId,
    nativeStayId: native.reservationStayId, documentCode: code, documentName: 'voucher.pdf', uniqueFreshListing: true,
    actualStoredSha256: storedSha, storedBytesHashVerified: true });
  assert.deepEqual(positive.screenshot, png);
  for (const altered of [[], [row, row], [{ ...row, name: 'wrong.pdf' }], [{ ...row, documentCode: 'OTHER' }]]) {
    assert.equal((await provePositiveAttachRecovery(intent, { ...deps, documents: async () => ({ documents: altered }) })).outcome, 'unconfirmed');
  }
  assert.equal((await provePositiveAttachRecovery(intent, { ...deps, writerQuiesced: () => false })).outcome, 'unconfirmed');
  assert.equal((await provePositiveAttachRecovery({ ...intent, nativeGuestId: '124' }, deps)).outcome, 'unconfirmed');
  assert.equal((await provePositiveAttachRecovery({ ...intent, propertyCode: 'OTHER' }, deps)).outcome, 'unconfirmed');
  assert.equal((await provePositiveAttachRecovery({ ...intent, recovery: { ...intent.recovery, departure: '2027-10-14' } }, deps)).outcome, 'unconfirmed');
  assert.equal((await provePositiveAttachRecovery(intent, { ...deps, read: async () => ({ ...record,
    details: { fields: [{ name: 'udfchkbox04', value: true }] } }) })).outcome, 'unconfirmed');
  assert.equal((await provePositiveAttachRecovery(intent, { ...deps, openSession: async (fn) => {
    await fn({ screenshot: async () => png }); throw new Error('browser close unconfirmed');
  } })).outcome, 'unconfirmed');
  assert.equal(shots, 1);
  const aborted = new AbortController();
  aborted.abort();
  let openedAfterAbort = false;
  assert.equal((await provePositiveAttachRecovery(intent, { ...deps, signal: aborted.signal,
    openSession: async () => { openedAfterAbort = true; } })).outcome, 'unconfirmed');
  assert.equal(openedAfterAbort, false);

  const realNative = { ...native, firstName: 'Real', lastName: 'Guest', status: 'Cancelled',
    arrival: '2026-10-12', departure: '2026-10-13' };
  const realRecord = { ...record, nativePreimage: realNative, details: { fields: record.details.fields.map((field) =>
    field.name === 'udfchkbox04' ? { ...field, value: true } : field) } };
  const realIntent = { ...intent, firstName: realNative.firstName, lastName: realNative.lastName,
    recovery: { ...intent.recovery, arrival: realNative.arrival, departure: realNative.departure,
      allowRealGuest: true, cmsSend: true } };
  const realDeps = { ...deps, read: async () => realRecord,
    openSession: async (fn) => fn({ screenshot: async () => png }) };
  assert.equal((await provePositiveAttachRecovery(realIntent, realDeps)).outcome, 'verified');
  assert.equal((await provePositiveAttachRecovery({ ...realIntent, recovery: { ...realIntent.recovery, cmsSend: false } },
    realDeps)).outcome, 'unconfirmed');
  const legacyRecovery = { ...realIntent.recovery };
  delete legacyRecovery.cmsSend;
  assert.equal((await provePositiveAttachRecovery({ ...realIntent, recovery: legacyRecovery }, realDeps)).outcome, 'unconfirmed');
});

test('filing refuses names that the Documents reader would normalize before opening HMS', async () => {
  const credentialLease = { signal: new AbortController().signal };
  for (const documentName of ['Proof  Labtest.pdf', ' Proof Labtest.pdf', 'Proof\u00a0Labtest.pdf']) {
    let opened = 0;
    const result = await runCloudPaneAttach({ target: { propertyCode: 'HRCEN' }, transportId: 'transport-centurion', credentialLease, documentName, guestName: 'Proof Labtest',
      approvedStay: stay, approvedSnapshot: snapshot, pdfSha256: 'a'.repeat(64), beforeDispatch: async () => true,
      finalAuthority: async () => true, continuationAllowed: () => true, dispatchWithAuthority: async () => {} },
    { openSession: async () => { opened++; } });
    assert.equal(result.outcome, 'refused_input');
    assert.equal(result.uploadSent, false);
    assert.equal(opened, 0);
  }
});

test('a clean upload plus a fresh matching listing confirms metadata; uncertainty stays unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pane-attach-test-'));
  try {
    const bytes = Buffer.from('%PDF-synthetic'), path = join(dir, 'source.pdf');
    await writeFile(path, bytes);
    let heldCode;
    const credentialLease = { signal: new AbortController().signal };
    const input = { credentialLease, target: { propertyCode: 'HRCEN' }, transportId: 'transport-centurion', confirmation: native.confirmation, arrival: native.arrival,
      guestName: 'Proof Labtest', documentName: 'voucher.pdf', file: path, approvedStay: stay, approvedSnapshot: snapshot, beforeDispatch: async () => true,
      continuationAllowed: () => true,
      finalAuthority: async (code) => { heldCode = code; return true; },
      dispatchWithAuthority: async (_code, guestId, nativeStayId, requestDigest, dispatch, writerIdentity) => {
        assert.equal(guestId, native.guestId); assert.equal(nativeStayId, native.reservationStayId);
        assert.equal(requestDigest, 'a'.repeat(64)); assert.deepEqual(writerIdentity, writer); return dispatch();
      },
      pdfSha256: createHash('sha256').update(bytes).digest('hex') };
    let sessions = 0, readbacks = 0;
    const deps = { openSession: async (fn, options) => { sessions++;
        assert.equal(options.propertyCode, 'HRCEN'); assert.equal(options.startScreen, 'OSRESS'); assert.equal(typeof options.prepareContext, 'function');
        assert.equal(options.credentialLease, credentialLease);
        return fn({ session: sessions }); },
      shallow: async () => {}, read: async () => record, readStoredDocumentBytes: async () => bytes,
      attach: async (_page, expected, file, options) => { assert.equal(expected.guestId, native.guestId);
        assert.equal(options.strictNetwork, true);
        assert.deepEqual(options.expectedDocumentContext, { cmsSend: false });
        assert.equal(await options.beforeDispatch(), true); assert.equal(await options.finalAuthority(), true); options.onDispatched();
        assert.equal(await options.dispatchWithAuthority(async () => 'continued', 'a'.repeat(64)), 'continued');
        return { outcome: 'awaiting_readback', ...await nativeScreenshots(options.evidenceRoot),
          dispatchCallbacksDrained: true }; },
      openReadSession: async (fn, options) => { sessions++; assert.equal(options.propertyCode, 'HRCEN');
        assert.equal(options.credentialLease, credentialLease); return fn({ session: sessions }); },
      writerIdentity: () => writer,
      freshRead: async (page, _input, code, setNative) => { assert.equal(page.session, 2); assert.match(code, /^NAVA[A-Z2-7]{25}[AEIMQUY4]$/);
        assert.equal(typeof setNative, 'function'); setNative(native);
        readbacks++; return { listed: true, nativeReadback: { confirmation: native.confirmation,
          nativeStayId: native.reservationStayId, nativeGuestId: native.guestId, documentCode: code,
          documentName: 'voucher.pdf', uniqueFreshListing: true }, screenshot: png }; } };
    const success = await runCloudPaneAttach(input, deps);
    assert.equal(success.outcome, 'confirmed'); assert.equal(success.uploadSent, true);
    assert.equal(success.listed, true); assert.match(heldCode, /^NAVA[A-Z2-7]{25}[AEIMQUY4]$/);
    assert.deepEqual(success.screenshots, [join(success.runDir, 'before.png'), join(success.runDir, 'after.png')]);
    assert.deepEqual(await readFile(join(success.runDir, 'before.png')), png);
    assert.deepEqual(await readFile(join(success.runDir, 'after.png')), png);
    assert.equal(success.dispatchCallbacksDrained, true);
    assert.equal(sessions, 2); assert.equal(readbacks, 1);
    await rm(success.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const successWithoutCallback = await runCloudPaneAttach(input, { ...deps,
      attach: async (_page, _expected, _file, options) => {
        assert.equal(await options.beforeDispatch(), true); assert.equal(await options.finalAuthority(), true);
        assert.equal(await options.dispatchWithAuthority(async () => 'continued', 'a'.repeat(64)), 'continued');
        return { outcome: 'awaiting_readback', ...await nativeScreenshots(options.evidenceRoot) };
      } });
    assert.equal(successWithoutCallback.outcome, 'confirmed');
    assert.equal(successWithoutCallback.uploadSent, true); assert.equal(successWithoutCallback.listed, true);
    assert.equal(sessions, 2);
    await rm(successWithoutCallback.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const missing = await runCloudPaneAttach(input, { ...deps, freshRead: async () => ({ listed: false }) });
    assert.equal(missing.outcome, 'upload_unconfirmed');
    assert.equal(missing.listed, false);
    await rm(missing.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const uncertain = await runCloudPaneAttach(input, { ...deps,
      attach: async (_page, _expected, _file, options) => { options.onDispatched(); return { outcome: 'uncertain' }; } });
    assert.equal(uncertain.outcome, 'uncertain'); assert.equal(uncertain.listed, true);
    await rm(uncertain.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const unknown = await runCloudPaneAttach(input, { ...deps,
      attach: async (_page, _expected, _file, options) => { options.onDispatched(); throw new Error('connection lost'); } });
    assert.equal(unknown.outcome, 'uncertain'); assert.equal(unknown.uploadSent, true); assert.equal(unknown.listed, undefined);
    assert.equal(sessions, 1); assert.equal(readbacks, 3);
    await rm(unknown.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const lostCallback = await runCloudPaneAttach(input, { ...deps,
      attach: async () => { throw new Error('connection lost'); },
      freshRead: async () => { throw new Error('readback unavailable'); } });
    assert.equal(lostCallback.outcome, 'uncertain'); assert.equal(lostCallback.uploadSent, true);
    assert.equal(lostCallback.listed, undefined); assert.equal(sessions, 1);
    await rm(lostCallback.cleanupRoot, { recursive: true, force: true });

    sessions = 0;
    const readbackFailed = await runCloudPaneAttach(input, { ...deps,
      freshRead: async () => { throw new Error('readback unavailable'); } });
    assert.equal(readbackFailed.outcome, 'uncertain'); assert.equal(readbackFailed.listed, undefined);
    await rm(readbackFailed.cleanupRoot, { recursive: true, force: true });
    sessions = 0;
    const outside = await runCloudPaneAttach(input, { ...deps, attach: async () => ({
      outcome: 'awaiting_readback', evidenceDir: dir,
      screenshots: [join(dir, `${randomUUID()}-before.png`), join(dir, `${randomUUID()}-after.png`)],
    }) });
    assert.equal(outside.outcome, 'uncertain'); assert.deepEqual(outside.screenshots, []);
    await rm(outside.cleanupRoot, { recursive: true, force: true });
    assert.equal((await runCloudPaneAttach({ ...input, pdfSha256: 'a'.repeat(64) }, deps)).outcome, 'attachment_hash_changed');
    assert.equal((await runCloudPaneAttach({ ...input, target: { propertyCode: 'OTHER' } }, deps)).outcome, 'refused_input');

  } finally { await rm(dir, { recursive: true, force: true }); }
});
