#!/usr/bin/env node
// Compose read shallow -> read record -> read documents in one authenticated session.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readShallow, readRecord, readDocuments } from './hms-readers.mjs';
import { lookupFailure, readLookupInput } from '../playwright-quote/stay360-lookup-cli.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node read-documents-ui.mjs --confirmation NUMBER | --json-stdin\n' +
    'JSON input: {"confirmation":"...","guestName":"...","arrivalDate":"YYYY-MM-DD"}.\n' +
    'Output contains guest and document information; capture it only in a private location.\n');
  process.exit(0);
}
const started = Date.now();
let input;
try { input = readLookupInput(args); }
catch (error) {
  process.stderr.write(`${JSON.stringify(lookupFailure(error, started))}\n`);
  process.exit(2);
}
try {
  const result = await withCenturionStay360Page(async (page) => {
    const stay360 = await readShallow(page, input.confirmation, input.options);
    const recordView = await readRecord(page, input.confirmation);
    const documents = await readDocuments(page, input.confirmation);
    return { ok: true, confirmation: stay360.confirmation, stay360, recordView, documents };
  });
  process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(lookupFailure(error, started))}\n`);
  process.exitCode = 1;
}
