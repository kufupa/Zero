import { describe, expect, it } from 'vitest';
import { digestPaneCloudCreateProof, mapPaneStayToCloudCreateInput } from '../src/ai/pane-create-cloud-input.js';
import { CREATE_GUARANTEES } from '../tooling/hms-cloud/cloud-create-policy.mjs';
import generatedNote from '../tooling/hms-cloud/fixtures/generated-reservation-note.json';

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
  it('binds the exact generated multiline reservation note through prepare and commit', () => {
    const reviewed = { ...stay, reservationNote: generatedNote.note };
    const native = { ...proof, note: generatedNote.note };
    expect(reviewed.reservationNote.length).toBeGreaterThan(200);
    for (const mode of ['prepare', 'commit'] as const) {
      expect(mapPaneStayToCloudCreateInput(reviewed, mode, '123')).toMatchObject({
        outcome: 'ok', input: { note: generatedNote.note },
      });
    }
    expect(digestPaneCloudCreateProof(reviewed, native, undefined, '123')).toMatchObject({
      outcome: 'ok', request: { note: generatedNote.note },
    });
    expect(digestPaneCloudCreateProof(reviewed, { ...native, note: generatedNote.note.replace('\n', ' ') }).outcome).toBe('refused');
    for (const note of ['x'.repeat(2_001), 'a\rb', 'a\0b', 'a\tb']) {
      expect(mapPaneStayToCloudCreateInput({ ...reviewed, reservationNote: note }, 'prepare').outcome).toBe('refused');
    }
    expect(mapPaneStayToCloudCreateInput({ ...reviewed, reservationNote: 'x'.repeat(2_000) }, 'prepare').outcome).toBe('ok');
  });
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

  it('preserves an explicitly chosen profile from prepare through proof', () => {
    expect(mapPaneStayToCloudCreateInput(stay, 'prepare', '123')).toMatchObject({
      outcome: 'ok', input: { mode: 'prepare', guest: { profileId: '123' } },
    });
    expect(mapPaneStayToCloudCreateInput(stay, 'prepare', '')).toMatchObject({
      outcome: 'refused', reason: 'prepared_guest_identity_required',
    });
    expect(digestPaneCloudCreateProof(stay, proof, undefined, '123').outcome).toBe('ok');
    expect(digestPaneCloudCreateProof(stay, proof, undefined, '456').outcome).toBe('refused');
    expect(digestPaneCloudCreateProof(stay, proof, undefined, 'not-a-native-id').outcome).toBe('refused');
  });

  it.each(Object.entries(CREATE_GUARANTEES).flatMap(([native, label]) => [
    [native, native, label], [label, native, label],
  ]))('maps and binds reviewed guarantee %s to native %s', (display, native, label) => {
    const reviewed = { ...stay, guaranteeType: display };
    expect(mapPaneStayToCloudCreateInput(reviewed, 'commit', '123')).toMatchObject({
      outcome: 'ok', input: { guaranteeType: native },
    });
    expect(digestPaneCloudCreateProof(reviewed, { ...proof, guaranteeType: native }, label, undefined, true).outcome).toBe('ok');
    const other = native === 'NGI' ? 'GTDAGT' : 'NGI';
    expect(digestPaneCloudCreateProof(reviewed, { ...proof, guaranteeType: other }, display).outcome).toBe('refused');
    if (display !== native) {
      expect(digestPaneCloudCreateProof(reviewed, { ...proof, guaranteeType: native }).outcome).toBe('refused');
      expect(digestPaneCloudCreateProof(reviewed, { ...proof, guaranteeType: native }, 'different').outcome).toBe('refused');
    }
  });

  it('rejects unobserved guarantee aliases', () => {
    for (const guaranteeType of ['CC', '6PM', 'COMP', 'PREPAID']) {
      expect(mapPaneStayToCloudCreateInput({ ...stay, guaranteeType }, 'commit', '123').outcome).toBe('refused');
    }
  });

  it('refuses unsupported requested fields instead of dropping them', () => {
    for (const [field, value] of Object.entries({ track: 'A', marketSegment: 'A',
      bookerName: 'invalid\nname', bookerEmail: 'a\n@example.test', guestoptin4: true,
      confirmationRecipient: { mode: 'client', address: 'invalid' } })) {
      expect(mapPaneStayToCloudCreateInput({ ...stay, [field]: value }, 'prepare')).toMatchObject({
        outcome: 'refused', reason: 'cloud_create_field_unsupported', field,
      });
    }
    expect(mapPaneStayToCloudCreateInput({ ...stay, childAges: undefined }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'child_ages_required' });
    for (const name of ['', '   ', 'Guest\nName']) {
      expect(mapPaneStayToCloudCreateInput({ ...stay, lastName: name }, 'prepare'))
        .toMatchObject({ outcome: 'refused', reason: 'guest_name_required' });
    }
  });

  it('binds the reviewed booker and recipient without enabling CMS send', () => {
    const reviewed = { ...stay, bookerName: 'Staff Booker', bookerEmail: 'booker@example.test',
      confirmationSendMail: false, confirmationRecipient: { mode: 'client' as const, address: 'client@example.test' } };
    const native = { ...proof, booker: { name: reviewed.bookerName, contact: reviewed.bookerEmail },
      cmsRecipient: reviewed.confirmationRecipient.address };
    expect(mapPaneStayToCloudCreateInput(reviewed, 'commit', '123')).toMatchObject({ outcome: 'ok', input: {
      booker: native.booker, cms: { send: false, recipient: native.cmsRecipient },
    } });
    expect(digestPaneCloudCreateProof(reviewed, native).outcome).toBe('ok');
    expect(digestPaneCloudCreateProof(reviewed, { ...native, cmsRecipient: 'other@example.test' }).outcome).toBe('refused');
    expect(digestPaneCloudCreateProof(reviewed, { ...native, booker: { ...native.booker, name: 'Other' } }).outcome).toBe('refused');
    expect(mapPaneStayToCloudCreateInput({ ...reviewed, confirmationSendMail: true }, 'commit', '123')).toMatchObject({
      outcome: 'refused', reason: 'confirmation_email_writer_unavailable',
    });
  });

  it('binds the selected track and explicitly false guest opt-in', () => {
    const reviewed = { ...stay, track: 'BAR', guestoptin4: false };
    const native = { ...proof, track: { lookupCode: 'BAR', display: 'Best Available' }, guestOptIn: false };
    expect(mapPaneStayToCloudCreateInput(reviewed, 'prepare')).toMatchObject({ outcome: 'ok', input: {
      track: 'BAR', guestoptin4: false,
    } });
    expect(digestPaneCloudCreateProof(reviewed, native).outcome).toBe('ok');
    expect(digestPaneCloudCreateProof(reviewed, { ...native, track: { ...native.track, display: 'Corporate Rate' } }).outcome).toBe('refused');
    expect(digestPaneCloudCreateProof(reviewed, { ...native, guestOptIn: true }).outcome).toBe('refused');
    expect(digestPaneCloudCreateProof(reviewed, proof).outcome).toBe('refused');
  });

  it('uses the requested guest name for unsaved preparation and keeps real-guest commits refused', () => {
    const real = { ...stay, firstName: 'Ada', lastName: 'Moyo' };
    expect(mapPaneStayToCloudCreateInput(real, 'prepare')).toMatchObject({ outcome: 'ok', input: {
      mode: 'prepare', guest: { search: { firstName: 'Ada', lastName: 'Moyo' } }, cms: { send: false },
    } });
    expect(mapPaneStayToCloudCreateInput(real, 'commit', '123')).toMatchObject({
      outcome: 'refused', reason: 'labtest_guest_required',
    });
    expect(mapPaneStayToCloudCreateInput(real, 'commit', '123', { allowRealGuest: true })).toMatchObject({
      outcome: 'ok', input: { guest: { profileId: '123' }, cms: { send: false } },
    });
    const observed = { ...proof, guest: { ...proof.guest, firstName: 'Ada', lastName: 'Moyo' } };
    expect(digestPaneCloudCreateProof(real, observed).outcome).toBe('ok');
    expect(digestPaneCloudCreateProof(real, proof).outcome).toBe('refused');
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

  it('refuses proof for stays outside the supported mapping even when native proof matches', () => {
    const unsupported = [
      { ...stay, propertyCode: 'HRDAV' },
      { ...stay, guaranteeType: 'GTD' },
      { ...stay, marketSegment: 'CORP' },
      { ...stay, confirmationSendMail: true },
    ];
    for (const request of unsupported) {
      expect(mapPaneStayToCloudCreateInput(request, 'prepare').outcome).toBe('refused');
      expect(digestPaneCloudCreateProof(request, proof)).toEqual({
        outcome: 'refused', reason: 'cloud_create_proof_mismatch',
      });
    }
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
