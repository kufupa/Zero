export type StayDateAnchorContext = {
  receivedAt?: string | null;
  sourceText?: string;
};

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'Jan(?:uary)?',
  'Feb(?:ruary)?',
  'Mar(?:ch)?',
  'Apr(?:il)?',
  'May',
  'Jun(?:e)?',
  'Jul(?:y)?',
  'Aug(?:ust)?',
  'Sep(?:tember)?',
  'Oct(?:ober)?',
  'Nov(?:ember)?',
  'Dec(?:ember)?',
];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type YearIntent = number | 'ambiguous' | null;

function validDay(value: string | null | undefined): value is string {
  if (!value || !ISO_DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function dayNumber(value: string): number {
  return Number(value.slice(8, 10));
}

function dateInYear(value: string, year: number): string | null {
  const candidate = `${year}${value.slice(4)}`;
  return validDay(candidate) ? candidate : null;
}

function addDays(value: string, days: number): string {
  const time = Date.parse(`${value}T00:00:00.000Z`) + days * DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/** Received date in Centurion's local calendar, not UTC's calendar. */
export function receivedDateAtHotel(receivedAt: string | null | undefined): string | null {
  if (!receivedAt) return null;
  const instant = new Date(receivedAt);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** Text used to distinguish an explicit trip year from a year the model supplied. */
export function stayDateSourceText(selection: {
  subject?: string;
  bodyText?: string;
  preceding?: Array<{ bodyText: string }>;
  attachments?: Array<{ text?: string }>;
}): string {
  return [
    selection.subject ? `Subject: ${selection.subject}` : '',
    selection.bodyText ?? '',
    ...(selection.preceding ?? []).map(({ bodyText }) => bodyText),
    ...(selection.attachments ?? []).map(({ text }) => text ?? ''),
  ]
    .filter(Boolean)
    .join('\n');
}

function contextualTripYear(sourceText: string): YearIntent {
  const years = [...sourceText.matchAll(/\b(?:19|20)\d{2}\b/g)];
  const contextual = years.filter((match) => {
    const [year] = match;
    const position = match.index ?? 0;
    const start = Math.max(0, position - 36);
    const end = Math.min(sourceText.length, position + year.length + 36);
    return /\b(?:tour|trip|stay|reservation|booking|travel|visit|holiday|conference|event|dates?)\b/i.test(
      sourceText.slice(start, end),
    );
  });
  const unique = [...new Set(contextual.map(([year]) => Number(year)))];
  if (unique.length === 1) return unique[0]!;
  return unique.length > 1 ? 'ambiguous' : null;
}

function yearIntentForDate(sourceText: string, arrival: string): YearIntent {
  const month = Number(arrival.slice(5, 7));
  const day = dayNumber(arrival);
  const monthPattern = MONTHS[month - 1];
  if (!monthPattern) return null;
  const dayPattern = `0?${day}(?:st|nd|rd|th)?`;
  const datePatterns = [
    new RegExp(`\\b${dayPattern}(?:\\s*(?:-|–|—|to|through)\\s*\\d{1,2})?\\s+${monthPattern}\\b`, 'i'),
    new RegExp(`\\b${monthPattern}\\s+${dayPattern}(?:\\s*(?:-|–|—|to|through)\\s*\\d{1,2})?\\b`, 'i'),
  ];
  for (const line of sourceText.split(/\r?\n/)) {
    if (!datePatterns.some((pattern) => pattern.test(line))) continue;
    const years = [...line.matchAll(/\b(?:19|20)\d{2}\b/g)].map(([year]) => Number(year));
    const unique = [...new Set(years)];
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1) return 'ambiguous';
  }

  const subject = sourceText.match(/^Subject:\s*(.*)$/im)?.[1] ?? '';
  const subjectYears = [...subject.matchAll(/\b(?:19|20)\d{2}\b/g)].map(([year]) => Number(year));
  const uniqueSubjectYears = [...new Set(subjectYears)];
  if (uniqueSubjectYears.length === 1) return uniqueSubjectYears[0]!;
  if (uniqueSubjectYears.length > 1) return 'ambiguous';

  return contextualTripYear(sourceText);
}

function targetYearFromRelativePhrase(sourceText: string, referenceYear: number): YearIntent {
  const lower = sourceText.toLowerCase();
  if (/\byear after next\b/.test(lower)) return referenceYear + 2;
  if (/\b(?:next|coming|following) year\b/.test(lower)) return referenceYear + 1;
  if (/\b(?:this|current) year\b/.test(lower)) return referenceYear;
  return null;
}

function explicitYearIntent(sourceText: string, arrival: string, referenceYear: number): YearIntent {
  const specific = yearIntentForDate(sourceText, arrival);
  if (specific !== null) return specific;
  const relative = targetYearFromRelativePhrase(sourceText, referenceYear);
  if (relative !== null) return relative;
  return null;
}

function nextOccurrence(value: string, referenceDate: string): string | null {
  const firstYear = Number(referenceDate.slice(0, 4));
  for (let year = firstYear; year <= firstYear + 8; year += 1) {
    const candidate = dateInYear(value, year);
    if (candidate && candidate >= referenceDate) return candidate;
  }
  return null;
}

function nextWeekdayAfter(referenceDate: string, weekday: string): string | null {
  const target = WEEKDAYS.findIndex((day) => day.toLowerCase() === weekday.toLowerCase());
  if (target < 0) return null;
  const referenceTime = Date.parse(`${referenceDate}T00:00:00.000Z`);
  const current = new Date(referenceTime).getUTCDay();
  const daysAhead = (target - current + 7) % 7 || 7;
  return addDays(referenceDate, daysAhead);
}

/**
 * Re-anchor model-produced requested dates to the selected email's receipt date. An explicit trip year wins; otherwise
 * partial dates use their next calendar occurrence, and "next Friday" means the first Friday after receipt.
 */
export function anchorStayDateRange(
  range: { arrival: string | null | undefined; departure: string | null | undefined },
  context: StayDateAnchorContext,
): { arrival: string | null; departure: string | null } {
  const { arrival, departure } = range;
  if (!validDay(arrival) || !validDay(departure) || departure <= arrival) {
    return { arrival: arrival ?? null, departure: departure ?? null };
  }
  const referenceDate = receivedDateAtHotel(context.receivedAt);
  if (!referenceDate) return { arrival, departure };
  const nights = (Date.parse(`${departure}T00:00:00.000Z`) - Date.parse(`${arrival}T00:00:00.000Z`)) / DAY_MS;
  if (!(nights > 0)) return { arrival, departure };

  const sourceText = context.sourceText ?? '';
  const explicitYear = explicitYearIntent(sourceText, arrival, Number(referenceDate.slice(0, 4)));
  let anchoredArrival: string | null = null;
  if (typeof explicitYear === 'number') {
    anchoredArrival = dateInYear(arrival, explicitYear);
  } else if (explicitYear === 'ambiguous') {
    return { arrival, departure };
  } else {
    const relativeWeekday = sourceText.match(/\bnext\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i)?.[1];
    anchoredArrival = relativeWeekday
      ? nextWeekdayAfter(referenceDate, relativeWeekday)
      : nextOccurrence(arrival, referenceDate);
  }
  if (!anchoredArrival) return { arrival, departure };
  return { arrival: anchoredArrival, departure: addDays(anchoredArrival, nights) };
}
