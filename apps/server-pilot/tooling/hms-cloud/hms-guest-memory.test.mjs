import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHmsGuestMemory, queryHmsGuestMemory } from './hms-guest-memory.mjs';

const field = (label, value) => ({ label: `${label}:`, value });
function result(confirmation, id, first, last, email, extra = {}) {
  return {
    ok: true, confirmation,
    provenance: extra.provenance,
    recordView: { details: { activeTab: 'Record View', confirmationInRecord: confirmation, fields: [
      field('Source of Business', extra.source ?? 'E-Mail'), field('Profile ID', id),
      field('First Name', first), field('Last Name', last), field('E-mail Address', email),
      ...(extra.fields || []),
    ] } },
    stay360: { ok: true, confirmation, details: { confirmationInHeader: confirmation, cards: [] } },
  };
}
const snapshot = (results, date = '2026-10-01') => ({ startedAt: `${date}T10:00:00Z`, results });
const build = results => buildHmsGuestMemory({ propertyCode: 'hotel-a', pmsSnapshot: snapshot(results) });
const query = (memory, input, options) => queryHmsGuestMemory(memory, { propertyCode: 'HOTEL-A', ...input }, options);

test('shared email retains separate candidates and historical support without selection', () => {
  const memory = build([
    result('fiction-1', '101', 'Fiction', 'One', 'shared@fiction.invalid'),
    result('fiction-2', '102', 'Fiction', 'Two', 'shared@fiction.invalid'),
    result('fiction-3', '101', 'Fiction', 'Former', 'old@fiction.invalid', { source: 'Voice Call' }),
  ]);
  const found = query(memory, { email: ' SHARED@fiction.invalid ' });
  assert.equal(found.outcome, 'candidates');
  assert.equal(found.candidateCount, 2);
  assert.deepEqual(found.candidates.map(item => item.profileId), ['101', '102']);
  assert.equal(found.candidates[0].support.matchedConfirmationCount, 1);
  assert.equal(found.candidates[0].support.confirmationCount, 2);
  assert.equal(found.candidates[0].sourceOfBusinessCounts['Voice Call'], 1);
  assert.equal(found.candidates[0].fieldStates.lastName.recorded, 2);
  assert.deepEqual(found.candidates[0].values.lastName, ['One', 'Former']);
  assert.ok(found.candidates[0].conflictingFields.includes('lastName'));
  assert.equal(found.candidates[0].evidence[0].fieldSource, 'recordView.details.fields');
  assert.equal(found.candidates[0].evidence[1].matchedQuery, false);
  assert.ok(found.limitations.includes('not_a_selection'));
  assert.deepEqual(query(memory, { firstName: 'Fiction', lastName: 'Two' }).candidates.map(c => c.profileId), ['102']);
  assert.equal(query(memory, { firstName: 'Fiction', lastName: 'Two', email: 'old@fiction.invalid' }).outcome, 'no_match');
});

test('incomplete queries request more input; a historical no-match is not a complete HMS search', () => {
  const memory = build([result('fiction-1', '101', 'Fiction', 'One', 'person@fiction.invalid')]);
  assert.deepEqual(query(memory, {}).missing, ['firstName', 'lastName']);
  assert.deepEqual(query(memory, { firstName: 'Fiction' }).missing, ['lastName']);
  assert.equal(query(memory, { email: 'invalid' }).issue, 'invalid_guest_criterion');
  assert.equal(query(memory, { profileId: 'not-a-number' }).outcome, 'input_gap');
  const absent = query(memory, { email: 'absent@fiction.invalid' });
  assert.equal(absent.outcome, 'no_match');
  assert.ok(absent.limitations.includes('not_current_hms_lookup'));
  assert.equal(absent.coverage.observations, 1);
});

test('property scope fails closed and rejects conflicting declared properties', () => {
  const memory = build([result('fiction-1', '101', 'Fiction', 'One', 'person@fiction.invalid')]);
  assert.throws(() => queryHmsGuestMemory(memory, { profileId: '101' }), /propertyCode/);
  assert.throws(() => queryHmsGuestMemory(memory, { propertyCode: 'hotel-b', profileId: '101' }), /propertyCode/);
  assert.throws(() => buildHmsGuestMemory({ propertyCode: 'hotel-a', pmsSnapshot: { propertyCode: 'hotel-b', results: [] } }), /multiple properties/);
});

test('excludes unverified confirmations and conflicting, unavailable or nonnumeric profile IDs', () => {
  const badView = result('fiction-1', '101', 'Fiction', 'One', 'shared@fiction.invalid');
  badView.stay360.details.confirmationInHeader = 'different';
  const conflict = result('fiction-2', '102', 'Fiction', 'Two', 'shared@fiction.invalid', { fields: [field('Profile ID', '103')] });
  const unavailable = result('fiction-3', null, 'Fiction', 'Three', 'shared@fiction.invalid');
  const invalid = result('fiction-4', 'text-id', 'Fiction', 'Four', 'shared@fiction.invalid');
  const good = result('fiction-5', '105', 'Fiction', 'Five', 'shared@fiction.invalid');
  const found = query(build([badView, conflict, unavailable, invalid, good]), { email: 'shared@fiction.invalid' });
  assert.deepEqual(found.candidates.map(item => item.profileId), ['105']);
  assert.equal(found.coverage.excludedIdentityObservations, 4);
  assert.equal(found.coverage.identityStatusCounts.mismatch, 1);
  assert.equal(found.coverage.profileIdStates.conflicting, 1);
  assert.equal(found.coverage.profileIdStates.unavailable, 1);
  assert.equal(found.coverage.nonnumericProfileIdObservations, 1);
  assert.equal(found.coverage.fieldStates.mobileNumber.missing, 1);
});

test('coverage, deduplication, source exclusions and pagination remain explicit', () => {
  const repeat = result('fiction-1', '101', 'Fiction', 'One', '', { provenance: { verifiedStayId: 'synthetic-stay-1' } });
  const other = result('fiction-2', '102', 'Fiction', 'Two', 'x@fiction.invalid', { source: 'Call Center' });
  const excluded = result('fiction-3', '103', 'Fiction', 'Three', 'x@fiction.invalid', { source: 'Other' });
  const first = snapshot([repeat, other, excluded], '2026-10-01');
  const second = snapshot([repeat], '2026-10-02');
  const memory = buildHmsGuestMemory({ propertyCode: 'hotel-a', pmsSnapshots: [first, second], pmsSourceFiles: ['/private/one.json', '/private/two.json'] });
  const found = query(memory, { firstName: 'Fiction', lastName: 'One' }, { evidenceLimit: 1 });
  assert.equal(found.coverage.input.excludedOtherSourcePmsResultCount, 1);
  assert.equal(found.coverage.fieldStates.email.blank, 2);
  assert.equal(found.candidates[0].support.confirmationCount, 1);
  assert.equal(found.candidates[0].support.observationCount, 2);
  assert.equal(found.candidates[0].evidenceTruncated, true);
  assert.equal(found.candidates[0].evidence[0].snapshot.sourceFile, 'one.json');
  const reordered = buildHmsGuestMemory({ propertyCode: 'hotel-a', pmsSnapshots: [second, first] });
  assert.deepEqual(new Set(memory.observations.map(item => item.fingerprint)), new Set(reordered.observations.map(item => item.fingerprint)));
  assert.throws(() => buildHmsGuestMemory({ propertyCode: 'hotel-a', pmsSnapshots: [snapshot([result('same', '1', 'F', 'X', '')]), snapshot([result('same', '1', 'F', 'X', '')])] }), /verified stay ID/);
  const limited = query(memory, { email: 'x@fiction.invalid' }, { limit: 1 });
  assert.equal(limited.candidateCount, 1);
  assert.equal(limited.candidatesTruncated, false);
  assert.throws(() => query(memory, { profileId: '101' }, { limit: 0 }), /limit/);
});

test('candidate limit is explicit and conflicting-field matches remain uncertain', () => {
  const a = result('fiction-1', '101', 'Fiction', 'One', 'shared@fiction.invalid');
  const b = result('fiction-2', '102', 'Fiction', 'Two', 'shared@fiction.invalid');
  const conflict = result('fiction-3', '103', 'Fiction', 'Three', 'shared@fiction.invalid',
    { fields: [field('Last Name', 'Four')] });
  const memory = build([a, b, conflict]);
  const limited = query(memory, { email: 'shared@fiction.invalid' }, { limit: 1 });
  assert.equal(limited.candidateCount, 3);
  assert.equal(limited.candidates.length, 1);
  assert.equal(limited.candidatesTruncated, true);
  const uncertain = query(memory, { firstName: 'Fiction', lastName: 'Three' });
  assert.equal(uncertain.outcome, 'candidates');
  assert.equal(uncertain.candidates[0].support.matchedObservationsWithUncertainCriteriaCount, 1);
  assert.equal(uncertain.candidates[0].evidence[0].uncertainMatch, true);
  const all = query(memory, { email: 'shared@fiction.invalid' });
  assert.ok(all.candidates.find(item => item.profileId === '103').conflictingFields.includes('lastName'));
});
