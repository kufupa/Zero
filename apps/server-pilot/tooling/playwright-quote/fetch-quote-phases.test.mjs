// U9 phase timings. Browser-free: a fake clock and runs that stop before CDP attach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as quote from './fetch-quote.mjs';
import { createAudit } from './audit.mjs';

const { QUOTE_PHASES, createPhaseClock, fetchQuote } = quote;
// Every phase except traceFinish needs a browser or a secret, so it stays at zero in these runs.
const NOT_RUN = QUOTE_PHASES.filter((name) => name !== 'traceFinish');

const readEvents = async (directory) =>
  (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

test('a phase clock reports every phase, each at zero until something is timed', () => {
  assert.deepEqual(createPhaseClock().ms, Object.fromEntries(QUOTE_PHASES.map((name) => [name, 0])));
});

test('a timed span adds to its own phase, and a span that throws still counts', async () => {
  let now = 0;
  const clock = createPhaseClock(() => now);
  assert.equal(await clock.time('login', async () => { now += 7; return 'ok'; }), 'ok');
  await clock.time('login', async () => { now += 3; });
  await assert.rejects(
    clock.time('grid', async () => { now += 4; throw new Error('grid_failed'); }),
    /grid_failed/,
  );
  assert.equal(clock.ms.login, 10);
  assert.equal(clock.ms.grid, 4);
  assert.equal(clock.ms.nav, 0);
});

test('audit events take optional fields, and the fixed keys cannot be overwritten', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'u9-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = await createAudit(directory, { trace: false });
  const entry = audit.event('phase_timings', { phaseMs: { grid: 12 }, phase: 'spoofed', sequence: 99 });
  assert.equal(entry.phase, 'phase_timings');
  assert.equal(entry.sequence, 2);
  assert.deepEqual(entry.phaseMs, { grid: 12 });
  assert.deepEqual((await readEvents(directory)).at(-1), entry);
});

test('an invalid request writes every phase to result.json and a matching phase_timings event', async (t) => {
  const result = await fetchQuote({ requestPath: new URL('./examples/missing-age.json', import.meta.url), env: {} });
  t.after(() => rm(result.evidenceDirectory, { recursive: true, force: true }));
  assert.equal(result.outcome, 'input_gap');
  assert.deepEqual(Object.keys(result.phaseMs).sort(), [...QUOTE_PHASES].sort());
  for (const name of NOT_RUN) assert.equal(result.phaseMs[name], 0, name);
  const saved = JSON.parse(await readFile(join(result.evidenceDirectory, 'result.json'), 'utf8'));
  assert.deepEqual(saved.phaseMs, result.phaseMs);
  const events = await readEvents(result.evidenceDirectory);
  const timings = events.findIndex((event) => event.phase === 'phase_timings');
  assert.deepEqual(events[timings].phaseMs, result.phaseMs);
  assert.ok(timings < events.findIndex((event) => event.phase === 'run_finished'));
});

test('a run that fails before the browser starts still reports every phase, with the untouched ones at zero', async (t) => {
  const result = await fetchQuote({
    requestPath: new URL('./examples/adult.json', import.meta.url),
    env: { HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'owned' },
  });
  t.after(() => rm(result.evidenceDirectory, { recursive: true, force: true }));
  assert.equal(result.outcome, 'execution_failure');
  assert.equal(result.phase, 'configuration');
  assert.deepEqual(Object.keys(result.phaseMs).sort(), [...QUOTE_PHASES].sort());
  for (const name of NOT_RUN) assert.equal(result.phaseMs[name], 0, name);
});
