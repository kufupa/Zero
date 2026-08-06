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
