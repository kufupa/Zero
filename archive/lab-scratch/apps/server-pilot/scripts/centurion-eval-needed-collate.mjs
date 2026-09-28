#!/usr/bin/env node
/** Merge cluster needed JSONL vs parser. Counts on stdout. No PII. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const CLUSTER = process.argv[2];
if (!CLUSTER) throw new Error('cluster required');

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

const incoming = [];
for (let i = 0; i < 5; i += 1) {
  incoming.push(...loadJsonl(path.join(DEMAND, 'extracts', `needed-${CLUSTER}-${i}.jsonl`)));
}
const parser = new Map(loadJsonl(path.join(DEMAND, 'extracts/parser-needed.jsonl')).map((row) => [row.inboundId, row]));
const priorPath = path.join(DEMAND, 'extracts/needed-canonical.jsonl');
const merged = new Map(loadJsonl(priorPath).map((row) => [row.inboundId, row]));
const lunaCounts = {};
const disagreements = [];

for (const row of incoming) {
  const id = row.inboundId;
  if (!id || !row.needed) continue;
  const old = merged.get(id) || { inboundId: id, needed: {} };
  const needed = { ...old.needed };
  const hint = parser.get(id);
  for (const [tool, value] of Object.entries(row.needed)) {
    const bool = Boolean(value);
    needed[tool] = bool;
    if (bool) bump(lunaCounts, tool);
    const parserVal = hint?.ceiling?.[tool] ?? hint?.floor?.[tool];
    if (parserVal != null && Boolean(parserVal) !== bool) {
      disagreements.push({ inboundId: id, cluster: CLUSTER, tool, parser: Boolean(parserVal), luna: bool });
    }
  }
  merged.set(id, { inboundId: id, needed, pass: CLUSTER });
}

mkdirSync(path.join(DEMAND, 'extracts'), { recursive: true, mode: 0o700 });
writeFileSync(
  priorPath,
  `${[...merged.values()].map((row) => JSON.stringify(row)).join('\n')}\n`,
  { mode: 0o600 },
);
writeFileSync(
  path.join(DEMAND, 'extracts', `disagreement-needed-${CLUSTER}.jsonl`),
  disagreements.length ? `${disagreements.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
  { mode: 0o600 },
);

console.log(
  JSON.stringify({
    cluster: CLUSTER,
    rows: incoming.length,
    merged: merged.size,
    lunaCounts,
    disagreements: disagreements.length,
  }),
);
