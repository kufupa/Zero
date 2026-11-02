import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSessionPageOptions, runBookingLookupTool, runPartyTool } from './booking-lookup-session.mjs';

test('session and legacy alias require the current clear Labtest preimage', async () => {
  for (const runTool of [runBookingLookupTool, runPartyTool]) {
    for (const labtestPreimage of [undefined, { outcome: 'existing_matches', preimageId: 'p' },
      { outcome: 'clear', preimageId: 'other' }]) {
      const result = await runTool({ page: {}, labtestPreimage }, {
        id: 'test', tool: 'saveNewLabtestStay', preimageId: 'p',
        approval: { by: 'Owner', at: '2026-11-01T12:00:00Z' },
      });
      assert.deepEqual(result, { id: 'test', tool: 'saveNewLabtestStay', outcome: 'input_gap',
        issue: 'CURRENT_LABTEST_PREIMAGE_REQUIRED' });
    }
  }
});


test('booking session forwards explicit service-worker blocking without changing defaults', () => {
  assert.deepEqual(bookingSessionPageOptions(), { headless: true, blockServiceWorkers: false });
  assert.deepEqual(bookingSessionPageOptions({ headless: false, blockServiceWorkers: true }),
    { headless: false, blockServiceWorkers: true });
  for (const invalid of [null, 'block', 1]) assert.throws(
    () => bookingSessionPageOptions({ blockServiceWorkers: invalid }), /SERVICE_WORKER_OPTION_INVALID/);
});
