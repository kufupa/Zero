import { createHash } from 'node:crypto';
import { collapseQuotedHtml } from '../mail/collapse-quoted-html.js';
import { sanitizeHtmlBodyForStorage } from '../mail/sanitize-email-html.js';

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
 * Plan signals for quote/group/event branches that need no reservation
 * prerequisite (Task 13 executable plan).
 */
export function detectDirectReadPlanRefs(segment: string): {
  hasGroupRef: boolean;
  hasEventRef: boolean;
} {
  return {
    hasGroupRef:
      /\b(group\s+block|group\s+booking|block\s+code|group\s+reservation)\b/i.test(
        segment,
      ),
    hasEventRef:
      /\b(event\s+booking|banquet|function\s+room|event\s+reservation)\b/i.test(
        segment,
      ),
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
export function selectOldestWithExactlyOneExact<
  T extends { id: string; receivedAt: Date | null },
>(
  rows: readonly T[],
  textOf: (row: T) => string,
): { row: T; candidate: ExactLookupCandidate } | null {
  const sorted = [...rows].sort(compareOldestReceivedAtThenId);
  for (const row of sorted) {
    const exact = filterExactReservationCandidates(
      extractLookupCandidates(textOf(row)),
    );
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
  /\b(?:confirmation|conf)\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/gi;
const BARE_CONF_RE = /\b(CONF-[A-Z0-9-]{2,28})\b/gi;
/** Centurion confirmation-letter subjects: `… (n°79798256-1)`. */
const N_DEGREE_CONF_RE = /\bn[°ºo]\s*([0-9]{6,14}(?:-\d{1,4})?)\b/gi;
const EXTERNAL_RE =
  /\b(?:external\s+reference|ext(?:ernal)?\s*(?:ref(?:erence)?)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/gi;
const BARE_EXT_RE = /\b(EXT-[A-Z0-9-]{2,28})\b/gi;
const SURNAME_DATES_RE =
  /\b(?:guest|mr\.?|mrs\.?|ms\.?|surname)?\s*([A-Z][a-z]{1,40})\s+(?:arriv(?:ing|al)|check[- ]?in)\s+(\d{4}-\d{2}-\d{2})\s+(?:depart(?:ing|ure)|check[- ]?out)\s+(\d{4}-\d{2}-\d{2})\b/gi;

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

  const push = (c: LookupCandidate) => {
    const key = `${c.kind}:${'value' in c ? c.value : `${c.surname}|${c.arrivalDate}|${c.departureDate}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  for (const re of [CONFIRMATION_RE, BARE_CONF_RE, N_DEGREE_CONF_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalizedText)) !== null) {
      const value = m[1]!.toUpperCase();
      if (!isPlausibleExactReservationValue(value)) continue;
      push({
        id: canonicalLookupCandidateId('confirmation', value),
        kind: 'confirmation',
        value,
      });
    }
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

function assertScoped(messages: readonly ThreadContextMessage[], transportId: string, threadId: string) {
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
export async function buildThreadContext(
  input: BuildThreadContextInput,
): Promise<ThreadContext> {
  assertScoped(input.messages, input.transportId, input.threadId);

  const { included, normalizedText } = selectBoundedMessages({
    triggerMessageId: input.triggerMessageId,
    messages: input.messages,
  });

  const lookupCandidates = extractLookupCandidates(normalizedText);

  if (input.searchRelated) {
    const exactQueries = lookupCandidates
      .filter((c): c is Extract<LookupCandidate, { kind: 'confirmation' | 'external_reference' }> =>
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

  const authorizedAttachmentIds = [
    ...new Set(included.flatMap((m) => m.message.attachmentIds)),
  ];

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
