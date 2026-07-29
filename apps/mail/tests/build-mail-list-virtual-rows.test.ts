import { describe, expect, it } from 'vitest';
import {
  buildMailListVirtualRows,
  type QueueSlug,
} from '../lib/mail/build-mail-list-virtual-rows';
import type { MailListThreadRow } from '@/types';

const QUEUE_ORDER: readonly QueueSlug[] = ['at-risk', 'new-bookings', 'groups-events', 'ops'];
const QUEUE_LABELS: Record<QueueSlug, string> = {
  'at-risk': 'At risk',
  'new-bookings': 'New Bookings',
  'groups-events': 'Groups & Events',
  ops: 'Ops',
};

function thread(
  id: string,
  receivedOn: string,
  opts: { starred?: boolean; latestMessageAt?: string } = {},
): MailListThreadRow {
  const { starred = false, latestMessageAt } = opts;
  return {
    id,
    receivedOn,
    latestMessageAt: latestMessageAt ?? receivedOn,
    isStarred: starred,
    tags: starred ? [{ id: 's', name: 'STARRED', type: 'system' }] : [],
  };
}

describe('buildMailListVirtualRows', () => {
  const now = new Date('2026-04-13T12:00:00.000Z');

  it('inserts header then threads per bucket; omits empty buckets', () => {
    const rows = buildMailListVirtualRows([thread('a', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: true,
    });
    expect(rows.map((r) => r.type)).toEqual(['header', 'thread']);
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('today');
    expect(rows[1].type === 'thread' && rows[1].threadIndex).toBe(0);
  });

  it('places starred threads in pinned with pinned header first', () => {
    const rows = buildMailListVirtualRows(
      [
        thread('old', '2026-01-01T10:00:00.000Z', { starred: true }),
        thread('today', '2026-04-13T10:00:00.000Z'),
      ],
      now,
      new Set(),
      { groupByDate: true },
    );
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('pinned');
    expect(rows[1].type === 'thread' && rows[1].message.id).toBe('old');
    expect(rows.some((r) => r.type === 'thread' && r.message.id === 'today')).toBe(true);
  });

  it('does not duplicate starred thread in a date bucket', () => {
    const rows = buildMailListVirtualRows(
      [thread('x', '2026-04-13T10:00:00.000Z', { starred: true })],
      now,
      new Set(),
      { groupByDate: true },
    );
    const threadRows = rows.filter((r) => r.type === 'thread');
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0].type === 'thread' && threadRows[0].message.id).toBe('x');
  });

  it('when section collapsed, keeps header but drops threads', () => {
    const collapsed = new Set<'today'>(['today']);
    const rows = buildMailListVirtualRows([thread('a', '2026-04-13T10:00:00.000Z')], now, collapsed, {
      groupByDate: true,
    });
    expect(rows.map((r) => r.type)).toEqual(['header']);
  });

  it('when groupByDate false, returns one thread row per item with correct indices', () => {
    const rows = buildMailListVirtualRows([thread('a', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type === 'thread' && rows[0].threadIndex).toBe(0);
  });

  it('emits four queue headers in scan order even if empty', () => {
    const rows = buildMailListVirtualRows([], now, new Set(), {
      groupByDate: false,
      groupByQueue: true,
      queueOrder: QUEUE_ORDER,
      queueLabels: QUEUE_LABELS,
      resolveQueue: () => ({ primarySlug: null, isUrgent: false }),
    });
    const headers = rows.filter((r) => r.type === 'queue-header');
    expect(headers.map((h) => (h.type === 'queue-header' ? h.slug : null))).toEqual(QUEUE_ORDER);
  });

  it('sorts urgent then starred then recency within a section', () => {
    const threads = [
      thread('plain', '2026-04-12T10:00:00.000Z'),
      thread('starred', '2026-04-13T11:00:00.000Z', { starred: true }),
      thread('urgent', '2026-04-11T10:00:00.000Z'),
    ];
    const rows = buildMailListVirtualRows(threads, now, new Set(), {
      groupByDate: false,
      groupByQueue: true,
      queueOrder: QUEUE_ORDER,
      queueLabels: QUEUE_LABELS,
      resolveQueue: (message) => ({
        primarySlug: 'new-bookings',
        isUrgent: message.id === 'urgent',
      }),
    });
    const nbSection = rows.filter(
      (r) =>
        r.type === 'thread' ||
        (r.type === 'queue-header' && r.slug === 'new-bookings') ||
        (r.type === 'queue-header' && r.slug === 'groups-events'),
    );
    const threadIds = nbSection
      .filter((r) => r.type === 'thread')
      .map((r) => (r.type === 'thread' ? r.message.id : ''));
    expect(threadIds).toEqual(['urgent', 'starred', 'plain']);
  });

  it('falls back unknown primary to ops', () => {
    const rows = buildMailListVirtualRows([thread('orphan', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: false,
      groupByQueue: true,
      queueOrder: QUEUE_ORDER,
      queueLabels: QUEUE_LABELS,
      resolveQueue: () => ({ primarySlug: null, isUrgent: false }),
    });
    const opsHeaderIndex = rows.findIndex((r) => r.type === 'queue-header' && r.slug === 'ops');
    const orphanIndex = rows.findIndex((r) => r.type === 'thread' && r.message.id === 'orphan');
    expect(opsHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(orphanIndex).toBeGreaterThan(opsHeaderIndex);
  });

  it('keeps groupByDate path when groupByQueue false', () => {
    const rows = buildMailListVirtualRows([thread('a', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: true,
      groupByQueue: false,
    });
    expect(rows.map((r) => r.type)).toEqual(['header', 'thread']);
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('today');
  });
});
