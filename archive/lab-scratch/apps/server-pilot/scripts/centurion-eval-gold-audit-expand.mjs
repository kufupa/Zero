#!/usr/bin/env node
/** Expand gold-audit to all paired rows needing focus tools. Counts on stdout. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const FOCUS = ['hms_quote_stay', 'hms_group_block_read', 'hms_cancel_reservation', 'mail_read_artifact'];
const SHARDS = 7;

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

const lab = new Map(loadJson(path.join(DEMAND, 'lab/index.json')).rows.map((row) => [row.inboundId, row]));
const bodies = [];
for (let i = 0; i < 7; i += 1) {
  bodies.push(...loadJsonl(path.join(DEMAND, 'shards', `gold-oracle-${i}-bodies.jsonl`)));
}
const rows = bodies.filter((row) => {
  const labRow = lab.get(row.inboundId);
  return labRow && FOCUS.some((tool) => labRow.needed?.[tool]);
}).map((row) => {
  const labRow = lab.get(row.inboundId);
  return {
    ...row,
    neededHint: Object.fromEntries(FOCUS.map((tool) => [tool, Boolean(labRow.needed?.[tool])])),
    no_oracle: !row.gold?.textBody,
  };
});

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
const size = Math.ceil(rows.length / SHARDS) || 1;
for (let i = 0; i < SHARDS; i += 1) {
  const slice = rows.slice(i * size, (i + 1) * size);
  writeFileSync(
    path.join(DEMAND, 'shards', `gold-audit-full-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}
console.log(JSON.stringify({ rows: rows.length, shards: SHARDS, withGold: rows.filter((row) => !row.no_oracle).length }));
