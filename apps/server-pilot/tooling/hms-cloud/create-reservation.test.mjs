import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { createReservation } from './create-reservation.mjs';

const input = {
  mode: 'commit', propertyCode: 'HRCEN', guest: { profileId: '123' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [8, 12] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' }, guaranteeType: 'NGI', sourceOfBusiness: 'EMA',
  parties: { organizationId: '41', organizationName: 'Example Company', agencyId: '99' },
  note: 'Synthetic proof', booker: { name: 'Example' }, cms: { send: false, messageId: '03' },
  price: 100, approval: { by: 'Owner', at: '2026-11-01T12:00:00Z' },
};

const profile = { nativeId: '123', firstName: 'Proof', lastName: 'Labtest', email: null, city: null };
const fields = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
const form = fields({
  firstname: 'Proof', lastname: 'Labtest', arrivaldate: '15-MAR-2027', departuredate: '17-MAR-2027',
  adults: '2', children: '2', child1: '0', child2: '2', child3: '0', roomtype: 'DLXKNG', rateplan: 'BAR',
  sourceofbusinessdesc: 'E-Mail', company: 'Example Company', guaranteetype: 'Non-Guaranteed Individual',
  reservationnote: 'Synthetic proof', udfchkbox04: false, udfchar13: '', emailaddress: '',
});

test('one guarded commit preserves warnings, takes screenshots and independently compares readback', async (t) => {
  const calls = [];
  const runTool = async (request) => {
    calls.push(request);
    switch (request.tool) {
      case 'searchGuestProfiles': return { outcome: 'matches', searchId: 'g', candidates: [profile], coverage: { loaded: 1, possiblyTruncated: false } };
      case 'selectGuestProfile': return { outcome: 'selected_unsaved', nativeId: '123' };
      case 'setGuestStayDate': return { outcome: 'updated_unsaved', displayed: request.field === 'arrivalDate' ? '15-MAR-2027' : '17-MAR-2027' };
      case 'selectGuestStayDropdown': return { outcome: 'updated_unsaved', field: request.field, requested: request.value,
        actual: request.field === 'adults' ? { value: 2, display: '2' } : { value: 'NGI', display: 'Non-Guaranteed Individual' }, profileProofToken: 'token' };
      case 'setGuestStayChildAges': return { outcome: 'updated_unsaved', actualChildAges: [8, 12], requestedChildAges: [8, 12],
        ageBandCounts: { child1: 0, child2: 2, child3: 0 }, profileProofToken: 'token' };
      case 'searchRoomTypes': return { outcome: 'matches', searchId: 'r', coverage: { complete: true }, candidates: [{ code: 'DLXKNG' }] };
      case 'selectRoomType': return { outcome: 'selected_unsaved', selectedField: { value: 'DLXKNG' } };
      case 'selectGuestStayRatePlan': return { outcome: 'selected_unsaved', code: 'BAR' };
      case 'searchGuestStaySourceBusiness': return { outcome: 'matches', searchId: 's', coverage: { possiblyTruncated: false } };
      case 'inspectGuestStaySourceBusiness': return { outcome: 'ok', candidates: [{ nativeCode: 'EMA', description: 'E-Mail' }], hasMoreLoaded: false };
      case 'selectGuestStaySourceBusiness': return { outcome: 'selected_unsaved', nativeCode: 'EMA', candidate: { nativeCode: 'EMA', description: 'E-Mail' }, selectedField: { value: 'E-Mail' }, profileProofToken: 'token' };
      case 'searchOrganization': return { outcome: 'matches', searchId: 'o', candidates: [{ nativeId: '41', name: 'Example Company' }] };
      case 'selectOrganization': return { outcome: 'selected_unsaved', nativeId: '41', displayedOrganization: 'Example Company', profileProofToken: 'token' };
      case 'setCmsSendCheckbox': return { outcome: 'updated_unsaved', actual: false };
      case 'setGuestStayText': return { outcome: 'updated_unsaved', actual: 'Synthetic proof' };
      case 'readGuestStayForm': return { outcome: 'ok', fields: form };
      case 'saveNewLabtestStay': return { outcome: 'saved_same_form', confirmation: '123456-1', requestSeen: true };
      case 'readSavedLabtestRecord': return { outcome: 'read_back_verified', organization: { nativeId: '41', name: 'Example Company' } };
      default: throw new Error(`unexpected call ${request.tool}`);
    }
  };
  let freshReads = 0;
  const result = await createReservation(input, {
    withSession: async (operation, options) => {
      assert.deepEqual(options.labtestDates, { arrival: '2027-03-15', departure: '2027-03-17' });
      return operation({ runTool, page: { screenshot: async () => Buffer.from('private screenshot') }, labtestPreimage: { preimageId: 'p' } });
    },
    withSavedSession: async (operation) => {
      freshReads += 1;
      return operation({ runTool: async () => ({ outcome: 'ok', record: { details: { fields: form, captureScope: 'test' } } }) });
    },
  });
  t.after(() => rm(dirname(result.screenshots.before), { recursive: true, force: true }));
  assert.equal(result.outcome, 'saved');
  assert.equal(result.confirmation, '123456-1');
  assert.deepEqual(result.readback.mismatches, []);
  assert.equal(result.readback.organizationProof.outcome, 'read_back_verified');
  assert.equal(freshReads, 1);
  assert.equal(calls.filter((call) => call.tool === 'saveNewLabtestStay').length, 1);
  const save = calls.find((call) => call.tool === 'saveNewLabtestStay');
  assert.equal(save.preimageId, 'p');
  assert.equal(save.organizationSelection.nativeId, '41');
  assert.equal(save.createFieldProof.childAgeSelection.profileProofToken, 'token');
  assert.ok(!Object.hasOwn(save, 'agencyId'));
  assert.ok(result.warnings.some((warning) => warning.field === 'parties.agencyId'));
  assert.ok(result.warnings.some((warning) => warning.field === 'booker'));
  assert.ok(result.warnings.some((warning) => warning.field === 'price'));
  assert.equal((await stat(dirname(result.screenshots.before))).mode & 0o777, 0o700);
  assert.equal((await stat(result.screenshots.before)).mode & 0o777, 0o600);
  assert.equal((await stat(result.screenshots.after)).mode & 0o777, 0o600);
});

test('unsafe or incomplete requests stop before saving and ambiguous guests retain candidates', async () => {
  let sessions = 0;
  const noSession = async () => { sessions += 1; throw new Error('unexpected session'); };
  for (const [change, outcome, issue] of [
    [{ cms: { send: true } }, 'unsupported', 'sending_not_supported'],
    [{ guaranteeType: 'GTDCC' }, 'refused', 'guarantee_not_supported_yet'],
    [{ guest: { search: { lastName: 'Real' } } }, 'refused', 'real_guest_write_disabled'],
    [{ stay: { ...input.stay, childAges: null } }, 'needs_input', undefined],
    [{ stay: { ...input.stay, childCount: 1 } }, 'needs_input', undefined],
    [{ approval: null }, 'needs_input', undefined],
  ]) {
    const result = await createReservation({ ...input, ...change }, { withSession: noSession });
    assert.equal(result.outcome, outcome);
    if (issue) assert.equal(result.issue, issue);
  }
  assert.equal(sessions, 0);

  let saves = 0;
  const refused = await createReservation(input, { withSession: async (operation) => operation({
    page: {}, labtestPreimage: { preimageId: 'p' }, runTool: async (request) => {
      if (request.tool === 'saveNewLabtestStay') saves += 1;
      return { outcome: 'matches', searchId: 'g', candidates: [{ ...profile, firstName: 'Real' }],
        coverage: { loaded: 1, possiblyTruncated: false } };
    },
  }) });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.issue, 'real_guest_write_disabled');
  assert.equal(saves, 0);

  const ambiguous = await createReservation({ mode: 'prepare', propertyCode: 'HRCEN', guest: { search: { lastName: 'Example' } } }, {
    withSession: async (operation) => operation({ runTool: async () => ({ outcome: 'matches', searchId: 'g',
      candidates: [{ ...profile, lastName: 'Example' }, { ...profile, nativeId: '124', lastName: 'Example' }],
      coverage: { loaded: 2, possiblyTruncated: false } }) }),
  });
  assert.equal(ambiguous.outcome, 'needs_input');
  assert.equal(ambiguous.issue, 'guest_ambiguous');
  assert.deepEqual(ambiguous.guestCandidates.map((item) => item.nativeId), ['123', '124']);
});
