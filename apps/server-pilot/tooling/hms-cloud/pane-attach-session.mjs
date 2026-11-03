// The pane's approved Labtest upload. Each readback owns a new browser session.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { centurionWriterIdentity, centurionWriterQuiesced, withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readShallow, readRecord, readDocuments } from './hms-readers.mjs';
import { installPaneAttachReadGuard } from './pane-attach-read-guard.mjs';
import { attachLabtestDocument } from './stay360-document-attach.mjs';

/** Encode all UUID bits without exceeding HMS's 30-character document-code limit. */
export function documentCodeForUuid(uuid) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
    throw new Error('DOCUMENT_UUID_INVALID');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = BigInt(`0x${uuid.replaceAll('-', '')}`) << 2n;
  let code = 'NAVA';
  for (let index = 25; index >= 0; index--) code += alphabet[Number((bits >> BigInt(index * 5)) & 31n)];
  return code;
}

/** Filing does not alter the stay; the send checkbox is the only communication setting it needs. */
export function filingSnapshot(record) {
  const fields = record?.details?.fields;
  if (!Array.isArray(fields)) return null;
  const send = fields.filter((item) => item?.name === 'udfchkbox04');
  return send.length === 1 && send[0].value === false ? { cmsSend: false } : null;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** The selected HMS record must be the fake stay staff reviewed. */
export function approvedLabtestRecord(record, stay) {
  const native = record?.nativePreimage;
  if (!native || !stay || native.propertyCode !== 'HRCEN' ||
      native.firstName !== 'Proof' || native.lastName !== 'Labtest' || native.status !== 'Reserved' ||
      !validIsoDate(native.arrival) || native.arrival < '2027-01-01' || !validIsoDate(native.departure) ||
      native.departure <= native.arrival) return null;
  for (const key of ['confirmation', 'arrival', 'departure']) {
    if (native[key] !== stay[key]) return null;
  }
  return { confirmation: native.confirmation, guestId: native.guestId, arrival: native.arrival,
    departure: native.departure };
}

/** The upload additionally pins the independently observed guest ID and forbids sending. */
export function approvedDocumentDispatch(record, stay, approvedSnapshot) {
  const target = approvedLabtestRecord(record, stay), snapshot = filingSnapshot(record);
  if (!target || typeof target.guestId !== 'string' || !/^[0-9]{1,30}$/.test(target.guestId) ||
      target.guestId !== stay.nativeGuestId || !snapshot || !approvedSnapshot ||
      JSON.stringify(snapshot) !== JSON.stringify(approvedSnapshot)) return null;
  return target;
}

/** A fresh listing confirms metadata only; it does not verify the stored bytes. */
export function hasUniqueDocumentListing(docs, code, name) {
  if (!Array.isArray(docs?.documents)) return false;
  const codes = docs.documents.filter((item) => item?.documentCode === code);
  return codes.length === 1 && codes[0].name === name;
}

/** Give the sealer the native evidence directory, retaining its parent for cleanup. */
function evidenceLocation(result, root) {
  const valid = typeof result?.evidenceDir === 'string' && dirname(result.evidenceDir) === root &&
    basename(result.evidenceDir).startsWith('hms-document-');
  const runDir = valid ? result.evidenceDir : root;
  const screenshots = valid && Array.isArray(result.screenshots) && result.screenshots.length === 2 &&
    ['before.png', 'after.png'].every((name, i) => result.screenshots[i] === join(runDir, name))
    ? result.screenshots : [];
  return { runDir, cleanupRoot: root, screenshots };
}

async function freshDocuments(page, input, code, setNative) {
  await readShallow(page, input.confirmation, { guestName: 'Proof Labtest', arrivalDate: input.arrival });
  const record = await readRecord(page, input.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
  const expected = approvedDocumentDispatch(record, input.approvedStay, input.approvedSnapshot);
  if (!expected) throw new Error('READBACK_STAY_MISMATCH');
  setNative(record.nativePreimage);
  const docs = await readDocuments(page, input.confirmation);
  return hasUniqueDocumentListing(docs, code, input.documentName);
}

/** Recovery accepts only a fresh positive listing on the original fake stay. */
export async function provePositiveAttachRecovery(intent, { openSession = withCenturionStay360Page,
  shallow = readShallow, read = readRecord, documents = readDocuments, writerQuiesced = centurionWriterQuiesced } = {}) {
  try {
    const recovery = intent?.recovery;
    if (intent?.operation !== 'attach_document' || intent.propertyCode !== 'HRCEN' ||
        intent.firstName !== 'Proof' || intent.lastName !== 'Labtest' ||
        !/^[0-9]{1,30}$/.test(intent.nativeGuestId || '') || !writerQuiesced(recovery?.writer) ||
        !/^\d+-\d+$/.test(recovery?.confirmation || '') || !validIsoDate(recovery.arrival) ||
        recovery.arrival < '2027-01-01' || !validIsoDate(recovery.departure) || recovery.departure <= recovery.arrival ||
        !/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(recovery.documentCode || '') ||
        typeof recovery.documentName !== 'string' || !/\.pdf$/i.test(recovery.documentName) ||
        recovery.documentName !== recovery.documentName.replace(/\s+/g, ' ').trim() ||
        !/^[a-f0-9]{64}$/.test(recovery.pdfSha256 || '')) return { outcome: 'unconfirmed' };
    const ref = { current: null };
    return await openSession(async (page) => {
      await shallow(page, recovery.confirmation, { guestName: 'Proof Labtest', arrivalDate: recovery.arrival });
      const record = await read(page, recovery.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
      const stay = { confirmation: recovery.confirmation, arrival: recovery.arrival, departure: recovery.departure,
        nativeGuestId: intent.nativeGuestId };
      if (!approvedDocumentDispatch(record, stay, { cmsSend: false })) return { outcome: 'unconfirmed' };
      ref.current = record.nativePreimage;
      const listing = await documents(page, recovery.confirmation);
      if (!hasUniqueDocumentListing(listing, recovery.documentCode, recovery.documentName)) return { outcome: 'unconfirmed' };
      const screenshot = await page.screenshot({ fullPage: true });
      if (!Buffer.isBuffer(screenshot) || !screenshot.length || screenshot.length > 10 * 1024 * 1024) {
        return { outcome: 'unconfirmed' };
      }
      return { outcome: 'verified', confirmation: recovery.confirmation, screenshot,
        readback: { confirmation: recovery.confirmation, nativeGuestId: intent.nativeGuestId,
          documentCode: recovery.documentCode, documentName: recovery.documentName, uniqueFreshListing: true } };
    }, { headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(5 * 60_000),
      prepareContext: (context) => installPaneAttachReadGuard(context, {
        confirmation: recovery.confirmation, getNative: () => ref.current,
      }) });
  } catch { return { outcome: 'unconfirmed' }; }
}

/** Caller holds the property lock and supplies a live server-side dispatch check. */
export async function runCloudPaneAttach(input, { openSession = withCenturionStay360Page,
  attach = attachLabtestDocument, freshRead = freshDocuments, shallow = readShallow, read = readRecord,
  writerIdentity = centurionWriterIdentity } = {}) {
  if (input.target?.propertyCode !== 'HRCEN' || input.allowRealGuest || typeof input.beforeDispatch !== 'function' ||
      typeof input.finalAuthority !== 'function' || typeof input.dispatchWithAuthority !== 'function' ||
      typeof input.continuationAllowed !== 'function' ||
      !input.approvedSnapshot || !/^[a-f0-9]{64}$/.test(input.pdfSha256 || '') ||
      typeof input.documentName !== 'string' || input.documentName !== input.documentName.replace(/\s+/g, ' ').trim()) {
    return { outcome: 'refused_input', uploadSent: false, screenshots: [] };
  }
  const bytes = await readFile(input.file);
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      createHash('sha256').update(bytes).digest('hex') !== input.pdfSha256) {
    return { outcome: 'attachment_hash_changed', uploadSent: false, screenshots: [] };
  }
  const root = await mkdtemp(join(tmpdir(), 'pane-cloud-attach-'));
  const code = documentCodeForUuid(randomUUID());
  const options = (ref, timeout) => ({ headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(timeout),
    prepareContext: (context) => installPaneAttachReadGuard(context, {
      confirmation: input.confirmation, getNative: () => ref.current,
    }) });
  const writing = { current: null };
  let result, dispatched = false, attachAttempted = false, writerSessionClosed = false;
  try {
    result = await openSession(async (page) => {
      await shallow(page, input.confirmation, { guestName: 'Proof Labtest', arrivalDate: input.arrival });
      const record = await read(page, input.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
      const expected = approvedDocumentDispatch(record, input.approvedStay, input.approvedSnapshot);
      if (!expected) return { outcome: 'not_dispatched', issue: 'APPROVED_STAY_MISMATCH' };
      writing.current = record.nativePreimage;
      attachAttempted = true;
      return attach(page, expected, { name: input.documentName, documentCode: code,
        description: input.documentName, mimeType: 'application/pdf', bytes },
      { evidenceRoot: root, expectedDocumentContext: input.approvedSnapshot,
        beforeDispatch: input.beforeDispatch, finalAuthority: () => input.finalAuthority(code),
        continuationAllowed: input.continuationAllowed,
        dispatchWithAuthority: (dispatch, requestDigest, beforeShot) =>
          input.dispatchWithAuthority(code, expected.guestId, requestDigest, dispatch, writerIdentity(page), beforeShot),
        onDispatched: () => { dispatched = true; }, strictNetwork: true, timeoutMs: 7 * 60_000 });
    }, options(writing, 10 * 60_000));
    writerSessionClosed = true; // withCenturionStay360Page returns only after verified browser cleanup.
  } catch {
    if (!attachAttempted && !dispatched) return { outcome: 'execution_failure', uploadSent: false, screenshots: [],
      dispatchCallbacksDrained: true, runDir: root, cleanupRoot: root };
    result = { outcome: 'uncertain', screenshots: [] };
  }
  if (!result || typeof result.outcome !== 'string') result = { outcome: 'uncertain', screenshots: [] };
  const evidence = evidenceLocation(result, root);
  const possible = dispatched || ['awaiting_readback', 'uncertain'].includes(result.outcome);
  if (!possible) return { outcome: result.issue || result.outcome, uploadSent: false,
    ...evidence, writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
  let listed;
  const reading = { current: null };
  try { listed = await openSession((page) => freshRead(page, input, code, (native) => { reading.current = native; }),
    options(reading, 5 * 60_000)); } catch { /* Unknown remains fenced. */ }
  // Owner's confirmation bar is a clean upload followed by a unique fresh listing.
  // The listing is not evidence of the stored file bytes or full tree completeness.
  const outcome = result.outcome === 'awaiting_readback' && listed === true ? 'confirmed'
    : listed === false ? 'upload_unconfirmed' : 'uncertain';
  return { outcome, uploadSent: true, documentCode: code, ...(listed === undefined ? {} : { listed }),
    ...evidence, writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
}
