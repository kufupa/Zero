import { describe, expect, it } from 'vitest';
import {
  aggregateAdminDashboardMetrics,
  type AdminDashboardMessageRow,
  type AdminDashboardThreadRow,
} from '../src/metrics/admin-dashboard-aggregates.js';

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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
        threads: [{ threadId: 'gap-thread', primaryFolder: 'bookings', spam: false, trashed: false }],
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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: cutoff,
    });

    expect(result.service.firstObservedHumanReply.value).toBeNull();
    expect(result.service.unscorable).toBe(1);
    expect(result.service.firstObservedHumanReply.exclusions).toMatchObject({ unscorable: 1 });
  });

  it('returns empty live zeros and unavailable nava cells for empty window', () => {
    const result = aggregateAdminDashboardMetrics({
      threads: [],
      messages: [],
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
        { id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' },
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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
      transports: [{ id: 'transport-centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion' }],
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
    expect(result.comparison.find((row) => row.transportId === 'transport-b')?.answeredWithin3hPercent).toBe(0);
  });
});
