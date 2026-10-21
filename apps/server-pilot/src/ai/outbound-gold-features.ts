/** Pure outbound-gold helpers. No DB, no network. Safe to import without DATABASE_URL. */

export const OUTBOUND_GOLD_PROD_INPUT = 'readQuoteAttachments → selectionToAgentPrompt' as const;
export const OUTBOUND_GOLD_VISION_PARITY = 'gap' as const;

export const OUTBOUND_GOLD_COUNT_KEYS = [
  'rows',
  'letters',
  'lettersCovered',
  'lettersUncovered',
  'coveragePass',
  'cards',
  'distinctDateSets',
  'dateSetCardPass',
  'withReply',
  'withLetter',
  'withQuotePdf',
  'n',
  'scoreKind',
  'label',
  'visionParity',
  'prodInput',
  'jsonlErrors',
] as const;

export type OutboundGoldCountKey = (typeof OUTBOUND_GOLD_COUNT_KEYS)[number];

export type LetterFields = {
  guest: string | null;
  conf: string | null;
  arrival: string | null;
};

export type GoldGuestConf = {
  guest: string | null;
  conf: string | null;
};

export type GoldLetterInput = {
  id: string;
  guest?: string | null;
  conf?: string | null;
  arrival?: string | null;
  subject?: string;
  filename?: string;
  pdfText?: string;
};

export type GoldCardInput = {
  id: string;
  arrival?: string | null;
  departure?: string | null;
  guest?: string | null;
  conf?: string | null;
  guests?: GoldGuestConf[];
};

export type OutboundGoldFixtureRow = {
  id: string;
  replyId?: string | null;
  letterId?: string | null;
  quotePdfId?: string | null;
  letter?: Omit<GoldLetterInput, 'id'> | null;
  /** All letters for this request. Preferred over repeating `letter`+`cards` per letter. */
  letters?: GoldLetterInput[];
  cards?: GoldCardInput[];
  /** Extraction kind. Booking/quote match guest+arrival; amend still needs conf. */
  kind?: string | null;
};

export type CoverageResult = {
  pass: boolean;
  letters: number;
  lettersCovered: number;
  lettersUncovered: number;
  cards: number;
  distinctDateSets: number;
  dateSetCardPass: boolean;
};

export type ScoreKindReport = {
  scoreKind: 'behaviour_check' | 'rate';
  n: number;
  label: string;
};

export type OutboundGoldSummary = CoverageResult &
  ScoreKindReport & {
    rows: number;
    withReply: number;
    withLetter: number;
    withQuotePdf: number;
    visionParity: typeof OUTBOUND_GOLD_VISION_PARITY;
    prodInput: typeof OUTBOUND_GOLD_PROD_INPUT;
    jsonlErrors: number;
  };

const LETTER_CONF_RE = /^HRCEN_Confirmation_Letter_(\d{8})(?:\b|\.|$)/i;
const LETTER_GUEST_RE = /Confirmation Letter_(.*?)\s*\(n[°ºo]\s*\d/i;
const ARRIVAL_DMY_RE = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/;
const ARRIVAL_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function fileName(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || value;
}

function padIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!valid) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function parseLetterGuest(subject: string | null | undefined): string | null {
  const raw = text(subject);
  if (!raw) return null;
  const match = raw.match(LETTER_GUEST_RE);
  if (!match?.[1]) return null;
  const guest = match[1].replace(/\s+/g, ' ').trim();
  return guest || null;
}

export function parseLetterConf(filename: string | null | undefined): string | null {
  const raw = text(filename);
  if (!raw) return null;
  const match = fileName(raw).match(LETTER_CONF_RE);
  return match?.[1] ?? null;
}

export function parseLetterArrival(pdfText: string | null | undefined): string | null {
  const raw = text(pdfText);
  if (!raw) return null;
  const arrivalRe = /\bArrival\b/gi;
  let hit: RegExpExecArray | null;
  while ((hit = arrivalRe.exec(raw))) {
    const chunk = raw.slice(hit.index, hit.index + 100);
    const dmy = chunk.match(ARRIVAL_DMY_RE);
    if (dmy) {
      const day = Number(dmy[1]);
      const month = Number(dmy[2]);
      let year = Number(dmy[3]);
      if (year < 100) year += 2000;
      const iso = padIso(year, month, day);
      if (iso) return iso;
    }
    const isoMatch = chunk.match(ARRIVAL_ISO_RE);
    if (isoMatch) {
      const iso = padIso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
      if (iso) return iso;
    }
  }
  return null;
}

export function parseLetterFields(input: {
  subject?: string;
  filename?: string;
  pdfText?: string;
}): LetterFields {
  return {
    guest: parseLetterGuest(input.subject),
    conf: parseLetterConf(input.filename),
    arrival: parseLetterArrival(input.pdfText),
  };
}

function normalizeName(value: string | null | undefined): string | null {
  const raw = text(value);
  return raw ? raw.toLowerCase().replace(/\s+/g, ' ') : null;
}

function normalizeConf(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  const base = raw.match(/^(\d{8})(?:-\d+)?$/);
  return base?.[1] ?? raw;
}

function dateSetKey(arrival: string | null, departure: string | null): string {
  return `${arrival ?? ''}|${departure ?? ''}`;
}

function resolveLetter(input: GoldLetterInput): LetterFields & { id: string } {
  const parsed = parseLetterFields(input);
  return {
    id: input.id,
    guest: text(input.guest) ?? parsed.guest,
    conf: normalizeConf(input.conf) ?? parsed.conf,
    arrival: text(input.arrival) ?? parsed.arrival,
  };
}

function resolveCard(input: GoldCardInput): {
  id: string;
  arrival: string | null;
  departure: string | null;
  guests: GoldGuestConf[];
} {
  const guests = input.guests?.length
    ? input.guests.map((row) => ({ guest: text(row.guest), conf: normalizeConf(row.conf) }))
    : [{ guest: text(input.guest), conf: normalizeConf(input.conf) }];
  return {
    id: input.id,
    arrival: text(input.arrival),
    departure: text(input.departure),
    guests,
  };
}

export function requireLetterConfirmation(kind: string | null | undefined): boolean {
  return kind !== 'booking' && kind !== 'quote';
}

function letterMatchesCard(
  letter: LetterFields,
  card: { arrival: string | null; guests: GoldGuestConf[] },
  requireConfirmation: boolean,
): boolean {
  if (!letter.guest || !letter.arrival) return false;
  if (requireConfirmation && !letter.conf) return false;
  if (letter.arrival !== card.arrival) return false;
  const guest = normalizeName(letter.guest);
  const conf = normalizeConf(letter.conf);
  return card.guests.some((row) => {
    if (normalizeName(row.guest) !== guest) return false;
    const cardConf = normalizeConf(row.conf);
    if (!requireConfirmation) {
      if (!cardConf || !conf) return true;
      return cardConf === conf;
    }
    return Boolean(conf) && cardConf === conf;
  });
}

export function checkLetterCoverage(input: {
  letters: readonly GoldLetterInput[];
  cards: readonly GoldCardInput[];
  requireConfirmation?: boolean;
}): CoverageResult {
  const requireConfirmation = input.requireConfirmation ?? true;
  const letters = input.letters.map(resolveLetter);
  const cards = input.cards.map(resolveCard);
  const covered = letters.filter((row) =>
    cards.some((card) => letterMatchesCard(row, card, requireConfirmation)),
  ).length;
  const dateSets = new Set(cards.map((card) => dateSetKey(card.arrival, card.departure)));
  const dateSetCardPass = cards.length === dateSets.size;
  const lettersUncovered = letters.length - covered;
  return {
    pass: lettersUncovered === 0 && dateSetCardPass && letters.length > 0,
    letters: letters.length,
    lettersCovered: covered,
    lettersUncovered,
    cards: cards.length,
    distinctDateSets: dateSets.size,
    dateSetCardPass,
  };
}

export function reportScoreKind(n: number): ScoreKindReport {
  if (n < 100) {
    return { scoreKind: 'behaviour_check', n, label: 'behaviour check, no rate' };
  }
  return { scoreKind: 'rate', n, label: 'rate' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function letterFieldOk(value: unknown): boolean {
  return value === undefined || value === null || isPlainObject(value);
}

function objectArrayFieldOk(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => isPlainObject(item));
}

function rowArtifactsOk(row: { letter?: unknown; letters?: unknown; cards?: unknown }): boolean {
  return letterFieldOk(row.letter) && objectArrayFieldOk(row.letters) && objectArrayFieldOk(row.cards);
}

function lettersForRow(row: OutboundGoldFixtureRow): GoldLetterInput[] {
  if (row.letters?.length) {
    return row.letters.map((item, index) => ({
      ...item,
      id: text(item.id) ?? `${row.id}:letter:${index}`,
    }));
  }
  if (!row.letter) return [];
  return [{ id: text(row.letterId) ?? `${row.id}:letter`, ...row.letter }];
}

export function parseFixtureJsonl(textValue: string): {
  rows: OutboundGoldFixtureRow[];
  jsonlErrors: number;
} {
  const rows: OutboundGoldFixtureRow[] = [];
  let jsonlErrors = 0;
  for (const line of textValue.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        jsonlErrors += 1;
        continue;
      }
      const record = value as Record<string, unknown>;
      const id = text(record.id);
      if (!id || !rowArtifactsOk(record)) {
        jsonlErrors += 1;
        continue;
      }
      rows.push({ ...(record as OutboundGoldFixtureRow), id });
    } catch {
      jsonlErrors += 1;
    }
  }
  return { rows, jsonlErrors };
}

export function scoreOutboundGoldFixture(
  rows: readonly OutboundGoldFixtureRow[],
  jsonlErrors = 0,
): OutboundGoldSummary {
  let letters = 0;
  let lettersCovered = 0;
  let lettersUncovered = 0;
  let cards = 0;
  let distinctDateSets = 0;
  let dateSetCardPass = true;
  let withReply = 0;
  let withLetter = 0;
  let withQuotePdf = 0;
  let scoredRows = 0;
  let errors = jsonlErrors;

  for (const row of rows) {
    if (!rowArtifactsOk(row)) {
      errors += 1;
      continue;
    }
    scoredRows += 1;
    if (text(row.replyId)) withReply += 1;
    const rowLetters = lettersForRow(row);
    if (text(row.letterId) || row.letter || rowLetters.length) withLetter += 1;
    if (text(row.quotePdfId)) withQuotePdf += 1;
    const coverage = checkLetterCoverage({
      letters: rowLetters,
      cards: row.cards ?? [],
      requireConfirmation: requireLetterConfirmation(row.kind),
    });
    letters += coverage.letters;
    lettersCovered += coverage.lettersCovered;
    lettersUncovered += coverage.lettersUncovered;
    cards += coverage.cards;
    distinctDateSets += coverage.distinctDateSets;
    if (!coverage.dateSetCardPass) dateSetCardPass = false;
  }

  return {
    pass: lettersUncovered === 0 && dateSetCardPass && letters > 0,
    letters,
    lettersCovered,
    lettersUncovered,
    cards,
    distinctDateSets,
    dateSetCardPass,
    ...reportScoreKind(letters),
    rows: scoredRows,
    withReply,
    withLetter,
    withQuotePdf,
    visionParity: OUTBOUND_GOLD_VISION_PARITY,
    prodInput: OUTBOUND_GOLD_PROD_INPUT,
    jsonlErrors: errors,
  };
}

export function formatAggregateStdout(summary: OutboundGoldSummary): string {
  const payload: Record<OutboundGoldCountKey, unknown> = {
    rows: summary.rows,
    letters: summary.letters,
    lettersCovered: summary.lettersCovered,
    lettersUncovered: summary.lettersUncovered,
    coveragePass: summary.pass,
    cards: summary.cards,
    distinctDateSets: summary.distinctDateSets,
    dateSetCardPass: summary.dateSetCardPass,
    withReply: summary.withReply,
    withLetter: summary.withLetter,
    withQuotePdf: summary.withQuotePdf,
    n: summary.n,
    scoreKind: summary.scoreKind,
    label: summary.label,
    visionParity: summary.visionParity,
    prodInput: summary.prodInput,
    jsonlErrors: summary.jsonlErrors,
  };
  return `${JSON.stringify(payload)}\n`;
}
