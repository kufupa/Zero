// Trusted outside-app adapters. Native writers own request fencing and independent readback.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCloudReadSession, cloudWriterCurrent, cloudWriterQuiesced } from './cloud-session.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';

const check = (value, issue) => { if (!value) throw new Error(issue); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => hash(a) === hash(b);
const nameParts = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase()
  .split(/[\s,]+/u).filter(Boolean).sort() : [];
const observed = () => new Date().toISOString();
const itemFields = ['code', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio',
  'comment', 'currency', 'totalCost'];
const values = item => Object.fromEntries(itemFields.map(key => [key, item?.[key]]));

function labtestPdf(propertyCode, sha) {
  const stream = `BT /F1 12 Tf 40 700 Td (Proof Labtest ${propertyCode} ${sha}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

async function writePrivate(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

function ownedNative(record, journal) {
  const own = journal.created, request = journal.effectiveRequest, native = record?.nativePreimage;
  const fields = record?.details?.fields;
  const field = name => {
    const matches = fields?.filter(value => value.name === name);
    check(matches?.length === 1, 'OWNED_STAY_FIELD_UNVERIFIED');
    return matches[0];
  };
  check(own?.freshReadbackVerified === true && native?.source === 'record_view_ext_model' &&
    native.propertyCode === journal.propertyCode && native.confirmation === own.confirmation &&
    native.reservationStayId === own.nativeStayId && native.guestId === own.guestId &&
    native.firstName === 'Proof' && native.lastName === 'Labtest' && native.status === 'Reserved' &&
    native.arrival >= '2027-01-01' && native.arrival === request.stay.arrival && native.departure === request.stay.departure &&
    native.roomType === request.room.roomType && native.ratePlan === request.room.ratePlan &&
    native.adults === request.stay.adults && native.children === request.stay.childAges.length &&
    native.guaranteeCode === request.guaranteeType &&
    (native.children === 0 || Array.isArray(native.childAges) &&
      equal([...native.childAges].sort((a, b) => a - b), [...request.stay.childAges].sort((a, b) => a - b))) &&
    field('udfchkbox04').value === false && field('reservationnote').rawValue === own.note, 'OWNED_STAY_UNVERIFIED');
  return native;
}

export async function runLabtestWorkflow({ workflow, journal, property, transportId, options, root, journalDir,
  checkHold, markPossible, record }) {
  const own = journal.created, propertyCode = property.propertyCode;
  const scope = { ...options, propertyCode, transportId, startScreen: 'OSRESS' };
  const readOwned = () => withCloudReadSession(async page => {
    await checkHold(options.signal);
    await readShallow(page, own.confirmation, { guestName: 'Proof Labtest', arrivalDate: journal.effectiveRequest.stay.arrival });
    const result = await readRecord(page, own.confirmation, { nativePropertyCode: propertyCode });
    ownedNative(result, journal);
    return result;
  }, { ...scope, prepareContext: context => installSavedStayReadGuard(context, { propertyCode, confirmation: own.confirmation }) });
  const initial = await readOwned(), selected = ownedNative(initial, journal);
  const startedAt = observed();
  const proof = { workflow, propertyCode, confirmation: own.confirmation, nativeStayId: own.nativeStayId,
    guestId: own.guestId, startedAt, prepared: null, result: null, dispatches: [] };
  const checkpoint = extra => record({ ...proof, ...extra });
  const claim = async evidence => {
    await checkHold(options.signal);
    await markPossible(`${workflow}_possible`, { workflowAttempt: { ...proof, dispatch: evidence } });
  };
  if (workflow === 'guest_profile_create') {
    const { createGuestProfileRunner } = await import('./guest-profile-runner.mjs');
    const { matchesProfileReadback, profileValuesEqual } = await import('./guest-profile-create.mjs');
    check(/^Proof[a-f0-9]{12}$/.test(journal.profileProofGuest?.firstName ?? '') &&
      journal.profileProofGuest.lastName === 'Labtest' && journal.profileProofGuest.email === '', 'PROFILE_PROOF_TARGET_INVALID');
    const business = { propertyCode, guest: journal.profileProofGuest, confirmDuplicateName: false };
    proof.business = business;
    proof.attemptId = randomUUID();
    const runner = createGuestProfileRunner({ runtimeDir: join(root, 'guest-profile-attempts'),
      sessionOptions: scope,
      authorizeStaffWrite: async context => {
        await checkHold(options.signal);
        return context.propertyCode === propertyCode && profileValuesEqual(context.fields, proof.prepared.businessFields) &&
          context.previewDigest === proof.prepared.previewDigest && context.confirmDuplicateName === false &&
          cloudWriterCurrent(context.writer);
      },
      dispatchStaffWrite: async (context, proceed) => {
        check(context.propertyCode === propertyCode && cloudWriterCurrent(context.writer) &&
          context.phase === 'initial', 'PROFILE_DISPATCH_UNVERIFIED');
        if (!proof.dispatches.length) await claim({ phase: context.phase });
        await checkHold(options.signal);
        proof.dispatches.push({ phase: context.phase, writer: context.writer });
        await checkpoint();
        await checkHold(options.signal);
        return proceed();
      } });
    proof.prepared = await runner.prepareGuestProfile(business);
    await checkpoint();
    check(proof.prepared.outcome === 'ready' && proof.prepared.native?.profileId === null &&
      /^[a-f0-9]{64}$/.test(proof.prepared.previewDigest ?? ''), 'PROFILE_PREPARE_UNVERIFIED');
    await checkHold(options.signal);
    await readOwned();
    proof.result = await runner.createGuestProfile({ ...business, attemptId: proof.attemptId,
      expectedPreviewDigest: proof.prepared.previewDigest,
      ...(proof.prepared.review ? { expectedReview: proof.prepared.review } : {}) });
    await checkpoint();
    check(proof.result.outcome === 'created' && proof.result.dispatched === true && proof.result.callbacksDrained === true &&
      proof.dispatches.length > 0 && proof.dispatches.every(dispatch => cloudWriterQuiesced(dispatch.writer)),
    'PROFILE_SAVE_UNVERIFIED');
    proof.readback = await runner.readGuestProfile({ propertyCode, nativeId: proof.result.nativeId, attemptId: proof.attemptId });
    check(matchesProfileReadback(proof.readback, proof.prepared.businessFields, proof.result.nativeId, proof.prepared.review),
      'PROFILE_READBACK_UNVERIFIED');
    proof.nativeGuestId = proof.result.nativeId;
  } else if (workflow === 'amend') {
    const { prepareCloudPaneAmend, commitCloudPaneAmend } = await import('./pane-amend-session.mjs');
    const fields = initial.details.fields;
    const field = name => {
      const matches = fields.filter(value => value.name === name);
      check(matches.length === 1 && typeof matches[0].value === 'string', 'AMEND_FIELD_UNVERIFIED');
      return matches[0].value;
    };
    check(selected.guaranteeCode === 'NGI', 'AMEND_LAB_GUARANTEE_UNSUPPORTED');
    const changes = { bookerContact: `Labtest amend ${randomUUID().slice(0, 8)}`,
      retainRates: 'yes', cmsSend: false, cmsMessageId: field('udfchar09'), cmsRecipient: field('udfchar13') };
    check(field('udfchar06') !== changes.bookerContact, 'AMEND_CHANGE_REQUIRED');
    proof.changes = changes;
    const input = { ...scope, target: { propertyCode, origin: property.origin },
      selected: { ...selected, childAges: [...journal.effectiveRequest.stay.childAges] },
      childAgePreimage: [...journal.effectiveRequest.stay.childAges], allowRealGuest: false,
      confirmation: own.confirmation, arrival: selected.arrival, changes,
      beforeScreenshot: join(journalDir, `${propertyCode}-amend-before.png`),
      afterScreenshot: join(journalDir, `${propertyCode}-amend-after.png`) };
    proof.prepared = await prepareCloudPaneAmend(input);
    await checkpoint();
    check(proof.prepared.outcome === 'prepared' && /^[a-f0-9]{64}$/.test(proof.prepared.nativeDigest ?? '') &&
      proof.prepared.preserved?.cmsSend === false, 'AMEND_PREPARE_UNVERIFIED');
    await readOwned();
    const operationDigest = hash({ propertyCode, confirmation: own.confirmation, nativeStayId: own.nativeStayId,
      changes, nativeDigest: proof.prepared.nativeDigest, approvedPrices: proof.prepared.approvedPrices,
      preserved: proof.prepared.preserved });
    proof.result = await commitCloudPaneAmend({ ...input, nativeDigest: proof.prepared.nativeDigest,
      approvedPrices: proof.prepared.approvedPrices, preserved: proof.prepared.preserved }, {
      operationDigest,
      isEnabled: () => !options.signal.aborted,
      sealBeforeEvidence: async () => {
        await checkHold(options.signal);
        check(!proof.beforeEvidence, 'AMEND_EVIDENCE_ALREADY_SEALED');
        proof.beforeEvidence = { eventId: randomUUID(), sha256: sha256(await readFile(input.beforeScreenshot)) };
        await checkpoint();
        return proof.beforeEvidence;
      },
      authorizeFirst: async step => {
        check(step.operationDigest === operationDigest && step.phase === 'amend.save' &&
          /^[a-f0-9]{64}$/.test(step.requestDigest ?? '') && proof.beforeEvidence && !proof.dispatches.length &&
          cloudWriterCurrent(step.writer), 'AMEND_DISPATCH_UNVERIFIED');
        await claim({ phase: step.phase, requestDigest: step.requestDigest });
        proof.dispatches.push({ phase: step.phase, requestDigest: step.requestDigest, writer: step.writer });
        await checkpoint();
        await checkHold(options.signal);
        return { holdId: randomUUID(), ownerToken: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '') };
      } });
    await checkpoint();
    check(proof.result.outcome === 'amended' && proof.result.writerSessionClosed === true &&
      proof.result.dispatchCallbacksDrained === true && proof.result.businessFieldsMatched === true &&
      proof.dispatches.length === 1 && cloudWriterQuiesced(proof.dispatches[0].writer), 'AMEND_SAVE_UNVERIFIED');
    proof.readback = proof.result.readback;
  } else if (workflow === 'attach') {
    const { prepareCloudPaneAttach, runCloudPaneAttach } = await import('./pane-attach-session.mjs');
    const bytes = labtestPdf(propertyCode, journal.sha), pdfSha256 = sha256(bytes);
    const file = join(journalDir, `${propertyCode}-proof-${randomUUID()}.pdf`);
    await writePrivate(file, bytes);
    const input = { ...scope, target: { propertyCode, origin: property.origin }, allowRealGuest: false,
      approvedStay: { propertyCode, confirmation: own.confirmation, nativeStayId: own.nativeStayId,
        nativeGuestId: own.guestId, firstName: 'Proof', lastName: 'Labtest', arrival: selected.arrival,
        departure: selected.departure, allowRealGuest: false },
      approvedSnapshot: { cmsSend: false }, confirmation: own.confirmation, arrival: selected.arrival,
      guestName: 'Proof Labtest', documentName: `${propertyCode}-Labtest-${randomUUID()}.pdf`, pdfSha256 };
    proof.document = { name: input.documentName, pdfSha256 };
    proof.prepared = await prepareCloudPaneAttach({ ...input, bytes });
    await checkpoint();
    check(proof.prepared.outcome === 'prepared', 'ATTACH_PREPARE_UNVERIFIED');
    await readOwned();
    proof.result = await runCloudPaneAttach({ ...input, file, documentCode: proof.prepared.documentCode,
      beforeDispatch: async () => { await checkHold(options.signal); return true; },
      finalAuthority: async code => {
        check(code === proof.prepared.documentCode, 'ATTACH_DOCUMENT_CHANGED');
        // The native writer reopens the stay; its active credential lease cannot host another session.
        await checkHold(options.signal);
        return sha256(await readFile(file)) === pdfSha256;
      },
      continuationAllowed: () => !options.signal.aborted,
      dispatchWithAuthority: async (code, guestId, stayId, requestDigest, proceed, writer) => {
        check(code === proof.prepared.documentCode && guestId === own.guestId && stayId === own.nativeStayId &&
          /^[a-f0-9]{64}$/.test(requestDigest ?? '') && cloudWriterCurrent(writer), 'ATTACH_DISPATCH_UNVERIFIED');
        await claim({ requestDigest });
        proof.dispatches.push({ requestDigest, writer });
        await checkpoint();
        await checkHold(options.signal);
        return proceed();
      } });
    await checkpoint();
    check(proof.result.outcome === 'confirmed' && proof.result.uploadSent === true &&
      proof.result.writerSessionClosed === true && proof.result.dispatchCallbacksDrained === true &&
      proof.dispatches.length === 1 && cloudWriterQuiesced(proof.dispatches[0].writer), 'ATTACH_SAVE_UNVERIFIED');
    proof.readback = proof.result.nativeReadback;
  } else if (workflow === 'addons') {
    const { withStay360AddOnSession } = await import('./stay360-addons-session.mjs');
    check(journal.proofRequest?.addons?.length === 1, 'ADDONS_EXPLICIT_ITEM_REQUIRED');
    const items = journal.proofRequest.addons.map(item => ({ ...item,
      startDate: selected.arrival, endDate: selected.arrival }));
    proof.items = items;
    let target;
    proof.result = await withStay360AddOnSession(async ({ runTool }) => {
      const read = await runTool({ tool: 'read', confirmation: own.confirmation, guestName: 'Proof Labtest', arrivalDate: selected.arrival });
      check(read.outcome === 'ok' && read.propertyCode === propertyCode && read.nativeStayId === own.nativeStayId &&
        read.target?.propertyCode === propertyCode && read.target?.confirmation === own.confirmation &&
        equal(nameParts(read.target?.guestName), nameParts(`${selected.firstName} ${selected.lastName}`)) &&
        read.coverage?.complete === true, 'ADDONS_TARGET_UNVERIFIED');
      target = read.target;
      proof.prepared = await runTool({ tool: 'prepare', confirmation: own.confirmation, items });
      await checkpoint();
      check(proof.prepared.outcome === 'prepared' && proof.prepared.saved === false &&
        proof.prepared.items?.length === 1, 'ADDONS_PREPARE_UNVERIFIED');
      return runTool({ tool: 'save', confirmation: own.confirmation, preparedId: proof.prepared.preparedId });
    }, { ...scope,
      withWriteLock: async (confirmation, save) => {
        check(confirmation === own.confirmation, 'ADDONS_LOCK_TARGET_CHANGED');
        await checkHold(options.signal);
        await readOwned();
        return save();
      },
      authorize: async prepared => {
        await checkHold(options.signal);
        return prepared.confirmation === own.confirmation && equal(prepared.target, target) &&
          equal(prepared.requestedItems, items) && equal(prepared.items, proof.prepared.items);
      },
      beforeDispatch: async (dispatch, writer) => {
        check(dispatch.confirmation === own.confirmation && dispatch.index === 0 && equal(dispatch.target, target) &&
          equal(dispatch.item, values(proof.prepared.items[0])) && cloudWriterCurrent(writer), 'ADDONS_DISPATCH_UNVERIFIED');
        await claim({ index: dispatch.index, item: dispatch.item });
        proof.dispatches.push({ index: dispatch.index, item: dispatch.item, writer });
        await checkpoint();
        await checkHold(options.signal);
        return true;
      },
      afterDispatch: async receipt => checkpoint({ receipt }) });
    await checkpoint();
    check(proof.result.outcome === 'saved' && proof.dispatches.length === 1 &&
      cloudWriterQuiesced(proof.dispatches[0].writer), 'ADDONS_SAVE_UNVERIFIED');
    proof.readback = proof.result.reconciliation?.readback;
  } else throw new Error('WORKFLOW_UNSUPPORTED');
  await readOwned();
  await checkHold(options.signal);
  return { ...proof, freshReadbackVerified: true, observedAt: observed() };
}

// Both runner and privileged installer validate the native receipts, not just a journal status.
export function verifyLabtestWorkflowProof(journal, workflow, proof) {
  const own = journal.created, readback = proof?.readback, result = proof?.result;
  check(proof?.workflow === workflow && proof.propertyCode === journal.propertyCode &&
    proof.confirmation === own.confirmation && proof.nativeStayId === own.nativeStayId && proof.guestId === own.guestId &&
    proof.freshReadbackVerified === true && proof.dispatches?.length > 0 &&
    Date.parse(proof.observedAt) >= Date.parse(proof.startedAt), 'WORKFLOW_PROOF_INVALID');
  if (workflow === 'guest_profile_create') {
    const firstName = proof.business?.guest?.firstName;
    const labtestDecision = firstName === 'Proof' && proof.business.confirmDuplicateName === true ||
      /^Proof[a-f0-9]{12}$/.test(firstName ?? '') && proof.business.confirmDuplicateName === false;
    check(proof.prepared?.outcome === 'ready' && result?.outcome === 'created' && result.dispatched === true &&
      result.callbacksDrained === true && /^\d{1,30}$/.test(proof.nativeGuestId ?? '') &&
      proof.business?.propertyCode === journal.propertyCode && labtestDecision &&
      proof.business.guest?.lastName === 'Labtest' && proof.business.guest?.email === '' &&
      /^[a-f0-9]{64}$/.test(proof.prepared.previewDigest ?? '') &&
      readback?.outcome === 'read' && readback.propertyCode === journal.propertyCode &&
      readback.nativeId === proof.nativeGuestId && result.nativeId === proof.nativeGuestId &&
      readback.firstName === firstName && readback.lastName === 'Labtest' &&
      readback.mobile === proof.business?.guest?.mobile && readback.email === '' && readback.status === 'ACTIVE' &&
      equal(readback.consent, [false, false, false, false]), 'PROFILE_PROOF_INVALID');
  } else {
    check(proof.prepared?.outcome === 'prepared' && readback?.confirmation === own.confirmation &&
      readback.nativeStayId === own.nativeStayId, 'STAY_PROOF_IDENTITY_INVALID');
    if (workflow === 'amend') {
      const selected = journal.effectiveRequest;
      check(result?.outcome === 'amended' && result.writerSessionClosed === true &&
        result.dispatchCallbacksDrained === true && result.businessFieldsMatched === true &&
        proof.dispatches.length === 1 && proof.dispatches[0].phase === 'amend.save' &&
        /^[a-f0-9]{64}$/.test(proof.dispatches[0].requestDigest ?? '') &&
        /^[a-f0-9]{64}$/.test(proof.beforeEvidence?.sha256 ?? '') &&
        /^[a-f0-9-]{36}$/i.test(proof.beforeEvidence?.eventId ?? '') &&
        readback.firstName === 'Proof' && readback.lastName === 'Labtest' &&
        readback.arrival === selected.stay.arrival && readback.departure === selected.stay.departure &&
        readback.roomType === selected.room.roomType && readback.ratePlan === selected.room.ratePlan &&
        readback.adults === selected.stay.adults && readback.children === selected.stay.childAges.length &&
        Array.isArray(readback.childAges) && equal([...readback.childAges].sort((a, b) => a - b),
          [...selected.stay.childAges].sort((a, b) => a - b)) &&
        readback.guaranteeType === selected.guaranteeType && readback.reservationNote === own.note &&
        typeof proof.changes?.bookerContact === 'string' && /^Labtest amend [a-f0-9]{8}$/.test(proof.changes.bookerContact) &&
        readback.bookerContact === proof.changes.bookerContact && readback.cmsSend === false &&
        readback.cmsMessageId === proof.prepared.preserved?.cmsMessageId &&
        readback.cmsRecipient === proof.prepared.preserved?.cmsRecipient, 'AMEND_PROOF_INVALID');
    } else if (workflow === 'attach') {
      check(result?.outcome === 'confirmed' && result.uploadSent === true && result.listed === true &&
        result.writerSessionClosed === true && result.dispatchCallbacksDrained === true &&
        readback.nativeGuestId === own.guestId && readback.uniqueFreshListing === true &&
        readback.documentCode === proof.prepared.documentCode && readback.documentName === proof.document?.name,
      'ATTACH_PROOF_INVALID');
    } else if (workflow === 'addons') {
      const reconciliation = result?.reconciliation, verified = reconciliation?.verified, receipts = result?.receipts;
      const prepared = proof.prepared.items?.[0];
      check(result?.outcome === 'saved' && result.requestedCount === 1 && proof.prepared.saved === false &&
        reconciliation?.outcome === 'verified' && reconciliation.mismatches?.length === 0 &&
        readback.propertyCode === journal.propertyCode && readback.coverage?.complete === true &&
        verified?.length === 1 && receipts?.length === 1 && typeof verified[0].nativeId === 'string' && verified[0].nativeId &&
        verified[0].nativeId === receipts[0].nativeId && equal(verified[0].item, values(prepared)) &&
        equal(receipts[0].item, verified[0].item) && !(result.baseline ?? [])
          .some(row => String(row.enhexpsequencekey) === verified[0].nativeId), 'ADDONS_PROOF_INVALID');
      const details = readback.details?.filter(detail => detail.nativeId === verified[0].nativeId);
      check(details?.length === 1 && details[0].fields?.itemId === prepared.itemId &&
        receipts[0].itemId === prepared.itemId && equal(values(details[0].fields), values(prepared)), 'ADDONS_DETAIL_UNVERIFIED');
    } else throw new Error('WORKFLOW_UNSUPPORTED');
  }
  return readback;
}
