import test from 'node:test';
import assert from 'node:assert/strict';
import { isOneNightRetainAmend, oneNightRetainPrices, oneNightRetainAvailabilityMatches,
  oneNightRetainPricesMatchObservations, oneNightRetainReadbackMatches } from './labtest-amend-retain-proof.mjs';

const required = ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax', 'guesttotal', 'tax', 'guesttax'];
const selected = { arrival:'2027-05-02', departure:'2027-05-03', adults:1, ratePlan:'BAR' };
const changes = { adults:2, ratePlan:'BAR', retainRates:'yes' };
const response = { pageData:{ success:true, messages:[] } };
function snapshot() {
  const data = {}, values = {};
  for (const key of required) {
    data[key] = '1234.50'; values[key] = '1,234.50';
    data[`${key}curr`] = values[`${key}curr`] = 'ZAR';
  }
  data.ratetax = '12.00'; data.ratetaxcurr = 'ZAR';
  data.resortfee = values.resortfee = '';
  return { data, values };
}

test('only a one-night adult edit or one-night date shift can use the narrow retain=yes proof', () => {
  assert.equal(isOneNightRetainAmend(selected, changes), true);
  assert.equal(isOneNightRetainAmend(selected,
    { arrival:'2027-05-03', departure:'2027-05-04', ratePlan:'BAR', retainRates:'yes' }), true);
  for (const [stay, update] of [
    [{ ...selected, departure:'2027-05-04' }, changes],
    [{ ...selected, arrival:'2027-02-30' }, changes],
    [selected, { ...changes, retainRates:'no' }],
    [selected, { ...changes, ratePlan:'CORP' }],
    [selected, { ...changes, adults:1 }],
    [selected, { ...changes, departure:'2027-05-04' }],
    [selected, { ...changes, children:0 }],
  ]) assert.equal(isOneNightRetainAmend(stay, update), false);
});

test('projects matching visible/model amounts and explicit currencies without floating point', () => {
  const result = oneNightRetainPrices(snapshot());
  assert.equal(result.currency, 'ZAR');
  assert.equal(result.fields.averagenightly.data.cents, '123450');
  assert.deepEqual(result.fields.ratetax.visible, { state:'missing' });
  assert.deepEqual(result.fields.resortfee.data, { state:'blank' });
});

test('the earlier lookup and native preparation must agree on amounts and currency', () => {
  const approved = oneNightRetainPrices(snapshot());
  const money = () => ({ amount:{ state:'observed', value:'R 1,234.50' }, currency:{ state:'observed', value:'ZAR' } });
  const financial = { averageRate:money(), grandTotal:money(), totalRate:money() };
  assert.equal(oneNightRetainPricesMatchObservations(approved, financial), true);
  for (const edit of [
    (f) => { f.averageRate.amount.value = '1,234.51'; },
    (f) => { f.grandTotal.currency.value = 'USD'; },
    (f) => { f.totalRate.amount.state = 'unknown'; },
    (f) => { f.totalRate.amount.value = 'R 12,34.50'; },
  ]) { const changed = structuredClone(financial); edit(changed); assert.equal(oneNightRetainPricesMatchObservations(approved, changed), false); }
});

test('refuses missing, ambiguous or inconsistent price and currency evidence', () => {
  for (const edit of [
    (s) => { delete s.values.averagenightly; },
    (s) => { s.data.AverageNightly = s.data.averagenightly; },
    (s) => { s.values.grandtotal = '12,34.50'; },
    (s) => { s.data.totalrate = '-1.00'; },
    (s) => { s.values.tax = '1234.51'; },
    (s) => { s.values.guesttotalcurr = 'USD'; },
    (s) => { delete s.values.guesttaxcurr; },
    (s) => { s.data.totalratewithtax = ''; },
    (s) => { s.data.ratetax = 'NaN'; },
  ]) { const value = snapshot(); edit(value); assert.equal(oneNightRetainPrices(value), null); }
});

test('availability requires a clean response and every approved price unchanged', () => {
  const before = snapshot();
  assert.equal(oneNightRetainAvailabilityMatches(response, before, structuredClone(before), selected, changes), true);
  for (const [result, edit] of [
    [{ pageData:{ success:false } }, () => {}],
    [{ pageData:{ success:true, messages:[{ type:'warning' }] } }, () => {}],
    [response, (s) => { s.data.totalrate = s.values.totalrate = '1250.00'; }],
    [response, (s) => { s.data.ratetax = '13.00'; }],
    [response, (s) => { s.data.resortfee = null; }],
    [response, (s) => { s.values.grandtotalcurr = 'USD'; }],
  ]) {
    const after = structuredClone(before); edit(after);
    assert.equal(oneNightRetainAvailabilityMatches(result, before, after, selected, changes), false);
  }
});

test('fresh readback must match the stored price projection and the same approved choice', () => {
  const before = snapshot(), approved = oneNightRetainPrices(before);
  assert.equal(oneNightRetainReadbackMatches(approved, structuredClone(before), selected, changes), true);
  const after = snapshot(); after.data.guesttotal = after.values.guesttotal = '900.00';
  assert.equal(oneNightRetainReadbackMatches(approved, after, selected, changes), false);
  assert.equal(oneNightRetainReadbackMatches(approved, before, selected, { ...changes, retainRates:'no' }), false);
  assert.equal(oneNightRetainReadbackMatches({ ...approved, currency:'USD' }, before, selected, changes), false);
});
