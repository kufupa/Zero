#!/usr/bin/env node
// Private, resumable census using the existing exact-confirmation/Add-On readers.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname as parentOf, join, resolve } from 'node:path';
import { withCenturionStay360Page } from '../../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../../playwright-quote/hms-read-only-guard.mjs';
import { readConfirmationFromStay360 } from '../stay360-confirmation.mjs';
import { readStay360AddOns } from '../stay360-addons.mjs';
import { lookupFailure } from '../stay360-lookup-cli.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: node batch-read-addons.mjs INPUT.json PRIVATE_OUTPUT_DIR WORKERS [--identity-source SOURCE.json]');
  console.log('WORKERS: 1 or 2. Resumes the same input hash; every stay owns a fresh guarded browser.');
  process.exit(0);
}
if (process.argv.length !== 5 && !(process.argv.length === 7 && process.argv[5] === '--identity-source')) {
  throw new Error('EXPECTED_INPUT_OUTPUT_WORKERS');
}
process.umask(0o077);
const input = resolve(process.argv[2]), output = resolve(process.argv[3]), workers = Number(process.argv[4]);
if (![1, 2].includes(workers)) throw new Error('INVALID_WORKER_COUNT');
if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
const directory = lstatSync(output);
if (!directory.isDirectory() || directory.uid !== process.getuid() || directory.mode & 0o077) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');
for (let current = output; ; current = parentOf(current)) {
  if (existsSync(join(current, '.git'))) throw new Error('OUTPUT_IN_GIT');
  if (parentOf(current) === current) break;
}
const bytes = readFileSync(input), inputSha256 = createHash('sha256').update(bytes).digest('hex');
const toolHashes = Object.fromEntries([
  ['batch', import.meta.url], ['addOns', new URL('../stay360-addons.mjs', import.meta.url)],
  ['lookup', new URL('../stay360-confirmation.mjs', import.meta.url)],
].map(([name, path]) => [name, createHash('sha256').update(readFileSync(new URL(path))).digest('hex')]));
const data = JSON.parse(bytes), candidates = data.candidates;
if (data.propertyCode !== 'HRCEN' || !/^[a-f0-9]{64}$/.test(data.sourceSha256 || '') ||
    !Array.isArray(candidates) || !candidates.length || candidates.some(row =>
      !/^\d+-\d+$/.test(row?.confirmation || '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.arrivalDate || '')) ||
    new Set(candidates.map(row => row.confirmation)).size !== candidates.length) throw new Error('INVALID_CANDIDATES');

// Optional original HMS snapshots improve ambiguous PDF-name hints without
// changing the frozen input or weakening the existing exact-match reader.
const historicalNames = new Map();
if (process.argv[6]) {
  const sourceBytes = readFileSync(resolve(process.argv[6]));
  if (createHash('sha256').update(sourceBytes).digest('hex') !== data.sourceSha256) throw new Error('IDENTITY_SOURCE_HASH_MISMATCH');
  const source = JSON.parse(sourceBytes);
  for (const candidate of candidates) {
    const row = source.results?.[candidate.sourceIndex];
    if (!candidate.historicalVerified) continue;
    if (!row?.ok || row.confirmation !== candidate.confirmation || row.stay360?.confirmation !== candidate.confirmation ||
        row.recordView?.details?.confirmationInRecord !== candidate.confirmation) throw new Error('IDENTITY_SOURCE_TARGET_MISMATCH');
    const names = (row.stay360.details?.cards || []).filter(card => card.title === 'Guest')
      .flatMap(card => card.fields || []).filter(field => field.name === 'guestfullname');
    if (names.length === 1 && typeof names[0].value === 'string' && names[0].value.trim()) {
      historicalNames.set(candidate.confirmation, names[0].value.trim());
    }
  }
}

const lock = join(output, 'scan.lock');
if (existsSync(lock)) {
  const previous = JSON.parse(readFileSync(lock, 'utf8'));
  let running = true;
  try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
  if (previous.host !== hostname() || running) throw new Error('SCAN_ALREADY_OWNED');
  renameSync(lock, lock + '.stale-' + Date.now());
}
publishSnapshot(lock, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
const progressPath = join(output, 'progress.json');
let report = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : {
  input, inputSha256, sourceSha256: data.sourceSha256, propertyCode: 'HRCEN',
  startedAt: new Date().toISOString(), total: candidates.length, workers, results: {},
};
if (report.inputSha256 !== inputSha256 || report.sourceSha256 !== data.sourceSha256 || report.total !== candidates.length) {
  unlinkSync(lock); throw new Error('RESUME_INPUT_CHANGED');
}
report.workers = workers;
report.blocked = null;
// Recover a snapshot committed just before an interrupted progress checkpoint.
for (const candidate of candidates) {
  const directory = join(output, 'records', candidate.confirmation);
  if (!existsSync(directory)) continue;
  const files = readdirSync(directory).filter(name => /^attempt-[1-3]\.json$/.test(name)).sort();
  if (!files.length) continue;
  const attempts = [];
  let latest;
  for (const [index, name] of files.entries()) {
    latest = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (latest.inputSha256 !== inputSha256 || latest.sourceSha256 !== data.sourceSha256 ||
        latest.confirmation !== candidate.confirmation || latest.attempt !== index + 1) throw new Error('RESUME_ARTIFACT_MISMATCH');
    attempts.push({ artifact: 'records/' + candidate.confirmation + '/' + name, ok: latest.ok,
      completeRead: latest.completeRead, issue: latest.issue, observedAt: latest.observedAt,
      elapsedMs: latest.elapsedMs, sessionVerified: latest.sessionVerified });
  }
  report.results[candidate.confirmation] = { confirmation: candidate.confirmation, attempts,
    ok: latest.ok, completeRead: latest.completeRead, rowCount: latest.addOns?.rows?.length ?? null,
    issue: latest.issue, selectedArtifact: attempts.at(-1).artifact };
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const browserHold = result => result.issue?.startsWith('HMS_BROWSER_HOLD');
const transient = result => !browserHold(result) && (['TimeoutError', 'HMS_BROWSER_LAUNCH_FAILED', 'HMS_SESSION_UNAVAILABLE',
  'PLAYWRIGHT_OPERATION_FAILED', 'ADDONS_RESPONSE_UNVERIFIED', 'ADDONS_RESPONSE_BODY_TIMEOUT',
  'ADDONS_ACTION_FAILED', 'HMS_OPERATION_ABORTED', 'HMS_BROWSER_CLOSE_UNCONFIRMED'].includes(result.issue) ||
  ['credentials', 'browser_launch', 'browser_context', 'login'].includes(result.phase));

// A hard link publishes only complete bytes and refuses an existing final path.
// Interrupted temporary files never match the recovery reader's attempt names.
function publishSnapshot(path, value) {
  const temporary = path + '.partial-' + randomUUID();
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, path); }
  finally { unlinkSync(temporary); }
}

function atomic(path, value) {
  const temporary = path + '.partial';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
function counts() {
  const rows = Object.values(report.results);
  return { attempted: rows.length, total: candidates.length,
    completeReads: rows.filter(row => row.completeRead).length,
    partialReads: rows.filter(row => row.ok && !row.completeRead).length,
    failedReads: rows.filter(row => !row.ok).length,
    populated: rows.filter(row => row.ok && row.rowCount > 0).length };
}
function checkpoint() {
  report.updatedAt = new Date().toISOString();
  report.counts = counts();
  atomic(progressPath, report);
}

function nativeArrivalHint(result) {
  const failure = result?.lookupFailure;
  const choices = failure?.candidates;
  return ['CONFIRMATION_HINT_MISMATCH', 'CONFIRMATION_HINT_UNVERIFIED'].includes(result?.issue) &&
    failure.searchResults?.complete === true && choices?.length === 1 &&
    /^\d{4}-\d{2}-\d{2}$/.test(choices[0].arrivalDate || '') ? choices[0].arrivalDate : null;
}

function historicalRefinement(candidate, result) {
  const name = historicalNames.get(candidate.confirmation), failure = result?.lookupFailure;
  if (!name || !['AMBIGUOUS_CONFIRMATION', 'CONFIRMATION_HINT_MISMATCH', 'CONFIRMATION_HINT_UNVERIFIED'].includes(result?.issue) ||
      failure?.searchResults?.complete !== true) return null;
  const cleanName = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const matches = failure.candidates?.filter(row => cleanName(row.guestName) === cleanName(name));
  if (matches?.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(matches[0].arrivalDate || '')) return null;
  const hints = { guestName: name, arrivalDate: matches[0].arrivalDate };
  return result.lookupHints?.guestName === name && result.lookupHints?.arrivalDate === hints.arrivalDate ? null : hints;
}

async function readOne(candidate, attempt, lookupHints, lookupHintSource) {
  const startedAt = new Date().toISOString(), started = Date.now(), writes = [];
  let lookup = null, addOns = null;
  try {
    const observed = await withCenturionStay360Page(async page => {
      page.on('request', request => {
        const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
        const intents = [body.get('pageaction'), url.searchParams.get('pageaction'), body.get('action'), url.searchParams.get('action')];
        if (url.pathname.startsWith('/web/base/') && intents.some(value => /SAVE|UPDATE|DELETE|REMOVE/i.test(value || ''))) {
          writes.push({ endpoint: url.pathname, method: request.method() });
        }
      });
      lookup = await readConfirmationFromStay360(page, candidate.confirmation, lookupHints);
      addOns = await readStay360AddOns(page, candidate.confirmation, { detailIds: candidate.detailIds ?? [] });
      if (writes.length) throw new Error('UNEXPECTED_NATIVE_WRITE_REQUEST');
      return { lookup, addOns };
    }, { headless: true, blockServiceWorkers: true,
      prepareContext: context => installReadOnlyGuard(context),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
    return { confirmation: candidate.confirmation, attempt, startedAt, observedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started, sessionVerified: true, ok: observed.addOns.outcome === 'ok',
      completeRead: observed.addOns.outcome === 'ok' && observed.addOns.coverage?.complete === true,
      issue: observed.addOns.issue ?? null, lookupHints, lookupHintSource, lookup: observed.lookup, addOns: observed.addOns, writes };
  } catch (error) {
    const failure = lookupFailure(error, started);
    return { confirmation: candidate.confirmation, attempt, startedAt, observedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started, sessionVerified: false, ok: false, completeRead: false,
      issue: failure.error, phase: failure.phase, lookupHints, lookupHintSource, lookupFailure: failure, lookup, addOns, writes };
  }
}

let next = 0;
async function worker() {
  while (next < candidates.length && !controller.signal.aborted) {
    const candidate = candidates[next++], previous = report.results[candidate.confirmation];
    if (previous?.ok || previous?.attempts.length >= 3) continue;
    if (previous?.attempts.length) {
      const latest = JSON.parse(readFileSync(join(output, previous.attempts.at(-1).artifact), 'utf8'));
      if (!transient(latest) && !nativeArrivalHint(latest) && !historicalRefinement(candidate, latest) &&
          !(latest.issue === 'AMBIGUOUS_CONFIRMATION' && !latest.lookupHints?.guestName && candidate.guestName)) continue;
    }
    const recordDir = join(output, 'records', candidate.confirmation);
    mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    const attempts = previous?.attempts || [];
    while (attempts.length < 3 && !controller.signal.aborted) {
      const attempt = attempts.length + 1;
      const useNameHint = attempts.at(-1)?.issue === 'AMBIGUOUS_CONFIRMATION' && Boolean(candidate.guestName);
      const previousRaw = attempts.length ? JSON.parse(readFileSync(join(output, attempts.at(-1).artifact), 'utf8')) : null;
      const observedArrival = nativeArrivalHint(previousRaw);
      const historicalHints = historicalRefinement(candidate, previousRaw);
      const lookupHints = historicalHints || { ...(previousRaw?.lookupHints || { arrivalDate: candidate.arrivalDate }),
        ...(observedArrival ? { arrivalDate: observedArrival } : {}),
        ...(useNameHint ? { guestName: candidate.guestName } : {}) };
      const lookupHintSource = historicalHints ? 'verified_historical_hms_name_and_current_native_date' :
        observedArrival ? 'current_native_date' : useNameHint ? 'input_name_and_date' : previousRaw?.lookupHintSource || 'input_date';
      const result = await readOne(candidate, attempt, lookupHints, lookupHintSource);
      if (browserHold(result)) {
        // No browser could launch: retain the blocker without spending a read attempt.
        const artifact = 'browser-block-' + randomUUID() + '.json';
        publishSnapshot(join(output, artifact), { inputSha256, sourceSha256: data.sourceSha256, toolHashes, candidate, ...result });
        report.blocked = { issue: result.issue, confirmation: candidate.confirmation, artifact };
        controller.abort();
        checkpoint();
        break;
      }
      const artifact = 'records/' + candidate.confirmation + '/attempt-' + attempt + '.json';
      publishSnapshot(join(output, artifact), { inputSha256, sourceSha256: data.sourceSha256,
        toolHashes, candidate, ...result });
      attempts.push({ artifact, ok: result.ok, completeRead: result.completeRead, issue: result.issue,
        observedAt: result.observedAt, elapsedMs: result.elapsedMs, sessionVerified: result.sessionVerified });
      report.results[candidate.confirmation] = { confirmation: candidate.confirmation, attempts,
        ok: result.ok, completeRead: result.completeRead, rowCount: result.addOns?.rows?.length ?? null,
        issue: result.issue, selectedArtifact: artifact };
      if (result.issue === 'HMS_BROWSER_CLOSE_UNCONFIRMED') {
        report.blocked = { issue: result.issue, confirmation: candidate.confirmation, artifact };
        controller.abort();
      }
      checkpoint();
      console.log(JSON.stringify({ ...counts(), lastOutcome: result.ok ? 'read' : result.issue,
        lastElapsedMs: result.elapsedMs }));
      const canRefineName = result.issue === 'AMBIGUOUS_CONFIRMATION' && !lookupHints.guestName && Boolean(candidate.guestName);
      const canRefineArrival = nativeArrivalHint(result) && nativeArrivalHint(result) !== lookupHints.arrivalDate;
      if (result.ok || (!transient(result) && !canRefineName && !canRefineArrival && !historicalRefinement(candidate, result))) break;
    }
  }
}

try {
  checkpoint();
  const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker().catch(error => {
    controller.abort(); throw error;
  })));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  report.scanFinished = counts().attempted === candidates.length && !controller.signal.aborted;
  report.endedAt = new Date().toISOString();
  checkpoint();
  const results = candidates.map(candidate => {
    const current = report.results[candidate.confirmation];
    return { candidate, summary: current ?? { outcome: 'not_attempted' },
      attempts: (current?.attempts || []).map(item => JSON.parse(readFileSync(join(output, item.artifact), 'utf8'))) };
  });
  atomic(join(output, 'reads.json'), { ...report, results });
  console.log(JSON.stringify({ scanFinished: report.scanFinished, ...counts() }));
  if (!report.scanFinished) process.exitCode = 1;
} finally {
  unlinkSync(lock);
}
