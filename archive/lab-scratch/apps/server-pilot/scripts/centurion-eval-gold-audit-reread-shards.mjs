#!/usr/bin/env node
/** Reread gold-audit disagreements. Counts on stdout. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const audit = JSON.parse(readFileSync(path.join(DEMAND, 'truth/gold-audit-full.json'), 'utf8'));
const ids = new Set(audit.disagreeIds || []);

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const rows = [];
for (let i = 0; i < 7; i += 1) {
  for (const row of loadJsonl(path.join(DEMAND, 'shards', `gold-audit-full-${i}-bodies.jsonl`))) {
    if (ids.has(row.inboundId)) rows.push(row);
  }
}
mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const SHARDS = 7;
const size = Math.ceil(rows.length / SHARDS) || 1;
for (let i = 0; i < SHARDS; i += 1) {
  const slice = rows.slice(i * size, (i + 1) * size);
  writeFileSync(
    path.join(DEMAND, 'shards', `gold-audit-reread-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}
console.log(JSON.stringify({ disagrees: ids.size, rows: rows.length, shards: SHARDS }));
