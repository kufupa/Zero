const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const NAMED_DATE =
  /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i;
const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};
const ARRIVAL_CUE = /\b(arriv\w*|check[\s-]?in)\b/gi;
const DEPARTURE_CUE = /\b(depart\w*|check[\s-]?out|leav\w*)\b/gi;

export type QuoteWorkflowAttachmentAdmission = {
  id: string;
  filename: string;
  byteSize?: number;
  text?: string;
  bytesPresent: boolean;
};

export type QuoteWorkflowAnalyseInput = {
  subject: string;
  bodyText: string;
  preceding?: Array<{ bodyText: string }>;
  attachments?: QuoteWorkflowAttachmentAdmission[];
  /** Staff correction. Dates, adults, board and asks it states replace the email's. */
  staffNote?: string;
  /** Staff override. Skips the quote-keyword gate so a stay group is always extracted. */
  treatAs?: 'quote' | 'create_booking';
};

export type QuoteWorkflowStayGroup = {
  id: string;
  arrivalDate?: string;
  departureDate?: string;
  quantity?: number;
  adults?: number;
  childrenAges: number[];
  board: 'dinner_bb' | 'bb' | 'room_only' | 'unknown';
  organisation?: string;
  specialRequests: string[];
  fields: Record<string, 'extracted' | 'staff_corrected' | 'missing'>;
};

export type QuoteWorkflowAnalysis = {
  intent: 'quote' | 'other';
  groups: QuoteWorkflowStayGroup[];
  secondaryAsks: string[];
  alternatives: string[];
  attachmentAdmissions: Array<{
    attachmentId: string;
    filename: string;
    byteSize?: number;
    admittedText: boolean;
  }>;
};

type DateMention = { iso: string; start: number; end: number };

function toIso(raw: string): string | undefined {
  const iso = raw.match(ISO_DATE);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = raw.match(NAMED_DATE);
  if (!named) return undefined;
  const month = MONTHS[named[2]!.toLowerCase()];
  return `${named[3]}-${month}-${named[1]!.padStart(2, '0')}`;
}

function looksLikeQuote(text: string): boolean {
  return /\b(quote|quotation|availability|rate|accommodation|rooms?)\b/i.test(text);
}

/** ISO and named dates in reading order. */
function dateMentions(text: string): DateMention[] {
  const mentions: DateMention[] = [];
  for (const match of text.matchAll(new RegExp(ISO_DATE.source, 'g'))) {
    const start = match.index ?? 0;
    mentions.push({ iso: match[0], start, end: start + match[0].length });
  }
  for (const match of text.matchAll(new RegExp(NAMED_DATE.source, 'gi'))) {
    const iso = toIso(match[0]);
    const start = match.index ?? 0;
    if (iso) mentions.push({ iso, start, end: start + match[0].length });
  }
  return mentions.sort((a, b) => a.start - b.start);
}

function lastCueIndex(text: string, cue: RegExp): number {
  let last = -1;
  for (const match of text.matchAll(cue)) last = match.index ?? last;
  return last;
}

/** The field named by the nearest arrival or departure label before a date, in its sentence. */
function cueBefore(text: string, from: number, to: number): 'arrival' | 'departure' | undefined {
  const sentence = text.slice(from, to).split(/[.;\n]/).pop() ?? '';
  const arrival = lastCueIndex(sentence, ARRIVAL_CUE);
  const departure = lastCueIndex(sentence, DEPARTURE_CUE);
  if (arrival < 0 && departure < 0) return undefined;
  return arrival > departure ? 'arrival' : 'departure';
}

const FROM_AT_END = /\bfrom\s*$/i;
const TO_BETWEEN = /^[\s,]*\bto\b[\s,]*$/i;

/**
 * Dates in a staff note. A label names the field a date corrects. "<field> changed from OLD to
 * NEW" sets that field to NEW and never uses OLD. Unlabelled dates fill whichever slot is still
 * open, in reading order, after the labelled and corrected dates are placed.
 */
function staffNoteDates(note: string): { arrivalDate?: string; departureDate?: string } {
  const mentions = dateMentions(note);
  const oldDates = new Set<number>();
  const correctedField = new Map<number, 'arrival' | 'departure'>();
  let cursor = 0;
  mentions.forEach((mention, index) => {
    const next = mentions[index + 1];
    const from = note.slice(cursor, mention.start).match(FROM_AT_END);
    if (from && next && TO_BETWEEN.test(note.slice(mention.end, next.start))) {
      const field = cueBefore(note, cursor, cursor + (from.index ?? 0));
      if (field) {
        oldDates.add(index);
        correctedField.set(index + 1, field);
      }
    }
    cursor = mention.end;
  });
  const named: { arrivalDate?: string; departureDate?: string } = {};
  const unlabelled: string[] = [];
  cursor = 0;
  mentions.forEach((mention, index) => {
    const cue = correctedField.get(index) ?? cueBefore(note, cursor, mention.start);
    cursor = mention.end;
    if (oldDates.has(index)) return;
    if (cue === 'arrival' && !named.arrivalDate) named.arrivalDate = mention.iso;
    else if (cue === 'departure' && !named.departureDate) named.departureDate = mention.iso;
    else unlabelled.push(mention.iso);
  });
  for (const iso of unlabelled) {
    if (!named.arrivalDate) named.arrivalDate = iso;
    else if (!named.departureDate) named.departureDate = iso;
  }
  return named;
}

function adultsIn(text: string): number | undefined {
  const match = text.match(/\b(\d+)\s+adult/i);
  return match ? Number(match[1]) : undefined;
}

function boardAlternativesIn(text: string): string[] {
  const alternatives: string[] = [];
  if (/\broom[- ]?only|\bRO\b/i.test(text)) alternatives.push('RO');
  if (/\bB&B\b|\bbed and breakfast|\bBB\b/i.test(text)) alternatives.push('BB');
  return alternatives;
}

function secondaryAsksIn(text: string): string[] {
  return /\bparking\b/i.test(text) ? ['parking'] : [];
}

/**
 * Mailbox-side regex classifier. Filenames never count as document bytes.
 * This is not the reservationist agent.
 */
export function analyseQuoteSources(input: QuoteWorkflowAnalyseInput): QuoteWorkflowAnalysis {
  const note = input.staffNote?.trim() ?? '';
  const emailText = [
    input.subject,
    input.bodyText,
    ...(input.preceding ?? []).map((part) => part.bodyText),
    ...(input.attachments ?? [])
      .map((part) => (part.bytesPresent || part.text ? part.text : undefined))
      .filter((text): text is string => Boolean(text)),
  ].join('\n');
  const attachmentAdmissions = (input.attachments ?? []).map((part) => ({
    attachmentId: part.id,
    filename: part.filename,
    byteSize: part.byteSize,
    admittedText: Boolean(part.bytesPresent || part.text),
  }));
  if (!input.treatAs && !looksLikeQuote([note, emailText].join('\n'))) {
    return { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], attachmentAdmissions };
  }
  // The note is parsed on its own so its dates never shift the email's positional dates.
  const emailDates = dateMentions(emailText).map((mention) => mention.iso);
  const noteDates = staffNoteDates(note);
  const noteAdults = adultsIn(note);
  const noteAlternatives = boardAlternativesIn(note);
  const noteAsks = secondaryAsksIn(note);
  const alternatives = noteAlternatives.length ? noteAlternatives : boardAlternativesIn(emailText);
  const secondaryAsks = noteAsks.length ? noteAsks : secondaryAsksIn(emailText);
  const adults = noteAdults ?? adultsIn(emailText);
  const arrivalDate = noteDates.arrivalDate ?? emailDates[0];
  const departureDate = noteDates.departureDate ?? emailDates[1];
  const group: QuoteWorkflowStayGroup = {
    id: 'g1',
    arrivalDate,
    departureDate,
    quantity: 1,
    adults,
    childrenAges: [],
    board:
      alternatives.includes('RO') && !alternatives.includes('BB')
        ? 'room_only'
        : alternatives.includes('BB')
          ? 'bb'
          : 'unknown',
    specialRequests: [],
    fields: {
      arrivalDate: noteDates.arrivalDate
        ? 'staff_corrected'
        : arrivalDate
          ? 'extracted'
          : 'missing',
      departureDate: noteDates.departureDate
        ? 'staff_corrected'
        : departureDate
          ? 'extracted'
          : 'missing',
      adults:
        noteAdults !== undefined
          ? 'staff_corrected'
          : /\badult/i.test([note, emailText].join('\n'))
            ? 'extracted'
            : 'missing',
    },
  };
  return { intent: 'quote', groups: [group], secondaryAsks, alternatives, attachmentAdmissions };
}
