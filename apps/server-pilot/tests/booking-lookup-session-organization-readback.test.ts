import { describe, expect, it } from 'vitest';
import {
  buildLabtestOrganizationReadbackTarget,
  labtestRecordOptionsForOrganizationSelection,
  sameSessionOrganizationSelection,
} from '../tooling/hms-cloud/booking-lookup-session.mjs';

const selection = {
  outcome: 'selected_unsaved', nativeId: '90210', searchId: 'org-search-1',
  displayedOrganization: 'Synthetic Company', profileProofToken: 'profile-proof-1',
  nativeIdEvidence: 'form_change_response', selectedField: { name: 'company', value: 'Synthetic Company' },
};
const request = {
  preimageId: 'preimage-1', arrival: '2027-01-25', departure: '2027-01-27', guestId: '45678',
  roomType: 'DLXKNG', ratePlan: 'BAR', guaranteeType: 'NGI', note: 'synthetic org create',
  organizationSelection: selection,
};
const saved = { outcome: 'saved_same_form', confirmation: '1234567-1' };

describe('booking-session linked-organization readback binding', () => {
  it('passes the exact live picker ID and visible name to the saved-record guard', () => {
    expect(labtestRecordOptionsForOrganizationSelection(selection)).toEqual({
      allowUnchangedBusinessParties: true,
      expectedOrganization: { nativeId: '90210', name: 'Synthetic Company' },
    });
  });

  it('rejects a create request that substitutes a different selection or profile proof', () => {
    expect(sameSessionOrganizationSelection(selection, selection)).toBe(true);
    for (const changed of [
      { ...selection, nativeId: '90211' },
      { ...selection, displayedOrganization: 'Different Company' },
      { ...selection, searchId: 'old-search' },
      { ...selection, profileProofToken: 'another-profile' },
      { ...selection, selectedField: { name: 'company', value: 'Different Company' } },
    ]) expect(sameSessionOrganizationSelection(selection, changed)).toBe(false);
  });

  it('binds fresh readback only to a successful organization-only create in this session', () => {
    expect(buildLabtestOrganizationReadbackTarget(saved, request, selection)).toEqual({
      confirmation: '1234567-1',
      expected: {
        confirmation: '1234567-1', guestId: '45678', arrival: '2027-01-25', departure: '2027-01-27',
        roomType: 'DLXKNG', ratePlan: 'BAR', note: 'synthetic org create',
      },
      expectedOrganization: { nativeId: '90210', name: 'Synthetic Company' },
    });
    expect(buildLabtestOrganizationReadbackTarget({ ...saved, outcome: 'uncertain' }, request, selection)).toBeNull();
    expect(buildLabtestOrganizationReadbackTarget(saved, { ...request, agencySelection: {} }, selection)).toBeNull();
    expect(buildLabtestOrganizationReadbackTarget(saved, {
      ...request, organizationSelection: { ...selection, nativeId: '90211' },
    }, selection)).toBeNull();
  });
});
