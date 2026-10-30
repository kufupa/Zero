#!/usr/bin/env node
// Run the existing read-only 1a -> 1b -> 1c CLI for each PDF candidate.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [inputArg, outputArg, workersArg] = process.argv.slice(2);
const workers = Number(workersArg);
if (process.argv.length !== 5 || !Number.isInteger(workers) || workers < 1) {
  console.error('Usage: node batch-read-guest-details.mjs INPUT.md OUTPUT.json WORKERS');
  process.exit(2);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const runner = fileURLToPath(new URL('../../playwright-quote/read-guest-details-ui.mjs', import.meta.url));
const markdown = readFileSync(input, 'utf8');
const heading = '## Distinct exact ID candidates';
const start = markdown.indexOf(heading);
if (start < 0) throw new Error('CANDIDATE_TABLE_NOT_FOUND');
const end = markdown.indexOf('\n## ', start + heading.length);
const table = markdown.slice(start + heading.length, end < 0 ? undefined : end);
const rows = table.split(/\r?\n/).filter((line) => line.trimStart().startsWith('|'));
const confirmations = rows.slice(2).map((row) => row.split('|')[1].trim().replace(/^`|`$/g, ''));
if (!confirmations.length || confirmations.some((value) => !/^\d{7,}-\d+$/.test(value)) ||
    new Set(confirmations).size !== confirmations.length) {
  throw new Error('INVALID_CANDIDATE_TABLE');
}
const hintFile = process.env.STAY360_DATE_HINTS_FILE;
const hints = hintFile ? new Map(JSON.parse(readFileSync(hintFile, 'utf8')).candidates
  .map((item) => [item.confirmation, { arrivalDate: item.arrivalDateHint, guestName: item.guestNameHint }])) : null;
if (hints && confirmations.some((confirmation) => {
  const arrivalDate = hints.get(confirmation)?.arrivalDate;
  return arrivalDate != null && arrivalDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(arrivalDate);
})) {
  throw new Error('INVALID_ARRIVAL_DATE_HINTS');
}
if ((statSync(dirname(output)).mode & 0o077) !== 0) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');

process.umask(0o077);
closeSync(openSync(output, 'wx', 0o600));
const startedAt = new Date().toISOString();
const results = confirmations.map((confirmation) => ({ confirmation, ok: null }));
let completed = 0;
let succeeded = 0;
let failed = 0;
let next = 0;
let interrupted = false;
const active = new Set();

function save() {
  const partial = `${output}.partial`;
  writeFileSync(partial, JSON.stringify({
    source: input,
    sourceType: 'unverified confirmation candidates extracted from PDFs',
    startedAt,
    updatedAt: new Date().toISOString(),
    concurrency: workers,
    total: confirmations.length,
    completed,
    succeeded,
    failed,
    results,
  }, null, 2), { flag: 'wx', mode: 0o600 });
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

async function runOne(confirmation) {
  const hint = hints?.get(confirmation) ?? {};
  // PDF extraction can leave partial names. Use one only when the search needs it.
  const first = await runAttempt(confirmation, { arrivalDate: hint.arrivalDate });
  if (interrupted || first.error !== 'AMBIGUOUS_CONFIRMATION' ||
      typeof hint.guestName !== 'string' || !hint.guestName.trim()) return first;
  const retry = await runAttempt(confirmation, hint);
  return {
    ...retry,
    elapsedMs: first.elapsedMs + retry.elapsedMs,
    previousAttempts: [{ source: 'initial lookup', ok: false, phase: first.phase,
      error: first.error, elapsedMs: first.elapsedMs }],
  };
}

function runAttempt(confirmation, options) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(process.execPath, [runner, '--json-stdin'], {
      cwd: root,
      env: { ...process.env, STAY360_PRIVATE_ROOT: dirname(output) },
      detached: true,
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
    child.stdin.end(JSON.stringify({ confirmation, ...options }));
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild(child, 'SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) stopChild(child, 'SIGKILL');
      }, 5_000);
      kill.unref();
    }, 180_000);
    child.once('close', (code) => {
      clearTimeout(timeout);
      active.delete(child);
      const elapsedMs = Date.now() - started;
      if (interrupted || timedOut || spawnFailed) {
        resolveResult({ ok: false, confirmation, error: interrupted ? 'RUN_INTERRUPTED' : timedOut ? 'RUN_TIMEOUT' : 'RUNNER_START_FAILED', elapsedMs });
        return;
      }
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          if (result.ok === true && result.confirmation === confirmation && result.stay360 && result.recordView &&
              result.guestDetails?.details?.activeTab === 'Guest Details') {
            resolveResult(result);
            return;
          }
        } catch { /* Report invalid output below. */ }
        resolveResult({ ok: false, confirmation, error: 'INVALID_RUNNER_OUTPUT', elapsedMs });
        return;
      }
      let failure = {};
      try {
        const parsed = JSON.parse(stderr);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) failure = parsed;
      } catch { /* Keep the error generic. */ }
      const error = typeof failure.error === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(failure.error)
        ? failure.error : 'PLAYWRIGHT_OPERATION_FAILED';
      const phase = typeof failure.phase === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(failure.phase)
        ? failure.phase : 'unknown';
      resolveResult({ ok: false, confirmation, phase, error, elapsedMs,
        ...(Array.isArray(failure.candidates) ? { candidates: failure.candidates } : {}),
        ...(Object.hasOwn(failure, 'searchedDateRange') ? { searchedDateRange: failure.searchedDateRange } : {}),
        ...(failure.searchResults ? { searchResults: failure.searchResults } : {}),
      });
    });
  });
}

async function work() {
  while (!interrupted) {
    const index = next++;
    if (index >= confirmations.length) return;
    results[index] = await runOne(confirmations[index]);
    completed += 1;
    if (results[index].ok) succeeded += 1;
    else failed += 1;
    save();
    if (completed % 6 === 0 || completed === confirmations.length) {
      console.log(`Completed ${completed}/${confirmations.length}: ${succeeded} succeeded, ${failed} failed`);
    }
  }
}

save();
await Promise.all(Array.from({ length: Math.min(workers, confirmations.length) }, work));
save();
if (interrupted || failed) process.exitCode = 1;
