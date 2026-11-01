import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { createReservation } from './create-reservation.mjs';

const input = {
  mode: 'commit', propertyCode: 'HRCEN', guest: { profileId: '123' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [8, 12] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' }, guaranteeType: 'NGI', sourceOfBusiness: 'EMA',
  parties: { organizationId: '41', agencyId: '99' }, note: 'Synthetic proof', booker: { name: 'Example' },
  cms: { send: false, messageId: '03' }, price: 100, approval: { by: 'Owner', at: '2026-11-01T12:00:00Z' },
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
      case 'selectGuestProfile': return { outcome: 'selected_unsaved', nativeId: request.nativeId };
      case 'setGuestStayDate': return { outcome: 'updated_unsaved', displayed: request.field === 'arrivalDate' ? '15-MAR-2027' : '17-MAR-2027' };
      case 'selectGuestStayDropdown': return { outcome: 'updated_unsaved', field: request.field, requested: request.value,
        actual: request.field === 'adults' ? { value: 2, display: '2' } : { value: 'NGI', display: 'Non-Guaranteed Individual' }, profileProofToken: 'token' };
      case 'setGuestStayChildAges': return { outcome: 'updated_unsaved', actualChildAges: [8, 12], requestedChildAges: [8, 12],
        ageBandCounts: { child1: 0, child2: 2, child3: 0 }, profileProofToken: 'token' };
      case 'searchRoomTypes': return { outcome: 'matches', searchId: 'r', coverage: { complete: true, matchingLoaded: 101 }, candidates: [] };
      case 'inspectRoomRateCandidate': return { outcome: 'match', candidates: [{ code: 'DLXKNG' }] };
      case 'selectRoomType': return { outcome: 'selected_unsaved', selectedField: { value: 'DLXKNG' } };
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

test('guarded commit verifies current inputs and fresh readback, including uncertain saves', async (t) => {
  const dirs = new Set();
  t.after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  const run = async (options) => {
    const fake = harness(options), result = await createReservation(input, fake.options);
    if (result.screenshots?.before) dirs.add(dirname(result.screenshots.before));
    return { fake, result };
  };
  const { fake, result } = await run();
  assert.equal(result.outcome, 'saved');
  assert.equal(result.confirmation, '123456-1');
  assert.deepEqual(result.appliedVerification, { visibleFields: true, childAges: 'at_selection_only', organizationId: 'at_selection_only' });
  assert.equal(result.applied.guest.email, '');
  assert.deepEqual(result.readback.mismatches, []);
  assert.equal(result.readback.organizationProof.outcome, 'read_back_verified');
  assert.equal(fake.freshReads, 1);
  assert.equal(fake.calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 1);
  const save = fake.calls.find((call) => call.tool === 'saveNewLabtestStay');
  assert.equal(save.preimageId, 'p');
  assert.equal(save.organizationSelection.nativeId, '41');
  assert.equal(save.createFieldProof.childAgeSelection.profileProofToken, 'token');
  assert.ok(!Object.hasOwn(save, 'agencyId'));
  assert.deepEqual(fake.calls.find((call) => call.tool === 'searchOrganization'),
    { tool: 'searchOrganization', query: '41', options: { field: 'nativeId' } });
  assert.deepEqual(fake.calls.filter((call) => call.tool === 'inspectGuestStaySourceBusiness').map((call) => call.offset), [0, 100]);
  assert.ok(result.warnings.some((warning) => warning.field === 'parties.agencyId'));
  assert.ok(result.warnings.some((warning) => warning.field === 'booker'));
  assert.ok(result.warnings.some((warning) => warning.field === 'price'));
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
  assert.equal(unknown.fake.calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 1);
  assert.deepEqual(unknown.result.reconciliation.candidates[0].readback.mismatches, []);
  const gap = await run({ save: { outcome: 'input_gap', issue: 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED' } });
  assert.equal(gap.result.outcome, 'needs_input');
  assert.equal(gap.fake.censuses, 0);
  const wrongGuest = await run({ draft: { ...values, guestid: '999' } });
  assert.equal(wrongGuest.result.outcome, 'uncertain');
  assert.equal(wrongGuest.fake.calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 0);
  const changedDraft = await run({ draft: { ...values, arrivaldate: '16-MAR-2027' } });
  assert.equal(changedDraft.result.applied.arrival, '16-MAR-2027');
  assert.equal(changedDraft.result.appliedVerification.visibleFields, false);
});

test('incomplete or unsafe inputs preserve evidence and never save', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [change, outcome, issue] of [
    [{ cms: { send: true } }, 'unsupported', 'sending_not_supported'],
    [{ guaranteeType: 'GTDCC' }, 'refused', 'guarantee_not_supported_yet'],
    [{ guest: { search: { lastName: 'Real' } } }, 'refused', 'real_guest_write_disabled'],
    [{ room: { ...input.room, ratePlan: 'BAR-1' } }, 'refused', 'native_code_not_supported_yet'],
    [{ stay: { ...input.stay, childAges: null } }, 'needs_input', undefined],
    [{ stay: { ...input.stay, childCount: 1 } }, 'needs_input', undefined],
    [{ approval: null }, 'needs_input', undefined],
  ]) {
    const result = await createReservation({ ...input, ...change }, { withSession: noSession });
    assert.equal(result.outcome, outcome);
    if (issue) assert.equal(result.issue, issue);
  }
  assert.equal(sessions, 0);
  const realProfile = await createReservation(input, { withSession: async (operation) => operation({ runTool: async () => ({
    outcome: 'matches', searchId: 'g', candidates: [{ ...profile, firstName: 'Real' }], coverage: { loaded: 1, possiblyTruncated: false },
  }) }) });
  assert.equal(realProfile.outcome, 'refused');
  assert.equal(realProfile.issue, 'real_guest_write_disabled');
  const preimage = { outcome: 'existing_matches', sameArrival: [{ confirmation: '123456-1' }], coverage: { complete: true } };
  const blocked = await createReservation(input, { withSession: async () => {
    throw Object.assign(new Error('LABTEST_PREIMAGE_NOT_CLEAR'), { phase: 'labtest_preimage', labtestPreimage: preimage });
  } });
  assert.equal(blocked.outcome, 'needs_input');
  assert.deepEqual(blocked.preimage, preimage);

  const lookup = (candidates) => async (operation) => operation({ runTool: async ({ tool }) => tool === 'closeGuestProfilePicker'
    ? { outcome: 'closed_unsaved' } : tool === 'readGuestStayForm' ? { outcome: 'ok', fields: [] }
      : { outcome: 'matches', searchId: 'g', candidates, coverage: { loaded: candidates.length, possiblyTruncated: false },
        correlation: { verifiedFields: ['firstname', 'lastname'] } } });
  const prepare = { mode: 'prepare', propertyCode: 'HRCEN', guest: { search: { lastName: 'Example' } } };
  const ambiguous = await createReservation(prepare, { withSession: lookup([{ ...profile, lastName: 'Example' }, { ...profile, nativeId: '124', lastName: 'Example' }]) });
  assert.equal(ambiguous.issue, 'guest_ambiguous');
  assert.deepEqual(ambiguous.guestCandidates.map((item) => item.nativeId), ['123', '124']);
  const email = await createReservation({ ...prepare, guest: { search: { lastName: 'Example', email: 'example@example.test' } } },
    { withSession: lookup([{ ...profile, lastName: 'Example' }]) });
  assert.equal(email.issue, 'guest_email_unverified');
  assert.deepEqual(email.guestCorrelation.verifiedFields, ['firstname', 'lastname']);

  const unresolved = harness({ profiles: [profile, { ...profile, nativeId: '124' }] });
  const continued = await createReservation({ ...input, mode: 'prepare', guest: { search: { lastName: 'Labtest' } } }, unresolved.options);
  assert.equal(continued.issue, 'guest_ambiguous');
  assert.ok(continued.missing.includes('guest'));
  assert.deepEqual(continued.guestCandidates.map((item) => item.nativeId), ['123', '124']);
  assert.equal(continued.applied.note, 'Synthetic proof');
  assert.equal(continued.applied.organization.nativeId, '41');
  assert.equal(continued.appliedVerification.visibleFields, true);
  assert.ok(unresolved.calls.some((call) => call.tool === 'closeGuestProfilePicker'));
  assert.equal(unresolved.calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 0);
  const stuck = harness({ profiles: [], close: { outcome: 'close_uncertain' } });
  const closed = await createReservation({ ...input, mode: 'prepare' }, stuck.options);
  assert.equal(closed.outcome, 'uncertain');
  assert.equal(stuck.calls.filter((call) => call.tool === 'setGuestStayText').length, 0);

  const partial = harness({ rateUnavailable: true });
  const prepared = await createReservation({ ...input, mode: 'prepare', room: { ...input.room, ratePlan: 'BAR-1' } }, partial.options);
  assert.equal(prepared.outcome, 'needs_input');
  assert.ok(prepared.missing.includes('room.ratePlanCriteria'));
  assert.ok(!prepared.missing.includes('room.ratePlan'));
  assert.equal(prepared.applied.guest.nativeId, '123');
  assert.equal(prepared.applied.note, 'Synthetic proof');
  assert.ok(prepared.warnings.some((warning) => warning.field === 'cms.send'));
  assert.equal(partial.calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 0);
});
