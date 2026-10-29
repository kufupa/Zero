#!/usr/bin/env node
// Centurion login + Stay 360, then read one exact confirmation.
import { withCenturionStay360Page } from './centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';

const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-confirmation-ui.mjs --confirmation NUMBER\n' +
  'Searches Stay 360 and prints the selected reservation page as JSON; output contains guest information.';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--confirmation' || !args[1].trim()) {
  process.stderr.write(`INVALID_CONFIRMATION\n${usage}\n`);
  process.exit(2);
}

const started = Date.now();
try {
  const result = await withCenturionStay360Page((page) => readConfirmationFromStay360(page, args[1]));
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
