import test from 'node:test';
import assert from 'node:assert/strict';
import { installAvailabilityReadOnlyGuard, isAvailabilityReadRequest, shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';

const origin = 'https://hms.example.test';
const oldPath = '/api/internalBooking/hotelAvail/inquiryForGrid';
const cloudPath = '/api/internalBooking/rateshop/inquiryForGrid';

test('read-only guard blocks the observed Cloud save action in query or form body', () => {
  const url = `${origin}/web/base/OSRESV.HDR`;
  for (const request of [
    { url: `${url}?pageaction=SAVE` },
    { url: `${url}?pageaction=LIST&PageAction=%53AVE` },
    { url, postData: 'SYSTEM_FUNCTION_NAME=OSRESV&pageaction=SAVE' },
  ]) assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', ...request }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'GET', url: `${url}?pageaction=SAVE` }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: `${url}?pageaction=LIST` }), false);
});

test('availability inquiry recognition requires POST, the exact path, and the same origin', () => {
  for (const path of [oldPath, cloudPath]) {
    assert.equal(isAvailabilityReadRequest({ method: 'POST', url: `${origin}${path}` }, origin), true);
    assert.equal(isAvailabilityReadRequest({ method: 'post', url: `${origin}${path}?page=2` }, origin), true);
    for (const url of [
      `https://other.example.test${path}`,
      `https://hms.example.test.evil.invalid${path}`,
      `https://hms.example.test:8443${path}`,
      `http://hms.example.test${path}`,
      `${origin}${path}/save`,
      `${origin}${path}Extra`,
      `${origin}${path.toLowerCase()}`,
      `${origin}${path}%2Fsave`,
      'not-a-url',
    ]) assert.equal(isAvailabilityReadRequest({ method: 'POST', url }, origin), false, url);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'TRACE', ''])
      assert.equal(isAvailabilityReadRequest({ method, url: `${origin}${path}` }, origin), false, method);
  }
});

test('installed availability guard allows only the two same-origin inquiry POSTs', async () => {
  let handler;
  await installAvailabilityReadOnlyGuard({ route: async (pattern, fn) => {
    assert.equal(pattern, '**/*');
    handler = fn;
  } }, `${origin}/login`);
  const action = async (method, url) => {
    let result;
    await handler({
      request: () => ({ method: () => method, url: () => url }),
      abort: async () => { result = 'abort'; },
      continue: async () => { result = 'continue'; },
    });
    return result;
  };
  for (const path of [oldPath, cloudPath]) {
    assert.equal(await action('POST', `${origin}${path}`), 'continue');
    assert.equal(await action('POST', `https://other.example.test${path}`), 'abort');
    assert.equal(await action('POST', `${origin}${path}/save`), 'abort');
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      assert.equal(await action(method, `${origin}${path}`), 'abort');
  }
  for (const path of ['/api/reservation/create', '/api/reservation/save', '/api/reservation/cancel', '/api/unknown'])
    assert.equal(await action('POST', `${origin}${path}`), 'abort');
  assert.equal(await action('POST', 'invalid'), 'abort');
  assert.equal(await action('TRACE', `${origin}${oldPath}`), 'abort');
  for (const method of ['GET', 'HEAD', 'OPTIONS'])
    assert.equal(await action(method, 'https://other.example.test/read'), 'continue');
});

test('availability guard rejects invalid or credential-bearing origins before installing a route', async () => {
  for (const invalid of ['not-a-url', 'file:///tmp/hms', 'https://user:password@hms.example.test']) {
    let installed = false;
    await assert.rejects(installAvailabilityReadOnlyGuard({ route: async () => { installed = true; } }, invalid),
      /hms_availability_read_origin_invalid/);
    assert.equal(installed, false);
  }
});
