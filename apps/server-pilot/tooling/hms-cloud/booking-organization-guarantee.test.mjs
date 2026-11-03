import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLabtestOrganizationReadbackTarget } from './booking-lookup-session.mjs';

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

test('organization readback target refuses an unverified or unsupported guarantee', () => {
  for (const bad of [
    { guaranteeType: 'GTDCC' },
    { guaranteeSelection: undefined },
    { guaranteeSelection: { ...selection, requested: 'NGI' } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, value: 'NGI' } } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, submitted: 'NGI' } } },
    { guaranteeSelection: { ...selection, actual: { ...selection.actual, display: '' } } },
  ]) assert.equal(buildLabtestOrganizationReadbackTarget(saved, { ...request, ...bad }, organization), null);
});
