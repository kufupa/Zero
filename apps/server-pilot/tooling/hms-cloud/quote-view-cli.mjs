#!/usr/bin/env node
// Offline projection of a caller-supplied private Hotel Availability snapshot.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getQuoteView } from './quote-view.mjs';

const VIEW_FIELDS = new Set([
  'roomTypes', 'ratePlans', 'offset', 'limit', 'nightOffset', 'nightLimit',
  'roomQuantity', 'includeNightlyValueSum',
]);
const INPUT_ISSUES = new Set([
  'ROOM_QUANTITY_INVALID', 'ROOM_QUANTITY_MISMATCH', 'INVALID_AVAILABILITY_VIEW_PAGE',
  'AVAILABILITY_VIEW_FILTERS_MUST_BE_ARRAYS', 'NIGHTLY_SUM_FLAG_INVALID',
]);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Project an existing snapshot without opening a session or writing files. */
export function projectQuoteRequest(request) {
  if (!object(request) || Object.keys(request).some((key) => !['snapshot', 'view'].includes(key)) ||
      !object(request.snapshot)) return { outcome: 'input_gap', issue: 'QUOTE_SNAPSHOT_REQUIRED' };
  const view = request.view === undefined ? {} : request.view;
  if (!object(view) || Object.keys(view).some((key) => !VIEW_FIELDS.has(key))) {
    return { outcome: 'input_gap', issue: 'INVALID_QUOTE_VIEW' };
  }
  try {
    const projected = getQuoteView(request.snapshot, view);
    return { outcome: 'ok', snapshotOutcome: projected.outcome, view: projected };
  } catch (error) {
    const message = error?.message;
    return INPUT_ISSUES.has(message) ? { outcome: 'input_gap', issue: message }
      : { outcome: 'execution_failure', issue: 'QUOTE_PROJECTION_FAILED' };
  }
}

export async function runQuoteViewCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node quote-view-cli.mjs --json-stdin\n' +
      'Input: {"snapshot": <private Hotel Availability snapshot>, "view": <optional filters>}\n' +
      'Input and output are private. This offline command makes no HMS requests.\n');
    return;
  }
  if (args.length !== 1 || args[0] !== '--json-stdin') {
    process.stdout.write(`${JSON.stringify({ outcome: 'input_gap', issue: 'EXPECTED_JSON_STDIN' })}\n`);
    process.exitCode = 1;
    return;
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) {
      process.stdout.write(`${JSON.stringify({ outcome: 'input_gap', issue: 'QUOTE_INPUT_TOO_LARGE' })}\n`);
      process.exitCode = 1;
      return;
    }
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    process.stdout.write(`${JSON.stringify({ outcome: 'input_gap', issue: 'INVALID_JSON' })}\n`);
    process.exitCode = 1;
    return;
  }
  const result = projectQuoteRequest(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runQuoteViewCli().catch(() => {
    process.stdout.write(`${JSON.stringify({ outcome: 'execution_failure', issue: 'QUOTE_CLI_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
