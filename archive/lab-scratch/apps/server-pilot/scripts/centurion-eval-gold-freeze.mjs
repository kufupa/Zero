#!/usr/bin/env node
/**
 * Write staff-used.json + call-graph.json. Never rewrite neededCount integers.
 * Counts on stdout. No PII.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const ROOT = path.resolve(DEMAND, '../../..');
const ALWAYS = new Set(['hms_find_reservation', 'hms_read_reservation']);
const LIST_ALIAS = ['hms_list_documents', 'documents_list_existing'];

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

function mergeStaffUsedWithoutTouchingNeeded(needed, staffUsed) {
  const out = {};
  for (const [tool, row] of Object.entries(needed)) {
    if (!row || typeof row !== 'object' || !('neededCount' in row)) continue;
    out[tool] = { ...row, neededCount: row.neededCount, staffUsedCount: staffUsed[tool] || 0 };
  }
  return out;
}

function buildCallGraph({ ask, staffUsed }) {
  const tools = new Set([...Object.keys(ask), ...Object.keys(staffUsed)]);
  const graph = {};
  for (const tool of tools) {
    graph[tool] = {
      ask: ask[tool] ?? 0,
      staffUsed: staffUsed[tool] ?? 0,
      alwaysInStack: ALWAYS.has(tool),
    };
  }
  return graph;
}

const needed = loadJson(path.join(DEMAND, 'truth/needed-count.json'));
const priorNeeded = structuredClone(needed);
const goldRows = loadJsonl(path.join(DEMAND, 'extracts/gold-oracle-canonical.jsonl'));
const outOnly = loadJsonl(path.join(DEMAND, 'extracts/outbound-only-canonical.jsonl'));
const staffUsed = {};
for (const row of [...goldRows, ...outOnly]) {
  for (const [tool, value] of Object.entries(row.staffUsed || {})) {
    if (value) staffUsed[tool] = (staffUsed[tool] || 0) + 1;
  }
}
const merged = mergeStaffUsedWithoutTouchingNeeded(needed, staffUsed);
for (const tool of Object.keys(priorNeeded)) {
  if (priorNeeded[tool]?.neededCount !== merged[tool]?.neededCount) {
    throw new Error(`neededCount mutated for ${tool}`);
  }
}

const ask = {};
for (const [tool, row] of Object.entries(needed)) {
  if (row && typeof row === 'object' && typeof row.neededCount === 'number') ask[tool] = row.neededCount;
}
const graph = buildCallGraph({ ask, staffUsed });
const pairedDenom = goldRows.length;
const outboundOnlyDenom = outOnly.length;

mkdirSync(path.join(DEMAND, 'truth'), { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(DEMAND, 'truth/staff-used.json'),
  `${JSON.stringify(
    {
      denominatorPaired: `${pairedDenom} paired gold inbounds`,
      denominatorOutboundOnly: `${outboundOnlyDenom} outbound_only golds`,
      note: 'Do not add to 980. Do not replace neededCount.',
      staffUsed,
      listDocumentsAlias: LIST_ALIAS,
      listDocumentsRolledUp: LIST_ALIAS.reduce((n, tool) => n + (staffUsed[tool] || 0), 0),
      rows: merged,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
writeFileSync(path.join(DEMAND, 'truth/call-graph.json'), `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });

const docsPath = path.join(ROOT, 'docs/infor-hms/centurion-eval-lab-counts.md');
let docs = readFileSync(docsPath, 'utf8');
const extra = [
  '## Staff-used (gold oracle)',
  '',
  `Denom paired: **${pairedDenom}**. Denom outbound_only: **${outboundOnlyDenom}**. Not added to 980.`,
  'Metric: staff reply used this verb. `hms_list_documents` ≡ `documents_list_existing` (alias, no id merge).',
  'Call-graph: find+read `alwaysInStack` on existing-stay work even when ask is 16/17.',
  '',
  '| staffUsed | ask | alwaysInStack | tool |',
  '| ---: | ---: | --- | --- |',
];
for (const [tool, row] of Object.entries(graph).sort((a, b) => b[1].staffUsed - a[1].staffUsed || a[0].localeCompare(b[0]))) {
  extra.push(`| ${row.staffUsed} | ${row.ask} | ${row.alwaysInStack ? 'yes' : ''} | \`${tool}\` |`);
}
extra.push('');
if (docs.includes('## Staff-used (gold oracle)')) {
  docs = docs.replace(/## Staff-used \(gold oracle\)[\s\S]*$/, extra.join('\n'));
} else {
  docs = `${docs.trimEnd()}\n\n${extra.join('\n')}\n`;
}
writeFileSync(docsPath, docs);

console.log(
  JSON.stringify({
    paired: pairedDenom,
    outboundOnly: outboundOnlyDenom,
    findAsk: ask.hms_find_reservation,
    findStaff: staffUsed.hms_find_reservation || 0,
    neededUntouched: true,
  }),
);
