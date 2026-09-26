/**
 * Immutable, request-level mail semantics.
 *
 * This module deliberately operates on compact semantic evidence rather than
 * message bodies.  Producers may inspect a body while creating evidence, but
 * dashboard reads only consume the versioned facts persisted by U2.
 */

export const MAIL_BASELINE_PROJECTION_VERSION = 'mail-baseline-projection-v1';
export const MAIL_BASELINE_INTERPRETATION_VERSION = 'mail-baseline-interpretation-v1';

export const PRIMARY_BUCKETS = [
  'awaiting_hotel_reply',
  'awaiting_customer_information',
  'hotel_action_pending',
  'unknown',
  'answered',
  'no_reply_required',
] as const;
export type MailBaselinePrimaryBucket = (typeof PRIMARY_BUCKETS)[number];

export const REPLY_STATES = [
  'awaiting_hotel',
  'awaiting_customer',
  'answered',
  'no_reply_required',
  'unknown',
] as const;
export type MailBaselineReplyState = (typeof REPLY_STATES)[number];

export const WORK_STATES = [
  'open',
  'partially_complete',
  'complete',
  'not_required',
  'unknown',
] as const;
export type MailBaselineWorkState = (typeof WORK_STATES)[number];

export type MailBaselineEventType =
  | 'ask'
  | 'answer'
  | 'clarification'
  | 'work_update'
  | 'acknowledgement'
  | 'forward';

export type MailBaselineAnswerState = 'supported' | 'partial' | 'unknown';
export type MailBaselineSource = 'mail_event' | 'external_sent' | 'import' | 'projection';
export type MailBaselineSourceBasis =
  | 'source_event'
  | 'sender_timestamp_estimate'
  | 'first_known'
  | 'import_created_at'
  | 'availability'
  | 'unknown';

/**
 * Creation/ingest clocks establish that a fact is present, not when the
 * source event happened.  Keep their labels for provenance, but never let
 * them establish a population, reply, or latency denominator.
 */
export function isMailBaselineAvailabilityBasis(
  basis: MailBaselineSourceBasis | null | undefined,
): boolean {
  return basis === 'availability' || basis === 'first_known' || basis === 'import_created_at';
}
export type MailBaselineLinkStrength = 'header' | 'thread' | 'manual' | 'ambiguous' | 'unknown';
export type MailBaselineDeliveryStatus =
  | 'accepted'
  | 'partial'
  | 'sent'
  | 'queued'
  | 'sending'
  | 'cancelled'
  | 'failed'
  | 'unknown';

export type MailBaselineDelivery = {
  status: MailBaselineDeliveryStatus;
  acceptedAt?: string | null;
  acceptedRecipients?: readonly string[];
  rejectedRecipients?: readonly string[];
};

export type MailBaselineEvidence = {
  id: string;
  requestId: string;
  askId: string;
  threadId: string;
  transportId: string;
  eventType: MailBaselineEventType;
  direction: 'inbound' | 'outbound';
  eventAt: string | Date | null;
  observedAt?: string | Date | null;
  source: MailBaselineSource;
  sourceBasis: MailBaselineSourceBasis;
  sourceMessageId?: string | null;
  requiresHotelResponse?: boolean;
  requiresCustomerInformation?: boolean;
  noReplyRequired?: boolean;
  answerState?: MailBaselineAnswerState | null;
  workState?: MailBaselineWorkState | null;
  substantive?: boolean;
  linkStrength?: MailBaselineLinkStrength;
  delivery?: MailBaselineDelivery | null;
  /** Stable semantic fact identity. Duplicate disagreement is always unknown. */
  factKey?: string;
  /** Optional source/judge version kept with the compact fact. */
  classifierVersion?: string | null;
  reviewerVersion?: string | null;
  unknownReason?: string | null;
};

export type MailBaselineCoverage = {
  /** Version of the producer-side measurement/T0 config snapshot. */
  configVersion?: string | null;
  startAt: string | null;
  endAt: string | null;
  basis: string;
  complete: boolean;
  confirmedGapIntervals?: readonly { startAt: string; endAt: string }[];
};

export type MailBaselineReducerInput = {
  transportId: string;
  threadId: string;
  observationCutoff: string | Date;
  measurementStartAt?: string | Date | null;
  coverage?: MailBaselineCoverage;
  sourceVintage: string;
  interpretationVersion: string;
  reviewerVersion?: string | null;
  evidence: readonly MailBaselineEvidence[];
};

export type MailBaselineAskProjection = {
  requestId: string;
  askId: string;
  threadId: string;
  startedAt: string | null;
  usefulReplyAt: string | null;
  waitStartedAt: string | null;
  followUpCount: number;
  replyState: MailBaselineReplyState;
  workState: MailBaselineWorkState;
  answerState: MailBaselineAnswerState | null;
  requiresHotelResponse: boolean;
  requiresCustomerInformation: boolean;
  noReplyRequired: boolean;
  partial: boolean;
  unknown: boolean;
  sourceMessageIds: readonly string[];
  unknownReasons: readonly string[];
};

export type MailBaselineProjection = {
  projectionVersion: string;
  transportId: string;
  threadId: string;
  sourceVintage: string;
  interpretationVersion: string;
  reviewerVersion: string | null;
  observationCutoff: string;
  coverage: MailBaselineCoverage;
  primaryBucket: MailBaselinePrimaryBucket;
  replyState: MailBaselineReplyState;
  workState: MailBaselineWorkState;
  asks: readonly MailBaselineAskProjection[];
  overlays: readonly ('partially_answered' | 'unknown_evidence' | 'pre_period' | 'coverage_gap')[];
  answeredAskCount: number;
  openAskCount: number;
  eligibleAskCount: number | null;
  answeredAskDurationCount: number | null;
  denominators: {
    eligible: number | null;
    scorable: number | null;
    unscorable: number | null;
  };
  exclusions: Record<string, number>;
  firstAskAt: string | null;
  waitStartedAt: string | null;
  sourceMessageIds: readonly string[];
};

type ParsedEvidence = MailBaselineEvidence & { eventDate: Date | null; observedDate: Date | null };

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}

function stableEvidenceCompare(left: ParsedEvidence, right: ParsedEvidence): number {
  const leftTime = left.eventDate?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightTime = right.eventDate?.getTime() ?? Number.NEGATIVE_INFINITY;
  return (
    leftTime - rightTime || left.id.localeCompare(right.id) || left.askId.localeCompare(right.askId)
  );
}

function hasCoverageGap(at: Date, coverage: MailBaselineCoverage): boolean {
  return (coverage.confirmedGapIntervals ?? []).some((gap) => {
    const start = asDate(gap.startAt)?.getTime();
    const end = asDate(gap.endAt)?.getTime();
    return start !== undefined && end !== undefined && start <= at.getTime() && at.getTime() < end;
  });
}

function eventCanAnswer(evidence: ParsedEvidence): boolean {
  if (evidence.eventDate === null || isMailBaselineAvailabilityBasis(evidence.sourceBasis))
    return false;
  if (evidence.direction !== 'outbound') return false;
  if (
    evidence.eventType === 'acknowledgement' ||
    evidence.eventType === 'forward' ||
    evidence.eventType === 'work_update'
  )
    return false;
  if (evidence.substantive !== true) return false;
  if (evidence.linkStrength === 'ambiguous' || evidence.linkStrength === 'unknown') return false;
  const delivery = evidence.delivery;
  if (!delivery) return evidence.source === 'external_sent';
  if (delivery.status === 'accepted' || delivery.status === 'partial') {
    const acceptedAt = asDate(delivery.acceptedAt);
    // SMTP acceptance is observed after message event time in the normal
    // path; the reducer has already bounded the evidence observation clock.
    return acceptedAt !== null;
  }
  // An externally observed Sent copy is valid evidence even when no Nava queue
  // row exists. Queued, failed, cancelled, and unknown are never replies.
  return delivery.status === 'sent' && evidence.source === 'external_sent';
}

function answerValue(evidence: ParsedEvidence): MailBaselineAnswerState | null {
  if (evidence.answerState === 'unknown') return 'unknown';
  if (evidence.answerState && eventCanAnswer(evidence)) return evidence.answerState;
  if (evidence.eventType === 'answer' && eventCanAnswer(evidence)) return 'supported';
  return null;
}

function valuesConflict<T>(values: readonly T[]): boolean {
  const serialized = new Set(values.map((value) => JSON.stringify(value)));
  return serialized.size > 1;
}

/**
 * Aggregate one field's facts. A repeated fact key with conflicting values is
 * unknown regardless of the input order. Different fact keys are a temporal
 * sequence and the latest valid fact wins.
 */
function reduceField<T>(
  events: readonly ParsedEvidence[],
  field: (event: ParsedEvidence) => T | null | undefined,
): { value: T | null; conflict: boolean } {
  const groups = new Map<string, { values: T[]; latest: ParsedEvidence }>();
  for (const event of events) {
    const value = field(event);
    if (value === null || value === undefined) continue;
    const key = `${event.factKey ?? event.id}:${field.name || 'field'}`;
    const group = groups.get(key) ?? { values: [], latest: event };
    group.values.push(value);
    if (stableEvidenceCompare(group.latest, event) < 0) group.latest = event;
    groups.set(key, group);
  }
  const conflict = [...groups.values()].some((group) => valuesConflict(group.values));
  if (conflict) return { value: null, conflict: true };
  const latest = [...groups.values()]
    .sort((left, right) => stableEvidenceCompare(left.latest, right.latest))
    .at(-1);
  return { value: (latest?.values.at(-1) as T | undefined) ?? null, conflict: false };
}

function normalizeCoverage(input: MailBaselineReducerInput, cutoff: Date): MailBaselineCoverage {
  return (
    input.coverage ?? {
      startAt: asDate(input.measurementStartAt)?.toISOString() ?? null,
      endAt: cutoff.toISOString(),
      basis: 'coverage_unconfigured',
      complete: false,
    }
  );
}

function makeDefaultAsk(
  requestId: string,
  askId: string,
  threadId: string,
): MailBaselineAskProjection {
  return {
    requestId,
    askId,
    threadId,
    startedAt: null,
    usefulReplyAt: null,
    waitStartedAt: null,
    followUpCount: 0,
    replyState: 'unknown',
    workState: 'unknown',
    answerState: null,
    requiresHotelResponse: false,
    requiresCustomerInformation: false,
    noReplyRequired: false,
    partial: false,
    unknown: true,
    sourceMessageIds: [],
    unknownReasons: ['no_scoped_ask_boundary'],
  };
}

function replyStateForAsk(input: {
  answerState: MailBaselineAnswerState | null;
  requiresHotelResponse: boolean;
  requiresCustomerInformation: boolean;
  noReplyRequired: boolean;
  unknown: boolean;
}): MailBaselineReplyState {
  if (input.answerState === 'supported') return 'answered';
  if (input.answerState === 'partial') return 'awaiting_hotel';
  if (input.answerState === 'unknown' || input.unknown) return 'unknown';
  if (input.requiresHotelResponse) return 'awaiting_hotel';
  if (input.requiresCustomerInformation) return 'awaiting_customer';
  if (input.noReplyRequired) return 'no_reply_required';
  return 'unknown';
}

function choosePrimaryBucket(
  asks: readonly MailBaselineAskProjection[],
  hasUnknownEvidence: boolean,
): MailBaselinePrimaryBucket {
  if (asks.some((ask) => ask.replyState === 'awaiting_hotel')) return 'awaiting_hotel_reply';
  if (asks.some((ask) => ask.replyState === 'awaiting_customer')) {
    return 'awaiting_customer_information';
  }
  if (asks.some((ask) => ['open', 'partially_complete'].includes(ask.workState))) {
    return 'hotel_action_pending';
  }
  if (
    hasUnknownEvidence ||
    asks.some((ask) => ask.replyState === 'unknown' || ask.workState === 'unknown')
  ) {
    return 'unknown';
  }
  if (
    asks.some((ask) => ask.answerState === 'supported') &&
    asks.every((ask) => ['complete', 'not_required'].includes(ask.workState))
  ) {
    return 'answered';
  }
  if (
    asks.length > 0 &&
    asks.every((ask) => ask.replyState === 'no_reply_required' && ask.workState === 'not_required')
  ) {
    return 'no_reply_required';
  }
  return 'unknown';
}

export function reduceMailBaseline(input: MailBaselineReducerInput): MailBaselineProjection {
  const cutoff = asDate(input.observationCutoff);
  if (!cutoff) throw new Error('mail baseline observation cutoff must be a valid instant');
  const measurementStart = asDate(input.measurementStartAt);
  const coverage = normalizeCoverage(input, cutoff);
  const exclusions: Record<string, number> = {};
  const increment = (key: string) => {
    exclusions[key] = (exclusions[key] ?? 0) + 1;
  };

  const valid: ParsedEvidence[] = [];
  for (const raw of input.evidence) {
    const eventDate = asDate(raw.eventAt);
    const observedDate = asDate(raw.observedAt);
    if (
      (eventDate && eventDate.getTime() > cutoff.getTime()) ||
      (observedDate && observedDate > cutoff)
    ) {
      increment('future_event');
      continue;
    }
    if (eventDate && eventDate.getTime() < 0) {
      increment('invalid_clock');
      continue;
    }
    valid.push({ ...raw, eventDate, observedDate });
  }
  valid.sort(stableEvidenceCompare);

  const byAsk = new Map<string, ParsedEvidence[]>();
  for (const event of valid) {
    if (event.transportId !== input.transportId || event.threadId !== input.threadId) {
      increment('scope_mismatch');
      continue;
    }
    const list = byAsk.get(event.askId) ?? [];
    list.push(event);
    byAsk.set(event.askId, list);
  }

  const asks: MailBaselineAskProjection[] = [];
  let hasUnknownEvidence = false;
  let prePeriod = false;
  let coverageGap = false;
  let eligible = measurementStart ? 0 : null;
  let scorable = measurementStart ? 0 : null;
  let unscorable = measurementStart ? 0 : null;
  const sourceMessageIds = new Set<string>();

  for (const [askId, events] of byAsk) {
    const requestId = events[0]?.requestId ?? askId;
    const ask = makeDefaultAsk(requestId, askId, input.threadId);
    const startEvent =
      events.find(
        (event) =>
          event.eventType === 'ask' ||
          event.requiresHotelResponse ||
          event.requiresCustomerInformation,
      ) ?? events[0];
    ask.startedAt = startEvent ? iso(startEvent.eventDate) : null;
    ask.waitStartedAt = ask.startedAt;
    ask.followUpCount = events.filter((event) => event.eventType === 'clarification').length;
    ask.sourceMessageIds = [
      ...new Set(
        events.map((event) => event.sourceMessageId).filter((id): id is string => Boolean(id)),
      ),
    ].sort();
    for (const id of ask.sourceMessageIds) sourceMessageIds.add(id);

    const requiresHotel = reduceField(events, (event) =>
      event.requiresHotelResponse === true ? true : null,
    );
    const requiresCustomer = reduceField(events, (event) =>
      event.requiresCustomerInformation === true ? true : null,
    );
    const noReply = reduceField(events, (event) => (event.noReplyRequired === true ? true : null));
    const work = reduceField(events, (event) => event.workState ?? null);
    const answers = events
      .filter((event) => event.eventType === 'answer' || event.answerState !== null)
      .map((event) => ({ event, value: answerValue(event) }))
      .filter(
        (item): item is { event: ParsedEvidence; value: MailBaselineAnswerState } =>
          item.value !== null,
      );
    const answerGroups = new Map<
      string,
      { values: MailBaselineAnswerState[]; latest: ParsedEvidence }
    >();
    for (const { event, value } of answers) {
      const key = `${event.factKey ?? event.id}:answer`;
      const group = answerGroups.get(key) ?? { values: [], latest: event };
      group.values.push(value);
      if (stableEvidenceCompare(group.latest, event) < 0) group.latest = event;
      answerGroups.set(key, group);
    }
    const answerConflict = [...answerGroups.values()].some((group) => valuesConflict(group.values));
    const latestAnswer = [...answerGroups.values()]
      .sort((left, right) => stableEvidenceCompare(left.latest, right.latest))
      .at(-1);
    const answerState = answerConflict ? null : (latestAnswer?.values.at(-1) ?? null);
    const firstUsefulReply = answers
      .filter((item) => item.value === 'supported' && item.event.eventDate !== null)
      .sort((left, right) => stableEvidenceCompare(left.event, right.event))[0]?.event;
    ask.usefulReplyAt =
      !answerConflict && firstUsefulReply ? iso(firstUsefulReply.eventDate) : null;
    const explicitUnknown = events.some(
      (event) => event.answerState === 'unknown' || event.unknownReason,
    );
    const ignoredNonSubstantive = events.some(
      (event) =>
        (event.eventType === 'answer' || event.answerState === 'supported') &&
        (!eventCanAnswer(event) ||
          event.eventType === 'acknowledgement' ||
          event.eventType === 'forward'),
    );
    const unknown =
      answerConflict ||
      explicitUnknown ||
      ignoredNonSubstantive ||
      events.some(
        (event) => event.eventDate === null || isMailBaselineAvailabilityBasis(event.sourceBasis),
      ) ||
      requiresHotel.conflict ||
      requiresCustomer.conflict ||
      noReply.conflict ||
      work.conflict;
    if (unknown) hasUnknownEvidence = true;

    ask.requiresHotelResponse = requiresHotel.value === true;
    ask.requiresCustomerInformation = requiresCustomer.value === true;
    ask.noReplyRequired = noReply.value === true;
    ask.answerState = answerConflict ? 'unknown' : answerState;
    ask.workState = work.conflict ? 'unknown' : (work.value ?? 'unknown');
    if (ask.workState === 'unknown' && ask.answerState === 'supported') {
      // A supported answer never proves that off-email work completed.
      ask.workState = 'unknown';
    }
    ask.partial = ask.answerState === 'partial' || ask.workState === 'partially_complete';
    ask.unknown = unknown || ask.answerState === 'unknown' || ask.workState === 'unknown';
    const unavailableClock = events.some(
      (event) => event.eventDate === null || isMailBaselineAvailabilityBasis(event.sourceBasis),
    );
    if (unavailableClock) {
      // A clockless fact can identify an ask, but cannot establish its current
      // work/reply state or win an operational bucket.
      ask.answerState = 'unknown';
      ask.workState = 'unknown';
      ask.partial = false;
    }
    ask.replyState = replyStateForAsk({
      answerState: ask.answerState,
      requiresHotelResponse: ask.requiresHotelResponse,
      requiresCustomerInformation: ask.requiresCustomerInformation,
      noReplyRequired: ask.noReplyRequired,
      unknown:
        unavailableClock ||
        (ask.unknown && !ask.requiresHotelResponse && !ask.requiresCustomerInformation),
    });
    ask.unknownReasons = [
      ...(answerConflict ? ['conflicting_duplicate_answer'] : []),
      ...(explicitUnknown
        ? events
            .filter((event) => event.unknownReason)
            .map((event) => event.unknownReason!)
            .sort()
        : []),
      ...(ignoredNonSubstantive ? ['non_substantive_or_unaccepted_reply'] : []),
      ...(unavailableClock ? ['availability_clock_unavailable'] : []),
      ...(requiresHotel.conflict ? ['conflicting_duplicate_hotel_response_requirement'] : []),
      ...(requiresCustomer.conflict ? ['conflicting_duplicate_customer_requirement'] : []),
      ...(work.conflict ? ['conflicting_duplicate_work_state'] : []),
    ];

    if (measurementStart) {
      const started = asDate(ask.startedAt);
      if (!started || unavailableClock) {
        eligible! += 1;
        unscorable! += 1;
        increment('unscorable_event_clock');
      } else {
        if (started < measurementStart) {
          prePeriod = true;
          increment('pre_period');
          // A pre-T0 unresolved ask is retained as a separate backlog/unknown-
          // start population and must not win the current-period bucket.
          ask.unknown = true;
          ask.replyState = 'unknown';
          ask.workState = 'unknown';
          ask.unknownReasons = [...ask.unknownReasons, 'pre_period'];
        } else {
          eligible! += 1;
          const inGap = hasCoverageGap(started, coverage);
          const covered =
            coverage.complete && !inGap && started >= measurementStart && started < cutoff;
          if (inGap) {
            coverageGap = true;
            increment('coverage_gap');
          }
          if (covered) scorable! += 1;
          else {
            unscorable! += 1;
            increment('unscorable');
          }
        }
      }
    }
    asks.push(ask);
  }

  asks.sort(
    (left, right) =>
      (left.startedAt ?? '').localeCompare(right.startedAt ?? '') ||
      left.askId.localeCompare(right.askId),
  );
  const overlays: MailBaselineProjection['overlays'][number][] = [];
  if (asks.some((ask) => ask.partial) && asks.some((ask) => ask.replyState !== 'answered'))
    overlays.push('partially_answered');
  if (hasUnknownEvidence || asks.some((ask) => ask.unknown)) overlays.push('unknown_evidence');
  if (prePeriod) overlays.push('pre_period');
  if (coverageGap || !coverage.complete) overlays.push('coverage_gap');

  const answeredAskCount = asks.filter((ask) => ask.replyState === 'answered').length;
  const openAskCount = asks.filter(
    (ask) =>
      ['open', 'partially_complete'].includes(ask.workState) ||
      ask.replyState === 'awaiting_hotel' ||
      ask.replyState === 'awaiting_customer',
  ).length;
  const primaryBucket = choosePrimaryBucket(asks, hasUnknownEvidence);
  const replyState: MailBaselineReplyState = asks.some((ask) => ask.replyState === 'awaiting_hotel')
    ? 'awaiting_hotel'
    : asks.some((ask) => ask.replyState === 'awaiting_customer')
      ? 'awaiting_customer'
      : asks.every((ask) => ask.replyState === 'answered') && asks.length > 0
        ? 'answered'
        : asks.every((ask) => ask.replyState === 'no_reply_required') && asks.length > 0
          ? 'no_reply_required'
          : 'unknown';
  const workState: MailBaselineWorkState = asks.some((ask) => ask.workState === 'open')
    ? 'open'
    : asks.some((ask) => ask.workState === 'partially_complete')
      ? 'partially_complete'
      : asks.length > 0 && asks.every((ask) => ask.workState === 'complete')
        ? 'complete'
        : asks.length > 0 && asks.every((ask) => ask.workState === 'not_required')
          ? 'not_required'
          : 'unknown';
  const firstAskAt =
    asks
      .map((ask) => ask.startedAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
  const waitStartedAt =
    asks
      .filter(
        (ask) => ask.replyState === 'awaiting_hotel' || ask.replyState === 'awaiting_customer',
      )
      .map((ask) => ask.waitStartedAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;

  return {
    projectionVersion: MAIL_BASELINE_PROJECTION_VERSION,
    transportId: input.transportId,
    threadId: input.threadId,
    sourceVintage: input.sourceVintage,
    interpretationVersion: input.interpretationVersion,
    reviewerVersion: input.reviewerVersion ?? null,
    observationCutoff: cutoff.toISOString(),
    coverage,
    primaryBucket,
    replyState,
    workState,
    asks,
    overlays,
    answeredAskCount,
    openAskCount,
    eligibleAskCount: eligible,
    answeredAskDurationCount: eligible === null ? null : scorable,
    denominators: { eligible, scorable, unscorable },
    exclusions,
    firstAskAt,
    waitStartedAt,
    sourceMessageIds: [...sourceMessageIds].sort(),
  };
}
