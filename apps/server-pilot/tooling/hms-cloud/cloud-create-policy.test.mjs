import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudTargetKey, hrcenToday, validCreateDates } from './cloud-create-policy.mjs';

test('real Create uses the Johannesburg calendar day and recovery can read past stays', () => {
  assert.equal(hrcenToday(new Date('2026-11-03T21:59:59Z')), '2026-11-03');
  assert.equal(hrcenToday(new Date('2026-11-03T22:00:00Z')), '2026-11-04');
  const today = hrcenToday(), midnight = Date.parse(`${today}T00:00:00Z`);
  const day = (offset) => new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10);
  assert.equal(validCreateDates(today, day(1), true), true);
  assert.equal(validCreateDates(day(-1), today, true), false);
  assert.equal(validCreateDates(day(-1), today, true, true), true);
  assert.equal(validCreateDates(today, today, true), false);
});

test('Create target keys normalize the approved name and include the arrival', () => {
  assert.equal(createCloudTargetKey({ firstName: 'Ａda', lastName: 'Moyo  Smith' }, '2027-08-01'),
    createCloudTargetKey({ firstName: 'ada', lastName: 'moyo smith' }, '2027-08-01'));
  assert.notEqual(createCloudTargetKey({ firstName: 'Ada', lastName: 'Moyo' }, '2027-08-01'),
    createCloudTargetKey({ firstName: 'Ada', lastName: 'Moyo' }, '2027-08-02'));
});
