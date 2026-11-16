// The pane's approved Cloud upload. Each readback owns a new browser session.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cloudWriterIdentity, cloudWriterQuiesced, withCloudCredentialLease, withCloudReadSession, withCloudWriterSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { readShallow, readRecord, readDocuments } from './hms-readers.mjs';
import { installPaneAttachReadGuard } from './pane-attach-read-guard.mjs';
import { attachLabtestDocument } from './stay360-document-attach.mjs';

const phaseSignal = (signal, timeout) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
const validScope = (propertyCode, transportId) => {
  const property = getPropertyRegistration(propertyCode);
  return Boolean(property?.active && typeof transportId === 'string' && property.transportIds.includes(transportId));
};
function savedTargetKeys(propertyCode, confirmation, nativeStayId) {
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active || !/^\d+-\d+$/.test(confirmation || '')) return [];
  const normalize = value => value.replace(/^0+(?=\d)/, '');
  const [base, suffix] = confirmation.split('-');
  const tenant = propertyCode === 'HRCEN' ? [] : [property.expectedTenant];
  const keys = [JSON.stringify([propertyCode, 'saved', `${normalize(base)}-${normalize(suffix)}`, ...tenant])];
  if (/^\d{1,100}$/.test(nativeStayId || '')) keys.push(JSON.stringify([propertyCode, 'saved_native', normalize(nativeStayId), ...tenant]));
  return keys;
}

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

/** Filing leaves the stay unchanged, including its existing CMS setting. */
export function filingSnapshot(record) {
  const fields = record?.details?.fields;
  if (!Array.isArray(fields)) return null;
  const send = fields.filter((item) => item?.name === 'udfchkbox04');
  return send.length === 1 && typeof send[0].value === 'boolean' ? { cmsSend: send[0].value } : null;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

// The native reader permits 200 characters per name; its search hint accepts
// at most 256 combined. Its matcher needs two name tokens longer than one
// character, so an initial-only hint would reject an otherwise valid lookup.
function lookupOptions(guestName, arrival) {
  const tokens = guestName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [];
  const matchableTokens = tokens.filter((word, index) => word !== 'and' || index === 0 || index === tokens.length - 1);
  const hasVerifiableName = matchableTokens.filter((word) => word.length > 1).length >= 2;
  return { ...(guestName.length <= 256 && hasVerifiableName ? { guestName } : {}), arrivalDate: arrival };
}

/** The selected native identity must be the stay staff reviewed. */
export function approvedLabtestRecord(record, stay) {
  const native = record?.nativePreimage;
  const propertyCode = stay?.propertyCode ?? 'HRCEN';
  const allowRealGuest = stay?.allowRealGuest === true;
  const firstName = stay?.firstName ?? (allowRealGuest ? null : 'Proof');
  const lastName = stay?.lastName ?? (allowRealGuest ? null : 'Labtest');
  const labtestGuest = firstName === 'Proof' && lastName === 'Labtest';
  if (!getPropertyRegistration(propertyCode)?.active || !native || !stay || native.source !== 'record_view_ext_model' || native.propertyCode !== propertyCode ||
      typeof firstName !== 'string' || !firstName.trim() || firstName !== firstName.trim() || firstName.length > 200 || /[\p{Cc}]/u.test(firstName) ||
      typeof lastName !== 'string' || !lastName.trim() || lastName !== lastName.trim() || lastName.length > 200 || /[\p{Cc}]/u.test(lastName) ||
      native.firstName !== firstName || native.lastName !== lastName ||
      typeof native.status !== 'string' || !native.status.trim() ||
      !/^\d{1,100}$/.test(native.reservationStayId || '') ||
      (stay.nativeStayId && native.reservationStayId !== stay.nativeStayId) ||
      (!allowRealGuest && !labtestGuest) ||
      (labtestGuest && (native.arrival < '2027-01-01' || native.status !== 'Reserved')) ||
      !validIsoDate(native.arrival) || !validIsoDate(native.departure) ||
      native.departure <= native.arrival) return null;
  for (const key of ['confirmation', 'arrival', 'departure']) {
    if (native[key] !== stay[key]) return null;
  }
  return { propertyCode: native.propertyCode, confirmation: native.confirmation, guestId: native.guestId, nativeStayId: native.reservationStayId,
    firstName, lastName, status: native.status, allowRealGuest, arrival: native.arrival, departure: native.departure };
}

/** The upload pins the independently observed guest ID and unchanged CMS setting. */
export function approvedDocumentDispatch(record, stay, approvedSnapshot) {
  const target = approvedLabtestRecord(record, stay), snapshot = filingSnapshot(record);
  if (!target || typeof target.guestId !== 'string' || !/^[0-9]{1,30}$/.test(target.guestId) ||
      target.guestId !== stay.nativeGuestId || !snapshot || !approvedSnapshot ||
      (target.firstName === 'Proof' && target.lastName === 'Labtest' && snapshot.cmsSend !== false) ||
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
export function hasUniqueDocumentListing(docs, code, name, description) {
  if (!Array.isArray(docs?.documents)) return false;
  const codes = docs.documents.filter((item) => item?.documentCode === code);
  return codes.length === 1 && codes[0].name === name &&
    (description === undefined || codes[0].description === description);
}

const PDF_MAGIC_BYTES = Buffer.from('%PDF-');
const STORED_BYTES_MODULE = './pane-document-bytes.mjs';
const storedDocumentBytes = { reader: null };
/**
 * The native stored-byte reader is discovered, never assumed: only the named
 * sibling export may supply fresh bytes. A missing module leaves the stored
 * hash unverified rather than fabricating a read. Discovery retries while the
 * reader stays unresolved so a later-deployed module is picked up.
 */
async function defaultStoredDocumentBytesReader() {
  if (!storedDocumentBytes.reader) {
    try {
      const mod = await import(STORED_BYTES_MODULE);
      storedDocumentBytes.reader = typeof mod?.readStoredDocumentBytes === 'function'
        ? mod.readStoredDocumentBytes : null;
    } catch { storedDocumentBytes.reader = null; }
  }
  return storedDocumentBytes.reader;
}

/**
 * Independently hash fresh stored bytes the reader returns. The reader is never
 * handed the expected digest, and a claimed digest is never trusted: missing
 * bytes, a reader failure, oversize or non-PDF output and a mismatched hash all
 * leave storedBytesHashVerified false.
 */
export async function verifyStoredDocumentBytes(page, reader, target, expectedSha256) {
  const result = { actualStoredSha256: null, storedBytesHashVerified: false };
  if (typeof reader !== 'function' || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) return result;
  try {
    const raw = await reader(page, { ...target });
    const body = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : null;
    if (!body?.length || body.length > 10 * 1024 * 1024 || !body.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES)) {
      return result;
    }
    result.actualStoredSha256 = createHash('sha256').update(body).digest('hex');
    result.storedBytesHashVerified = result.actualStoredSha256 === expectedSha256;
  } catch { /* A reader failure keeps the stored hash unverified. */ }
  return result;
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

function safeNativeDiagnostics(result) {
  const diagnostics = {};
  for (const key of ['checkStatus', 'uploadStatus', 'refreshStatus']) {
    const value = result?.[key];
    if (value === null || (Number.isSafeInteger(value) && value >= 100 && value <= 599)) diagnostics[key] = value;
  }
  for (const key of ['visibleDialogs', 'blockedRequests']) {
    const value = result?.[key];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 1000) diagnostics[key] = value;
  }
  return Object.keys(diagnostics).length ? diagnostics : undefined;
}

async function freshDocuments(page, input, code, setNative) {
  await readShallow(page, input.confirmation, lookupOptions(input.guestName, input.arrival));
  const record = await readRecord(page, input.confirmation, { nativePropertyCode: input.target.propertyCode, nativeIdentityOnly: true });
  const expected = approvedDocumentDispatch(record, input.approvedStay, input.approvedSnapshot);
  if (!expected) throw new Error('READBACK_STAY_MISMATCH');
  setNative(record.nativePreimage);
  const docs = await readDocuments(page, input.confirmation);
  const listed = hasUniqueDocumentListing(docs, code, input.documentName, input.documentDescription);
  const nativeReadback = { confirmation: record.nativePreimage.confirmation,
    nativeStayId: record.nativePreimage.reservationStayId, nativeGuestId: record.nativePreimage.guestId,
    documentCode: code, documentName: input.documentName,
    ...(input.documentDescription && listed ? { documentDescription: input.documentDescription } : {}), uniqueFreshListing: listed };
  return { listed, nativeReadback, screenshot: listed ? await page.screenshot({ fullPage: true }) : null };
}

/**
 * Recovery accepts only fresh byte-level proof on the original stay. A unique
 * listing without a matching stored-byte hash reports 'listed', not 'verified'.
 */
export async function provePositiveAttachRecovery(intent, { openSession = withCloudReadSession,
  shallow = readShallow, read = readRecord, documents = readDocuments, writerQuiesced = cloudWriterQuiesced,
  readStoredDocumentBytes, signal, credentialLease } = {}) {
  try {
    const recovery = intent?.recovery;
    const labtestGuest = intent?.firstName === 'Proof' && intent?.lastName === 'Labtest';
    const targetPolicyAllowed = labtestGuest
      ? typeof recovery?.arrival === 'string' && recovery.arrival >= '2027-01-01'
      : recovery?.allowRealGuest === true;
    if (intent?.operation !== 'attach_document' || !validScope(intent.propertyCode, intent.transportId) ||
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
        (recovery.cmsSend !== undefined && typeof recovery.cmsSend !== 'boolean') ||
        !/^[a-f0-9]{64}$/.test(recovery.pdfSha256 || '')) return { outcome: 'unconfirmed' };
    const ref = { current: null }, approvedNative = { current: null };
    const sessionSignal = phaseSignal(credentialLease?.signal ? AbortSignal.any([signal, credentialLease.signal].filter(Boolean)) : signal, 5 * 60_000);
    sessionSignal.throwIfAborted();
    return await openSession(async (page) => {
      await shallow(page, recovery.confirmation, lookupOptions(`${intent.firstName} ${intent.lastName}`, recovery.arrival));
      sessionSignal.throwIfAborted();
      const record = await read(page, recovery.confirmation, { nativePropertyCode: intent.propertyCode, nativeIdentityOnly: true });
      sessionSignal.throwIfAborted();
      const stay = { propertyCode: intent.propertyCode, confirmation: recovery.confirmation, arrival: recovery.arrival, departure: recovery.departure,
        nativeGuestId: intent.nativeGuestId, nativeStayId: recovery.nativeStayId,
        firstName: intent.firstName, lastName: intent.lastName, allowRealGuest: recovery.allowRealGuest === true };
      // Old holds predate CMS-on filing and could only have captured false.
      if (!approvedDocumentDispatch(record, stay, { cmsSend: recovery.cmsSend ?? false })) return { outcome: 'unconfirmed' };
      approvedNative.current = snapshotApprovedNativeIdentity(record.nativePreimage);
      ref.current = record.nativePreimage;
      const listing = await documents(page, recovery.confirmation);
      sessionSignal.throwIfAborted();
      if (!hasUniqueDocumentListing(listing, recovery.documentCode, recovery.documentName, recovery.documentDescription)) return { outcome: 'unconfirmed' };
      const readback = { confirmation: record.nativePreimage.confirmation,
        nativeStayId: record.nativePreimage.reservationStayId, nativeGuestId: intent.nativeGuestId,
        documentCode: recovery.documentCode, documentName: recovery.documentName,
        ...(recovery.documentDescription ? { documentDescription: recovery.documentDescription } : {}), uniqueFreshListing: true };
      const stored = await verifyStoredDocumentBytes(page,
        readStoredDocumentBytes !== undefined ? readStoredDocumentBytes : await defaultStoredDocumentBytesReader(),
        { propertyCode: intent.propertyCode, confirmation: recovery.confirmation, documentCode: recovery.documentCode,
          documentName: recovery.documentName,
          ...(recovery.documentDescription ? { documentDescription: recovery.documentDescription } : {}),
          nativeStayId: record.nativePreimage.reservationStayId, nativeGuestId: intent.nativeGuestId },
        recovery.pdfSha256);
      sessionSignal.throwIfAborted();
      if (stored.storedBytesHashVerified !== true) {
        return { outcome: 'listed', confirmation: recovery.confirmation,
          actualStoredSha256: stored.actualStoredSha256, storedBytesHashVerified: false,
          readback: { ...readback, ...(stored.actualStoredSha256 ? { actualStoredSha256: stored.actualStoredSha256 } : {}) } };
      }
      const screenshot = await page.screenshot({ fullPage: true });
      sessionSignal.throwIfAborted();
      if (!Buffer.isBuffer(screenshot) || !screenshot.length || screenshot.length > 10 * 1024 * 1024) {
        return { outcome: 'unconfirmed' };
      }
      return { outcome: 'verified', confirmation: recovery.confirmation, screenshot,
        actualStoredSha256: stored.actualStoredSha256, storedBytesHashVerified: true,
        readback: { ...readback, actualStoredSha256: stored.actualStoredSha256, storedBytesHashVerified: true } };
    }, { propertyCode: intent.propertyCode, transportId: intent.transportId, credentialLease, startScreen: 'OSRESS', signal: sessionSignal,
      cloudTargetKeys: savedTargetKeys(intent.propertyCode, recovery.confirmation, recovery.nativeStayId),
      ...(recovery.cloudTargetKey ? { cloudTargetKey: recovery.cloudTargetKey } : {}),
      prepareContext: (context) => installPaneAttachReadGuard(context, {
        propertyCode: intent.propertyCode, confirmation: recovery.confirmation, allowRealGuest: recovery.allowRealGuest === true,
        getNative: () => ref.current, getApprovedNativeIdentity: () => approvedNative.current,
      }) });
  } catch { return { outcome: 'unconfirmed' }; }
}

/** Stage the same native Documents form without arming or submitting an upload. */
export async function prepareCloudPaneAttach(input, { openSession = withCloudWriterSession,
  attach = attachLabtestDocument, shallow = readShallow, read = readRecord } = {}) {
  if (!validScope(input?.target?.propertyCode, input?.transportId) || !input.approvedSnapshot ||
      (input.approvedStay?.propertyCode && input.approvedStay.propertyCode !== input.target.propertyCode) ||
      typeof input.guestName !== 'string' || input.guestName !== `${input.approvedStay?.firstName} ${input.approvedStay?.lastName}` ||
      typeof input.documentName !== 'string' || input.documentName !== input.documentName.replace(/\s+/g, ' ').trim() ||
      !Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > 10 * 1024 * 1024 ||
      !input.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      createHash('sha256').update(input.bytes).digest('hex') !== input.pdfSha256) {
    return { outcome: 'refused_input' };
  }
  const code = documentCodeForUuid(randomUUID());
  const root = await mkdtemp(join(tmpdir(), 'pane-cloud-attach-prepare-'));
  const native = { current: null }, approvedNative = { current: null };
  const ownedPage = { current: null };
  const allowRealGuest = input.allowRealGuest === true && input.approvedStay?.allowRealGuest === true;
  try {
    const result = await openSession(async (page) => {
      ownedPage.current = page;
      await shallow(page, input.confirmation, lookupOptions(input.guestName, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.target.propertyCode, nativeIdentityOnly: true });
      const expected = approvedDocumentDispatch(record, { ...input.approvedStay, propertyCode: input.target.propertyCode }, input.approvedSnapshot);
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      approvedNative.current = snapshotApprovedNativeIdentity(record.nativePreimage);
      native.current = record.nativePreimage;
      return attach(page, expected, { name: input.documentName, documentCode: code,
        description: input.documentDescription ?? input.documentName, mimeType: 'application/pdf', bytes: input.bytes },
      { evidenceRoot: root, expectedDocumentContext: input.approvedSnapshot,
        strictNetwork: true, cloudGuarded: true, prepareOnly: true, timeoutMs: 5 * 60_000 });
    }, { propertyCode: input.target.propertyCode, transportId: input.transportId, credentialLease: input.credentialLease,
      startScreen: 'OSRESS', signal: phaseSignal(input.signal, 6 * 60_000),
      cloudTargetKeys: savedTargetKeys(input.target.propertyCode, input.confirmation, input.approvedStay?.nativeStayId),
      ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}),
      prepareContext: (context) => installPaneAttachReadGuard(context, {
        propertyCode: input.target.propertyCode, confirmation: input.confirmation, allowRealGuest,
        getOwnedPage: () => ownedPage.current, forwardToCloud: true,
        getNative: () => native.current, getApprovedNativeIdentity: () => approvedNative.current,
      }) });
    return result?.outcome === 'prepared' && result.documentCode === code &&
      result.documentName === input.documentName && result.description === (input.documentDescription ?? input.documentName)
      ? { outcome: 'prepared', documentCode: code } : { outcome: 'refused', issue: result?.issue };
  } catch {
    return { outcome: 'refused', issue: 'DOCUMENT_PREPARE_UNAVAILABLE' };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Caller holds the property lock and supplies a live server-side dispatch check. */
export async function runCloudPaneAttach(input, dependencies = {}) {
  const propertyCode = input?.target?.propertyCode;
  if (!validScope(propertyCode, input?.transportId)) return { outcome: 'refused_input', uploadSent: false, screenshots: [] };
  const execute = credentialLease => runCloudPaneAttachWithLease(input, { ...dependencies, credentialLease });
  return input.credentialLease ? execute(input.credentialLease) : withCloudCredentialLease(propertyCode, execute, { signal: input.signal });
}

async function runCloudPaneAttachWithLease(input, { openSession = withCloudWriterSession, openReadSession = withCloudReadSession,
  credentialLease,
  attach = attachLabtestDocument, freshRead = freshDocuments, shallow = readShallow, read = readRecord,
  readStoredDocumentBytes, writerIdentity = cloudWriterIdentity } = {}) {
  if (!validScope(input?.target?.propertyCode, input?.transportId) ||
      (input.approvedStay?.propertyCode && input.approvedStay.propertyCode !== input.target.propertyCode) ||
      typeof input.beforeDispatch !== 'function' ||
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
  const code = input.documentCode ?? documentCodeForUuid(randomUUID());
  if (!/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(code)) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    return { outcome: 'refused_input', uploadSent: false, screenshots: [] };
  }
  const allowRealGuest = input.allowRealGuest === true && input.approvedStay?.allowRealGuest === true;
  const approvedNative = { current: null };
  const baseSignal = credentialLease?.signal ? AbortSignal.any([input.signal, credentialLease.signal].filter(Boolean)) : input.signal;
  const writerSignal = phaseSignal(baseSignal, 10 * 60_000);
  const writerPage = { current: null };
  const options = (ref, timeout, signal = phaseSignal(baseSignal, timeout), writer = false) => ({ propertyCode: input.target.propertyCode,
    transportId: input.transportId, credentialLease, startScreen: 'OSRESS', signal,
    cloudTargetKeys: savedTargetKeys(input.target.propertyCode, input.confirmation, input.approvedStay?.nativeStayId),
    ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}),
    prepareContext: (context) => installPaneAttachReadGuard(context, {
      propertyCode: input.target.propertyCode, confirmation: input.confirmation, allowRealGuest,
      ...(writer ? { getOwnedPage: () => writerPage.current, forwardToCloud: true } : {}),
      getNative: () => ref.current, getApprovedNativeIdentity: () => approvedNative.current,
    }) });
  const writing = { current: null };
  let result, dispatched = false, attachAttempted = false, writerSessionClosed = false;
  try {
    result = await openSession(async (page) => {
      writerPage.current = page;
      await shallow(page, input.confirmation, lookupOptions(input.guestName, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.target.propertyCode, nativeIdentityOnly: true });
      const expected = approvedDocumentDispatch(record, { ...input.approvedStay, propertyCode: input.target.propertyCode }, input.approvedSnapshot);
      if (!expected) return { outcome: 'not_dispatched', issue: 'APPROVED_STAY_MISMATCH' };
      approvedNative.current = snapshotApprovedNativeIdentity(record.nativePreimage);
      writing.current = record.nativePreimage;
      attachAttempted = true;
      return attach(page, expected, { name: input.documentName, documentCode: code,
        description: input.documentDescription ?? input.documentName, mimeType: 'application/pdf', bytes },
      { evidenceRoot: root, expectedDocumentContext: input.approvedSnapshot,
        beforeDispatch: input.beforeDispatch, finalAuthority: () => input.finalAuthority(code),
        continuationAllowed: () => !writerSignal.aborted && input.continuationAllowed() === true,
        dispatchWithAuthority: (dispatch, requestDigest, beforeShot, intercepted) => {
          const writer = writerIdentity(page);
          if (!writer) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
          return input.dispatchWithAuthority(code, expected.guestId, expected.nativeStayId, requestDigest,
            dispatch, writer, beforeShot, intercepted);
        },
        onDispatched: () => { dispatched = true; }, strictNetwork: true, cloudGuarded: true, timeoutMs: 7 * 60_000 });
    }, options(writing, 10 * 60_000, writerSignal, true));
    writerSessionClosed = true;
  } catch {
    if (!attachAttempted && !dispatched) return { outcome: 'execution_failure', uploadSent: false, screenshots: [],
      dispatchCallbacksDrained: true, runDir: root, cleanupRoot: root };
    result = { outcome: 'uncertain', screenshots: [] };
  }
  if (!result || typeof result.outcome !== 'string') result = { outcome: 'uncertain', screenshots: [] };
  const evidence = evidenceLocation(result, root);
  const possible = dispatched || ['awaiting_readback', 'uncertain'].includes(result.outcome);
  if (!possible) {
    const nativeDiagnostics = safeNativeDiagnostics(result);
    return { outcome: result.issue || result.outcome, uploadSent: false,
      ...(nativeDiagnostics ? { nativeDiagnostics } : {}),
      ...evidence, writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
  }
  const byteReader = readStoredDocumentBytes !== undefined ? readStoredDocumentBytes
    : await defaultStoredDocumentBytesReader();
  let fresh;
  const reading = { current: null };
  try { if (!writerSessionClosed) throw new Error('HMS_WRITER_CLOSE_UNCONFIRMED');
    fresh = await openReadSession(async (page) => {
      const found = await freshRead(page, { ...input,
        approvedStay: { ...input.approvedStay, propertyCode: input.target.propertyCode } }, code, (native) => {
      reading.current = native;
      approvedNative.current = snapshotApprovedNativeIdentity(native);
    });
      const stored = found?.listed === true ? await verifyStoredDocumentBytes(page, byteReader,
        { propertyCode: input.target.propertyCode, confirmation: input.confirmation, documentCode: code,
          documentName: input.documentName,
          ...(input.documentDescription ? { documentDescription: input.documentDescription } : {}),
          nativeStayId: found?.nativeReadback?.nativeStayId ?? input.approvedStay?.nativeStayId,
          nativeGuestId: found?.nativeReadback?.nativeGuestId ?? input.approvedStay?.nativeGuestId },
        input.pdfSha256) : { actualStoredSha256: null, storedBytesHashVerified: false };
      return found && typeof found === 'object' ? { ...found, ...stored,
        ...(found.nativeReadback && typeof found.nativeReadback === 'object' ? { nativeReadback: { ...found.nativeReadback,
          ...(stored.actualStoredSha256 ? { actualStoredSha256: stored.actualStoredSha256 } : {}),
          ...(stored.storedBytesHashVerified ? { storedBytesHashVerified: true } : {}) } } : {}) } : found;
    },
    options(reading, 5 * 60_000)); } catch { /* Unknown remains fenced. */ }
  const listed = fresh?.listed;
  const nativeReadback = fresh?.nativeReadback;
  const storedVerified = fresh?.storedBytesHashVerified === true && fresh?.actualStoredSha256 === input.pdfSha256;
  if (listed === true && Buffer.isBuffer(fresh?.screenshot) && fresh.screenshot.length > 0 &&
      fresh.screenshot.length <= 10 * 1024 * 1024 && evidence.screenshots.length === 2) {
    await writeFile(evidence.screenshots[1], fresh.screenshot, { mode: 0o600 });
  } else if (listed === true) {
    return { outcome: 'uncertain', uploadSent: true, documentCode: code, ...evidence,
      listed, ...(nativeReadback ? { nativeReadback } : {}),
      actualStoredSha256: fresh?.actualStoredSha256 ?? null, storedBytesHashVerified: storedVerified,
      writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
  }
  // Owner's confirmation bar is a clean upload, a unique fresh listing and fresh
  // stored bytes whose independent SHA-256 equals the approved source. A listing,
  // a missing digest, a reader failure or a mismatched digest stays uncertain.
  const outcome = result.outcome === 'awaiting_readback' && listed === true && storedVerified ? 'confirmed'
    : listed === false ? 'upload_unconfirmed' : 'uncertain';
  return { outcome, uploadSent: true, documentCode: code, ...(listed === undefined ? {} : { listed }),
    ...(nativeReadback ? { nativeReadback } : {}),
    actualStoredSha256: fresh?.actualStoredSha256 ?? null, storedBytesHashVerified: storedVerified,
    ...evidence, writerSessionClosed, dispatchCallbacksDrained: result.dispatchCallbacksDrained === true };
}
