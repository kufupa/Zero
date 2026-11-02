import test from 'node:test';
import assert from 'node:assert/strict';
import { stableNativeCreateFormDigest } from './guest-stay-save.mjs';
import { stableNativeCreateBodyDigest } from './native-create-body-digest.mjs';

const form = {
  sessionID: { sessionID: 'native-session' }, bookingsessionid: 'booking-session',
  guestid: '123', roomtype: 'STQN', guaranteetype: 'NGI', reservationnote: 'Reviewed note', revenuevalue: '0.00',
};
const controls = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR' };
function bodyFor(values) {
  return new URLSearchParams([
    ...Object.entries(values).map(([key, value]) => [key, String(key === 'sessionID' && typeof value === 'object'
      ? value.sessionID : value ?? '')]),
    ...Object.entries(controls),
  ]);
}

test('matches actual request controls and all fields before deriving the form digest', () => {
  const body = bodyFor(form);
  const digest = stableNativeCreateBodyDigest(body, form);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, stableNativeCreateFormDigest(form));
  body.set('revenuevalue', '000.000');
  assert.equal(stableNativeCreateBodyDigest(body, form), digest);
});

test('permits changed sessions only when request and form agree, and binds other fields', () => {
  const original = stableNativeCreateBodyDigest(bodyFor(form), form);
  const next = { ...form, sessionID: 'next-native', bookingsessionid: 'next-booking' };
  assert.equal(stableNativeCreateBodyDigest(bodyFor(next), next), original);
  for (const key of ['roomtype', 'guaranteetype', 'reservationnote']) {
    const changed = { ...form, [key]: 'different' };
    assert.notEqual(stableNativeCreateBodyDigest(bodyFor(changed), changed), original);
  }
  assert.equal(stableNativeCreateBodyDigest(bodyFor(form), next), null);
});

test('refuses changed, missing, duplicate, or extra body fields and controls', () => {
  const changes = [
    (body) => body.set('roomtype', 'DIFFERENT'),
    (body) => body.set('sessionID', 'different-session'),
    (body) => body.set('revenuevalue', '1'),
    (body) => body.set('SYSTEM_FUNCTION_NAME', 'OTHER'),
    (body) => body.set('USER_FUNCTION_NAME', 'OTHER'),
    (body) => body.set('CURRENT_TAB_NAME', 'OTHER'),
    (body) => body.delete('CURRENT_TAB_NAME'),
    (body) => body.append('CURRENT_TAB_NAME', 'HDR'),
    (body) => body.append('roomtype', 'STQN'),
    (body) => body.append('unreviewed', 'value'),
  ];
  for (const change of changes) {
    const body = bodyFor(form);
    change(body);
    assert.equal(stableNativeCreateBodyDigest(body, form), null);
  }
});

test('fails closed on malformed sessions, unsupported values and non-body input', () => {
  assert.equal(stableNativeCreateBodyDigest(null, form), null);
  for (const invalid of [
    { ...form, sessionID: '' },
    { ...form, bookingsessionid: 'bad\nsession' },
    { ...form, SessionID: 'duplicate-case' },
    { ...form, nested: { value: 'unsupported' } },
    { ...form, CURRENT_TAB_NAME: 'HDR' },
  ]) assert.equal(stableNativeCreateBodyDigest(bodyFor(invalid), invalid), null);
});
