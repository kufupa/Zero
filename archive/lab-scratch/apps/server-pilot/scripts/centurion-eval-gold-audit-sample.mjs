#!/usr/bin/env node
/** Stratified gold-audit shard. Counts on stdout. No PII. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const LIMITS = {
  hms_quote_stay: 8,
  hms_group_block_read: 8,
  hms_cancel_reservation: 7,
  mail_read_artifact: 7,
};
const FOCUS = Object.keys(LIMITS);

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

const lab = loadJson(path.join(DEMAND, 'lab/index.json'));
const goldBodies = new Map();
for (let i = 0; i < 7; i += 1) {
  for (const row of loadJsonl(path.join(DEMAND, 'shards', `gold-oracle-${i}-bodies.jsonl`))) {
    goldBodies.set(row.inboundId, row);
  }
}
const picked = new Set();
const out = [];
const counts = Object.fromEntries(FOCUS.map((tool) => [tool, 0]));

function take(tool, requireGold) {
  for (const row of lab.rows || []) {
    if (counts[tool] >= LIMITS[tool]) return;
    if (picked.has(row.inboundId)) continue;
    if (!row.needed?.[tool]) continue;
    const hasGold = Boolean(row.gold?.textBody) || goldBodies.get(row.inboundId)?.gold?.textBody;
    if (requireGold && !hasGold) continue;
    const body = goldBodies.get(row.inboundId);
    out.push({
      inboundId: row.inboundId,
      threadOutcome: row.threadOutcome,
      neededHint: Object.fromEntries(FOCUS.map((item) => [item, Boolean(row.needed?.[item])])),
      focusTool: tool,
      inbound: body?.inbound || { subject: row.inbound?.subject, textBody: String(row.inbound?.textBody || '').slice(0, 8000) },
      gold: body?.gold || (row.gold
        ? { id: row.gold.id, subject: row.gold.subject, textBody: String(row.gold.textBody || '').slice(0, 8000) }
        : null),
      threadOuts: body?.threadOuts || [],
      attachmentText: body?.attachmentText || '',
      no_oracle: !hasGold,
    });
    picked.add(row.inboundId);
    counts[tool] += 1;
  }
}

for (const tool of FOCUS) take(tool, true);
for (const tool of FOCUS) take(tool, false);

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(DEMAND, 'shards', 'gold-audit-0-bodies.jsonl'),
  out.length ? `${out.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
  { mode: 0o600 },
);
for (let i = 1; i < 7; i += 1) {
  writeFileSync(path.join(DEMAND, 'shards', `gold-audit-${i}-bodies.jsonl`), '', { mode: 0o600 });
}
console.log(JSON.stringify({ rows: out.length, counts, withGold: out.filter((row) => !row.no_oracle).length }));
