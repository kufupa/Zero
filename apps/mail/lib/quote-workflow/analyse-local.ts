import type { QuoteAnalysis, StayGroupRequirement } from './types';

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

export type LocalAnalyseInput = {
  subject: string;
  bodyText: string;
  attachmentBytes?: Array<{ id: string; filename: string; text?: string }>;
};

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

/**
 * Mailbox-side regex preview only. Not the reservationist agent.
 * Attachment filenames never count as document content.
 */
export function analyseLocalEmail(input: LocalAnalyseInput): QuoteAnalysis {
  const admittedText = [
    input.subject,
    input.bodyText,
    ...(input.attachmentBytes ?? []).map((part) => part.text).filter((text): text is string => Boolean(text)),
  ].join('\n');
  if (!looksLikeQuote(admittedText)) {
    return { intent: 'other', groups: [], secondaryAsks: [], alternatives: [] };
  }
  const dates = [...admittedText.matchAll(new RegExp(ISO_DATE, 'g'))].map((m) => m[0]);
  const named = [...admittedText.matchAll(new RegExp(NAMED_DATE.source, 'gi'))]
    .map((m) => toIso(m[0]))
    .filter((d): d is string => Boolean(d));
  const allDates = [...dates, ...named];
  const arrivalDate = allDates[0];
  const departureDate = allDates[1];
  const alternatives: string[] = [];
  if (/\broom[- ]?only|\bRO\b/i.test(admittedText)) alternatives.push('RO');
  if (/\bB&B\b|\bbed and breakfast|\bBB\b/i.test(admittedText)) alternatives.push('BB');
  const secondaryAsks = [...admittedText.matchAll(/[^.?\n]*\b(parking|shuttle|airport)\b[^.?\n]*[?]?/gi)]
    .map((match) => match[0].replace(/\s+/g, ' ').trim())
    .filter((clause) => clause.length >= 8 && (/[?]/.test(clause) || /^(is |are |can |could |please |how |what )/i.test(clause)));
  const group: StayGroupRequirement = {
    id: 'g1',
    arrivalDate,
    departureDate,
    quantity: 1,
    roomPreference: undefined,
    adults: /\b(\d+)\s+adult/i.test(admittedText) ? Number(admittedText.match(/\b(\d+)\s+adult/i)?.[1]) : undefined,
    childrenAges: [],
    board: alternatives.includes('RO') && !alternatives.includes('BB') ? 'room_only' : alternatives.includes('BB') ? 'bb' : 'unknown',
    specialRequests: [],
    fields: {
      arrivalDate: arrivalDate ? 'extracted' : 'missing',
      departureDate: departureDate ? 'extracted' : 'missing',
      adults: /\badult/i.test(admittedText) ? 'extracted' : 'missing',
    },
  };
  return { intent: 'quote', groups: [group], secondaryAsks, alternatives };
}
