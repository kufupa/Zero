export type StayDateAnchorContext = {
  receivedAt?: string | null;
  /** Verified date phrase for this stay only. */
  sourceText?: string;
  /** Supplied only for a single-stay request. */
  subjectText?: string;
  /** Full selected body/subject text, supplied only for one stay to check explicit years. */
  yearEvidenceText?: string;
  /** Passed only for a matched or single-stay correction. */
  staffNote?: string;
  /** Existing-stay actions must not roll yearless dates into a new-request year. */
  allowYearlessRollover?: boolean;
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
const MONTH_DAY = new RegExp(
  `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS.join('|')})|(?:${MONTHS.join('|')})\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b`,
  'i',
);
const RELATIVE_WEEKDAY = /\bnext\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;
const RELATIVE_NEXT_YEAR = /\bnext\s+year\b/i;

function validDay(value: string | null | undefined): value is string {
  if (!value || !ISO_DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
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

/** Text used to verify date evidence from the selected message and its attachments only. */
export function stayDateSourceText(selection: {
  subject?: string;
  bodyText?: string;
  attachments?: Array<{ text?: string }>;
}): string {
  return [
    selection.subject ? `Subject: ${selection.subject}` : '',
    selection.bodyText ?? '',
    ...(selection.attachments ?? []).map(({ text }) => text ?? ''),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Current message body and subject only; excludes quoted history and attachments. */
export function stayDateYearEvidenceText(selection: {
  subject?: string;
  bodyText?: string;
}): string {
  return [selection.subject ? `Subject: ${selection.subject}` : '', selection.bodyText ?? '']
    .filter(Boolean)
    .join('\n');
}

function hasExplicitYear(text: string | undefined): boolean {
  if (!text) return false;
  const month = `(?:${MONTHS.join('|')})`;
  const monthDateYear = new RegExp(`${MONTH_DAY.source}\\s*,?\\s*\\b(?:19|20)\\d{2}\\b`, 'i');
  const monthRangeYear = new RegExp(
    `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s*[-–—]\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+${month}|${month}\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*[-–—]\\s*\\d{1,2}(?:st|nd|rd|th)?)\\s*,?\\s*(?:19|20)\\d{2}\\b`,
    'i',
  );
  return (
    monthDateYear.test(text) ||
    monthRangeYear.test(text) ||
    new RegExp(`\\b${month}\\s+(?:19|20)\\d{2}\\b`, 'i').test(text) ||
    /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b/.test(text)
  );
}

function hasUnambiguousYearForStay(text: string | undefined): boolean {
  if (!text) return false;
  const day = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
  const month = `(?:${MONTHS.join('|')})`;
  const monthDay = `${month}\\s+${day}`;
  const dayMonth = `${day}\\s+${month}`;
  const monthRange = `(?:${month}\\s+${day}\\s*[-–—]\\s*${day}|${day}\\s*[-–—]\\s*${day}\\s+${month})`;
  const explicitMonthDate = new RegExp(
    `\\b(?:${monthRange}|${monthDay}|${dayMonth})\\s*,?\\s*(?:19|20)\\d{2}\\b`,
    'gi',
  );
  const explicitMonthYear = new RegExp(`\\b${month}\\s+(?:19|20)\\d{2}\\b`, 'gi');
  const explicitDates = [
    ...text.matchAll(explicitMonthDate),
    ...text.matchAll(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g),
    ...text.matchAll(/\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b/g),
    ...text.matchAll(explicitMonthYear),
  ];
  return explicitDates.length === 1;
}

function hasStaffDateCorrection(note: string | undefined): boolean {
  if (!note?.trim()) return false;
  const numericDate =
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}-\d{1,2}(?:-\d{2,4})?\b(?!\s*(?:adults?|children?|guests?|rooms?|nights?|people|persons?|occupants?|pax)\b)/i;
  return numericDate.test(note) || MONTH_DAY.test(note) || RELATIVE_WEEKDAY.test(note);
}

function explicitRangeEndYear(text: string | undefined): number | null {
  if (!text) return null;
  const dates = [...text.matchAll(new RegExp(MONTH_DAY.source, 'gi'))];
  const years = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)];
  if (dates.length !== 2 || years.length !== 1) return null;
  const endOfSecondDate = dates[1]!.index! + dates[1]![0].length;
  return years[0]!.index! >= endOfSecondDate ? Number(years[0]![0]) : null;
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
  const current = new Date(`${referenceDate}T00:00:00.000Z`).getUTCDay();
  const daysAhead = (target - current + 7) % 7 || 7;
  return addDays(referenceDate, daysAhead);
}

/** Resolve dates per stay using staff, explicit years, verified relative phrases, then yearless rollover. */
export function anchorStayDateRange(
  range: { arrival: string | null | undefined; departure: string | null | undefined },
  context: StayDateAnchorContext,
): { arrival: string | null; departure: string | null } {
  const { arrival, departure } = range;
  if (!validDay(arrival)) return { arrival: arrival ?? null, departure: departure ?? null };
  const hasValidDeparture = validDay(departure);
  if (hasValidDeparture && departure <= arrival) {
    return { arrival, departure };
  }

  const referenceDate = receivedDateAtHotel(context.receivedAt);
  if (!referenceDate) return { arrival, departure: departure ?? null };
  if (hasStaffDateCorrection(context.staffNote)) return { arrival, departure: departure ?? null };

  const nights = hasValidDeparture
    ? (Date.parse(`${departure}T00:00:00.000Z`) - Date.parse(`${arrival}T00:00:00.000Z`)) / DAY_MS
    : null;
  const withArrival = (anchoredArrival: string) => ({
    arrival: anchoredArrival,
    departure: nights === null ? departure ?? null : addDays(anchoredArrival, nights),
  });

  const explicitEndYear = explicitRangeEndYear(context.sourceText);
  if (hasValidDeparture && explicitEndYear && Number(departure.slice(5, 7)) < Number(arrival.slice(5, 7))) {
    const mixedYearArrival = dateInYear(arrival, explicitEndYear - 1);
    const mixedYearDeparture = dateInYear(departure, explicitEndYear);
    if (mixedYearArrival && mixedYearDeparture) {
      return { arrival: mixedYearArrival, departure: mixedYearDeparture };
    }
  }
  if (
    hasExplicitYear(context.sourceText) ||
    hasUnambiguousYearForStay(context.yearEvidenceText) ||
    hasExplicitYear(context.subjectText)
  ) {
    return { arrival, departure: departure ?? null };
  }
  if (context.allowYearlessRollover === false) {
    return { arrival, departure: departure ?? null };
  }

  const selectedDateText = [context.sourceText, context.subjectText].filter(Boolean).join('\n');
  if (RELATIVE_NEXT_YEAR.test(selectedDateText)) {
    const anchoredArrival = dateInYear(arrival, Number(referenceDate.slice(0, 4)) + 1);
    return anchoredArrival ? withArrival(anchoredArrival) : { arrival, departure: departure ?? null };
  }

  const relativeWeekday = selectedDateText.match(RELATIVE_WEEKDAY)?.[1];
  if (relativeWeekday) {
    const anchoredArrival = nextWeekdayAfter(referenceDate, relativeWeekday);
    return anchoredArrival ? withArrival(anchoredArrival) : { arrival, departure: departure ?? null };
  }

  const checkedStayText =
    Boolean(context.sourceText?.trim()) ||
    Boolean(
      context.subjectText &&
        (MONTH_DAY.test(context.subjectText) || RELATIVE_NEXT_YEAR.test(context.subjectText) || RELATIVE_WEEKDAY.test(context.subjectText)),
    );
  if (!checkedStayText) return { arrival, departure: departure ?? null };

  const anchoredArrival = nextOccurrence(arrival, referenceDate);
  return anchoredArrival ? withArrival(anchoredArrival) : { arrival, departure: departure ?? null };
}
