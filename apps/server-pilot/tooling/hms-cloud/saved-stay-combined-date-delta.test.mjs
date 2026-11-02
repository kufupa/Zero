import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCombinedDateDraft } from './saved-stay-combined-date-delta.mjs';

const expected = { arrival:'2026-11-15', departure:'2026-11-20' };
const changes = { departure:'2026-11-21' };
function snapshots() {
  const before = { data:{ arrivaldate:'11/15/2026', departuredate:'11/20/2026', adults:'2', other:'same' },
    values:{ arrivaldate:'15-NOV-2026', departuredate:'20-NOV-2026', adults:'2', other:'same' },
    formDirty:true, recordDirty:true, dirtyFields:['adults'], modifiedFields:['adults'],
    partyControls:[], partyInputsBlank:true };
  const after = structuredClone(before);
  after.values.departuredate = '21-NOV-2026';
  after.dirtyFields.push('departuredate');
  return { before, after };
}
test('accepts only the requested date delta on the established occupancy draft', () => {
  const { before, after } = snapshots();
  assert.equal(matchesCombinedDateDraft(before, after, expected, changes), true);
  after.data.other = 'changed';
  assert.equal(matchesCombinedDateDraft(before, after, expected, changes), false);
});
test('rejects stale occupancy, duplicate dirty fields and unrequested changes', () => {
  for (const edit of [
    (after) => { after.dirtyFields = ['departuredate']; },
    (after) => { after.dirtyFields.push('departuredate'); },
    (after) => { after.values.arrivaldate = '16-NOV-2026'; },
    (after) => { after.partyInputsBlank = false; },
  ]) {
    const { before, after } = snapshots(); edit(after);
    assert.equal(matchesCombinedDateDraft(before, after, expected, changes), false);
  }
});
