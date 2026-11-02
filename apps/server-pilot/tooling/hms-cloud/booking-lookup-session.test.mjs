import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSessionPageOptions, createBookingToolQueue, runBookingLookupTool, runPartyTool } from './booking-lookup-session.mjs';

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


test('real session queue clones requests while keeping screenshot callback in session context', async () => {
  const arSelection = { outcome: 'selected_unsaved', searchId: 's', nativeId: '75', displayedArAccount: 'Account',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'araccountname', value: 'Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Account' } };
  const request = { tool: 'saveNewLabtestStay', preimageId: 'p', arrival: '2027-12-29', departure: '2027-12-31',
    guestId: '123', roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'NGI', note: 'synthetic', arSelection,
    billingReference: ' PO ', options: { beforeSaveScreenshot: 'not-a-function' } };
  const queue = createBookingToolQueue({ page: { context: () => null }, labtestPreimage: { outcome: 'clear', preimageId: 'p' },
    beforeSaveScreenshot: () => {} });
  // Getting as far as the writer's context gate demonstrates that the cloned,
  // serializable request was dispatched and the in-process callback replaced
  // the invalid wire option. No browser or save is attempted.
  assert.equal((await queue.runTool(request)).issue, 'BROWSER_CONTEXT_UNSAFE');
  assert.equal((await queue.runTool({ ...request, options: { beforeSaveScreenshot: () => {} } })).issue, 'invalid_request');
  await queue.close();
  assert.equal((await queue.runTool(request)).issue, 'SESSION_CLOSED');
});
