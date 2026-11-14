import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLabtestOrganizationReadbackTarget, readSavedOrganizationCreate } from './booking-lookup-session.mjs';

const organization = { outcome: 'selected_unsaved', nativeId: '41', displayedOrganization: 'Example Company',
  searchId: 'search-1', profileProofToken: 'profile-1', nativeIdEvidence: 'form_change_response',
  selectedField: { name: 'company', value: 'Example Company' } };
const selection = { outcome: 'updated_unsaved', field: 'guaranteeType', requested: 'GTDAGT',
  actual: { value: 'GTDAGT', submitted: 'GTDAGT', display: 'Guaranteed By Agent' } };
const request = { guestId: '123', arrival: '2027-11-12', departure: '2027-11-14', roomType: 'STQN',
  ratePlan: 'BAR', note: 'Proof Labtest test', organizationSelection: organization,
  guaranteeType: 'GTDAGT', guaranteeSelection: selection };
const saved = { outcome: 'saved_same_form', confirmation: '123456-1' };

test('organization readback target binds the exact saved guarantee selection', () => {
  const target = buildLabtestOrganizationReadbackTarget(saved, request, organization);
  assert.deepEqual(target.expectedGuarantee, { code: 'GTDAGT', display: 'Guaranteed By Agent' });
  const ngi = buildLabtestOrganizationReadbackTarget(saved,
    { ...request, guaranteeType: 'NGI', guaranteeSelection: undefined }, organization);
  assert.deepEqual(ngi.expectedGuarantee, { code: 'NGI', display: 'Non-Guaranteed Individual' });
});

test('organization readback accepts the reviewed HMS textarea limit without changing the note', () => {
  const note = `Line one\n${'x'.repeat(1_991)}`;
  assert.equal(note.length, 2_000);
  assert.equal(buildLabtestOrganizationReadbackTarget(saved, { ...request, note }, organization).expected.note, note);
  assert.equal(buildLabtestOrganizationReadbackTarget(saved, { ...request, note: `${note}x` }, organization), null);
});

test('organization readback target refuses an unverified or unsupported guarantee', () => {
  for (const bad of [
    { guaranteeType: 'CC' },
    { guaranteeSelection: undefined },
    { guaranteeSelection: { ...selection, requested: 'NGI' } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, value: 'NGI' } } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, submitted: 'NGI' } } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, display: '' } } },
  ]) assert.equal(buildLabtestOrganizationReadbackTarget(saved, { ...request, ...bad }, organization), null);
});

test('real organization readback binds the trusted guest and target-scoped browser', async () => {
  const realSelection = { ...selection, requested: 'GTDCC', actual: { value: 'GTDCC', submitted: 'GTDCC',
    display: 'Guaranteed By Credit Card' } };
  const realRequest = { ...request, guaranteeType: 'GTDCC', guaranteeSelection: realSelection };
  const cloudTargetKey = '["HRCEN","create","ada","moyo","2027-11-12"]';
  const authority = { allowRealGuest: true, expectedGuest: { firstName: 'Ada', lastName: 'Moyo' }, cloudTargetKey };
  const target = buildLabtestOrganizationReadbackTarget(saved, realRequest, organization, authority);
  assert.deepEqual({ firstName: target.expected.firstName, lastName: target.expected.lastName }, authority.expectedGuest);
  assert.equal(target.cloudTargetKey, cloudTargetKey);
  assert.equal(buildLabtestOrganizationReadbackTarget(saved, realRequest, organization,
    { ...authority, cloudTargetKey: 'wrong' }), null);
  const result = await readSavedOrganizationCreate({ savedOrganizationCreate: target }, { confirmation: saved.confirmation }, {
    openSession: async (_operation, options) => {
      assert.equal(options.cloudTargetKey, cloudTargetKey);
      return { outcome: 'read_back_verified' };
    },
  });
  assert.equal(result.outcome, 'read_back_verified');
});

test('organization readback selects the property and guards before the first page', async () => {
  const target = buildLabtestOrganizationReadbackTarget(saved, request, organization);
  let blocked = false, installed = false;
  const result = await readSavedOrganizationCreate({ savedOrganizationCreate: target }, { confirmation: saved.confirmation }, {
    openSession: async (_operation, options) => {
      assert.equal(options.propertyCode, 'HRCEN');
      assert.equal(options.startScreen, 'OSRESS');
      await options.prepareContext({ routeWebSocket: async () => {}, route: async (_pattern, handler) => {
        installed = true;
        await handler({ request: () => ({ method: () => 'POST',
          url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
          postData: () => null, headers: () => ({}) }), abort: async () => { blocked = true; }, fallback: async () => {} });
      } });
      return { outcome: 'read_back_verified' };
    },
  });
  assert.equal(installed && blocked, true);
  assert.equal(result.outcome, 'read_back_verified');
});
