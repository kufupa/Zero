#!/usr/bin/env node
/** Counts-only QA of lab proposedActions. No bodies on stdout. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LAB_FREEZE_TOOL_IDS = [
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

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const index = JSON.parse(readFileSync(path.join(DEMAND, 'lab/index.json'), 'utf8'));
const freeze = new Set(LAB_FREEZE_TOOL_IDS);
const byTool = {};
for (const id of LAB_FREEZE_TOOL_IDS) byTool[id] = { n: 0, withLive: 0, empty: 0, sample: [] };

let unknownTool = 0;
let yearQty = 0;
let arrayDept = 0;
let pdfSoup = 0;
let staffDid = 0;
let noStaffDidLive = 0;

for (const row of index.rows || []) {
  const acts = Array.isArray(row.proposedActions) ? row.proposedActions : [];
  const live = acts.filter((a) => a && (a.status === 'live' || a.status === 'needs_human'));
  if (String(row.attachmentText || '').trimStart().startsWith('%PDF')) pdfSoup += 1;
  const used = row.usedResult && typeof row.usedResult === 'object' && !Array.isArray(row.usedResult) ? row.usedResult : {};
  const usedKeys = Object.keys(used).filter((k) => used[k] != null && String(used[k]).trim() !== '');
  if (usedKeys.length) staffDid += 1;
  else if (live.length) noStaffDidLive += 1;
  for (const a of acts) {
    if (!a || !a.tool) continue;
    if (!freeze.has(a.tool)) unknownTool += 1;
    const qty = a.request?.roomQty;
    if (qty != null && /^(?:19|20)\d{2}$/.test(String(qty).trim())) yearQty += 1;
    if (Array.isArray(a.request?.departure)) arrayDept += 1;
  }
  const tools = new Set([...(row.tools || []), ...acts.map((a) => a?.tool).filter(Boolean)]);
  if (row.needed) {
    for (const [tool, wanted] of Object.entries(row.needed)) {
      if (wanted) tools.add(tool);
    }
  }
  for (const tool of tools) {
    if (!byTool[tool]) continue;
    byTool[tool].n += 1;
    if (live.some((a) => a.tool === tool)) byTool[tool].withLive += 1;
    if (acts.length === 0) byTool[tool].empty += 1;
    if (byTool[tool].sample.length < 20) byTool[tool].sample.push(String(row.inboundId));
  }
}

const out = {
  rows: index.rows.length,
  unknownTool,
  yearQty,
  arrayDept,
  pdfSoup,
  staffDid,
  noStaffDidLive,
  folders: Object.fromEntries(
    Object.entries(byTool).map(([id, v]) => [id, { n: v.n, withLive: v.withLive, empty: v.empty, sampleN: v.sample.length }]),
  ),
};
console.log(JSON.stringify(out));
const reviewDir = path.join(DEMAND, 'review');
mkdirSync(reviewDir, { recursive: true });
writeFileSync(path.join(reviewDir, 'product-loop-4.json'), `${JSON.stringify({ ...out, samples: Object.fromEntries(Object.entries(byTool).map(([id, v]) => [id, v.sample])) }, null, 2)}\n`);
