import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteTraceAsyncEnabled, provisionalQuoteCapture } from './fetch-quote.mjs';

const GRID_SHOTS = [{ path: 'screenshots/group-1-criteria-applied.png' }, { path: 'screenshots/group-1-availability-results.png' }];

function recordingAudit(screenshots = GRID_SHOTS) {
  const calls = { snapshot: 0, finish: 0 };
  return {
    calls,
    snapshot() {
      calls.snapshot += 1;
      return { status: 'pending', trace: { status: 'pending' }, screenshots };
    },
    finish() {
      calls.finish += 1;
      throw new Error('finish must not run before the provisional capture is handed over');
    },
  };
}

const quoteResult = { outcome: 'quote', groups: [{ id: 'group-1' }], issues: [], screenshots: [] };

test('the trace-async flag is enabled only by the exact value on', () => {
  assert.equal(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: 'on' }), true);
  for (const value of [undefined, '', '1', 'true', 'ON', ' on', 'on ', 'off'])
    assert.equal(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: value }), false, `value ${JSON.stringify(value)}`);
  assert.equal(quoteTraceAsyncEnabled({}), false);
});

test('a quote becomes a provisional capture with a pending trace and never finishes the audit', () => {
  const audit = recordingAudit();
  const provisional = provisionalQuoteCapture({
    result: quoteResult,
    audit,
    directory: '/private/run',
    started: 1000,
    now: 61000,
  });
  assert.equal(provisional.outcome, 'quote');
  assert.equal(provisional.audit.status, 'pending');
  assert.equal(provisional.audit.trace.status, 'pending');
  assert.equal(provisional.evidenceDirectory, '/private/run');
  assert.equal(provisional.elapsedMs, 60000);
  assert.deepEqual(provisional.screenshots, ['screenshots/group-1-criteria-applied.png', 'screenshots/group-1-availability-results.png']);
  assert.deepEqual(audit.calls, { snapshot: 1, finish: 0 });
});

test('a quote missing its grid screenshots is not provisional, so the sequential path decides it', () => {
  const audit = recordingAudit([GRID_SHOTS[0]]);
  assert.equal(
    provisionalQuoteCapture({ result: quoteResult, audit, directory: '/private/run', started: 0, now: 1 }),
    null,
  );
});

test('only quote outcomes are provisional; other outcomes keep the sequential trace finish', () => {
  for (const outcome of ['partial', 'no_match', 'unavailable', 'execution_failure']) {
    const audit = recordingAudit();
    assert.equal(
      provisionalQuoteCapture({ result: { ...quoteResult, outcome }, audit, directory: '/d', started: 0, now: 1 }),
      null,
      outcome,
    );
    assert.deepEqual(audit.calls, { snapshot: 0, finish: 0 }, outcome);
  }
});
