import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rules = await import('./create-proof-rules.mjs').catch(() => ({}));
const EXPECTED = {
  arrival: '2027-10-12',
  departure: '2027-10-13',
  roomType: 'STQN',
  firstName: 'Proof',
  lastName: 'Labtest',
};

test('create readback compares date range, room type, and full guest name', () => {
  assert.equal(typeof rules.compareCreatedStay, 'function');
  assert.deepEqual(rules.compareCreatedStay(EXPECTED, {
    arrival: '2027-10-12',
    departure: '2027-10-13',
    roomType: 'stqn',
    firstName: ' proof  ',
    lastName: 'LABTEST',
  }), { readbackMatch: true, mismatches: [] });
});

test('create readback returns every field mismatch, including the combined guest name', () => {
  assert.equal(typeof rules.compareCreatedStay, 'function');
  assert.deepEqual(rules.compareCreatedStay(EXPECTED, {
    arrival: '2027-10-13',
    departure: '2027-10-14',
    roomType: 'STWN',
    firstName: 'Ada',
    lastName: 'Lovelace',
  }), {
    readbackMatch: false,
    mismatches: [
      { field: 'arrival', expected: '2027-10-12', actual: '2027-10-13' },
      { field: 'departure', expected: '2027-10-13', actual: '2027-10-14' },
      { field: 'roomType', expected: 'STQN', actual: 'STWN' },
      { field: 'guestName', expected: 'Proof Labtest', actual: 'Ada Lovelace' },
    ],
  });
});

test('confirmed save reads by confirmation and skips guest/date reconciliation', async () => {
  const calls = [];
  assert.equal(typeof rules.reconcileCreateSave, 'function');
  const result = await rules.reconcileCreateSave({
    save: { confirmed: true, confirmationNumber: '61143613-1' },
    expected: EXPECTED,
    existingRows: [],
    readByConfirmation: async (confirmation) => {
      calls.push(['confirmation', confirmation]);
      return {
        outcome: 'found',
        stay: { ...EXPECTED, status: 'Reserved' },
        screenshot: '/tmp/readback.png',
      };
    },
    searchByGuestDates: async () => {
      calls.push(['guest_dates']);
      return { outcome: 'ok', rows: [] };
    },
  });
  assert.deepEqual(calls, [['confirmation', '61143613-1']]);
  assert.deepEqual(result, {
    confNo: '61143613-1',
    readbackMatch: true,
    mismatches: [],
    screenshot: '/tmp/readback.png',
    unknownOutcome: null,
  });
});

test('pane commit is committed only when readback matches', () => {
  assert.equal(typeof rules.paneCommitOutcome, 'function');
  assert.equal(rules.paneCommitOutcome({ readbackMatch: true }), 'committed');
  assert.equal(rules.paneCommitOutcome({ readbackMatch: false, mismatches: [{ field: 'roomType' }] }), 'committed_unverified');
  assert.equal(rules.paneCommitOutcome({ readbackMatch: null, unknownOutcome: 'unresolved' }), 'committed_unverified');
  assert.equal(rules.paneCommitOutcome({ readbackMatch: null, unknownOutcome: 'not_found' }), 'committed_unverified');
});

test('conflicting observed confirmations remain unresolved without guessing a match', async () => {
  let calls = 0;
  const observed = ['11111111-1', '22222222-1', '33333333-1'];
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null, reason: 'conflicting_confirmation_numbers', conflictingConfirmationNumbers: observed },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async () => { calls += 1; return { outcome: 'ok', rows: [] }; },
    readByConfirmation: async () => { calls += 1; return { outcome: 'found', stay: EXPECTED }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.confNo, null);
  assert.equal(result.unknownOutcome, 'unresolved');
  assert.equal(result.conflictReason, 'conflicting_confirmation_numbers');
  assert.deepEqual(result.conflictingConfirmationNumbers, observed);
  assert.equal(rules.paneCommitOutcome(result), 'committed_unverified');
});

test('confirmed save retains confirmation when readback throws', async () => {
  const result = await rules.reconcileCreateSave({
    save: { confirmed: true, confirmationNumber: '61143613-1' },
    expected: EXPECTED,
    existingRows: [],
    readByConfirmation: async () => { throw new Error('readback unavailable'); },
    searchByGuestDates: async () => {
      throw new Error('confirmed save must not search guest dates');
    },
  });
  assert.equal(result.confNo, '61143613-1');
  assert.equal(result.readbackMatch, null);
  assert.deepEqual(result.mismatches, [{
    field: 'reservation',
    expected: 'found active confirmation',
    actual: 'readback_error',
  }]);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('confirmed save retains confirmation when readback cannot find it', async () => {
  const result = await rules.reconcileCreateSave({
    save: { confirmed: true, confirmationNumber: '61143613-1' },
    expected: EXPECTED,
    existingRows: [],
    readByConfirmation: async () => ({ outcome: 'not_found' }),
    searchByGuestDates: async () => {
      throw new Error('confirmed save must not search guest dates');
    },
  });
  assert.equal(result.confNo, '61143613-1');
  assert.equal(result.readbackMatch, null);
  assert.deepEqual(result.mismatches, [{
    field: 'reservation',
    expected: 'found active confirmation',
    actual: 'not_found',
  }]);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('unknown save searches guest/dates once, then reads the found record by confirmation', async () => {
  const calls = [];
  assert.equal(typeof rules.reconcileCreateSave, 'function');
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: '61143613-1' },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async (request) => {
      calls.push(['guest_dates', request.lastName, request.arrival, request.departure]);
      return {
        outcome: 'ok',
        rows: [{
          confirmation: '61143613-1',
          firstName: 'Proof',
          lastName: 'Labtest',
          arrival: '2027-10-12',
          departure: '2027-10-13',
          status: 'Reserved',
        }],
        screenshot: '/tmp/panel.png',
      };
    },
    readByConfirmation: async (confirmation) => {
      calls.push(['confirmation', confirmation]);
      return {
        outcome: 'found',
        stay: { ...EXPECTED, status: 'Reserved' },
        screenshot: '/tmp/readback.png',
      };
    },
  });
  assert.deepEqual(calls, [
    ['guest_dates', 'Labtest', '2027-10-12', '2027-10-13'],
    ['confirmation', '61143613-1'],
  ]);
  assert.deepEqual(result, {
    confNo: '61143613-1',
    readbackMatch: true,
    mismatches: [],
    screenshot: '/tmp/readback.png',
    unknownOutcome: 'found',
  });
});

test('unknown save does not substitute a different found confirmation for the breadcrumb', async () => {
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: '11111111-1' },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async () => ({
      outcome: 'ok',
      rows: [{ ...EXPECTED, confirmation: '22222222-1', status: 'Reserved' }],
    }),
    readByConfirmation: async () => { throw new Error('conflicting numbers must remain unresolved'); },
  });
  assert.equal(result.confNo, null);
  assert.equal(result.unknownOutcome, 'unresolved');
  assert.deepEqual(result.conflictingConfirmationNumbers, ['11111111-1', '22222222-1']);
  assert.equal(rules.paneCommitOutcome(result), 'committed_unverified');
});

test('unknown save reports not_found without confirmation readback or retry', async () => {
  const calls = [];
  assert.equal(typeof rules.reconcileCreateSave, 'function');
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async () => {
      calls.push('guest_dates');
      return { outcome: 'ok', rows: [], screenshot: '/tmp/panel.png' };
    },
    readByConfirmation: async () => {
      calls.push('confirmation');
      return { outcome: 'found', stay: EXPECTED };
    },
  });
  assert.deepEqual(calls, ['guest_dates']);
  assert.deepEqual(result, {
    confNo: null,
    readbackMatch: null,
    mismatches: [],
    screenshot: '/tmp/panel.png',
    unknownOutcome: 'not_found',
  });
});

test('unknown save cannot prove a matching confirmation that existed before save', async () => {
  const existing = [{ confirmation: '61143613-1', ...EXPECTED, status: 'Reserved' }];
  const calls = [];
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null },
    expected: EXPECTED,
    existingRows: existing,
    searchByGuestDates: async () => ({ outcome: 'ok', rows: existing }),
    readByConfirmation: async () => {
      calls.push('readback');
      return { outcome: 'found', stay: { ...EXPECTED, status: 'Reserved' } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.readbackMatch, null);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('unknown save cannot prove a prior row with incomplete first name or departure', async () => {
  const existing = [{
    confirmation: '61143613-1',
    firstName: '',
    lastName: EXPECTED.lastName,
    arrival: EXPECTED.arrival,
    departure: null,
    status: 'Reserved',
  }];
  const calls = [];
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null },
    expected: EXPECTED,
    existingRows: existing,
    searchByGuestDates: async () => ({
      outcome: 'ok',
      rows: [{ confirmation: '61143613-1', ...EXPECTED, status: 'Reserved' }],
    }),
    readByConfirmation: async (confirmation) => {
      calls.push(confirmation);
      return { outcome: 'found', stay: { ...EXPECTED, status: 'Reserved' } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.confNo, null);
  assert.equal(result.readbackMatch, null);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('unknown save stays unresolved when a possible new row is incomplete', async () => {
  const calls = [];
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async () => ({
      outcome: 'ok',
      rows: [{
        confirmation: '61143613-2',
        firstName: '',
        lastName: EXPECTED.lastName,
        arrival: EXPECTED.arrival,
        departure: null,
        status: 'Reserved',
      }],
    }),
    readByConfirmation: async (confirmation) => {
      calls.push(confirmation);
      return { outcome: 'found', stay: { ...EXPECTED, status: 'Reserved' } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.confNo, null);
  assert.equal(result.readbackMatch, null);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('unknown save cannot prove a newly matching canceled reservation', async () => {
  const canceled = [{ confirmation: '61143613-2', ...EXPECTED, status: 'Cancelled' }];
  const calls = [];
  const result = await rules.reconcileCreateSave({
    save: { confirmed: false, confirmationNumber: null },
    expected: EXPECTED,
    existingRows: [],
    searchByGuestDates: async () => ({ outcome: 'ok', rows: canceled }),
    readByConfirmation: async () => {
      calls.push('readback');
      return { outcome: 'found', stay: { ...EXPECTED, status: 'Cancelled' } };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.readbackMatch, null);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('confirmed save stays unresolved when confirmation readback is canceled', async () => {
  const result = await rules.reconcileCreateSave({
    save: { confirmed: true, confirmationNumber: '61143613-2' },
    expected: EXPECTED,
    existingRows: [],
    readByConfirmation: async () => ({
      outcome: 'found',
      stay: { ...EXPECTED, status: 'Cancelled' },
    }),
    searchByGuestDates: async () => {
      throw new Error('confirmed save must not search guest dates');
    },
  });
  assert.equal(result.confNo, '61143613-2');
  assert.equal(result.readbackMatch, null);
  assert.equal(result.unknownOutcome, 'unresolved');
});

test('proof mode accepts only the committed Lab flag and exact Proof Labtest guest', () => {
  assert.equal(typeof rules.proofModeRefusal, 'function');
  assert.equal(rules.proofModeRefusal({
    request: EXPECTED,
    paneCommit: true,
    env: { RESERVATIONIST_PANE_SAVE: 'lab' },
  }), null);
  assert.equal(rules.proofModeRefusal({
    request: EXPECTED,
    paneCommit: true,
    env: { RESERVATIONIST_PANE_SAVE: 'on' },
  }), 'proof_requires_lab_flag');
  assert.equal(rules.proofModeRefusal({
    request: EXPECTED,
    paneCommit: false,
    env: { RESERVATIONIST_PANE_SAVE: 'lab' },
  }), 'proof_requires_pane_commit');
  assert.equal(rules.proofModeRefusal({
    request: { ...EXPECTED, firstName: 'Nava' },
    paneCommit: true,
    env: { RESERVATIONIST_PANE_SAVE: 'lab' },
  }), 'proof_guest_required');
  assert.equal(rules.proofModeRefusal({
    request: { ...EXPECTED, lastName: 'Other' },
    paneCommit: true,
    env: { RESERVATIONIST_PANE_SAVE: 'lab' },
  }), 'proof_guest_required');
});

test('proof mode refuses invalid or pre-2027 dates and non-positive stays', () => {
  assert.equal(typeof rules.proofModeRefusal, 'function');
  const options = { paneCommit: true, env: { RESERVATIONIST_PANE_SAVE: 'lab' } };
  assert.equal(rules.proofModeRefusal({ ...options, request: { ...EXPECTED, arrival: '2026-12-31' } }), 'proof_dates_2027_required');
  assert.equal(rules.proofModeRefusal({ ...options, request: { ...EXPECTED, departure: '2026-12-31' } }), 'proof_dates_2027_required');
  assert.equal(rules.proofModeRefusal({ ...options, request: { ...EXPECTED, arrival: '2027-02-30' } }), 'proof_dates_2027_required');
  assert.equal(rules.proofModeRefusal({ ...options, request: { ...EXPECTED, departure: EXPECTED.arrival } }), 'proof_departure_after_arrival');
});

test('Save-click errors distinguish definite missing control from possible dispatch', () => {
  assert.equal(typeof rules.saveClickMayHaveFired, 'function');
  assert.equal(rules.saveClickMayHaveFired(new Error('control_missing:^Save')), false);
  assert.equal(rules.saveClickMayHaveFired(new Error('Execution context was destroyed')), true);
});

test('stay lookup exposes reusable on-open confirmation and guest/date readers', async () => {
  const source = await readFile(new URL('./stay-lookup.mjs', import.meta.url), 'utf8');
  assert.match(source, /export async function findOnOpenGuestStay/);
  assert.match(source, /export async function searchGuestOnOpenGuestStay/);
  assert.match(source, /export async function searchGuestOnOpenGuestStay\(ctx\) \{\s*if \(!ctx\.result\) ctx\.result = newLookupResult\(ctx\.args\);/);
});

test('confirmed save retains confirmation when pre-save rows are unavailable or incomplete', async () => {
  for (const existingRows of [null, [{ ...EXPECTED, status: 'Reserved' }]]) {
    const result = await rules.reconcileCreateSave({
      save: { confirmed: true, confirmationNumber: '61143613-1' },
      expected: EXPECTED,
      existingRows,
      readByConfirmation: async () => {
        throw new Error('unusable pre-save rows must stop reconciliation');
      },
      searchByGuestDates: async () => {
        throw new Error('confirmed save must not search guest dates');
      },
    });
    assert.equal(result.confNo, '61143613-1');
    assert.equal(result.unknownOutcome, 'unresolved');
  }
});

test('proof pre-save search refuses Save when baseline rows are unavailable', () => {
  assert.equal(typeof rules.proofPreSaveSearchRefusal, 'function');
  assert.equal(rules.proofPreSaveSearchRefusal(null), 'proof_pre_save_search_unavailable');
  assert.equal(rules.proofPreSaveSearchRefusal(undefined), 'proof_pre_save_search_unavailable');
  assert.equal(rules.proofPreSaveSearchRefusal([]), null);
});

test('proof mode refuses profile, party, company, account, and billing fields', () => {
  const options = { paneCommit: true, env: { RESERVATIONIST_PANE_SAVE: 'lab' } };
  const fields = {
    profileId: 42,
    arAccount: 'Legacy Hotels AR',
    billingReference: 'PO-1',
    agency: 'Travel Agent Ltd',
    bookingAgency: { nativeId: '49', name: 'Travel Agent Ltd' },
    organization: { nativeId: '84', name: 'Real Company Ltd' },
    reservationNote: 'Charge to company account',
    bookerName: 'Jane Booker',
    bookerEmail: 'jane@example.test',
  };
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(
      rules.proofModeRefusal({ ...options, request: { ...EXPECTED, [field]: value } }),
      'proof_party_or_billing_fields_forbidden',
      `proof mode must refuse ${field}`,
    );
  }
});
