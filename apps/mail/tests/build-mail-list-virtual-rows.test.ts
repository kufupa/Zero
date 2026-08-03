import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMailListVirtualRows } from '../lib/mail/build-mail-list-virtual-rows';
import type { MailListThreadRow } from '@/types';

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

  it('preserves newest-first within a date bucket; urgent does not jump ahead', () => {
    const threads = [
      thread('newer', '2026-04-13T11:00:00.000Z'),
      thread('older-urgent', '2026-04-13T09:00:00.000Z'),
    ];
    const rows = buildMailListVirtualRows(threads, now, new Set(), { groupByDate: true });
    const ids = rows
      .filter((r) => r.type === 'thread')
      .map((r) => (r.type === 'thread' ? r.message.id : ''));
    expect(ids).toEqual(['newer', 'older-urgent']);
  });

  it('emits only header and thread row types', () => {
    const dateRows = buildMailListVirtualRows(
      [thread('a', '2026-04-13T10:00:00.000Z')],
      now,
      new Set(),
      { groupByDate: true },
    );
    const flatRows = buildMailListVirtualRows(
      [thread('a', '2026-04-13T10:00:00.000Z')],
      now,
      new Set(),
      { groupByDate: false },
    );
    expect(dateRows.every((r) => r.type === 'header' || r.type === 'thread')).toBe(true);
    expect(flatRows.every((r) => r.type === 'thread')).toBe(true);
  });
});

describe('mail-list inbox chrono contract', () => {
  const mailListSource = readFileSync(
    join(__dirname, '../components/mail/mail-list.tsx'),
    'utf8',
  );
  const builderSource = readFileSync(
    join(__dirname, '../lib/mail/build-mail-list-virtual-rows.ts'),
    'utf8',
  );

  it('mail-list does not enable groupByQueue', () => {
    expect(mailListSource).not.toMatch(/groupByQueue/);
    expect(mailListSource).not.toMatch(/queue-header/);
    expect(mailListSource).not.toMatch(/\bQueueSlug\b/);
  });

  it('virtual-row builder has no queue-grouping API', () => {
    expect(builderSource).not.toMatch(/groupByQueue/);
    expect(builderSource).not.toMatch(/queue-header/);
    expect(builderSource).not.toMatch(/export type QueueSlug/);
    expect(builderSource).not.toMatch(/buildQueueGroupedRows/);
    expect(builderSource).not.toMatch(/compareQueueThreads/);
  });
});
