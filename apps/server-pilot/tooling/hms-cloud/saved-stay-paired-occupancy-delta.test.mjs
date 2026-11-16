import test from 'node:test';
import assert from 'node:assert/strict';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { labtestCombinedAmendPreimageBinding } from './saved-stay-combined-preimage.mjs';
import { planSavedChildOccupancy, savedChildOccupancy } from './guest-stay-amend-children.mjs';
import { classifyPairedOccupancyDelta as classify } from './saved-stay-paired-occupancy-delta.mjs';

function fixture() {
  const expected = { confirmation:'12345678-1', guestId:'123', arrival:'2027-10-12', departure:'2027-10-13',
    roomType:'STQN', ratePlan:'BAR', note:'', adults:1, childCount:1, childAges:[8] };
  const nativeIdentity = { PKID:'10', bookingsessionid:'100', reservationid:'20', reservationstayid:'30', recordid:'40' };
  const parties = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
  const data = { ...parties, ...nativeIdentity, propertycode:'HRCEN', status:'Reserved', firstname:'Proof', lastname:'Labtest',
    confirmationnumber:expected.confirmation, guestid:expected.guestId, arrivaldate:'10/12/2027', departuredate:'10/13/2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', adults:'1', children:'1', child1:'0', child2:'1', child3:'0',
    childages:'8', successmessages:'', activechildcategories:'', updatechildcategories:'', enablecheckavailability:'0',
    guaranteetype:'NGI', udfchkbox04:'0', udfchar13:'', emailaddress:'' };
  const values = { confirmationnumber:expected.confirmation, guestid:expected.guestId, status:'Reserved',
    firstname:'Proof', lastname:'Labtest', arrivaldate:'12-OCT-2027', departuredate:'13-OCT-2027', roomtype:'STQN',
    rateplan:'BAR', reservationnote:'', guaranteetype:'NGI', udfchar13:'', emailaddress:'', adults:'1',
    children:'1', child1:'0', child2:'1', child3:'0', childages:'8', nights:'1', departuredayofweek:'Wed' };
  const baseline = { data, values, partyControls:[], partyInputsBlank:true,
    formDirty:false, recordDirty:false, dirtyFields:[], modifiedFields:[] };
  const state = { frame:{}, native:nativeIdentity, partyPreimage:parties };
  const changes = { adults:2, childCount:2, childAges:[8, 5], departure:'2027-10-14', retainRates:'yes' };
  const binding = labtestCombinedAmendPreimageBinding(expected, state, baseline, changes);
  const native = { propertyCode:'HRCEN', reservationStayId:'30', childAges:[8], activeChildCategories:3,
    updateChildCategories:false, confirmChildCategory:false };
  const opened = structuredClone(baseline);
  opened.data.successmessages = true; opened.data.activechildcategories = 3; opened.recordDirty = true;
  const childDraft = structuredClone(opened);
  childDraft.data.childages = '8,5'; childDraft.data.updatechildcategories = true;
  childDraft.data.enablecheckavailability = '-1'; childDraft.values.children = '2'; childDraft.values.child2 = '2';
  childDraft.formDirty = true; childDraft.dirtyFields = ['children', 'child2'];
  childDraft.modifiedFields = ['childages', 'updatechildcategories', 'enablecheckavailability'];
  const childEvidence = { outcome:'applied_to_unsaved_draft', nativeValidationVerified:true, nativeResponseAges:[8, 5],
    saved:savedChildOccupancy(baseline), draftOccupancy:savedChildOccupancy(childDraft).fields,
    requested:planSavedChildOccupancy({ childCount:2, childAges:[8, 5] }),
    draftVisible:Object.fromEntries(Object.entries({ children:2, child1:0, child2:2, child3:0 })
      .map(([name, value]) => [name, { visible:String(value), component:value }])) };
  const adultDraft = structuredClone(childDraft);
  adultDraft.data.adults = '2'; adultDraft.values.adults = '2';
  adultDraft.dirtyFields.push('adults'); adultDraft.modifiedFields.push('adults');
  return { expected, state, baseline, binding, changes, native, opened, childDraft, childEvidence, adultDraft };
}

test('classifies an exact synthetic child-then-adult transition without staging or save authority', () => {
  const f = fixture(); assert.ok(f.binding);
  assert.deepEqual(classify(f), { outcome:'offline_match', canStage:false, saveEligible:false, saveDispatched:false });
});

test('rejects stale identity, child ages, native metadata, and unbound changes', () => {
  for (const mutate of [
    (f) => { f.baseline.data.guestid = '999'; },
    (f) => { f.baseline.formDirty = true; },
    (f) => { f.expected.childAges = null; },
    (f) => { f.native.childAges = [9]; },
    (f) => { f.native.reservationStayId = '31'; },
    (f) => { f.native.activeChildCategories = 2; },
    (f) => { f.changes.adults = 3; },
    (f) => { f.binding = { ...f.binding, digest:'wrong' }; },
    (f) => { f.opened.values.adults = '5'; },
    (f) => { f.childDraft.data.childages = '8,6'; },
    (f) => { f.childEvidence.nativeValidationVerified = false; },
    (f) => { f.childEvidence.nativeResponseAges = [5, 8]; },
    (f) => { f.childEvidence.draftVisible.child2.component = 1; },
    (f) => { f.childEvidence.outcome = 'apply_uncertain'; },
  ]) { const f = fixture(); mutate(f); assert.equal(classify(f).outcome, 'offline_mismatch'); }
});

test('rejects erased dirty fields, additional mutations, duplicate fields and changed party controls', () => {
  for (const mutate of [
    (f) => { f.adultDraft.dirtyFields = ['adults']; },
    (f) => { f.adultDraft.modifiedFields = ['adults']; },
    (f) => { f.adultDraft.dirtyFields.push('adults'); },
    (f) => { f.adultDraft.data.childages = '8,6'; },
    (f) => { f.adultDraft.data.unrelated = 'changed'; },
    (f) => { f.adultDraft.partyInputsBlank = false; },
    (f) => { f.adultDraft.partyControls.push({ name:'company', value:'other' }); },
    (f) => { f.adultDraft.values.adults = '3'; },
    (f) => { f.adultDraft.recordDirty = false; },
  ]) { const f = fixture(); mutate(f); assert.equal(classify(f).outcome, 'offline_mismatch'); }
});


test('rejects missing child dirt before and after the adult transition', () => {
  for (const mutate of [
    (f) => { f.childDraft.dirtyFields = []; f.adultDraft.dirtyFields = ['adults']; },
    (f) => { f.childDraft.modifiedFields = []; f.adultDraft.modifiedFields = ['adults']; },
    ...['children', 'child2'].map((name) => (f) => {
      f.childDraft.dirtyFields = f.childDraft.dirtyFields.filter((field) => field !== name);
      f.adultDraft.dirtyFields = f.adultDraft.dirtyFields.filter((field) => field !== name);
    }),
    ...['childages', 'updatechildcategories', 'enablecheckavailability'].map((name) => (f) => {
      f.childDraft.modifiedFields = f.childDraft.modifiedFields.filter((field) => field !== name);
      f.adultDraft.modifiedFields = f.adultDraft.modifiedFields.filter((field) => field !== name);
    }),
  ]) { const f = fixture(); mutate(f); assert.equal(classify(f).outcome, 'offline_mismatch'); }
});

test('rejects missing or stale saved and draft child occupancy evidence', () => {
  for (const mutate of [
    (f) => { delete f.childEvidence.saved; },
    (f) => { f.childEvidence.saved.ages = [9]; },
    (f) => { f.childEvidence.saved.fields.childages.model.value = '9'; },
    (f) => { delete f.childEvidence.draftOccupancy; },
    (f) => { f.childEvidence.draftOccupancy.children.form.value = '1'; },
    (f) => { f.childEvidence.draftOccupancy.childages.model.value = '8,6'; },
  ]) { const f = fixture(); mutate(f); assert.equal(classify(f).outcome, 'offline_mismatch'); }
});
