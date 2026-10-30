#!/usr/bin/env node
// Log in once, select a confirmation, and read Record View and Guest Details.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { readRecordViewFromStay360 } from './stay360-record-view.mjs';
import { readGuestDetailsFromStay360 } from './stay360-guest-details.mjs';
import { lookupFailure, readLookupInput } from './stay360-lookup-cli.mjs';

const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-guest-details-ui.mjs --confirmation NUMBER\n' +
  '   or: node apps/server-pilot/tooling/playwright-quote/read-guest-details-ui.mjs --json-stdin\n' +
  'JSON input: {"confirmation":"...","guestName":"...","arrivalDate":"YYYY-MM-DD"}; the last two are optional.\n' +
  'Prints the selected Stay 360 page, Record View and Guest Details as JSON; output contains guest information.';
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
  const result = await withCenturionStay360Page(async (page) => {
    const stay360 = await readConfirmationFromStay360(page, input.confirmation, input.options);
    const recordView = await readRecordViewFromStay360(page, input.confirmation);
    const guestDetails = await readGuestDetailsFromStay360(page, input.confirmation);
    return { ok: true, confirmation: stay360.confirmation, stay360, recordView, guestDetails };
  });
  process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(lookupFailure(error, started), null, 2)}\n`);
  process.exitCode = 1;
}
