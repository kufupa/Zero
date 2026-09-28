#!/usr/bin/env node
/**
 * Freeze one neededCount per catalogue tool.
 * 95-met when Luna covered >=98% of 980 AND |luna-parserCeiling|/N < 0.02,
 * or after disagreement reread the count moved <2%.
 * Unresolved tools print parserFloor only — no fake integer. Counts on stdout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const ROOT = path.resolve(DEMAND, '../../..');

const CAT = [
  'hms_find_reservation',
  'hms_read_reservation',
  'hms_read_notes_traces',
  'mail.send_with_attachments',
  'hms_attach_guest_stay_document',
  'hms_list_documents',
  'mail_read_artifact',
  'documents_read_existing',
  'documents_list_existing',
  'hms_send_reservation_confirmation',
  'hms_quote_stay',
  'hms_generate_confirmation_proforma',
  'hms_generate_quote_document',
  'hms_group_block_read',
  'hms_amend_reservation',
  'hms_create_reservation',
  'hms_cancel_reservation',
  'hms_read_folio',
  'hms_post_payment',
  'hms_generate_invoice',
  'hms_email_folio',
  'hms_refund',
  'hms_company_account_read',
  'hms_event_read',
  'property_read_knowledge',
  'mail_parse_channel_payload',
  'hms_sent_email_audit',
];

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

const parser = loadJson(path.join(DEMAND, 'truth/parser-needed.json'));
const n = Number(parser.candidates) || 980;
const lunaRows = loadJsonl(path.join(DEMAND, 'extracts/needed-canonical.jsonl'));
const REREAD = process.argv.includes('--reread');
const touchedArg = process.argv.find((arg) => arg.startsWith('--touched='));
const touched = new Set(
  touchedArg
    ? touchedArg
        .slice('--touched='.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [],
);
const priorPath = path.join(DEMAND, 'truth/needed-count.json');
const prior = existsSync(priorPath) ? loadJson(priorPath) : {};

const lunaCounts = {};
const lunaCovered = {};
for (const tool of CAT) {
  lunaCounts[tool] = 0;
  lunaCovered[tool] = 0;
}
for (const row of lunaRows) {
  for (const tool of CAT) {
    if (row.needed && Object.prototype.hasOwnProperty.call(row.needed, tool)) {
      lunaCovered[tool] += 1;
      if (row.needed[tool]) lunaCounts[tool] += 1;
    }
  }
}

const out = {
  denominator: `${n} candidate inbounds`,
  candidates: n,
  lunaRows: lunaRows.length,
};
for (const tool of CAT) {
  const parserFloor = parser.parserFloor?.[tool] || 0;
  const parserCeiling = parser.parserCeiling?.[tool] || 0;
  const covered = lunaCovered[tool];
  const luna = covered ? lunaCounts[tool] : null;
  const coverage = covered / n;
  const delta = luna == null ? 1 : Math.abs(luna - parserCeiling) / n;
  const priorLuna = typeof prior[tool]?.luna === 'number' ? prior[tool].luna : null;
  const moved = priorLuna == null || luna == null ? 1 : Math.abs(luna - priorLuna) / n;
  const coverageOk = coverage >= 0.98;
  const agreeOk = luna != null && delta < 0.02;
  const stableOk =
    REREAD && touched.has(tool) && priorLuna != null && luna != null && moved < 0.02;
  const inherited =
    REREAD &&
    touched.size > 0 &&
    !touched.has(tool) &&
    prior[tool]?.threshold95 === 'met' &&
    priorLuna === luna;
  const met = coverageOk && (agreeOk || stableOk || inherited);
  const neededCount = met ? luna : null;
  out[tool] = {
    neededCount,
    parserFloor,
    parserCeiling,
    luna,
    lunaCovered: covered,
    disagreementRate: Number(delta.toFixed(4)),
    moveRate: Number(moved.toFixed(4)),
    threshold95: met ? 'met' : 'not_met',
  };
  if (!met) out[tool].unresolved = true;
}

mkdirSync(path.join(DEMAND, 'truth'), { recursive: true, mode: 0o700 });
writeFileSync(path.join(DEMAND, 'truth/needed-count.json'), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });

const lines = [
  '# Centurion neededCount (one integer per tool)',
  '',
  `Denominator: **${n} candidate inbounds** (1069 − skip). Window Sep 9–18 16:50 JHB.`,
  'Metric: inbound requires this verb (stack OK).',
  '',
  '| neededCount | tool | 95 |',
  '| ---: | --- | --- |',
];
for (const tool of CAT) {
  const row = out[tool];
  const nVal = row.neededCount == null ? `unresolved (floor ${row.parserFloor})` : String(row.neededCount);
  lines.push(`| ${nVal} | \`${tool}\` | ${row.threshold95} |`);
}
lines.push('');
writeFileSync(path.join(ROOT, 'docs/infor-hms/centurion-eval-lab-counts.md'), `${lines.join('\n')}\n`);
console.log(
  JSON.stringify({
    candidates: n,
    lunaRows: lunaRows.length,
    met: CAT.filter((t) => out[t].threshold95 === 'met').length,
    unresolved: CAT.filter((t) => out[t].threshold95 !== 'met').length,
  }),
);
