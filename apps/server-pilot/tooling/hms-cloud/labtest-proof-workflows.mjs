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
const decimal = value => {
  const match = String(value ?? '').match(/^(\d+)(?:\.(\d+))?$/);
  return match ? `${match[1].replace(/^0+(?=\d)/, '')}.${(match[2] ?? '').replace(/0+$/, '')}` : null;
};
const isoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const AMEND_STAY_KEYS = ['arrival', 'departure', 'roomType', 'adults'];
const AMEND_COMBINED_KEYS = [...AMEND_STAY_KEYS, 'retainRates', 'cmsSend', 'cmsMessageId', 'cmsRecipient'];
const combinedAmendChanges = changes => changes && typeof changes === 'object' && !Array.isArray(changes) &&
  AMEND_STAY_KEYS.some(key => Object.hasOwn(changes, key));
// The owned stay starts at the immutable create preimage; a verified amendment
// moves only the business fields its fresh readback bound.
function labtestExpectedStay(journal) {
  const stay = journal.effectiveRequest?.stay, room = journal.effectiveRequest?.room;
  return { arrival: stay?.arrival, departure: stay?.departure, roomType: room?.roomType, adults: stay?.adults };
}
// The approved combined amendment: dates, room and adults must all change while
// every other business field stays preserved. Anything weaker is refused before staging.
function requestedCombinedAmend(journal) {
  const request = journal.proofRequest?.amend;
  if (request === undefined) return null;
  const stay = journal.effectiveRequest?.stay, room = journal.effectiveRequest?.room;
  const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : [];
  check(keys.every(key => AMEND_STAY_KEYS.includes(key)) && keys.includes('roomType') && keys.includes('adults') &&
    (keys.includes('arrival') || keys.includes('departure')) && stay && room, 'AMEND_REQUEST_INVALID');
  const arrival = request.arrival ?? stay.arrival, departure = request.departure ?? stay.departure;
  check(isoDay(arrival) && isoDay(departure) && arrival >= '2027-01-01' && arrival < departure &&
    /^[A-Z0-9]{1,12}$/.test(request.roomType ?? '') && Number.isInteger(request.adults) &&
    request.adults >= 1 && request.adults <= 16 &&
    (arrival !== stay.arrival || departure !== stay.departure) && request.roomType !== room.roomType &&
    request.adults !== stay.adults, 'AMEND_COMBINED_CHANGE_REQUIRED');
  return { arrival, departure, roomType: request.roomType, adults: request.adults };
}
// A repriced amendment requires the native average as well as the total.
function verifiedAmendPrice(prices, issue) {
  check(prices?.version === 2 && /^[A-Z]{3}$/.test(prices.currency ?? '') &&
    /^(?:0|[1-9]\d{0,13})$/.test(prices.totalCents ?? '') && /^(?:0|[1-9]\d{0,13})$/.test(prices.averageCents ?? ''), issue);
}

function nativeAddOnPreview(result) {
  const item = result?.outcome === 'prepared' && result.items?.length === 1 ? result.items[0]
    : result?.outcome === 'needs_input' && result.issue === 'ADDONS_PRICE_REQUIRED' ? result.preview : null;
  check(item?.status === 'VALID' && /^\d+$/.test(item.itemId ?? '') &&
    /^[A-Z]{3}$/.test(item.currency ?? '') && decimal(item.unitPrice) !== null &&
    decimal(item.totalCost) !== null, 'ADDONS_NATIVE_PRICE_UNVERIFIED');
  return item;
}

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

function ownedNative(record, journal, expected = labtestExpectedStay(journal)) {
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
    native.arrival >= '2027-01-01' && native.arrival === expected.arrival && native.departure === expected.departure &&
    native.roomType === expected.roomType && native.ratePlan === request.room.ratePlan &&
    native.adults === expected.adults && native.children === request.stay.childAges.length &&
    native.guaranteeCode === request.guaranteeType &&
    (native.children === 0 || Array.isArray(native.childAges) &&
      equal([...native.childAges].sort((a, b) => a - b), [...request.stay.childAges].sort((a, b) => a - b))) &&
    field('udfchkbox04').value === false && field('reservationnote').rawValue === own.note, 'OWNED_STAY_UNVERIFIED');
  return native;
}

export async function runLabtestWorkflow({ workflow, journal, property, transportId, options, root, journalDir,
  checkHold, markPossible, record }) {
  const own = journal.created, propertyCode = property.propertyCode;
  let expectedStay = labtestExpectedStay(journal);
  const priorAmend = journal.workflowProofs?.amend;
  if (combinedAmendChanges(priorAmend?.changes)) {
    const readback = verifyLabtestWorkflowProof(journal, 'amend', priorAmend);
    expectedStay = { arrival: readback.arrival, departure: readback.departure,
      roomType: readback.roomType, adults: readback.adults };
  }
  const scope = { ...options, propertyCode, transportId, startScreen: 'OSRESS' };
  const readOwned = () => withCloudReadSession(async page => {
    await checkHold(options.signal);
    await readShallow(page, own.confirmation, { guestName: 'Proof Labtest', arrivalDate: expectedStay.arrival });
    const result = await readRecord(page, own.confirmation, { nativePropertyCode: propertyCode });
    ownedNative(result, journal, expectedStay);
    return result;
  }, { ...scope, prepareContext: context => installSavedStayReadGuard(context, { propertyCode, confirmation: own.confirmation }) });
  const initial = await readOwned(), selected = ownedNative(initial, journal, expectedStay);
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
  } else if (workflow === 'amend' || workflow === 'amend_adults') {
    const { prepareCloudPaneAmend, commitCloudPaneAmend } = await import('./pane-amend-session.mjs');
    const fields = initial.details.fields;
    const field = name => {
      const matches = fields.filter(value => value.name === name);
      check(matches.length === 1 && typeof matches[0].value === 'string', 'AMEND_FIELD_UNVERIFIED');
      return matches[0].value;
    };
    check(selected.guaranteeCode === 'NGI', 'AMEND_LAB_GUARANTEE_UNSUPPORTED');
    const occupancy = workflow === 'amend_adults';
    const requested = occupancy ? null : requestedCombinedAmend(journal);
    if (occupancy) {
      verifyLabtestWorkflowProof(journal, 'amend', journal.workflowProofs?.amend);
      check(propertyCode === 'HRCEN' && selected.ratePlan === 'CMPRO' && selected.adults === 1 &&
        selected.children === 0, 'AMEND_OCCUPANCY_LAB_ONLY');
    }
    const changes = { ...(occupancy ? { adults: 2, retainRates: 'no' }
      : requested ? { arrival: requested.arrival, departure: requested.departure, roomType: requested.roomType,
        adults: requested.adults, retainRates: 'no' }
      : { bookerContact: `Labtest amend ${randomUUID().slice(0, 8)}`, retainRates: 'yes' }),
      cmsSend: false, cmsMessageId: field('udfchar09'), cmsRecipient: field('udfchar13') };
    if (!occupancy && !requested) check(field('udfchar06') !== changes.bookerContact, 'AMEND_CHANGE_REQUIRED');
    else proof.beforeBookerContact = field('udfchar06');
    proof.changes = changes;
    proof.preimage = selected;
    const input = { ...scope, target: { propertyCode, origin: property.origin },
      selected: { ...selected, childAges: [...journal.effectiveRequest.stay.childAges] },
      childAgePreimage: [...journal.effectiveRequest.stay.childAges], allowRealGuest: false,
      confirmation: own.confirmation, arrival: selected.arrival, changes,
      beforeScreenshot: join(journalDir, `${propertyCode}-${workflow}-before.png`),
      afterScreenshot: join(journalDir, `${propertyCode}-${workflow}-after.png`) };
    proof.prepared = await prepareCloudPaneAmend(input);
    await checkpoint();
    check(proof.prepared.outcome === 'prepared' && /^[a-f0-9]{64}$/.test(proof.prepared.nativeDigest ?? '') &&
      proof.prepared.preserved?.cmsSend === false, 'AMEND_PREPARE_UNVERIFIED');
    if (occupancy) check(proof.prepared.approvedPrices?.currency === 'ZAR' &&
      proof.prepared.approvedPrices.totalCents === '0', 'AMEND_OCCUPANCY_PRICE_UNVERIFIED');
    else if (requested) verifiedAmendPrice(proof.prepared.approvedPrices, 'AMEND_PRICE_UNVERIFIED');
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
        check(step.operationDigest === operationDigest && step.phase === (occupancy || requested ? 'amend.availability' : 'amend.save') &&
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
    if (occupancy || requested) expectedStay = { arrival: changes.arrival ?? selected.arrival,
      departure: changes.departure ?? selected.departure, roomType: changes.roomType ?? selected.roomType,
      adults: changes.adults ?? selected.adults };
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
    const requestedItems = journal.proofRequest.addons.map(item => ({ ...item,
      startDate: selected.arrival, endDate: selected.arrival }));
    const discoveryItems = requestedItems.map(({ unitPrice: _price, ...item }) => item);
    let target, items;
    proof.result = await withStay360AddOnSession(async ({ runTool }) => {
      const read = await runTool({ tool: 'read', confirmation: own.confirmation, guestName: 'Proof Labtest', arrivalDate: selected.arrival });
      check(read.outcome === 'ok' && read.propertyCode === propertyCode && read.nativeStayId === own.nativeStayId &&
        read.target?.propertyCode === propertyCode && read.target?.confirmation === own.confirmation &&
        equal(nameParts(read.target?.guestName), nameParts(`${selected.firstName} ${selected.lastName}`)) &&
        read.coverage?.complete === true, 'ADDONS_TARGET_UNVERIFIED');
      target = read.target;
      proof.priceDiscovery = await runTool({ tool: 'prepare', confirmation: own.confirmation, items: discoveryItems });
      const native = nativeAddOnPreview(proof.priceDiscovery);
      check(native.code === requestedItems[0].code && (requestedItems[0].unitPrice === undefined ||
        decimal(requestedItems[0].unitPrice) === decimal(native.unitPrice)), 'ADDONS_APPROVED_PRICE_CHANGED');
      proof.priceApproval = { source: 'native_preview', itemId: native.itemId, item: values(native) };
      items = requestedItems.map(item => ({ ...item, unitPrice: native.unitPrice }));
      proof.items = items;
      await checkpoint();
      proof.prepared = await runTool({ tool: 'prepare', confirmation: own.confirmation, items });
      await checkpoint();
      check(proof.prepared.outcome === 'prepared' && proof.prepared.saved === false &&
        proof.prepared.items?.length === 1 &&
        equal(values(proof.prepared.items[0]), proof.priceApproval.item) &&
        proof.prepared.items[0].itemId === proof.priceApproval.itemId, 'ADDONS_PREPARE_UNVERIFIED');
      return runTool({ tool: 'save', confirmation: own.confirmation, preparedId: proof.prepared.preparedId });
    }, { ...scope,
      withWriteLock: async (confirmation, save) => {
        check(confirmation === own.confirmation, 'ADDONS_LOCK_TARGET_CHANGED');
        await checkHold(options.signal);
        await readOwned();
        const fresh = await withStay360AddOnSession(async ({ runTool }) =>
          runTool({ tool: 'prepare', confirmation: own.confirmation, items: discoveryItems }), scope);
        const native = nativeAddOnPreview(fresh);
        check(native.itemId === proof.priceApproval.itemId && equal(values(native), proof.priceApproval.item),
          'ADDONS_APPROVED_PRICE_CHANGED');
        proof.priceRecheck = { itemId: native.itemId, item: values(native), observedAt: observed() };
        await checkpoint();
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
    if (workflow === 'amend' || workflow === 'amend_adults') {
      const selected = journal.effectiveRequest;
      const occupancy = workflow === 'amend_adults';
      const requested = occupancy ? null : requestedCombinedAmend(journal);
      check(result?.outcome === 'amended' && result.writerSessionClosed === true &&
        result.dispatchCallbacksDrained === true && result.businessFieldsMatched === true &&
        proof.dispatches.length === 1 && proof.dispatches[0].phase === (occupancy || requested ? 'amend.availability' : 'amend.save') &&
        /^[a-f0-9]{64}$/.test(proof.dispatches[0].requestDigest ?? '') &&
        /^[a-f0-9]{64}$/.test(proof.beforeEvidence?.sha256 ?? '') &&
        /^[a-f0-9-]{36}$/i.test(proof.beforeEvidence?.eventId ?? '') &&
        readback.firstName === 'Proof' && readback.lastName === 'Labtest' &&
        readback.ratePlan === selected.room.ratePlan &&
        readback.children === selected.stay.childAges.length &&
        Array.isArray(readback.childAges) && equal([...readback.childAges].sort((a, b) => a - b),
          [...selected.stay.childAges].sort((a, b) => a - b)) &&
        readback.guaranteeType === selected.guaranteeType && readback.reservationNote === own.note &&
        readback.cmsSend === false &&
        readback.cmsMessageId === proof.prepared.preserved?.cmsMessageId &&
        readback.cmsRecipient === proof.prepared.preserved?.cmsRecipient &&
        (occupancy ? readback.arrival === selected.stay.arrival && readback.departure === selected.stay.departure &&
          readback.roomType === selected.room.roomType && readback.adults === 2 &&
          journal.propertyCode === 'HRCEN' && selected.room.ratePlan === 'CMPRO' &&
          selected.stay.adults === 1 && proof.changes?.adults === 2 && proof.changes.retainRates === 'no' &&
          proof.prepared.approvedPrices?.currency === 'ZAR' && proof.prepared.approvedPrices.totalCents === '0' &&
          readback.bookerContact === proof.beforeBookerContact &&
          proof.beforeBookerContact === journal.workflowProofs?.amend?.changes?.bookerContact
          : requested ? readback.arrival === requested.arrival && readback.departure === requested.departure &&
          readback.roomType === requested.roomType && readback.adults === requested.adults &&
          proof.changes?.arrival === requested.arrival && proof.changes.departure === requested.departure &&
          proof.changes.roomType === requested.roomType && proof.changes.adults === requested.adults &&
          proof.changes.retainRates === 'no' && proof.changes.cmsSend === false &&
          typeof proof.changes.cmsMessageId === 'string' && typeof proof.changes.cmsRecipient === 'string' &&
          Object.keys(proof.changes).every(key => AMEND_COMBINED_KEYS.includes(key)) &&
          typeof proof.beforeBookerContact === 'string' && readback.bookerContact === proof.beforeBookerContact &&
          proof.preimage?.arrival === selected.stay.arrival && proof.preimage.departure === selected.stay.departure &&
          proof.preimage.roomType === selected.room.roomType && proof.preimage.adults === selected.stay.adults &&
          proof.prepared.preserved?.cmsSend === false &&
          proof.prepared.approvedPrices?.version === 2 &&
          /^[A-Z]{3}$/.test(proof.prepared.approvedPrices.currency ?? '') &&
          /^(?:0|[1-9]\d{0,13})$/.test(proof.prepared.approvedPrices.totalCents ?? '') &&
          /^(?:0|[1-9]\d{0,13})$/.test(proof.prepared.approvedPrices.averageCents ?? '') &&
          readback.price?.currency === proof.prepared.approvedPrices.currency &&
          readback.price?.totalCents === proof.prepared.approvedPrices.totalCents &&
          readback.price?.averageCents === proof.prepared.approvedPrices.averageCents
          : readback.arrival === selected.stay.arrival && readback.departure === selected.stay.departure &&
          readback.roomType === selected.room.roomType && readback.adults === selected.stay.adults &&
          typeof proof.changes?.bookerContact === 'string' && /^Labtest amend [a-f0-9]{8}$/.test(proof.changes.bookerContact) &&
          readback.bookerContact === proof.changes.bookerContact), 'AMEND_PROOF_INVALID');
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
        proof.priceApproval?.source === 'native_preview' && proof.priceApproval.itemId === prepared?.itemId &&
        equal(proof.priceApproval.item, values(prepared)) && proof.items?.[0]?.unitPrice === prepared?.unitPrice &&
        proof.priceRecheck?.itemId === prepared?.itemId && equal(proof.priceRecheck?.item, values(prepared)) &&
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

// Create evidence stays immutable; only a verified amendment can change the cleanup expectation.
export function labtestProofStayAdults(journal) {
  const amend = journal.workflowProofs?.amend, occupancy = journal.workflowProofs?.amend_adults;
  if (!amend && !occupancy) return journal.effectiveRequest.stay.adults;
  const adults = verifyLabtestWorkflowProof(journal, 'amend', amend).adults;
  return occupancy ? verifyLabtestWorkflowProof(journal, 'amend_adults', occupancy).adults : adults;
}
