#!/usr/bin/env node
/** Merge gold-oracle JSONL. Counts on stdout. No PII. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2];
if (!PASS) throw new Error('pass required e.g. gold-oracle');

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

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const ENUM = new Set([
  'confirmationNumber',
  'guestName',
  'arrival',
  'departure',
  'adults',
  'children',
  'paxTotal',
  'roomType',
  'rateCode',
  'amount',
  'attachmentName',
  'cancelReason',
  'occupancy',
  'roomQty',
  'groupName',
  'rateQuoted',
  'status',
  'docType',
]);

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + 1;
}

function asFieldMap(value, quotes, side) {
  const fromQuotes = {};
  for (const quote of quotes) {
    if (quote.side !== side) continue;
    if (!ENUM.has(quote.field)) continue;
    const text = String(quote.quote || '').trim();
    if (text.length >= 2 && text.length <= 80) fromQuotes[quote.field] = text;
  }
  if (!value || typeof value !== 'object') return fromQuotes;
  if (Array.isArray(value)) {
    const fieldish = value.length && value.every((item) => ENUM.has(String(item)));
    if (fieldish) {
      const picked = {};
      for (const field of value) {
        if (fromQuotes[field]) picked[field] = fromQuotes[field];
      }
      return Object.keys(picked).length ? picked : fromQuotes;
    }
    return fromQuotes;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENUM.has(key)) continue;
    const text = item == null ? '' : String(item).trim();
    if (text.length >= 2 && text.length <= 80) out[key] = text;
  }
  return Object.keys(out).length ? out : fromQuotes;
}

function coerceQuotes(quotes) {
  return (Array.isArray(quotes) ? quotes : [])
    .map((item) => ({
      field: String(item?.field || ''),
      side: item?.side === 'gold' ? 'gold' : 'inbound',
      quote: String(item?.quote || item?.text || '').trim(),
    }))
    .filter((item) => ENUM.has(item.field) && item.quote.length >= 2 && item.quote.length <= 80);
}

const incoming = [];
for (let i = 0; i < 7; i += 1) {
  incoming.push(...loadJsonl(path.join(DEMAND, 'extracts', `${PASS}-${i}.jsonl`)));
}
const priorPath = path.join(DEMAND, 'extracts', `${PASS}-canonical.jsonl`);
const merged = new Map(loadJsonl(priorPath).map((row) => [row.inboundId || row.goldId, row]));
const staffUsed = {};
let quoteRows = 0;
let unresolvedQuotes = 0;

for (const row of incoming) {
  const id = row.inboundId || row.goldId;
  if (!id) continue;
  const incomingStaff = row.staffUsed || row.needed || {};
  const staff = {};
  for (const tool of CAT) {
    const bool = incomingStaff[tool] === true;
    staff[tool] = bool;
    if (bool) bump(staffUsed, tool);
  }
  const quotes = coerceQuotes(row.quotes);
  if (quotes.length) quoteRows += 1;
  unresolvedQuotes += (row.unresolvedFields || []).length;
  const request = asFieldMap(row.request, quotes, 'inbound');
  const usedResult = asFieldMap(row.usedResult, quotes, 'gold');
  for (const key of ['confirmationNumber', 'guestName', 'arrival', 'departure']) {
    if (request[key] && usedResult[key] && String(request[key]) === String(usedResult[key])) {
      delete usedResult[key];
    }
  }
  const interesting = Object.keys(usedResult).filter((key) => request[key] == null);
  merged.set(id, {
    inboundId: row.inboundId || null,
    goldId: row.goldId || null,
    pile: row.pile || PASS,
    staffUsed: staff,
    quotes,
    request,
    usedResult,
    staffFilledAbsentFromInbound: interesting,
    unresolvedFields: row.unresolvedFields || [],
    policy: row.policy || null,
    pass: PASS,
  });
}

mkdirSync(path.join(DEMAND, 'extracts'), { recursive: true, mode: 0o700 });
writeFileSync(
  priorPath,
  `${[...merged.values()].map((row) => JSON.stringify(row)).join('\n')}\n`,
  { mode: 0o600 },
);
writeFileSync(
  path.join(DEMAND, 'truth', `${PASS}-staff-used-counts.json`),
  `${JSON.stringify({ pass: PASS, rows: merged.size, staffUsed, quoteRows, unresolvedQuotes }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify({ pass: PASS, incoming: incoming.length, merged: merged.size, staffUsed, quoteRows }));
