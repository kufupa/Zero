import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { createReservation, REAL_GUEST_CREATE_AUTHORIZATION_HOLD } from './create-reservation.mjs';
import { normalizeCreateTrack } from '../playwright-quote/create-request.mjs';

const input = {
  mode: 'commit', propertyCode: 'HRCEN', guest: { profileId: '123' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [8, 12] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' }, guaranteeType: 'NGI', sourceOfBusiness: 'EMA',
  parties: { organizationId: '41' }, note: 'Synthetic proof',
  cms: { send: false },
};
const profile = { nativeId: '123', firstName: 'Proof', lastName: 'Labtest', email: 'response-only@example.test' };
const generatedNote = JSON.parse(readFileSync(new URL('./fixtures/generated-reservation-note.json', import.meta.url), 'utf8')).note;
const values = { guestid: '123', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
  arrivaldate: '15-MAR-2027', departuredate: '17-MAR-2027', adults: '2', children: '2', child1: '0', child2: '2', child3: '0',
  roomtype: 'DLXKNG', rateplan: 'BAR', sourceofbusinessdesc: 'E-Mail', company: 'Example Company',
  guaranteetype: 'Non-Guaranteed Individual', reservationnote: 'Synthetic proof', udfchkbox04: false, udfchar13: '', emailaddress: '' };
const nativePreimage = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1', guestId: '123',
  status: 'Reserved', firstName: 'Proof', lastName: 'Labtest', arrival: input.stay.arrival, departure: input.stay.departure,
  roomType: input.room.roomType, ratePlan: input.room.ratePlan, adults: 2, children: 2, guaranteeCode: 'NGI' };
const fields = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value, ...(name === 'reservationnote' ? { rawValue: value } : {}) }));

function harness(options = {}) {
  const calls = [], sources = [...Array.from({ length: 100 }, (_, i) => ({ nativeCode: `X${i}`, description: `Other ${i}` })),
    { nativeCode: 'EMA', description: 'E-Mail' }];
  let freshReads = 0, censuses = 0, sessionOptions;
  const partyFields = {};
  const partyDefaults = { organization: { nativeId: '41', name: 'Example Company' },
    agency: { nativeId: '99', name: 'Example Agency', city: 'Pretoria', referenceNumber: '123' },
    arAccount: { nativeId: '75', name: 'Example Account', accountNumber: 'AR-75', status: 'Active' } };
  const partySearch = (kind, request) => {
    const candidates = options.partyCandidates?.[kind] ?? [partyDefaults[kind]];
    return options.partySearches?.[kind] ?? { outcome: candidates.length ? 'matches' : 'no_match', searchId: `search-${kind}`,
      query: request.query, criteria: { query: request.query }, candidates, coverage: { loaded: candidates.length, possiblyTruncated: false },
      correlation: { verifiedFields: ['nativeId', 'name'] } };
  };
  const partySelect = (kind, request, display, form) => {
    const row = (options.partySearches?.[kind]?.candidates ?? options.partyCandidates?.[kind] ?? [partyDefaults[kind]]).find(({ nativeId }) => nativeId === request.nativeId);
    partyFields[form] = row?.name;
    return { outcome: 'selected_unsaved', nativeId: request.nativeId, searchId: request.searchId,
      nativeIdEvidence: 'form_change_response', [display]: row?.name, selectedField: { name: form, value: row?.name },
      ...(kind === 'agency' ? { agencyIataNumber: null, agencyReferenceNumberType: 'IATA',
        agencyReferenceEvidence: { iataNumber: 'response_grid_correlated', referenceNumberType: 'response_grid_correlated' } } : {}),
      ...(kind === 'arAccount' ? { nativeReadback: { araccountid: request.nativeId, araccountname: row?.name,
        arstatuscodedesc: 'Active' } } : {}),
      profileProofToken: 'token', ...options.partySelections?.[kind] };
  };
  const runTool = async (request) => {
    request = structuredClone(request);
    calls.push(request);
    switch (request.tool) {
      case 'searchGuestProfiles': return { outcome: options.profileSearchOutcome ?? 'matches', searchId: 'g', candidates: options.profiles || [profile],
        coverage: { loaded: (options.profiles || [profile]).length, possiblyTruncated: options.profileCoverageTruncated ?? false }, correlation: { verifiedFields: ['firstname', 'lastname'] } };
      case 'closeGuestProfilePicker': return options.close || { outcome: 'closed_unsaved' };
      case 'selectGuestProfile': return { outcome: 'selected_unsaved', nativeId: options.selectedGuestId ?? request.nativeId };
      case 'setGuestStayDate': return { outcome: 'updated_unsaved', actual: request.date, displayed: request.field === 'arrivalDate' ? '15-MAR-2027' : '17-MAR-2027' };
      case 'selectGuestStayDropdown':
        if (request.field === 'reasonForStay') { partyFields.reasonforstay = 'Business'; return { outcome: 'updated_unsaved', field: request.field,
          requested: request.value, actual: { value: request.value, display: 'Business' } }; }
        return request.field === 'guaranteeType' && options.guaranteeResult ? options.guaranteeResult : { outcome: 'updated_unsaved', field: request.field, requested: request.value,
        actual: request.field === 'adults' ? { value: options.actualAdults ?? 2, display: '2' } : { value: options.actualGuarantee ?? 'NGI', display: 'Non-Guaranteed Individual' }, profileProofToken: 'token' };
      case 'setGuestStayChildAges': return { outcome: 'updated_unsaved', actualChildAges: options.actualChildAges ?? request.childAges,
        requestedChildAges: request.childAges, ageBandCounts: request.childAges.length === 0
          ? { child1: 0, child2: 0, child3: 0 } : { child1: 0, child2: 2, child3: 0 }, profileProofToken: 'token' };
      case 'searchRoomTypes': return { outcome: 'matches', searchId: 'r', coverage: { complete: true, matchingLoaded: 101 }, candidates: [] };
      case 'inspectRoomRateCandidate': return { outcome: 'match', candidates: [{ code: 'DLXKNG' }] };
      case 'selectRoomType': return { outcome: 'selected_unsaved', selectedField: { value: options.selectedRoom ?? 'DLXKNG' } };
      case 'selectGuestStayRatePlan': return options.rateUnavailable ? { outcome: 'criteria_unavailable', issue: 'RATE_CRITERIA_UNAVAILABLE' }
        : { outcome: 'selected_unsaved', code: request.code };
      case 'searchGuestStaySourceBusiness': return { outcome: 'matches', searchId: 's', coverage: { loaded: sources.length, possiblyTruncated: false } };
      case 'inspectGuestStaySourceBusiness': return { outcome: 'ok', candidates: sources.slice(request.offset, request.offset + request.limit),
        hasMoreLoaded: request.offset + request.limit < sources.length };
      case 'selectGuestStaySourceBusiness': return { outcome: 'selected_unsaved', nativeCode: 'EMA', candidate: sources.at(-1),
        selectedField: { value: 'E-Mail' }, profileProofToken: 'token' };
      case 'searchOrganization': return partySearch('organization', request);
      case 'searchPrimaryBookingAgency': return partySearch('agency', request);
      case 'searchArAccount': return partySearch('arAccount', request);
      case 'selectOrganization': return partySelect('organization', request, 'displayedOrganization', 'company');
      case 'selectPrimaryBookingAgency': return partySelect('agency', request, 'displayedAgency', 'ta1');
      case 'selectArAccount': return partySelect('arAccount', request, 'displayedArAccount', 'araccountname');
      case 'closeGuestStayPartyPicker': return options.partyClose || { outcome: 'closed_unsaved' };
      case 'listCmsMessageIds': return { outcome: 'ok', searchId: 'cms', candidates: [{ code: '03', description: 'Test' }], coverage: { complete: null, loaded: 1 } };
      case 'closeCmsMessageIdPicker': return { outcome: 'closed_unsaved' };
      case 'selectCmsMessageId': partyFields.udfchar09 = request.code; return { outcome: 'updated_unsaved', field: 'cmsMessageId', requested: request.code, actual: request.code };
      case 'setCmsSendCheckbox': return { outcome: 'updated_unsaved', actual: false };
      case 'setGuestStayText':
        if (request.field === 'reservationNote') partyFields.reservationnote = request.value;
        if (request.field === 'bookerName') partyFields.caller = request.value;
        if (request.field === 'bookerContact') partyFields.udfchar06 = request.value;
        if (request.field === 'cmsRecipient') partyFields.udfchar13 = request.value;
        return { outcome: 'updated_unsaved', actual: request.value };
      case 'readGuestStayForm': return { outcome: 'ok', fields: fields(options.draft
        ? { ...options.draft, ...(partyFields.track !== undefined ? { track: partyFields.track } : {}) }
        : { ...values, ...partyFields }) };
      case 'saveNewLabtestStay':
        if (request.billingReference != null && sessionOptions?.beforeSaveScreenshot) await sessionOptions.beforeSaveScreenshot();
        return options.save || { outcome: 'saved_same_form', confirmation: '123456-1', requestSeen: true, arProfileId: '501',
          dispatchCallbacksDrained: true,
          ...(request.billingReference != null ? { billingReferenceStaged: true } : {}) };
      default: throw new Error(`unexpected call ${request.tool}`);
    }
  };
  return { calls, get freshReads() { return freshReads; }, get censuses() { return censuses; }, get sessionOptions() { return sessionOptions; }, options: {
    selectTrack: async (_page, code) => {
      calls.push({ tool: 'selectTrack', code });
      if (!options.trackUnchanged) partyFields.track = normalizeCreateTrack(code)?.display;
    },
    withSession: async (operation, options) => { sessionOptions = options; return operation({ runTool, page: { screenshot: async () => Buffer.from('private screenshot') },
      labtestPreimage: { preimageId: 'p' } }); },
    withSavedSession: async (operation) => {
      freshReads += 1;
      return operation({ runTool: async () => ({ outcome: 'ok', record: { nativePreimage: options.nativePreimage ?? nativePreimage,
        details: { fields: fields(options.record || values), captureScope: 'test' } } }) });
    },
    partyReadback: async (request) => options.partyReadback?.(request) ?? { outcome: 'verified' },
    census: async () => { censuses += 1; return { outcome: 'existing_matches', coverage: { complete: true }, sameArrival: [{ confirmation: '123456-1' }] }; },
  } };
}

test('unsupported commit requests, nested unknowns and explicit clears stop before session', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [change, fields] of [
    [{ price: 100, parties: { organizationId: '41', agencyId: '99' } }, ['price']],
    [{ guest: { ...input.guest, searchExtra: { nested: { unknown: null } } } }, ['guest.searchExtra.nested.unknown']],
    [{ stay: { ...input.stay, occupancy: { other: 1 } } }, ['stay.occupancy.other']],
    [{ cms: { send: false, messageId: null } }, ['cms.messageId']],
    [{ parties: { organizationId: null } }, ['parties.organizationId']],
    [{ sourceOfBusiness: null }, ['sourceOfBusiness']],
    [{ note: null }, ['note']],
    [{ cms: { send: true, recipient: null }, price: 2 }, ['cms.send', 'cms.recipient', 'price']],
    [{ booker: { name: 'Example', surprise: 'x' } }, ['booker.surprise']],
    [{ approval: { by: 'Owner', at: '2026-11-01T12:00:00Z', grantId: 'spoofed' } },
      ['approval.at', 'approval.by', 'approval.grantId']],
  ]) {
    const result = await createReservation({ ...input, ...change, mode: 'commit' }, { withSession: noSession });
    assert.equal(result.outcome, 'unsupported');
    assert.deepEqual(result.unsupportedFields.map(({ field }) => field).sort(), fields.sort());
  }
  assert.equal(sessions, 0);
});

test('staff-bound commit rechecks the staged native request before Save', async (t) => {
  const preparing = harness();
  const prepared = await createReservation({ ...input, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.match(prepared.requestBinding.digest, /^[0-9a-f]{64}$/);

  const authorizeCandidate = async () => true;
  let capturedEvidence;
  const dispatchCandidate = async (_request, next, evidence) => { capturedEvidence = evidence; return next(); };
  const committing = harness();
  const saved = await createReservation(input, { ...committing.options,
    expectedRequestDigest: prepared.requestBinding.digest, authorizeCandidate, dispatchCandidate });
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  assert.equal(committing.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
  assert.equal(committing.sessionOptions.authorizeCandidate, authorizeCandidate);
  assert.equal(await committing.sessionOptions.dispatchCandidate({}, async () => 'continued'), 'continued');
  assert.deepEqual(capturedEvidence.preimage, { preimageId: 'p' });
  assert.equal(capturedEvidence.beforeScreenshot, saved.screenshots.before);

  const changed = harness();
  const refusal = await createReservation(input, { ...changed.options,
    expectedRequestDigest: '0'.repeat(64), authorizeCandidate, dispatchCandidate });
  assert.equal(refusal.outcome, 'refused');
  assert.equal(refusal.issue, 'approved_request_changed');
  assert.equal(changed.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);

  const missingCallbacks = harness();
  const invalid = await createReservation(input, { ...missingCallbacks.options,
    expectedRequestDigest: prepared.requestBinding.digest });
  assert.equal(invalid.issue, 'SAVE_GUARD_CALLBACKS_INVALID');
  assert.equal(missingCallbacks.calls.length, 0);
});

test('generated multiline note remains exact from prepare to fenced save and fresh readback', async (t) => {
  const reviewed = { ...input, note: generatedNote };
  const preparing = harness();
  const prepared = await createReservation({ ...reviewed, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.equal(prepared.requestBinding.request.note, generatedNote);
  assert.equal(preparing.calls.find(({ tool, field }) => tool === 'setGuestStayText' && field === 'reservationNote').value, generatedNote);
  const committing = harness({ record: { ...values, reservationnote: generatedNote } });
  const saved = await createReservation(reviewed, { ...committing.options, expectedRequestDigest: prepared.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  assert.equal(committing.calls.find(({ tool }) => tool === 'saveNewLabtestStay').note, generatedNote);
  assert.deepEqual(saved.readback.mismatches, []);

  const changed = harness({ record: { ...values, reservationnote: generatedNote.replace('\n', ' ') } });
  const uncertain = await createReservation(reviewed, { ...changed.options, expectedRequestDigest: prepared.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (uncertain.screenshots?.before) t.after(() => rm(dirname(uncertain.screenshots.before), { recursive: true, force: true }));
  assert.equal(uncertain.outcome, 'uncertain');
  assert.ok(uncertain.readback.mismatches.some(({ field }) => field === 'note'));
});

test('staff-bound create requires drained callbacks, owned-session close, and an exact read-only fresh session', async (t) => {
  const prepared = await createReservation({ ...input, mode: 'prepare' }, harness().options);
  const dirs = new Set();
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const guards = { expectedRequestDigest: prepared.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() };
  for (const drain of [undefined, false, true]) {
    const run = harness({ save: { outcome: 'saved_same_form', confirmation: '123456-1', arProfileId: '501',
      ...(drain !== undefined ? { dispatchCallbacksDrained: drain } : {}) } });
    let readOptions;
    const freshSession = run.options.withSavedSession;
    run.options.withSavedSession = async (operation, options) => { readOptions = options; return freshSession(operation, options); };
    const result = await createReservation(input, { ...run.options, ...guards });
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    assert.deepEqual(readOptions, { readOnly: true, readOnlyConfirmation: '123456-1' });
    assert.equal(result.writerSessionClosed, true);
    assert.equal(result.outcome, drain === true ? 'saved' : 'uncertain');
    if (drain !== true) assert.equal(result.issue, 'save_callback_drain_unconfirmed');
  }
  const closing = harness();
  const withSession = closing.options.withSession;
  closing.options.withSession = async (...args) => { await withSession(...args); throw new Error('HMS_BROWSER_CLOSE_UNCONFIRMED'); };
  const result = await createReservation(input, { ...closing.options, ...guards });
  if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
  assert.equal(result.outcome, 'uncertain');
  assert.notEqual(result.writerSessionClosed, true);
  const wrongGuarantee = harness({ nativePreimage: { ...nativePreimage, guaranteeCode: 'GTDAGT' } });
  const mismatched = await createReservation(input, { ...wrongGuarantee.options, ...guards });
  if (mismatched.screenshots?.before) dirs.add(dirname(mismatched.screenshots.before));
  assert.equal(mismatched.outcome, 'uncertain');
  assert.ok(mismatched.readback.mismatches.some(({ field }) => field === 'guaranteeTypeCode'));
});

test('staff preview requires an explicit choice even when one profile matches', async () => {
  const run = harness();
  const result = await createReservation({ ...input, mode: 'prepare', guest: {
    search: { firstName: 'Proof', lastName: 'Labtest' },
  } }, { ...run.options, requireExplicitGuestSelection: true });
  assert.equal(result.outcome, 'needs_input');
  assert.equal(result.issue, 'guest_choice_required');
  assert.deepEqual(result.guestCandidates.map(({ nativeId }) => nativeId), ['123']);
  assert.equal(run.calls.some(({ tool }) => tool === 'selectGuestProfile'), false);
  assert.equal(run.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('staff preview stores its approved screenshot privately', async (t) => {
  const run = harness();
  const result = await createReservation({ ...input, mode: 'prepare' }, {
    ...run.options, capturePrepareScreenshot: true,
  });
  assert.equal(result.outcome, 'prepared');
  assert.match(result.requestBinding.digest, /^[0-9a-f]{64}$/);
  assert.match(result.screenshots.filled, /^\/tmp\/hms-cloud-create-[0-9a-f-]+\/filled\.png$/);
  t.after(() => rm(dirname(result.screenshots.filled), { recursive: true, force: true }));
  assert.equal((await stat(result.screenshots.filled)).mode & 0o777, 0o600);
  assert.equal(run.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('track and false guest opt-in match preview, native Save and fresh readback', async (t) => {
  const requested = { ...input, track: 'BAR', guestoptin4: false };
  const seen = { ...values, track: 'Best Available', guestoptin4: false };
  const preparing = harness({ draft: seen });
  const prepared = await createReservation({ ...requested, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.deepEqual(prepared.requestBinding.request.track, { lookupCode: 'BAR', display: 'Best Available' });
  assert.equal(prepared.requestBinding.request.guestOptIn, false);

  const committing = harness({ draft: seen, record: seen });
  const saved = await createReservation(requested, { ...committing.options,
    expectedRequestDigest: prepared.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  const save = committing.calls.find(({ tool }) => tool === 'saveNewLabtestStay');
  assert.equal(save.track, 'Best Available');
  assert.equal(save.guestOptIn, false);
  assert.deepEqual(saved.readback.mismatches, []);

  const changedTrack = harness({ draft: { ...seen, track: 'Corporate Rate' }, trackUnchanged: true });
  const refused = await createReservation(requested, changedTrack.options);
  assert.equal(refused.issue, 'requested_track_not_staged');
  assert.equal(changedTrack.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
  const selectedOptIn = harness();
  const unsupported = await createReservation({ ...requested, guestoptin4: true }, selectedOptIn.options);
  assert.equal(unsupported.issue, 'requested_fields_not_supported');
  assert.equal(selectedOptIn.calls.length, 0);

  const changedReadback = harness({ draft: seen, record: { ...seen, guestoptin4: true } });
  const uncertain = await createReservation(requested, changedReadback.options);
  if (uncertain.screenshots?.before) t.after(() => rm(dirname(uncertain.screenshots.before), { recursive: true, force: true }));
  assert.equal(uncertain.outcome, 'uncertain');
  assert.ok(uncertain.readback.mismatches.some(({ field }) => field === 'guestOptIn'));
});

test('stages the reviewed track when the rate supplied a different default', async (t) => {
  const request = { ...input, track: 'COR', guestoptin4: false };
  const initial = { ...values, track: 'Best Available', guestoptin4: false };
  const prepare = harness({ draft: initial });
  const preview = await createReservation({ ...request, mode: 'prepare' }, prepare.options);
  assert.equal(preview.outcome, 'prepared');
  assert.deepEqual(preview.requestBinding.request.track, { lookupCode: 'COR', display: 'Corporate Rate' });
  assert.deepEqual(prepare.calls.filter(({ tool }) => tool === 'selectTrack'), [{ tool: 'selectTrack', code: 'COR' }]);
  const commit = harness({ draft: initial, record: { ...initial, track: 'Corporate Rate' } });
  const saved = await createReservation(request, { ...commit.options, expectedRequestDigest: preview.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  assert.equal(commit.calls.find(({ tool }) => tool === 'saveNewLabtestStay').track, 'Corporate Rate');
  assert.deepEqual(saved.readback.mismatches, []);
});

test('booker and no-send CMS recipient survive native staging and fresh readback', async (t) => {
  const requested = { ...input, booker: { name: 'Staff Booker', contact: 'booker@example.test' },
    cms: { send: false, recipient: 'client@example.test' } };
  const seen = { ...values, caller: requested.booker.name, udfchar06: requested.booker.contact,
    udfchar13: requested.cms.recipient };
  const preparing = harness();
  const prepared = await createReservation({ ...requested, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.deepEqual(prepared.requestBinding.request.booker, requested.booker);
  assert.equal(prepared.requestBinding.request.cmsRecipient, requested.cms.recipient);
  assert.equal(prepared.requestBinding.request.sendHmsConfirmation.kind, 'never');

  const committing = harness({ record: seen });
  const saved = await createReservation(requested, { ...committing.options,
    expectedRequestDigest: prepared.requestBinding.digest,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  const save = committing.calls.find(({ tool }) => tool === 'saveNewLabtestStay');
  assert.deepEqual(save.booker, requested.booker);
  assert.equal(save.cmsRecipient, requested.cms.recipient);
  assert.deepEqual(saved.readback.mismatches, []);
  assert.ok(committing.calls.some(({ tool, checked }) => tool === 'setCmsSendCheckbox' && checked === false));

  const changedReadback = harness({ record: { ...seen, udfchar13: 'wrong@example.test' } });
  const uncertain = await createReservation(requested, changedReadback.options);
  if (uncertain.screenshots?.before) t.after(() => rm(dirname(uncertain.screenshots.before), { recursive: true, force: true }));
  assert.equal(uncertain.outcome, 'uncertain');
  assert.ok(uncertain.readback.mismatches.some(({ field }) => field === 'cmsRecipient'));
  const send = harness();
  const rejected = await createReservation({ ...requested, cms: { ...requested.cms, send: true } }, send.options);
  assert.equal(rejected.issue, 'sending_not_supported');
  assert.equal(send.calls.length, 0);
});

test('guarded Labtest commit saves once, verifies fresh readback and reconciles uncertainty', async (t) => {
  const dirs = new Set();
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = async (options = {}, change = {}) => {
    const fake = harness(options), result = await createReservation({ ...input, ...change }, fake.options);
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    return { fake, result };
  };
  const { fake, result } = await run();
  const noMetadata = harness();
  const withoutMetadata = await createReservation(input, noMetadata.options);
  if (withoutMetadata.screenshots?.before) dirs.add(dirname(withoutMetadata.screenshots.before));
  assert.equal(withoutMetadata.outcome, 'saved');
  assert.equal(noMetadata.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
  assert.equal(result.outcome, 'saved');
  assert.equal(result.warnings.filter(({ field, issue }) => field === 'stay.childAges' && issue === 'saved_record_exposes_age_bands_not_exact_ages').length, 1);
  assert.equal(result.approvalReady, false);
  assert.equal(result.confirmation, '123456-1');
  assert.deepEqual(result.appliedVerification, { visibleFields: true, childAges: 'at_selection_only', organizationId: 'at_selection_only' });
  assert.deepEqual(result.readback.mismatches, []);
  assert.equal(result.readback.partyProof.outcome, 'verified');
  assert.equal(fake.freshReads, 1);
  const saves = fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].preimageId, 'p');
  assert.equal(saves[0].organizationSelection.nativeId, '41');
  assert.equal(saves[0].createFieldProof.childAgeSelection.profileProofToken, 'token');
  assert.ok(fake.calls.some(({ tool, checked }) => tool === 'setCmsSendCheckbox' && checked === false));
  assert.match(result.screenshots.before, /^\/tmp\/hms-cloud-create-[0-9a-f-]{36}\//);
  assert.equal((await stat(dirname(result.screenshots.before))).mode & 0o777, 0o700);
  assert.equal((await stat(result.screenshots.before)).mode & 0o777, 0o600);
  assert.equal((await stat(result.screenshots.after)).mode & 0o777, 0o600);
  const mismatch = await run({ record: { ...values, rateplan: 'OTHER' } });
  assert.equal(mismatch.result.outcome, 'uncertain');
  assert.ok(mismatch.result.readback.mismatches.some(({ field }) => field === 'ratePlan'));
  const unknown = await run({ save: { outcome: 'uncertain', issue: 'SAVE_TIMEOUT', requestSeen: true } });
  assert.equal(unknown.result.outcome, 'uncertain');
  assert.equal(unknown.fake.censuses, 1);
  assert.equal(unknown.fake.freshReads, 1);
  assert.equal(unknown.fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
  assert.deepEqual(unknown.result.reconciliation.candidates[0].readback.mismatches, []);
  const gap = await run({ save: { outcome: 'input_gap', issue: 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED' } });
  assert.equal(gap.result.outcome, 'needs_input');
  assert.equal(gap.fake.censuses, 0);
  const refused = await run({ save: { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' } });
  assert.equal(refused.result.outcome, 'refused');
  assert.equal(refused.fake.censuses, 0);
  for (const draft of [{ ...values, guestid: '999' }, { ...values, arrivaldate: '16-MAR-2027' }]) {
    const changed = await run({ draft });
    assert.equal(changed.result.outcome, 'uncertain');
    assert.equal(changed.fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  }
});

test('agent guarantee is selected, bound, saved once and independently read back in simulation', async (t) => {
  const selection = { outcome: 'updated_unsaved', field: 'guaranteeType', requested: 'GTDAGT',
    actual: { value: 'GTDAGT', submitted: 'GTDAGT', display: 'Guaranteed By Agent' } };
  const agentValues = { ...values, guaranteetype: 'Guaranteed By Agent' };
  const nativePreimage = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1', guestId: '123',
    status: 'Reserved', firstName: 'Proof', lastName: 'Labtest', arrival: input.stay.arrival, departure: input.stay.departure,
    roomType: input.room.roomType, ratePlan: input.room.ratePlan, adults: 2, children: 2, guaranteeCode: 'GTDAGT' };
  const options = { guaranteeResult: selection, draft: agentValues, record: agentValues, nativePreimage };
  const preparing = harness(options);
  const prepared = await createReservation({ ...input, mode: 'prepare', guaranteeType: 'GTDAGT' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.equal(prepared.applied.guaranteeType, 'Guaranteed By Agent');
  assert.equal(prepared.requestBinding.request.guaranteeType, 'GTDAGT');
  assert.equal(preparing.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);

  const committing = harness(options);
  const saved = await createReservation({ ...input, guaranteeType: 'GTDAGT' }, committing.options);
  if (saved.screenshots?.before) t.after(() => rm(dirname(saved.screenshots.before), { recursive: true, force: true }));
  assert.equal(saved.outcome, 'saved');
  assert.deepEqual(saved.readback.mismatches, []);
  const calls = committing.calls.filter(({ tool }) => tool === 'saveNewLabtestStay');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].guaranteeSelection, selection);
  assert.ok(committing.calls.some(({ tool, checked }) => tool === 'setCmsSendCheckbox' && checked === false));

  // An agency ID alone cannot select a party without the required name query.
  const idOnly = harness(options);
  const held = await createReservation({ ...input, guaranteeType: 'GTDAGT', parties: { agencyId: '99' } }, idOnly.options);
  assert.equal(held.outcome, 'needs_input');
  assert.ok(held.missing.includes('parties.agencyName'));
  assert.equal(idOnly.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);

  // The same visible label is not proof of the saved native code, with or without a party.
  for (const parties of [{}, { agencyId: '99', agencyName: 'Example' }, { organizationId: '41' }]) {
    const partyValues = { ...agentValues, company: parties.organizationId ? 'Example Company' : '',
      ...(parties.agencyId ? { ta1: 'Example Agency' } : {}) };
    const matching = harness({ ...options, draft: partyValues, record: partyValues, nativePreimage });
    const verified = await createReservation({ ...input, guaranteeType: 'GTDAGT', parties }, matching.options);
    if (verified.screenshots?.before) t.after(() => rm(dirname(verified.screenshots.before), { recursive: true, force: true }));
    assert.equal(verified.outcome, 'saved');
    assert.equal(matching.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
    for (const proof of [null, { ...nativePreimage, guaranteeCode: 'NGI' }, { ...nativePreimage, guestId: '999' }]) {
      const fake = harness({ ...options, draft: partyValues, record: partyValues, nativePreimage: proof });
      const uncertain = await createReservation({ ...input, guaranteeType: 'GTDAGT', parties }, fake.options);
      if (uncertain.screenshots?.before) t.after(() => rm(dirname(uncertain.screenshots.before), { recursive: true, force: true }));
      assert.equal(uncertain.outcome, 'uncertain');
      assert.ok(uncertain.readback?.mismatches?.some(({ field }) => field === 'guaranteeTypeCode'));
      assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
    }
  }

  const mismatch = harness({ ...options, guaranteeResult: { ...selection, actual: { ...selection.actual, submitted: 'NGI' } } });
  const refused = await createReservation({ ...input, guaranteeType: 'GTDAGT' }, mismatch.options);
  assert.equal(refused.outcome, 'uncertain');
  assert.equal(refused.issue, 'requested_field_not_staged');
  assert.equal(mismatch.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
});

test('real profiles and blocked preimages do not reach save', async () => {
  const fake = harness({ profiles: [{ ...profile, firstName: 'Real' }] });
  let consumeCalls = 0;
  const real = await createReservation(input, { ...fake.options,
    consumeApproval: async () => { consumeCalls += 1; return { consumed: true }; } });
  assert.equal(real.outcome, 'refused');
  assert.equal(real.issue, REAL_GUEST_CREATE_AUTHORIZATION_HOLD);
  assert.equal(consumeCalls, 0);
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  const preimage = { outcome: 'existing_matches', sameArrival: [{ confirmation: '123456-1' }], coverage: { complete: true } };
  const blocked = await createReservation(input, { withSession: async () => {
    throw Object.assign(new Error('LABTEST_PREIMAGE_NOT_CLEAR'), { phase: 'labtest_preimage', labtestPreimage: preimage });
  } });
  assert.equal(blocked.outcome, 'needs_input');
  assert.deepEqual(blocked.preimage, preimage);
});

test('real guest searches hold before any session without trusted create approval', async () => {
  let sessions = 0, consumeCalls = 0;
  const result = await createReservation({ ...input, guest: { search: { firstName: 'Real', lastName: 'Guest' } } }, {
    withSession: async () => { sessions += 1; throw new Error('unexpected session'); },
    consumeApproval: async () => { consumeCalls += 1; return { consumed: true }; },
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.issue, REAL_GUEST_CREATE_AUTHORIZATION_HOLD);
  assert.equal(result.approvalReady, false);
  assert.equal(sessions, 0);
  assert.equal(consumeCalls, 0);
});

test('supported inputs stage without claiming approval readiness', async () => {
  const fake = harness();
  const result = await createReservation({ ...input, mode: 'prepare' }, fake.options);
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.issue, undefined);
  assert.equal(result.approvalReady, false);
  assert.deepEqual(result.missing, []);
  assert.equal(result.applied.guest.nativeId, '123');
  assert.deepEqual(result.applied.childAges, [8, 12]);
  assert.equal(result.applied.note, 'Synthetic proof');
  assert.equal(result.applied.organization.nativeId, '41');
  assert.equal(result.appliedVerification.visibleFields, true);
  assert.equal(result.applied.guaranteeType, 'Non-Guaranteed Individual');
  assert.equal(result.requestBinding.request.guest.nativeId, '123');
  assert.equal(result.requestBinding.request.room.ratePlan, 'BAR');
  assert.equal(result.requestBinding.request.sendHmsConfirmation.kind, 'never');
  assert.match(result.requestBinding.digest, /^[a-f0-9]{64}$/);
  assert.ok(result.warnings.some(({ field, issue }) => field === 'stay.childAges' && issue === 'saved_record_exposes_age_bands_not_exact_ages'));
  assert.ok(result.warnings.some(({ field, issue }) => field === 'sourceOfBusiness' && issue === 'native_code_not_exposed_on_form_or_saved_record'));
  assert.deepEqual(fake.calls.filter(({ tool }) => tool === 'inspectGuestStaySourceBusiness').map(({ offset }) => offset), [0, 100]);
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
});

test('prepare does not bind a billing reference before its guarded save-time staging and readback', async () => {
  const fake = harness();
  const result = await createReservation({ ...input, mode: 'prepare', billingReference: 'INV-123',
    parties: { organizationId: '41', arAccountId: '75', arAccountName: 'Example Account' } }, fake.options);
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.requestBinding, undefined);
  assert.ok(result.unsupportedFields.some(({ field, issue }) => field === 'billingReference' && issue === 'commit_only'));
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('prepare reports an unstaged guarantee without claiming the draft is complete', async () => {
  const realProfile = { ...profile, firstName: 'Real', lastName: 'Guest' };
  const fake = harness({ profiles: [realProfile], draft: { ...values, firstname: 'Real', lastname: 'Guest' } });
  const result = await createReservation({ ...input, mode: 'prepare' }, fake.options);
  assert.equal(result.outcome, 'needs_input');
  assert.ok(result.missing.includes('guaranteeType.staging'));
  assert.equal(result.applied.note, input.note);
  assert.equal(result.applied.guest.firstName, 'Real');
  assert.equal(result.requestBinding, undefined);
  assert.equal(fake.calls.some(({ tool, field }) => tool === 'selectGuestStayDropdown' && field === 'guaranteeType'), false);
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('safe guarantee refusal keeps prepare useful but never permits commit', async () => {
  const guaranteeResult = { outcome: 'unsupported', issue: 'GUARANTEE_DRAFT_UNSUPPORTED' };
  const preparing = harness({ guaranteeResult });
  const prepared = await createReservation({ ...input, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'needs_input');
  assert.ok(prepared.missing.includes('guaranteeType.staging'));
  assert.ok(prepared.warnings.some(({ field, issue }) => field === 'guaranteeType' && issue === 'GUARANTEE_DRAFT_UNSUPPORTED'));
  assert.equal(prepared.applied.note, input.note);
  assert.equal(prepared.appliedVerification.visibleFields, true);
  assert.equal(preparing.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);

  const committing = harness({ guaranteeResult });
  const refused = await createReservation(input, committing.options);
  assert.equal(refused.outcome, 'needs_input');
  assert.equal(refused.issue, 'GUARANTEE_DRAFT_UNSUPPORTED');
  assert.equal(committing.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('unknown ages differ from known zero and contradictions never reach session', async () => {
  for (const childAges of [undefined, null]) {
    const fake = harness();
    const stay = { ...input.stay };
    if (childAges === undefined) delete stay.childAges; else stay.childAges = childAges;
    const result = await createReservation({ ...input, stay }, fake.options);
    assert.equal(result.outcome, 'needs_input');
    assert.ok(result.missing.includes('stay.childAges'));
    assert.equal(fake.calls.length, 0);
  }
  const fake = harness({ draft: { ...values, children: '0', child1: '0', child2: '0', child3: '0' } });
  const zero = await createReservation({ ...input, mode: 'prepare', stay: { ...input.stay, childAges: [], childCount: 0 } }, fake.options);
  assert.deepEqual(zero.applied.childAges, []);
  assert.equal(zero.appliedVerification.visibleFields, true);
  const conflict = await createReservation({ ...input, stay: { ...input.stay, childCount: 1 } }, fake.options);
  assert.equal(conflict.issue, 'child_count_conflict');
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
});

test('unsafe inputs and wrong staged values do not become approval ready', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [change, outcome, issue] of [
    [{ cms: { send: true } }, 'unsupported', 'sending_not_supported'],
    [{ guaranteeType: 'GTDCC' }, 'refused', 'guarantee_not_supported_yet'],
    [{ guest: { search: { lastName: 'Real' } } }, 'refused', REAL_GUEST_CREATE_AUTHORIZATION_HOLD],
    [{ room: { ...input.room, ratePlan: 'BAR-1' } }, 'refused', 'native_code_not_supported_yet'],
    [{ guest: [] }, 'needs_input', 'invalid_field_type'],
  ]) {
    const result = await createReservation({ ...input, ...change }, { withSession: noSession });
    assert.equal(result.outcome, outcome);
    assert.equal(result.issue, issue);
  }
  assert.equal(sessions, 0);
  const guaranteeDraft = harness();
  const unsupportedGuarantee = await createReservation({ ...input, mode: 'prepare', guaranteeType: 'GTDCC' }, guaranteeDraft.options);
  assert.equal(unsupportedGuarantee.outcome, 'unsupported');
  assert.equal(unsupportedGuarantee.issue, 'guarantee_not_supported_yet');
  assert.equal(unsupportedGuarantee.applied.note, input.note);
  assert.equal(unsupportedGuarantee.approvalReady, false);
  assert.equal(guaranteeDraft.calls.some(({ tool, field }) => tool === 'selectGuestStayDropdown' && field === 'guaranteeType'), false);
  const fake = harness({ actualChildAges: [7, 12] });
  const changed = await createReservation({ ...input, mode: 'prepare' }, fake.options);
  assert.equal(changed.outcome, 'uncertain');
  assert.equal(changed.issue, 'requested_field_not_staged');
  assert.equal(changed.field, 'stay.childAges');
  assert.equal(changed.approvalReady, false);
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  for (const [options, field] of [
    [{ actualAdults: 3 }, 'stay.adults'],
    [{ selectedRoom: 'OTHER' }, 'room.roomType'],
    [{ selectedGuestId: '999' }, 'guest'],
    [{ actualGuarantee: 'OTHER' }, 'guaranteeType'],
  ]) {
    const staged = harness(options);
    const result = await createReservation({ ...input, mode: 'prepare' }, staged.options);
    assert.equal(result.issue, 'requested_field_not_staged');
    assert.equal(result.field, field);
    assert.equal(result.approvalReady, false);
    assert.equal(staged.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  }
  const checked = harness({ draft: { ...values, udfchkbox04: true } });
  const sendMismatch = await createReservation({ ...input, mode: 'prepare' }, checked.options);
  assert.equal(sendMismatch.issue, 'draft_readback_mismatch');
  assert.equal(sendMismatch.field, 'udfchkbox04');
});

test('ambiguous identity and unavailable rate retain useful preparation evidence', async () => {
  const unresolved = harness({ profiles: [profile, { ...profile, nativeId: '124' }] });
  const continued = await createReservation({ ...input, mode: 'prepare', guest: { search: { lastName: 'Labtest' } } }, unresolved.options);
  assert.equal(continued.issue, 'guest_ambiguous');
  assert.ok(continued.missing.includes('guest'));
  assert.deepEqual(continued.guestCandidates.map((item) => item.nativeId), ['123', '124']);
  assert.equal(continued.applied.note, 'Synthetic proof');
  assert.equal(continued.applied.organization.nativeId, '41');
  assert.equal(continued.appliedVerification.visibleFields, true);
  assert.ok(unresolved.calls.some(({ tool }) => tool === 'closeGuestProfilePicker'));
  assert.equal(unresolved.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  const email = harness();
  const unverifiedEmail = await createReservation({ ...input, mode: 'prepare', guest: {
    search: { lastName: 'Labtest', email: 'response-only@example.test' },
  } }, email.options);
  assert.equal(unverifiedEmail.issue, 'guest_email_unverified');
  assert.deepEqual(unverifiedEmail.guestCorrelation.verifiedFields, ['firstname', 'lastname']);
  assert.equal(email.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  const stuck = harness({ profiles: [], close: { outcome: 'close_uncertain' } });
  const closed = await createReservation({ ...input, mode: 'prepare' }, stuck.options);
  assert.equal(closed.outcome, 'uncertain');
  assert.equal(stuck.calls.filter(({ tool }) => tool === 'setGuestStayText').length, 0);
  const partial = harness({ rateUnavailable: true });
  const prepared = await createReservation({ ...input, mode: 'prepare', room: { ...input.room, ratePlan: 'BAR-1' } }, partial.options);
  assert.equal(prepared.outcome, 'needs_input');
  assert.ok(prepared.missing.includes('room.ratePlanCriteria'));
  assert.ok(!prepared.missing.includes('room.ratePlan'));
  assert.equal(prepared.applied.guest.nativeId, '123');
  assert.equal(prepared.applied.note, 'Synthetic proof');
  assert.equal(partial.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
});


test('prepare stages supported partial fields while retaining unsupported values and clears', async () => {
  for (const [change, unsupported] of [
    [{ guaranteeType: 'GTDCC', price: 100, parties: { organizationId: '41', agencyId: '99' } },
      ['guaranteeType', 'price']],
    [{ guest: { ...input.guest, searchExtra: { nested: { unknown: null } } } }, ['guest.searchExtra.nested.unknown']],
    [{ stay: { ...input.stay, occupancy: { other: 1 } } }, ['stay.occupancy.other']],
    [{ cms: { send: false, messageId: null } }, ['cms.messageId']],
    [{ parties: { organizationId: null } }, ['parties.organizationId']],
    [{ sourceOfBusiness: null }, ['sourceOfBusiness']],
    [{ note: null }, ['note']],
    [{ cms: { send: true, recipient: null }, price: 2 }, ['cms.send', 'cms.recipient', 'price']],
    [{ booker: { name: 'Example', surprise: 'x' } }, ['booker.surprise']],
  ]) {
    const fake = harness();
    const result = await createReservation({ ...input, ...change, mode: 'prepare' }, fake.options);
    assert.equal(result.outcome, 'unsupported');
    assert.equal(result.approvalReady, false);
    assert.equal(result.appliedVerification.visibleFields, true);
    assert.equal(result.applied.guest.nativeId, '123');
    assert.deepEqual(result.unsupportedFields.map(({ field }) => field).sort(), unsupported.sort());
    if (change.note === null) {
      assert.equal(Object.hasOwn(result.applied, 'note'), false);
      assert.equal(fake.calls.some(({ tool, field }) => tool === 'setGuestStayText' && field === 'reservationNote'), false);
    }
    assert.equal(fake.calls.some(({ tool, field }) => tool === 'selectGuestStayDropdown' && field === 'guaranteeType'), change.guaranteeType !== 'GTDCC');
    assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay' || tool === 'setCmsSendCheckbox'), false);
    assert.equal(fake.freshReads, 0);
  }
});

test('prepare retains supported notes when required fields and an optional value are missing', async () => {
  const fake = harness();
  const result = await createReservation({ mode: 'prepare', propertyCode: 'HRCEN',
    note: 'Synthetic proof', guaranteeType: 'GTDCC', billingReference: null }, fake.options);
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.approvalReady, false);
  assert.equal(result.applied.note, 'Synthetic proof');
  assert.equal(result.appliedVerification.visibleFields, true);
  assert.ok(result.missing.includes('guest'));
  assert.ok(result.missing.includes('stay.arrival'));
  assert.ok(result.missing.includes('room.roomType'));
  assert.deepEqual(result.unsupportedFields.map(({ field }) => field).sort(), ['billingReference', 'guaranteeType']);
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('conflicting prepare inputs still report unsupported requested values', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; };
  for (const [change, issue] of [
    [{ stay: { ...input.stay, childCount: 1 } }, 'child_count_conflict'],
    [{ guest: { profileId: '123', search: { lastName: 'Labtest' } } }, 'guest_identity_conflict'],
  ]) {
    const result = await createReservation({ ...input, ...change, mode: 'prepare', price: 100 }, { withSession: noSession });
    assert.equal(result.issue, issue);
    assert.deepEqual(result.unsupportedFields, [{ field: 'price', issue: 'not_settable_yet' }]);
    assert.equal(result.approvalReady, false);
  }
  assert.equal(sessions, 0);
});


test('prepare stages explicit agency, organization and A/R from the same picker searches', async () => {
  const fake = harness();
  const parties = { organizationId: '41', agencyName: 'Example', agencyId: '99', arAccountName: 'Example', arAccountId: '75' };
  const result = await createReservation({ ...input, mode: 'prepare', parties }, fake.options);
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.approvalReady, false);
  assert.deepEqual(result.applied.agency, { nativeId: '99', name: 'Example Agency' });
  assert.deepEqual(result.applied.arAccount, { nativeId: '75', name: 'Example Account' });
  assert.equal(result.applied.organization.nativeId, '41');
  assert.equal(result.partySearches.agency.candidates[0].city, 'Pretoria');
  assert.equal(result.partySearches.agency.candidates[0].referenceNumber, '123');
  assert.equal(result.partySearches.arAccount.candidates[0].accountNumber, 'AR-75');
  assert.equal(result.partySearches.arAccount.coverage.possiblyTruncated, false);
  assert.deepEqual(result.partySearches.arAccount.selection.nativeReadback,
    { araccountid: '75', araccountname: 'Example Account', arstatuscodedesc: 'Active' });
  assert.equal(result.partySearches.agency.selection.agencyIataNumber, null);
  assert.equal(result.partySearches.agency.selection.agencyReferenceEvidence.iataNumber, 'response_grid_correlated');
  assert.equal(result.appliedVerification.agencyId, 'at_selection_only');
  assert.equal(result.appliedVerification.arAccountId, 'at_selection_only');
  for (const [tool, searchId, nativeId] of [['selectOrganization', 'search-organization', '41'],
    ['selectPrimaryBookingAgency', 'search-agency', '99'], ['selectArAccount', 'search-arAccount', '75']]) {
    assert.ok(fake.calls.some((call) => call.tool === tool && call.searchId === searchId && call.nativeId === nativeId));
  }
  assert.ok(fake.calls.findIndex(({ tool, field }) => tool === 'selectGuestStayDropdown' && field === 'guaranteeType') <
    fake.calls.findIndex(({ tool }) => tool === 'selectPrimaryBookingAgency'));
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('prepare preserves ambiguous and truncated search evidence without automatic selection', async () => {
  const cases = [
    { candidates: [], truncated: false, issue: 'no_matches' },
    { candidates: [{ nativeId: '99', name: 'Example Agency' }], truncated: false, issue: 'explicit_selection_required' },
    { candidates: [{ nativeId: '99', name: 'Example Agency' }, { nativeId: '98', name: 'Example Agency' }], truncated: true, issue: 'explicit_selection_required' },
    { candidates: [], truncated: true, issue: 'results_incomplete' },
  ];
  for (const { candidates, truncated, issue } of cases) {
    const fake = harness({ partySearches: { agency: { outcome: candidates.length ? 'matches' : 'no_match', searchId: 'current', candidates,
      coverage: { loaded: candidates.length, possiblyTruncated: truncated } } } });
    const result = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', arAccountName: 'Example', arAccountId: '75' } }, fake.options);
    assert.equal(result.outcome, 'needs_input');
    assert.equal(result.partySearches.agency.issue, issue);
    assert.deepEqual(result.partySearches.agency.candidates, candidates);
    assert.equal(result.partySearches.agency.coverage.possiblyTruncated, truncated);
    assert.ok(result.missing.includes('parties.agencyId'));
    assert.equal(result.applied.arAccount.nativeId, '75');
    assert.equal(result.applied.note, input.note);
    assert.equal(fake.calls.some(({ tool }) => tool === 'selectPrimaryBookingAgency'), false);
    assert.equal(fake.calls.filter(({ tool }) => tool === 'closeGuestStayPartyPicker').length, 1);
  }
});

test('prepare resolves parties independently and refuses stale or mismatched selections', async () => {
  const unresolved = harness({ partyCandidates: { organization: [{ nativeId: '41', name: 'Example Company' }, { nativeId: '42', name: 'Example Company' }] } });
  const result = await createReservation({ ...input, mode: 'prepare', parties: { organizationName: 'Example Company', agencyId: '99', agencyName: 'Example', arAccountId: '75' } }, unresolved.options);
  assert.equal(result.outcome, 'needs_input');
  assert.equal(result.partySearches.organization.issue, 'explicit_selection_required');
  assert.equal(result.applied.agency.nativeId, '99');
  assert.ok(result.missing.includes('parties.arAccountName'));
  assert.equal(unresolved.calls.some(({ tool }) => tool === 'selectOrganization' || tool === 'searchArAccount'), false);
  for (const [partySelections, field] of [
    [{ agency: { searchId: 'stale' } }, 'parties.agencyId'],
    [{ agency: { nativeId: '98' } }, 'parties.agencyId'],
    [{ arAccount: { nativeIdEvidence: 'unknown' } }, 'parties.arAccountId'],
    [{ arAccount: { selectedField: { name: 'araccountname', value: 'Other' } } }, 'parties.arAccountId'],
  ]) {
    const fake = harness({ partySelections });
    const attempt = await createReservation({ ...input, mode: 'prepare', parties: { agencyId: '99', agencyName: 'Example', arAccountId: '75', arAccountName: 'Example' } }, fake.options);
    assert.equal(attempt.outcome, 'uncertain');
    assert.equal(attempt.issue, 'requested_field_not_staged');
    assert.equal(attempt.field, field);
    assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
  }
});

test('party selection handles duplicate IDs, truncated misses, picker errors and final readback mismatch', async () => {
  for (const [candidates, truncated, issue] of [
    [[{ nativeId: '99', name: 'One' }, { nativeId: '99', name: 'Two' }], false, 'id_ambiguous'],
    [[{ nativeId: '98', name: 'Other' }], false, 'id_not_found'],
    [[{ nativeId: '98', name: 'Other' }], true, 'id_not_in_loaded_results'],
  ]) {
    const fake = harness({ partySearches: { agency: { outcome: 'matches', searchId: 'current', candidates,
      coverage: { loaded: candidates.length, possiblyTruncated: truncated } } } });
    const result = await createReservation({ ...input, mode: 'prepare', parties: { agencyId: '99', agencyName: 'Example' } }, fake.options);
    assert.equal(result.partySearches.agency.issue, issue);
    assert.ok(result.missing.includes('parties.agencyId.selection'));
    assert.equal(fake.calls.some(({ tool }) => tool === 'selectPrimaryBookingAgency'), false);
  }
  const failedClose = harness({ partyCandidates: { agency: [] }, partyClose: { outcome: 'close_uncertain', issue: 'PARTY_CANCEL_UNVERIFIED' } });
  const closeResult = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', arAccountName: 'Example', arAccountId: '75' } }, failedClose.options);
  assert.equal(closeResult.outcome, 'uncertain');
  assert.equal(closeResult.partySearches.agency.issue, 'no_matches');
  assert.equal(failedClose.calls.some(({ tool }) => tool === 'searchArAccount'), false);
  const wrong = harness({ draft: { ...values, ta1: 'Other Agency' } });
  const mismatch = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', agencyId: '99' } }, wrong.options);
  assert.equal(mismatch.outcome, 'uncertain');
  assert.equal(mismatch.issue, 'draft_readback_mismatch');
  assert.equal(mismatch.field, 'ta1');
});

test('party clears stay unsupported and unresolved choices never save', async () => {
  for (const parties of [{ agencyId: null }, { arAccountName: null }]) {
    let sessions = 0;
    const result = await createReservation({ ...input, parties }, { withSession: async () => { sessions++; } });
    assert.equal(result.outcome, 'unsupported');
    assert.equal(sessions, 0);
  }
  for (const parties of [{ agencyId: '99' }, { agencyName: 'Example' }, { arAccountId: '75' }, { arAccountName: 'Example' }]) {
    const fake = harness();
    const result = await createReservation({ ...input, parties }, fake.options);
    assert.equal(result.outcome, 'needs_input');
    assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
  }
});

test('commit independently passes selected parties and requires fresh native identity readback', async (t) => {
  const dirs = new Set();
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  for (const parties of [
    { organizationId: '41' },
    { agencyId: '99', agencyName: 'Example' },
    { arAccountId: '75', arAccountName: 'Example' },
    { agencyId: '99', agencyName: 'Example', organizationId: '41', arAccountId: '75', arAccountName: 'Example' },
  ]) {
    let checked;
    const fake = harness({ record: { ...values, company: parties.organizationId ? 'Example Company' : '' },
      partyReadback: (request) => { checked = request; return { outcome: 'verified' }; } });
    const result = await createReservation({ ...input, parties }, fake.options);
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    assert.equal(result.outcome, 'saved');
    const save = fake.calls.find(({ tool }) => tool === 'saveNewLabtestStay');
    assert.equal(save.agencySelection?.nativeId ?? null, parties.agencyId ?? null);
    assert.equal(save.arSelection?.nativeId ?? null, parties.arAccountId ?? null);
    assert.equal(save.organizationSelection?.nativeId ?? null, parties.organizationId ?? null);
    assert.equal(checked.agency?.nativeId ?? null, parties.agencyId ?? null);
    assert.equal(checked.organization?.nativeId ?? null, parties.organizationId ?? null);
    assert.equal(checked.arAccount?.profileId ?? null, parties.arAccountId ? '501' : null);
  }
  for (const parties of [{ organizationId: '41' }, { agencyId: '99', agencyName: 'Example' }]) {
    const fake = harness({ record: { ...values, company: parties.organizationId ? 'Example Company' : '' },
      partyReadback: () => ({ outcome: 'unverified' }) });
    const result = await createReservation({ ...input, parties }, fake.options);
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    assert.equal(result.outcome, 'uncertain');
    assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
  }
});

test('optional CMS code is selected and checked without sending', async (t) => {
  const fake = harness({ record: { ...values, udfchar09: '03' } });
  const result = await createReservation({ ...input, cms: { send: false, messageId: '03' } }, fake.options);
  if (result.screenshots?.before) t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'saved');
  assert.equal(result.applied.cmsMessageId, '03');
  assert.equal(fake.calls.find(({ tool }) => tool === 'saveNewLabtestStay').createFieldProof.cmsMessageSelection.actual, '03');
  const unavailable = harness();
  const missing = await createReservation({ ...input, cms: { messageId: 'UNAVAILABLE' } }, unavailable.options);
  assert.equal(missing.outcome, 'needs_input');
  assert.ok(missing.missing.includes('cms.messageId.selection'));
  assert.equal(unavailable.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});



test('explicit loaded IDs survive truncated search but not duplicate or conflicting organization evidence', async () => {
  const fake = harness({ partySearches: { agency: { outcome: 'matches', searchId: 'current',
    candidates: [{ nativeId: '99', name: 'Example Agency' }], coverage: { loaded: 1, possiblyTruncated: true } } } });
  const selected = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', agencyId: '99' } }, fake.options);
  assert.equal(selected.outcome, 'prepared');
  assert.equal(selected.partySearches.agency.coverage.possiblyTruncated, true);
  assert.equal(selected.applied.agency.nativeId, '99');
  const conflict = harness();
  const result = await createReservation({ ...input, mode: 'prepare', parties: { organizationId: '41', organizationName: 'Other',
    arAccountName: 'Example', arAccountId: '75' } }, conflict.options);
  assert.equal(result.partySearches.organization.issue, 'id_name_conflict');
  assert.equal(result.applied.arAccount.nativeId, '75');
  assert.equal(conflict.calls.some(({ tool }) => tool === 'selectOrganization'), false);
  const duplicate = harness({ partyCandidates: { organization: [{ nativeId: '41', name: 'One' }, { nativeId: '41', name: 'Two' }] } });
  const ambiguous = await createReservation({ ...input, mode: 'prepare', parties: { organizationId: '41', organizationName: 'One' } }, duplicate.options);
  assert.equal(ambiguous.partySearches.organization.issue, 'id_ambiguous');
  assert.equal(duplicate.calls.some(({ tool }) => tool === 'selectOrganization'), false);
});

test('failed picker search or uncertain selection does not continue', async () => {
  const failedSearch = harness({ partySearches: { agency: { outcome: 'execution_failure', issue: 'LOOKUP_SEARCH_UNVERIFIED' } } });
  const failed = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', arAccountName: 'Example', arAccountId: '75' } }, failedSearch.options);
  assert.equal(failed.outcome, 'uncertain');
  assert.equal(failed.issue, 'LOOKUP_SEARCH_UNVERIFIED');
  assert.equal(failedSearch.calls.some(({ tool }) => tool === 'searchArAccount'), false);
  const failedSelection = harness({ partySelections: { agency: { outcome: 'selection_uncertain', issue: 'LOOKUP_SELECTION_NOT_CONFIRMED' } } });
  const uncertain = await createReservation({ ...input, mode: 'prepare', parties: { agencyName: 'Example', agencyId: '99', arAccountName: 'Example', arAccountId: '75' } }, failedSelection.options);
  assert.equal(uncertain.outcome, 'uncertain');
  assert.equal(uncertain.partySearches.agency.candidates[0].nativeId, '99');
  assert.equal(failedSelection.calls.some(({ tool }) => tool === 'searchArAccount'), false);
});


test('reason for stay uses current dropdown and saved visible readback', async (t) => {
  const fake = harness({ record: { ...values, reasonforstay: 'Business' } });
  const result = await createReservation({ ...input, reasonForStay: 'BUS' }, fake.options);
  if (result.screenshots?.before) t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'saved');
  assert.equal(result.applied.reasonForStay, 'Business');
  assert.equal(fake.calls.find(({ tool }) => tool === 'saveNewLabtestStay').createFieldProof.reasonSelection.actual.value, 'BUS');
  const mismatch = harness({ record: { ...values, reasonforstay: 'Leisure' } });
  const uncertain = await createReservation({ ...input, reasonForStay: 'BUS' }, mismatch.options);
  if (uncertain.screenshots?.before) t.after(() => rm(dirname(uncertain.screenshots.before), { recursive: true, force: true }));
  assert.equal(uncertain.outcome, 'uncertain');
  assert.ok(uncertain.readback.mismatches.some(({ field }) => field === 'reasonForStay'));
});


test('guarded create and unsaved prepare block service workers before opening the session', async () => {
  const fake = harness();
  await createReservation(input, fake.options);
  assert.equal(fake.sessionOptions.blockServiceWorkers, true);
  const prepare = harness();
  await createReservation({ ...input, mode: 'prepare' }, prepare.options);
  assert.equal(prepare.sessionOptions.blockServiceWorkers, true);
});

test('explicit billing reference with selected A/R is passed exactly to the guarded writer and fresh readback', async (t) => {
  let checked;
  const fake = harness({ partyReadback: (request) => { checked = request; return { outcome: 'verified' }; } });
  const reference = '  PO 123  ';
  const result = await createReservation({ ...input, parties: { organizationId: '41', arAccountId: '75', arAccountName: 'Example' }, billingReference: reference }, fake.options);
  if (result.screenshots?.before) t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'saved');
  assert.equal(fake.calls.find(({ tool }) => tool === 'saveNewLabtestStay').billingReference, reference);
  assert.equal(checked.billingReference, reference);
});

test('billing reference is commit-only, explicit, nonblank and requires a selected A/R account', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const value of ['', '   ', 'bad\nreference', 1]) {
    const result = await createReservation({ ...input, billingReference: value }, { withSession: noSession });
    assert.equal(result.outcome, 'needs_input');
  }
  const withoutAccount = await createReservation({ ...input, billingReference: 'PO-123' }, { withSession: noSession });
  assert.equal(withoutAccount.outcome, 'needs_input');
  const clear = await createReservation({ ...input, billingReference: null }, { withSession: noSession });
  assert.equal(clear.outcome, 'unsupported');
  assert.equal(sessions, 0);
});


test('billing create cannot report saved without staged screenshot and fresh exact proof', async (t) => {
  const request = { ...input, parties: { organizationId: '41', arAccountId: '75', arAccountName: 'Example' }, billingReference: 'PO-123' };
  const dirs = new Set(); t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  for (const options of [{ partyReadback: () => ({ outcome: 'unverified' }) },
    { save: { outcome: 'saved_same_form', confirmation: '123456-1', arProfileId: '501' } }]) {
    const result = await createReservation(request, harness(options).options);
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    assert.equal(result.outcome, 'uncertain');
  }
  const unknown = harness({ save: { outcome: 'uncertain', confirmation: null } });
  const result = await createReservation(request, unknown.options);
  if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.reconciliation.billingReferenceVerification, 'not_checked');
  assert.equal(result.reconciliation.candidates[0].billingAndPartyProof.outcome, 'unverified');
});


test('prepare reports billing reference unsupported without sending a save', async () => {
  const fake = harness();
  const result = await createReservation({ ...input, mode: 'prepare', billingReference: 'PO-123' }, fake.options);
  assert.equal(result.outcome, 'unsupported');
  assert.ok(result.unsupportedFields.some(({ field, issue }) => field === 'billingReference' && issue === 'commit_only'));
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
});

test('billing reports only absent A/R identity fields, without duplicates', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [parties, wanted] of [
    [{ arAccountId: '75' }, ['parties.arAccountName']],
    [{ arAccountName: 'Example' }, ['parties.arAccountId']],
    [{}, ['parties.arAccountId', 'parties.arAccountName']],
    [{ arAccountId: '75', arAccountName: '   ' }, ['parties.arAccountName']],
  ]) {
    const result = await createReservation({ ...input, parties, billingReference: 'PO-123' }, { withSession: noSession });
    assert.equal(result.outcome, 'needs_input');
    assert.deepEqual(result.missing, wanted);
  }
  assert.equal(sessions, 0);
});


test('guest name lookup returns none, selects one, and refuses ambiguity without a Save', async () => {
  const search = { firstName: 'Real', lastName: 'Guest' };
  const real = { ...profile, ...search };
  const prepare = { ...input, mode: 'prepare', guest: { search } };
  const none = harness({ profiles: [], profileSearchOutcome: 'no_match' });
  const missing = await createReservation(prepare, none.options);
  assert.equal(missing.issue, 'guest_not_found');
  assert.ok(missing.missing.includes('guest'));
  assert.equal(none.calls.some(({ tool }) => tool === 'selectGuestProfile' || tool === 'saveNewLabtestStay'), false);

  const one = harness({ profiles: [real], draft: { ...values, firstname: 'Real', lastname: 'Guest' } });
  const staged = await createReservation(prepare, one.options);
  assert.equal(staged.applied.guest.nativeId, '123');
  assert.deepEqual(one.calls.find(({ tool }) => tool === 'searchGuestProfiles'),
    { tool: 'searchGuestProfiles', field: 'lastName', query: 'Guest' });
  assert.deepEqual(one.calls.find(({ tool }) => tool === 'selectGuestProfile'),
    { tool: 'selectGuestProfile', searchId: 'g', nativeId: '123' });
  assert.equal(staged.approvalReady, false);
  assert.equal(one.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);

  for (const options of [
    { profiles: [real, { ...real, nativeId: '124' }] },
    { profiles: [real], profileCoverageTruncated: true },
  ]) {
    const many = harness(options);
    const result = await createReservation(prepare, many.options);
    assert.equal(result.issue, 'guest_ambiguous');
    assert.ok(result.missing.includes('guest'));
    assert.equal(many.calls.some(({ tool }) => tool === 'selectGuestProfile' || tool === 'saveNewLabtestStay'), false);
  }

  const refused = harness({ profiles: [real] });
  const result = await createReservation({ ...input, guest: { profileId: '123' } }, refused.options);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.issue, REAL_GUEST_CREATE_AUTHORIZATION_HOLD);
  assert.equal(refused.calls.some(({ tool }) => tool === 'selectGuestProfile' || tool === 'saveNewLabtestStay'), false);
});

test('prepares a synthetic Labtest note once and requires it explicitly at commit', async (t) => {
  const { note: omitted, ...withoutNote } = input;
  assert.equal(omitted, 'Synthetic proof');
  const preparing = harness();
  const prepared = await createReservation({ ...withoutNote, mode: 'prepare' }, preparing.options);
  assert.equal(prepared.outcome, 'prepared');
  assert.match(prepared.applied.note, /^Proof Labtest create [0-9a-f-]{36}$/);
  assert.equal(prepared.requestBinding.request.note, prepared.applied.note);
  assert.equal(preparing.calls.find((call) => call.tool === 'setGuestStayText' && call.field === 'reservationNote').value,
    prepared.applied.note);

  const missing = harness();
  const refused = await createReservation(withoutNote, missing.options);
  assert.equal(refused.outcome, 'needs_input');
  assert.ok(refused.missing.includes('note'));
  assert.equal(missing.calls.some((call) => call.tool === 'saveNewLabtestStay'), false);
  assert.equal(missing.calls.some((call) => call.tool === 'setGuestStayText'), false);

  const committing = harness({ save: { outcome: 'not_dispatched' } });
  const result = await createReservation({ ...withoutNote, note: prepared.applied.note }, committing.options);
  if (result.screenshots?.before) t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(committing.calls.find((call) => call.tool === 'saveNewLabtestStay')?.note, prepared.applied.note);
});

test('does not invent a note for a real guest prepare', async () => {
  const { note: omitted, ...withoutNote } = input;
  assert.equal(omitted, 'Synthetic proof');
  const realProfile = { ...profile, firstName: 'Real', lastName: 'Guest' };
  const fake = harness({ profiles: [realProfile], draft: { ...values, firstname: 'Real', lastname: 'Guest', reservationnote: '' } });
  const prepared = await createReservation({ ...withoutNote, mode: 'prepare' }, fake.options);
  assert.equal(Object.hasOwn(prepared.applied, 'note'), false);
  assert.equal(fake.calls.some((call) => call.tool === 'setGuestStayText' && call.field === 'reservationNote'), false);
  assert.equal(fake.calls.some((call) => call.tool === 'saveNewLabtestStay'), false);
});

test('native guard callbacks travel only in server-owned commit session options', async (t) => {
  const authorizeCandidate = async () => true;
  const dispatchCandidate = async (_request, continueOnce) => continueOnce();
  const fake = harness();
  const result = await createReservation(input, { ...fake.options, authorizeCandidate, dispatchCandidate });
  if (result.screenshots?.before) t.after(async () => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'saved');
  assert.equal(fake.sessionOptions.authorizeCandidate, authorizeCandidate);
  assert.equal(typeof fake.sessionOptions.dispatchCandidate, 'function');
  const save = fake.calls.find(({ tool }) => tool === 'saveNewLabtestStay');
  assert.ok(save);
  assert.equal(Object.hasOwn(save, 'authorizeCandidate'), false);
  assert.equal(Object.hasOwn(save, 'dispatchCandidate'), false);
  for (const guards of [{ authorizeCandidate }, { dispatchCandidate }, { authorizeCandidate: true, dispatchCandidate }]) {
    const refused = await createReservation(input, { ...fake.options, ...guards });
    assert.equal(refused.issue, 'SAVE_GUARD_CALLBACKS_INVALID');
  }
  const prepare = harness();
  await createReservation({ ...input, mode: 'prepare' }, { ...prepare.options, authorizeCandidate, dispatchCandidate });
  assert.equal(Object.hasOwn(prepare.sessionOptions, 'authorizeCandidate'), false);
  assert.equal(Object.hasOwn(prepare.sessionOptions, 'dispatchCandidate'), false);
});

test('staff create holds confirmation when fresh native no-party readback disagrees', async (t) => {
  let checked;
  const fake = harness({ partyReadback: (request) => { checked = request; return { outcome: 'unverified' }; } });
  const result = await createReservation(input, { ...fake.options,
    authorizeCandidate: async () => true, dispatchCandidate: async (_request, next) => next() });
  if (result.screenshots?.before) t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'uncertain');
  assert.equal(checked.agency, null);
  assert.equal(checked.organization, null);
  assert.equal(checked.arAccount, null);
});
