import type {CaseCard} from '../types.js';
import {anchorCaptures, anchorPdfs, beforeCutoff, confirmationId as id, indexMentions, rows, type TwinAnchor, type TwinPdf, type TwinWorld} from './world.js';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function isoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const native = /^(?:[A-Za-z]{3} )?(\d{1,2})[ -]?([A-Za-z]{3})[ -]?(\d{4})$/.exec(s.trim());
  if (!native) return null;
  const month = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').indexOf(native[2].toUpperCase());
  return month < 0 ? null : `${native[3]}-${String(month + 1).padStart(2, '0')}-${native[1].padStart(2, '0')}`;
}

const pdfCell = (value: unknown) => typeof value === 'string'
  ? value.split(/\s+(?:Confirmation\s+(?:Number|No\.?)|Guest\s+Name|Arrival(?:\s+Date)?|Departure(?:\s+Date)?|Room\s+Type|Accommodation\s+Type|Occupancy|Rate\s+Includes|Average\s+Daily\s+Rate|Total\s+Accommodation|Adults|Children|Agency|Company)\s*:/i, 1)[0].trim()
  : value;

/** Stay from PDF fields only — never merge later HMS snapshot. */
export function stayFromPdf(pdf: TwinPdf | null, confirmation: string | null): Record<string, unknown> | null {
  if (!pdf) return null;
  const fields = {...object(pdf.pdf_fields), ...object(pdf.fields)};
  const guest = pdfCell(first(fields.guestName) ?? fields.guest_name ?? fields.guestfullname);
  const arrival = first(fields.arrivalDate) ?? fields.arrival_date;
  const departure = first(fields.departureDate) ?? fields.departure_date;
  const conf = confirmation;
  return {
    confirmation: conf,
    confirmationnumber: conf,
    guest_name: guest,
    guestfullname: guest,
    arrival_date: isoDate(arrival),
    arrivaldate: arrival,
    departure_date: isoDate(departure),
    departuredate: departure,
    adults: fields.adults ?? null,
    children: fields.children ?? null,
    room_type_text: pdfCell(first(fields.accommodationType) ?? first(fields.roomType) ?? fields.room_type_text),
    occupancy_text: first(fields.occupancy) ?? fields.occupancy_text,
    rate_includes_text: first(fields.rateIncludes) ?? fields.rate_includes_text,
    average_daily_rate_text: first(fields.averageDailyRate) ?? fields.average_daily_rate_text,
    total_accommodation_text: first(fields.totalAccommodation) ?? fields.total_accommodation_text,
    agency_text: first(fields.agency) ?? fields.agency_text ?? fields.ta1,
    company_text: first(fields.company) ?? fields.company_text,
    source: 'last_pre_as_of_pdf',
  };
}

type Observation = {
  at: number;
  confirmation: string;
  stay: Record<string, unknown>;
  documents: Record<string, unknown>[] | null;
  basis: 'pre_as_of_hms_capture' | 'last_pre_as_of_pdf' | 'pre_as_of_identity';
};

function pdfObservations(pdfs: TwinPdf[], cutoff: number, scopedId: string | null) {
  const out: Observation[] = [];
  for (const pdf of pdfs) {
    const at = parseTime(pdf.sent_at);
    if (at === null || at >= cutoff) continue;
    const fields = {...object(pdf.pdf_fields), ...object(pdf.fields)};
    if (!Object.keys(fields).length) continue;
    const declared = fields.confirmationNumber ?? fields.confirmation_number ?? fields.confirmation ?? pdf.confirmation;
    const fromFilename = /Confirmation[_ -]Letter[_ -](\d{6,10}(?:-\d+)?)(?![\d-])/i.exec(String(pdf.filename ?? ''))?.[1];
    const labels = Array.isArray(pdf.confirmation_labels) ? pdf.confirmation_labels : [];
    const declaredIds = [...(Array.isArray(declared) ? declared : [declared]), ...labels, fromFilename].map(id).filter(key => key !== null);
    const keys = scopedId ? (declaredIds.length && !declaredIds.includes(scopedId) ? [] : [scopedId]) : [...new Set(declaredIds)];
    for (const key of keys) {
      const stay = stayFromPdf(pdf, key);
      if (stay) out.push({at, confirmation: key, stay, documents: null, basis: 'last_pre_as_of_pdf'});
    }
  }
  return out;
}

function anchorObservations(anchor: TwinAnchor, cutoff: number): Observation[] {
  const confirmation = id(anchor.confirmation);
  if (!confirmation) return [];
  const captures = anchorCaptures(anchor).filter(row => beforeCutoff(row.captured_at, cutoff));
  return [...pdfObservations(anchorPdfs(anchor), cutoff, confirmation), ...captures.map(row => ({
    at: Date.parse(String(row.captured_at)), confirmation, stay: {...object(row.hms_fields), confirmation},
    documents: documentRows(row) ?? documentRows(object(row.hms_fields)), basis: 'pre_as_of_hms_capture' as const,
  }))];
}

function documentRows(row: Record<string, unknown>) {
  return Array.isArray(row.documents) && (row.documents_observed === true || row.documents.length > 0)
    ? rows(row.documents) : null;
}

export function observeStays(world: TwinWorld, card: CaseCard): Map<string, Observation> {
  const selected = object(card.selected_email);
  const cutoff = world.cutoff;
  const raw = object(card.hms_raw);
  const frozen = object(card.hms_shown);
  const pdfs = [...rows(card.pdf_versions), ...rows(raw.pdf_versions)];
  const observations = world.anchors.flatMap(anchor => anchorObservations(anchor, cutoff));
  observations.push(...pdfObservations([...world.letterEvidence.letters, ...pdfs], cutoff, null));
  const capturedAt = frozen.captured_at ?? frozen.hms_capture_later;
  const frozenStay = object(frozen.stay ?? frozen.hms_fields);
  const primary = id(frozen.confirmation ?? frozenStay.confirmation);
  if (primary && beforeCutoff(capturedAt, cutoff) && Object.keys(frozenStay).length) {
    observations.push({at: Date.parse(String(capturedAt)), confirmation: primary,
      stay: {...frozenStay, confirmation: primary}, documents: documentRows(frozen), basis: 'pre_as_of_hms_capture'});
  }
  const latest = new Map<string, Observation>();
  const priority = {pre_as_of_hms_capture: 2, last_pre_as_of_pdf: 1, pre_as_of_identity: 0};
  for (const row of observations) {
    const previous = latest.get(row.confirmation);
    if (!previous || priority[row.basis] > priority[previous.basis] || row.basis === previous.basis && (row.at > previous.at || row.at === previous.at && row.documents && !previous.documents)) {
      latest.set(row.confirmation, row);
    }
  }
  const mentions = new Map<string, number>();
  for (const mail of [...rows(card.context_before), ...rows(card.cross_thread_context), selected]) indexMentions(mail, mentions);
  const letters = new Map<string, number>();
  for (const pdf of world.letterEvidence.letters) {
    const confirmation = id(pdf.confirmation);
    const at = parseTime(pdf.sent_at);
    if (confirmation && at !== null && at < (letters.get(confirmation) ?? Infinity)) letters.set(confirmation, at);
  }
  for (const anchor of world.anchors) {
    const confirmation = id(anchor.confirmation);
    if (!confirmation || latest.has(confirmation)) continue;
    const capture = anchorCaptures(anchor).find(row => parseTime(row.captured_at) !== null);
    if (!capture) continue;
    const fields = object(capture.hms_fields);
    const created = fields.created_at ?? fields.creation_date ?? fields.created_date ?? fields.createdate ?? anchor.created_at;
    const at = Math.min(mentions.get(confirmation) ?? Infinity, world.letterEvidence.mentions.get(confirmation) ?? Infinity,
      letters.get(confirmation) ?? Infinity, parseTime(/\d:\d/.test(String(created)) ? created : isoDate(created) ?? created) ?? Infinity,
      ...anchorPdfs(anchor).map(pdf => parseTime(pdf.sent_at) ?? Infinity));
    if (at >= cutoff) continue;
    const guestfullname = fields.guestfullname ?? fields.guest_name ?? [fields.firstname, fields.lastname].filter(Boolean).join(' ');
    latest.set(confirmation, {at, confirmation, stay: {confirmation, guestfullname}, documents: null, basis: 'pre_as_of_identity'});
  }
  return latest;
}

export function projectHmsShown(world: TwinWorld, card: CaseCard) {
  const confirmation = id(card.real_confirmation ?? card.confirmation ?? object(card.hms_shown).confirmation);
  const found = confirmation ? observeStays(world, card).get(confirmation) : undefined;
  return {
    as_of: new Date(world.cutoff).toISOString(),
    confirmation,
    exists: found != null,
    stay: found?.stay ?? null,
    documents: found?.documents ?? null,
    documents_observed: found?.documents != null,
    twin_coverage: found ? 'observed' : 'unobserved',
    basis: found?.basis ?? 'no_pre_as_of_evidence',
    basis_pdf_sent_at: found?.basis === 'last_pre_as_of_pdf' ? new Date(found.at).toISOString() : null,
  };
}
