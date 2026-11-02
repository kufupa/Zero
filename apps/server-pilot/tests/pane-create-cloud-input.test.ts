import { describe, expect, it } from 'vitest';
import { digestPaneCloudCreateProof, mapPaneStayToCloudCreateInput } from '../src/ai/pane-create-cloud-input.js';

const stay = {
  firstName: 'Proof', lastName: 'Labtest', propertyCode: 'HRCEN',
  arrival: '2027-01-10', departure: '2027-01-12', adults: 1, childAges: [],
  roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'NGI', sourceOfBusiness: 'WKIN',
  reservationNote: 'Staff reviewed Labtest booking',
};
const proof = {
  propertyCode: 'HRCEN', guest: { nativeId: '123', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: stay.arrival, departure: stay.departure, adults: 1, childAges: [] },
  room: { roomType: stay.roomType, ratePlan: stay.ratePlan }, guaranteeType: 'NGI',
  sourceOfBusiness: { nativeCode: 'WKIN', description: 'Walk in' }, note: stay.reservationNote,
  sendHmsConfirmation: { kind: 'never' },
};

describe('Cloud pane create mapping', () => {
  it('maps a supported Labtest draft without enabling email or save', () => {
    expect(mapPaneStayToCloudCreateInput(stay, 'prepare')).toMatchObject({ outcome: 'ok', input: {
      mode: 'prepare', guest: { search: { firstName: 'Proof', lastName: 'Labtest' } },
      stay: { childAges: [], childCount: 0 }, cms: { send: false },
    } });
    expect(mapPaneStayToCloudCreateInput(stay, 'commit')).toMatchObject({
      outcome: 'refused', reason: 'prepared_guest_identity_required',
    });
    expect(mapPaneStayToCloudCreateInput(stay, 'commit', '123')).toMatchObject({
      outcome: 'ok', input: { mode: 'commit', guest: { profileId: '123' }, cms: { send: false } },
    });
  });

  it('refuses unsupported requested fields instead of dropping them', () => {
    for (const [field, value] of Object.entries({ track: 'A', marketSegment: 'A',
      bookerName: 'A', bookerEmail: 'a@example.test', guestoptin4: false,
      confirmationRecipient: { mode: 'client', address: 'a@example.test' } })) {
      expect(mapPaneStayToCloudCreateInput({ ...stay, [field]: value }, 'prepare')).toMatchObject({
        outcome: 'refused', reason: 'cloud_create_field_unsupported', field,
      });
    }
    expect(mapPaneStayToCloudCreateInput({ ...stay, childAges: undefined }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'child_ages_required' });
    expect(mapPaneStayToCloudCreateInput({ ...stay, lastName: 'Other' }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'labtest_guest_required' });
  });

  it('accepts only native proof matching the reviewed stay and no-send intent', () => {
    expect(digestPaneCloudCreateProof(stay, proof)).toMatchObject({ outcome: 'ok',
      normalizedRequestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const mismatches = [
      { ...proof, guest: { ...proof.guest, nativeId: 'bad' } },
      { ...proof, stay: { ...proof.stay, adults: 2 } },
      { ...proof, room: { ...proof.room, ratePlan: 'OTHER' } },
      { ...proof, note: 'different' },
      { ...proof, sendHmsConfirmation: { kind: 'send', recipient: 'a@example.test' } },
      { ...proof, reasonForStay: { value: 'A', display: 'A' } },
      { ...proof, parties: { arAccount: { nativeId: '1234', name: 'Account' } }, billingReference: 'ref' },
    ];
    for (const mismatch of mismatches) expect(digestPaneCloudCreateProof(stay, mismatch).outcome).toBe('refused');
  });

  it('requires party identities and rejects different native selections', () => {
    expect(mapPaneStayToCloudCreateInput({ ...stay, organization: { name: 'Company' } }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'organization_id_and_name_required' });
    const withParty = { ...stay, organization: { nativeId: '456', name: 'Company' } };
    const partyProof = { ...proof, parties: { organization: { nativeId: '456', name: 'Company' } } };
    expect(digestPaneCloudCreateProof(withParty, partyProof).outcome).toBe('ok');
    expect(digestPaneCloudCreateProof(withParty, { ...partyProof, parties: { organization: { nativeId: '789', name: 'Company' } } }).outcome).toBe('refused');
    expect(digestPaneCloudCreateProof(stay, partyProof).outcome).toBe('refused');
  });
});
