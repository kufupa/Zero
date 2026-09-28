#!/usr/bin/env node
/** Pick ~15 ids/shard + cited ids. Writes ids only. No bodies on stdout. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2] || 'value-reread';
const CITED_SUBSTR = [
  'airbus',
  'request for accommodation',
  'urgent request for a tax invoice',
  'voucher',
  'mulungwa',
  'bok radio',
  'reservations 16 october',
  'cidb',
];

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function hash32(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const lab = JSON.parse(readFileSync(path.join(DEMAND, 'lab/index.json'), 'utf8'));
const byInbound = new Map((lab.rows || []).map((row) => [String(row.inboundId), row]));
const citedIds = new Set();
for (const row of lab.rows || []) {
  const hay = `${row.inbound?.subject || ''} ${row.gold?.subject || ''}`.toLowerCase();
  if (CITED_SUBSTR.some((needle) => hay.includes(needle))) citedIds.add(String(row.inboundId));
}

const out = { pass: PASS, citedCount: citedIds.size, shards: [] };
for (let i = 0; i < 7; i += 1) {
  const rows = loadJsonl(path.join(DEMAND, 'shards', `${PASS}-${i}-bodies.jsonl`));
  const buckets = {
    find: [],
    read: [],
    quote: [],
    true_gap: [],
    gold_human: [],
    hasPdf: [],
    hasPrior: [],
  };
  const citedHere = [];
  for (const row of rows) {
    const id = String(row.inboundId);
    const labRow = byInbound.get(id) || {};
    const tools = labRow.neededTools || [];
    if (tools.includes('hms_find_reservation')) buckets.find.push(id);
    if (tools.includes('hms_read_reservation')) buckets.read.push(id);
    if (tools.includes('hms_quote_stay')) buckets.quote.push(id);
    if (labRow.threadOutcome === 'true_gap') buckets.true_gap.push(id);
    if (labRow.threadOutcome === 'gold_human' || labRow.threadOutcome === 'gold_pairing_miss') {
      buckets.gold_human.push(id);
    }
    if (row.attachmentText) buckets.hasPdf.push(id);
    if (Array.isArray(row.priorInbounds) && row.priorInbounds.length) buckets.hasPrior.push(id);
    if (citedIds.has(id)) citedHere.push(id);
  }
  const sample = new Set(citedHere);
  for (const [name, ids] of Object.entries(buckets)) {
    const sorted = [...ids].sort((a, b) => hash32(`${PASS}:${i}:${name}:${a}`) - hash32(`${PASS}:${i}:${name}:${b}`));
    for (const id of sorted.slice(0, 2)) sample.add(id);
  }
  while (sample.size < 15 && rows.length) {
    const extra = rows[sample.size % rows.length];
    if (extra?.inboundId) sample.add(String(extra.inboundId));
    else break;
  }
  out.shards.push({
    shard: i,
    rows: rows.length,
    citedInShard: citedHere.length,
    sampleCount: sample.size,
    sampleIds: [...sample],
    citedIds: citedHere,
    bucketCounts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  });
}

mkdirSync(path.join(DEMAND, 'extracts'), { recursive: true, mode: 0o700 });
writeFileSync(path.join(DEMAND, 'extracts', `${PASS}-qa-sample.json`), `${JSON.stringify(out, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    pass: PASS,
    citedCount: out.citedCount,
    shards: out.shards.map((s) => ({
      shard: s.shard,
      rows: s.rows,
      sampleCount: s.sampleCount,
      citedInShard: s.citedInShard,
      bucketCounts: s.bucketCounts,
    })),
  }),
);
