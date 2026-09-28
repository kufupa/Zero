#!/usr/bin/env node
/** Shuffle inbound bodies for a neededCount cluster. Counts on stdout. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const CLUSTER = process.argv[2] || 'writes';
const SHARD_COUNT = Number(process.argv[3] || 5);
const SEED = process.argv[4] || `20260920-needed-${CLUSTER}`;

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const rows = [];
for (let i = 0; i < 5; i += 1) {
  rows.push(...loadJsonl(path.join(DEMAND, 'shards', `pass3-${i}-bodies.jsonl`)));
}
if (!rows.length) {
  for (let i = 0; i < 5; i += 1) {
    rows.push(...loadJsonl(path.join(DEMAND, 'shards', `pass2-${i}-bodies.jsonl`)));
  }
}

const parser = new Map(loadJsonl(path.join(DEMAND, 'extracts/parser-needed.jsonl')).map((row) => [row.inboundId, row]));

function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedInt = Number.parseInt(createHash('sha256').update(SEED).digest('hex').slice(0, 8), 16);
const rand = mulberry32(seedInt);
const shuffled = rows
  .filter((row) => parser.has(row.inboundId))
  .map((row, index) => ({ row, index, sort: rand() }))
  .sort((a, b) => a.sort - b.sort || a.index - b.index)
  .map((item) => {
    const hint = parser.get(item.row.inboundId);
    const text = String(item.row.inbound?.textBody || '').slice(0, 2500);
    const subject = item.row.inbound?.subject || null;
    return {
      inboundId: item.row.inboundId,
      inbound: { subject, textBody: text },
      parserFloor: hint?.floor || {},
      parserCeiling: hint?.ceiling || {},
    };
  });

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const shardSize = Math.ceil(shuffled.length / SHARD_COUNT) || 1;
for (let i = 0; i < SHARD_COUNT; i += 1) {
  const slice = shuffled.slice(i * shardSize, (i + 1) * shardSize);
  writeFileSync(
    path.join(DEMAND, 'shards', `needed-${CLUSTER}-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}

console.log(
  JSON.stringify({
    cluster: CLUSTER,
    seed: SEED,
    shuffled: shuffled.length,
    shardCount: SHARD_COUNT,
    orderChanged: rows[0]?.inboundId !== shuffled[0]?.inboundId,
  }),
);
