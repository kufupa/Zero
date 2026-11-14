import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { bookingSessionPageOptions, createBookingToolQueue, runBookingLookupTool, runPartyTool } from './booking-lookup-session.mjs';
import { acquireCloudCredentialLease, cloudCredentialLeaseKey, switchCloudProperty, verifyCloudProperty,
  withCloudReadSession } from './cloud-session.mjs';
import { createCloudLookupReadTools } from './hms-lookup-read-session.mjs';
import { matchesGuestProfileReadRequest } from './guest-profile.mjs';
import { getPropertyRegistration, validateHmsPropertySecret } from './property-registry.mjs';
import { searchGuestInCloud } from './pane-guest-search.mjs';

test('fresh credential versions and evidence key metadata are checked under the lease before browser launch', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let held = false, launches = 0, keyReads = 0, mode = '', controller;
    const key = Buffer.alloc(32, 83), encodedKey = key.toString('base64');
    mock.module('postgres', { defaultExport: () => ({
      reserve: async () => ({ unsafe: async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) { held = true; return [{ acquired: true }]; }
        if (sql.includes('pg_advisory_unlock')) { held = false; return [{ released: true }]; }
        return [{ pid: 42 }];
      } }), end: async () => { held = false; },
    }) });
    const { getPropertyRegistration } = await import('./tooling/hms-cloud/property-registry.mjs');
    const property = getPropertyRegistration('HRDAVS');
    mock.module('@aws-sdk/client-secrets-manager', { namedExports: {
      GetSecretValueCommand: class { constructor(input) { this.input = input; } },
      SecretsManagerClient: class {
        async send(command) {
          assert.equal(command.input.VersionStage, 'AWSCURRENT');
          if (command.input.SecretId === 'evidence-fixture') {
            assert.equal(held, true); keyReads += 1;
            if (mode === 'abort-key') controller.abort(new Error('TEST_ABORT'));
            return { SecretString: mode === 'bad-key' ? 'not base64!' : encodedKey,
              VersionId: mode === 'rotated-key' ? 'key-v2' : 'key-v1',
              VersionStages: mode === 'stale-key' ? ['AWSPREVIOUS'] : ['AWSCURRENT'] };
          }
          const selected = command.input.SecretId === property.credentialSecretRef ? getPropertyRegistration('HRDAV') : getPropertyRegistration('HRCEN');
          if (selected.group === 'davinci') assert.equal(held, true);
          return { SecretString: JSON.stringify({ loginUrl: selected.origin + '/web/base/logindisp?tenant=' + selected.expectedTenant,
            username: selected.username, password: 'synthetic-only', expectedTenant: selected.expectedTenant,
            expectedPropertyCode: selected.landingPropertyCode, expectedPropertyName: selected.expectedPropertyName,
            credentialMode: 'view_only', mailboxTransportIds: selected.transportIds }),
            VersionId: mode === 'missing-version' ? undefined : mode === 'rotated-credential' ? 'credential-v2' : 'credential-v1',
            VersionStages: mode === 'missing-stages' ? undefined : mode === 'stale-credential' ? ['AWSPREVIOUS'] : ['AWSCURRENT'] };
        }
        destroy() {}
      },
    } });
    const { chromium } = await import('playwright');
    chromium.launch = async () => { launches += 1; throw new Error('BROWSER_BOUNDARY_REACHED'); };
    const { credentialVersionHmacSha256 } = await import('./tooling/hms-cloud/credential-version.mjs');
    const { credentialVersionHmacSha256: runtimeDigest } = await import('./src/hms/evidence-runtime.ts');
    const { hmacSha256PrivateValue } = await import('./src/hms/private-digests.ts');
    for (const input of [
      { evidenceKey: key, evidenceKeyVersion: 'key-v1', hmsSecretArn: property.credentialSecretRef, hmsSecretVersionId: 'credential-v1' },
      { evidenceKey: 'x'.repeat(32), evidenceKeyVersion: ' key-v1 ', hmsSecretArn: ' arn:fixture:é ', hmsSecretVersionId: ' version-二 ' },
    ]) {
      const digest = credentialVersionHmacSha256(input);
      assert.equal(digest, runtimeDigest(input));
      assert.equal(digest, hmacSha256PrivateValue({ key: input.evidenceKey, keyVersion: input.evidenceKeyVersion,
        purpose: 'credential_version', value: JSON.stringify({ secretArn: input.hmsSecretArn.trim(), versionId: input.hmsSecretVersionId.trim() }) }).hmacSha256);
    }
    const digest = credentialVersionHmacSha256({ evidenceKey: key, evidenceKeyVersion: 'key-v1',
      hmsSecretArn: property.credentialSecretRef, hmsSecretVersionId: 'credential-v1' });
    const { withCloudReadSession } = await import('./tooling/hms-cloud/cloud-session.mjs');
    let loadedKey;
    const from = Buffer.from;
    Buffer.from = function(value, encoding, ...rest) {
      const buffer = from(value, encoding, ...rest);
      if (value === encodedKey && encoding === 'base64') loadedKey = buffer;
      return buffer;
    };
    const cases = [
      ['missing-version', 'HMS_CREDENTIAL_VERSION_MISSING'], ['missing-stages', 'HMS_CREDENTIAL_VERSION_STAGES_MISSING'],
      ['stale-credential', 'HMS_CREDENTIAL_VERSION_STALE'], ['rotated-credential', 'HMS_CREDENTIAL_VERSION_MISMATCH'],
      ['missing-digest', 'HMS_CREDENTIAL_VERSION_DIGEST_MISSING'], ['missing-key-metadata', 'HMS_EVIDENCE_KEY_METADATA_MISSING'],
      ['rotated-key', 'HMS_EVIDENCE_KEY_VERSION_MISMATCH'], ['stale-key', 'HMS_EVIDENCE_KEY_VERSION_MISMATCH'],
      ['bad-key', 'HMS_EVIDENCE_KEY_INVALID'], ['abort-key', 'TEST_ABORT'], ['', 'BROWSER_BOUNDARY_REACHED'],
    ];
    for (const [failure, expected] of cases) {
      mode = failure; held = false; launches = 0; keyReads = 0; loadedKey = undefined;
      controller = new AbortController();
      process.env.DATABASE_URL = 'postgres://mock.invalid/never-connect';
      process.env.HMS_EVIDENCE_HMAC_SECRET_ARN = mode === 'missing-key-metadata' ? '' : 'evidence-fixture';
      process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = 'key-v1';
      delete process.env.HMS_EVIDENCE_HMAC_KEY;
      process.env.HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS = mode === 'missing-digest' ? '' : digest;
      await assert.rejects(withCloudReadSession(async () => { throw new Error('OPERATION_REACHED'); },
        { propertyCode: 'HRDAVS', transportId: 'transport-faith', signal: controller.signal }), new RegExp(expected));
      assert.equal(launches, mode === '' ? 1 : 0);
      assert.equal(held, false);
      if (loadedKey) assert.equal(loadedKey.every(byte => byte === 0), true);
    }
    mode = 'missing-version'; launches = 0; keyReads = 0;
    await assert.rejects(withCloudReadSession(async () => {}, { propertyCode: 'HRDAVS' }), /BROWSER_BOUNDARY_REACHED/);
    assert.equal(launches, 1); assert.equal(keyReads, 0); assert.equal(held, false);
    launches = 0;
    await assert.rejects(withCloudReadSession(async () => {}, { propertyCode: 'HRCEN', transportId: 'transport-centurion' }), /BROWSER_BOUNDARY_REACHED/);
    assert.equal(launches, 1); assert.equal(keyReads, 0);
    launches = 0;
    await assert.rejects(withCloudReadSession(async () => {}, {
      propertyCode: 'HRCEN', transportId: 'transport-centurion', loadSecret: async () => ({
        loginUrl: 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp?tenant=THECENTURION_PRD',
        username: 'NAVAAI', password: 'test-only', expectedTenant: 'THECENTURION_PRD',
        expectedPropertyCode: 'HRCEN', expectedPropertyName: 'Centurion Hotel', credentialMode: 'view_only',
        mailboxTransportId: 'transport-davinci',
      }),
    }), /hms_property_credential_mismatch/);
    assert.equal(launches, 0);
    Buffer.from = from;
    process.stdout.write(JSON.stringify({ tested: cases.length, parity: true }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: new URL('../../', import.meta.url), timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { tested: 11, parity: true });
});

test('Cloud lookup exposes only property-scoped read operations', async () => {
  const runTool = createCloudLookupReadTools({}, 'HRDAVS');
  assert.deepEqual(await runTool({ tool: 'searchGuestProfiles', propertyCode: 'HRDAV' }),
    { id: undefined, tool: 'searchGuestProfiles', outcome: 'input_gap', issue: 'PROPERTY_MISMATCH' });
  for (const tool of ['selectGuestProfile', 'selectOrganization', 'saveNewLabtestStay']) {
    assert.deepEqual(await runTool({ tool }), { id: undefined, tool, outcome: 'input_gap', issue: 'unknown_tool' });
  }
  assert.equal((await runTool({ tool: 'searchRatePlans' })).issue, 'unknown_tool');
  assert.equal((await runTool({ tool: 'closeRoomRatePicker' })).issue, 'unknown_tool');
  assert.throws(() => createCloudLookupReadTools({}, 'UNKNOWN'), /HMS_PROPERTY_REQUIRED/);

  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let releaseClose, enteredClose, retained, closeFails = false;
    let closeStarted = new Promise(resolve => { enteredClose = resolve; });
    let mayClose = new Promise(resolve => { releaseClose = resolve; });
    const page = {};
    const cloud = await import('./tooling/hms-cloud/cloud-session.mjs');
    mock.module('./tooling/hms-cloud/cloud-session.mjs', { namedExports: { ...cloud,
      withCloudReadSession: async (operation, options) => {
        assert.equal(options.propertyCode, 'HRDAVS');
        assert.equal(options.transportId, 'transport-davinci');
        assert.equal(options.startScreen, 'OSRESV');
        const result = await operation(page, { propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD',
          landingPropertyCode: 'HRDAV', origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' });
        enteredClose(); await mayClose;
        if (closeFails) throw new Error('CLOSE_UNCONFIRMED');
        return result;
      },
    } });
    const lookup = await import('./tooling/hms-cloud/lookup.mjs');
    mock.module('./tooling/hms-cloud/lookup.mjs', { namedExports: { ...lookup,
      openNewGuestStay: async (received, options) => {
        assert.equal(received, page); assert.equal(options.propertyCode, 'HRDAVS');
      },
    } });
    const rates = await import('./tooling/hms-cloud/guest-stay-room-rate.mjs');
    mock.module('./tooling/hms-cloud/guest-stay-room-rate.mjs', { namedExports: { ...rates,
      searchRatePlans: async (received, request) => {
        assert.equal(received, page); return { outcome: 'matches', candidates: [{ code: request.query }] };
      },
    } });
    const { withCloudRoomRateReadSession } = await import('./tooling/hms-cloud/hms-lookup-read-session.mjs');
    let published = false;
    const pending = withCloudRoomRateReadSession('searchRatePlans', async ({ runTool }) => {
      retained = runTool;
      assert.equal((await runTool({ tool: 'searchRoomTypes' })).issue, 'unknown_tool');
      assert.equal((await runTool({ tool: 'searchRatePlans', propertyCode: 'HRDAV' })).issue, 'PROPERTY_MISMATCH');
      return runTool({ tool: 'searchRatePlans', query: 'BAR' });
    }, { propertyCode: 'HRDAVS', transportId: 'transport-davinci' }).then(value => { published = true; return value; });
    await closeStarted;
    assert.equal(published, false);
    assert.equal((await retained({ tool: 'searchRatePlans' })).issue, 'SESSION_CLOSED');
    releaseClose();
    assert.deepEqual((await pending).candidates, [{ code: 'BAR' }]);
    closeFails = true;
    closeStarted = new Promise(resolve => { enteredClose = resolve; });
    mayClose = new Promise(resolve => { releaseClose = resolve; });
    const failed = withCloudRoomRateReadSession('searchRatePlans', async ({ runTool }) =>
      runTool({ tool: 'searchRatePlans', query: 'BAR' }), { propertyCode: 'HRDAVS', transportId: 'transport-davinci' });
    await closeStarted; releaseClose();
    await assert.rejects(failed, /CLOSE_UNCONFIRMED/);
  `;
  await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: new URL('../../', import.meta.url), timeout: 30000, maxBuffer: 1024 * 1024 });
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


test('booking session forwards scoped Cloud options', () => {
  const signal = new AbortController().signal, credentialLease = {};
  const options = bookingSessionPageOptions({ propertyCode: 'HRDAVS', transportId: 'transport-davinci',
    signal, credentialLease, headless: false, cloudTargetKey: 'target' });
  assert.deepEqual(options, { propertyCode: 'HRDAVS', transportId: 'transport-davinci', signal,
    credentialLease, headless: false, cloudTargetKey: 'target' });
  for (const invalid of [null, 'block', 1]) assert.throws(
    () => bookingSessionPageOptions({ blockServiceWorkers: invalid }), /SERVICE_WORKER_OPTION_INVALID/);
});

test('real session queue clones requests while keeping screenshot callback in session context', async () => {
  const arSelection = { outcome: 'selected_unsaved', searchId: 's', nativeId: '75', displayedArAccount: 'Account',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'araccountname', value: 'Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Account' } };
  const request = { tool: 'saveNewLabtestStay', preimageId: 'p', arrival: '2027-12-29', departure: '2027-12-31',
    guestId: '123', roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'NGI', note: 'synthetic', arSelection, expectedArProfileId: '501',
    billingReference: ' PO ', options: { beforeSaveScreenshot: 'not-a-function' } };
  const queue = createBookingToolQueue({ createAuthority: { propertyCode: 'HRCEN' }, page: { context: () => null }, labtestPreimage: { outcome: 'clear', preimageId: 'p' },
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
  const context = { createAuthority: { propertyCode: 'HRCEN' }, page: { context: () => null }, labtestPreimage: { outcome: 'clear', preimageId: 'p' },
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
