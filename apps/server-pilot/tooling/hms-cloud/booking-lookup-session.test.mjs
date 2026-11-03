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


test('booking session installs its read guard before the first page and preserves service-worker choice', async () => {
  const defaultOptions = bookingSessionPageOptions();
  const guardedOptions = bookingSessionPageOptions({ headless: false, blockServiceWorkers: true });
  assert.equal(defaultOptions.headless, true);
  assert.equal(defaultOptions.blockServiceWorkers, false);
  assert.equal(guardedOptions.headless, false);
  assert.equal(guardedOptions.blockServiceWorkers, true);
  assert.equal(typeof guardedOptions.prepareContext, 'function');
  assert.equal(guardedOptions.prepareContext, defaultOptions.prepareContext);
  assert.equal(bookingSessionPageOptions({ cloudTargetKey: 'target' }).cloudTargetKey, 'target');
  let handler;
  await guardedOptions.prepareContext({ route: async (_pattern, installed) => { handler = installed; } });
  let aborted = false;
  await handler({ request: () => ({ method: () => 'POST',
    url: () => 'https://example.test/web/base/OSRESV.HDR?pageaction=SAVE', postData: () => '' }),
  abort: async () => { aborted = true; }, fallback: async () => {} });
  assert.equal(aborted, true);
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

test('save guard authority stays in session context and wire options cannot supply it', async () => {
  const callback = async () => true;
  const context = { page: { context: () => null }, labtestPreimage: { outcome: 'clear', preimageId: 'p' },
    authorizeCandidate: callback, dispatchCandidate: callback };
  const request = { tool: 'saveNewLabtestStay', preimageId: 'p', arrival: '2027-12-29', departure: '2027-12-31',
    guestId: '123', roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'NGI', note: 'synthetic' };
  const queue = createBookingToolQueue(context);
  assert.equal((await queue.runTool(request)).issue, 'BROWSER_CONTEXT_UNSAFE');
  for (const options of [{ authorizeCandidate: 'spoofed' }, { dispatchCandidate: 'spoofed' },
    { allowRealGuest: true }, { expectedGuest: { firstName: 'Ada', lastName: 'Moyo' } }, { cloudTargetKey: 'spoofed' },
    { authorizeCandidate: 'spoofed', dispatchCandidate: 'spoofed' }]) {
    assert.equal((await queue.runTool({ ...request, options })).issue, 'SERVER_SAVE_GUARD_ONLY');
  }
  assert.equal((await queue.runTool({ ...request, options: { authorizeCandidate: callback } })).issue, 'invalid_request');
  await queue.close();
  for (const guards of [{ authorizeCandidate: callback }, { dispatchCandidate: callback },
    { authorizeCandidate: true, dispatchCandidate: callback }]) {
    assert.equal((await runBookingLookupTool({ ...context, authorizeCandidate: undefined, dispatchCandidate: undefined, ...guards }, request)).issue,
      'SAVE_GUARD_CALLBACKS_INVALID');
  }
});
