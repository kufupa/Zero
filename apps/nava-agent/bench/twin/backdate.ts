import type {CaseCard, Workflow} from '../types.js';
import type {TwinAnchor, TwinPdf, TwinWorld} from './world.js';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asOfMs(card: CaseCard): number {
  const raw = card.as_of ?? card.source?.input_cutoff;
  const ms = parseTime(raw);
  if (ms == null) throw new Error('CASE_AS_OF_MISSING');
  return ms;
}

function pdfTime(pdf: TwinPdf): number | null {
  return parseTime(pdf.sent_at) ?? parseTime(pdf.filed_at);
}

function lastPdfBefore(anchor: TwinAnchor | undefined, asOf: number): TwinPdf | null {
  const pdfs = [...(anchor?.pdfs ?? [])]
    .map(pdf => ({pdf, at: pdfTime(pdf)}))
    .filter((row): row is {pdf: TwinPdf; at: number} => row.at != null && row.at <= asOf)
    .sort((a, b) => a.at - b.at);
  return pdfs.length ? pdfs[pdfs.length - 1]!.pdf : null;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function isoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/** Stay from PDF fields only — never merge later HMS snapshot. */
export function stayFromPdf(pdf: TwinPdf | null, confirmation: string | null): Record<string, unknown> | null {
  if (!pdf) return null;
  const fields = {...object(pdf.pdf_fields), ...object(pdf.fields)};
  const guest = first(fields.guestName) ?? fields.guest_name;
  const arrival = first(fields.arrivalDate) ?? fields.arrival_date;
  const departure = first(fields.departureDate) ?? fields.departure_date;
  const conf = first(fields.confirmationNumber) ?? confirmation;
  return {
    status: 'Reserved',
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
    room_type_text: first(fields.accommodationType) ?? fields.room_type_text,
    occupancy_text: first(fields.occupancy) ?? fields.occupancy_text,
    rate_includes_text: first(fields.rateIncludes) ?? fields.rate_includes_text,
    average_daily_rate_text: first(fields.averageDailyRate) ?? fields.average_daily_rate_text,
    total_accommodation_text: first(fields.totalAccommodation) ?? fields.total_accommodation_text,
    source: 'last_pre_as_of_pdf',
  };
}

export type HmsShown = {
  as_of: string;
  workflow: Workflow;
  confirmation: string | null;
  exists: boolean;
  stay: Record<string, unknown> | null;
  documents: Array<Record<string, unknown>>;
  basis: string;
  basis_pdf_sent_at?: string | null;
};

export function projectHmsShown(world: TwinWorld, card: CaseCard): HmsShown {
  const asOf = asOfMs(card);
  const asOfIso = new Date(asOf).toISOString();
  const workflow = card.workflow;
  const confirmation = card.real_confirmation ?? card.confirmation ?? null;
  const raw = object(card.hms_raw);
  const decisionPdf = object(card.decision_time_base_pdf ?? raw.decision_time_base_pdf);
  // Prefer frozen case.hms_shown when card already passed leak guard (bench data path).
  const frozen = object(card.hms_shown);
  if (frozen.basis === 'last_pre_as_of_pdf' || frozen.basis === 'create_booking_absent_at_as_of') {
    return {
      as_of: asOfIso,
      workflow,
      confirmation,
      exists: Boolean(frozen.exists),
      stay: frozen.stay ? object(frozen.stay) : null,
      documents: Array.isArray(frozen.documents) ? frozen.documents as Array<Record<string, unknown>> : [],
      basis: String(frozen.basis),
      basis_pdf_sent_at: typeof frozen.basis_pdf_sent_at === 'string' ? frozen.basis_pdf_sent_at : null,
    };
  }
  let pdf: TwinPdf | null = null;
  if (workflow === 'amend' && decisionPdf.fields) {
    pdf = {
      sent_at: typeof decisionPdf.sent_at === 'string' ? decisionPdf.sent_at : undefined,
      sha256: decisionPdf.sha256,
      pdf_fields: {
        guestName: [object(decisionPdf.fields).guest_name],
        arrivalDate: [object(decisionPdf.fields).arrival_date],
        departureDate: [object(decisionPdf.fields).departure_date],
        accommodationType: [object(decisionPdf.fields).room_type_text],
        occupancy: [object(decisionPdf.fields).occupancy_text],
        rateIncludes: [object(decisionPdf.fields).rate_includes_text],
        averageDailyRate: [object(decisionPdf.fields).average_daily_rate_text],
        totalAccommodation: [object(decisionPdf.fields).total_accommodation_text],
        confirmationNumber: [confirmation],
      },
      fields: object(decisionPdf.fields),
    };
  } else {
    pdf = lastPdfBefore(world.anchor, asOf);
  }

  if (workflow === 'create') {
    const ordered = [...(world.anchor?.pdfs ?? [])]
      .map(row => ({pdf: row, at: pdfTime(row)}))
      .filter((row): row is {pdf: TwinPdf; at: number} => row.at != null)
      .sort((a, b) => a.at - b.at);
    const first = ordered[0];
    if (!confirmation || !first || first.at > asOf) {
      return {
        as_of: asOfIso,
        workflow,
        confirmation,
        exists: false,
        stay: null,
        documents: [],
        basis: 'create_booking_absent_at_as_of',
        basis_pdf_sent_at: null,
      };
    }
  }

  const stay = stayFromPdf(pdf, confirmation);
  if ((workflow === 'amend' || workflow === 'cancel' || workflow === 'filing') && !stay) {
    return {
      as_of: asOfIso,
      workflow,
      confirmation,
      exists: false,
      stay: null,
      documents: [],
      basis: 'no_pre_as_of_pdf',
      basis_pdf_sent_at: null,
    };
  }
  if (workflow === 'cancel' && stay) stay.status = 'Reserved';

  return {
    as_of: asOfIso,
    workflow,
    confirmation,
    exists: Boolean(stay),
    stay,
    documents: [],
    basis: 'last_pre_as_of_pdf',
    basis_pdf_sent_at: typeof pdf?.sent_at === 'string' ? pdf.sent_at : null,
  };
}
