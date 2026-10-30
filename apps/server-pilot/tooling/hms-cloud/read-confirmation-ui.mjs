#!/usr/bin/env node
// Centurion login + Stay 360, then read one exact confirmation.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { lookupFailure, readLookupInput } from './stay360-lookup-cli.mjs';

const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-confirmation-ui.mjs --confirmation NUMBER\n' +
  '   or: node apps/server-pilot/tooling/playwright-quote/read-confirmation-ui.mjs --json-stdin\n' +
  'JSON input: {"confirmation":"...","guestName":"...","arrivalDate":"YYYY-MM-DD"}; the last two are optional.\n' +
  'Searches Stay 360 and prints the selected reservation page as JSON; output contains guest information.';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const started = Date.now();
let input;
try { input = readLookupInput(args); }
catch (error) {
  process.stderr.write(`${JSON.stringify(lookupFailure(error, started), null, 2)}\n`);
  process.exit(2);
}
try {
  const result = await withCenturionStay360Page((page) =>
    readConfirmationFromStay360(page, input.confirmation, input.options));
  process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(lookupFailure(error, started), null, 2)}\n`);
  process.exitCode = 1;
}
