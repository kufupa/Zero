#!/usr/bin/env node
// Read-only census; all candidate details stay in the caller's private directory.
import { realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withCenturionStay360Page } from '../../playwright-quote/centurion-stay360.mjs';
import { searchLabtestPreimage } from '../labtest-preimage.mjs';

const [arrival, departure, output] = process.argv.slice(2);
const root = process.env.STAY360_PRIVATE_ROOT;
if (!arrival || !departure || !root || !output || !path.isAbsolute(output)) {
  throw new Error('ARRIVAL_DEPARTURE_AND_PRIVATE_OUTPUT_REQUIRED');
}
const privateRoot = await realpath(root), parent = await realpath(path.dirname(output));
const relative = path.relative(privateRoot, parent);
if (relative.startsWith('..') || path.isAbsolute(relative) || ((await stat(privateRoot)).mode & 0o077) !== 0 ||
    ((await stat(parent)).mode & 0o077) !== 0) throw new Error('PRIVATE_OUTPUT_DIRECTORY_REQUIRED');
const result = await withCenturionStay360Page((page) => searchLabtestPreimage(page, { arrival, departure }), { headless: true });
await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ outcome: result.outcome, issue: result.issue || null, coverage: result.coverage || null,
  sameArrival: result.sameArrival?.length ?? null }));
if (!['clear', 'existing_matches'].includes(result.outcome)) process.exitCode = 1;
