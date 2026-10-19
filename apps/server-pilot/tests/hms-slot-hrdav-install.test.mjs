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
import { tmpdir, userInfo } from 'node:os';
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
  if (options.hrdavEnv != null) {
    writeFileSync(join(root, 'was-enabled'), '1');
    writeFileSync(join(root, 'was-active'), '1');
  }
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
case "\${1:-}" in
  restart) : > "$SYSTEMCTL_RESTARTED" ;;
  is-enabled)
    [ -f "$SYSTEMCTL_WAS_ENABLED" ] || exit 1
    exit 0
    ;;
  is-active)
    if [[ "\${SYSTEMCTL_FAIL_ACTIVE:-}" == 1 && -f "$SYSTEMCTL_RESTARTED" ]]; then
      exit 3
    fi
    if [ -f "$SYSTEMCTL_RESTARTED" ] || [ -f "$SYSTEMCTL_WAS_ACTIVE" ]; then
      exit 0
    fi
    exit 3
    ;;
esac
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
      SYSTEMCTL_WAS_ENABLED: join(harness.root, 'was-enabled'),
      SYSTEMCTL_WAS_ACTIVE: join(harness.root, 'was-active'),
      SYSTEMCTL_RESTARTED: join(harness.root, 'restarted'),
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
    assert.equal(existsSync(join(harness.lib, 'hrdav')), true);
    const script = readFileSync(scriptPath, 'utf8');
    assert.match(script, /dirname "\$profile"/);
    const calls = readFileSync(harness.log, 'utf8');
    assert.match(calls, /enable hms-slot@hrdav/);
    assert.match(calls, /restart hms-slot@hrdav/);
    assert.doesNotMatch(calls, /hms-slot@hrcen/);
    assert.doesNotMatch(result.stdout + result.stderr, /pkill/);
    assert.doesNotMatch(script, /mktemp "\$\{NAVA_ETC\}/);
    assert.match(script, /run "\$SYSTEMCTL"/);
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

test('failed reinstall restores a previously running hrdav unit instead of leaving it disabled', () => {
  const previous = 'HMS_SLOT_CDP_PORT=19999\nHMS_READ_SECRET_ARN=old\n';
  const harness = makeHarness({ hrdavEnv: previous });
  try {
    const result = runScript(harness, [], { SYSTEMCTL_FAIL_ACTIVE: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(harness.etc, 'hms-slot-hrdav.env'), 'utf8'), previous);
    const calls = readFileSync(harness.log, 'utf8');
    assert.match(calls, /enable hms-slot@hrdav/);
    assert.match(calls, /restart hms-slot@hrdav/);
    const afterFail = calls.split('is-active --quiet hms-slot@hrdav').pop() ?? '';
    assert.doesNotMatch(afterFail, /disable --now hms-slot@hrdav/);
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

test('uses sudo for env install and systemctl when SUDO is set', () => {
  const harness = makeHarness();
  const sudoLog = join(harness.root, 'sudo.log');
  writeFileSync(
    join(harness.bin, 'sudo'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$SUDO_LOG"
exec "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(join(harness.bin, 'sudo'), 0o755);
  writeFileSync(sudoLog, '');
  try {
    const result = runScript(harness, [], {
      SUDO: join(harness.bin, 'sudo'),
      SUDO_LOG: sudoLog,
      HMS_SLOT_USER: userInfo().username,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sudoed = readFileSync(sudoLog, 'utf8');
    assert.match(sudoed, /hms-slot-hrdav\.env/);
    assert.match(sudoed, /systemctl/);
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
