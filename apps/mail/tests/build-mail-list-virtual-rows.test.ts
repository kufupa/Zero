import { describe, expect, it } from 'vitest';
import { buildMailListVirtualRows } from '../lib/mail/build-mail-list-virtual-rows';
import type { ParsedMessage } from '@/types';

function thread(id: string, receivedOn: string, starred = false): ParsedMessage {
  return {
    id,
    title: '',
    subject: '',
    tags: starred ? [{ id: 's', name: 'STARRED' }] : [],
    sender: { email: 'a@b.c' },
    to: [],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn,
    unread: false,
    body: '',
    processedHtml: '',
    blobUrl: '',
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
      [thread('old', '2026-01-01T10:00:00.000Z', true), thread('today', '2026-04-13T10:00:00.000Z')],
      now,
      new Set(),
      { groupByDate: true },
    );
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('pinned');
    expect(rows[1].type === 'thread' && rows[1].message.id).toBe('old');
    expect(rows.some((r) => r.type === 'thread' && r.message.id === 'today')).toBe(true);
  });

  it('does not duplicate starred thread in a date bucket', () => {
    const rows = buildMailListVirtualRows([thread('x', '2026-04-13T10:00:00.000Z', true)], now, new Set(), {
      groupByDate: true,
    });
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
});
