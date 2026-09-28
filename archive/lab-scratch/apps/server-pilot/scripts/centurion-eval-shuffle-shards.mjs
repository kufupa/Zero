#!/usr/bin/env node
/** Shuffle inbound body shards for a named eval pass. Counts on stdout. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2] || 'pass3';
const SHARD_COUNT = Number(process.argv[3] || 5);
const SEED = process.argv[4] || `20260919-${PASS}-shuffle`;

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const rows = [];
for (let i = 0; i < 5; i += 1) {
  rows.push(...loadJsonl(path.join(DEMAND, 'shards', `pass2-${i}-bodies.jsonl`)));
}
if (!rows.length) {
  for (let i = 0; i < 5; i += 1) {
    rows.push(...loadJsonl(path.join(DEMAND, 'shards', `inbound-${i}-bodies.jsonl`)));
  }
  for (let i = 0; i < 2; i += 1) {
    rows.push(...loadJsonl(path.join(DEMAND, 'shards', `pf-inbound-${i}-bodies.jsonl`)));
  }
}

const hints = new Map();
const hintPath = path.join(DEMAND, 'truth', 'pass0-per-inbound.jsonl');
for (const row of loadJsonl(hintPath)) {
  hints.set(row.inboundId, row);
}

const SNAP = path.join(
  DEMAND,
  '../../connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
);
const skips = new Set(
  loadJsonl(path.join(DEMAND, 'skips.jsonl'))
    .filter((row) => row.skipReason === 'channel_auto')
    .map((row) => String(row.goldId)),
);
const byThread = new Map();
for (const row of loadJsonl(SNAP)) {
  const threadId = String(row.threadId || '');
  if (!threadId) continue;
  const isOut =
    row.direction === 'outbound' || row.businessDirection === 'outbound' || row.confirmedOutbound === true;
  if (!isOut) continue;
  if (!byThread.has(threadId)) byThread.set(threadId, []);
  byThread.get(threadId).push({
    id: row.id,
    eventAt: row.eventAt || null,
    channelAuto: skips.has(String(row.id)),
    textBody: String(row.textBody || '').slice(0, 1500),
  });
}

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
  .map((row, index) => ({ row, index, sort: rand() }))
  .sort((a, b) => a.sort - b.sort || a.index - b.index)
  .map((item) => {
    const hint = hints.get(item.row.inboundId) || {};
    const inbound = item.row.inbound ? { ...item.row.inbound, htmlBody: undefined } : item.row.inbound;
    const gold = item.row.gold ? { ...item.row.gold, htmlBody: undefined } : item.row.gold;
    const threadId = String(item.row.threadId || inbound?.threadId || '');
    return {
      inboundId: item.row.inboundId,
      threadId: item.row.threadId || null,
      eventAt: item.row.eventAt || null,
      goldId: item.row.goldId || null,
      unanswered: item.row.unanswered,
      matchMethod: item.row.matchMethod || null,
      otherDesk: item.row.otherDesk || null,
      inbound,
      gold,
      threadOuts: threadId ? byThread.get(threadId) || [] : [],
      parserThreadOutcome: hint.threadOutcome || null,
      parserPaxTotal: hint.paxTotal ?? null,
      usefulAttachmentCount: hint.usefulAttachmentCount ?? 0,
    };
  });

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const shardSize = Math.ceil(shuffled.length / SHARD_COUNT) || 1;
for (let i = 0; i < SHARD_COUNT; i += 1) {
  const slice = shuffled.slice(i * shardSize, (i + 1) * shardSize);
  writeFileSync(
    path.join(DEMAND, 'shards', `${PASS}-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}

console.log(
  JSON.stringify({
    pass: PASS,
    seed: SEED,
    input: rows.length,
    shuffled: shuffled.length,
    shardCount: SHARD_COUNT,
    orderChanged: rows[0]?.inboundId !== shuffled[0]?.inboundId,
  }),
);
