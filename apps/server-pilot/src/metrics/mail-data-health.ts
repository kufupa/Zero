/**
 * Pure, bounded diagnostics for an already-produced mail summary.
 *
 * The health payload intentionally contains counts, clocks and evidence
 * availability only.  It never accepts or returns a message body, credentials,
 * or a request to perform mailbox work.
 */

export type MailDataDirection = 'inbound' | 'outbound';

export type MailDataTimestampBasis =
  | 'source_event'
  | 'sender_timestamp_estimate'
  | 'first_known'
  | 'availability';

export type MailDataCountPair = {
  numerator: number;
  denominator: number;
};

export type MailDataHealthMessage = {
  /** Stable identity used to deduplicate returned/source copies. */
  canonicalId?: string | null;
  sourceMessageId?: string | null;
  id?: string | null;
  direction: MailDataDirection;
  threadId?: string | null;
  /** Trusted event clock, when the source supplies one. */
  sourceEventAt?: string | null;
  eventAt?: string | null;
  /** RFC Date / parser receivedAt fallback; always labelled as an estimate. */
  headerDateAt?: string | null;
  receivedAt?: string | null;
  sentAt?: string | null;
  /** First local observation, not a historical event substitute. */
  firstKnownAt?: string | null;
  createdAt?: string | null;
  /** Native queue state; pending/sending/cancelled/failed are not observed sends. */
  sendState?: 'pending' | 'sending' | 'sent' | 'accepted' | 'cancelled' | 'failed' | null;
  hasQuotedMailboxReply?: boolean;
  quotedMailboxReply?: boolean;
  containsQuotedMailboxReply?: boolean;
  hasMatchingOutbound?: boolean;
};

export type MailDataHealthThread = {
  threadId: string;
  messageCount: number;
  hasQuotedMailboxReply?: boolean;
  hasMatchingOutbound?: boolean;
};

export type MailDataHealthSummaryInput = {
  observationCutoff: string;
  directionCounts: { inbound: number; outbound: number };
  lastObservedAt: { inbound: string | null; outbound: string | null };
  lastObservedBasis?: {
    inbound: MailDataTimestampBasis | null;
    outbound: MailDataTimestampBasis | null;
  };
  singleton: MailDataCountPair;
  quotedMailboxReplyNoMatchingOutbound:
    | MailDataCountPair
    | {
        numerator: number | null;
        denominator: number | null;
        availability: 'available' | 'unavailable';
        reason?: string;
      };
};

export type MailDataHealthInput = {
  observationCutoff: string;
  /** Existing query summaries can be passed directly instead of message rows. */
  directionCounts?: { inbound: number; outbound: number };
  lastObservedAt?: { inbound: string | null; outbound: string | null };
  lastObservedBasis?: {
    inbound: MailDataTimestampBasis | null;
    outbound: MailDataTimestampBasis | null;
  };
  singleton?: MailDataCountPair;
  quotedMailboxReplyNoMatchingOutbound?:
    | MailDataCountPair
    | {
        numerator: number | null;
        denominator: number | null;
        availability: 'available' | 'unavailable';
        reason?: string;
      };
  messages?: readonly MailDataHealthMessage[];
  threads?: readonly MailDataHealthThread[];
  quoteProjection?: 'available' | 'unavailable';
};

export type MailDataHealth = {
  availability: 'available' | 'unavailable';
  observationCutoff: string;
  directionCounts: { inbound: number | null; outbound: number | null };
  lastObservedAt: { inbound: string | null; outbound: string | null };
  lastObservedBasis: {
    inbound: MailDataTimestampBasis | null;
    outbound: MailDataTimestampBasis | null;
  };
  singleton: { numerator: number | null; denominator: number | null };
  quotedMailboxReplyNoMatchingOutbound: {
    numerator: number | null;
    denominator: number | null;
    availability: 'available' | 'unavailable';
    reason?: string;
  };
};

type ObservedMessage = {
  message: MailDataHealthMessage;
  at: string;
  basis: MailDataTimestampBasis;
};

const NON_OBSERVED_SEND_STATES = new Set<MailDataHealthMessage['sendState']>([
  'pending',
  'sending',
  'cancelled',
  'failed',
]);

function validTimestamp(value: string | null | undefined): number | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value);
}

function validCutoff(value: string): number | null {
  return validTimestamp(value);
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validCountPair(value: unknown): value is MailDataCountPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    validCount((value as MailDataCountPair).numerator) &&
    validCount((value as MailDataCountPair).denominator) &&
    (value as MailDataCountPair).numerator <= (value as MailDataCountPair).denominator
  );
}

function identityForMessage(message: MailDataHealthMessage, index: number): string {
  return message.canonicalId?.trim() || message.sourceMessageId?.trim() || message.id?.trim() || `row:${index}`;
}

function chooseObservedTime(
  message: MailDataHealthMessage,
  cutoff: number,
): { at: string; basis: MailDataTimestampBasis } | null {
  const candidates: Array<{ value: string | null | undefined; basis: MailDataTimestampBasis }> = [
    { value: message.sourceEventAt, basis: 'source_event' },
    { value: message.eventAt, basis: 'source_event' },
    {
      value: message.direction === 'outbound' ? message.sentAt : message.receivedAt,
      basis: message.direction === 'outbound' ? 'source_event' : 'sender_timestamp_estimate',
    },
    { value: message.headerDateAt, basis: 'sender_timestamp_estimate' },
    { value: message.firstKnownAt, basis: 'first_known' },
    { value: message.createdAt, basis: 'availability' },
  ];

  // A future/invalid event clock cannot enter an as-of report.  A bounded
  // first-known fallback can still identify when the row became observable.
  for (const candidate of candidates) {
    const instant = validTimestamp(candidate.value);
    if (instant !== null && instant <= cutoff) {
      return { at: candidate.value!, basis: candidate.basis };
    }
  }
  return null;
}

function isObservedSend(message: MailDataHealthMessage): boolean {
  return message.direction !== 'outbound' || !NON_OBSERVED_SEND_STATES.has(message.sendState ?? null);
}

function quoteValue(message: MailDataHealthMessage): boolean | undefined {
  return message.hasQuotedMailboxReply ?? message.quotedMailboxReply ?? message.containsQuotedMailboxReply;
}

function unavailableHealth(observationCutoff: string): MailDataHealth {
  return {
    availability: 'unavailable',
    observationCutoff,
    directionCounts: { inbound: null, outbound: null },
    lastObservedAt: { inbound: null, outbound: null },
    lastObservedBasis: { inbound: null, outbound: null },
    singleton: { numerator: null, denominator: null },
    quotedMailboxReplyNoMatchingOutbound: {
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'invalid_observation_cutoff',
    },
  };
}

function copySummary(input: MailDataHealthInput): MailDataHealth | null {
  if (
    !input.directionCounts ||
    !validCount(input.directionCounts.inbound) ||
    !validCount(input.directionCounts.outbound) ||
    !input.lastObservedAt ||
    !input.singleton ||
    !validCountPair(input.singleton) ||
    !input.quotedMailboxReplyNoMatchingOutbound
  ) {
    return null;
  }

  const quote = input.quotedMailboxReplyNoMatchingOutbound;
  const quoteAvailable = validCountPair(quote);
  const quoteWithAvailability = quote as {
    numerator: number | null;
    denominator: number | null;
    availability?: 'available' | 'unavailable';
    reason?: string;
  };
  const quoteUnavailable =
    quoteWithAvailability.availability === 'unavailable' &&
    quoteWithAvailability.numerator === null &&
    quoteWithAvailability.denominator === null;
  if (!quoteAvailable && !quoteUnavailable) return null;

  const cutoff = validTimestamp(input.observationCutoff);
  if (cutoff === null) return null;
  for (const at of [input.lastObservedAt.inbound, input.lastObservedAt.outbound]) {
    if (at !== null && (validTimestamp(at) === null || validTimestamp(at)! > cutoff)) return null;
  }

  const basis = input.lastObservedBasis ?? {
    inbound: input.lastObservedAt.inbound ? 'first_known' : null,
    outbound: input.lastObservedAt.outbound ? 'first_known' : null,
  };
  return {
    availability: 'available',
    observationCutoff: input.observationCutoff,
    directionCounts: input.directionCounts,
    lastObservedAt: input.lastObservedAt,
    lastObservedBasis: basis,
    singleton: input.singleton,
    quotedMailboxReplyNoMatchingOutbound: quoteAvailable
      ? { ...quote, availability: 'available' }
      : {
          numerator: null,
          denominator: null,
          availability: 'unavailable',
          reason:
            quoteWithAvailability.reason ?? 'quote_projection_unavailable',
        },
  };
}

function deriveFromMessages(input: MailDataHealthInput, cutoff: number): MailDataHealth {
  const rows = input.messages ?? [];
  const byIdentity = new Map<string, MailDataHealthMessage>();
  const seenIdentities = new Set<string>();
  rows.forEach((message, index) => {
    if (!message || (message.direction !== 'inbound' && message.direction !== 'outbound')) return;
    const identities = [message.canonicalId, message.sourceMessageId, message.id]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const identity = identities[0] ?? `row:${index}`;
    if (identities.some((value) => seenIdentities.has(value))) return;
    identities.forEach((value) => seenIdentities.add(value));
    if (!byIdentity.has(identity)) byIdentity.set(identity, message);
  });

  const observed: ObservedMessage[] = [];
  for (const message of byIdentity.values()) {
    if (!isObservedSend(message)) continue;
    const selected = chooseObservedTime(message, cutoff);
    if (selected) observed.push({ message, ...selected });
  }

  const directionCounts = { inbound: 0, outbound: 0 };
  const latest: Record<MailDataDirection, ObservedMessage | null> = {
    inbound: null,
    outbound: null,
  };
  for (const row of observed) {
    directionCounts[row.message.direction] += 1;
    const previous = latest[row.message.direction];
    if (!previous || Date.parse(row.at) > Date.parse(previous.at)) {
      latest[row.message.direction] = row;
    }
  }

  const byThread = new Map<string, MailDataHealthMessage[]>();
  for (const row of observed) {
    const threadId = row.message.threadId?.trim() || identityForMessage(row.message, observed.indexOf(row));
    const threadRows = byThread.get(threadId) ?? [];
    threadRows.push(row.message);
    byThread.set(threadId, threadRows);
  }

  const singletonDenominator = byThread.size;
  const singletonNumerator = [...byThread.values()].filter((threadRows) => threadRows.length === 1).length;

  const quoteProjectionAvailable =
    input.quoteProjection === 'available' ||
    (input.quoteProjection === undefined &&
      [...byIdentity.values()].every((message) => quoteValue(message) !== undefined));
  let quote: MailDataHealth['quotedMailboxReplyNoMatchingOutbound'];
  if (!quoteProjectionAvailable) {
    quote = {
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'quote_projection_unavailable',
    };
  } else {
    let quoteNumerator = 0;
    for (const threadRows of byThread.values()) {
      if (threadRows.length !== 1) continue;
      const only = threadRows[0]!;
      const hasQuote = quoteValue(only) === true;
      const hasOutbound = threadRows.some(
        (message) => message.direction === 'outbound' || message.hasMatchingOutbound === true,
      );
      if (hasQuote && !hasOutbound) quoteNumerator += 1;
    }
    quote = {
      numerator: quoteNumerator,
      denominator: singletonDenominator,
      availability: 'available',
    };
  }

  return {
    availability: 'available',
    observationCutoff: input.observationCutoff,
    directionCounts,
    lastObservedAt: {
      inbound: latest.inbound?.at ?? null,
      outbound: latest.outbound?.at ?? null,
    },
    lastObservedBasis: {
      inbound: latest.inbound?.basis ?? null,
      outbound: latest.outbound?.basis ?? null,
    },
    singleton: { numerator: singletonNumerator, denominator: singletonDenominator },
    quotedMailboxReplyNoMatchingOutbound: quote,
  };
}

/**
 * Build deterministic diagnostics from bounded query summaries or rows.  No
 * body scanning, network access, model call, or capture-completeness claim is
 * made by this function.
 */
export function buildMailDataHealth(input: MailDataHealthInput): MailDataHealth {
  const cutoff = validCutoff(input.observationCutoff);
  if (cutoff === null) return unavailableHealth(input.observationCutoff);

  if (!input.messages && input.directionCounts) {
    return copySummary(input) ?? unavailableHealth(input.observationCutoff);
  }
  return deriveFromMessages(input, cutoff);
}

/** Alias for query code that names the operation as a computation. */
export const computeMailDataHealth = buildMailDataHealth;
