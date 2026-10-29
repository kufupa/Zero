#!/usr/bin/env node
// Log in once, select a confirmation, and read its Record View.
import { withCenturionStay360Page } from './centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { readRecordViewFromStay360 } from './stay360-record-view.mjs';

const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-record-view-ui.mjs --confirmation NUMBER\n' +
  'Prints the selected Stay 360 page and Record View as JSON; output contains guest information.';
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
  const result = await withCenturionStay360Page(async (page) => {
    const stay360 = await readConfirmationFromStay360(page, args[1]);
    const recordView = await readRecordViewFromStay360(page, args[1]);
    return { ok: true, confirmation: stay360.confirmation, stay360, recordView };
  });
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
