#!/usr/bin/env node
// Save the full result privately, and optionally return a smaller view on stdout.
import { readFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { filterHotelAvailability, searchHotelAvailability } from './hotel-availability.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node read-hotel-availability-ui.mjs PRIVATE_SNAPSHOT.json --json-stdin\n' +
    'Input: {"criteria":{"propertyCode":"HRCEN","arrivalDate":"YYYY-MM-DD",' +
    '"departureDate":"YYYY-MM-DD","adults":2,"childAges":[],"roomTypes":"all","ratePlans":"all"},' +
    '"view":{"roomTypes":["STQN"],"ratePlans":["BAR"]}}. Omit view for a summary only.\n');
  process.exit(0);
}
try {
  if (args.length !== 2 || args[1] !== '--json-stdin') throw new Error('EXPECTED_PRIVATE_PATH_AND_JSON_STDIN');
  const path = resolve(args[0]);
  if ((await stat(dirname(path))).mode & 0o077) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');
  process.umask(0o077);
  const request = JSON.parse(readFileSync(0, 'utf8'));
  if (request.view != null && (typeof request.view !== 'object' || Array.isArray(request.view) ||
      (request.view.roomTypes != null && !Array.isArray(request.view.roomTypes)) ||
      (request.view.ratePlans != null && !Array.isArray(request.view.ratePlans)))) throw new Error('VIEW_FILTER_INVALID');
  const result = await withCenturionStay360Page((page) => searchHotelAvailability(page, request.criteria));
  if (result.outcome !== 'ok' && result.outcome !== 'criteria_unavailable') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } else {
    const view = result.outcome === 'ok' && request.view ? filterHotelAvailability(result.snapshot, request.view) : undefined;
    await writeFile(path, `${JSON.stringify(result.snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    if (result.outcome === 'criteria_unavailable') {
      process.stdout.write(`${JSON.stringify({ outcome: result.outcome, issue: result.issue, snapshotPath: path })}\n`);
    } else {
      const availability = result.snapshot.response.availabilitydata;
      const properties = availability.children.filter((item) => item.isprop && !item.issummary);
      const roomRows = properties.flatMap((item) => item.children || []);
      const summary = { dateCount: availability.datesList.length, roomRows: roomRows.length,
        rateRows: roomRows.reduce((count, room) => count + (room.children || []).length, 0) };
      process.stdout.write(`${JSON.stringify({ outcome: 'ok', snapshotPath: path, summary,
        ...(view ? { view } : {}) })}\n`);
    }
  }
} catch (error) {
  const message = String(error?.message || error).split('\n')[0];
  process.stderr.write(`${JSON.stringify({ outcome: 'execution_failure', phase: error?.phase || 'operation',
    issue: /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'HOTEL_AVAILABILITY_RUN_FAILED' })}\n`);
  process.exitCode = 1;
}
