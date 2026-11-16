import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { bookingSessionPageOptions, createBookingToolQueue, runBookingLookupTool, runPartyTool } from './booking-lookup-session.mjs';
import { acquireCloudCredentialLease, cloudCredentialLeaseKey, switchCloudProperty, verifyCloudProperty, verifyCloudCredentialVersion,
  withCloudReadSession } from './cloud-session.mjs';
import { createCloudLookupReadTools } from './hms-lookup-read-session.mjs';
import { matchesGuestProfileReadRequest } from './guest-profile.mjs';
import { getPropertyRegistration, validateHmsPropertySecret } from './property-registry.mjs';
import { searchGuestInCloud } from './pane-guest-search.mjs';
import { matchesRatePlanPickerRequest } from './guest-stay-room-rate.mjs';

test('explicit unbound reads tolerate a missing digest but reject configured invalid digests and strict reads', async () => {
  const key = 'HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS';
  const previous = process.env[key];
  try {
    delete process.env[key];
    const input = { propertyCode: 'HRDAVS', transportId: 'transport-faith', loadedSecret: {}, allowUnboundVersion: true };
    assert.equal(await verifyCloudCredentialVersion(input), null);
    await assert.rejects(verifyCloudCredentialVersion({ ...input, requireBoundVersion: true }), /HMS_CREDENTIAL_VERSION_MISSING/);
    process.env[key] = 'invalid';
    await assert.rejects(verifyCloudCredentialVersion(input), /HMS_CREDENTIAL_VERSION_MISSING/);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('target browser quarantine clears under the credential lease only after its exact owner is quiescent', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const home = mkdtempSync(join(os.tmpdir(), 'zero-cloud-hold-'));
    mock.method(os.default, 'homedir', () => home);
    syncBuiltinESMExports();
    let held = false, credentialReads = 0;
    mock.module('postgres', { defaultExport: () => ({
      reserve: async () => ({ unsafe: async (sql) => {
        if (/pg_(?:try_)?advisory_lock/.test(sql)) { held = true; return [{ acquired: true }]; }
        if (sql.includes('pg_advisory_unlock')) { held = false; return [{ released: true }]; }
        return [{ pid: 42 }];
      } }), end: async () => { held = false; },
    }) });
    const cloud = await import('./tooling/hms-cloud/cloud-session.mjs');
    process.env.DATABASE_URL = 'postgres://mock.invalid/never-connect';
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await Promise.all([once(owner, 'spawn'), once(browser, 'spawn')]);
    const processIdentity = child => ({ pid: child.pid,
      started: readFileSync('/proc/' + child.pid + '/stat', 'utf8').split(')').at(-1).trim().split(/\s+/)[19] });
    const identity = {
      host: createHash('sha256').update(readFileSync('/etc/machine-id', 'utf8').trim()).update('\0').update(os.hostname()).digest('hex'),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pidNamespace: (await import('node:fs')).readlinkSync('/proc/self/ns/pid'),
      node: processIdentity(owner), browser: processIdentity(browser),
    };
    const alias = JSON.stringify(['HRCEN', 'create', 'quarantine', 'test', '2027-12-01']);
    const path = cloud.cloudHoldPath('HRCEN', alias);
    const hold = { version: 2, propertyCode: 'HRCEN', alias, identity };
    const write = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const options = { propertyCode: 'HRCEN', cloudTargetKey: alias, loadSecret: async () => {
      assert.equal(held, true); credentialReads += 1; throw new Error('STOP_BEFORE_BROWSER');
    } };
    const run = () => cloud.withCloudReadSession(async () => assert.fail('operation reached'), options);
    const stop = async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGKILL'); await exited;
    };
    try {
      write(hold);
      await assert.rejects(run(), /HMS_BROWSER_HOLD/);
      assert.equal(credentialReads, 0); assert.equal(held, false); assert.equal(existsSync(path), true);
      await Promise.all([stop(owner), stop(browser)]);
      assert.equal(cloud.cloudWriterQuiesced(identity), true);
      for (const untrusted of [{ propertyCode: 'HRCEN', identity }, { ...hold, alias: alias + ' ' },
        { ...hold, identity: { ...identity, host: 'unattested' } }]) {
        write(untrusted); await assert.rejects(run(), /HMS_BROWSER_HOLD/);
        assert.equal(existsSync(path), true); assert.equal(credentialReads, 0); assert.equal(held, false);
      }
      write(hold);
      await assert.rejects(run(), /HMS_CREDENTIALS_UNAVAILABLE/);
      assert.equal(existsSync(path), false); assert.equal(credentialReads, 1); assert.equal(held, false);
      const lease = await cloud.acquireCloudCredentialLease('HRCEN');
      write(hold);
      await assert.rejects(cloud.withCloudReadSession(async () => {}, { ...options, credentialLease: lease }), /HMS_CREDENTIALS_UNAVAILABLE/);
      assert.equal(existsSync(path), false); assert.equal(held, true);
      await lease.release(); assert.equal(held, false);
      process.stdout.write('quarantine recovery verified');
    } finally {
      await Promise.all([stop(owner), stop(browser)]); rmSync(home, { recursive: true, force: true });
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { cwd: new URL('../../', import.meta.url), timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(stdout, 'quarantine recovery verified');
});

test('owned writer cleanup separates close API errors from physical exit and lease safety', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as os from 'node:os';
    import * as fs from 'node:fs';
    import * as timers from 'node:timers/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const mode = process.argv[1], home = fs.mkdtempSync(join(os.tmpdir(), 'zero-writer-cleanup-'));
    const children = []; let held = false, round = 0, tamperIdentity = false, releaseCallback;
    const timeout = timers.setTimeout, readFileSync = fs.readFileSync, unlinkSync = fs.unlinkSync;
    mock.method(os.default, 'homedir', () => home);
    mock.method(timers.default, 'setTimeout', (ms, ...args) => timeout(ms === 30000 ? 100 : ms, ...args));
    mock.method(fs.default, 'readFileSync', (path, ...args) => {
      const value = readFileSync(path, ...args), child = children.at(-1)?.child;
      if (mode === 'unknown-owner' && tamperIdentity && path === '/proc/' + child?.pid + '/stat') {
        const split = value.lastIndexOf(')'), fields = value.slice(split + 1).trim().split(/\s+/);
        fields[19] = String(BigInt(fields[19]) + 1n);
        return value.slice(0, split + 1) + ' ' + fields.join(' ');
      }
      return value;
    });
    mock.method(fs.default, 'unlinkSync', path => {
      if (mode === 'hold-release' && path.includes('credential-browser-hold-')) throw new Error('TEST_HOLD_RELEASE_FAILED');
      return unlinkSync(path);
    });
    syncBuiltinESMExports();
    mock.module('postgres', { defaultExport: () => ({
      reserve: async () => ({ unsafe: async sql => {
        if (/pg_(?:try_)?advisory_lock/.test(sql)) { held = true; return [{ acquired: true }]; }
        if (sql.includes('pg_advisory_unlock')) { held = false; return [{ released: true }]; }
        return [{ pid: 42 }];
      } }), end: async () => { held = false; },
    }) });
    const key = Buffer.alloc(32, 83);
    mock.module('@aws-sdk/client-secrets-manager', { namedExports: {
      GetSecretValueCommand: class {},
      SecretsManagerClient: class {
        async send() { return { SecretString: key.toString('base64'), VersionId: 'key-v1', VersionStages: ['AWSCURRENT'] }; }
        destroy() {}
      },
    } });
    const fixture = () => {
      const context = { route: async () => {}, routeWebSocket: async (pattern, handler) => {
        assert.equal(pattern,'**/*'); let closed = false;
        handler({ close: () => { closed = true; } }); assert.equal(closed,true);
      }, close: async () => { throw new Error('TEST_CONTEXT_CLOSE_FAILED'); } };
      const page = { context: () => context, on: () => {}, goto: async () => {}, evaluate: async () => true,
        waitForFunction: async (_fn, input) => ({ jsonValue: async () => ({ propertyCode: input.expectedProperty,
          tenantId: input.expectedTenant, origin: input.expectedOrigin }), dispose: async () => {} }) };
      context.newPage = async () => page;
      return { newContext: async () => context, close: async () => { throw new Error('TEST_BROWSER_CLOSE_FAILED'); } };
    };
    const childSource = "process.on('message',m=>{if(m==='close')setTimeout(()=>process.exit(0),150)});process.send('ready');setInterval(()=>{},1000)";
    mock.module('playwright', { namedExports: { chromium: {
      launch: async () => fixture(), connect: async () => fixture(),
      launchServer: async () => {
        round += 1;
        const child = spawn(process.execPath, ['-e', childSource], { detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
        const ready = once(child,'message'), exited = once(child,'exit');
        children.push({ child, exited }); await ready;
        return { process: () => child, wsEndpoint: () => 'fixture', close: async () => {
          if (mode !== 'live-group') child.send('close');
        } };
      },
    } } });
    const cloud = await import('./tooling/hms-cloud/cloud-session.mjs');
    const { getPropertyRegistration } = await import('./tooling/hms-cloud/property-registry.mjs');
    const { credentialVersionHmacSha256 } = await import('./tooling/hms-cloud/credential-version.mjs');
    const property = getPropertyRegistration('HRCEN');
    process.env.DATABASE_URL = 'postgres://mock.invalid/never-connect';
    process.env.HMS_EVIDENCE_HMAC_SECRET_ARN = 'evidence-fixture'; process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = 'key-v1';
    process.env.HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRCEN = credentialVersionHmacSha256({
      evidenceKey: key, evidenceKeyVersion: 'key-v1', hmsSecretArn: property.credentialSecretRef, hmsSecretVersionId: 'credential-v1',
    });
    const secret = { loginUrl: property.origin + '/web/base/logindisp?tenant=' + property.expectedTenant,
      username: property.username, password: 'synthetic-only', expectedTenant: property.expectedTenant,
      expectedPropertyCode: 'HRCEN', expectedPropertyName: property.expectedPropertyName,
      credentialMode: 'view_only', mailboxTransportId: 'transport-centurion' };
    const alias = JSON.stringify(['HRCEN','create','cleanup','test','2027-12-01']);
    const lease = await cloud.acquireCloudCredentialLease('HRCEN');
    const options = { propertyCode:'HRCEN', transportId:'transport-centurion', credentialLease:lease, cloudTargetKey:alias,
      loadSecret:async () => ({ secret, versionId:'credential-v1', versionStages:['AWSCURRENT'] }) };
    const credentialHold = join(home,'.nava-hms-runtime','credential-browser-hold-' + cloud.cloudCredentialLeaseKey('HRCEN'));
    let identity;
    const operation = async page => {
      identity = cloud.cloudWriterIdentity(page);
      if (mode !== 'reader-close') assert.equal(cloud.cloudWriterCurrent(identity),true);
      if (mode === 'operation-refusal' && round === 1) throw new Error('TEST_OPERATION_REFUSED');
      if (mode === 'unknown-owner') tamperIdentity = true;
      if (mode === 'undrained') {
        setTimeout(() => controller.abort(new Error('TEST_ABORT')),10);
        await new Promise(resolve => { releaseCallback = resolve; });
      }
      return { prepared:true };
    };
    const controller = new AbortController();
    try {
      const run = mode === 'reader-close' ? cloud.withCloudReadSession : cloud.withCloudWriterSession;
      const pending = run(operation,{ ...options,...(mode === 'undrained' ? { signal:controller.signal } : {}) });
      if (mode === 'delayed-exit' || mode === 'operation-refusal') {
        if (mode === 'operation-refusal') await assert.rejects(pending,/TEST_OPERATION_REFUSED/);
        else assert.deepEqual(await pending,{ prepared:true });
        assert.equal(cloud.cloudWriterQuiesced(identity),true);
        assert.equal(fs.existsSync(credentialHold),false);
        assert.equal(fs.existsSync(cloud.cloudHoldPath('HRCEN',alias)),false);
        assert.equal(held,true);
        assert.deepEqual(await cloud.withCloudWriterSession(async () => ({ borrowedAgain:true }),options),{ borrowedAgain:true });
        await lease.release(); assert.equal(held,false);
      } else {
        const expected = mode === 'undrained' ? /SAVE_CALLBACK_DRAIN_UNCONFIRMED/ : mode === 'hold-release' ? /TEST_HOLD_RELEASE_FAILED/ :
          mode === 'unknown-owner' ? /HMS_WRITER_IDENTITY_UNAVAILABLE/ : /HMS_SESSION_CLEANUP_FAILED/;
        await assert.rejects(pending,expected);
        if (mode !== 'reader-close') {
          assert.equal(fs.existsSync(credentialHold),true);
          assert.equal(fs.existsSync(cloud.cloudHoldPath('HRCEN',alias)),true);
        }
        await assert.rejects(lease.release(),/HMS_CREDENTIAL_LEASE_IN_USE/); assert.equal(held,true);
        if (mode === 'live-group') assert.equal(cloud.cloudWriterCurrent(identity),true);
      }
      process.stdout.write(mode);
    } finally {
      releaseCallback?.();
      for (const { child,exited } of children) {
        if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid,'SIGKILL');
        await exited;
      }
      mock.restoreAll(); syncBuiltinESMExports();
      fs.rmSync(home,{ recursive:true,force:true });
    }
  `;
  for (const mode of ['delayed-exit','operation-refusal','live-group','undrained','hold-release','unknown-owner','reader-close']) {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--experimental-test-module-mocks','--input-type=module','-e',script,mode],
      { cwd:new URL('../../',import.meta.url), timeout:15000, maxBuffer:1024*1024 });
    assert.equal(stdout,mode);
  }
});

test('fresh credential versions and evidence key metadata are checked under the lease before browser launch', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    const home = mkdtempSync(join(os.tmpdir(), 'zero-cloud-credential-'));
    mock.method(os.default, 'homedir', () => home);
    syncBuiltinESMExports();
    process.on('exit', () => rmSync(home, { recursive: true, force: true }));
    let held = false, launches = 0, keyReads = 0, mode = '', controller;
    const key = Buffer.alloc(32, 83), encodedKey = key.toString('base64');
    mock.module('postgres', { defaultExport: () => ({
      reserve: async () => ({ unsafe: async (sql) => {
        if (/pg_(?:try_)?advisory_lock/.test(sql)) { held = true; return [{ acquired: true }]; }
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

test('source lookup passes property in options without adding a source filter', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const received = [];
    mock.module('./tooling/hms-cloud/guest-stay-source-business.mjs', { namedExports: {
      inspectGuestStaySourceBusiness: async () => {},
      selectGuestStaySourceBusiness: async () => {},
      closeGuestStaySourceBusinessPicker: async () => {},
      searchGuestStaySourceBusiness: async (page, input, options) => {
        received.push({ input, options });
        if (Object.keys(input).some(key => !['field', 'query'].includes(key))) {
          return { outcome: 'unsupported', issue: 'SOURCE_FILTER_UNSUPPORTED' };
        }
        return { outcome: 'matches', candidates: [] };
      },
    } });
    const { runBookingLookupTool } = await import('./tooling/hms-cloud/booking-lookup-session.mjs');
    const context = { page: {}, createAuthority: { propertyCode: 'HRDAVS' } };
    const request = { id: 'source', tool: 'searchGuestStaySourceBusiness', propertyCode: 'HRDAVS',
      field: 'description', query: 'GDS', options: { timeoutMs: 5000 } };
    assert.equal((await runBookingLookupTool(context, request)).outcome, 'matches');
    assert.deepEqual(received[0], { input: { field: 'description', query: 'GDS' },
      options: { timeoutMs: 5000, propertyCode: 'HRDAVS' } });
    assert.equal((await runBookingLookupTool(context, { ...request, extraFilter: 'x' })).issue, 'SOURCE_FILTER_UNSUPPORTED');
    assert.equal((await runBookingLookupTool(context, { ...request, propertyCode: 'HRDAV' })).issue, 'PROPERTY_MISMATCH');
    assert.equal(received.length, 2);
  `;
  await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: new URL('../../', import.meta.url), timeout: 30000, maxBuffer: 1024 * 1024 });
});

test('rate picker read is tied to the verified rate-shop session and property', () => {
  const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
  const rateShop = { kind: 'ratePlan', propertyCode: 'HRCEN', bookingSessionId: 'session-1' };
  const fields = { GRID_NAME: 'LVMULTIRATEPLANS3', GRID_TYPE: 'LIST',
    LOV_ALIAS_NAME_1: 'control.property', LOV_ALIAS_VALUE_1: 'HRCEN', LOV_ALIAS_TYPE_1: 'text',
    LOV_ALIAS_NAME_2: 'param.arrivaldate', LOV_ALIAS_VALUE_2: '11/23/2026', LOV_ALIAS_TYPE_2: 'text' };
  const request = (params = fields, url = `${origin}/web/base/BSMSLV`, method = 'POST') => ({
    method: () => method, url: () => url, postData: () => new URLSearchParams(params).toString(),
  });
  const allowed = (params, session = rateShop, url, method) =>
    matchesRatePlanPickerRequest(request(params, url, method), origin, 'HRCEN', session);
  assert.equal(allowed(fields), true);
  assert.equal(allowed({ ...fields, harmlessNativeField: 'new' }), true);
  assert.equal(allowed({ ...fields, LOV_ALIAS_VALUE_1: 'HRDAV' }), false);
  assert.equal(allowed({ ...fields, GRID_NAME: 'OTHER' }), false);
  assert.equal(allowed({ ...fields, LOV_ALIAS_TYPE_1: 'integer' }), false);
  assert.equal(allowed({ ...fields, LOV_ALIAS_NAME_3: 'param.propertycode', LOV_ALIAS_VALUE_3: 'HRDAV' }), false);
  assert.equal(allowed({ ...fields, grid_name: 'OTHER' }), false);
  assert.equal(allowed({ ...fields, action: 'SAVE' }), false);
  assert.equal(allowed(fields, { ...rateShop, bookingSessionId: '' }), false);
  assert.equal(allowed(fields, { ...rateShop, propertyCode: 'HRDAV' }), false);
  assert.equal(allowed(fields, rateShop, `${origin}/web/base/BSMSLV?x=1`), false);
  assert.equal(allowed(fields, rateShop, 'https://example.invalid/web/base/BSMSLV'), false);
  assert.equal(allowed(fields, rateShop, `${origin}/web/base/BSMSLV`, 'GET'), false);
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

test('Cloud credentials accept registered transports through the primary membership before browser launch', async () => {
  const davinci = getPropertyRegistration('HRDAV');
  const davinciSecret = { expectedPropertyCode: 'HRDAV', expectedTenant: 'DAVINCI_PRD',
    expectedPropertyName: 'Davinci Hotel', username: 'NAVAAI', credentialMode: 'view_only',
    mailboxTransportId: 'transport-davinci' };
  assert.equal(validateHmsPropertySecret({ ...davinci, transportId: 'transport-davinci' }, davinciSecret), davinciSecret);
  for (const propertyCode of ['HRDAV', 'HRDAVS']) {
    const property = getPropertyRegistration(propertyCode);
    for (const transportId of property.transportIds) {
      assert.equal(validateHmsPropertySecret({ ...property, transportId }, davinciSecret), davinciSecret);
    }
  }
  assert.throws(() => validateHmsPropertySecret({ ...davinci, transportId: 'transport-unknown' }, davinciSecret),
    /hms_property_credential_mismatch/);
  assert.throws(() => validateHmsPropertySecret({ ...davinci, transportId: 'transport-faith' },
    { ...davinciSecret, mailboxTransportId: 'transport-epick' }),
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
  const signal = new AbortController().signal, credentialLease = {}, cloudTargetKeys = ['target', 'alias'];
  for (const [propertyCode, transportId] of [['HRCEN', 'transport-centurion'], ['HRDAV', 'transport-davinci'],
    ['HRDAVS', 'transport-davinci']]) {
    const scoped = { propertyCode, transportId, signal, credentialLease, headless: false,
      cloudTargetKey: 'target', cloudTargetKeys };
    assert.deepEqual(bookingSessionPageOptions(scoped), scoped);
    assert.deepEqual(bookingSessionPageOptions({ ...scoped, labtestDates: undefined }), scoped);
    for (const labtestDates of [{ arrival: '2027-12-29', departure: '2027-12-31' }, null]) {
      assert.deepEqual(bookingSessionPageOptions({ ...scoped, labtestDates }), { ...scoped, startScreen: 'OSRESS' });
    }
  }
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
