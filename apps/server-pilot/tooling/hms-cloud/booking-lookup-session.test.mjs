import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { bookingSessionPageOptions, createBookingToolQueue, runBookingLookupTool, runPartyTool } from './booking-lookup-session.mjs';
import { acquireCloudCredentialLease, cloudCredentialLeaseKey, switchCloudProperty, verifyCloudProperty,
  withCloudReadSession } from './cloud-session.mjs';
import { createCloudLookupReadTools } from './hms-lookup-read-session.mjs';
import { matchesGuestProfileReadRequest } from './guest-profile.mjs';
import { getPropertyRegistration, validateHmsPropertySecret } from './property-registry.mjs';
import { searchGuestInCloud } from './pane-guest-search.mjs';

test('Cloud lookup exposes only property-scoped read operations', async () => {
  const runTool = createCloudLookupReadTools({}, 'HRDAVS');
  assert.deepEqual(await runTool({ tool: 'searchGuestProfiles', propertyCode: 'HRDAV' }),
    { id: undefined, tool: 'searchGuestProfiles', outcome: 'input_gap', issue: 'PROPERTY_MISMATCH' });
  for (const tool of ['selectGuestProfile', 'selectOrganization', 'saveNewLabtestStay']) {
    assert.deepEqual(await runTool({ tool }), { id: undefined, tool, outcome: 'input_gap', issue: 'unknown_tool' });
  }
  assert.equal((await runTool({ tool: 'searchRatePlans' })).issue, 'NATIVE_ROOM_RATE_LOOKUP_UNVERIFIED');
  assert.equal((await runTool({ tool: 'closeRoomRatePicker' })).outcome, 'not_open');
  assert.throws(() => createCloudLookupReadTools({}, 'UNKNOWN'), /HMS_PROPERTY_REQUIRED/);
});

test('guest profile inquiry binds the native response to selected property and query', () => {
  const body = new URLSearchParams({ GRID_NAME: 'LVGUESTS', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
    LOV_ALIAS_VALUE_1: 'HRDAVS', MADDON_FILTER_ALIAS_NAME_1: 'lastname', MADDON_FILTER_VALUE_1: 'Labtest' });
  const request = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/GRIDDATA',
    postData: () => body.toString() };
  assert.equal(matchesGuestProfileReadRequest(request, 'lastname', 'Labtest', 'HRDAVS'), true);
  assert.equal(matchesGuestProfileReadRequest(request, 'lastname', 'Labtest', 'HRDAV'), false);
  assert.equal(matchesGuestProfileReadRequest(request, 'lastname', 'Other', 'HRDAVS'), false);
});

test('Cloud scope and credential lease fail closed before browser access', async () => {
  assert.equal(cloudCredentialLeaseKey('HRDAV'), cloudCredentialLeaseKey('HRDAVS'));
  assert.notEqual(cloudCredentialLeaseKey('HRDAV'), cloudCredentialLeaseKey('HRCEN'));
  assert.throws(() => cloudCredentialLeaseKey('UNKNOWN'), /HMS_PROPERTY_REQUIRED/);
  let loaded = false;
  await assert.rejects(withCloudReadSession(async () => {}, { loadSecret: async () => { loaded = true; } }),
    /HMS_PROPERTY_REQUIRED/);
  assert.equal(loaded, false);
  await assert.rejects(switchCloudProperty({}, { propertyCode: 'HRCEN', landingPropertyCode: 'HRDAV' }),
    /HMS_PROPERTY_SWITCH_REFUSED/);
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(acquireCloudCredentialLease('HRDAV'), /HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED/);
    await assert.rejects(acquireCloudCredentialLease('HRDAVS'), /HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED/);
  } finally { if (previous !== undefined) process.env.DATABASE_URL = previous; }
});

test('Cloud credentials must include the authenticated transport before browser launch', async () => {
  const davinci = getPropertyRegistration('HRDAV');
  const davinciSecret = { expectedPropertyCode: 'HRDAV', expectedTenant: 'DAVINCI_PRD',
    expectedPropertyName: 'Davinci Hotel', username: 'NAVAAI', credentialMode: 'view_only',
    mailboxTransportId: 'transport-davinci' };
  assert.equal(validateHmsPropertySecret({ ...davinci, transportId: 'transport-davinci' }, davinciSecret), davinciSecret);
  assert.throws(() => validateHmsPropertySecret({ ...davinci, transportId: 'transport-faith' }, davinciSecret),
    /hms_property_credential_mismatch/);

  const launch = chromium.launch;
  let launched = false;
  chromium.launch = async () => { launched = true; throw new Error('UNEXPECTED_BROWSER_LAUNCH'); };
  try {
    await assert.rejects(withCloudReadSession(async () => {}, {
      propertyCode: 'HRCEN', transportId: 'transport-centurion', loadSecret: async () => ({
        loginUrl: 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp?tenant=THECENTURION_PRD',
        username: 'NAVAAI', password: 'test-only', expectedTenant: 'THECENTURION_PRD',
        expectedPropertyCode: 'HRCEN', expectedPropertyName: 'Centurion Hotel', credentialMode: 'view_only',
        mailboxTransportId: 'transport-davinci',
      }),
    }), /hms_property_credential_mismatch/);
    assert.equal(launched, false);
  } finally { chromium.launch = launch; }
});

test('guest search forwards the authenticated transport to its Cloud session', async () => {
  const property = getPropertyRegistration('HRDAVS');
  let sessionOptions;
  const result = await searchGuestInCloud({ propertyCode: 'HRDAVS', lastName: 'Guest', arrival: '2027-06-01', dir: '/tmp' }, {
    transportId: 'transport-faith',
    openSession: async (operation, options) => {
      sessionOptions = options;
      return operation({}, { propertyCode: property.propertyCode, tenantId: property.expectedTenant,
        landingPropertyCode: property.landingPropertyCode, origin: property.origin });
    },
    navigate: async () => {}, search: async () => ({ outcome: 'ok' }),
  });
  assert.equal(result.outcome, 'ok');
  assert.equal(sessionOptions.propertyCode, 'HRDAVS');
  assert.equal(sessionOptions.transportId, 'transport-faith');
});

test('Cloud property picker selects the exact native row and verifies the changed shell', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `
      <!doctype html><title>Infor HMS - HRDAV</title><body>
      <button class="switchproperty">HRDAV</button>
      <div class="x-window" id="gridpopup-1" style="display:none"><table>
        <tr class="x-grid-row"><td>HRDAV</td><td>Davinci Hotel</td></tr>
        <tr class="x-grid-row"><td>HRDAVS</td><td>Observed Suites Name</td></tr>
      </table><a class="x-btn" href="#">OK</a></div>
      <script>
        const button = document.querySelector('.switchproperty'), picker = document.querySelector('.x-window');
        window.EAM = { AppData: { getRawAppData: () => ({ tenantid: 'DAVINCI_PRD', property: button.textContent }) } };
        button.onclick = () => { picker.style.display = 'block'; };
        for (const row of picker.querySelectorAll('tr')) row.onclick = () => {
          for (const other of picker.querySelectorAll('tr')) other.classList.remove('x-grid-row-selected');
          row.classList.add('x-grid-row-selected');
        };
        picker.querySelector('a').onclick = (event) => {
          event.preventDefault(); button.textContent = picker.querySelector('.x-grid-row-selected td').textContent;
          document.title = 'Infor HMS - ' + button.textContent; picker.style.display = 'none';
        };
      </script></body>` }));
    const page = await context.newPage();
    await page.goto('https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/loadmain');
    assert.equal((await verifyCloudProperty(page, { propertyCode: 'HRDAV', tenantId: 'DAVINCI_PRD' })).propertyCode, 'HRDAV');
    const selected = await switchCloudProperty(page, { propertyCode: 'HRDAVS', landingPropertyCode: 'HRDAV', tenantId: 'DAVINCI_PRD' });
    assert.equal(selected.propertyCode, 'HRDAVS');
    assert.equal(selected.observedName, 'Observed Suites Name');
    await assert.rejects(verifyCloudProperty(page, { propertyCode: 'HRDAVS', tenantId: 'OTHER' }), /HMS_TENANT_MISMATCH/);
  } finally { await browser.close(); }
});

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
