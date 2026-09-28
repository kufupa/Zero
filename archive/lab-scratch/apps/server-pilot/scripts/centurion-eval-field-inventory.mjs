#!/usr/bin/env node
/** Field inventory from canonical quotes. Counts on stdout. No PII. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const TOOLS = ['hms_quote_stay', 'hms_group_block_read', 'hms_cancel_reservation', 'mail_read_artifact'];

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const rows = [
  ...loadJsonl(path.join(DEMAND, 'extracts/gold-oracle-canonical.jsonl')),
  ...loadJsonl(path.join(DEMAND, 'extracts/outbound-only-canonical.jsonl')),
];
const inventory = {};
for (const tool of TOOLS) {
  const inbound = {};
  const gold = {};
  let n = 0;
  for (const row of rows) {
    if (!row.staffUsed?.[tool] && !row.needed?.[tool]) continue;
    n += 1;
    for (const quote of row.quotes || []) {
      const bucket = quote.side === 'gold' ? gold : inbound;
      bucket[quote.field] = (bucket[quote.field] || 0) + 1;
    }
    for (const key of Object.keys(row.request || {})) inbound[key] = (inbound[key] || 0) + 1;
    for (const key of Object.keys(row.usedResult || {})) gold[key] = (gold[key] || 0) + 1;
  }
  inventory[tool] = { rows: n, inboundFields: inbound, goldFields: gold };
}
mkdirSync(path.join(DEMAND, 'truth'), { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(DEMAND, 'truth/field-inventory-quote-group-cancel-artifact.json'),
  `${JSON.stringify({ note: 'corpus field frequency, not HMS Zod', inventory }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify({ tools: TOOLS, rows: rows.length, inventory: Object.fromEntries(TOOLS.map((tool) => [tool, inventory[tool].rows])) }));
