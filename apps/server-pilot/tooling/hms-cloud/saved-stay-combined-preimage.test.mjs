import test from 'node:test';
import assert from 'node:assert/strict';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { labtestCombinedAmendPreimageBinding as bind } from './saved-stay-combined-preimage.mjs';

function fixture() {
  const expected = { confirmation:'12345678-1', guestId:'123', arrival:'2027-10-12', departure:'2027-10-13',
    roomType:'STQN', ratePlan:'BAR', note:'', adults:1, childCount:1, childAges:[8] };
  const native = { PKID:'10', bookingsessionid:'100', reservationid:'20', reservationstayid:'30', recordid:'40' };
  const parties = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
  const data = { ...parties, ...native, propertycode:'HRCEN', status:'Reserved', firstname:'Proof', lastname:'Labtest',
    confirmationnumber:expected.confirmation, guestid:expected.guestId, arrivaldate:'10/12/2027', departuredate:'10/13/2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', adults:'1', children:'1', child1:'0', child2:'1', child3:'0',
    childages:'8', guaranteetype:'NGI', udfchkbox04:'0', udfchar13:'', emailaddress:'',
    sessionID:{sessionID:'abc'}, extId:'11', unrelated:'kept' };
  const values = { confirmationnumber:expected.confirmation, guestid:expected.guestId, status:'Reserved',
    firstname:'Proof', lastname:'Labtest', arrivaldate:'12-OCT-2027', departuredate:'13-OCT-2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', guaranteetype:'NGI', udfchar13:'', emailaddress:'',
    adults:'1', children:'1', child1:'0', child2:'1', child3:'0', childages:'8' };
  const snapshot = { data, values, partyControls:[], partyInputsBlank:true, formDirty:false, recordDirty:false, dirtyFields:[], modifiedFields:[] };
  const state = { frame:{}, native, partyPreimage:parties };
  const changes = { departure:'2027-10-14', childCount:2, childAges:[8, 5], retainRates:'yes' };
  return { expected, state, snapshot, changes };
}
const binding = ({expected, state, snapshot, changes}) => bind(expected, state, snapshot, changes);

test('binds complete clean preimage and changes, not browser session identifiers', () => {
  const f = fixture(), first = binding(f);
  assert.match(first?.digest || '', /^[a-f0-9]{64}$/);
  f.state.native.bookingsessionid = f.snapshot.data.bookingsessionid = 'different';
  f.snapshot.data.sessionID = { sessionID:'different' }; f.snapshot.data.extId = 'different';
  assert.deepEqual(binding(f), first);
  f.snapshot.data.unrelated = 'changed';
  assert.notDeepEqual(binding(f), first);
  f.snapshot.data.unrelated = 'kept'; f.changes.retainRates = 'no';
  assert.notDeepEqual(binding(f), first);
});

test('refuses stale edits, wrong identity and changed native targets', () => {
  for (const change of [
    (f) => { f.snapshot.formDirty = true; },
    (f) => { f.snapshot.data.confirmationnumber = '87654321-1'; },
    (f) => { f.snapshot.data.guestid = '456'; },
    (f) => { f.snapshot.values.guestid = '456'; },
    (f) => { f.snapshot.values.arrivaldate = '11-OCT-2027'; },
    (f) => { f.snapshot.data.reservationstayid = '31'; },
    (f) => { f.snapshot.data.arrivaldate = '10/11/2027'; },
    (f) => { f.snapshot.data.propertycode = 'HRDAV'; },
    (f) => { f.snapshot.data.companyid = 'unexpected'; },
    (f) => { f.snapshot.data.udfchkbox04 = '1'; },
    (f) => { f.snapshot.values.udfchkbox04 = '1'; },
    (f) => { f.snapshot.values.emailaddress = 'recipient@example.invalid'; },
    (f) => { f.snapshot.data.ADULTS = '1'; },
  ]) { const f = fixture(); change(f); assert.equal(binding(f), null); }
});

test('does not infer missing child ages and requires exact child preimages', () => {
  for (const change of [
    (f) => { f.expected.childAges = null; },
    (f) => { f.snapshot.data.childages = ''; },
    (f) => { delete f.snapshot.data.childages; },
    (f) => { f.snapshot.data.childages = '9'; },
    (f) => { f.snapshot.values.childages = '9'; },
    (f) => { f.changes.childAges = null; },
    (f) => { delete f.changes.childAges; },
  ]) { const f = fixture(); change(f); assert.equal(binding(f), null); }
});

test('rejects invalid or empty changes and null dates', () => {
  for (const changes of [{}, { retainRates:'yes' }, { arrival:null }, { departure:'2027-10-11' },
    { adults:0 }, { childCount:1 }, { ratePlan:'bad rate' }, { departure:'2027-10-14', retainRates:true },
    { departure:'2027-10-14', retainRates:'maybe' }, { unexpected:true }]) {
    const f = fixture(); f.changes = changes; assert.equal(binding(f), null);
  }
});


test('preserves unknown ages when only dates or adults change, never treats them as an empty list', () => {
  const f = fixture();
  f.expected.childAges = null; f.expected.childCount = 0;
  for (const part of [f.snapshot.data, f.snapshot.values]) {
    part.children = '0'; part.child1 = '0'; part.child2 = '0'; part.child3 = '0'; part.childages = '';
  }
  f.changes = { adults:2, departure:'2027-10-14' };
  const unknown = binding(f); assert.match(unknown?.digest || '', /^[a-f0-9]{64}$/);
  f.changes = { childCount:0, childAges:[] }; assert.equal(binding(f), null);
  f.changes = { adults:2, departure:'2027-10-14' }; f.expected.childAges = [];
  assert.equal(binding(f), null);
});

test('rejects populated form ages when native model ages are unknown', () => {
  for (const childCount of [0, 1]) {
    const f = fixture();
    f.expected.childAges = null; f.expected.childCount = childCount;
    f.snapshot.data.childages = '';
    if (childCount === 0) {
      for (const part of [f.snapshot.data, f.snapshot.values]) {
        part.children = '0'; part.child1 = '0'; part.child2 = '0'; part.child3 = '0';
      }
    }
    f.changes = { adults:2, departure:'2027-10-14' };
    for (const ages of ['8', 'unknown', ' ']) {
      f.snapshot.values.childages = ages;
      assert.equal(binding(f), null);
    }
    for (const ages of ['', null]) {
      f.snapshot.values.childages = ages;
      assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
    }
    delete f.snapshot.values.childages;
    assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
  }
});

test('rejects sparse arrays even when extra properties mask missing indices', () => {
  const f = fixture();
  const sparse = Array(1); sparse.extra = 'not an element';
  f.snapshot.data.unrelated = sparse;
  assert.equal(binding(f), null);
});
