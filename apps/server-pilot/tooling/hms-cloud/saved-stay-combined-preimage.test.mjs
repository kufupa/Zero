import test from 'node:test';
import assert from 'node:assert/strict';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { labtestCombinedAmendPreimageBinding as bind } from './saved-stay-combined-preimage.mjs';
import { expectedLabtestAmendRecord } from './pane-amend-session.mjs';

function fixture() {
  const expected = { confirmation:'12345678-1', guestId:'123', arrival:'2027-10-12', departure:'2027-10-13',
    roomType:'STQN', ratePlan:'BAR', note:'', adults:1, childCount:1, childAges:[8] };
  const native = { PKID:'10', bookingsessionid:'100', reservationid:'20', reservationstayid:'30', recordid:'40' };
  const parties = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
  const data = { ...parties, ...native, propertycode:'HRCEN', status:'Reserved', firstname:'Proof', lastname:'Labtest',
    confirmationnumber:expected.confirmation, guestid:expected.guestId, arrivaldate:'10/12/2027', departuredate:'10/13/2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', adults:'1', children:'1', child1:'0', child2:'1', child3:'0',
    childages:'8', child1label:'Child 0-02', child2label:'Child 03-12', child3label:'Child 13-17',
    child1status:'ACTIVE', child2status:'ACTIVE', child3status:'ACTIVE',
    guaranteetype:'NGI', udfchkbox04:'0', udfchar13:'', emailaddress:'',
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

test('binds business preimage and changes, not unrelated native fields or session identifiers', () => {
  const f = fixture(), first = binding(f);
  assert.match(first?.digest || '', /^[a-f0-9]{64}$/);
  f.state.native.bookingsessionid = f.snapshot.data.bookingsessionid = 'different';
  f.snapshot.data.sessionID = { sessionID:'different' }; f.snapshot.data.extId = 'different';
  assert.deepEqual(binding(f), first);
  f.snapshot.data.unrelated = 'changed';
  assert.deepEqual(binding(f), first);
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


test('preserves unknown ages and accepts an explicit requested child edit for native verification', () => {
  const f = fixture();
  f.expected.childAges = null; f.expected.childCount = 0;
  for (const part of [f.snapshot.data, f.snapshot.values]) {
    part.children = '0'; part.child1 = '0'; part.child2 = '0'; part.child3 = '0'; part.childages = '';
  }
  f.changes = { adults:2, departure:'2027-10-14' };
  const unknown = binding(f); assert.match(unknown?.digest || '', /^[a-f0-9]{64}$/);
  f.changes = { childCount:1, childAges:[8] }; assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
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

test('ignores malformed unrelated native fields outside the business preimage', () => {
  const f = fixture();
  const sparse = Array(1); sparse.extra = 'not an element';
  f.snapshot.data.unrelated = sparse;
  assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
});

test('binds real expected identity and native guarantee in the complete saved baseline', () => {
  const f = fixture();
  Object.assign(f.expected, { firstName:'Alice', lastName:'Example', note:'x'.repeat(300) });
  Object.assign(f.state, { allowRealGuest:true, expectedFirstName:'Alice', expectedLastName:'Example',
    expectedGuarantee:{ code:'CC', display:'Credit Card' } });
  for (const part of [f.snapshot.data, f.snapshot.values]) {
    Object.assign(part, { firstname:'Alice', lastname:'Example', guaranteetype:'CC', reservationnote:f.expected.note });
  }
  const native = { source:'record_view_ext_model', propertyCode:'HRCEN', confirmation:f.expected.confirmation,
    guestId:f.expected.guestId, reservationStayId:'30', reservationId:'20', recordId:'40', status:'Reserved',
    firstName:'Alice', lastName:'Example', arrival:f.expected.arrival, departure:f.expected.departure,
    roomType:f.expected.roomType, ratePlan:f.expected.ratePlan, adults:1, children:1, childAges:[8], guaranteeCode:'CC' };
  const record = { nativePreimage:native, details:{ fields:[{ name:'reservationnote', rawValue:f.expected.note }] } };
  assert.equal(expectedLabtestAmendRecord(record, native, { allowRealGuest:true })?.note, f.expected.note);
  assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
  f.snapshot.data.lastname = 'Other'; assert.equal(binding(f), null);
  f.snapshot.data.lastname = 'Example'; f.snapshot.values.guaranteetype = 'NGI'; assert.equal(binding(f), null);
  f.snapshot.values.guaranteetype = 'CC'; f.expected.firstName = 'Other'; assert.equal(binding(f), null);
  f.expected.firstName = 'Alice'; f.expected.arrival = '2020-01-01'; assert.equal(binding(f), null);
});

test('binds preserved unsent recipient and verified model-only primary party', () => {
  const f = fixture();
  f.state.cmsRecipient = 'desk@example.invalid'; f.state.allowModelOnlyPrimaryPartyIds = true;
  f.state.partyPreimage.taid1 = '42'; f.state.partyPreimage.ta1 = 'Agency';
  f.snapshot.data.taid1 = '42'; f.snapshot.data.ta1 = 'Agency';
  f.snapshot.values.ta1 = 'Agency'; f.snapshot.partyControls.push({ name:'ta1', value:'Agency' });
  f.snapshot.data.udfchar13 = f.snapshot.values.udfchar13 = f.state.cmsRecipient;
  assert.match(binding(f)?.digest || '', /^[a-f0-9]{64}$/);
  f.snapshot.partyControls[0].value = 'Different'; assert.equal(binding(f), null);
  f.snapshot.partyControls[0].value = 'Agency'; f.snapshot.values.udfchar13 = 'changed'; assert.equal(binding(f), null);
});
