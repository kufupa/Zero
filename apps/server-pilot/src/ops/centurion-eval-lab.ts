/**
 * Centurion eval-lab parsers: threadOutcome, useful attachments, occupancy.
 * Counts and enums only — no mail bodies in this module.
 */

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

export type ThreadOutcomeInput = {
  unanswered?: boolean;
  writeStateIndependent?: string | null;
  hasHumanGold?: boolean;
  hasChannelAutoGold?: boolean;
  hasLaterOutbound?: boolean;
  hasSiblingGold?: boolean;
  otherDesk?: string | null;
  noReplyOwed?: boolean;
  windowCutoff?: boolean;
  parseFailure?: boolean;
};

export function assignThreadOutcome(input: ThreadOutcomeInput): ThreadOutcome {
  if (input.hasHumanGold) return 'gold_human';
  if (input.hasChannelAutoGold) return 'gold_channel_auto';
  if (input.hasLaterOutbound || input.hasSiblingGold) return 'gold_pairing_miss';
  if (input.otherDesk) return 'other_desk';
  if (input.noReplyOwed) return 'no_reply_owed';
  if (input.windowCutoff) return 'window_cutoff';
  if (input.parseFailure) return 'ingest_recovered';
  return 'true_gap';
}

const IMAGE_RE = /^image\/(jpeg|jpg|png|gif)\b/i;
const USEFUL_TYPE_RE =
  /pdf|spreadsheet|excel|csv|msword|wordprocessingml|officedocument\.spreadsheet|officedocument\.word/i;
const LOGO_NAME_RE = /logo|signature|spacer|pixel|footer|header.?image/i;

export type EvalAttachmentMeta = {
  contentType?: string | null;
  filename?: string | null;
  byteSize?: number | null;
};

export function isUsefulEvalAttachment(meta: EvalAttachmentMeta): boolean {
  const type = meta.contentType ?? '';
  const name = meta.filename ?? '';
  if (IMAGE_RE.test(type)) return false;
  if (LOGO_NAME_RE.test(name)) return false;
  return USEFUL_TYPE_RE.test(type) || USEFUL_TYPE_RE.test(name);
}

export type OccupancyParse = {
  paxTotal: number | null;
  source: 'pax_word' | 'adults_children' | 'unknown';
};

function maxInt(
  text: string,
  pattern: RegExp,
  { min = 1, max = 400 }: { min?: number; max?: number } = {},
): number | null {
  let best: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n === 2026 || n < min || n > max) continue;
    best = best == null ? n : Math.max(best, n);
  }
  return best;
}

export function parseOccupancyFromBody(text: string): OccupancyParse {
  const copy = String(text || '');
  const adults = maxInt(copy, /\b(\d{1,3})\s*(?:adults?|adlts?)\b/gi);
  const children = maxInt(copy, /\b(\d{1,3})\s*(?:children|child|kids?|infants?)\b/gi, {
    min: 0,
  });
  const paxWord = maxInt(
    copy,
    /\b(\d{1,3})\s*(?:pax|persons?|people|guests?|delegates?|attendees?)\b/gi,
  );
  if (adults != null || children != null) {
    const total = (adults || 0) + (children || 0);
    if (total >= 1) return { paxTotal: total, source: 'adults_children' };
  }
  if (paxWord != null) return { paxTotal: paxWord, source: 'pax_word' };
  return { paxTotal: null, source: 'unknown' };
}

export const USEFUL_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
] as const;

export function sortRequiredFirst(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): string[] {
  const requiredSet = new Set(required);
  const keys = Object.keys(properties);
  return [
    ...keys.filter((key) => requiredSet.has(key)),
    ...keys.filter((key) => !requiredSet.has(key)),
  ];
}

export type SpanHit = {
  field: string;
  start: number;
  end: number;
  side: 'inbound' | 'gold';
};

export function highlightSpans(text: string, spans: readonly SpanHit[], side: SpanHit['side']): string {
  const applicable = spans
    .filter((span) => span.side === side && span.start >= 0 && span.end <= text.length && span.start < span.end)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  let out = '';
  for (const span of applicable) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start);
    const cls = side === 'inbound' ? 'lab-span-inbound' : 'lab-span-gold';
    out += `<mark class="${cls}" data-field="${span.field}">${text.slice(span.start, span.end)}</mark>`;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

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

export const EVAL_TOOL_CATALOGUE = [
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
] as const;

export type EvalToolId = (typeof EVAL_TOOL_CATALOGUE)[number];

export type NeededMap = Record<EvalToolId, boolean>;

const OTA_RE = /synxis|booking\.com|expedia|travelclick|hotelbeds|agoda|channel manager/i;
const THANKS_RE = /\bthank(?:s| you)\b|\bkindly received\b|\bwell received\b/i;
const BOOK_RE =
  /\bplease\s+(?:kindly\s+)?book\b|\bkindly book\b|\bnew booking\b|\bwould like to book\b|\bbook the below\b|\breservation request\b|\bhold these rooms\b/i;
const QUOTE_RE = /\bquote\b|\bquotation\b|\bavailability\b|\brates?\s+for\b/i;
const CANCEL_RE = /\bcancel\b|\brelease (?:the )?(?:room|stay|booking|reservation)\b|\bno-?show\b/i;
const AMEND_RE =
  /\bamend\b|\bchange (?:the )?(?:date|dates|departure|arrival|room|name)\b|\bmodify\b|\bupdate (?:the )?(?:booking|reservation|stay)\b/i;
const CONF_RE =
  /\b(?:confirmation|conf(?:irmation)?(?:\s*(?:no\.?|number|#))?|res(?:ervation)?(?:\s*(?:no\.?|number|#))?)\s*[:#]?\s*[A-Z0-9]{5,}\b/i;
const FOLIO_RE = /\bfolio\b|\bguest ledger\b/i;
const INVOICE_RE = /\binvoice\b|\btax invoice\b/i;
const REFUND_RE = /\brefund\b/i;
const PAY_RE = /\bproof of payment\b|\bpop attached\b|\bpost(?:ing)? (?:the )?payment\b|\bkindly post\b/i;
const EMAIL_FOLIO_RE = /\bemail (?:the )?folio\b|\bsend (?:the )?folio\b/i;
const SEND_CONF_RE = /\bsend(?:ing)? (?:the )?(?:booking )?confirmation\b|\bconfirmation (?:letter|email)\b/i;
const PROFORMA_RE = /\bpro\s*-?forma\b|\bproforma\b/i;
const QUOTE_DOC_RE = /\bquote document\b|\bquotation pdf\b|\bquote pdf\b/i;
const ATTACH_RE = /\battached\b|\battachment\b|\bvoucher\b|\bitinerary\b/i;
const SEND_ATTACH_RE = /\bsend(?:ing)? with attachments\b|\bplease find attached\b|\battached (?:please|kindly)\b/i;
const LIST_DOCS_RE = /\blist (?:existing )?documents\b|\bdocuments on (?:the )?stay\b/i;
const READ_DOCS_RE = /\bread the existing\b|\bexisting (?:tax )?invoice on file\b/i;
const COMPANY_RE = /\bcompany account\b|\bbilling to\b|\bcompany billing\b/i;
const EVENT_RE = /\bconference\b|\bevent\b|\bbeo\b|\bballroom\b|\ballotment\b/i;
const PROPERTY_RE = /\bparking policy\b|\bcheck-?in time\b|\bhotel (?:policy|info|information)\b/i;
const SENT_AUDIT_RE = /\balready email(?:ed)?\b|\bsent email audit\b|\bdid we already email\b/i;
const NOTES_RE = /\btrace\b|\bspecial request\b|\bguest note\b/i;
const CHANNEL_RE = /synxis|channel manager|booking\.com notification/i;

function emptyNeeded(): NeededMap {
  return Object.fromEntries(EVAL_TOOL_CATALOGUE.map((tool) => [tool, false])) as NeededMap;
}

function hasConf(text: string): boolean {
  return CONF_RE.test(text) || /\b\d{6,}\b/.test(text);
}

export type ParseNeededOpts = {
  attachmentText?: string;
};

export function parseNeededTools(text: string, opts: ParseNeededOpts = {}): { floor: NeededMap; ceiling: NeededMap } {
  const body = `${text || ''}\n${opts.attachmentText || ''}`;
  const floor = emptyNeeded();
  const pax = parseOccupancyFromBody(body).paxTotal;
  const isGroup = pax != null && pax >= 10;
  const ota = OTA_RE.test(body);
  const thanks = THANKS_RE.test(body) && !BOOK_RE.test(body) && !QUOTE_RE.test(body);
  const quoteOnly = QUOTE_RE.test(body) && !BOOK_RE.test(body);

  if (!thanks) {
    floor.hms_cancel_reservation = CANCEL_RE.test(body);
    floor.hms_amend_reservation = AMEND_RE.test(body);
    floor.hms_quote_stay = QUOTE_RE.test(body);
    floor.hms_create_reservation = BOOK_RE.test(body) && !ota && !quoteOnly && !isGroup && !floor.hms_cancel_reservation;
    floor.hms_group_block_read = isGroup || (/\bgroup\b|\bblock\b|\ballotment\b/.test(body) && BOOK_RE.test(body));
    if (EVENT_RE.test(body) && (BOOK_RE.test(body) || QUOTE_RE.test(body) || /\bpax\b/i.test(body))) {
      floor.hms_group_block_read = true;
      floor.hms_event_read = true;
    }
  }

  floor.hms_read_folio = FOLIO_RE.test(body);
  floor.hms_generate_invoice = INVOICE_RE.test(body);
  floor.hms_refund = REFUND_RE.test(body);
  floor.hms_post_payment = PAY_RE.test(body);
  floor.hms_email_folio = EMAIL_FOLIO_RE.test(body);
  floor.hms_send_reservation_confirmation = SEND_CONF_RE.test(body);
  floor.hms_generate_confirmation_proforma = PROFORMA_RE.test(body) || SEND_CONF_RE.test(body);
  floor.hms_generate_quote_document = QUOTE_DOC_RE.test(body);
  floor.mail_read_artifact = ATTACH_RE.test(body);
  floor.hms_attach_guest_stay_document = ATTACH_RE.test(body) && (BOOK_RE.test(body) || /\bvoucher\b|\bitinerary\b/i.test(body));
  floor['mail.send_with_attachments'] = SEND_ATTACH_RE.test(body);
  floor.hms_list_documents = LIST_DOCS_RE.test(body);
  floor.documents_list_existing = LIST_DOCS_RE.test(body);
  floor.documents_read_existing = READ_DOCS_RE.test(body);
  floor.hms_company_account_read = COMPANY_RE.test(body);
  if (!floor.hms_event_read) floor.hms_event_read = EVENT_RE.test(body);
  floor.property_read_knowledge = PROPERTY_RE.test(body);
  floor.mail_parse_channel_payload = CHANNEL_RE.test(body) || ota;
  floor.hms_sent_email_audit = SENT_AUDIT_RE.test(body);
  floor.hms_read_notes_traces = NOTES_RE.test(body);

  if (isGroup) {
    floor.hms_create_reservation = false;
    floor.hms_group_block_read = true;
  }

  const ceiling: NeededMap = { ...floor };
  const write =
    floor.hms_create_reservation ||
    floor.hms_amend_reservation ||
    floor.hms_cancel_reservation ||
    floor.hms_quote_stay ||
    floor.hms_group_block_read;
  if (write && !hasConf(body) && !thanks) {
    ceiling.hms_find_reservation = true;
    ceiling.hms_read_reservation = true;
  }
  return { floor, ceiling };
}

export const NEEDED_TOOL_CLUSTERS = {
  writes: [
    'hms_create_reservation',
    'hms_amend_reservation',
    'hms_cancel_reservation',
    'hms_quote_stay',
    'hms_group_block_read',
  ],
  docs: [
    'hms_list_documents',
    'documents_list_existing',
    'documents_read_existing',
    'mail_read_artifact',
    'hms_attach_guest_stay_document',
    'mail.send_with_attachments',
    'hms_generate_confirmation_proforma',
    'hms_generate_quote_document',
    'hms_send_reservation_confirmation',
  ],
  money: ['hms_read_folio', 'hms_post_payment', 'hms_generate_invoice', 'hms_email_folio', 'hms_refund'],
  locators: ['hms_find_reservation', 'hms_read_reservation', 'hms_read_notes_traces'],
  context: [
    'hms_company_account_read',
    'hms_event_read',
    'property_read_knowledge',
    'mail_parse_channel_payload',
    'hms_sent_email_audit',
  ],
} as const;

export const NEEDED_TOOL_CONTRACTS: Record<
  EvalToolId,
  { includeWhen: string; excludeWhen: string; impliedBy?: string }
> = {
  hms_find_reservation: {
    includeWhen: 'explicit locate/find existing stay',
    excludeWhen: 'thanks/OTA/new-book-only with confirmation already in body',
    impliedBy: 'write without confirmation number',
  },
  hms_read_reservation: {
    includeWhen: 'need stay header after find',
    excludeWhen: 'no existing stay',
    impliedBy: 'write without confirmation number',
  },
  hms_read_notes_traces: { includeWhen: 'trace/special request/guest note', excludeWhen: 'no note ask' },
  'mail.send_with_attachments': { includeWhen: 'staff must send files', excludeWhen: 'no outbound file' },
  hms_attach_guest_stay_document: { includeWhen: 'voucher/itinerary/PDF onto stay', excludeWhen: 'logo/signature' },
  hms_list_documents: { includeWhen: 'list docs on stay', excludeWhen: 'no document ask' },
  mail_read_artifact: { includeWhen: 'inbound attachment must be read', excludeWhen: 'no useful attachment' },
  documents_read_existing: { includeWhen: 'read existing invoice/doc in HMS', excludeWhen: 'no existing-doc ask' },
  documents_list_existing: { includeWhen: 'list existing HMS docs', excludeWhen: 'no list ask' },
  hms_send_reservation_confirmation: { includeWhen: 'send confirmation to guest/TA', excludeWhen: 'quote-only' },
  hms_quote_stay: { includeWhen: 'availability/rate quote', excludeWhen: 'already booked with no rate ask' },
  hms_generate_confirmation_proforma: { includeWhen: 'proforma/STORECONF', excludeWhen: 'no confirm/proforma ask' },
  hms_generate_quote_document: { includeWhen: 'quote PDF', excludeWhen: 'verbal rate only' },
  hms_group_block_read: { includeWhen: 'pax>=10 or group/block/allotment', excludeWhen: 'FIT pax<10' },
  hms_amend_reservation: { includeWhen: 'change existing stay', excludeWhen: 'new book or cancel-only' },
  hms_create_reservation: { includeWhen: 'new individual book pax<10 not OTA', excludeWhen: 'quote-only, OTA, pax>=10, cancel' },
  hms_cancel_reservation: { includeWhen: 'cancel/release/no-show', excludeWhen: 'new book' },
  hms_read_folio: { includeWhen: 'folio/ledger', excludeWhen: 'no money ask' },
  hms_post_payment: { includeWhen: 'proof of payment / post payment', excludeWhen: 'no pay ask' },
  hms_generate_invoice: { includeWhen: 'invoice/tax invoice', excludeWhen: 'no invoice ask' },
  hms_email_folio: { includeWhen: 'email/send folio', excludeWhen: 'folio read only' },
  hms_refund: { includeWhen: 'refund', excludeWhen: 'no refund ask' },
  hms_company_account_read: { includeWhen: 'company account/billing', excludeWhen: 'FIT cash' },
  hms_event_read: { includeWhen: 'conference/event/BEO', excludeWhen: 'room-only FIT' },
  property_read_knowledge: { includeWhen: 'hotel policy/info', excludeWhen: 'stay mutation' },
  mail_parse_channel_payload: { includeWhen: 'OTA/channel notification', excludeWhen: 'human TA prose book' },
  hms_sent_email_audit: { includeWhen: 'did we already email from HMS', excludeWhen: 'first outbound' },
};

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

export type GoldFieldName = (typeof GOLD_FIELD_ENUM)[number];

export type GoldFieldQuote = {
  field: GoldFieldName;
  side: SpanHit['side'];
  quote: string;
};

export type RawGoldQuote = {
  field?: string | null;
  side?: SpanHit['side'] | string;
  quote?: string;
  text?: string;
};

export type QuoteMissReason = 'empty_quote' | 'empty_body' | 'not_in_body' | 'bad_field' | 'whole_body';

export type QuoteMiss = { field: string | null; reason: QuoteMissReason };

const GOLD_QUOTE_MIN_CHARS = 2;
const GOLD_QUOTE_MAX_CHARS = 400;

const GOLD_FIELD_SET = new Set<string>(GOLD_FIELD_ENUM);

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

export function rehydrateMailText(
  current: string | null | undefined,
  snapshotText?: string | null,
): string {
  const cur = current ?? '';
  if (cur.trim()) return cur;
  return snapshotText ?? '';
}

export function normalizeGoldQuote(raw: RawGoldQuote | GoldFieldQuote | null | undefined): GoldFieldQuote | QuoteMiss {
  const side: SpanHit['side'] = raw?.side === 'gold' ? 'gold' : 'inbound';
  const quote = String(raw?.quote || raw?.text || '');
  const rawField = typeof raw?.field === 'string' ? raw.field : null;
    if (!quote || quote.length < GOLD_QUOTE_MIN_CHARS) return { field: rawField, reason: 'empty_quote' };
  if (!rawField || !GOLD_FIELD_SET.has(rawField)) return { field: rawField, reason: 'bad_field' };
  return { field: rawField as GoldFieldName, side, quote };
}

function isQuoteMiss(value: GoldFieldQuote | QuoteMiss): value is QuoteMiss {
  return 'reason' in value;
}

export function locateQuoteSpans(
  text: string,
  quotes: readonly (GoldFieldQuote | RawGoldQuote)[],
): { spans: SpanHit[]; unresolved: QuoteMiss[] } {
  const spans: SpanHit[] = [];
  const unresolved: QuoteMiss[] = [];
  const body = text || '';
  for (const item of quotes) {
    const normalized = normalizeGoldQuote(item);
    if (isQuoteMiss(normalized)) {
      unresolved.push(normalized);
      continue;
    }
    if (!body.trim()) {
      unresolved.push({ field: normalized.field, reason: 'empty_body' });
      continue;
    }
    if (normalized.quote === body || normalized.quote.length >= GOLD_QUOTE_MAX_CHARS) {
      unresolved.push({ field: normalized.field, reason: 'whole_body' });
      continue;
    }
    const start = body.indexOf(normalized.quote);
    if (start < 0) {
      unresolved.push({ field: normalized.field, reason: 'not_in_body' });
      continue;
    }
    spans.push({
      field: normalized.field,
      start,
      end: start + normalized.quote.length,
      side: normalized.side,
    });
  }
  return { spans, unresolved };
}

export function isGoldFieldName(field: string | null | undefined): boolean {
  return Boolean(field && (GOLD_FIELD_SET.has(field) || field === 'channelAuto'));
}

export function interestingFacts(fields: readonly string[] | null | undefined): string[] {
  return (fields || []).filter((field) => GOLD_FIELD_SET.has(field));
}

export function rewriteDateSpan(
  text: string,
  span: SpanHit,
): SpanHit {
  if (span.field !== 'arrival' && span.field !== 'departure') return span;
  const raw = text.slice(span.start, span.end);
  const norm = raw.replace(/^\s*[*\-•\t ]*(?:check[\s-]?in|check[\s-]?out)\s*:\s*/i, '').trim();
  if (!norm || !raw.includes(norm)) return span;
  const inner = raw.indexOf(norm);
  return { ...span, start: span.start + inner, end: span.start + inner + norm.length };
}

function captureLabeledDate(text: string, label: 'in' | 'out'): string | undefined {
  const re =
    label === 'in'
      ? /check[\s-]?in\s*:?\s*([^\n]{2,40})/i
      : /check[\s-]?out\s*:?\s*([^\n]{2,40})/i;
  const match = text.match(re);
  if (!match) return undefined;
  const norm = match[1]
    .replace(/^\s*[*\-•\t ]+/, '')
    .replace(/^(?:check[\s-]?in|check[\s-]?out)\s*:?\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (norm.length < 2 || norm.length > 80 || !/\d/.test(norm)) return undefined;
  return norm;
}

export function harvestStayDates(text: string): { arrival?: string; departure?: string } {
  const arrival = captureLabeledDate(text, 'in');
  const departure = captureLabeledDate(text, 'out');
  return {
    ...(arrival ? { arrival } : {}),
    ...(departure ? { departure } : {}),
  };
}

export type StayAsk = {
  arrival?: string;
  departure?: string;
  roomQty?: number;
  roomType?: string;
};

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
  const push = (ask: StayAsk) => {
    const key = `${ask.arrival || ''}|${ask.departure || ''}|${ask.roomQty ?? ''}`;
    if (!ask.arrival && !ask.departure && ask.roomQty == null) return;
    if (seen.has(key)) return;
    seen.add(key);
    asks.push(ask);
  };
  for (const match of (text || '').matchAll(ARRIVE_BLOCK_RE)) {
    push({
      ...(coerceScalarDate(match[1]) ? { arrival: coerceScalarDate(match[1]) } : {}),
      ...(coerceScalarDate(match[2]) ? { departure: coerceScalarDate(match[2]) } : {}),
      ...(coerceRoomQty(match[3]) != null ? { roomQty: coerceRoomQty(match[3]) } : {}),
      ...(String(match[4] || '').trim() ? { roomType: String(match[4]).trim() } : {}),
    });
  }
  for (const match of (text || '').matchAll(CHECKIN_BLOCK_RE)) {
    push({
      ...(coerceScalarDate(match[1]) ? { arrival: coerceScalarDate(match[1]) } : {}),
      ...(coerceScalarDate(match[2]) ? { departure: coerceScalarDate(match[2]) } : {}),
    });
  }
  for (const match of (text || '').matchAll(FROM_TO_RE)) {
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

export type NeededFreezeRow = {
  neededCount: number | null;
  threshold95?: string;
  staffUsedCount?: number;
};

export function mergeStaffUsedWithoutTouchingNeeded<T extends Record<string, NeededFreezeRow>>(
  needed: T,
  staffUsed: Record<string, number>,
): T {
  const out = {} as T;
  for (const [tool, row] of Object.entries(needed)) {
    out[tool as keyof T] = {
      ...row,
      neededCount: row.neededCount,
      staffUsedCount: staffUsed[tool],
    } as T[keyof T];
  }
  return out;
}

export type CallGraphRow = {
  ask: number;
  staffUsed: number;
  alwaysInStack: boolean;
};

const ALWAYS_IN_STACK = new Set(['hms_find_reservation', 'hms_read_reservation']);

export function buildCallGraph(input: {
  ask: Record<string, number>;
  staffUsed: Record<string, number>;
}): Record<string, CallGraphRow> {
  const tools = new Set([...Object.keys(input.ask), ...Object.keys(input.staffUsed)]);
  const graph: Record<string, CallGraphRow> = {};
  for (const tool of tools) {
    graph[tool] = {
      ask: input.ask[tool] ?? 0,
      staffUsed: input.staffUsed[tool] ?? 0,
      alwaysInStack: ALWAYS_IN_STACK.has(tool),
    };
  }
  return graph;
}
