import test from 'node:test';
import assert from 'node:assert/strict';
import { readLabtestCreate, reconcileLabtestCreate } from './labtest-create-readback.mjs';

const stay = { arrival: '2027-03-15', departure: '2027-03-17' };
const expected = { ...stay, adults: 2, children: 2, childBands: { child1: 0, child2: 2, child3: 0 },
  roomType: 'DLXKNG', ratePlan: 'BAR', note: 'Ref Ab3F9', guestId: '123', guarantee: 'Non-Guaranteed Individual' };
const fields = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value, ...(name === 'reservationnote' ? { rawValue: value } : {}) }));
const values = { arrivaldate: '15-MAR-2027', departuredate: '17-MAR-2027', adults: '2', children: '2',
  child1: '0', child2: '2', child3: '0', roomtype: 'DLXKNG', rateplan: 'BAR', reservationnote: 'Ref Ab3F9',
  guestid: '123', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', guaranteetype: 'Non-Guaranteed Individual',
  udfchkbox04: false, udfchar13: '', emailaddress: '' };

test('fresh readback compares identity, status, stay and exact note', async () => {
  let request;
  const withSavedSession = async (operation) => operation({ runTool: async (input) => {
    request = input;
    return { outcome: 'ok', record: { details: { fields: fields(values), captureScope: 'record' } } };
  } });
  const result = await readLabtestCreate({ confirmation: '123-1', stay, expected }, { withSavedSession });
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(request, { tool: 'read', confirmation: '123-1', guestName: 'Proof Labtest', arrivalDate: stay.arrival });
  const changed = async (operation) => operation({ runTool: async () => ({ outcome: 'ok', record: { details: {
    fields: fields({ ...values, guestid: '999', status: 'Cancelled', reservationnote: 'Ref ab3f9', rateplan: 'bar' }),
  } } }) });
  const mismatch = await readLabtestCreate({ confirmation: '123-1', stay, expected }, { withSavedSession: changed });
  assert.deepEqual(mismatch.mismatches.map(({ field }) => field), ['ratePlan', 'note', 'guestId', 'status']);
  const invalid = await readLabtestCreate({ confirmation: '123-1', stay, expected: { ...expected, guestId: undefined } }, {
    withSavedSession: async () => { throw new Error('must not read without expected identity'); },
  });
  assert.equal(invalid.issue, 'expected_record_invalid');
  const whitespace = async (operation) => operation({ runTool: async () => ({ outcome: 'ok', record: { details: {
    fields: fields(values).map((field) => field.name === 'reservationnote' ? { ...field, rawValue: ` ${field.value} ` } : field),
  } } }) });
  const raw = await readLabtestCreate({ confirmation: '123-1', stay, expected }, { withSavedSession: whitespace });
  assert.deepEqual(raw.mismatches.map(({ field }) => field), ['note']);
});

test('reconciliation reads complete census candidates and preserves incomplete evidence', async () => {
  let reads = 0;
  const withSavedSession = async (operation) => operation({ runTool: async () => {
    reads += 1;
    return { outcome: 'ok', record: { details: { fields: fields(values) } } };
  } });
  const census = async () => ({ outcome: 'existing_matches', coverage: { complete: true }, sameArrival: [{ confirmation: '123-1' }] });
  const result = await reconcileLabtestCreate({ stay, expected }, { census, withSavedSession });
  assert.equal(reads, 1);
  assert.equal(result.candidates[0].confirmation, '123-1');
  assert.deepEqual(result.candidates[0].readback.mismatches, []);
  const incomplete = await reconcileLabtestCreate({ stay, expected }, {
    census: async () => ({ outcome: 'incomplete', sameArrival: [{ confirmation: '123-1' }] }), withSavedSession,
  });
  assert.equal(reads, 1);
  assert.deepEqual(incomplete.candidates, []);
  assert.equal(incomplete.census.outcome, 'incomplete');
});

test('reconciliation exposes mismatched and unreadable candidates without retrying a save', async () => {
  const requests = [];
  let censuses = 0;
  const census = async () => {
    censuses += 1;
    return { outcome: 'existing_matches', coverage: { complete: true }, sameArrival: [
      { confirmation: '123-1' }, { confirmation: '124-1' }, { confirmation: '125-1' },
    ] };
  };
  const withSavedSession = async (operation) => operation({ runTool: async (request) => {
    requests.push(request);
    if (request.confirmation === '125-1') throw new Error('READ_UNAVAILABLE');
    const record = request.confirmation === '124-1' ? { ...values, guestid: '999', rateplan: 'OTHER' } : values;
    return { outcome: 'ok', record: { details: { fields: fields(record) } } };
  } });
  const result = await reconcileLabtestCreate({ stay, expected }, { census, withSavedSession });
  assert.equal(censuses, 1);
  assert.deepEqual(result.candidates[0].readback.mismatches, []);
  assert.deepEqual(result.candidates[1].readback.mismatches.map(({ field }) => field), ['ratePlan', 'guestId']);
  assert.deepEqual(result.candidates[2], { confirmation: '125-1', issue: 'readback_unverified' });
  assert.deepEqual(requests.map(({ tool }) => tool), ['read', 'read', 'read']);
});

test('a failed reconciliation census never reads candidates', async () => {
  let reads = 0;
  const result = await reconcileLabtestCreate({ stay, expected }, {
    census: async () => { throw new Error('CENSUS_UNAVAILABLE'); },
    withSavedSession: async () => { reads += 1; },
  });
  assert.deepEqual(result, { census: { outcome: 'incomplete', issue: 'census_unverified' }, candidates: [] });
  assert.equal(reads, 0);
});
