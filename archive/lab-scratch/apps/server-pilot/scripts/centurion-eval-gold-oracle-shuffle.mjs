#!/usr/bin/env node
/** Build 8k inbound+gold+threadOuts+attach shards. Counts on stdout. No PII. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PILE = process.argv[2] || 'gold-oracle';
const SHARD_COUNT = Math.min(7, Number(process.argv[3] || 7));
const SEED = process.argv[4] || `20260920-${PILE}`;
const SNAP = path.join(
  DEMAND,
  '../../connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
);

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clip(text, n) {
  return String(text || '').slice(0, n);
}

function staffGoldText(text) {
  const raw = String(text || '');
  const match = raw.match(/\n(?:From:\s|-----Original Message-----)/i);
  if (!match || match.index < 8) return clip(raw, 8000);
  const staff = raw.slice(0, match.index).trim();
  return clip(staff || raw, 8000);
}

function isOut(row) {
  return row.direction === 'outbound' || row.businessDirection === 'outbound' || row.confirmedOutbound === true;
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

const messages = loadJsonl(SNAP);
const byId = new Map(messages.map((row) => [String(row.id), row]));
const byThread = new Map();
for (const row of messages) {
  const threadId = String(row.threadId || '');
  if (!threadId) continue;
  if (!byThread.has(threadId)) byThread.set(threadId, []);
  byThread.get(threadId).push(row);
}

const attachByInbound = new Map();
for (let i = 0; i < 5; i += 1) {
  for (const row of loadJsonl(path.join(DEMAND, 'shards', `pass6-${i}-bodies.jsonl`))) {
    const texts = ((row.artifacts || []).map((item) => item.textExtract || '')).join('\n');
    if (texts.trim()) attachByInbound.set(String(row.inboundId), clip(texts, 8000));
  }
}

const lab = existsSync(path.join(DEMAND, 'lab/index.json'))
  ? JSON.parse(readFileSync(path.join(DEMAND, 'lab/index.json'), 'utf8'))
  : { rows: [] };
const labByInbound = new Map((lab.rows || []).map((row) => [String(row.inboundId), row]));
const pairs = loadJsonl(path.join(DEMAND, 'pairs.jsonl'));
const skips = loadJsonl(path.join(DEMAND, 'skips.jsonl')).filter((row) => row.skipReason === 'channel_auto');

function mailView(id, limit) {
  const row = byId.get(String(id || ''));
  if (!row) return null;
  return {
    id: String(row.id),
    subject: clip(row.subject, 400),
    textBody: clip(row.textBody || row.htmlBody, limit),
  };
}

function threadOuts(threadId) {
  return (byThread.get(String(threadId || '')) || [])
    .filter(isOut)
    .slice(0, 8)
    .map((row) => ({
      id: String(row.id),
      eventAt: row.eventAt || null,
      textBody: clip(row.textBody || row.htmlBody, 2000),
    }));
}

let source = [];
if (PILE === 'gold-oracle') {
  source = (lab.rows || []).filter((row) =>
    row.threadOutcome === 'gold_human' || row.threadOutcome === 'gold_pairing_miss',
  );
} else if (PILE === 'true-gap') {
  source = (lab.rows || []).filter((row) => row.threadOutcome === 'true_gap');
} else if (PILE === 'outbound-only') {
  source = pairs.filter((row) => row.matchMethod === 'outbound_only');
} else if (PILE === 'channel-auto') {
  source = skips;
} else if (PILE === 'value-reread') {
  source = lab.rows || [];
} else {
  throw new Error(`unknown pile ${PILE}`);
}

const rand = mulberry32(Number.parseInt(createHash('sha256').update(SEED).digest('hex').slice(0, 8), 16));
const shuffled = source
  .map((row, index) => ({ row, index, sort: rand() }))
  .sort((a, b) => a.sort - b.sort || a.index - b.index)
  .map((item) => {
    const row = item.row;
    if (PILE === 'outbound-only') {
      const gold = mailView(row.goldId, 8000);
      return {
        pile: PILE,
        goldId: String(row.goldId),
        threadId: row.threadId || null,
        inboundId: null,
        inbound: null,
        gold,
        threadOuts: threadOuts(row.threadId),
        attachmentText: '',
      };
    }
    if (PILE === 'channel-auto') {
      const gold = mailView(row.goldId, 8000);
      const threadId = gold ? byId.get(String(row.goldId))?.threadId : null;
      return {
        pile: PILE,
        goldId: String(row.goldId),
        threadId: threadId || null,
        inboundId: null,
        inbound: null,
        gold,
        threadOuts: threadOuts(threadId),
        attachmentText: '',
        policy: 'ota_already_created_do_not_double_create',
      };
    }
    const labRow = labByInbound.get(String(row.inboundId)) || row;
    const inboundId = String(labRow.inboundId);
    const goldId = labRow.gold?.id || null;
    const goldRaw = goldId ? mailView(goldId, 8000) : labRow.gold
      ? { id: labRow.gold.id, subject: clip(labRow.gold.subject, 400), textBody: clip(labRow.gold.textBody, 8000) }
      : null;
    const gold = goldRaw
      ? { ...goldRaw, textBody: staffGoldText(goldRaw.textBody) }
      : null;
    return {
      pile: PILE,
      inboundId,
      goldId,
      threadId: labRow.threadId || null,
      threadOutcome: labRow.threadOutcome || null,
      inbound: mailView(inboundId, 8000) || {
        id: inboundId,
        subject: clip(labRow.inbound?.subject, 400),
        textBody: clip(labRow.inbound?.textBody, 8000),
      },
      gold,
      threadOuts: threadOuts(labRow.threadId),
      priorInbounds: Array.isArray(labRow.priorInbounds)
        ? labRow.priorInbounds.map((item) => ({
            id: item.id,
            subject: clip(item.subject, 400),
            textBody: clip(item.textBody, 4000),
          }))
        : [],
      attachmentText: labRow.attachmentText || attachByInbound.get(inboundId) || '',
    };
  });

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const shardSize = Math.ceil(shuffled.length / SHARD_COUNT) || 1;
let nonempty = 0;
for (let i = 0; i < SHARD_COUNT; i += 1) {
  const slice = shuffled.slice(i * shardSize, (i + 1) * shardSize);
  if (slice.length) nonempty += 1;
  writeFileSync(
    path.join(DEMAND, 'shards', `${PILE}-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}

console.log(
  JSON.stringify({
    pile: PILE,
    seed: SEED,
    rows: shuffled.length,
    shardCount: SHARD_COUNT,
    nonemptyShards: nonempty,
    withGold: shuffled.filter((row) => row.gold && row.gold.textBody).length,
    withAttach: shuffled.filter((row) => row.attachmentText).length,
    withPrior: shuffled.filter((row) => Array.isArray(row.priorInbounds) && row.priorInbounds.length).length,
  }),
);
