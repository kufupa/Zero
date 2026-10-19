import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../deploy/hms-slot-hrdav-install.sh', import.meta.url),
);

const HRCEN_SECRET = 'nava-zero/server-pilot/infor-hms-read';
const HRDAV_SECRET = 'nava-zero/server-pilot/infor-hms-read-davinci';

function hrcenEnvText(lib) {
  return [
    'PLAYWRIGHT_BROWSERS_PATH=/opt/nava/ms-playwright',
    `HMS_SLOT_PROFILE_DIR=${lib}/hrcen/profile`,
    'HMS_SLOT_CDP_PORT=19223',
    'HMS_SLOT_DEBUG_ADDRESS=127.0.0.1',
    `HMS_SLOT_PHASE_PATH=${lib}/hrcen/phase.json`,
    `HMS_READ_SECRET_ARN=${HRCEN_SECRET}`,
    'HMS_SLOT_HEADLESS=1',
    'AWS_REGION=af-south-1',
    '',
  ].join('\n');
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const harnessHrcenText = new Map();

function makeHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hms-slot-hrdav-'));
  const bin = join(root, 'bin');
  const etc = join(root, 'etc', 'nava');
  const lib = join(root, 'var', 'lib', 'nava', 'hms-slot');
  const systemd = join(root, 'etc', 'systemd', 'system');
  const log = join(root, 'systemctl.log');
  mkdirSync(bin);
  mkdirSync(etc, { recursive: true });
  mkdirSync(join(lib, 'hrcen'), { recursive: true });
  mkdirSync(systemd, { recursive: true });
  const hrcenText = options.hrcenEnv ?? hrcenEnvText(lib);
  writeFileSync(join(etc, 'hms-slot-hrcen.env'), hrcenText, {
    mode: 0o600,
  });
  harnessHrcenText.set(root, hrcenText);
  if (options.hrdavEnv != null) {
    writeFileSync(join(etc, 'hms-slot-hrdav.env'), options.hrdavEnv, { mode: 0o600 });
  }
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [[ "\${1:-}" == is-active ]]; then
  if [[ "\${SYSTEMCTL_FAIL_ACTIVE:-}" == 1 ]]; then exit 3; fi
  exit 0
fi
if [[ "\${1:-}" == is-enabled ]]; then
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  writeFileSync(log, '');
  return { root, bin, etc, lib, systemd, log };
}

function runScript(harness, args = [], extraEnv = {}) {
  return spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${harness.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: harness.root,
      SUDO: '',
      NAVA_ETC: harness.etc,
      HMS_SLOT_LIB: harness.lib,
      HMS_SLOT_SYSTEMD_DIR: harness.systemd,
      SYSTEMCTL: join(harness.bin, 'systemctl'),
      SYSTEMCTL_LOG: harness.log,
      ...extraEnv,
    },
  });
}

test('install copies the hrcen env, switches port/profile/secret, keeps browsers path, enables hrdav, leaves hrcen alone', () => {
  assert.equal(existsSync(scriptPath), true, 'hms-slot-hrdav-install.sh must exist');
  const harness = makeHarness();
  try {
    const result = runScript(harness);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const hrdav = parseEnv(readFileSync(join(harness.etc, 'hms-slot-hrdav.env'), 'utf8'));
    const hrcen = parseEnv(readFileSync(join(harness.etc, 'hms-slot-hrcen.env'), 'utf8'));
    assert.equal(hrdav.HMS_SLOT_CDP_PORT, '19225');
    assert.equal(hrdav.HMS_SLOT_PROFILE_DIR, join(harness.lib, 'hrdav', 'profile'));
    assert.equal(hrdav.HMS_SLOT_PHASE_PATH, join(harness.lib, 'hrdav', 'phase.json'));
    assert.equal(hrdav.HMS_READ_SECRET_ARN, HRDAV_SECRET);
    assert.equal(hrdav.PLAYWRIGHT_BROWSERS_PATH, '/opt/nava/ms-playwright');
    assert.equal(hrdav.HMS_SLOT_DEBUG_ADDRESS, '127.0.0.1');
    assert.equal(hrcen.HMS_SLOT_CDP_PORT, '19223');
    assert.equal(hrcen.HMS_READ_SECRET_ARN, HRCEN_SECRET);
    assert.equal(existsSync(join(harness.lib, 'hrdav', 'profile')), true);
    const calls = readFileSync(harness.log, 'utf8');
    assert.match(calls, /enable --now hms-slot@hrdav/);
    assert.doesNotMatch(calls, /hms-slot@hrcen/);
    assert.doesNotMatch(result.stdout + result.stderr, /pkill/);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('rollback disables hrdav, restores a previous hrdav env, and does not touch hrcen', () => {
  const previous = 'HMS_SLOT_CDP_PORT=19999\nHMS_READ_SECRET_ARN=old\n';
  const harness = makeHarness({ hrdavEnv: previous });
  try {
    const installed = runScript(harness);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const rolled = runScript(harness, ['rollback']);
    assert.equal(rolled.status, 0, rolled.stderr || rolled.stdout);
    assert.equal(readFileSync(join(harness.etc, 'hms-slot-hrdav.env'), 'utf8'), previous);
    assert.equal(
      readFileSync(join(harness.etc, 'hms-slot-hrcen.env'), 'utf8'),
      harnessHrcenText.get(harness.root),
    );
    const calls = readFileSync(harness.log, 'utf8');
    assert.match(calls, /disable --now hms-slot@hrdav/);
    assert.doesNotMatch(calls, /disable --now hms-slot@hrcen|stop hms-slot@hrcen/);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('failed start rolls back the new env when none existed before', () => {
  const harness = makeHarness();
  try {
    const result = runScript(harness, [], { SYSTEMCTL_FAIL_ACTIVE: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(harness.etc, 'hms-slot-hrdav.env')), false);
    const calls = readFileSync(harness.log, 'utf8');
    assert.match(calls, /disable --now hms-slot@hrdav/);
    assert.equal(existsSync(join(harness.etc, 'hms-slot-hrcen.env')), true);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('refuses to install without PLAYWRIGHT_BROWSERS_PATH in the hrcen env', () => {
  const harness = makeHarness({
    hrcenEnv: 'HMS_SLOT_PROFILE_DIR=/var/lib/nava/hms-slot/hrcen/profile\nHMS_SLOT_CDP_PORT=19223\n',
  });
  try {
    const result = runScript(harness);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(harness.etc, 'hms-slot-hrdav.env')), false);
    assert.match(result.stderr + result.stdout, /PLAYWRIGHT_BROWSERS_PATH/);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
