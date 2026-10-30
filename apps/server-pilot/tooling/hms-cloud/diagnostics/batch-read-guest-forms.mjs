#!/usr/bin/env node
// Read the selected Guest Details forms for a private list of existing stays.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [inputArg, outputArg, workersArg] = process.argv.slice(2);
const workers = Number(workersArg);
if (process.argv.length !== 5 || !Number.isInteger(workers) || workers < 1) {
  throw new Error('EXPECTED_INPUT_OUTPUT_AND_WORKERS');
}
const input = resolve(inputArg);
const output = resolve(outputArg);
if ((statSync(dirname(output)).mode & 0o077) !== 0) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');
let candidates;
try {
  candidates = JSON.parse(readFileSync(input, 'utf8')).candidates;
} catch {
  console.error('INVALID_CANDIDATES');
  process.exit(2);
}
if (!Array.isArray(candidates) || !candidates.length ||
    candidates.some((item) => !item || typeof item.confirmation !== 'string' ||
      !item.confirmation.trim() || item.confirmation !== item.confirmation.trim()) ||
    new Set(candidates.map((item) => item.confirmation)).size !== candidates.length) {
  throw new Error('INVALID_CANDIDATES');
}
process.umask(0o077);
closeSync(openSync(output, 'wx', 0o600));
const runner = fileURLToPath(new URL('../read-guest-form-ui.mjs', import.meta.url));
const startedAt = new Date().toISOString();
const results = candidates.map((item) => ({ confirmation: item.confirmation, ok: null }));
const active = new Set();
let next = 0;
let completed = 0;
let succeeded = 0;
let failed = 0;
let interrupted = false;

function save() {
  const partial = `${output}.partial`;
  writeFileSync(partial, JSON.stringify({ source: input, startedAt, updatedAt: new Date().toISOString(),
    concurrency: workers, total: candidates.length, completed, succeeded, failed, results }, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(partial, output);
}

function stopChild(child, signal) {
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of active) stopChild(child, 'SIGTERM');
  });
}

function attempt(item, includeName) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [runner, '--json-stdin'], {
      env: { ...process.env, STAY360_PRIVATE_ROOT: dirname(output) }, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', () => { spawnFailed = true; });
    child.stdin.end(JSON.stringify({ confirmation: item.confirmation, arrivalDate: item.arrivalDate,
      ...(includeName ? { guestName: item.guestName } : {}) }));
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child, 'SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) stopChild(child, 'SIGKILL');
      }, 5_000);
      kill.unref();
    }, 180_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      if (interrupted || timedOut || spawnFailed) {
        resolveResult({ ok: false, confirmation: item.confirmation,
          error: interrupted ? 'RUN_INTERRUPTED' : timedOut ? 'RUN_TIMEOUT' : 'RUNNER_START_FAILED' });
        return;
      }
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          const guests = result.guestForms?.guests;
          if (result.ok === true && result.confirmation === item.confirmation && Array.isArray(guests) &&
              guests.length > 0 && guests.length === result.guestForms.grid?.rows?.length) {
            const complete = result.guestForms.grid?.coverage?.complete !== false &&
              guests.every((guest) => guest?.form && !guest.error);
            resolveResult(complete ? result : { ...result, ok: false, error: 'INCOMPLETE_GUEST_FORMS' });
            return;
          }
        } catch { /* Return an explicit invalid-output result below. */ }
        resolveResult({ ok: false, confirmation: item.confirmation, error: 'INVALID_OR_EMPTY_GUEST_FORMS' });
        return;
      }
      let failure = {};
      try { failure = JSON.parse(stderr); } catch { /* Keep the error generic. */ }
      resolveResult({ ...failure, ok: false, confirmation: item.confirmation,
        error: typeof failure?.error === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(failure.error)
          ? failure.error : 'PLAYWRIGHT_OPERATION_FAILED' });
    });
  });
}

async function work() {
  while (!interrupted) {
    const index = next++;
    if (index >= candidates.length) return;
    const item = candidates[index];
    let result = await attempt(item, false);
    if (!interrupted && result.error === 'AMBIGUOUS_CONFIRMATION' && item.guestName) {
      result = await attempt(item, true);
    }
    results[index] = result;
    completed += 1;
    if (result.ok === true) succeeded += 1;
    else failed += 1;
    save();
    if (completed % 5 === 0 || completed === candidates.length) {
      console.log(`Completed ${completed}/${candidates.length}: ${succeeded} succeeded, ${failed} failed`);
    }
  }
}

save();
await Promise.all(Array.from({ length: Math.min(workers, candidates.length) }, work));
save();
if (interrupted || failed) process.exitCode = 1;
