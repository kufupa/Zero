import test from 'node:test';
import assert from 'node:assert/strict';
import { stableNativeCreateFormDigest } from './guest-stay-save.mjs';

const form = {
  sessionID: { sessionID: 'session-one' }, bookingsessionid: 'booking-one',
  guestid: '123', roomtype: 'STQN', reservationnote: 'Reviewed note', revenuevalue: '0.00',
};

test('binds form fields but ignores only volatile session values and zero representation', () => {
  const first = stableNativeCreateFormDigest(form);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, stableNativeCreateFormDigest({ ...form, sessionID: 'session-two',
    bookingsessionid: 'booking-two', revenuevalue: 0 }));
  assert.notEqual(first, stableNativeCreateFormDigest({ ...form, roomtype: 'DLXKNG' }));
  assert.notEqual(first, stableNativeCreateFormDigest({ ...form, reservationnote: 'Changed note' }));
  assert.notEqual(first, stableNativeCreateFormDigest({ ...form, revenuevalue: '1.00' }));
  assert.equal(first, stableNativeCreateFormDigest(Object.fromEntries(Object.entries(form).reverse())));
});

test('refuses missing, malformed, duplicate-case sessions and unsupported field values', () => {
  for (const invalid of [
    {}, { ...form, sessionID: '' }, { ...form, sessionID: { sessionID: 'x', extra: 'y' } },
    { ...form, bookingsessionid: 'bad\nsession' }, { ...form, bookingsessionid: ' untrimmed ' },
    { ...form, Bookingsessionid: 'duplicate' }, { ...form, SessionID: 'duplicate' },
    { ...form, nested: { value: 'unexpected' } },
  ]) assert.equal(stableNativeCreateFormDigest(invalid), null);
});
