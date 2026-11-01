import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { createReservation } from './create-reservation.mjs';

const input = {
  mode: 'commit', propertyCode: 'HRCEN', guest: { profileId: '123' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [8, 12] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' }, guaranteeType: 'NGI', sourceOfBusiness: 'EMA',
  parties: { organizationId: '41' }, note: 'Synthetic proof',
  cms: { send: false }, approval: { by: 'Owner', at: '2026-11-01T12:00:00Z' },
};
const profile = { nativeId: '123', firstName: 'Proof', lastName: 'Labtest', email: 'response-only@example.test' };
const values = { guestid: '123', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
  arrivaldate: '15-MAR-2027', departuredate: '17-MAR-2027', adults: '2', children: '2', child1: '0', child2: '2', child3: '0',
  roomtype: 'DLXKNG', rateplan: 'BAR', sourceofbusinessdesc: 'E-Mail', company: 'Example Company',
  guaranteetype: 'Non-Guaranteed Individual', reservationnote: 'Synthetic proof', udfchkbox04: false, udfchar13: '', emailaddress: '' };
const fields = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value, ...(name === 'reservationnote' ? { rawValue: value } : {}) }));

function harness(options = {}) {
  const calls = [], sources = [...Array.from({ length: 100 }, (_, i) => ({ nativeCode: `X${i}`, description: `Other ${i}` })),
    { nativeCode: 'EMA', description: 'E-Mail' }];
  let freshReads = 0, censuses = 0;
  const runTool = async (request) => {
    calls.push(request);
    switch (request.tool) {
      case 'searchGuestProfiles': return { outcome: 'matches', searchId: 'g', candidates: options.profiles || [profile],
        coverage: { loaded: (options.profiles || [profile]).length, possiblyTruncated: false }, correlation: { verifiedFields: ['firstname', 'lastname'] } };
      case 'closeGuestProfilePicker': return options.close || { outcome: 'closed_unsaved' };
      case 'selectGuestProfile': return { outcome: 'selected_unsaved', nativeId: options.selectedGuestId ?? request.nativeId };
      case 'setGuestStayDate': return { outcome: 'updated_unsaved', actual: request.date, displayed: request.field === 'arrivalDate' ? '15-MAR-2027' : '17-MAR-2027' };
      case 'selectGuestStayDropdown': return { outcome: 'updated_unsaved', field: request.field, requested: request.value,
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
      case 'searchOrganization': return { outcome: 'matches', searchId: 'o', candidates: [{ nativeId: '41', name: 'Example Company' }] };
      case 'selectOrganization': return { outcome: 'selected_unsaved', nativeId: '41', displayedOrganization: 'Example Company', profileProofToken: 'token' };
      case 'setCmsSendCheckbox': return { outcome: 'updated_unsaved', actual: false };
      case 'setGuestStayText': return { outcome: 'updated_unsaved', actual: request.value };
      case 'readGuestStayForm': return { outcome: 'ok', fields: fields(options.draft || values) };
      case 'saveNewLabtestStay': return options.save || { outcome: 'saved_same_form', confirmation: '123456-1', requestSeen: true };
      case 'readSavedLabtestRecord': return { outcome: 'read_back_verified', organization: { nativeId: '41', name: 'Example Company' } };
      default: throw new Error(`unexpected call ${request.tool}`);
    }
  };
  return { calls, get freshReads() { return freshReads; }, get censuses() { return censuses; }, options: {
    withSession: async (operation) => operation({ runTool, page: { screenshot: async () => Buffer.from('private screenshot') },
      labtestPreimage: { preimageId: 'p' } }),
    withSavedSession: async (operation) => {
      freshReads += 1;
      return operation({ runTool: async () => ({ outcome: 'ok', record: { details: { fields: fields(options.record || values), captureScope: 'test' } } }) });
    },
    census: async () => { censuses += 1; return { outcome: 'existing_matches', coverage: { complete: true }, sameArrival: [{ confirmation: '123456-1' }] }; },
  } };
}

test('unsupported commit requests, nested unknowns and explicit clears stop before session', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [change, fields] of [
    [{ price: 100, parties: { organizationId: '41', agencyId: '99' } }, ['price', 'parties.agencyId']],
    [{ guest: { ...input.guest, searchExtra: { nested: { unknown: null } } } }, ['guest.searchExtra.nested.unknown']],
    [{ stay: { ...input.stay, occupancy: { other: 1 } } }, ['stay.occupancy.other']],
    [{ cms: { send: false, messageId: null } }, ['cms.messageId']],
    [{ parties: { organizationId: null } }, ['parties.organizationId']],
    [{ sourceOfBusiness: null }, ['sourceOfBusiness']],
    [{ note: null }, ['note']],
    [{ cms: { send: true, recipient: null }, price: 2 }, ['cms.send', 'cms.recipient', 'price']],
    [{ booker: { name: 'Example', surprise: 'x' } }, ['booker', 'booker.surprise']],
  ]) {
    const result = await createReservation({ ...input, ...change, mode: 'commit' }, { withSession: noSession });
    assert.equal(result.outcome, 'unsupported');
    assert.deepEqual(result.unsupportedFields.map(({ field }) => field).sort(), fields.sort());
  }
  assert.equal(sessions, 0);
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
  const { approval: _metadata, ...withoutApproval } = input;
  const noMetadata = harness();
  const withoutMetadata = await createReservation(withoutApproval, noMetadata.options);
  if (withoutMetadata.screenshots?.before) dirs.add(dirname(withoutMetadata.screenshots.before));
  assert.equal(withoutMetadata.outcome, 'saved');
  assert.equal(noMetadata.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 1);
  assert.equal(result.outcome, 'saved');
  assert.equal(result.approvalReady, false);
  assert.equal(result.confirmation, '123456-1');
  assert.deepEqual(result.appliedVerification, { visibleFields: true, childAges: 'at_selection_only', organizationId: 'at_selection_only' });
  assert.deepEqual(result.readback.mismatches, []);
  assert.equal(result.readback.organizationProof.outcome, 'read_back_verified');
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

test('real profiles and blocked preimages do not reach save', async () => {
  const fake = harness({ profiles: [{ ...profile, firstName: 'Real' }] });
  const real = await createReservation(input, fake.options);
  assert.equal(real.outcome, 'refused');
  assert.equal(real.issue, 'real_guest_write_disabled');
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
  const preimage = { outcome: 'existing_matches', sameArrival: [{ confirmation: '123456-1' }], coverage: { complete: true } };
  const blocked = await createReservation(input, { withSession: async () => {
    throw Object.assign(new Error('LABTEST_PREIMAGE_NOT_CLEAR'), { phase: 'labtest_preimage', labtestPreimage: preimage });
  } });
  assert.equal(blocked.outcome, 'needs_input');
  assert.deepEqual(blocked.preimage, preimage);
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
  assert.ok(result.warnings.some(({ field, issue }) => field === 'stay.childAges' && issue === 'saved_record_exposes_age_bands_not_exact_ages'));
  assert.ok(result.warnings.some(({ field, issue }) => field === 'sourceOfBusiness' && issue === 'native_code_not_exposed_on_form_or_saved_record'));
  assert.deepEqual(fake.calls.filter(({ tool }) => tool === 'inspectGuestStaySourceBusiness').map(({ offset }) => offset), [0, 100]);
  assert.equal(fake.calls.filter(({ tool }) => tool === 'saveNewLabtestStay').length, 0);
});

test('prepare reports an unstaged guarantee without claiming the draft is complete', async () => {
  const realProfile = { ...profile, firstName: 'Real', lastName: 'Guest' };
  const fake = harness({ profiles: [realProfile], draft: { ...values, firstname: 'Real', lastname: 'Guest' } });
  const result = await createReservation({ ...input, mode: 'prepare' }, fake.options);
  assert.equal(result.outcome, 'needs_input');
  assert.ok(result.missing.includes('guaranteeType.staging'));
  assert.equal(result.applied.note, input.note);
  assert.equal(result.applied.guest.firstName, 'Real');
  assert.equal(fake.calls.some(({ tool, field }) => tool === 'selectGuestStayDropdown' && field === 'guaranteeType'), false);
  assert.equal(fake.calls.some(({ tool }) => tool === 'saveNewLabtestStay'), false);
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
    [{ guest: { search: { lastName: 'Real' } } }, 'refused', 'real_guest_write_disabled'],
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
      ['guaranteeType', 'price', 'parties.agencyId']],
    [{ guest: { ...input.guest, searchExtra: { nested: { unknown: null } } } }, ['guest.searchExtra.nested.unknown']],
    [{ stay: { ...input.stay, occupancy: { other: 1 } } }, ['stay.occupancy.other']],
    [{ cms: { send: false, messageId: null } }, ['cms.messageId']],
    [{ parties: { organizationId: null } }, ['parties.organizationId']],
    [{ sourceOfBusiness: null }, ['sourceOfBusiness']],
    [{ note: null }, ['note']],
    [{ cms: { send: true, recipient: null }, price: 2 }, ['cms.send', 'cms.recipient', 'price']],
    [{ booker: { name: 'Example', surprise: 'x' } }, ['booker', 'booker.surprise']],
  ]) {
    const fake = harness();
    const result = await createReservation({ ...input, ...change, mode: 'prepare' }, fake.options);
    assert.equal(result.outcome, 'unsupported');
    assert.equal(result.approvalReady, false);
    assert.equal(result.appliedVerification.visibleFields, true);
    assert.equal(result.applied.guest.nativeId, '123');
    assert.deepEqual(result.unsupportedFields.map(({ field }) => field).sort(), unsupported.sort());
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
