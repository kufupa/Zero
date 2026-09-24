import { sanitizeHtmlBodyForStorage } from '../mail/sanitize-email-html.js';
import { collapseQuotedHtml } from '../mail/collapse-quoted-html.js';
import { createHash } from 'node:crypto';

/** Plan budget: ≤64 KiB UTF-8 for retained thread context text. */
export const THREAD_CONTEXT_MAX_BYTES = 64 * 1024;

export const RELATED_MESSAGE_SEARCH_MAX = 20;

export type LookupCandidate =
  | { id: string; kind: 'confirmation'; value: string }
  | { id: string; kind: 'external_reference'; value: string }
  | {
      id: string;
      kind: 'surname_dates';
      surname: string;
      arrivalDate: string;
      departureDate: string;
    };

/** Exact confirmation/external-ref candidates only — production live session entry. */
export type ExactLookupCandidate = Extract<
  LookupCandidate,
  { kind: 'confirmation' | 'external_reference' }
>;

/**
 * Live HRCEN confirmations are digit-bearing (often `########-#` / `n°…`).
 * Pure-alpha tokens from "Confirmation Letter_…" false-fire the labeled regex.
 * Explicit `CONF-*` / `EXT-*` forms remain valid even without digits.
 */
export function isPlausibleExactReservationValue(value: string): boolean {
  const v = value.trim().toUpperCase();
  if (v.length < 6 || v.length > 32) return false;
  if (!/^[A-Z0-9-]+$/.test(v)) return false;
  return /\d/.test(v) || /^(?:CONF|EXT)-[A-Z0-9-]+$/.test(v);
}

export function filterExactReservationCandidates(
  candidates: readonly LookupCandidate[],
): ExactLookupCandidate[] {
  return candidates.filter(
    (c): c is ExactLookupCandidate =>
      (c.kind === 'confirmation' || c.kind === 'external_reference') &&
      isPlausibleExactReservationValue(c.value),
  );
}

/**
 * Connected live lookup admission: prefer one exact confirmation/external
 * reference; if none exists, permit one body-derived surname/date candidate.
 * Multiple candidates remain ambiguous and must not be guessed between.
 */
export function selectConnectedLookupCandidate(
  candidates: readonly LookupCandidate[],
): LookupCandidate | null {
  const exact = filterExactReservationCandidates(candidates);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const surnameDates = candidates.filter((candidate) => candidate.kind === 'surname_dates');
  return surnameDates.length === 1 ? surnameDates[0]! : null;
}

/**
 * Plan signals for quote/group/event branches that need no reservation
 * prerequisite (Task 13 executable plan).
 */
export function detectDirectReadPlanRefs(segment: string): {
  hasGroupRef: boolean;
  hasEventRef: boolean;
} {
  return {
    hasGroupRef: /\b(group\s+block|group\s+booking|block\s+code|group\s+reservation)\b/i.test(
      segment,
    ),
    hasEventRef: /\b(event\s+booking|banquet|function\s+room|event\s+reservation)\b/i.test(segment),
  };
}

/**
 * Manual / shadow eligibility: exactly one confirmation or external_reference.
 * Rejects 0 and 2+ (ambiguous). Surname-only threads → null.
 */
export function requireExactlyOneExactCandidate(
  candidates: readonly LookupCandidate[],
): ExactLookupCandidate | null {
  const exact = filterExactReservationCandidates(candidates);
  return exact.length === 1 ? exact[0]! : null;
}

/** Oldest `receivedAt` then message id — canary / manual selection order. */
export function compareOldestReceivedAtThenId(
  a: { id: string; receivedAt: Date | null },
  b: { id: string; receivedAt: Date | null },
): number {
  const at = a.receivedAt?.getTime() ?? 0;
  const bt = b.receivedAt?.getTime() ?? 0;
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

/**
 * Walk rows oldest-first; return first with exactly one exact candidate.
 * Shared by live canary + unit proofs (not newest-first).
 */
export function selectOldestWithExactlyOneExact<T extends { id: string; receivedAt: Date | null }>(
  rows: readonly T[],
  textOf: (row: T) => string,
): { row: T; candidate: ExactLookupCandidate } | null {
  const sorted = [...rows].sort(compareOldestReceivedAtThenId);
  for (const row of sorted) {
    const exact = filterExactReservationCandidates(extractLookupCandidates(textOf(row)));
    if (exact.length === 1) {
      return { row, candidate: exact[0]! };
    }
  }
  return null;
}

export type ThreadContext = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  includedMessageIds: string[];
  threadStateVersion: string;
  normalizedText: string;
  lookupCandidates: LookupCandidate[];
  authorizedAttachmentIds: string[];
};

export type ThreadContextMessage = {
  id: string;
  transportId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  textBody: string | null;
  htmlBody: string | null;
  subject: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  attachmentIds: string[];
};

export type ThreadStateVersionMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  timestamp: string;
};

export type RelatedMessageHit = {
  messageId: string;
  excerpt: string;
};

export type RelatedMessageSearch = (args: {
  transportId: string;
  threadId: string;
  query: string;
  maxResults: number;
}) => Promise<RelatedMessageHit[]>;

export type BuildThreadContextInput = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  messages: readonly ThreadContextMessage[];
  latestDraftRevisionId: string | null;
  searchRelated?: RelatedMessageSearch;
};

const CONFIRMATION_RE =
  /\b(?:confirmation|conf(?:irmation)?\s*(?:#|no\.?|number)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/gi;
const BARE_CONF_RE = /\b(CONF-[A-Z0-9-]{2,28})\b/gi;
/** Centurion confirmation-letter subjects: `… (n°79798256-1)`. */
const N_DEGREE_CONF_RE = /\bn[°ºo]\s*([0-9]{6,14}(?:-\d{1,4})?)\b/gi;
/** Common hotel correspondence labels: `booking reference: 6197775252`. */
const BOOKING_REFERENCE_RES = [
  /\b(?:booking|reservation|stay)\s+reference(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
  /\breference\s*(?:number|no\.?|#)\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
  /\breference\s*\([^\n)]{0,96}\)\s*[*]?\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
];
/** Explicit provider-labelled reference; unlike generic booking labels it is an external ref. */
const LEKKESLAAP_EXTERNAL_RE =
  /^[ \t]*LekkeSlaap\s+booking\s+reference\s+number[ \t]*:[ \t]*(LS-[A-Z0-9][A-Z0-9-]{2,29})[ \t]*\r?$/gim;
/**
 * Centurion booking summaries sometimes put the numeric confirmation in
 * parentheses without a `confirmation:` label (for example after a booking
 * date range).  Admit only the distinctive digit-hyphen shape when the same
 * authored line/context explicitly describes a booking/reservation/stay.
 * Quoted lines are excluded so an old reply cannot become a new lookup ref.
 */
const BARE_NUMERIC_CONF_RE = /(?<![\w-])(\d{6,14}-\d{1,4})(?![\w-])/g;
/** SynXis channel confirmation is an external reference, not the HMS stay id. */
const SYNXIS_CONFIRMATION_RE =
  /^\s*Confirmation Number\/Cancellation Number:\s*([A-Z0-9][A-Z0-9-]{3,31})\s*\/[^\r\n]*$/gim;
const EXTERNAL_RE =
  /\b(?:external\s+reference|ext(?:ernal)?\s*(?:ref(?:erence)?)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/gi;
const BARE_EXT_RE = /\b(EXT-[A-Z0-9-]{2,28})\b/gi;
const SURNAME_DATES_RE =
  /\b(?:guest|mr\.?|mrs\.?|ms\.?|surname)?\s*([A-Z][a-z]{1,40})\s+(?:arriv(?:ing|al)|check[- ]?in)\s+(\d{4}-\d{2}-\d{2})\s+(?:depart(?:ing|ure)|check[- ]?out)\s+(\d{4}-\d{2}-\d{2})\b/gi;
/** Common request form: `1. L.E Seloana` then `Check in 24 August, check out 28 August 2026`. */
const NATURAL_CHECK_DATES_RE =
  /\bcheck[- ]?in\s*[:=-]?\s*(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?\s*,?\s*(?:and\s+)?check[- ]?out\s*[:=-]?\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/gi;
const NATURAL_NAME_LINE_RE =
  /^\s*>?\s*(?:\d+[.)-]\s+|(?:guest|guest\s+name|surname|name)\s*[:=-]\s+)(?:(?:[A-Z][a-z]{1,40}|[A-Z](?:\.[A-Z])?\.?)\s+){0,3}([A-Z][a-z]{2,40})\.?\s*$/i;
const HMS_MONTH_NUMBER: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

function naturalStayDate(day: string, month: string, year: string | undefined): string | null {
  if (!year) return null;
  const monthNumber = HMS_MONTH_NUMBER[month.slice(0, 3).toUpperCase()];
  const dayNumber = Number(day);
  if (!monthNumber || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) {
    return null;
  }
  const candidate = `${year}-${monthNumber}-${String(dayNumber).padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function naturalSurnameCandidates(text: string, matchIndex: number): string[] {
  const prefix = text.slice(Math.max(0, matchIndex - 640), matchIndex);
  const lines = prefix.split(/\r?\n/).slice(-10);
  const out: string[] = [];
  for (const line of lines) {
    const match = NATURAL_NAME_LINE_RE.exec(line);
    if (!match) continue;
    const surname = match[1]!.trim();
    if (!out.some((value) => value.toUpperCase() === surname.toUpperCase())) out.push(surname);
  }
  return out;
}

function messageTimestamp(m: ThreadContextMessage): number {
  const t = m.sentAt ?? m.receivedAt;
  return t ? t.getTime() : 0;
}

function messageTimestampIso(m: ThreadContextMessage): string {
  const t = m.sentAt ?? m.receivedAt;
  return t ? t.toISOString() : '1970-01-01T00:00:00.000Z';
}

/**
 * Collapse quoted reply blocks and sanitize HTML for model-facing context.
 * Prefer plain text when present; otherwise sanitize+collapse HTML.
 */
export function normalizeMessageText(input: {
  textBody: string | null;
  htmlBody: string | null;
}): string {
  const text = input.textBody?.trim();
  if (text) return text;

  const html = input.htmlBody;
  if (!html) return '';

  const sanitized = sanitizeHtmlBodyForStorage(html) ?? '';
  if (!sanitized.includes('<')) return sanitized.trim();
  return collapseQuotedHtml(sanitized).trim();
}

/** Canonical opaque ID for a server-derived lookup candidate. */
export function canonicalLookupCandidateId(kind: LookupCandidate['kind'], value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 16);
}

/** Extract opaque lookup candidates from thread-present text only. */
export function extractLookupCandidates(normalizedText: string): LookupCandidate[] {
  const out: LookupCandidate[] = [];
  const seen = new Set<string>();
  const explicitProviderExternalValues = new Set<string>();

  const push = (c: LookupCandidate) => {
    const key = `${c.kind}:${'value' in c ? c.value : `${c.surname}|${c.arrivalDate}|${c.departureDate}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  if (/The following reservation has been booked through SynXis CR\./i.test(normalizedText)) {
    SYNXIS_CONFIRMATION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SYNXIS_CONFIRMATION_RE.exec(normalizedText)) !== null) {
      const value = match[1]!.toUpperCase();
      if (isPlausibleExactReservationValue(value))
        push({
          id: canonicalLookupCandidateId('external_reference', value),
          kind: 'external_reference',
          value,
        });
    }
  }

  LEKKESLAAP_EXTERNAL_RE.lastIndex = 0;
  let lekkeSlaapMatch: RegExpExecArray | null;
  while ((lekkeSlaapMatch = LEKKESLAAP_EXTERNAL_RE.exec(normalizedText)) !== null) {
    const value = lekkeSlaapMatch[1]!.toUpperCase();
    if (!isPlausibleExactReservationValue(value)) continue;
    explicitProviderExternalValues.add(value);
    push({
      id: canonicalLookupCandidateId('external_reference', value),
      kind: 'external_reference',
      value,
    });
  }

  for (const re of [CONFIRMATION_RE, ...BOOKING_REFERENCE_RES, BARE_CONF_RE, N_DEGREE_CONF_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalizedText)) !== null) {
      const value = m[1]!.toUpperCase();
      if (!isPlausibleExactReservationValue(value)) continue;
      if (explicitProviderExternalValues.has(value)) continue;
      push({
        id: canonicalLookupCandidateId('confirmation', value),
        kind: 'confirmation',
        value,
      });
    }
  }

  BARE_NUMERIC_CONF_RE.lastIndex = 0;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = BARE_NUMERIC_CONF_RE.exec(normalizedText)) !== null) {
    const token = bareMatch[1]!;
    const lineStart = normalizedText.lastIndexOf('\n', bareMatch.index) + 1;
    const lineEnd = normalizedText.indexOf('\n', bareMatch.index);
    const line = normalizedText.slice(lineStart, lineEnd < 0 ? normalizedText.length : lineEnd);
    if (/^\s*>/.test(line)) continue;
    const context = normalizedText.slice(
      Math.max(0, bareMatch.index - 120),
      Math.min(normalizedText.length, bareMatch.index + bareMatch[0].length + 120),
    );
    if (
      !/\b(?:booking|reservation|stay|arrival|departure|check[- ]?(?:in|out)|confirmation|reference)\b/i.test(
        context,
      )
    ) {
      continue;
    }
    const value = token.toUpperCase();
    if (!isPlausibleExactReservationValue(value)) continue;
    push({
      id: canonicalLookupCandidateId('confirmation', value),
      kind: 'confirmation',
      value,
    });
  }

  for (const re of [EXTERNAL_RE, BARE_EXT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalizedText)) !== null) {
      const value = m[1]!.toUpperCase();
      if (!isPlausibleExactReservationValue(value)) continue;
      push({
        id: canonicalLookupCandidateId('external_reference', value),
        kind: 'external_reference',
        value,
      });
    }
  }

  SURNAME_DATES_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SURNAME_DATES_RE.exec(normalizedText)) !== null) {
    const surname = sm[1]!;
    const arrivalDate = sm[2]!;
    const departureDate = sm[3]!;
    push({
      id: canonicalLookupCandidateId('surname_dates', `${surname}|${arrivalDate}|${departureDate}`),
      kind: 'surname_dates',
      surname,
      arrivalDate,
      departureDate,
    });
  }

  NATURAL_CHECK_DATES_RE.lastIndex = 0;
  let naturalMatch: RegExpExecArray | null;
  while ((naturalMatch = NATURAL_CHECK_DATES_RE.exec(normalizedText)) !== null) {
    const year = naturalMatch[3] ?? naturalMatch[6];
    const arrivalDate = naturalStayDate(naturalMatch[1]!, naturalMatch[2]!, year);
    const departureDate = naturalStayDate(naturalMatch[4]!, naturalMatch[5]!, naturalMatch[6]!);
    if (!arrivalDate || !departureDate || departureDate <= arrivalDate) continue;
    for (const surname of naturalSurnameCandidates(normalizedText, naturalMatch.index)) {
      push({
        id: canonicalLookupCandidateId(
          'surname_dates',
          `${surname}|${arrivalDate}|${departureDate}`,
        ),
        kind: 'surname_dates',
        surname,
        arrivalDate,
        departureDate,
      });
    }
  }

  return out;
}

export function computeThreadStateVersion(input: {
  messages: readonly ThreadStateVersionMessage[];
  latestDraftRevisionId: string | null;
}): string {
  const ordered = [...input.messages].sort((a, b) => {
    const t = a.timestamp.localeCompare(b.timestamp);
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });
  const versionParts = {
    messages: ordered.map((m) => ({
      id: m.id,
      direction: m.direction,
      timestamp: m.timestamp,
    })),
    latestDraftRevisionId: input.latestDraftRevisionId,
  };
  return createHash('sha256').update(JSON.stringify(versionParts)).digest('hex');
}

type NormalizedMsg = {
  message: ThreadContextMessage;
  normalizedText: string;
  bytes: number;
};

/**
 * Newest-first selection: trigger + latest retained always; older history
 * appended while UTF-8 budget remains. Never truncates trigger/latest away.
 */
export function selectBoundedMessages(input: {
  triggerMessageId: string;
  messages: readonly ThreadContextMessage[];
  maxBytes?: number;
}): { included: NormalizedMsg[]; normalizedText: string } {
  const maxBytes = input.maxBytes ?? THREAD_CONTEXT_MAX_BYTES;
  const byId = new Map(input.messages.map((m) => [m.id, m]));
  const trigger = byId.get(input.triggerMessageId);
  if (!trigger) {
    throw new Error(`trigger message not found: ${input.triggerMessageId}`);
  }

  const sortedNewestFirst = [...input.messages].sort((a, b) => {
    const t = messageTimestamp(b) - messageTimestamp(a);
    if (t !== 0) return t;
    return b.id.localeCompare(a.id);
  });

  const newest = sortedNewestFirst[0]!;
  const retainedIds = new Set<string>([trigger.id, newest.id]);

  const normalize = (m: ThreadContextMessage): NormalizedMsg => {
    const body = normalizeMessageText(m);
    const subject = m.subject?.trim() ?? '';
    const normalizedText = [subject, body].filter(Boolean).join('\n');
    return {
      message: m,
      normalizedText,
      bytes: Buffer.byteLength(normalizedText, 'utf8'),
    };
  };

  const retained: NormalizedMsg[] = [];
  // Newest first in output order.
  if (newest.id !== trigger.id) {
    retained.push(normalize(newest));
  }
  retained.push(normalize(trigger));

  let used = retained.reduce((sum, m) => sum + m.bytes, 0);
  // Separators between blocks (~3 bytes each for "\n\n").
  used += Math.max(0, retained.length - 1) * 2;

  const older = sortedNewestFirst.filter((m) => !retainedIds.has(m.id));
  for (const next of older) {
    const normalized = normalize(next);
    const nextBytes = Buffer.byteLength(normalized.normalizedText, 'utf8');
    const sep = 2;
    if (used + sep + nextBytes > maxBytes) continue;
    retained.push(normalized);
    retainedIds.add(next.id);
    used += sep + nextBytes;
  }

  const normalizedText = retained.map((m) => m.normalizedText).join('\n\n');
  return { included: retained, normalizedText };
}

function assertScoped(
  messages: readonly ThreadContextMessage[],
  transportId: string,
  threadId: string,
) {
  for (const m of messages) {
    if (m.transportId !== transportId || m.threadId !== threadId) {
      throw new Error('thread context messages must be transport and thread scoped');
    }
  }
}

/**
 * Build model-facing thread context: bounded newest-first text, opaque
 * lookup candidates, authorized attachment IDs, and high-water version.
 */
export async function buildThreadContext(input: BuildThreadContextInput): Promise<ThreadContext> {
  assertScoped(input.messages, input.transportId, input.threadId);

  const { included, normalizedText } = selectBoundedMessages({
    triggerMessageId: input.triggerMessageId,
    messages: input.messages,
  });

  const lookupCandidates = extractLookupCandidates(normalizedText);

  if (input.searchRelated) {
    const exactQueries = lookupCandidates
      .filter(
        (c): c is Extract<LookupCandidate, { kind: 'confirmation' | 'external_reference' }> =>
          c.kind === 'confirmation' || c.kind === 'external_reference',
      )
      .map((c) => c.value);

    for (const query of exactQueries) {
      await input.searchRelated({
        transportId: input.transportId,
        threadId: input.threadId,
        query,
        maxResults: RELATED_MESSAGE_SEARCH_MAX,
      });
      // Related hits are server-side only; model sees candidates + bounded text, not raw dumps.
    }
  }

  const authorizedAttachmentIds = [...new Set(included.flatMap((m) => m.message.attachmentIds))];

  const threadStateVersion = computeThreadStateVersion({
    messages: input.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      timestamp: messageTimestampIso(m),
    })),
    latestDraftRevisionId: input.latestDraftRevisionId,
  });

  return {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    includedMessageIds: included.map((m) => m.message.id),
    threadStateVersion,
    normalizedText,
    lookupCandidates,
    authorizedAttachmentIds,
  };
}
