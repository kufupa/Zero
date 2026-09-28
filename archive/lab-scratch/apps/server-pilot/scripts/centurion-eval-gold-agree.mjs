#!/usr/bin/env node
/** goldAgree = 0 disagreements. Counts on stdout. No PII. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const FOCUS = [
  'hms_quote_stay',
  'hms_group_block_read',
  'hms_cancel_reservation',
  'mail_read_artifact',
  'hms_generate_invoice',
  'hms_email_folio',
];

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const rows = [];
for (let i = 0; i < 7; i += 1) {
  rows.push(...loadJsonl(path.join(DEMAND, 'extracts', `gold-audit-${i}.jsonl`)));
}
let agree = 0;
const disagrees = [];
for (const row of rows) {
  const ok = row.goldAgree === true;
  if (ok) agree += 1;
  else disagrees.push({ inboundId: row.inboundId, focus: FOCUS.filter((tool) => row.neededAgree?.[tool] === false || row.staffUsedAgree?.[tool] === false) });
}
const summary = {
  rows: rows.length,
  agree,
  disagree: disagrees.length,
  goldAgree: rows.length && disagrees.length === 0 ? '100%' : rows.length ? `${((agree / rows.length) * 100).toFixed(1)}%` : 'n/a',
};
mkdirSync(path.join(DEMAND, 'truth'), { recursive: true, mode: 0o700 });
writeFileSync(path.join(DEMAND, 'truth/gold-audit-30.json'), `${JSON.stringify({ ...summary, disagrees }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary));
