#!/usr/bin/env bash
# Runtime check, run on the box as the service user:
#   bash apps/server-pilot/deploy/runtime-check.sh [expected-sha]
# From the VPS:
#   bash apps/server-pilot/deploy/ssm-run-command.sh \
#     'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/runtime-check.sh <sha>'
#
# Prints the deployed SHA, then for http, worker, ai-worker and remote-http the
# effective workflow flags read from the running process, then health and the
# canary ledger lines. Only workflow flag names are ever printed; every other
# environment variable, including the build commit, is compared but not shown.
# Exits 1 when a process is missing or offline, a build does not match the
# checkout, health fails, or the given SHA is not the deployed one.
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --input-type=module - "${1:-}" <<'NODE'
import fs from 'node:fs';
import cp from 'node:child_process';

const expected = process.argv[2] ?? '';
if (expected && !/^[a-f0-9]{40}$/.test(expected)) { console.error('usage: runtime-check.sh [40-hex sha]'); process.exit(2); }
const FLAG = /^(?:(?:PANE_WRITE_|PANE_HMS_LAB_|PANE_CLOUD_|HMS_DAVINCI_)[A-Z0-9_]*|HMS_QUOTE_REST_FAST_PATH|PANE_STAY_LOOKUP)$/;
const SAFE_VALUE = /^[A-Za-z0-9_,.:-]{0,200}$/;
const problems = [];
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let marker = '';
try { marker = fs.readFileSync('dist/.nava-build-commit', 'utf8').trim(); } catch { /* reported below */ }
if (!/^[a-f0-9]{40}$/.test(marker)) marker = 'missing';
console.log(`deployed_sha=${head} build_marker=${marker}`);
if (marker !== head) problems.push('build marker does not match the checkout');
if (expected && expected !== head) problems.push(`expected ${expected} is not deployed`);

const names = ['http', 'worker', 'ai-worker', 'remote-http'];
// pm2 jlist carries every process environment; it is parsed here and never printed.
const apps = JSON.parse(cp.execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
for (const name of names) {
  const matches = apps.filter(app => app.name === name);
  if (matches.length !== 1) { console.log(JSON.stringify({ process: name, status: 'missing' })); problems.push(`${name} missing`); continue; }
  const app = matches[0], status = String(app.pm2_env?.status ?? 'unknown');
  let env = null;
  try {
    env = Object.fromEntries(fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  } catch { /* An offline process has no environment to read. */ }
  const flags = Object.fromEntries(Object.keys(env ?? {}).filter(key => FLAG.test(key)).sort()
    .map(key => [key, SAFE_VALUE.test(env[key]) ? env[key] : '<unprintable>']));
  const buildMatchesDeployed = env ? env.NAVA_BUILD_COMMIT === head : false;
  console.log(JSON.stringify({ process: name, pid: app.pid, status, restarts: app.pm2_env?.restart_time ?? null,
    unstableRestarts: app.pm2_env?.unstable_restarts ?? null, buildMatchesDeployed, flags }));
  if (status !== 'online') problems.push(`${name} is ${status}`);
  if (!buildMatchesDeployed) problems.push(`${name} does not run the deployed build`);
}

for (const port of [8788, 8789]) {
  let ok = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10_000) });
    ok = response.status === 200 && (await response.json()).ok === true;
  } catch { /* reported below */ }
  console.log(`health port=${port} ok=${ok}`);
  if (!ok) problems.push(`health ${port} failed`);
}

let ledger = [];
try {
  ledger = fs.readFileSync('/etc/nava/hms-canary-passes.txt', 'utf8').split(/\r?\n/)
    .filter(line => /^CANARY PASS [a-z_]+ (?:HRCEN|HRDAV|HRDAVS) [0-9a-f]{40}$/.test(line));
} catch { /* A missing ledger prints zero lines. */ }
const current = ledger.filter(line => line.endsWith(` ${head}`));
console.log(`canary_lines total=${ledger.length} deployed_sha=${current.length}`);
for (const line of current) console.log(line);
for (const line of ledger.filter(line => !current.includes(line)).slice(-20)) console.log(line);

if (problems.length) { for (const problem of problems) console.error(`runtime-check FAIL: ${problem}`); process.exit(1); }
console.log('runtime-check ok');
NODE
