#!/usr/bin/env node
/** Patch lab index with needed flags. Copies gitignored public JSON. Counts on stdout. No PII. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const ROOT = path.resolve(DEMAND, '../../..');

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const indexPath = path.join(DEMAND, 'lab/index.json');
const index = loadJson(indexPath);
const parserRows = new Map(loadJsonl(path.join(DEMAND, 'extracts/parser-needed.jsonl')).map((row) => [row.inboundId, row]));
const lunaRows = new Map(loadJsonl(path.join(DEMAND, 'extracts/needed-canonical.jsonl')).map((row) => [row.inboundId, row]));
const freeze = existsSync(path.join(DEMAND, 'truth/needed-count.json'))
  ? loadJson(path.join(DEMAND, 'truth/needed-count.json'))
  : {};

const neededCounts = [];
for (const [tool, row] of Object.entries(freeze)) {
  if (!row || typeof row !== 'object' || !('parserFloor' in row)) continue;
  neededCounts.push({
    tool,
    neededCount: row.neededCount == null ? 'unresolved' : row.neededCount,
    parserFloor: row.parserFloor,
    threshold95: row.threshold95,
  });
}
neededCounts.sort((a, b) => {
  const av = a.neededCount === 'unresolved' ? a.parserFloor : a.neededCount;
  const bv = b.neededCount === 'unresolved' ? b.parserFloor : b.neededCount;
  return bv - av || a.tool.localeCompare(b.tool);
});

let flagged = 0;
for (const row of index.rows) {
  const luna = lunaRows.get(row.inboundId);
  const parser = parserRows.get(row.inboundId);
  const needed = { ...(parser?.ceiling || parser?.floor), ...(luna?.needed) };
  row.needed = needed;
  if (Object.values(needed).some(Boolean)) flagged += 1;
}
index.neededCounts = neededCounts;
index.denominator = freeze.denominator || '980 candidate inbounds';
writeFileSync(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });

if (process.env.LAB_WRITE_PUBLIC_INDEX === '1') {
  const publicPath = path.join(ROOT, 'apps/mail/public/lab-centurion-index.json');
  copyFileSync(indexPath, publicPath);
}
console.log(JSON.stringify({ rows: index.rows.length, flagged, neededCountTools: neededCounts.length, public: process.env.LAB_WRITE_PUBLIC_INDEX === '1' }));
