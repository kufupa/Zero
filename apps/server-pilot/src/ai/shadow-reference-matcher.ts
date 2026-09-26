import { createHash } from 'node:crypto';

export type ShadowPredictionReference = {
  id: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  triggerMessageIdHeader?: string | null;
  asOfAt: Date | string;
};

export type ShadowOutboundMessage = {
  id: string;
  transportId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  createdAt: Date | string;
  sentAt?: Date | string | null;
  receivedAt?: Date | string | null;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
};

export type ShadowReferenceStatus = 'matched' | 'late' | 'ambiguous' | 'unmatched' | 'unobserved';

export type ShadowReferenceMatch = {
  status: ShadowReferenceStatus;
  referenceMessageId: string | null;
  linkStrength: 'header' | 'thread' | 'ambiguous' | 'unknown';
  reason: string;
  matchKey: string;
  observedAt: string | null;
};

function instant(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized.replace(/^<|>$/g, '') : null;
}

function candidateEventAt(candidate: ShadowOutboundMessage): number | null {
  return instant(candidate.sentAt ?? candidate.receivedAt ?? candidate.createdAt);
}

function headerIdentities(candidate: ShadowOutboundMessage): Set<string> {
  return new Set(
    [candidate.inReplyTo, ...(candidate.references ?? [])]
      .map(normalizeMessageId)
      .filter((value): value is string => value !== null),
  );
}

function matchKey(predictionId: string, status: ShadowReferenceStatus, messageId: string | null) {
  return `shadow-match:${createHash('sha256')
    .update(`${predictionId}\u001f${status}\u001f${messageId ?? ''}`, 'utf8')
    .digest('hex')}`;
}

/**
 * Resolve one private prediction against later outbound observations.
 * Header links are authoritative; a sole same-thread candidate is retained as
 * a weaker match, while competing weak candidates stay ambiguous. A message
 * that predates the frozen as-of point is explicitly late and never becomes a
 * normal success label.
 */
export function matchShadowReference(
  prediction: ShadowPredictionReference,
  candidates: readonly ShadowOutboundMessage[],
): ShadowReferenceMatch {
  const asOf = instant(prediction.asOfAt);
  if (asOf === null) {
    return {
      status: 'unobserved',
      referenceMessageId: null,
      linkStrength: 'unknown',
      reason: 'invalid_prediction_as_of',
      matchKey: matchKey(prediction.id, 'unobserved', null),
      observedAt: null,
    };
  }

  const outbound = candidates.filter(
    (candidate) =>
      candidate.direction === 'outbound' &&
      candidate.transportId === prediction.transportId &&
      candidate.threadId === prediction.threadId,
  );
  const triggerIdentities = new Set(
    [prediction.triggerMessageId, prediction.triggerMessageIdHeader]
      .map(normalizeMessageId)
      .filter((value): value is string => value !== null),
  );
  const explicitlyLinked = outbound.filter((candidate) => {
    const identities = headerIdentities(candidate);
    return [...identities].some((identity) => triggerIdentities.has(identity));
  });

  const late = outbound
    .filter((candidate) => (candidateEventAt(candidate) ?? Number.NEGATIVE_INFINITY) <= asOf)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (late.length > 0) {
    const candidate =
      explicitlyLinked.find((row) => late.some((item) => item.id === row.id)) ?? late[0]!;
    const observedAt = candidateEventAt(candidate);
    return {
      status: 'late',
      referenceMessageId: candidate.id,
      linkStrength: explicitlyLinked.some((row) => row.id === candidate.id) ? 'header' : 'thread',
      reason: 'outbound_observed_before_prediction_as_of',
      matchKey: matchKey(prediction.id, 'late', candidate.id),
      observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    };
  }

  if (explicitlyLinked.length === 1) {
    const candidate = explicitlyLinked[0]!;
    const observedAt = candidateEventAt(candidate);
    return {
      status: 'matched',
      referenceMessageId: candidate.id,
      linkStrength: 'header',
      reason: 'verified_reply_header',
      matchKey: matchKey(prediction.id, 'matched', candidate.id),
      observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    };
  }
  if (explicitlyLinked.length > 1) {
    return {
      status: 'ambiguous',
      referenceMessageId: null,
      linkStrength: 'ambiguous',
      reason: 'multiple_verified_reply_headers',
      matchKey: matchKey(prediction.id, 'ambiguous', null),
      observedAt: null,
    };
  }

  const later = outbound.filter((candidate) => (candidateEventAt(candidate) ?? asOf) > asOf);
  if (later.length === 1) {
    const candidate = later[0]!;
    const observedAt = candidateEventAt(candidate);
    return {
      status: 'matched',
      referenceMessageId: candidate.id,
      linkStrength: 'thread',
      reason: 'sole_later_same_thread_outbound',
      matchKey: matchKey(prediction.id, 'matched', candidate.id),
      observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    };
  }
  if (later.length > 1) {
    return {
      status: 'ambiguous',
      referenceMessageId: null,
      linkStrength: 'ambiguous',
      reason: 'competing_later_same_thread_outbound_without_reference',
      matchKey: matchKey(prediction.id, 'ambiguous', null),
      observedAt: null,
    };
  }

  return {
    status: 'unmatched',
    referenceMessageId: null,
    linkStrength: 'unknown',
    reason: 'no_verified_outbound_reference',
    matchKey: matchKey(prediction.id, 'unmatched', null),
    observedAt: null,
  };
}
