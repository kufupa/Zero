import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { probeCommandEnv, probeSucceeded } from './diagnostics/party-lookup-batch-probe.mjs';

test('import has no CLI, browser or credential side effects', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./diagnostics/party-lookup-batch-probe.mjs', import.meta.url).href)}); console.log('import only');`],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'import only');
  assert.equal(child.stderr, '');
});

test('probe env requires loopback CDP, borrowed ownership, and a secret source', () => {
  assert.throws(() => probeCommandEnv({ HMS_STAGEHAND_CDP_URL: 'http://10.0.0.1:19225', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed', HMS_READ_SECRET_ARN: 'x' }), /LOOPBACK_CDP_REQUIRED/);
  assert.throws(() => probeCommandEnv({ HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19225', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'owned', HMS_READ_SECRET_ARN: 'x' }), /BORROWED_OWNERSHIP_REQUIRED/);
  assert.throws(() => probeCommandEnv({ HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19225', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed' }), /SECRET_SOURCE_REQUIRED/);
  const env = probeCommandEnv({
    HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19225',
    HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
    HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read-davinci',
  });
  assert.equal(env.HMS_STAGEHAND_CDP_URL, 'http://127.0.0.1:19225/');
});

test('probeSucceeded is true only when both searches answered', () => {
  assert.equal(probeSucceeded({
    searches: [
      { outcome: 'no_match', skipped: false },
      { outcome: 'no_match', skipped: false },
    ],
  }), true);
  assert.equal(probeSucceeded({
    searches: [{ outcome: 'execution_failure', skipped: false }],
  }), false);
  assert.equal(probeSucceeded({
    searches: [
      { outcome: 'no_match', skipped: false },
      { outcome: 'execution_failure', skipped: false },
    ],
  }), false);
});
