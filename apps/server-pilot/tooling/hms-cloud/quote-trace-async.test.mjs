import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteTraceAsyncEnabled } from './fetch-quote.mjs';

test('the trace-async flag is enabled only by the exact value on', () => {
  assert.equal(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: 'on' }), true);
  for (const value of [undefined, '', '1', 'true', 'ON', ' on', 'on ', 'off'])
    assert.equal(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: value }), false, `value ${JSON.stringify(value)}`);
  assert.equal(quoteTraceAsyncEnabled({}), false);
});
