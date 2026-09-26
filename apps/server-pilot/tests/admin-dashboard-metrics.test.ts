import {
  aggregateAdminDashboardMetrics,
  type AdminDashboardMessageRow,
  type AdminDashboardThreadRow,
} from '../src/metrics/admin-dashboard-aggregates.js';
import { reduceMailBaseline } from '../src/metrics/mail-baseline.js';
import { describe, expect, it } from 'vitest';

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-08-08T00:00:00.000Z');

function msg(
  partial: Partial<AdminDashboardMessageRow> &
    Pick<AdminDashboardMessageRow, 'id' | 'threadId' | 'transportId' | 'direction'>,
): AdminDashboardMessageRow {
  return {
    receivedAt: partial.receivedAt ?? null,
    sentAt: partial.sentAt ?? null,
    createdAt: partial.createdAt ?? new Date('2026-08-02T10:00:00.000Z'),
    ...partial,
  };
}

function thread(
  partial: Partial<AdminDashboardThreadRow> & Pick<AdminDashboardThreadRow, 'id' | 'transportId'>,
): AdminDashboardThreadRow {
  return {
    spamAt: partial.spamAt ?? null,
    trashedAt: partial.trashedAt ?? null,
    ...partial,
  };
}

describe('aggregateAdminDashboardMetrics', () => {
  it('keeps the strict executive payload truthful across cohorts, clocks, duplicates, and sends', () => {
    const cutoff = new Date('2026-08-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: {
        classificationAsOf: cutoff,
        snapshotBasis: 'retained_matching_snapshot',
        threads: [
          { threadId: 'c1', primaryFolder: 'bookings', urgent: true, spam: false, trashed: false },
          {
            threadId: 'c2',
            primaryFolder: null,
            folderSlugs: ['money-billing', 'documents-delivery'],
            spam: false,
            trashed: false,
          },
          { threadId: 'c3', primaryFolder: 'groups-events', spam: true, trashed: false },
          { threadId: 'c4', primaryFolder: 'manage-stay', spam: false, trashed: true },
        ],
      },
      threads: [
        thread({ id: 'c1', transportId: 'transport-centurion-a' }),
        thread({ id: 'c2', transportId: 'transport-centurion-b' }),
        thread({ id: 'c3', transportId: 'transport-centurion-a' }),
        thread({ id: 'c4', transportId: 'transport-centurion-b' }),
        thread({ id: 'research', transportId: 'transport-pmbobo' }),
      ],
      preWindowThreadIds: ['c2'],
      preWindowEvidenceAvailable: true,
      messages: [
        msg({
          id: 'c1-in-copy',
          sourceMessageId: 'source-c1-in',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
          fromAddress: 'guest-one@example.com',
        }),
        msg({
          id: 'c1-in',
          sourceMessageId: 'source-c1-in',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:01:00.000Z'),
          fromAddress: 'guest-one@example.com',
        }),
        msg({
          id: 'c1-accepted',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T09:00:00.000Z'),
          sendState: 'accepted',
        }),
        msg({
          id: 'c1-queued',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T09:10:00.000Z'),
          sendState: 'pending',
        }),
        msg({
          id: 'c2-in',
          threadId: 'c2',
          transportId: 'transport-centurion-b',
          direction: 'inbound',
          receivedAt: new Date('2026-08-03T08:00:00.000Z'),
          fromAddress: 'guest-two@example.com',
        }),
        msg({
          id: 'c2-failed',
          threadId: 'c2',
          transportId: 'transport-centurion-b',
          direction: 'outbound',
          sentAt: new Date('2026-08-03T09:00:00.000Z'),
          sendState: 'failed',
        }),
        msg({
          id: 'c3-in',
          threadId: 'c3',
          transportId: 'transport-centurion-a',
          direction: 'inbound',
          receivedAt: new Date('2026-08-04T08:00:00.000Z'),
          fromAddress: 'guest-three@example.com',
        }),
        msg({
          id: 'c4-in',
          threadId: 'c4',
          transportId: 'transport-centurion-b',
          direction: 'inbound',
          receivedAt: new Date('2026-08-04T08:00:00.000Z'),
          fromAddress: 'guest-four@example.com',
        }),
        msg({
          id: 'imported-old',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'inbound',
          receivedAt: new Date('2026-07-01T08:00:00.000Z'),
          createdAt: new Date('2026-08-05T08:00:00.000Z'),
          fromAddress: 'old@example.com',
        }),
        msg({
          id: 'future',
          threadId: 'c1',
          transportId: 'transport-centurion-a',
          direction: 'outbound',
          sentAt: new Date('2026-08-08T00:00:00.000Z'),
          sendState: 'sent',
        }),
        msg({
          id: 'research-in',
          threadId: 'research',
          transportId: 'transport-pmbobo',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
          fromAddress: 'research@example.com',
        }),
      ],
      transports: [
        { id: 'transport-centurion-a', email: 'centurion-a@legacyhotels.co.za', displayName: 'A' },
        { id: 'transport-centurion-b', email: 'centurion-b@legacyhotels.co.za', displayName: 'B' },
        { id: 'transport-pmbobo', email: 'pmbobo@legacyhotels.co.za', displayName: 'Research' },
      ],
      windowStart: WINDOW_START,
      windowEnd: cutoff,
    });

    expect(result.traffic.inbound.value).toBe(4);
    expect(result.traffic.outbound.value).toBe(1);
    expect(result.activity.distinctExternalSenderAddresses.value).toBe(2);
    expect(result.activity.newlyObservedConversations.value).toBe(1);
    expect(result.activity.continuingConversations.value).toBe(1);
    expect(result.traffic.inbound.captureBasis).toBe('raw_observed_transport_messages');
    expect(result.folders.mix.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folder: 'bookings', count: 1 }),
        expect.objectContaining({ folder: 'unknown-review', count: 1 }),
      ]),
    );
    expect(result.folders.urgent.value).toBe(1);
    expect(result.folders.exclusions).toMatchObject({ spam: 1, trash: 1 });
    expect(result.service.firstObservedHumanReply.value).toBeNull();
    expect(result.service.firstObservedHumanReply.availabilityReason).toBe(
      'measurement_config_unavailable',
    );
    expect(result.conversations.awaitingHotel.value).toBeNull();
    expect(result.conversations.awaitingHotel.availabilityReason).toBe(
      'request_projection_unavailable',
    );
    expect(result.transports.map((transport) => transport.id)).toEqual([
      'transport-centurion-a',
      'transport-centurion-b',
    ]);
  });

  it('does not infer newly observed from pre-window history with no source event clock', () => {
    const cutoff = new Date('2026-08-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: {
        classificationAsOf: cutoff,
        snapshotBasis: 'retained_matching_snapshot',
        threads: [
          { threadId: 'unknown-history', primaryFolder: 'bookings', spam: false, trashed: false },
        ],
      },
      threads: [thread({ id: 'unknown-history', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'unknown-history-current',
          threadId: 'unknown-history',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      preWindowThreadIds: [],
      preWindowUnknownThreadIds: ['unknown-history'],
      preWindowEvidenceAvailable: true,
      windowStart: WINDOW_START,
      windowEnd: cutoff,
    });

    expect(result.activity.activeConversations.value).toBe(1);
    expect(result.activity.newlyObservedConversations).toMatchObject({
      availability: 'unavailable',
      value: null,
      availabilityReason: 'pre_window_history_unknown',
    });
    expect(result.activity.continuingConversations).toMatchObject({
      availability: 'unavailable',
      value: null,
      availabilityReason: 'pre_window_history_unknown',
    });
  });

  it('keeps traffic available but gates mutable folder and spam/trash work without a matching snapshot', () => {
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: WINDOW_END,
      classificationSnapshot: null,
      threads: [thread({ id: 't1', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'm1',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.traffic.inbound.value).toBe(1);
    expect(result.folders.mix.value).toBeNull();
    expect(result.folders.mix.availability).toBe('unavailable');
    expect(result.folders.mix.availabilityReason).toBe('classification_snapshot_unavailable');
    expect(result.activity.activeConversations.value).toBeNull();
    expect(result.activity.distinctExternalSenderAddresses.value).toBeNull();
    expect(result.conversations.unknown.value).toBeNull();
    expect(result.service.firstObservedHumanReply.value).toBeNull();
  });

  it('keeps confirmed capture-gap intervals out of first observed reply durations', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: {
        classificationAsOf: cutoff,
        snapshotBasis: 'retained_matching_snapshot',
        threads: [
          { threadId: 'gap-thread', primaryFolder: 'bookings', spam: false, trashed: false },
        ],
      },
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [
          { startAt: '2026-09-03T00:00:00.000Z', endAt: '2026-09-04T00:00:00.000Z' },
        ],
      },
      threads: [thread({ id: 'gap-thread', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'gap-inbound',
          threadId: 'gap-thread',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T12:00:00.000Z'),
          fromAddress: 'gap-guest@example.com',
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
        msg({
          id: 'gap-outbound',
          threadId: 'gap-thread',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-09-04T12:00:00.000Z'),
          authorClass: 'internal_human',
          hasScopedReplyLink: true,
          sendState: 'accepted',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.firstObservedHumanReply.value).toBeNull();
    expect(result.service.unscorable).toBe(1);
    expect(result.service.firstObservedHumanReply.exclusions).toMatchObject({ unscorable: 1 });
  });

  it('marks first observed reply unavailable when route rows omit approved evidence fields', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: {
        classificationAsOf: cutoff,
        snapshotBasis: 'retained_matching_snapshot',
        threads: [
          { threadId: 'route-thread', primaryFolder: 'bookings', spam: false, trashed: false },
        ],
      },
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'route-thread', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'route-inbound',
          threadId: 'route-thread',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T12:00:00.000Z'),
          fromAddress: 'route-guest@example.com',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.firstObservedHumanReply).toMatchObject({
      availability: 'unavailable',
      value: null,
      availabilityReason: 'reply_evidence_unavailable',
    });
    expect(result.service.counts.eligibleNewConversations).toMatchObject({
      availability: 'unavailable',
      value: null,
      denominator: null,
      denominatorStatus: 'not_applicable',
    });
    expect(result.service.counts.unansweredEligible).toMatchObject({
      availability: 'unavailable',
      value: null,
      denominator: null,
      denominatorStatus: 'unknown',
    });
    expect(result.service.counts.unscorable).toMatchObject({
      availability: 'unavailable',
      value: null,
      denominator: null,
      denominatorStatus: 'unknown',
    });
    expect(result.service.eligibleNewConversationCount).toBeNull();
    expect(result.service.unansweredEligible).toBeNull();
    expect(result.eligibleThreadCount).toBeNull();
    expect(result.unansweredEligible).toBeNull();
    expect(result.perTransport[0]?.unanswered).toBeNull();
  });

  it('computes median and p90 only from complete first-observed-human-reply evidence', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const common = {
      cohortId: 'centurion' as const,
      observationCutoff: cutoff,
      classificationSnapshot: {
        classificationAsOf: cutoff,
        snapshotBasis: 'retained_matching_snapshot',
        threads: [
          { threadId: 'reply-a', primaryFolder: 'bookings', spam: false, trashed: false },
          { threadId: 'reply-b', primaryFolder: 'bookings', spam: false, trashed: false },
        ],
      },
      measurementConfig: {
        version: 1 as const,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [
        thread({ id: 'reply-a', transportId: 'transport-centurion' }),
        thread({ id: 'reply-b', transportId: 'transport-centurion' }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    };
    const result = aggregateAdminDashboardMetrics({
      ...common,
      messages: [
        msg({
          id: 'reply-a-in',
          threadId: 'reply-a',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T12:00:00.000Z'),
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
        msg({
          id: 'reply-a-out',
          threadId: 'reply-a',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-09-02T12:30:00.000Z'),
          authorClass: 'internal_human',
          hasScopedReplyLink: true,
          sendState: 'sent',
        }),
        msg({
          id: 'reply-b-in',
          threadId: 'reply-b',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-03T12:00:00.000Z'),
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
        msg({
          id: 'reply-b-out',
          threadId: 'reply-b',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-09-03T14:00:00.000Z'),
          authorClass: 'internal_human',
          hasScopedReplyLink: true,
          sendState: 'sent',
        }),
      ],
    });

    expect(result.service.firstObservedHumanReply.availability).toBe('available');
    expect(result.medianFirstResponseMinutes).toMatchObject({ availability: 'live', value: 75 });
    expect(result.p90FirstResponseMinutes).toMatchObject({ availability: 'live', value: 120 });
    expect(result.service.eligibleNewConversationCount).toBe(2);
    expect(result.service.unansweredEligible).toBe(0);
  });

  it('does not use an inbound start after window end even when its reply is before cutoff', () => {
    const windowStart = new Date('2026-09-01T00:00:00.000Z');
    const windowEnd = new Date('2026-09-06T00:00:00.000Z');
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: windowStart.toISOString(),
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'late-start', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'late-start-inbound',
          threadId: 'late-start',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-07T10:00:00.000Z'),
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
        msg({
          id: 'late-start-outbound',
          threadId: 'late-start',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-09-07T11:00:00.000Z'),
          authorClass: 'internal_human',
          hasScopedReplyLink: true,
          sendState: 'sent',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart,
      windowEnd,
    });

    expect(result.traffic.inbound.value).toBe(0);
    expect(result.traffic.outbound.value).toBe(0);
    expect(result.service.firstObservedHumanReply).toMatchObject({
      availability: 'unavailable',
      value: null,
      availabilityReason: 'no_eligible_new_conversations',
    });
    expect(result.service.eligibleNewConversationCount).toBe(0);
    expect(result.service.unansweredEligible).toBe(0);
  });

  it('publishes strict service count evidence with the configured measurement start', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const measurementStartAt = '2026-09-01T00:00:00.000Z';
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt,
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'count-evidence', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'count-evidence-inbound',
          threadId: 'count-evidence',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T10:00:00.000Z'),
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.counts).toMatchObject({
      eligibleNewConversations: {
        availability: 'available',
        value: 1,
        unit: 'conversations',
        denominator: null,
        denominatorStatus: 'not_applicable',
        captureBasis: 'measurement_start_at:2026-09-01T00:00:00.000Z; verified-two-way-feed',
      },
      unansweredEligible: {
        availability: 'available',
        value: 1,
        denominator: 1,
        denominatorStatus: 'known',
      },
      unscorable: {
        availability: 'available',
        value: 0,
        denominator: 1,
        denominatorStatus: 'known',
      },
      measurementStartAt,
      measurementConfigVersion: '1',
    });
  });

  it('reports first useful reply only from retained supported baseline evidence', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const projection = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'useful-reply-thread',
      observationCutoff: cutoff,
      measurementStartAt: '2026-09-01T00:00:00.000Z',
      coverage: {
        configVersion: '1',
        startAt: '2026-09-01T00:00:00.000Z',
        endAt: cutoff.toISOString(),
        basis: 'verified-two-way-feed',
        complete: true,
      },
      sourceVintage: '2026-09-08T00:00:00.000Z',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      evidence: [
        {
          id: 'useful-ask',
          requestId: 'useful-request',
          askId: 'useful-ask',
          threadId: 'useful-reply-thread',
          transportId: 'transport-centurion',
          eventType: 'ask',
          direction: 'inbound',
          eventAt: '2026-09-02T10:00:00.000Z',
          observedAt: '2026-09-02T10:01:00.000Z',
          source: 'mail_event',
          sourceBasis: 'source_event',
          requiresHotelResponse: true,
          workState: 'open',
          answerState: null,
          substantive: false,
          linkStrength: 'header',
          delivery: null,
        },
        {
          id: 'useful-answer',
          requestId: 'useful-request',
          askId: 'useful-ask',
          threadId: 'useful-reply-thread',
          transportId: 'transport-centurion',
          eventType: 'answer',
          direction: 'outbound',
          eventAt: '2026-09-02T10:30:00.000Z',
          observedAt: '2026-09-02T10:31:00.000Z',
          source: 'external_sent',
          sourceBasis: 'source_event',
          answerState: 'supported',
          workState: 'complete',
          substantive: true,
          linkStrength: 'header',
          delivery: { status: 'sent' },
        },
      ],
    });
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'current-config-must-not-rewrite-projection',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'useful-reply-thread', transportId: 'transport-centurion' })],
      messages: [],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      requestBaselines: [projection],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.firstUsefulReply).toMatchObject({
      availability: 'available',
      value: 30,
      denominator: 1,
      measurementConfigVersion: '1',
      captureBasis: 'verified-two-way-feed',
    });
  });

  it('does not classify an unknown outbound author as a known unanswered request', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'unknown-outbound', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'unknown-outbound-inbound',
          threadId: 'unknown-outbound',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T10:00:00.000Z'),
          authorClass: 'external_human',
          qualifiesNewConversation: true,
        }),
        msg({
          id: 'unknown-outbound-reply',
          threadId: 'unknown-outbound',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-09-02T11:00:00.000Z'),
          authorClass: 'unknown',
          hasScopedReplyLink: true,
          sendState: 'sent',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.eligibleNewConversationCount).toBe(1);
    expect(result.service.unansweredEligible).toBe(0);
    expect(result.service.unscorable).toBe(1);
    expect(result.service.firstObservedHumanReply.exclusions).toMatchObject({
      unanswered: 0,
      unscorable: 1,
    });
  });

  it('does not assign the known eligible denominator to unknown-author unscorable starts', () => {
    const cutoff = new Date('2026-09-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      measurementConfig: {
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-01T00:00:00.000Z',
        captureAssumptionBasis: 'verified-two-way-feed',
        confirmedGapIntervals: [],
      },
      threads: [thread({ id: 'unknown-author-start', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'unknown-author-start-inbound',
          threadId: 'unknown-author-start',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-09-02T10:00:00.000Z'),
          authorClass: 'unknown',
          qualifiesNewConversation: true,
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.eligibleNewConversationCount).toBe(0);
    expect(result.service.unscorable).toBe(1);
    expect(result.service.counts.unscorable).toMatchObject({
      availability: 'available',
      value: 1,
      denominator: null,
      denominatorStatus: 'unknown',
    });
  });

  it('keeps a sent duplicate observed when a queued copy arrives first and normalizes source IDs', () => {
    const cutoff = new Date('2026-08-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      threads: [],
      messages: [
        msg({
          id: 'queued-copy',
          sourceMessageId: '  "<Same-Source@example.com>" ',
          threadId: 'queue-thread',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T12:00:00.000Z'),
          sendState: 'pending',
        }),
        msg({
          id: 'sent-copy',
          sourceMessageId: '<same-source@example.com>',
          threadId: 'queue-thread',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T12:01:00.000Z'),
          sendState: 'sent',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.traffic.outbound.value).toBe(1);
    expect(result.traffic.outbound.exclusions).toMatchObject({
      duplicate_source_copies: 1,
      non_observed_send_state: 0,
    });
  });

  it('keeps a sent duplicate observed when the queued copy arrives second', () => {
    const cutoff = new Date('2026-08-08T00:00:00.000Z');
    const result = aggregateAdminDashboardMetrics({
      cohortId: 'centurion',
      observationCutoff: cutoff,
      classificationSnapshot: null,
      threads: [],
      messages: [
        msg({
          id: 'sent-first-copy',
          sourceMessageId: '<sent-first@example.com>',
          threadId: 'sent-first-thread',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T12:00:00.000Z'),
          sendState: 'sent',
        }),
        msg({
          id: 'queued-second-copy',
          sourceMessageId: '  "<SENT-FIRST@example.com>"  ',
          threadId: 'sent-first-thread',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T12:01:00.000Z'),
          sendState: 'pending',
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.traffic.outbound.value).toBe(1);
    expect(result.traffic.outbound.exclusions).toMatchObject({
      duplicate_source_copies: 1,
      non_observed_send_state: 0,
    });
  });

  it('returns empty live zeros and unavailable nava cells for empty window', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [],
      messages: [],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.inboundVolume.availability).toBe('live');
    expect(result.inboundVolume.value).toBe(0);
    expect(result.medianFirstResponseMinutes.availability).toBe('live');
    expect(result.medianFirstResponseMinutes.value).toBeNull();
    expect(result.p90FirstResponseMinutes.value).toBeNull();
    expect(result.answeredWithin3hPercent.availability).toBe('live');
    expect(result.answeredWithin3hPercent.value).toBeNull();
    expect(result.unansweredEligible).toBe(0);
    expect(result.eligibleThreadCount).toBe(0);
    expect(result.draftCreationMinutes.availability).toBe('unavailable');
    expect(result.draftCreationMinutes.value).toBeNull();
    expect(result.aiAssistedSendRate.availability).toBe('unavailable');
    expect(result.medianEditDistance.availability).toBe('unavailable');
    expect(result.totalRevenue.availability).toBe('coming_soon');
    // Every JHB day the UTC window touches is padded with zeros so empty days still plot.
    // A 7-day UTC window spans 8 partial Africa/Johannesburg dates.
    expect(result.inboundPerDay).toHaveLength(8);
    expect(result.inboundPerDay[0]?.period).toBe('2026-08-01');
    expect(result.inboundPerDay.at(-1)?.period).toBe('2026-08-08');
    expect(result.inboundPerDay.every((day) => day.byTransport['transport-centurion'] === 0)).toBe(
      true,
    );
    expect(result.comparison).toEqual([
      {
        transportId: 'transport-centurion',
        label: 'Centurion',
        inbound: 0,
        answeredWithin3hPercent: null,
        drafted: null,
      },
    ]);
  });

  it('counts inbound volume and ignores navaai transport messages', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [
        thread({ id: 't1', transportId: 'transport-centurion' }),
        thread({ id: 't2', transportId: 'transport-nava' }),
      ],
      messages: [
        msg({
          id: 'm1',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
        msg({
          id: 'm2',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-03T08:00:00.000Z'),
        }),
        msg({
          id: 'm3',
          threadId: 't2',
          transportId: 'transport-nava',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T09:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
        { id: 'transport-nava', email: 'navaai@legacyhotels.co.za', displayName: 'Nava' },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.inboundVolume.value).toBe(2);
    expect(result.transports.map((t) => t.id)).toEqual(['transport-centurion']);
  });

  it('excludes spam and trash threads from eligibility', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [
        thread({ id: 'ok', transportId: 'transport-centurion' }),
        thread({
          id: 'spam',
          transportId: 'transport-centurion',
          spamAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
        thread({
          id: 'trash',
          transportId: 'transport-centurion',
          trashedAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      ],
      messages: [
        msg({
          id: 'm-ok',
          threadId: 'ok',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
        msg({
          id: 'm-spam',
          threadId: 'spam',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
        msg({
          id: 'm-trash',
          threadId: 'trash',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.inboundVolume.value).toBe(1);
    expect(result.eligibleThreadCount).toBe(1);
  });

  it('computes first-response per thread from earliest inbound to first later outbound', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [
        thread({ id: 'answered', transportId: 'transport-centurion' }),
        thread({ id: 'unanswered', transportId: 'transport-centurion' }),
        thread({ id: 'multi', transportId: 'transport-centurion' }),
      ],
      messages: [
        msg({
          id: 'a-in',
          threadId: 'answered',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
        msg({
          id: 'a-out',
          threadId: 'answered',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T10:30:00.000Z'),
          receivedAt: new Date('2026-08-02T10:31:00.000Z'),
        }),
        msg({
          id: 'u-in',
          threadId: 'unanswered',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T11:00:00.000Z'),
        }),
        msg({
          id: 'multi-in1',
          threadId: 'multi',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T12:00:00.000Z'),
        }),
        msg({
          id: 'multi-in2',
          threadId: 'multi',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T12:10:00.000Z'),
        }),
        msg({
          id: 'multi-out',
          threadId: 'multi',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T13:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    // answered = 30m, multi = 60m (from earliest inbound), unanswered excluded from median
    expect(result.medianFirstResponseMinutes.value).toBe(45);
    expect(result.unansweredEligible).toBe(1);
    expect(result.eligibleThreadCount).toBe(3);
    // 2 of 3 answered within 3h → ~66.7
    expect(result.answeredWithin3hPercent.value).toBe(66.7);
  });

  it('counts same-second outbound as answered and ignores outbound before inbound', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [
        thread({ id: 'same', transportId: 'transport-centurion' }),
        thread({ id: 'skew', transportId: 'transport-centurion' }),
      ],
      messages: [
        msg({
          id: 's-in',
          threadId: 'same',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
        msg({
          id: 's-out',
          threadId: 'same',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
        msg({
          id: 'k-out-early',
          threadId: 'skew',
          transportId: 'transport-centurion',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T09:00:00.000Z'),
        }),
        msg({
          id: 'k-in',
          threadId: 'skew',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(result.medianFirstResponseMinutes.value).toBe(0);
    expect(result.unansweredEligible).toBe(1);
    expect(result.answeredWithin3hPercent.value).toBe(50);
  });

  it('buckets inbound per day in Africa/Johannesburg and builds comparison without drafted', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [thread({ id: 't1', transportId: 'transport-centurion' })],
      messages: [
        msg({
          id: 'm1',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'inbound',
          // 2026-08-02 22:00 UTC = 2026-08-03 00:00 SAST
          receivedAt: new Date('2026-08-02T22:00:00.000Z'),
        }),
        msg({
          id: 'm2',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'inbound',
          receivedAt: new Date('2026-08-03T10:00:00.000Z'),
        }),
        msg({
          id: 'm3',
          threadId: 't1',
          transportId: 'transport-centurion',
          direction: 'outbound',
          // 90 minutes after earliest inbound (still within 3h)
          sentAt: new Date('2026-08-02T23:30:00.000Z'),
        }),
      ],
      transports: [
        {
          id: 'transport-centurion',
          email: 'centurion@legacyhotels.co.za',
          displayName: 'Centurion',
        },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    const day = result.inboundPerDay.find((d) => d.period === '2026-08-03');
    expect(day).toBeDefined();
    expect(day?.byTransport['transport-centurion']).toBe(2);
    expect(result.comparison).toHaveLength(1);
    expect(result.comparison[0]?.transportId).toBe('transport-centurion');
    expect(result.comparison[0]?.inbound).toBe(2);
    expect(result.comparison[0]?.answeredWithin3hPercent).toBe(100);
    expect(result.comparison[0]?.drafted).toBeNull();
    expect(result.assumptions).toContain('bcc_outbound_coverage');
    expect(result.assumptions).toContain('africa_johannesburg_buckets');
    expect(result.footnote).toMatch(/Centurion/i);
  });

  it('exposes per-transport series so a mailbox subset can be recomputed honestly', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [
        thread({ id: 'a1', transportId: 'transport-a' }),
        thread({ id: 'b1', transportId: 'transport-b' }),
      ],
      messages: [
        msg({
          id: 'a-in',
          threadId: 'a1',
          transportId: 'transport-a',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
        msg({
          id: 'a-out',
          threadId: 'a1',
          transportId: 'transport-a',
          direction: 'outbound',
          sentAt: new Date('2026-08-02T10:20:00.000Z'),
        }),
        msg({
          id: 'b-in',
          threadId: 'b1',
          transportId: 'transport-b',
          direction: 'inbound',
          receivedAt: new Date('2026-08-02T10:00:00.000Z'),
        }),
      ],
      transports: [
        { id: 'transport-a', email: 'a@legacyhotels.co.za', displayName: 'A' },
        { id: 'transport-b', email: 'b@legacyhotels.co.za', displayName: null },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    const a = result.perTransport.find((row) => row.transportId === 'transport-a');
    const b = result.perTransport.find((row) => row.transportId === 'transport-b');
    expect(a).toMatchObject({ inbound: 1, unanswered: 0, latenciesMinutes: [20] });
    expect(b).toMatchObject({ inbound: 1, unanswered: 1, latenciesMinutes: [] });
    expect(b?.label).toBe('b@legacyhotels.co.za');
    // Unanswered-only mailbox is a real 0% miss, not null.
    expect(
      result.comparison.find((row) => row.transportId === 'transport-b')?.answeredWithin3hPercent,
    ).toBe(0);
  });
});
