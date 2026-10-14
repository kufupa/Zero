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

/** Text used to verify model date evidence against the selected mail. */
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
  return Boolean(text && /\b(?:19|20)\d{2}\b/.test(text));
}

function hasStaffDateCorrection(note: string | undefined): boolean {
  if (!note?.trim()) return false;
  return (
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/i.test(note) ||
    MONTH_DAY.test(note) ||
    RELATIVE_WEEKDAY.test(note)
  );
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
  if (!validDay(arrival) || !validDay(departure) || departure <= arrival) {
    return { arrival: arrival ?? null, departure: departure ?? null };
  }

  const referenceDate = receivedDateAtHotel(context.receivedAt);
  if (!referenceDate) return { arrival, departure };
  if (hasStaffDateCorrection(context.staffNote)) return { arrival, departure };
  if (
    hasExplicitYear(context.sourceText) ||
    hasExplicitYear(context.yearEvidenceText) ||
    hasExplicitYear(context.subjectText)
  ) {
    return { arrival, departure };
  }

  const nights =
    (Date.parse(`${departure}T00:00:00.000Z`) - Date.parse(`${arrival}T00:00:00.000Z`)) / DAY_MS;
  if (!(nights > 0)) return { arrival, departure };

  const relativeWeekday = context.sourceText?.match(RELATIVE_WEEKDAY)?.[1];
  if (relativeWeekday) {
    const anchoredArrival = nextWeekdayAfter(referenceDate, relativeWeekday);
    return anchoredArrival
      ? { arrival: anchoredArrival, departure: addDays(anchoredArrival, nights) }
      : { arrival, departure };
  }

  if (arrival >= referenceDate) return { arrival, departure };
  const checkedStayText =
    Boolean(context.sourceText?.trim()) ||
    Boolean(context.subjectText?.trim()) ||
    Boolean(context.yearEvidenceText?.trim());
  if (!checkedStayText) return { arrival, departure };

  const anchoredArrival = nextOccurrence(arrival, referenceDate);
  return anchoredArrival
    ? { arrival: anchoredArrival, departure: addDays(anchoredArrival, nights) }
    : { arrival, departure };
}
