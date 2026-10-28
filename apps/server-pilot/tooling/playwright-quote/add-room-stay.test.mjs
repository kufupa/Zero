import test from 'node:test';
import assert from 'node:assert/strict';
import { addRoomFormWant, formMismatches, newConfirmations, parentRefusal, parseParent } from './add-room-stay.mjs';

const stay = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-12-20',
  departure: '2027-12-21',
  adults: 2,
  childAges: [5],
  roomType: 'STKNG',
  ratePlan: 'ngdtsb',
};

test('parent must be a confirmation number', () => {
  assert.deepEqual(parseParent(['--parent', '73165771-1']), { ok: true, parent: '73165771-1' });
  assert.equal(parseParent(['--parent', 'Labtest']).ok, false);
  assert.equal(parseParent([]).ok, false);
});

test('a child of 5 is one Child 03-12 on the Add Record form', () => {
  const form = addRoomFormWant(stay);
  assert.equal(form.ok, true);
  assert.deepEqual(form.want, {
    quantity: '1',
    arrivaldate: '20-DEC-2027',
    departuredate: '21-DEC-2027',
    adults: '2',
    child1: '0',
    child2: '1',
    children: '1',
    roomtype: 'STKNG',
    rateplan: 'NGDTSB',
    lastname: 'Labtest',
    firstname: 'Proof',
  });
});

test('a teenager refuses: the Add Record form has no 13-17 band', () => {
  assert.deepEqual(addRoomFormWant({ ...stay, childAges: [14] }), { ok: false, reason: 'refused_child_band_unsupported' });
});

test('a Children total HMS did not update is a mismatch', () => {
  const { want } = addRoomFormWant(stay);
  const shown = { ...want, children: '0' };
  assert.deepEqual(formMismatches(want, shown), [{ field: 'children', expected: '1', actual: '0' }]);
  assert.deepEqual(formMismatches(want, { ...want, rateplan: 'ngdtsb' }), []);
});

test('the parent must be the same guest and dates, and still booked', () => {
  const parent = { lastname: 'Labtest', arrivaldate: '20-DEC-2027', departuredate: '21-DEC-2027', status: 'Reserved' };
  assert.equal(parentRefusal(parent, stay), null);
  assert.equal(parentRefusal({ ...parent, lastname: 'Smith' }, stay), 'refused_parent_guest');
  assert.equal(parentRefusal({ ...parent, departuredate: '22-DEC-2027' }, stay), 'refused_parent_dates');
  assert.equal(parentRefusal({ ...parent, status: 'Cancelled' }, stay), 'refused_parent_status');
});

test('only confirmations new after Submit count as the added room', () => {
  assert.deepEqual(newConfirmations(['73165771-1'], ['73165771-1', '39863956-1']), ['39863956-1']);
  assert.deepEqual(newConfirmations(['73165771-1'], ['73165771-1']), []);
});
