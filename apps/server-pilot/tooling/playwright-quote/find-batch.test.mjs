import test from 'node:test';
import assert from 'node:assert/strict';
import { installReadOnlyGuard, shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';
import {
  completedConfirmations, parseFindBatchArgs, parseFindBatchInput, remainingConfirmations,
  historySweepStarts,
} from './find-batch-rules.mjs';

test('find batch arguments default to a 1500ms pause and accept the resumable/history switches', () => {
  assert.deepEqual(parseFindBatchArgs(['--input', 'confs.json', '--out', 'out.jsonl']), {
    ok: true,
    args: { input: 'confs.json', out: 'out.jsonl', cap: null, pauseMs: 1500, includeHistory: false },
  });
  assert.deepEqual(parseFindBatchArgs([
    '--input', 'confs.json', '--out', 'out.jsonl', '--cap', '3', '--pause-ms', '0', '--include-history',
  ]), {
    ok: true,
    args: { input: 'confs.json', out: 'out.jsonl', cap: 3, pauseMs: 0, includeHistory: true },
  });
});

test('find batch arguments reject missing, repeated, malformed and unknown flags', () => {
  assert.equal(parseFindBatchArgs([]).ok, false);
  assert.equal(parseFindBatchArgs(['--input', '--out', 'out.jsonl']).ok, false);
  assert.equal(parseFindBatchArgs(['--input', 'in.json', '--out', 'out.jsonl', '--cap', '0']).ok, false);
  assert.equal(parseFindBatchArgs(['--input', 'in.json', '--out', 'out.jsonl', '--pause-ms', '-1']).ok, false);
  assert.equal(parseFindBatchArgs(['--input', 'a', '--input', 'b', '--out', 'out']).ok, false);
  assert.equal(parseFindBatchArgs(['--input', 'in', '--out', 'out', '--unknown', 'x']).ok, false);
});

test('batch input accepts exact HMS confirmations, preserves the -1 suffix, deduplicates and caps', () => {
  assert.deepEqual(parseFindBatchInput(JSON.stringify([
    ' 82696537-1 ', '82696537-1', '57291630-2', '57291630-1',
  ]), 2), ['82696537-1', '57291630-2']);
  assert.throws(() => parseFindBatchInput('{bad json'), /JSON/);
  assert.throws(() => parseFindBatchInput(JSON.stringify(['82696537'])), /confirmation/);
  assert.throws(() => parseFindBatchInput(JSON.stringify(['1-2'])), /confirmation/);
  assert.throws(() => parseFindBatchInput(JSON.stringify([{ confirmation: '82696537-1' }])), /confirmation/);
});

test('resume skips every confirmation with a parseable output row and ignores malformed lines', () => {
  const output = [
    JSON.stringify({ conf: '82696537-1', outcome: 'not_found' }),
    '{partial',
    JSON.stringify({ conf: '57291630-1', outcome: 'execution_failure' }),
    JSON.stringify({ confirmation: 'legacy-shape', outcome: 'found' }),
  ].join('\n');
  assert.deepEqual([...completedConfirmations(output)].sort(), ['57291630-1', '82696537-1']);
  assert.deepEqual(remainingConfirmations(['82696537-1', '57291630-1', '61143613-1'], output), ['61143613-1']);
});

test('include-history advances through earlier 60-day windows but stops at the five-year bound', () => {
  const starts = historySweepStarts('2026-10-13');
  assert.equal(starts[0], '2026-08-14');
  assert.equal(starts.at(-1), '2021-10-14');
  assert.equal(starts.length, 31);
});

test('route guard aborts HMS writes but permits confirmation and reservation read searches', () => {
  assert.equal(
    shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.invalid/web/base/OSRESS.search' }),
    false,
  );
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.invalid/web/base/OSRESV.HDR' }), false);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.invalid/web/base/OSRESV.save' }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.invalid/web/base/OSRESV.cancel' }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'GET', url: 'https://hms.invalid/web/base/OSRESV.cancel' }), false);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'DELETE', url: 'https://hms.invalid/web/base/OSRESV.HDR' }), true);
});

test('installed route guard aborts the write and continues the read-only searches', async () => {
  let handler;
  const context = {
    route: async (pattern, run) => {
      assert.equal(pattern, '**/*');
      handler = run;
    },
  };
  await installReadOnlyGuard(context);
  const resultFor = async (method, url) => {
    const result = { action: null };
    const route = {
      request: () => ({ method: () => method, url: () => url }),
      abort: async () => { result.action = 'abort'; },
      continue: async () => { result.action = 'continue'; },
    };
    await handler(route);
    return result.action;
  };
  assert.equal(await resultFor('POST', 'https://hms.invalid/web/base/OSRESS.search'), 'continue');
  assert.equal(await resultFor('POST', 'https://hms.invalid/web/base/OSRESV.HDR'), 'continue');
  assert.equal(await resultFor('POST', 'https://hms.invalid/web/base/OSRESV.save'), 'abort');
});
