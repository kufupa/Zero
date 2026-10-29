#!/usr/bin/env node
// Read-only Stay 360 benchmark. Input and browser output remain private.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { withCenturionStay360Page } from '../centurion-stay360.mjs';
import { readConfirmationFromStay360 } from '../stay360-confirmation.mjs';
import { readRecordViewFromStay360 } from '../stay360-record-view.mjs';

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const mib = 1024 * 1024;
const safeErrors = new Set([
  'INVALID_ARGUMENTS', 'INPUT_PERMISSIONS_UNSAFE', 'INVALID_PRIVATE_INPUT',
  'CGROUP_V2_REQUIRED', 'BOUNDED_CGROUP_REQUIRED', 'IPC_UNAVAILABLE',
  'PARENT_DISCONNECTED', 'INVALID_LAUNCH_SIGNAL', 'HMS_CREDENTIALS_INVALID',
  'HMS_TARGET_MISMATCH', 'HMS_CREDENTIALS_UNAVAILABLE', 'PLAYWRIGHT_VERSION_MISMATCH',
  'AUTHENTICATED_SHELL_TIMEOUT', 'NOTE_PRIVATE_DIRECTORY_UNSAFE', 'AMBIGUOUS_SEARCH_WINDOW',
  'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_SEARCH_TIMEOUT', 'UNEXPECTED_DIALOG',
  'NOTE_CLOSE_NOT_UNIQUE', 'CONFIRMATION_DETAILS_NOT_LOADED', 'INVALID_CONFIRMATION',
  'CONFIRMATION_SEARCH_NOT_VISIBLE', 'CONFIRMATION_RUN_BUTTON_NOT_UNIQUE',
  'CONFIRMATION_NOT_FOUND', 'AMBIGUOUS_CONFIRMATION', 'CONFIRMATION_HEADER_MISMATCH',
  'STAY_BUTTON_NOT_UNIQUE', 'RECORD_FRAME_NOT_UNIQUE', 'RECORD_CONFIRMATION_NOT_UNIQUE',
  'RECORD_CONFIRMATION_MISMATCH', 'RECORD_VIEW_NOT_LOADED', 'RECORD_PANELS_NOT_EXPANDED',
  'RECORD_EXPAND_NOT_UNIQUE',
]);

function safeCode(error) {
  const message = String(error?.message || error).split('\n')[0];
  return safeErrors.has(message) ? message : 'PLAYWRIGHT_OPERATION_FAILED';
}

async function worker(mode) {
  const start = performance.now();
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const beforeLaunch = () => new Promise((resolve, reject) => {
      if (!process.send) return reject(new Error('IPC_UNAVAILABLE'));
      const disconnected = () => reject(new Error('PARENT_DISCONNECTED'));
      process.once('disconnect', disconnected);
      process.once('message', (message) => {
        process.removeListener('disconnect', disconnected);
        process.disconnect();
        if (message?.type === 'launch') resolve();
        else reject(new Error('INVALID_LAUNCH_SIGNAL'));
      });
      process.send({ type: 'ready' }, (error) => { if (error) reject(error); });
    });
    const { stay360, recordView } = await withCenturionStay360Page(async (page) => ({
      stay360: await readConfirmationFromStay360(page, input.confirmation),
      recordView: await readRecordViewFromStay360(page, input.confirmation),
    }), { headless: mode === 'headless', beforeLaunch });
    const fields = recordView.details.fields;
    const value = (name) => fields.find((field) => field.name === name)?.value ?? '';
    const number = (name) => {
      const text = String(value(name)).replace(/,/g, '').trim();
      return text ? Number(text) : NaN;
    };
    const norm = (item) => String(item).normalize('NFKD').replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const expectedGuest = norm(input.guest);
    const checkboxes = fields.filter((field) => ['checkbox', 'radio'].includes(field.type));
    const checks = {
      confirmation: stay360.details.confirmationInHeader === input.confirmation &&
        recordView.details.confirmationInRecord === input.confirmation,
      guest: Boolean(expectedGuest) && norm(value('firstname') + value('lastname')) === expectedGuest,
      arrival: String(value('arrivaldate')).toLowerCase() === String(input.arrival).toLowerCase(),
      departure: String(value('departuredate')).toLowerCase() === String(input.departure).toLowerCase(),
      adults: number('adults') === input.adults,
      averageRate: number('averagerate') === input.averageRate,
      totalRate: number('totalrate') === input.totalRate,
      checkboxes: checkboxes.length > 0 && checkboxes.every((field) => typeof field.value === 'boolean'),
    };
    const ok = Object.values(checks).every(Boolean);
    process.stdout.write(`${JSON.stringify({
      ok, checks, fieldCount: fields.length,
      notes: stay360.notes.length + recordView.notes.length,
      elapsedMs: Math.round(performance.now() - start),
    })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const message = String(error?.message || '').split('\n')[0];
    const action = message.match(/\b(?:locator|page|frame|elementHandle)\.[A-Za-z]+(?=:)/)?.[0] || null;
    const source = String(error?.stack || '').match(/(?:stay360-confirmation|stay360-record-view|centurion-stay360|session-reuse)\.mjs:\d+:\d+/)?.[0] || null;
    const cause = /timeout/i.test(message) ? 'timeout' :
      /target page, context or browser has been closed/i.test(message) ? 'browser_closed' :
        /execution context was destroyed/i.test(message) ? 'navigation' : null;
    process.stdout.write(`${JSON.stringify({
      ok: false, error: safeCode(error),
      phase: ['credentials', 'browser_launch', 'browser_context', 'login', 'stay_360', 'operation']
        .includes(error?.phase) ? error.phase : null,
      errorType: ['Error', 'TimeoutError', 'TypeError'].includes(error?.name) ? error.name : null,
      action, source, cause, elapsedMs: Math.round(performance.now() - start),
    })}\n`);
    process.exitCode = 1;
  }
}

function parseArgs() {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node stay360-benchmark.mjs --input PRIVATE.json --mode headless|headed --count N [--delay-ms 200]\n');
    process.exit(0);
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--mode', '--count', '--delay-ms'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new Error('INVALID_ARGUMENTS');
    }
    options[args[i]] = args[i + 1];
  }
  const count = Number(options['--count']);
  const delayMs = Number(options['--delay-ms'] ?? 200);
  if (!options['--input'] || !['headless', 'headed'].includes(options['--mode']) ||
      !Number.isInteger(count) || count < 1 || count > 100 ||
      !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error('INVALID_ARGUMENTS');
  const stat = statSync(options['--input']);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('INPUT_PERMISSIONS_UNSAFE');
  const input = JSON.parse(readFileSync(options['--input'], 'utf8'));
  if (!Array.isArray(input) || !input.length || input.some((item) =>
    !item || !['confirmation', 'guest', 'arrival', 'departure'].every((key) =>
      typeof item[key] === 'string' && item[key].trim()) ||
    !['adults', 'averageRate', 'totalRate'].every((key) => Number.isFinite(item[key])))) {
    throw new Error('INVALID_PRIVATE_INPUT');
  }
  return { input, mode: options['--mode'], count, delayMs };
}

function readCgroup() {
  const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((item) => item.startsWith('0::'));
  if (!line) throw new Error('CGROUP_V2_REQUIRED');
  const dir = `/sys/fs/cgroup${line.slice(3)}`;
  const read = (name) => readFileSync(`${dir}/${name}`, 'utf8').trim();
  const limit = Number(read('memory.max'));
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('BOUNDED_CGROUP_REQUIRED');
  return { dir, read, limit };
}

function cpuUsage(read) {
  const match = read('cpu.stat').match(/^usage_usec (\d+)$/m);
  return match ? Number(match[1]) : 0;
}

function ioTotals(read) {
  return read('io.stat').split('\n').reduce((sum, line) => {
    for (const match of line.matchAll(/\b(rbytes|wbytes)=(\d+)/g)) sum[match[1]] += Number(match[2]);
    return sum;
  }, { rbytes: 0, wbytes: 0 });
}

function availableMemory() {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : 0;
}

function countBrowsers(read, starts, children) {
  let count = 0;
  const workerPids = new Set([...children].map((child) => child.pid));
  for (const pid of read('cgroup.procs').split('\n')) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (/^(chrome|chromium|chromium-browser|chrome-headless-shell|headless_shell)$/.test(basename(cmd[0])) &&
          !cmd.some((arg) => arg.startsWith('--type='))) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (!workerPids.has(Number(fields[1]))) continue;
        count += 1;
        if (!starts.has(pid)) starts.set(pid, Number(fields[19]));
      }
    } catch { /* Process may have exited between samples. */ }
  }
  return count;
}

async function benchmark() {
  const { input, mode, count, delayMs } = parseArgs();
  const group = readCgroup();
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const initialCpu = cpuUsage(group.read);
  const initialIo = ioTotals(group.read);
  const started = performance.now();
  let lastSample = started;
  let lastCpu = initialCpu;
  let peakCpuCores = 0;
  let peakMemory = Number(group.read('memory.current'));
  let minHostAvailable = availableMemory();
  let peakBrowsers = 0;
  let aborted = null;
  const browserStarts = new Map();
  const children = new Set();
  const jobs = [];

  const stop = (reason) => {
    if (aborted) return;
    aborted = reason;
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGINT', () => stop('INTERRUPTED'));
  process.on('SIGTERM', () => stop('INTERRUPTED'));
  const sample = () => {
    const now = performance.now();
    const used = cpuUsage(group.read);
    if (now > lastSample) peakCpuCores = Math.max(peakCpuCores, (used - lastCpu) / 1000 / (now - lastSample));
    lastCpu = used;
    lastSample = now;
    const memory = Number(group.read('memory.current'));
    const available = availableMemory();
    peakMemory = Math.max(peakMemory, memory);
    minHostAvailable = Math.min(minHostAvailable, available);
    peakBrowsers = Math.max(peakBrowsers, countBrowsers(group.read, browserStarts, children));
    if (children.size && (memory >= group.limit * 0.85 || available < 4 * 1024 * mib)) stop('MEMORY_GUARD');
  };
  const sampler = setInterval(sample, 200);

  const run = (entry, index) => {
    const child = spawn(process.execPath, [script, '--worker', mode], { stdio: ['pipe', 'pipe', 'ignore', 'ipc'] });
    children.add(child);
    let resolveReady;
    let resolveFinished;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    let readyReported = false;
    const reportReady = (value) => {
      if (!readyReported) { readyReported = true; resolveReady(value); }
    };
    child.once('message', (message) => reportReady(message?.type === 'ready'));
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (output.length < 10_000) output += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(entry));
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      reportReady(false);
      children.delete(child);
      let result;
      try { result = JSON.parse(output); } catch { result = { ok: false, error: 'WORKER_NO_RESULT' }; }
      resolveFinished({ ...result, ok: code === 0 && result.ok === true, index: index + 1 });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
    return { child, ready, finished };
  };

  for (let i = 0; i < count && !aborted; i += 1) {
    jobs.push(run(input[i % input.length], i));
    if (i + 1 < count) await sleep(100);
  }
  const readiness = await Promise.all(jobs.map((job) => job.ready));
  const preparationMs = Math.round(performance.now() - started);
  let firstGrant;
  let lastGrant;
  for (let i = 0; i < jobs.length && !aborted; i += 1) {
    if (!readiness[i] || !jobs[i].child.connected) continue;
    const grant = performance.now();
    firstGrant ??= grant;
    lastGrant = grant;
    jobs[i].child.send({ type: 'launch' }, (error) => { if (error) jobs[i].child.kill('SIGTERM'); });
    if (i + 1 < jobs.length) await sleep(delayMs);
  }
  const results = await Promise.all(jobs.map((job) => job.finished));
  clearInterval(sampler);
  sample();
  const elapsedMs = Math.round(performance.now() - started);
  const cpuSeconds = (cpuUsage(group.read) - initialCpu) / 1_000_000;
  const io = ioTotals(group.read);
  const successful = results.filter((result) => result.ok);
  const latencies = successful.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const starts = [...browserStarts.values()].sort((a, b) => a - b);
  const intervals = starts.slice(1).map((start, i) => Math.round((start - starts[i]) * 1000 / clockTicks)).sort((a, b) => a - b);
  const summary = {
    mode, inputCount: input.length, requested: count, launched: jobs.length,
    succeeded: successful.length, failed: results.length - successful.length, aborted,
    failures: results.filter((result) => !result.ok).map(({ index, error, phase, checks, errorType, action, source, cause, elapsedMs }) => ({ index, error, phase, checks, errorType, action, source, cause, elapsedMs })),
    fieldCounts: [...new Set(successful.map((result) => result.fieldCount))],
    noteCount: results.reduce((sum, result) => sum + (result.notes || 0), 0),
    peakBrowsers, observedBrowserStarts: starts.length, delayMs, elapsedMs, preparationMs,
    launchGrantSpreadMs: firstGrant === undefined ? null : Math.round(lastGrant - firstGrant),
    browserStartIntervalsMs: intervals.length ? {
      min: intervals[0], median: intervals[Math.floor(intervals.length / 2)], max: intervals.at(-1),
    } : null,
    medianLookupMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    p95LookupMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    cpuSeconds: Number(cpuSeconds.toFixed(2)),
    averageCpuCores: Number((cpuSeconds / (elapsedMs / 1000)).toFixed(2)),
    peakCpuCores: Number(peakCpuCores.toFixed(2)),
    peakMemoryMiB: Math.round(Math.max(peakMemory, Number(group.read('memory.peak'))) / mib),
    memoryLimitMiB: Math.round(group.limit / mib),
    minHostAvailableMiB: Math.round(minHostAvailable / mib),
    readMiB: Number(((io.rbytes - initialIo.rbytes) / mib).toFixed(2)),
    writeMiB: Number(((io.wbytes - initialIo.wbytes) / mib).toFixed(2)),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (aborted || successful.length !== count) process.exitCode = 1;
}

if (args[0] === '--worker') await worker(args[1]);
else {
  try { await benchmark(); }
  catch (error) { process.stderr.write(`${safeCode(error)}\n`); process.exitCode = 1; }
}
