#!/usr/bin/env node
/** Collate proposed-*.jsonl onto lab index. Counts on stdout. No bodies. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2] || 'proposed';
const indexPath = path.join(DEMAND, 'lab/index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const byId = new Map();
for (let i = 0; i < 7; i += 1) {
  const file = path.join(DEMAND, 'extracts', `${PASS}-${i}.jsonl`);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (row.inboundId && Array.isArray(row.proposedActions)) byId.set(String(row.inboundId), row);
    } catch {
      /* skip junk line */
    }
  }
}
function remainingWrite(row) {
  if (Array.isArray(row.stayAsks) && row.stayAsks.length > 0) return true;
  const needed = row.needed && typeof row.needed === 'object' ? Object.values(row.needed) : [];
  return needed.some(Boolean);
}

let patched = 0;
let lunaEmptyKeptDerived = 0;
for (const row of index.rows || []) {
  const hit = byId.get(String(row.inboundId));
  if (!hit) continue;
  const otherDesk = Boolean(row.otherDesk) || row.threadOutcome === 'other_desk';
  if (
    Array.isArray(hit.proposedActions) &&
    hit.proposedActions.length === 0 &&
    !otherDesk &&
    remainingWrite(row)
  ) {
    lunaEmptyKeptDerived += 1;
    continue;
  }
  row.proposedActions = hit.proposedActions;
  if (hit.skipReason) row.skipReason = hit.skipReason;
  patched += 1;
}
writeFileSync(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({ rows: index.rows.length, patched, extracted: byId.size, lunaEmptyKeptDerived }),
);
