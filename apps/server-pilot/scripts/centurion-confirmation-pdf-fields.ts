const IDENTIFIER_PATTERN = /(?<![A-Z0-9])\d{6,10}(?:-\d{1,2})?(?![A-Z0-9])/gi;
const PDF_FIELD_LABEL_PATTERN =
  /\b(Guest Name|Confirmation Number|Arrival Date|Departure Date|Accommodation Type|Number of Person\(s\)|Average Daily\s+Rate|Rate Includes|Total Accommodation for stay)\s*:/gi;
const PDF_FIELD_KEYS: Record<string, PdfFieldKey> = {
  'guest name': 'guestName',
  'confirmation number': 'confirmationNumber',
  'arrival date': 'arrivalDate',
  'departure date': 'departureDate',
  'accommodation type': 'accommodationType',
  'number of person(s)': 'occupancy',
  'average daily rate': 'averageDailyRate',
  'rate includes': 'rateIncludes',
  'total accommodation for stay': 'totalAccommodation',
};

export type PdfFieldKey =
  | 'guestName'
  | 'confirmationNumber'
  | 'arrivalDate'
  | 'departureDate'
  | 'accommodationType'
  | 'occupancy'
  | 'averageDailyRate'
  | 'rateIncludes'
  | 'totalAccommodation';
type PdfFieldCandidate = { value: string; pageNumber: number; label: string };
export type ExtractedPdfFields = Record<PdfFieldKey, PdfFieldCandidate[]>;
export const PDF_FIELD_NAMES: readonly PdfFieldKey[] = [
  'guestName',
  'confirmationNumber',
  'arrivalDate',
  'departureDate',
  'accommodationType',
  'occupancy',
  'averageDailyRate',
  'rateIncludes',
  'totalAccommodation',
];

export function extractPdfFields(pages: readonly { page: number; markdown: string }[]): ExtractedPdfFields {
  const fields: ExtractedPdfFields = {
    guestName: [],
    confirmationNumber: [],
    arrivalDate: [],
    departureDate: [],
    accommodationType: [],
    occupancy: [],
    averageDailyRate: [],
    rateIncludes: [],
    totalAccommodation: [],
  };

  for (const page of pages) {
    for (const rawLine of page.markdown.split(/\r?\n/)) {
      const line = rawLine.replace(/\*\*|__/g, '').replace(/`/g, '');
      PDF_FIELD_LABEL_PATTERN.lastIndex = 0;
      const matches = [...line.matchAll(PDF_FIELD_LABEL_PATTERN)];
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index]!;
        const label = match[1]?.replace(/\s+/g, ' ').trim() ?? '';
        const key = PDF_FIELD_KEYS[label.toLowerCase()];
        if (!key) continue;
        const start = match.index! + match[0].length;
        const end = matches[index + 1]?.index ?? line.length;
        let value = line.slice(start, end);
        if (key === 'totalAccommodation') value = value.replace(/\s+pro\s*forma\b.*$/i, '');
        value = value
          .replace(/^[\s|:;]+/, '')
          .replace(/[\s|;*]+$/, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (value) fields[key].push({ value, pageNumber: page.page + 1, label });
      }
    }
  }
  return fields;
}

export function identifierValues(text: string): Set<string> {
  const values = new Set<string>();
  IDENTIFIER_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    values.add(match[0]!.toUpperCase());
  }
  return values;
}

export function confirmationNumberCandidates(
  fields: ExtractedPdfFields,
): Array<{ value: string; pageNumber: number }> {
  return fields.confirmationNumber.flatMap(({ value, pageNumber }) =>
    [...identifierValues(value)].map((candidate) => ({ value: candidate, pageNumber })),
  );
}
