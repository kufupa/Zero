/** View-only Centurion demand eval lab helpers. Synthetic fixtures only in tests. */

import { LAB_FREEZE_TOOL_IDS as LAB_TOOL_FOLDER_IDS, labReviewSchemaFor } from './centurion-eval-schemas';
import { fillQuoteFromReadText, isAvailabilityPing, routeQuoteRequest } from './quote-stay-route';

export {
  EMPTY_LAB_REVIEW_SCHEMA,
  LAB_FREEZE_TOOL_IDS,
  LAB_REVIEW_SCHEMAS,
  labReviewSchemaFor,
  type JsonSchemaLike,
  type LabFreezeToolId,
  type LabReviewSchema,
} from './centurion-eval-schemas';

export const THREAD_OUTCOMES = [
  'gold_human',
  'gold_channel_auto',
  'gold_pairing_miss',
  'other_desk',
  'no_reply_owed',
  'window_cutoff',
  'ingest_recovered',
  'true_gap',
] as const;

export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number];

export const THREAD_OUTCOME_COPY: Record<ThreadOutcome, string> = {
  gold_human: 'Centurion wrote a human gold reply in the window.',
  gold_channel_auto: 'Channel-auto / template gold exists on this thread (still a response).',
  gold_pairing_miss: 'A later or sibling Centurion outbound exists; 1:1 pairing missed it.',
  other_desk: 'Martha, Kamala, or Penny handled this (label, not a Centurion miss).',
  no_reply_owed: 'No Centurion@ reply owed (thanks, FYI, OTA-already-created, or processed in HMS).',
  window_cutoff: 'Inbound landed at the snapshot cutoff; a reply may exist after 18 Sep 16:50 JHB.',
  ingest_recovered: 'Was parse_failure ingest; re-pair after recover rather than treating as a gap.',
  true_gap: 'No handling found after pairing, auto-gold, other-desk, and no-reply checks. HITL only.',
};

export type LabSpan = {
  field: string;
  start: number;
  end: number;
  side: 'inbound' | 'gold';
  colorIndex?: number;
};

export type LabNeededCounts = Array<{
  tool: string;
  neededCount: number | 'unresolved';
  staffUsedCount?: number;
  parserFloor?: number;
  threshold95?: 'met' | 'not_met';
}>;

export type LabRow = {
  inboundId: string;
  threadId: string | null;
  tools: string[];
  needed?: Record<string, boolean>;
  staffUsed?: Record<string, boolean>;
  threadOutcome: ThreadOutcome;
  threadOutcomeCopy: string;
  channelAuto: boolean;
  otherDesk: string | null;
  demandFamily: string | null;
  facetChips?: string[];
  primaryVerb?: string | null;
  inbound: { subject: string | null; textBody: string; from?: unknown; to?: unknown };
  gold: { id: string | null; subject: string | null; textBody: string; channelAuto: boolean } | null;
  request: Record<string, unknown>;
  usedResult: Record<string, unknown> | unknown[];
  staffFilledAbsentFromInbound: string[];
  spans: LabSpan[];
  attachmentRefs: Array<{ filename: string | null; contentType: string | null; byteSize: number | null }>;
  priorInbounds?: Array<{ id: string; subject: string | null; textBody: string }>;
  attachmentText?: string;
  stayAsks?: StayAsk[];
  proposedActions?: ProposedAction[];
};

export type StayAsk = {
  arrival?: string;
  departure?: string;
  roomQty?: number;
  roomType?: string;
};

export type ProposedActionStatus = 'live' | 'done' | 'superseded' | 'needs_human';

export type ProposedAction = {
  tool: string;
  title: string;
  status: ProposedActionStatus;
  colorIndex: number;
  request: Record<string, unknown>;
};

export const ACTION_PALETTE = [
  { mark: '#fbbf24', ink: '#78350f' },
  { mark: '#2dd4bf', ink: '#115e59' },
  { mark: '#c4b5fd', ink: '#5b21b6' },
  { mark: '#a3e635', ink: '#3f6212' },
] as const;

const PROPOSED_VERBS: Record<string, string> = {
  hms_quote_stay: 'Quote stay',
  hms_find_reservation: 'Find reservation',
  hms_read_reservation: 'Read reservation',
  hms_read_notes_traces: 'Read notes',
  hms_read_folio: 'Read folio',
  hms_create_reservation: 'Create reservation',
  hms_amend_reservation: 'Amend reservation',
  hms_cancel_reservation: 'Cancel reservation',
  hms_group_block_read: 'Read group block',
  hms_company_account_read: 'Read company',
  hms_event_read: 'Read event',
};

export function proposedVerb(tool: string): string {
  return PROPOSED_VERBS[tool] || labReviewSchemaFor(tool).title || tool;
}

function compactDate(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(iso[3])} ${months[Number(iso[2]) - 1]}`;
  }
  const match = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?/);
  if (!match) return text;
  return `${match[1]} ${match[2].slice(0, 3)}`;
}

export function proposedActionFacts(request: Record<string, unknown>): string {
  const qty = request.roomQty;
  const type = request.roomType ? String(request.roomType).toLowerCase() : '';
  const rooms = qty != null && qty !== '' ? `${qty}${type ? ` ${type}` : ''}` : type;
  const arr = compactDate(request.arrival);
  const dep = compactDate(request.departure);
  const stay = arr && dep ? `${arr}–${dep}` : arr || dep;
  const conf = request.confirmationNumber ? String(request.confirmationNumber) : '';
  const adults = request.adults != null && request.adults !== '' ? `${request.adults} pax` : '';
  return [rooms, stay, adults, conf].filter(Boolean).join(' · ');
}

export function coerceProposedAction(
  raw: Partial<ProposedAction> | null | undefined,
  index = 0,
): ProposedAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const tool = String(raw.tool || '');
  if (!tool) return null;
  const status: ProposedActionStatus =
    raw.status === 'done' || raw.status === 'superseded' || raw.status === 'needs_human' ? raw.status : 'live';
  const colorIndex = Number.isFinite(raw.colorIndex) ? Math.max(0, Math.min(3, Number(raw.colorIndex))) : index % 4;
  return {
    tool,
    title: raw.title || proposedVerb(tool),
    status,
    colorIndex,
    request: coerceRequest(raw.request || {}),
  };
}

export function hasRemainingWrite(row: LabRow): boolean {
  if ((row.stayAsks || []).length > 0) return true;
  return Object.values(row.needed || {}).some(Boolean);
}

export function shouldSkipProposed(row: LabRow): boolean {
  if (row.otherDesk || row.threadOutcome === 'other_desk') return true;
  if ((row.threadOutcome === 'no_reply_owed' || row.channelAuto) && !hasRemainingWrite(row)) return true;
  return false;
}

function listedOrDerivedProposed(row: LabRow): ProposedAction[] {
  if (Array.isArray(row.proposedActions)) {
    return row.proposedActions
      .map((item, index) => coerceProposedAction(item, index))
      .filter((item): item is ProposedAction => item != null);
  }
  if (shouldSkipProposed(row)) {
    return [];
  }
  const hay = `${row.inbound.textBody || ''}\n${row.attachmentText || ''}\n${(row.priorInbounds || []).map((item) => item.textBody).join('\n')}`;
  const asks = row.stayAsks?.length ? row.stayAsks : splitStayAsks(hay);
  const quoteWanted =
    Boolean(row.needed?.hms_quote_stay) ||
    row.staffUsed?.hms_quote_stay ||
    row.tools.includes('hms_quote_stay') ||
    asks.length > 0;
  const actions: ProposedAction[] = [];
  if (asks.length && quoteWanted) {
    for (const [index, ask] of asks.entries()) {
      actions.push({
        tool: 'hms_quote_stay',
        title: 'Quote stay',
        status: 'live',
        colorIndex: index % 4,
        request: coerceRequest(stayAskRecord(ask)),
      });
    }
  } else if (quoteWanted) {
    actions.push({
      tool: 'hms_quote_stay',
      title: 'Quote stay',
      status: 'live',
      colorIndex: 0,
      request: coerceRequest(flattenExtract(asRecord(row.request))),
    });
  }
  const already = new Set(actions.map((item) => item.tool));
  const rest = LAB_TOOL_FOLDER_IDS.filter(
    (id) => id !== 'hms_quote_stay' && (row.needed?.[id] || row.tools.includes(id)) && !already.has(id),
  );
  for (const [offset, tool] of rest.slice(0, 3).entries()) {
    actions.push({
      tool,
      title: proposedVerb(tool),
      status: 'live',
      colorIndex: (actions.length + offset) % 4,
      request: coerceRequest(flattenExtract(asRecord(row.request))),
    });
  }
  return actions;
}

export function resolveProposedActions(row: LabRow): ProposedAction[] {
  return enrichHitlProposed(row);
}

export const HITL_PRIMARY_TOOLS = [
  'hms_quote_stay',
  'hms_amend_reservation',
  'hms_create_reservation',
  'hms_cancel_reservation',
  'hms_read_folio',
  'hms_generate_invoice',
  'hms_post_payment',
  'hms_email_folio',
  'hms_refund',
  'hms_event_read',
  'hms_group_block_read',
  'hms_company_account_read',
  'hms_send_reservation_confirmation',
  'hms_generate_quote_document',
  'hms_generate_confirmation_proforma',
  'mail.send_with_attachments',
  'hms_attach_guest_stay_document',
] as const;

export const HITL_NOISY_TOOLS = new Set([
  'mail_read_artifact',
  'documents_read_existing',
  'documents_list_existing',
  'mail_parse_channel_payload',
  'hms_sent_email_audit',
  'property_read_knowledge',
  'hms_list_documents',
]);

/** Freeze needed=false for these; gold still used them. Card from tools/staffUsed. */
export const HITL_COMPANION_FROM_TOOLS = new Set([
  'hms_generate_quote_document',
  'hms_email_folio',
]);

function wantsPrimaryCard(row: LabRow, tool: string): boolean {
  if (row.needed?.[tool]) return true;
  if (HITL_PRIMARY_TOOLS.includes(tool as (typeof HITL_PRIMARY_TOOLS)[number]) && row.staffUsed?.[tool]) {
    return true;
  }
  if (HITL_COMPANION_FROM_TOOLS.has(tool) && row.tools.includes(tool)) return true;
  return false;
}

export function occupancyFromText(text: string): { adults?: number } {
  const match = text.match(
    /\b(\d{1,3})\s*(?:pax|adults?|people|guests?|delegates?|attendees?)\b/i,
  );
  if (!match) return {};
  const adults = Number(match[1]);
  if (!Number.isFinite(adults) || adults < 1 || adults > 400) return {};
  return { adults };
}

/** Early step is a small number. The rail shows the later step on top. */
export function reservationistRank(tool: string): number {
  if (tool === 'hms_find_reservation') return 10;
  if (
    tool === 'hms_read_reservation' ||
    tool === 'hms_read_notes_traces' ||
    tool === 'hms_read_folio' ||
    tool === 'hms_event_read' ||
    tool === 'hms_group_block_read' ||
    tool === 'hms_company_account_read'
  ) {
    return 20;
  }
  if (
    tool === 'hms_quote_stay' ||
    tool === 'hms_amend_reservation' ||
    tool === 'hms_create_reservation' ||
    tool === 'hms_cancel_reservation'
  ) {
    return 30;
  }
  if (
    tool === 'hms_generate_quote_document' ||
    tool === 'hms_generate_confirmation_proforma' ||
    tool === 'hms_generate_invoice' ||
    tool === 'hms_attach_guest_stay_document'
  ) {
    return 40;
  }
  if (
    tool === 'hms_send_reservation_confirmation' ||
    tool === 'hms_email_folio' ||
    tool === 'mail.send_with_attachments'
  ) {
    return 50;
  }
  if (tool === 'hms_post_payment' || tool === 'hms_refund') return 60;
  return 25;
}

export function enrichHitlProposed(row: LabRow): ProposedAction[] {
  if (row.otherDesk || row.threadOutcome === 'other_desk') return [];
  const pingSource = `${row.inbound?.textBody || ''}\n${row.attachmentText || ''}`;
  if (isAvailabilityPing(pingSource)) return [];
  const existing = listedOrDerivedProposed(row);
  const byTool = new Map<string, ProposedAction>();
  const quotes: ProposedAction[] = [];
  for (const action of existing) {
    const next =
      action.status === 'superseded' || action.status === 'needs_human'
        ? action
        : { ...action, status: 'live' as const };
    if (next.tool === 'hms_quote_stay') {
      const pingSource = `${row.inbound?.textBody || ''}\n${row.attachmentText || ''}`;
      if (!isAvailabilityPing(pingSource)) quotes.push(next);
    }
    else if (!byTool.has(next.tool)) byTool.set(next.tool, next);
  }
  const hay = `${row.inbound.textBody || ''}\n${row.attachmentText || ''}`;
  const occ = occupancyFromText(hay);
  const baseRequest = coerceRequest({ ...row.request, ...occ });
  for (const tool of HITL_PRIMARY_TOOLS) {
    if (!wantsPrimaryCard(row, tool)) continue;
    if (tool === 'hms_quote_stay' && (quotes.length || isAvailabilityPing(`${row.inbound?.textBody || ''}\n${row.attachmentText || ''}`))) continue;
    if (byTool.has(tool)) continue;
    byTool.set(tool, {
      tool,
      title: proposedVerb(tool),
      status: 'live',
      colorIndex: 0,
      request: baseRequest,
    });
  }
  const writeLive = [...quotes, ...byTool.values()].some(
    (item) =>
      (item.status === 'live' || item.status === 'needs_human') &&
      (item.tool === 'hms_quote_stay' || HITL_PRIMARY_TOOLS.includes(item.tool as (typeof HITL_PRIMARY_TOOLS)[number])),
  );
  if (writeLive) {
    for (const tool of ['hms_find_reservation', 'hms_read_reservation', 'hms_read_notes_traces'] as const) {
      if (byTool.has(tool) || quotes.some((item) => item.tool === tool)) continue;
      const fromQuote = quotes.length > 0 && tool !== 'hms_read_notes_traces';
      if (row.needed?.[tool] || row.tools.includes(tool) || Boolean(row.staffUsed?.[tool]) || fromQuote) {
        byTool.set(tool, {
          tool,
          title: proposedVerb(tool),
          status: 'live',
          colorIndex: 0,
          request: baseRequest,
        });
      }
    }
  }
  let merged = [...quotes, ...byTool.values()];
  const primaryLive = merged.filter(
    (item) =>
      (item.status === 'live' || item.status === 'needs_human') && !HITL_NOISY_TOOLS.has(item.tool),
  );
  if (primaryLive.length) {
    merged = merged.filter((item) => !HITL_NOISY_TOOLS.has(item.tool));
  }
  merged.sort((left, right) => reservationistRank(right.tool) - reservationistRank(left.tool));
  const asks = row.stayAsks?.length ? row.stayAsks : splitStayAsks(hay);
  const filled = merged.map((item, index) => {
    const request = { ...item.request };
    if (request.adults == null && occ.adults != null) request.adults = occ.adults;
    const quoteSource = [
      row.inbound?.textBody || '',
      row.attachmentText || '',
      row.gold?.textBody || '',
      ...(row.priorInbounds || []).map((prior) => prior.textBody || ''),
    ].join('\n');
    const routed =
      item.tool === 'hms_quote_stay' ? fillQuoteFromReadText(routeQuoteRequest(request), quoteSource) : request;
    return { ...item, request: routed, colorIndex: index % 4 };
  });
  const liveQuotes = filled.filter((item) => item.tool === 'hms_quote_stay' && item.status === 'live');
  if (asks.length > 1 && liveQuotes.length === asks.length) {
    liveQuotes.forEach((item, askIndex) => {
      const ask = stayAskRecord(asks[askIndex]);
      const request = { ...item.request };
      if (!request.arrival && ask.arrival) request.arrival = ask.arrival;
      if (!request.departure && ask.departure) request.departure = ask.departure;
      item.request = request;
    });
  }
  return filled;
}

export type LabIndex = {
  generated: string;
  rows: LabRow[];
  neededCounts?: LabNeededCounts;
  denominator?: string;
};

export function sortRequiredFirst(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): string[] {
  const requiredSet = new Set(required);
  const keys = Object.keys(properties);
  return [...keys.filter((key) => requiredSet.has(key)), ...keys.filter((key) => !requiredSet.has(key))];
}

export const GOLD_FIELD_ENUM = [
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
] as const;

const GOLD_FIELD_SET = new Set<string>(GOLD_FIELD_ENUM);

const DATE_TOKEN_RE =
  /\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;
const ARRIVE_BLOCK_RE =
  /Arrive(?:d|l)?\s*:?\s*([^\n]+)\s*Depart(?:ure)?\s*:?\s*([^\n]+)\s*Rooms?\s*:?\s*(\d{1,2})\s*([A-Za-z][A-Za-z ]{0,20})?/gi;
const CHECKIN_BLOCK_RE =
  /Check[\s-]?in\s*:?\s*([^\n]+?)\s*Check[\s-]?out\s*:?\s*([^\n]+)/gi;
const FROM_TO_RE =
  /(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:\s+\d{4})?)\s+(?:to|until|–|-)\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{4})/gi;

export function coerceRoomQty(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) return undefined;
  const raw = String(value).trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 40) return undefined;
  if (/^(?:19|20)\d{2}$/.test(raw)) return undefined;
  return n;
}

export function coerceScalarDate(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) return undefined;
  const text = String(value).trim();
  if (!text || text.startsWith('[')) return undefined;
  const token = text.match(DATE_TOKEN_RE)?.[0];
  return token || (/\d/.test(text) && text.length <= 40 ? text : undefined);
}

export function splitStayAsks(text: string): StayAsk[] {
  const asks: StayAsk[] = [];
  const seen = new Set<string>();
  const body = text || '';
  const push = (ask: StayAsk) => {
    const key = `${ask.arrival || ''}|${ask.departure || ''}|${ask.roomQty ?? ''}`;
    if (!ask.arrival && !ask.departure && ask.roomQty == null) return;
    if (seen.has(key)) return;
    seen.add(key);
    asks.push(ask);
  };
  for (const match of body.matchAll(ARRIVE_BLOCK_RE)) {
    push({
      ...(coerceScalarDate(match[1]) ? { arrival: coerceScalarDate(match[1]) } : {}),
      ...(coerceScalarDate(match[2]) ? { departure: coerceScalarDate(match[2]) } : {}),
      ...(coerceRoomQty(match[3]) != null ? { roomQty: coerceRoomQty(match[3]) } : {}),
      ...(String(match[4] || '').trim() ? { roomType: String(match[4]).trim() } : {}),
    });
  }
  for (const match of body.matchAll(CHECKIN_BLOCK_RE)) {
    push({
      ...(coerceScalarDate(match[1]) ? { arrival: coerceScalarDate(match[1]) } : {}),
      ...(coerceScalarDate(match[2]) ? { departure: coerceScalarDate(match[2]) } : {}),
    });
  }
  for (const match of body.matchAll(FROM_TO_RE)) {
    const departure = coerceScalarDate(match[2]);
    let arrival = coerceScalarDate(match[1]);
    if (!arrival && match[1] && departure) {
      const year = String(departure).match(/\d{4}/)?.[0];
      arrival = year ? coerceScalarDate(`${match[1]} ${year}`) : undefined;
    }
    push({
      ...(arrival ? { arrival } : {}),
      ...(departure ? { departure } : {}),
    });
  }
  return asks;
}

export function stayAskRecord(ask: StayAsk | null | undefined): Record<string, unknown> {
  if (!ask) return {};
  return {
    ...(ask.arrival ? { arrival: ask.arrival } : {}),
    ...(ask.departure ? { departure: ask.departure } : {}),
    ...(ask.roomQty != null ? { roomQty: ask.roomQty } : {}),
    ...(ask.roomType ? { roomType: ask.roomType } : {}),
  };
}

export function coerceRequest(request: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'roomQty') {
      const qty = coerceRoomQty(value);
      if (qty != null) out.roomQty = qty;
      continue;
    }
    if (key === 'arrival' || key === 'departure') {
      const date = coerceScalarDate(value);
      if (date) out[key] = date;
      continue;
    }
    if (Array.isArray(value)) continue;
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

const QUOTED_HISTORY_RE =
  /\n(?:From:\s|-----Original Message-----|_{3,}.*Forwarded|On .{8,120} wrote:)/i;

export function splitQuotedHistory(text: string): { staff: string; quoted: string | null } {
  const raw = text || '';
  const match = QUOTED_HISTORY_RE.exec(raw);
  if (!match || match.index < 8) return { staff: raw, quoted: null };
  const staff = raw.slice(0, match.index).trim();
  const quoted = raw.slice(match.index).trim();
  if (!staff) return { staff: raw, quoted: null };
  return { staff, quoted: quoted || null };
}

export function stripQuotedHistory(text: string): string {
  return splitQuotedHistory(text).staff;
}

export function normalizeDateSpanQuote(field: string, quote: string): string {
  if (field !== 'arrival' && field !== 'departure') return quote;
  return quote.replace(/^\s*[*\-•\t ]*(?:check[\s-]?in|check[\s-]?out)\s*:\s*/i, '').trim();
}

export function interestingFacts(fields: readonly string[] | null | undefined): string[] {
  return (fields || []).filter((field) => GOLD_FIELD_SET.has(field));
}

export function spansForPaint(spans: readonly LabSpan[], tool: string): LabSpan[] {
  const schema = labReviewSchemaFor(tool);
  const allowed = new Set([
    ...Object.keys(schema.input.properties ?? {}),
    ...Object.keys(schema.output.properties ?? {}),
    'channelAuto',
  ]);
  return spans.filter((span) => span.field === 'channelAuto' || (GOLD_FIELD_SET.has(span.field) && allowed.has(span.field)));
}

export function rewriteDateSpans(text: string, spans: readonly LabSpan[]): LabSpan[] {
  return spans.map((span) => {
    if (span.field !== 'arrival' && span.field !== 'departure') return span;
    const raw = text.slice(span.start, span.end);
    const norm = normalizeDateSpanQuote(span.field, raw);
    if (!norm || !raw.includes(norm)) return { ...span, field: span.field };
    const inner = raw.indexOf(norm);
    return { ...span, start: span.start + inner, end: span.start + inner + norm.length };
  });
}

export function highlightSpans(text: string, spans: readonly LabSpan[], side: LabSpan['side']): string {
  const applicable = spans
    .filter((span) => span.side === side && span.start >= 0 && span.end <= text.length && span.start < span.end)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  let out = '';
  for (const span of applicable) {
    if (span.start < cursor) continue;
    const cls =
      side === 'inbound'
        ? `lab-span-action-${span.colorIndex ?? 0}`
        : span.field === 'channelAuto'
          ? 'lab-span-gold-auto'
          : 'lab-span-gold';
    out += text.slice(cursor, span.start);
    out += `<mark class="${cls}" data-field="${span.field}">${text.slice(span.start, span.end)}</mark>`;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

export function valuesToSpans(
  text: string,
  values: Record<string, unknown> | null | undefined,
  side: LabSpan['side'],
  tool: string,
  colorIndex = 0,
): LabSpan[] {
  const schema = labReviewSchemaFor(tool);
  const allowed = new Set([
    ...Object.keys(schema.input.properties ?? {}),
    ...Object.keys(schema.output.properties ?? {}),
  ]);
  const spans: LabSpan[] = [];
  for (const [field, value] of Object.entries(values || {})) {
    if (!GOLD_FIELD_SET.has(field) || !allowed.has(field)) continue;
    const located = locateFieldValue(text, field, value);
    if (!located) continue;
    spans.push({ field, start: located.start, end: located.end, side, colorIndex });
  }
  return spans;
}

export function locateFieldValue(
  text: string,
  field: string,
  value: unknown,
): { start: number; end: number } | null {
  if (value == null || Array.isArray(value)) return null;
  if (field === 'roomQty') {
    const qty = coerceRoomQty(value);
    if (qty == null) return null;
    const labeled = text.match(new RegExp(`Rooms?\\s*:\\s*(${qty})\\b`, 'i'));
    if (labeled && labeled.index != null) {
      const inner = labeled[0].lastIndexOf(String(qty));
      return { start: labeled.index + inner, end: labeled.index + inner + String(qty).length };
    }
    return null;
  }
  const quote = normalizeDateSpanQuote(field, String(value));
  if (quote.length < 2) return null;
  const start = text.indexOf(quote);
  if (start < 0) return null;
  return { start, end: start + quote.length };
}

export function countEmptyOptionals(
  properties: Record<string, unknown>,
  required: readonly string[],
  filled: Record<string, unknown>,
): { emptyRequired: string[]; emptyOptional: string[] } {
  const requiredSet = new Set(required);
  const emptyRequired: string[] = [];
  const emptyOptional: string[] = [];
  for (const key of Object.keys(properties)) {
    const value = filled[key];
    const empty = value == null || value === '';
    if (!empty) continue;
    if (requiredSet.has(key)) emptyRequired.push(key);
    else emptyOptional.push(key);
  }
  return { emptyRequired, emptyOptional };
}

function spanFieldValues(text: string, spans: readonly LabSpan[], side: LabSpan['side']): Record<string, string> {
  const values: Record<string, string> = {};
  for (const span of spans) {
    if (span.side !== side || span.field === 'channelAuto') continue;
    const quote = normalizeDateSpanQuote(span.field, text.slice(span.start, span.end));
    if (quote) values[span.field] = quote;
  }
  return values;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function flattenExtract(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  if (typeof source.query === 'string' && out.confirmationNumber == null) {
    out.confirmationNumber = source.query;
  }
  const occupancy = source.occupancy;
  if (occupancy && typeof occupancy === 'object' && !Array.isArray(occupancy)) {
    const occ = occupancy as Record<string, unknown>;
    if (out.adults == null && occ.adults != null) out.adults = occ.adults;
    if (out.children == null && occ.children != null) out.children = occ.children;
  }
  if (out.occupancy == null && source.guestCount != null) {
    out.occupancy = source.guestCount;
  }
  return out;
}

function pickSchemaValues(keys: readonly string[], ...sources: Array<Record<string, unknown>>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    for (const source of sources) {
      const value = source[key];
      if (value != null && value !== '') {
        picked[key] = value;
        break;
      }
    }
  }
  return picked;
}

function dropInboundEchoes(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  inboundText: string,
  goldText: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...output };
  for (const [key, value] of Object.entries(next)) {
    const asText = value == null ? '' : String(value);
    if (!asText) {
      delete next[key];
      continue;
    }
    if (input[key] != null && String(input[key]) === asText) {
      delete next[key];
      continue;
    }
    if (inboundText.includes(asText) && !goldText.includes(asText)) {
      delete next[key];
    }
  }
  return next;
}

export function projectLabFills(
  row: LabRow,
  tool: string,
  askIndex = 0,
  action?: ProposedAction | null,
): { input: Record<string, unknown>; output: Record<string, unknown> } {
  const schema = labReviewSchemaFor(tool);
  const inputKeys = Object.keys(schema.input.properties ?? {});
  const outputKeys = Object.keys(schema.output.properties ?? {});
  const inboundText = `${row.inbound.textBody || ''}\n${row.attachmentText || ''}`;
  const goldText = row.gold?.textBody || '';
  const resolved = action || resolveProposedActions(row).filter((item) => item.tool === tool)[askIndex];
  const asks = row.stayAsks?.length ? row.stayAsks : splitStayAsks(inboundText);
  const ask = asks[askIndex] || asks[0];
  const inboundSpans = spanFieldValues(inboundText, spansForPaint(row.spans, tool), 'inbound');
  const goldSpans = spanFieldValues(goldText, spansForPaint(row.spans, tool), 'gold');
  const actionRequest = resolved ? coerceRequest(resolved.request) : stayAskRecord(ask);
  const request = coerceRequest({ ...flattenExtract(asRecord(row.request)), ...actionRequest });
  const used = flattenExtract(asRecord(row.usedResult));
  const input = coerceRequest(pickSchemaValues(inputKeys, actionRequest, inboundSpans, request));
  const output = dropInboundEchoes(
    pickSchemaValues(outputKeys, goldSpans, used),
    input,
    inboundText,
    goldText,
  );
  return { input, output };
}

export const SYNTHETIC_LAB_INDEX: LabIndex = {
  generated: 'synthetic',
  rows: [
    {
      inboundId: 'syn-blue-pink',
      threadId: 'syn-thread-1',
      tools: ['hms_quote_stay', 'hms_find_reservation'],
      needed: { hms_quote_stay: true, hms_find_reservation: true },
      threadOutcome: 'gold_channel_auto',
      threadOutcomeCopy: THREAD_OUTCOME_COPY.gold_channel_auto,
      channelAuto: true,
      otherDesk: null,
      demandFamily: 'quote',
      facetChips: ['travel_agent'],
      inbound: {
        subject: 'Quote for 12 Oct',
        textBody: 'Please quote 12 Oct to 14 Oct for two adults.',
      },
      gold: {
        id: 'syn-gold-auto',
        subject: 'Auto confirmation',
        textBody: 'Your booking template confirmation is attached. Rate BAR, king bed.',
        channelAuto: true,
      },
      request: { arrival: '2026-10-12', departure: '2026-10-14', occupancy: { adults: 2 } },
      usedResult: { rateCode: 'BAR', bedType: 'king' },
      staffFilledAbsentFromInbound: ['bedType', 'rateCode'],
      spans: [
        { field: 'arrival', start: 13, end: 19, side: 'inbound' },
        { field: 'departure', start: 23, end: 29, side: 'inbound' },
        { field: 'channelAuto', start: 0, end: 27, side: 'gold' },
      ],
      attachmentRefs: [],
    },
    {
      inboundId: 'syn-true-gap',
      threadId: 'syn-thread-2',
      tools: ['hms_find_reservation'],
      needed: { hms_find_reservation: true },
      threadOutcome: 'true_gap',
      threadOutcomeCopy: THREAD_OUTCOME_COPY.true_gap,
      channelAuto: false,
      otherDesk: null,
      demandFamily: 'find_read',
      facetChips: ['individual'],
      inbound: {
        subject: 'Where is my booking',
        textBody: 'Can you find confirmation ABC123 please.',
      },
      gold: null,
      request: { query: 'ABC123' },
      usedResult: {},
      staffFilledAbsentFromInbound: [],
      spans: [{ field: 'query', start: 20, end: 26, side: 'inbound' }],
      attachmentRefs: [],
    },
    {
      inboundId: 'syn-staff-only-quote',
      threadId: 'syn-thread-3',
      tools: [],
      needed: { hms_quote_stay: false },
      staffUsed: { hms_quote_stay: true },
      threadOutcome: 'gold_human',
      threadOutcomeCopy: THREAD_OUTCOME_COPY.gold_human,
      channelAuto: false,
      otherDesk: null,
      demandFamily: 'quote',
      facetChips: ['individual'],
      inbound: {
        subject: 'Staff quoted without ask flag',
        textBody: 'Rates for 20 Oct.',
      },
      gold: {
        id: 'syn-gold-staff',
        subject: 'Quote sent',
        textBody: 'Quoted BAR.',
        channelAuto: false,
      },
      request: {},
      usedResult: { rateCode: 'BAR' },
      staffFilledAbsentFromInbound: ['rateCode'],
      spans: [],
      attachmentRefs: [],
    },
  ],
};

function rowNeedsTool(row: LabRow, tool: string): boolean {
  if (row.staffUsed?.[tool]) return true;
  if (row.needed?.[tool]) return true;
  if (row.needed && Object.prototype.hasOwnProperty.call(row.needed, tool)) return false;
  return row.tools.includes(tool);
}

export function rowsForTool(index: LabIndex, tool: string | null): LabRow[] {
  if (!tool) return index.rows;
  return index.rows.filter((row) => rowNeedsTool(row, tool));
}

export function toolCounts(index: LabIndex): Array<{
  tool: string;
  neededCount: number | 'unresolved';
  staffUsedCount?: number;
  parserFloor?: number;
  threshold95?: 'met' | 'not_met';
}> {
  if (index.neededCounts?.length) {
    return [...index.neededCounts].sort((a, b) => {
      const av = a.neededCount === 'unresolved' ? a.parserFloor || 0 : a.neededCount;
      const bv = b.neededCount === 'unresolved' ? b.parserFloor || 0 : b.neededCount;
      return bv - av || a.tool.localeCompare(b.tool);
    });
  }
  const counts = new Map<string, number>();
  for (const row of index.rows) {
    const keys = row.needed ? Object.keys(row.needed).filter((tool) => row.needed?.[tool]) : row.tools;
    for (const tool of new Set(keys)) {
      counts.set(tool, (counts.get(tool) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tool, neededCount]) => ({ tool, neededCount }))
    .sort((a, b) => Number(b.neededCount) - Number(a.neededCount) || a.tool.localeCompare(b.tool));
}

export function buildLabNavItems(index: LabIndex): Array<{
  id: string;
  title: string;
  url: string;
  subtitle: string;
}> {
  const byTool = new Map(toolCounts(index).map((item) => [item.tool, item]));
  return [
    {
      id: 'all-threads',
      title: 'All threads',
      url: '/lab/centurion',
      subtitle: String(index.rows.length),
    },
    ...LAB_TOOL_FOLDER_IDS.map((tool) => {
      const item = byTool.get(tool);
      const needed = item?.neededCount ?? 0;
      const used = item?.staffUsedCount;
      return {
        id: tool,
        title: tool,
        url: `/lab/centurion/${encodeURIComponent(tool)}`,
        subtitle: used == null ? String(needed) : `${needed} ${used}`,
      };
    }),
  ];
}

export function isMailFolderRoute(pathname: string): boolean {
  return pathname.startsWith('/mail/');
}

export const LAB_FACETS = ['travel_agent', 'group', 'company', 'individual', 'add_on'] as const;

export type LabFilters = {
  tool?: string | null;
  outcome?: ThreadOutcome | null;
  facet?: string | null;
  proposed?: 'live' | 'skip' | null;
};

export function rowHasLiveProposed(row: LabRow): boolean {
  return resolveProposedActions(row).some((item) => item.status === 'live' || item.status === 'needs_human');
}

export function filterLabRows(index: LabIndex, filters: LabFilters = {}): LabRow[] {
  return index.rows.filter((row) => {
    if (filters.tool && !rowNeedsTool(row, filters.tool)) return false;
    if (filters.outcome && row.threadOutcome !== filters.outcome) return false;
    if (filters.facet && !(row.facetChips || []).includes(filters.facet)) return false;
    if (filters.proposed === 'live' && !rowHasLiveProposed(row)) return false;
    if (filters.proposed === 'skip' && rowHasLiveProposed(row)) return false;
    return true;
  });
}

export function outcomeCounts(index: LabIndex): Array<{ outcome: ThreadOutcome; count: number }> {
  const counts = new Map<ThreadOutcome, number>();
  for (const row of index.rows) {
    counts.set(row.threadOutcome, (counts.get(row.threadOutcome) || 0) + 1);
  }
  return THREAD_OUTCOMES.filter((outcome) => counts.get(outcome)).map((outcome) => ({
    outcome,
    count: counts.get(outcome) || 0,
  }));
}
