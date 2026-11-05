#!/usr/bin/env node
// Full exact-ID profile reads. Inputs and output contain private guest information.
import { readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readGuestProfiles } from '../guest-profile-create.mjs';

if (process.argv[2] === '--help') {
  console.log('Usage: node batch-read-guest-profiles.mjs INPUT.json OUTPUT.json');
  console.log('Input: {candidates: [{nativeId, propertyCode?}]}. Output must be in a private directory outside Git.');
  process.exit(0);
}
if (process.argv.length !== 4) throw new Error('EXPECTED_INPUT_AND_OUTPUT');
process.umask(0o077);
const input = resolve(process.argv[2]), output = resolve(process.argv[3]);
const dir = dirname(output);
if (await realpath(dir) !== dir) throw new Error('OUTPUT_DIRECTORY_ALIAS');
const stat = await lstat(dir);
if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');
for (let parent = dir; ; parent = dirname(parent)) {
  try { await lstat(resolve(parent, '.git')); throw new Error('OUTPUT_IN_GIT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (dirname(parent) === parent) break;
}
const candidates = JSON.parse(await readFile(input, 'utf8')).candidates;
const report = { source: input, startedAt: new Date().toISOString(), sessionVerified: false, results: [] };
await writeFile(output, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
async function checkpoint() {
  const partial = output + '.partial';
  await writeFile(partial, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  await rename(partial, output);
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const result = await readGuestProfiles(candidates, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]), onResult: async row => {
  report.results.push(row);
  if (report.results.length % 25 === 0) {
    await checkpoint();
    console.log(JSON.stringify({ completed: report.results.length, total: candidates.length }));
  }
} });
report.outcome = result.outcome;
report.issue = result.issue ?? null;
report.sessionVerified = result.sessionVerified === true;
report.endedAt = new Date().toISOString();
await checkpoint();
console.log(JSON.stringify({ outcome: report.outcome, completed: report.results.length,
  total: candidates?.length ?? null, sessionVerified: report.sessionVerified, issue: report.issue }));
if (!report.sessionVerified) process.exitCode = 1;
