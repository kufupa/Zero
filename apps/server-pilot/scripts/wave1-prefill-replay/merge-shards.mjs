#!/usr/bin/env node
// Merge the K run directories of one sharded wave1 replay (run.ts --shard <i> --shards <K>) into one run directory.
// Usage: node scripts/wave1-prefill-replay/merge-shards.mjs --out <new dir> <shard run dir> ... (all K, any order)
// Writes results.jsonl, summary.json and manifest.json. Fails if the shards are not one complete run of the same
// selection, or if any case is missing or duplicated. Result lines are copied unchanged, so scoring is unaffected.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
if (outAt < 0 || !args[outAt + 1] || args[outAt + 1].startsWith('--')) throw new Error('OUT_DIRECTORY_REQUIRED');
const outDir = resolve(args[outAt + 1]);
const positional = args.filter((_, position) => position !== outAt && position !== outAt + 1);
if (!positional.length || positional.some(dir => dir.startsWith('--'))) throw new Error('SHARD_RUN_DIRECTORIES_REQUIRED');
const runDirs = positional.map(dir => resolve(dir));
if (new Set(runDirs).size !== runDirs.length || runDirs.includes(outDir)) throw new Error('RUN_DIRECTORIES_MUST_BE_DISTINCT');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const shards = [];
for (const runDir of runDirs) {
  const manifest = await readJson(join(runDir, 'manifest.json'));
  const { index, count, caseIds } = manifest.shard ?? {};
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Array.isArray(caseIds)) throw new Error(`NOT_A_SHARD_RUN:${runDir}`);
  const results = await readFile(join(runDir, 'results.jsonl'), 'utf8');
  shards.push({ runDir, manifest, index, count, caseIds, results, summary: await readJson(join(runDir, 'summary.json')) });
}
shards.sort((a, b) => a.index - b.index);
const [first] = shards;
if (shards.some(shard => shard.count !== shards.length) || shards.some((shard, position) => shard.index !== position + 1))
  throw new Error('SHARD_SET_INCOMPLETE_OR_DUPLICATED');
for (const key of ['sourceVersion', 'selectionSha256', 'sealSha256', 'routeIdentityHash', 'artifactHashes', 'sourceHashes',
  'modelId', 'reasoningEffort', 'nativeReaderMode', 'cases']) {
  if (first.manifest[key] === undefined || shards.some(shard => !same(shard.manifest[key], first.manifest[key])))
    throw new Error(`SHARD_MANIFEST_MISMATCH:${key}`);
}

const caseOrder = first.manifest.cases.map(row => row.decisionId);
const expected = new Set(caseOrder);
const lines = new Map();
for (const shard of shards) {
  const assigned = new Set(shard.caseIds);
  if (assigned.size !== shard.caseIds.length || shard.caseIds.some(id => !expected.has(id))) throw new Error(`SHARD_CASE_IDS_INVALID:${shard.index}`);
  if (shard.summary.finishedAt === undefined) throw new Error(`SHARD_RUN_NOT_FINISHED:${shard.index}`);
  for (const line of shard.results.split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    if (!['case_result', 'case_failure'].includes(record.type) || !assigned.has(record.decisionId))
      throw new Error(`RESULT_NOT_ASSIGNED_TO_SHARD:${shard.index}:${record.decisionId}`);
    if (lines.has(record.decisionId)) throw new Error(`DUPLICATE_CASE:${record.decisionId}`);
    lines.set(record.decisionId, line);
  }
}
const assignments = shards.flatMap(shard => shard.caseIds);
if (new Set(assignments).size !== assignments.length) throw new Error('CASE_ASSIGNED_TO_MORE_THAN_ONE_SHARD');
const missing = caseOrder.filter(id => !lines.has(id));
if (missing.length || lines.size !== expected.size) throw new Error(`MISSING_CASES:${missing.join(',')}`);

await mkdir(outDir, { recursive: true, mode: 0o700 });
if ((await readdir(outDir)).length) throw new Error('OUT_DIRECTORY_NOT_EMPTY');
const merged = `${caseOrder.map(id => lines.get(id)).join('\n')}\n`;
const sum = key => shards.reduce((total, shard) => total + (shard.summary[key] ?? 0), 0);
const { shard: _shard, concurrency: _concurrency, seeded: _seeded, seededAttachments: _attachments, startedAt: _startedAt,
  ...shared } = first.manifest;
const manifest = { ...shared, shards: shards.length, resultsSha256: sha256(merged), mergedAt: new Date().toISOString(),
  mergedFrom: shards.map(shard => ({ shard: shard.index, runDir: shard.runDir, caseIds: shard.caseIds,
    resultsSha256: sha256(shard.results), concurrency: shard.manifest.concurrency, startedAt: shard.manifest.startedAt,
    finishedAt: shard.summary.finishedAt })) };
const summary = { completed: lines.size, total: expected.size, failures: sum('failures'), exceptionCount: sum('exceptionCount'),
  workflowFailedCount: sum('workflowFailedCount'), prefillFailedCount: sum('prefillFailedCount'),
  nativeIncompleteCount: sum('nativeIncompleteCount'), summaries: shards.flatMap(shard => shard.summary.summaries ?? []),
  finishedAt: shards.map(shard => shard.summary.finishedAt).sort().at(-1) };
await writeFile(join(outDir, 'results.jsonl'), merged, { mode: 0o600, flag: 'wx' });
await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary), { mode: 0o600, flag: 'wx' });
await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
console.info(JSON.stringify({ status: 'merged', shards: shards.length, cases: lines.size, failures: summary.failures, outDir }));
