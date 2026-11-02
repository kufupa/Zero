import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRealDateDraft } from './saved-stay-real-date-delta.mjs';

const expected = { arrival:'2026-11-15', departure:'2026-11-20' };
const changes = { departure:'2026-11-21', adults:2 };
function snapshots() {
  const before = { data:{ arrivaldate:'11/15/2026', departuredate:'11/20/2026', adults:'2',
    nights:'5', departuredayofweek:'Fri', averagerate:'2830', ratetax:'0', enablecheckavailability:'0', other:'same' },
  values:{ arrivaldate:'15-NOV-2026', departuredate:'20-NOV-2026', adults:'2', nights:'5',
    departuredayofweek:'Fri', averagerate:'2,830.00', other:'same' },
  formDirty:true, recordDirty:true, dirtyFields:['adults'], modifiedFields:['adults'],
  partyControls:[], partyInputsBlank:true };
  const after = structuredClone(before);
  after.values.departuredate = '21-NOV-2026'; after.values.nights = '6'; after.values.departuredayofweek = 'Sat';
  after.values.averagerate = ''; after.data.ratetax = ''; after.data.enablecheckavailability = '-1';
  after.dirtyFields.push('departuredate', 'nights', 'departuredayofweek', 'averagerate');
  after.modifiedFields.push('ratetax', 'enablecheckavailability');
  return {before, after};
}
test('accepts the observed date, weekday, nights and invalidation patterns without save authority', () => {
  const {before, after} = snapshots();
  assert.equal(matchesRealDateDraft(before, after, expected, changes), true);
});
test('rejects wrong derived values, arbitrary side effects and missing original dirty fields', () => {
  for (const mutate of [
    (f) => { f.after.values.nights = '7'; },
    (f) => { f.after.values.departuredayofweek = 'Sun'; },
    (f) => { f.after.values.departuredayofweek = 'Fri'; },
    (f) => { f.after.values.nights = '5'; },
    (f) => { f.after.data.nights = '6'; },
    (f) => { f.after.data.ratetax = '123'; },
    (f) => { f.after.data.enablecheckavailability = '1'; },
    (f) => { f.after.values.averagerate = '100'; },
    (f) => { f.after.values.other = ''; },
    (f) => { f.after.dirtyFields = f.after.dirtyFields.filter((name) => name !== 'adults'); },
    (f) => { f.after.dirtyFields.push('company'); },
    (f) => { f.after.partyInputsBlank = false; },
  ]) { const f = snapshots(); mutate(f); assert.equal(matchesRealDateDraft(f.before, f.after, expected, changes), false); }
});
test('accepts an exact simple date-only delta and refuses invalid or stale dates', () => {
  const {before, after} = snapshots();
  for (const part of ['data','values']) for (const key of ['nights','departuredayofweek']) {
    delete before[part][key]; delete after[part][key];
  }
  after.values.averagerate = before.values.averagerate; after.data.ratetax = before.data.ratetax;
  after.data.enablecheckavailability = before.data.enablecheckavailability;
  after.dirtyFields = ['adults', 'departuredate']; after.modifiedFields = ['adults'];
  assert.equal(matchesRealDateDraft(before, after, expected, changes), true);
  assert.equal(matchesRealDateDraft(before, after, {...expected, departure:'2026-11-19'}, changes), false);
  assert.equal(matchesRealDateDraft(before, after, expected, {...changes, departure:'2026-02-30'}), false);
});
