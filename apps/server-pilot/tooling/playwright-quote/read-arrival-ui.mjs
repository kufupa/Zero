#!/usr/bin/env node
// Centurion login + Stay 360, then the read-only arrival UI step.
import { withCenturionStay360Page } from './centurion-stay360.mjs';
import { readArrivalFromStay360 } from './arrival-ui.mjs';

const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-arrival-ui.mjs [--arrival N]\n' +
  'Reads the Nth visible Arrivals row (1-based; default 1) and prints raw visible details as JSON.';
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const arrivalArg = args.length === 2 && args[0] === '--arrival' ? args[1] : args.length ? null : '1';
if (!arrivalArg || !/^[1-9]\d*$/.test(arrivalArg) || !Number.isSafeInteger(Number(arrivalArg))) {
  process.stderr.write(`INVALID_ARRIVAL_NUMBER\n${usage}\n`);
  process.exit(2);
}

const started = Date.now();
try {
  const result = await withCenturionStay360Page((page) => readArrivalFromStay360(page, Number(arrivalArg)));
  process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2)}\n`);
} catch (error) {
  const message = String(error?.message || error).split('\n')[0];
  process.stderr.write(`${JSON.stringify({
    ok: false,
    phase: error?.phase || 'startup',
    elapsedMs: Date.now() - started,
    error: /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'PLAYWRIGHT_OPERATION_FAILED',
  }, null, 2)}\n`);
  process.exitCode = 1;
}
