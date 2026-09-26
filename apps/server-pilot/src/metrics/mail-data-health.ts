/**
 * Pure, bounded diagnostics for an already-produced, single-scope mail
 * summary. The health payload contains counts, clocks, and evidence status
 * only; it never scans or returns message bodies or processing credentials.
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
  /** Stable identities used to deduplicate source/returned copies. */
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

export type MailDataSummaryQuote =
  | MailDataCountPair
  | {
      numerator: number | null;
      denominator: number | null;
      availability: 'available' | 'unavailable';
      reason?: string;
    };

/** Existing query summaries must carry their own clock provenance. */
export type MailDataHealthSummaryInput = {
  observationCutoff: string;
  directionCounts: { inbound: number; outbound: number };
  lastObservedAt: { inbound: string | null; outbound: string | null };
  lastObservedBasis: {
    inbound: MailDataTimestampBasis | null;
    outbound: MailDataTimestampBasis | null;
  };
  singleton: MailDataCountPair;
  quotedMailboxReplyNoMatchingOutbound: MailDataSummaryQuote;
};

/**
 * Row diagnostics are explicitly scoped and require an explicit bounded quote
 * projection. An empty row list is therefore a known empty period, while an
 * omitted row source cannot be mistaken for zero traffic.
 */
export type MailDataHealthRowsInput = {
  observationCutoff: string;
  scopeKey: string;
  messages: readonly MailDataHealthMessage[];
  quoteProjection: 'available' | 'unavailable';
};

export type MailDataHealthInput = MailDataHealthSummaryInput | MailDataHealthRowsInput;

export type MailDataUnscorableCounts = {
  total: number;
  inbound: number;
  outbound: number;
  missingClock: number;
  invalidClock: number;
  missingThreadLinkage: number;
  missingIdentity: number;
};

export type MailDataAvailabilityReason =
  | 'missing_evidence'
  | 'invalid_observation_cutoff'
  | 'missing_scope'
  | 'missing_summary_basis'
  | 'unusable_evidence';

export type MailDataHealth = {
  availability: 'available' | 'unavailable';
  availabilityReason?: MailDataAvailabilityReason;
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
    reason?: 'quote_projection_unavailable' | 'thread_linkage_unavailable';
  };
  unscorable: MailDataUnscorableCounts;
};

type ClockSelection = {
  at: string | null;
  basis: MailDataTimestampBasis | null;
  /** Only source/estimated event clocks may enter direction/thread counters. */
  counterEligible: boolean;
  reason: 'missing_clock' | 'invalid_clock' | 'outside_cutoff' | null;
};

type ObservedMessage = {
  message: MailDataHealthMessage;
  at: string;
  basis: MailDataTimestampBasis;
  counterEligible: boolean;
};

type MessageGroup = {
  message: MailDataHealthMessage;
  keys: string[];
};

const NON_OBSERVED_SEND_STATES = new Set<MailDataHealthMessage['sendState']>([
  'pending',
  'sending',
  'cancelled',
  'failed',
]);

const ALLOWED_BASES = new Set<MailDataTimestampBasis>([
  'source_event',
  'sender_timestamp_estimate',
  'first_known',
  'availability',
]);

const ALLOWED_SUMMARY_REASONS = new Set([
  'quote_projection_unavailable',
  'thread_linkage_unavailable',
]);

function validTimestamp(value: string | null | undefined): number | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value);
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validCountPair(value: unknown): value is MailDataCountPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    validCount((value as MailDataCountPair).numerator) &&
    validCount((value as { denominator: unknown }).denominator) &&
    (value as MailDataCountPair).numerator <= (value as MailDataCountPair).denominator
  );
}

function validBasis(value: unknown): value is MailDataTimestampBasis {
  return typeof value === 'string' && ALLOWED_BASES.has(value as MailDataTimestampBasis);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimestampOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && validTimestamp(value) !== null);
}

function unknownCounts(): MailDataUnscorableCounts {
  return {
    total: 0,
    inbound: 0,
    outbound: 0,
    missingClock: 0,
    invalidClock: 0,
    missingThreadLinkage: 0,
    missingIdentity: 0,
  };
}

function unavailableHealth(
  observationCutoff: string,
  reason: MailDataAvailabilityReason,
  unscorable: MailDataUnscorableCounts = unknownCounts(),
): MailDataHealth {
  return {
    availability: 'unavailable',
    availabilityReason: reason,
    observationCutoff,
    directionCounts: { inbound: null, outbound: null },
    lastObservedAt: { inbound: null, outbound: null },
    lastObservedBasis: { inbound: null, outbound: null },
    singleton: { numerator: null, denominator: null },
    quotedMailboxReplyNoMatchingOutbound: {
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'quote_projection_unavailable',
    },
    unscorable,
  };
}

function markUnscorable(
  counts: MailDataUnscorableCounts,
  direction: MailDataDirection | null,
  reason: 'missingClock' | 'invalidClock' | 'missingThreadLinkage' | 'missingIdentity',
  rowIsNew = true,
): void {
  if (rowIsNew) counts.total += 1;
  if (direction) counts[direction] += 1;
  counts[reason] += 1;
}

function normalizedIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function identityKeys(message: MailDataHealthMessage, scopeKey: string): string[] {
  const values: Array<[string, string | null | undefined]> = [
    ['canonical', message.canonicalId],
    ['source', message.sourceMessageId],
    ['local', message.id],
  ];
  return values
    .filter(([, value]) => Boolean(value?.trim()))
    .map(([kind, value]) => `${scopeKey}\u0000${kind}\u0000${normalizedIdentity(value!)}`);
}

function validOrNull(value: string | null | undefined): string | null {
  return validTimestamp(value) === null ? null : value!;
}

function earlierClock(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  const validLeft = validOrNull(left);
  const validRight = validOrNull(right);
  if (!validLeft) return validRight;
  if (!validRight) return validLeft;
  return Date.parse(validLeft) <= Date.parse(validRight) ? validLeft : validRight;
}

function mergedSendState(
  left: MailDataHealthMessage['sendState'],
  right: MailDataHealthMessage['sendState'],
): MailDataHealthMessage['sendState'] {
  const rank: Record<NonNullable<MailDataHealthMessage['sendState']>, number> = {
    cancelled: 0,
    failed: 1,
    pending: 2,
    sending: 3,
    accepted: 4,
    sent: 5,
  };
  if (!left) return right;
  if (!right) return left;
  return rank[left] >= rank[right] ? left : right;
}

function mergedBoolean(
  left: boolean | undefined,
  right: boolean | undefined,
): boolean | undefined {
  if (left === true || right === true) return true;
  return left ?? right;
}

function mergedText(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null | undefined {
  if (left?.trim()) return left;
  if (right?.trim()) return right;
  return left ?? right;
}

function mergeMessages(left: MailDataHealthMessage, right: MailDataHealthMessage): MailDataHealthMessage {
  return {
    ...left,
    direction: left.direction,
    canonicalId: mergedText(left.canonicalId, right.canonicalId),
    sourceMessageId: mergedText(left.sourceMessageId, right.sourceMessageId),
    id: mergedText(left.id, right.id),
    threadId: mergedText(left.threadId, right.threadId),
    sourceEventAt: earlierClock(left.sourceEventAt, right.sourceEventAt),
    eventAt: earlierClock(left.eventAt, right.eventAt),
    headerDateAt: earlierClock(left.headerDateAt, right.headerDateAt),
    receivedAt: earlierClock(left.receivedAt, right.receivedAt),
    sentAt: earlierClock(left.sentAt, right.sentAt),
    firstKnownAt: earlierClock(left.firstKnownAt, right.firstKnownAt),
    createdAt: earlierClock(left.createdAt, right.createdAt),
    sendState: mergedSendState(left.sendState, right.sendState),
    hasQuotedMailboxReply: mergedBoolean(
      left.hasQuotedMailboxReply,
      right.hasQuotedMailboxReply,
    ),
    quotedMailboxReply: mergedBoolean(left.quotedMailboxReply, right.quotedMailboxReply),
    containsQuotedMailboxReply: mergedBoolean(
      left.containsQuotedMailboxReply,
      right.containsQuotedMailboxReply,
    ),
    hasMatchingOutbound: left.hasMatchingOutbound || right.hasMatchingOutbound,
  };
}

function collectMessageGroups(
  messages: readonly MailDataHealthMessage[],
  scopeKey: string,
  unscorable: MailDataUnscorableCounts,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const groupByKey = new Map<string, number>();
  const parent: number[] = [];

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };

  for (const message of messages) {
    const direction =
      message &&
      typeof message === 'object' &&
      ((message as { direction?: unknown }).direction === 'inbound' ||
        (message as { direction?: unknown }).direction === 'outbound')
        ? (message as { direction: MailDataDirection }).direction
        : null;
    if (!direction) {
      markUnscorable(unscorable, null, 'missingIdentity');
      continue;
    }
    const keys = identityKeys(message, scopeKey);
    if (keys.length === 0) {
      markUnscorable(unscorable, message.direction, 'missingIdentity');
      continue;
    }

    const roots = [
      ...new Set(
        keys
          .map((key) => groupByKey.get(key))
          .filter((value): value is number => value !== undefined)
          .map(find),
      ),
    ];
    let root: number;
    if (roots.length === 0) {
      root = groups.length;
      groups.push({ message, keys: [] });
      parent.push(root);
    } else {
      root = roots[0]!;
      groups[root]!.message = mergeMessages(groups[root]!.message, message);
      for (const other of roots.slice(1)) {
        if (find(other) === root) continue;
        parent[other] = root;
        groups[root]!.message = mergeMessages(groups[root]!.message, groups[other]!.message);
        groups[root]!.keys.push(...groups[other]!.keys);
      }
    }

    groups[find(root)]!.keys.push(...keys);
    for (const key of keys) groupByKey.set(key, find(root));
  }

  return groups.filter((group, index) => find(index) === index);
}

function chooseObservedTime(message: MailDataHealthMessage, cutoff: number): ClockSelection {
  const primary = [
    { value: message.sourceEventAt, basis: 'source_event' as const },
    { value: message.eventAt, basis: 'source_event' as const },
    {
      value: message.direction === 'outbound' ? message.sentAt : message.receivedAt,
      basis: message.direction === 'outbound'
        ? ('source_event' as const)
        : ('sender_timestamp_estimate' as const),
    },
  ].filter(({ value }) => value !== undefined && value !== null && value !== '');

  const primaryInvalid = primary.some(({ value }) => validTimestamp(value) === null);
  const primaryValid: Array<{
    value: number;
    raw: string;
    basis: 'source_event' | 'sender_timestamp_estimate';
  }> = [];
  for (const candidate of primary) {
    const value = validTimestamp(candidate.value);
    if (value !== null) {
      primaryValid.push({ value, raw: candidate.value!, basis: candidate.basis });
    }
  }
  const primaryFuture = primaryValid.some(({ value }) => value > cutoff);
  const primaryAtCutoff = primaryValid.filter(({ value }) => value <= cutoff);
  if (primaryAtCutoff.length > 0) {
    const selected = primaryAtCutoff[0]!;
    return {
      at: selected.raw,
      basis: selected.basis,
      counterEligible: !primaryInvalid && !primaryFuture,
      reason: primaryInvalid || primaryFuture ? 'invalid_clock' : null,
    };
  }

  // A source/event clock beyond the cutoff is not silently recast as a local
  // first-known event. It is retained only as an explicitly unscorable row.
  if (primaryValid.length > 0 || primaryInvalid) {
    const firstKnown = validTimestamp(message.firstKnownAt);
    return {
      at: firstKnown !== null && firstKnown <= cutoff ? message.firstKnownAt! : null,
      basis: firstKnown !== null && firstKnown <= cutoff ? 'first_known' : null,
      counterEligible: false,
      reason: 'invalid_clock',
    };
  }

  const estimate = validTimestamp(message.headerDateAt);
  if (estimate !== null && estimate <= cutoff) {
    return {
      at: message.headerDateAt!,
      basis: 'sender_timestamp_estimate',
      counterEligible: true,
      reason: null,
    };
  }
  if (message.headerDateAt !== undefined && message.headerDateAt !== null) {
    return { at: null, basis: null, counterEligible: false, reason: 'invalid_clock' };
  }

  const firstKnown = validTimestamp(message.firstKnownAt);
  if (firstKnown !== null && firstKnown <= cutoff) {
    return {
      at: message.firstKnownAt!,
      basis: 'first_known',
      counterEligible: false,
      reason: 'missing_clock',
    };
  }

  const created = validTimestamp(message.createdAt);
  if (created !== null && created <= cutoff) {
    return {
      at: message.createdAt!,
      basis: 'availability',
      counterEligible: false,
      reason: 'missing_clock',
    };
  }

  return { at: null, basis: null, counterEligible: false, reason: 'missing_clock' };
}

function isObservedSend(message: MailDataHealthMessage): boolean {
  return message.direction !== 'outbound' || !NON_OBSERVED_SEND_STATES.has(message.sendState ?? null);
}

function quoteValue(message: MailDataHealthMessage): boolean | undefined {
  return message.hasQuotedMailboxReply ?? message.quotedMailboxReply ?? message.containsQuotedMailboxReply;
}

function validBasisOrNull(value: unknown): value is MailDataTimestampBasis | null {
  return value === null || validBasis(value);
}

function normalizeSummaryReason(
  value: MailDataSummaryQuote,
): 'quote_projection_unavailable' | 'thread_linkage_unavailable' {
  if (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    typeof (value as { reason?: unknown }).reason === 'string' &&
    ALLOWED_SUMMARY_REASONS.has((value as { reason: string }).reason)
  ) {
    return (value as { reason: string }).reason as
      | 'quote_projection_unavailable'
      | 'thread_linkage_unavailable';
  }
  return 'quote_projection_unavailable';
}

function copySummary(input: MailDataHealthSummaryInput, cutoff: number): MailDataHealth {
  const directionCounts = input.directionCounts as unknown;
  const lastObservedAt = input.lastObservedAt as unknown;
  const lastObservedBasis = input.lastObservedBasis as unknown;
  if (
    !isRecord(directionCounts) ||
    !isRecord(lastObservedAt) ||
    !isRecord(lastObservedBasis)
  ) {
    return unavailableHealth(input.observationCutoff, 'missing_summary_basis');
  }

  const inboundCount = directionCounts.inbound;
  const outboundCount = directionCounts.outbound;
  const inboundAt = lastObservedAt.inbound;
  const outboundAt = lastObservedAt.outbound;
  const inboundBasis = lastObservedBasis.inbound;
  const outboundBasis = lastObservedBasis.outbound;
  const singleton = input.singleton as unknown;
  if (
    !validCount(inboundCount) ||
    !validCount(outboundCount) ||
    !validCountPair(singleton) ||
    !validBasisOrNull(inboundBasis) ||
    !validBasisOrNull(outboundBasis)
  ) {
    return unavailableHealth(input.observationCutoff, 'missing_summary_basis');
  }
  if (
    !validTimestampOrNull(inboundAt) ||
    !validTimestampOrNull(outboundAt)
  ) {
    return unavailableHealth(input.observationCutoff, 'unusable_evidence');
  }
  if (
    (inboundAt === null) !== (inboundBasis === null) ||
    (outboundAt === null) !== (outboundBasis === null)
  ) {
    return unavailableHealth(input.observationCutoff, 'missing_summary_basis');
  }
  for (const at of [inboundAt, outboundAt]) {
    if (at !== null && validTimestamp(at)! > cutoff) {
      return unavailableHealth(input.observationCutoff, 'unusable_evidence');
    }
  }

  const quote = input.quotedMailboxReplyNoMatchingOutbound;
  const quoteAvailable = validCountPair(quote);
  const quoteUnavailable =
    typeof quote === 'object' &&
    quote !== null &&
    'availability' in quote &&
    quote.availability === 'unavailable' &&
    quote.numerator === null &&
    quote.denominator === null;
  if (!quoteAvailable && !quoteUnavailable) {
    return unavailableHealth(input.observationCutoff, 'unusable_evidence');
  }

  const copiedQuote = quoteAvailable
    ? {
        numerator: quote.numerator,
        denominator: quote.denominator,
        availability: 'available' as const,
      }
    : {
        numerator: null,
        denominator: null,
        availability: 'unavailable' as const,
        reason: normalizeSummaryReason(quote),
      };

  return {
    availability: 'available',
    observationCutoff: input.observationCutoff,
    directionCounts: {
      inbound: inboundCount,
      outbound: outboundCount,
    },
    lastObservedAt: {
      inbound: inboundAt,
      outbound: outboundAt,
    },
    lastObservedBasis: {
      inbound: inboundBasis,
      outbound: outboundBasis,
    },
    singleton: {
      numerator: singleton.numerator,
      denominator: singleton.denominator,
    },
    quotedMailboxReplyNoMatchingOutbound: copiedQuote,
    unscorable: unknownCounts(),
  };
}

function deriveFromMessages(input: MailDataHealthRowsInput, cutoff: number): MailDataHealth {
  const unscorable = unknownCounts();
  const groups = collectMessageGroups(input.messages, input.scopeKey, unscorable);
  const observed: ObservedMessage[] = [];

  for (const group of groups) {
    const message = group.message;
    if (!isObservedSend(message)) continue;
    const selected = chooseObservedTime(message, cutoff);
    if (selected.reason) {
      markUnscorable(
        unscorable,
        message.direction,
        selected.reason === 'missing_clock' ? 'missingClock' : 'invalidClock',
      );
    }
    if (selected.at && selected.basis) {
      observed.push({
        message,
        at: selected.at,
        basis: selected.basis,
        counterEligible: selected.counterEligible,
      });
    }
  }

  const counterRows = observed.filter((row) => row.counterEligible);
  const directionCounts = { inbound: 0, outbound: 0 };
  const latest: Record<MailDataDirection, ObservedMessage | null> = {
    inbound: null,
    outbound: null,
  };
  for (const row of counterRows) {
    const previous = latest[row.message.direction];
    if (!previous || Date.parse(row.at) > Date.parse(previous.at)) {
      latest[row.message.direction] = row;
    }
  }
  for (const row of counterRows) directionCounts[row.message.direction] += 1;

  const byThread = new Map<string, MailDataHealthMessage[]>();
  for (const row of counterRows) {
    const threadId = row.message.threadId?.trim();
    if (!threadId) {
      markUnscorable(unscorable, row.message.direction, 'missingThreadLinkage');
      continue;
    }
    const threadRows = byThread.get(threadId) ?? [];
    threadRows.push(row.message);
    byThread.set(threadId, threadRows);
  }

  const hasRows = input.messages.length > 0;
  const hasUsableEventEvidence = counterRows.length > 0;
  const hasOnlyInvalidEvidence = hasRows && !hasUsableEventEvidence && unscorable.total > 0;
  const availability = hasOnlyInvalidEvidence ? 'unavailable' : 'available';
  const healthBase = {
    availability: availability as 'available' | 'unavailable',
    ...(availability === 'unavailable'
      ? { availabilityReason: 'unusable_evidence' as const }
      : {}),
    observationCutoff: input.observationCutoff,
    directionCounts:
      availability === 'unavailable' ? { inbound: null, outbound: null } : directionCounts,
    lastObservedAt: {
      inbound: latest.inbound?.at ?? null,
      outbound: latest.outbound?.at ?? null,
    },
    lastObservedBasis: {
      inbound: latest.inbound?.basis ?? null,
      outbound: latest.outbound?.basis ?? null,
    },
    unscorable,
  };

  const hasMissingThreadLinkage = unscorable.missingThreadLinkage > 0;
  let singleton: MailDataHealth['singleton'];
  if (hasMissingThreadLinkage || availability === 'unavailable') {
    singleton = { numerator: null, denominator: null };
  } else {
    singleton = {
      numerator: [...byThread.values()].filter((rows) => rows.length === 1).length,
      denominator: byThread.size,
    };
  }

  let quote: MailDataHealth['quotedMailboxReplyNoMatchingOutbound'];
  const quoteFlagsKnown = counterRows.every((row) => quoteValue(row.message) !== undefined);
  if (
    input.quoteProjection !== 'available' ||
    availability === 'unavailable' ||
    hasMissingThreadLinkage ||
    (counterRows.length > 0 && !quoteFlagsKnown)
  ) {
    quote = {
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: hasMissingThreadLinkage
        ? 'thread_linkage_unavailable'
        : 'quote_projection_unavailable',
    };
  } else if (counterRows.length === 0) {
    quote = {
      numerator: 0,
      denominator: 0,
      availability: 'available',
    };
  } else {
    let quoteNumerator = 0;
    for (const threadRows of byThread.values()) {
      if (threadRows.length !== 1) continue;
      const only = threadRows[0]!;
      const hasQuote = quoteValue(only) === true;
      const hasOutbound = only.direction === 'outbound' || only.hasMatchingOutbound === true;
      if (hasQuote && !hasOutbound) quoteNumerator += 1;
    }
    quote = {
      numerator: quoteNumerator,
      denominator: byThread.size,
      availability: 'available',
    };
  }

  return {
    ...healthBase,
    singleton,
    quotedMailboxReplyNoMatchingOutbound: quote,
  };
}

/**
 * Build deterministic diagnostics from one explicit bounded evidence source.
 * No body scanning, network access, model call, or capture-completeness claim
 * is made by this function.
 */
export function buildMailDataHealth(input: MailDataHealthInput): MailDataHealth {
  const cutoff = validTimestamp(input.observationCutoff);
  if (cutoff === null) {
    return unavailableHealth(input.observationCutoff, 'invalid_observation_cutoff');
  }

  if ('messages' in input) {
    if (typeof input.scopeKey !== 'string' || input.scopeKey.trim() === '') {
      return unavailableHealth(input.observationCutoff, 'missing_scope');
    }
    if (!Array.isArray(input.messages)) {
      return unavailableHealth(input.observationCutoff, 'missing_evidence');
    }
    return deriveFromMessages(input, cutoff);
  }

  if ('directionCounts' in input) return copySummary(input, cutoff);
  return unavailableHealth(
    (input as { observationCutoff: string }).observationCutoff,
    'missing_evidence',
  );
}

/** Alias for query code that names the operation as a computation. */
export const computeMailDataHealth = buildMailDataHealth;
