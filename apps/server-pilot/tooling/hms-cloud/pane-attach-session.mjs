// The pane's approved HRCEN upload. Each readback owns a new browser session.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

// The native reader permits 200 characters per name; its search hint accepts
// at most 256 combined. Confirmation and arrival still select uniquely, and
// the opened native record is always checked against both exact names.
function lookupOptions(guestName, arrival) {
  return { ...(guestName.length <= 256 ? { guestName } : {}), arrivalDate: arrival };
}

/** The selected native identity must be the stay staff reviewed. */
export function approvedLabtestRecord(record, stay) {
  const native = record?.nativePreimage;
  const allowRealGuest = stay?.allowRealGuest === true;
  const firstName = stay?.firstName ?? (allowRealGuest ? null : 'Proof');
  const lastName = stay?.lastName ?? (allowRealGuest ? null : 'Labtest');
  const labtestGuest = firstName === 'Proof' && lastName === 'Labtest';
  if (!native || !stay || native.source !== 'record_view_ext_model' || native.propertyCode !== 'HRCEN' ||
      typeof firstName !== 'string' || !firstName.trim() || firstName !== firstName.trim() || firstName.length > 200 || /[\p{Cc}]/u.test(firstName) ||
      typeof lastName !== 'string' || !lastName.trim() || lastName !== lastName.trim() || lastName.length > 200 || /[\p{Cc}]/u.test(lastName) ||
      native.firstName !== firstName || native.lastName !== lastName || native.status !== 'Reserved' ||
      !/^\d{1,100}$/.test(native.reservationStayId || '') ||
      (stay.nativeStayId && native.reservationStayId !== stay.nativeStayId) ||
      (!allowRealGuest && !labtestGuest) || (labtestGuest && native.arrival < '2027-01-01') ||
      !validIsoDate(native.arrival) || !validIsoDate(native.departure) ||
      native.departure <= native.arrival) return null;
  for (const key of ['confirmation', 'arrival', 'departure']) {
    if (native[key] !== stay[key]) return null;
  }
  return { confirmation: native.confirmation, guestId: native.guestId, nativeStayId: native.reservationStayId,
    firstName, lastName, allowRealGuest, arrival: native.arrival, departure: native.departure };
}

/** The upload additionally pins the independently observed guest ID and forbids sending. */
export function approvedDocumentDispatch(record, stay, approvedSnapshot) {
  const target = approvedLabtestRecord(record, stay), snapshot = filingSnapshot(record);
  if (!target || typeof target.guestId !== 'string' || !/^[0-9]{1,30}$/.test(target.guestId) ||
      target.guestId !== stay.nativeGuestId || !snapshot || !approvedSnapshot ||
      JSON.stringify(snapshot) !== JSON.stringify(approvedSnapshot)) return null;
  return target;
}

/** Snapshot the identity tuple only after approvedDocumentDispatch accepts the native record. */
function snapshotApprovedNativeIdentity(native) {
  if (!native || typeof native !== 'object') return null;
  return Object.freeze({ propertyCode: native.propertyCode, confirmation: native.confirmation,
    reservationId: native.reservationId, reservationStayId: native.reservationStayId, guestId: native.guestId,
    firstName: native.firstName, lastName: native.lastName, status: native.status,
    arrival: native.arrival, departure: native.departure });
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
  await readShallow(page, input.confirmation, lookupOptions(input.guestName, input.arrival));
  const record = await readRecord(page, input.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
  const expected = approvedDocumentDispatch(record, input.approvedStay, input.approvedSnapshot);
  if (!expected) throw new Error('READBACK_STAY_MISMATCH');
  setNative(record.nativePreimage);
  const docs = await readDocuments(page, input.confirmation);
  const listed = hasUniqueDocumentListing(docs, code, input.documentName);
  const nativeReadback = { confirmation: record.nativePreimage.confirmation,
    nativeStayId: record.nativePreimage.reservationStayId, nativeGuestId: record.nativePreimage.guestId,
    documentCode: code, documentName: input.documentName, uniqueFreshListing: listed };
  return { listed, nativeReadback, screenshot: listed ? await page.screenshot({ fullPage: true }) : null };
}

/** Recovery accepts only a fresh positive listing on the original stay. */
export async function provePositiveAttachRecovery(intent, { openSession = withCenturionStay360Page,
  shallow = readShallow, read = readRecord, documents = readDocuments, writerQuiesced = centurionWriterQuiesced } = {}) {
  try {
    const recovery = intent?.recovery;
    const labtestGuest = intent?.firstName === 'Proof' && intent?.lastName === 'Labtest';
    const targetPolicyAllowed = labtestGuest
      ? typeof recovery?.arrival === 'string' && recovery.arrival >= '2027-01-01'
      : recovery?.allowRealGuest === true;
    if (intent?.operation !== 'attach_document' || intent.propertyCode !== 'HRCEN' ||
        typeof intent.firstName !== 'string' || !intent.firstName.trim() ||
        typeof intent.lastName !== 'string' || !intent.lastName.trim() ||
        !/^[0-9]{1,30}$/.test(intent.nativeGuestId || '') || !writerQuiesced(recovery?.writer) ||
        !/^\d+-\d+$/.test(recovery?.confirmation || '') || !validIsoDate(recovery.arrival) ||
        !validIsoDate(recovery.departure) || recovery.departure <= recovery.arrival ||
        !targetPolicyAllowed ||
        (recovery.guestName && recovery.guestName !== `${intent.firstName} ${intent.lastName}`) ||
        !/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(recovery.documentCode || '') ||
        typeof recovery.documentName !== 'string' || !/\.pdf$/i.test(recovery.documentName) ||
        recovery.documentName !== recovery.documentName.replace(/\s+/g, ' ').trim() ||
        !/^[a-f0-9]{64}$/.test(recovery.pdfSha256 || '')) return { outcome: 'unconfirmed' };
    const ref = { current: null }, approvedNative = { current: null };
    return await openSession(async (page) => {
      await shallow(page, recovery.confirmation, lookupOptions(`${intent.firstName} ${intent.lastName}`, recovery.arrival));
      const record = await read(page, recovery.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
      const stay = { confirmation: recovery.confirmation, arrival: recovery.arrival, departure: recovery.departure,
        nativeGuestId: intent.nativeGuestId, nativeStayId: recovery.nativeStayId,
        firstName: intent.firstName, lastName: intent.lastName, allowRealGuest: recovery.allowRealGuest === true };
      if (!approvedDocumentDispatch(record, stay, { cmsSend: false })) return { outcome: 'unconfirmed' };
      approvedNative.current = snapshotApprovedNativeIdentity(record.nativePreimage);
      ref.current = record.nativePreimage;
      const listing = await documents(page, recovery.confirmation);
      if (!hasUniqueDocumentListing(listing, recovery.documentCode, recovery.documentName)) return { outcome: 'unconfirmed' };
      const screenshot = await page.screenshot({ fullPage: true });
      if (!Buffer.isBuffer(screenshot) || !screenshot.length || screenshot.length > 10 * 1024 * 1024) {
        return { outcome: 'unconfirmed' };
      }
      return { outcome: 'verified', confirmation: recovery.confirmation, screenshot,
        readback: { confirmation: record.nativePreimage.confirmation, nativeStayId: record.nativePreimage.reservationStayId,
          nativeGuestId: intent.nativeGuestId,
          documentCode: recovery.documentCode, documentName: recovery.documentName, uniqueFreshListing: true } };
    }, { headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(5 * 60_000),
      ...(recovery.cloudTargetKey ? { cloudTargetKey: recovery.cloudTargetKey } : {}),
      prepareContext: (context) => installPaneAttachReadGuard(context, {
        confirmation: recovery.confirmation, allowRealGuest: recovery.allowRealGuest === true,
        getNative: () => ref.current, getApprovedNativeIdentity: () => approvedNative.current,
      }) });
  } catch { return { outcome: 'unconfirmed' }; }
}

/** Caller holds the property lock and supplies a live server-side dispatch check. */
export async function runCloudPaneAttach(input, { openSession = withCenturionStay360Page,
  attach = attachLabtestDocument, freshRead = freshDocuments, shallow = readShallow, read = readRecord,
  writerIdentity = centurionWriterIdentity } = {}) {
  if (input.target?.propertyCode !== 'HRCEN' || typeof input.beforeDispatch !== 'function' ||
      typeof input.finalAuthority !== 'function' || typeof input.dispatchWithAuthority !== 'function' ||
      typeof input.continuationAllowed !== 'function' ||
      typeof input.guestName !== 'string' || input.guestName !== `${input.approvedStay?.firstName} ${input.approvedStay?.lastName}` ||
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
  const allowRealGuest = input.allowRealGuest === true && input.approvedStay?.allowRealGuest === true;
  const approvedNative = { current: null };
  const options = (ref, timeout) => ({ headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(timeout),
    ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}),
    prepareContext: (context) => installPaneAttachReadGuard(context, {
      confirmation: input.confirmation, allowRealGuest,
      getNative: () => ref.current, getApprovedNativeIdentity: () => approvedNative.current,
    }) });
  const writing = { current: null };
  let result, dispatched = false, attachAttempted = false, writerSessionClosed = false;
  try {
    result = await openSession(async (page) => {
      await shallow(page, input.confirmation, lookupOptions(input.guestName, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
      const expected = approvedDocumentDispatch(record, input.approvedStay, input.approvedSnapshot);
      if (!expected) return { outcome: 'not_dispatched', issue: 'APPROVED_STAY_MISMATCH' };
      approvedNative.current = snapshotApprovedNativeIdentity(record.nativePreimage);
      writing.current = record.nativePreimage;
      attachAttempted = true;
      return attach(page, expected, { name: input.documentName, documentCode: code,
        description: input.documentName, mimeType: 'application/pdf', bytes },
      { evidenceRoot: root, expectedDocumentContext: input.approvedSnapshot,
        beforeDispatch: input.beforeDispatch, finalAuthority: () => input.finalAuthority(code),
        continuationAllowed: input.continuationAllowed,
        dispatchWithAuthority: (dispatch, requestDigest, beforeShot, intercepted) => {
          const writer = writerIdentity(page);
          if (!writer) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
          return input.dispatchWithAuthority(code, expected.guestId, expected.nativeStayId, requestDigest,
            dispatch, writer, beforeShot, intercepted);
        },
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
  let fresh;
  const reading = { current: null };
  try { fresh = await openSession((page) => freshRead(page, input, code, (native) => { reading.current = native; }),
    options(reading, 5 * 60_000)); } catch { /* Unknown remains fenced. */ }
  const listed = fresh?.listed;
  const nativeReadback = fresh?.nativeReadback;
  if (listed === true && Buffer.isBuffer(fresh?.screenshot) && fresh.screenshot.length > 0 &&
      fresh.screenshot.length <= 10 * 1024 * 1024 && evidence.screenshots.length === 2) {
    await writeFile(evidence.screenshots[1], fresh.screenshot, { mode: 0o600 });
  } else if (listed === true) {
    return { outcome: 'uncertain', uploadSent: true, documentCode: code, ...evidence,
      writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
  }
  // Owner's confirmation bar is a clean upload followed by a unique fresh listing.
  // The listing is not evidence of the stored file bytes or full tree completeness.
  const outcome = result.outcome === 'awaiting_readback' && listed === true ? 'confirmed'
    : listed === false ? 'upload_unconfirmed' : 'uncertain';
  return { outcome, uploadSent: true, documentCode: code, ...(listed === undefined ? {} : { listed }),
    ...(nativeReadback ? { nativeReadback } : {}),
    ...evidence, writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
}
