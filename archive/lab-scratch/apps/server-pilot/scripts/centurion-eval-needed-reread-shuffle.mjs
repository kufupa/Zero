#!/usr/bin/env node
/** Build disagreement-only shard. Usage: label bodies.jsonl disagreement.jsonl */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const LABEL = process.argv[2];
const BODIES = process.argv[3];
const DIS = process.argv[4];
if (!LABEL || !BODIES || !DIS) throw new Error('usage: label bodies.jsonl disagreement.jsonl');

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resolve(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(DEMAND, filePath);
}

const bodies = new Map(loadJsonl(resolve(BODIES)).map((row) => [row.inboundId, row]));
const disagrees = loadJsonl(resolve(DIS));
const ids = [...new Set(disagrees.map((row) => row.inboundId))];
const rows = ids.map((id) => bodies.get(id)).filter(Boolean);
mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const out = path.join(DEMAND, 'shards', `${LABEL}-0-bodies.jsonl`);
writeFileSync(out, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '', { mode: 0o600 });
console.log(JSON.stringify({ label: LABEL, disagreements: disagrees.length, ids: ids.length, rows: rows.length }));
