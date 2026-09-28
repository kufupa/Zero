#!/usr/bin/env tsx
/**
 * Parser floor/ceiling needed flags for 980 candidates. Counts on stdout. No PII.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  EVAL_TOOL_CATALOGUE,
  parseNeededTools,
  type EvalToolId,
  type NeededMap,
} from '../../../../../apps/server-pilot/src/ops/centurion-eval-lab.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DEMAND = path.join(ROOT, '.private/centurion-corpus/centurion-tool-demand-20260919');
const SNAP = path.join(
  ROOT,
  '.private/connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
);

function loadJsonl(filePath: string) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function bump(map: Record<string, number>, key: string, n = 1) {
  map[key] = (map[key] || 0) + n;
}

const byId = new Map(loadJsonl(SNAP).map((row) => [String(row.id), row]));
const attachByInbound = new Map<string, string>();
for (let i = 0; i < 5; i += 1) {
  for (const row of loadJsonl(path.join(DEMAND, `shards/pass6-${i}-bodies.jsonl`))) {
    const texts = ((row.artifacts as Array<{ textExtract?: string }>) || [])
      .map((item) => item.textExtract || '')
      .join('\n');
    if (texts.trim()) attachByInbound.set(String(row.inboundId), texts.slice(0, 8000));
  }
}

const extracts = loadJsonl(path.join(DEMAND, 'extracts/all-inbound-demand.jsonl'));
const floorCounts: Record<string, number> = Object.fromEntries(EVAL_TOOL_CATALOGUE.map((tool) => [tool, 0]));
const ceilingCounts: Record<string, number> = Object.fromEntries(EVAL_TOOL_CATALOGUE.map((tool) => [tool, 0]));
const rows: Array<{ inboundId: string; decision: unknown; floor: NeededMap; ceiling: NeededMap }> = [];
let candidates = 0;

for (const row of extracts) {
  if (row.decision === 'skip') continue;
  candidates += 1;
  const inboundId = String(row.inboundId);
  const mail = byId.get(inboundId);
  const inbound = (row as { inbound?: { subject?: string; textBody?: string } }).inbound;
  const text = `${mail?.subject || inbound?.subject || ''}\n${mail?.textBody || inbound?.textBody || ''}`;
  const parsed = parseNeededTools(text, { attachmentText: attachByInbound.get(inboundId) || '' });
  for (const tool of EVAL_TOOL_CATALOGUE) {
    if (parsed.floor[tool]) bump(floorCounts, tool);
    if (parsed.ceiling[tool]) bump(ceilingCounts, tool);
  }
  rows.push({ inboundId, decision: row.decision, floor: parsed.floor, ceiling: parsed.ceiling });
}

const truthDir = path.join(DEMAND, 'truth');
const extractsDir = path.join(DEMAND, 'extracts');
mkdirSync(truthDir, { recursive: true, mode: 0o700 });
mkdirSync(extractsDir, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(extractsDir, 'parser-needed.jsonl'),
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  { mode: 0o600 },
);
const summary = {
  denominator: `${candidates} candidate inbounds`,
  candidates,
  parserFloor: floorCounts,
  parserCeiling: ceilingCounts,
};
writeFileSync(path.join(truthDir, 'parser-needed.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
