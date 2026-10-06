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
 * Mailbox-side regex classifier. Filenames never count as document bytes.
 * This is not the reservationist agent.
 */
export function analyseQuoteSources(input: QuoteWorkflowAnalyseInput): QuoteWorkflowAnalysis {
  const admittedText = [
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
  if (!looksLikeQuote(admittedText)) {
    return { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], attachmentAdmissions };
  }
  const dates = [...admittedText.matchAll(new RegExp(ISO_DATE, 'g'))].map((match) => match[0]);
  const named = [...admittedText.matchAll(new RegExp(NAMED_DATE.source, 'gi'))]
    .map((match) => toIso(match[0]))
    .filter((date): date is string => Boolean(date));
  const allDates = [...dates, ...named];
  const alternatives: string[] = [];
  if (/\broom[- ]?only|\bRO\b/i.test(admittedText)) alternatives.push('RO');
  if (/\bB&B\b|\bbed and breakfast|\bBB\b/i.test(admittedText)) alternatives.push('BB');
  const secondaryAsks: string[] = [];
  if (/\bparking\b/i.test(admittedText)) secondaryAsks.push('parking');
  const arrivalDate = allDates[0];
  const departureDate = allDates[1];
  const group: QuoteWorkflowStayGroup = {
    id: 'g1',
    arrivalDate,
    departureDate,
    quantity: 1,
    adults: /\b(\d+)\s+adult/i.test(admittedText)
      ? Number(admittedText.match(/\b(\d+)\s+adult/i)?.[1])
      : undefined,
    childrenAges: [],
    board:
      alternatives.includes('RO') && !alternatives.includes('BB')
        ? 'room_only'
        : alternatives.includes('BB')
          ? 'bb'
          : 'unknown',
    specialRequests: [],
    fields: {
      arrivalDate: arrivalDate ? 'extracted' : 'missing',
      departureDate: departureDate ? 'extracted' : 'missing',
      adults: /\badult/i.test(admittedText) ? 'extracted' : 'missing',
    },
  };
  return { intent: 'quote', groups: [group], secondaryAsks, alternatives, attachmentAdmissions };
}
