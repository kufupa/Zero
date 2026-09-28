/** Quote-only router. Bed words are not room codes. Never invent adults from room quantity. */

export const QUOTE_NATIVE_ROOM_CODES = [
  'DLXQN',
  'DLXTWN',
  'DLXKNG',
  'EXKNG',
  'LUXKNG',
  'SKNG',
  'STQN',
  'STWN',
  'SUITE',
] as const;

const NATIVE = new Set<string>(QUOTE_NATIVE_ROOM_CODES);
const BED = /^(singles?|twins?|doubles?|queens?|kings?)$/i;
const BED_IN = /\b(singles?|twins?|doubles?|queens?|kings?)\b/i;
const PRODUCT = /\b(standard|deluxe|luxury|executive)\b/i;

export type QuoteGateFlag = 'UNREAD_PDF' | 'BAD_ROOM' | 'FAKE_PAX' | 'YEAR_QTY' | 'INVENTED_MONEY';

function bedName(raw: string): string {
  const word = raw.toLowerCase();
  if (word.startsWith('single')) return 'single';
  if (word.startsWith('twin')) return 'twin';
  if (word.startsWith('double')) return 'double';
  if (word.startsWith('queen')) return 'queen';
  return 'king';
}

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const GAP = '[^\\S\\n]*\\n?[^\\S\\n]*';
const DATE =
  `(?<![-–\\d])(20\\d{2}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2}[/.-]\\d{1,2}(?!\\d)|${MONTH}[a-z]*\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s*${MONTH}[a-z]*(?:\\s+\\d{2,4})?|\\d{1,2}-[A-Za-z]{3}-\\d{4})`;
const MONEY = '([0-9][0-9\\s.,]*)';

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function dateKey(raw: string): string | undefined {
  const text = raw.trim().replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');
  const iso = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${Number(iso[2])}-${Number(iso[3])}`;
  const numeric = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (numeric) return `${numeric[3]}-${Number(numeric[2])}-${Number(numeric[1])}`;
  const dayMonth = text.match(/^(\d{1,2})[/.-](\d{1,2})$/);
  if (dayMonth && Number(dayMonth[2]) >= 1 && Number(dayMonth[2]) <= 12) {
    return `*-${Number(dayMonth[2])}-${Number(dayMonth[1])}`;
  }
  const dashed = text.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
  if (dashed) {
    const month = MONTH_INDEX[dashed[2].toLowerCase().slice(0, 3)];
    if (month) return `${dashed[3]}-${month}-${Number(dashed[1])}`;
  }
  const monthFirst = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthFirst) {
    const month = MONTH_INDEX[monthFirst[1].toLowerCase().slice(0, 3)];
    if (month) return `${monthFirst[3]}-${month}-${Number(monthFirst[2])}`;
  }
  const named = text.match(/^(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s*([A-Za-z]+)(?:\s+(\d{2,4}))?$/i);
  if (!named) return undefined;
  const month = MONTH_INDEX[named[2].toLowerCase().slice(0, 3)];
  if (!month) return undefined;
  const day = Number(named[1]);
  if (!named[3]) return `*-${month}-${day}`;
  const year = named[3].length === 2 ? String(2000 + Number(named[3])) : named[3];
  return `${year}-${month}-${day}`;
}

function oneCalendarDay(values: string[]): string | undefined {
  const keys = values.map((value) => dateKey(value));
  const concrete = [...new Set(keys.filter((key) => key && !key.startsWith('*-')))] as string[];
  if (concrete.length > 1) return undefined;
  if (concrete.length === 1) {
    const [, month, day] = concrete[0].split('-');
    const compatible = keys.every((key) => !key || key === concrete[0] || key === `*-${month}-${day}`);
    if (!compatible) return undefined;
    return [...values].sort(
      (left, right) => Number(/\d{2,4}$/.test(right.trim())) - Number(/\d{2,4}$/.test(left.trim())) || right.length - left.length,
    )[0];
  }
  const undated = [...new Set(keys.filter((key) => key?.startsWith('*-')))];
  if (undated.length === 1 && keys.every((key) => key === undated[0])) return values[0];
  return undefined;
}

function withWrappedYear(text: string, value: string): string {
  if (/\d{4}/.test(value)) return value;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*\\n\\s*(20\\d{2})\\b`));
  return match ? `${value} ${match[1]}` : value;
}

export function foldMoneyText(text: string): string {
  return text.replace(/(\d)\s+(?=\d{3}\b)/g, '$1').replace(/,(?=\d{3}\b)/g, '').replace(/(\d),(\d{2})\b/g, '$1.$2');
}

export function moneyIsInSource(value: string, source: string): boolean {
  const digits = value.replace(/[^\d.]/g, '');
  if (!digits) return true;
  const folded = foldMoneyText(source);
  if (folded.includes(digits)) return true;
  return digits.endsWith('.00') && folded.includes(digits.slice(0, -3));
}

function moneyAmount(raw: string): string | undefined {
  if (/\d{1,2}[,/.-]\s*(?:19|20)\d{2}/.test(raw) || /\b20\d{2}\b/.test(raw)) return undefined;
  const folded = foldMoneyText(raw).replace(/[^\d.]/g, '');
  if (!/^\d+(\.\d{2})?$/.test(folded)) return undefined;
  const [whole, cents = '00'] = folded.split('.');
  const amount = Number(whole);
  if (!Number.isFinite(amount) || amount < 50 || amount > 500000) return undefined;
  return `${whole}.${cents.slice(0, 2).padEnd(2, '0')}`;
}

function cleanDate(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const duplicatedDay = text.match(/^(\d{1,2})((?:st|nd|rd|th)?(?:\s+of)?\s+[A-Za-z]+)\s+\1$/i);
  return duplicatedDay ? `${duplicatedDay[1]}${duplicatedDay[2]}` : text;
}

function labeledDates(text: string, label: RegExp): string[] {
  return unique(
    [...text.matchAll(label)]
      .map((match) => cleanDate(match.slice(1).find((group) => Boolean(group)) || ''))
      .filter(Boolean),
  );
}

function nightlyRates(text: string): string[] {
  const found: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    if (!/rate per night|daily rate|single rate|agreed rate|rate honour|per night/i.test(line)) continue;
    if (/arrival snack|platter|vat|levy/i.test(line)) continue;
    const window =
      /daily rate|agreed rate|rate honour/i.test(line) && !/(?:ZAR|\bR)(?=\s*\d)/i.test(line)
        ? `${line}\n${lines[i + 1] || ''}`
        : line;
    const tagged = [...window.matchAll(new RegExp(`(?:ZAR|\\bR)(?=\\s*\\d)\\s*${MONEY}`, 'gi'))];
    if (tagged.length === 0 && /daily rate/i.test(window)) {
      const bare = window.match(new RegExp(`daily rate[:\\s]+${MONEY}`, 'i'));
      const amount = bare ? moneyAmount(bare[1] || '') : undefined;
      if (amount) found.push(amount);
      continue;
    }
    const alternatives = /\/\s*double|–\s*double|-\s*double|room only/i.test(window);
    const chosen = alternatives ? tagged : tagged.slice(0, 1);
    for (const match of chosen) {
      const amount = moneyAmount(match[1] || '');
      if (amount) found.push(amount);
    }
  }
  return unique(found);
}

export function isAvailabilityPing(text: string): boolean {
  return /vacant, clean, inspected|update room availability/i.test(text) && !/check[\s-]*in|arrival date/i.test(text);
}

/** Copy a quote field only when the opened text labels it. One value. No guesses. */
export function fillQuoteFromReadText(
  request: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...request };
  delete next.boardBasis;
  if (!text.trim()) return next;
  for (const key of ['amount', 'rateQuoted'] as const) {
    const value = String(next[key] ?? '');
    const digits = value.replace(/[^\d]/g, '');
    const normalized = moneyAmount(value);
    if (/^(?:19|20)\d{2}$/.test(digits) || !moneyIsInSource(value, text) || !normalized) delete next[key];
    else next[key] = normalized;
  }
  const stayLabeled =
    /check(?:ing)?[\s-]*in|check(?:ing)?[\s-]*out|\barrival(?:\s+date)?\s*[:@\-–—]|\bdeparture(?:\s+date)?\s*[:@\-–—]/i.test(
      text,
    );
  if (!stayLabeled && /per month|\bp\/m\b|subscription/i.test(text)) {
    delete next.amount;
    delete next.rateQuoted;
  }
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(String(next.arrival || ''))) delete next.arrival;
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(String(next.departure || ''))) delete next.departure;
  if (
    /not a room quote|authorisation failed|bank payment notification/i.test(text) &&
    !/check(?:ing)?[\s-]*in|arriv(?:al|e)\s*[:@\-–—]/i.test(text)
  ) {
    return next;
  }
  const checkIn = labeledDates(
    text,
    new RegExp(
      `check(?:ing)?[\\s-]*in(?:\\s+date)?${GAP}[:@\\-–—,]?[*_]{0,2}${GAP}(?:on\\s+the\\s+|on\\s+|the\\s+)?(?:(?!date\\b|on\\b|the\\b)[A-Za-z]{2,9},?[^\\S\\n]+)?${DATE}`,
      'gi',
    ),
  );
  const arrival = labeledDates(
    text,
    new RegExp(`\\barriv(?:al|e)(?:\\s+date)?${GAP}[:@\\-–—,]?[*_]{0,2}${GAP}(?:[A-Za-z]{3,12},[^\\S\\n]*)?${DATE}`, 'gi'),
  );
  const checkOut = labeledDates(
    text,
    new RegExp(
      `check(?:ing)?[\\s-]*out(?:\\s+date)?${GAP}[:@\\-–—,]?[*_]{0,2}${GAP}(?:on\\s+the\\s+|on\\s+|the\\s+)?(?:(?!date\\b|on\\b|the\\b)[A-Za-z]{2,9},?[^\\S\\n]+)?${DATE}`,
      'gi',
    ),
  );
  const departure = labeledDates(
    text,
    new RegExp(`\\bdepart(?:ure)?(?:\\s+date)?${GAP}[:@\\-–—,]?[*_]{0,2}${GAP}(?:[A-Za-z]{3,12},[^\\S\\n]*)?${DATE}`, 'gi'),
  );
  const fullYear = (value: string) => !/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(value);
  const arrivals = unique([...checkIn, ...arrival]).filter(fullYear);
  const departures = unique([...checkOut, ...departure]).filter(fullYear);
  const arrivalDay = oneCalendarDay(arrivals);
  const departureDay = oneCalendarDay(departures);
  const conflict = (values: string[]) => new Set(values.map((value) => dateKey(value)).filter(Boolean)).size > 1;
  if (arrivalDay) next.arrival = arrivalDay;
  else if (conflict(arrivals) || arrivals.length === 0) delete next.arrival;
  else if (arrivals.length === 1) next.arrival = arrivals[0];
  if (departureDay) next.departure = departureDay;
  else if (conflict(departures) || departures.length === 0) delete next.departure;
  else if (departures.length === 1) next.departure = departures[0];
  if (typeof next.arrival === 'string') next.arrival = withWrappedYear(text, next.arrival);
  if (typeof next.departure === 'string') next.departure = withWrappedYear(text, next.departure);
  if (next.arrival && !dateKey(String(next.arrival))) delete next.arrival;
  if (next.departure && !dateKey(String(next.departure))) delete next.departure;
  const openWindow = text.match(/(?:applications?\s+open|registration\s+open|\bopen:)\s*([^\n]+)/i);
  if (openWindow && !/check(?:ing)?[\s-]*in\s*[:@\-–—]?\s*(?:on\s+)?(?:the\s+)?\d|check(?:ing)?[\s-]*in\s*[:@\-–—]?\s*\n\s*20\d{2}/i.test(text)) {
    const window = openWindow[1] || '';
    if (next.arrival && window.includes(String(next.arrival))) delete next.arrival;
    if (next.departure && window.includes(String(next.departure))) delete next.departure;
  }
  const bedCounts = [...text.matchAll(/\b(single|twin|double|queen|king)\s+rooms?\s*:\s*(\d{1,3})/gi)];
  if (new Set(bedCounts.map((match) => (match[1] || '').toLowerCase())).size > 1) {
    delete next.bedPreference;
    delete next.roomQty;
  }
  const roomBeds = unique(
    [...text.matchAll(/\b(single|twin|double|queen|king)\s+rooms?\b/gi)].map((match) => (match[1] || '').toLowerCase()),
  );
  if (roomBeds.length > 1) {
    delete next.bedPreference;
    delete next.bedType;
  }
  const stayRange = text.match(
    /check(?:ing)?[\s-]*in\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\s*([A-Za-z]+)\s+(\d{4})/i,
  );
  if (stayRange && !next.arrival && !next.departure) {
    const month = stayRange[3] || '';
    const year = stayRange[4] || '';
    next.arrival = `${stayRange[1]} ${month} ${year}`;
    next.departure = `${stayRange[2]} ${month} ${year}`;
  }
  const andOut = [...text.matchAll(/check(?:ing)?[\s-]*in\s+(\d{1,2})\s+and\s+out\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{2,4}))?/gi)];
  const fromTo = [
    ...text.matchAll(
      /\bfrom\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+to\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?/gi,
    ),
  ];
  if (fromTo.length === 1 && arrivals.length === 0 && departures.length === 0 && !next.arrival && !next.departure) {
    const match = fromTo[0];
    const year = match[5] ? ` ${match[5]}` : '';
    next.arrival = `${match[1]} ${match[2]}${year}`;
    next.departure = `${match[3]} ${match[4]}${year}`;
  }
  if (andOut.length === 1 && arrivals.length === 0 && departures.length === 0) {
    const match = andOut[0];
    const year = match[4] ? ` ${match[4]}` : '';
    next.arrival = `${match[1]} ${match[3]}${year}`;
    next.departure = `${match[2]} ${match[3]}${year}`;
  }
  const cap = text.match(/(?:capped at|dinner limit)\s*(?:R|ZAR)?\s*([0-9][0-9\s.,]*\d)/i);
  if (cap && next.amount != null && moneyAmount(cap[1] || '') === String(next.amount)) delete next.amount;
  const rates = nightlyRates(text);
  if (rates.length > 1) delete next.rateQuoted;
  else if (!next.rateQuoted && rates.length === 1) next.rateQuoted = rates[0];
  if (!next.roomQty) {
    const qty = unique([...text.matchAll(/\b(\d{1,3})\s+rooms?\s+x\s+\d+/gi)].map((match) => match[1] || ''));
    if (qty.length === 1) {
      const parsed = Number(qty[0]);
      if (parsed >= 1 && parsed <= 40) next.roomQty = parsed;
    }
  }
  const adults = String(next.adults ?? '');
  if (/^\d{1,3}$/.test(adults)) {
    const stated = new RegExp(
      `\\b${adults}\\s*(?:pax|adults?|people|guests?|delegates?|attendees?)\\b|\\b(?:pax|adults?|people|guests?|delegates?|attendees?)\\s*${adults}\\b`,
      'i',
    ).test(text);
    const roomCount = new RegExp(`\\b${adults}\\s+(?:single|twin|double)s?\\s+rooms?\\b`, 'i').test(text);
    const copiedFromQty = next.roomQty != null && Number(next.adults) === Number(next.roomQty);
    if ((roomCount || copiedFromQty) && !stated) delete next.adults;
  }
  if (!next.roomType) {
    const codes = unique(
      [...text.toUpperCase().matchAll(/\b(DLXQN|DLXTWN|DLXKNG|EXKNG|LUXKNG|SKNG|STQN|STWN|SUITE)\b/g)].map(
        (match) => match[1] || '',
      ),
    );
    if (codes.length === 1) next.roomType = codes[0];
  }
  return next;
}

export function routeQuoteRequest(request: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...request };
  delete next.boardBasis;
  const room = String(next.roomType || '').trim();
  if (!room) return next;
  const code = room.toUpperCase();
  if (NATIVE.has(code)) {
    next.roomType = code;
    return next;
  }
  if (/voucher/i.test(room) || room.length > 40) {
    delete next.roomType;
    return next;
  }
  if (PRODUCT.test(room)) {
    delete next.roomType;
    return next;
  }
  if (BED.test(room.replace(/\s+rooms?$/i, '').trim())) {
    next.bedPreference = bedName(room);
    delete next.roomType;
    return next;
  }
  const inner = room.match(BED_IN);
  if (inner) {
    next.bedPreference = bedName(inner[1]);
    delete next.roomType;
    return next;
  }
  delete next.roomType;
  return next;
}

function pdfNamed(row: { attachmentRefs?: Array<{ filename?: string | null; contentType?: string | null }> }): boolean {
  return (row.attachmentRefs || []).some((ref) => /pdf/i.test(`${ref.filename || ''} ${ref.contentType || ''}`));
}

export function quoteGateFlags(row: {
  attachmentRefs?: Array<{ filename?: string | null; contentType?: string | null }>;
  attachmentText?: string;
  inbound?: { textBody?: string };
  gold?: { textBody?: string } | null;
  priorInbounds?: Array<{ textBody?: string }>;
  proposedActions?: Array<{ tool?: string; status?: string; request?: Record<string, unknown> }>;
}): QuoteGateFlag[] {
  const flags = new Set<QuoteGateFlag>();
  const stored = [
    row.inbound?.textBody || '',
    row.attachmentText || '',
    row.gold?.textBody || '',
    ...(row.priorInbounds || []).map((prior) => prior.textBody || ''),
  ].join('\n');
  const attachment = String(row.attachmentText || '').trim();
  const soup = attachment.startsWith('%PDF');
  if (pdfNamed(row) && (!attachment || soup)) flags.add('UNREAD_PDF');
  for (const action of row.proposedActions || []) {
    if (action.tool !== 'hms_quote_stay') continue;
    if (action.status !== 'live' && action.status !== 'needs_human') continue;
    const request = action.request || {};
    const room = String(request.roomType || '').trim();
    if (room && !NATIVE.has(room.toUpperCase())) flags.add('BAD_ROOM');
    if (request.adults != null && request.roomQty != null && Number(request.adults) === Number(request.roomQty)) {
      const count = String(Number(request.adults));
      const stated = new RegExp(
        `\\b${count}\\s*(?:pax|adults?|people|guests?|delegates?|attendees?)\\b|\\b(?:pax|adults?|people|guests?|delegates?|attendees?)\\s*${count}\\b`,
        'i',
      ).test(stored);
      if (!stated) flags.add('FAKE_PAX');
    }
    const qty = String(request.roomQty ?? '').trim();
    if (/^(?:19|20)\d{2}$/.test(qty)) flags.add('YEAR_QTY');
    for (const key of ['amount', 'rateQuoted'] as const) {
      const value = String(request[key] ?? '');
      if (value && !moneyIsInSource(value, stored)) flags.add('INVENTED_MONEY');
    }
  }
  return [...flags];
}
