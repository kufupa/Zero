import { describe, expect, it, vi } from 'vitest';
import { listWorkItems } from '../src/ai/work-items.js';
import type { DB } from '../src/db/client.js';
import {
  collectNeedsYouPages,
  NEEDS_YOU_MAX_CANDIDATES,
  type NeedsYouCursor,
} from '../src/ai/work-items-list-pages.js';

type Row = { id: string; chipRank: number; sortAge: string; valid: boolean };

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index), chipRank: 0, sortAge: '2027-01-01 00:00:10.000001', valid: false,
  }));
}

function fetcher(source: Row[]) {
  return vi.fn(async (cursor: NeedsYouCursor | null, size: number) => {
    const start = cursor === null ? 0 : source.findIndex((row) => row.id === cursor.id) + 1;
    if (cursor !== null) {
      const previous = source[start - 1]!;
      expect(cursor).toEqual({ rank: previous.chipRank, age: previous.sortAge, id: previous.id });
    }
    return source.slice(start, start + size);
  });
}

const validate = (row: Row) => row.valid ? row.id : null;

describe('Needs You candidate paging', () => {
  it('requests one read-only repeatable-read transaction for all pages', async () => {
    const transaction = vi.fn(async () => []);
    const db = { transaction } as unknown as DB;
    expect(await listWorkItems(db, { transportId: 'mailbox', statuses: ['needs_you'], limit: 1 })).toEqual([]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read', accessMode: 'read only',
    });
  });

  it('skips invalid pages, carries exact cursor values and stops at the requested limit', async () => {
    const source = rows(103);
    source[99]!.valid = true;
    source[100]!.valid = true;
    source[100]!.sortAge = '2027-01-01 00:00:10.000002';
    source[101]!.valid = true;
    source[101]!.sortAge = '2027-01-01 00:00:10.000002';
    const fetchPage = fetcher(source);
    expect(await collectNeedsYouPages({ limit: 2, fetchPage, validate })).toEqual(['99', '100']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenLastCalledWith({
      rank: 0, age: '2027-01-01 00:00:10.000001', id: '99',
    }, 50);
  });

  it('returns fewer rows only on exhaustion and does not fetch for an empty limit', async () => {
    const source = rows(51);
    source[50]!.valid = true;
    source[50]!.chipRank = 1;
    const fetchPage = fetcher(source);
    expect(await collectNeedsYouPages({ limit: 10, fetchPage, validate })).toEqual(['50']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const empty = fetcher([]);
    expect(await collectNeedsYouPages({ limit: 0, fetchPage: empty, validate })).toEqual([]);
    expect(empty).not.toHaveBeenCalled();
    expect(await collectNeedsYouPages({ limit: 2, fetchPage: empty, validate })).toEqual([]);
  });

  it('honours the maximum output and page size', async () => {
    const source = rows(201).map((row) => ({ ...row, valid: true }));
    const fetchPage = fetcher(source);
    expect(await collectNeedsYouPages({ limit: 200, fetchPage, validate })).toHaveLength(200);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(null, 200);
    await expect(collectNeedsYouPages({ limit: 201, fetchPage, validate })).rejects.toThrow(RangeError);
  });

  it('fails visibly at the scan cap rather than silently dropping later tasks', async () => {
    const source = rows(NEEDS_YOU_MAX_CANDIDATES + 1);
    source[0]!.valid = true;
    source[NEEDS_YOU_MAX_CANDIDATES]!.valid = true;
    const fetchPage = fetcher(source);
    await expect(collectNeedsYouPages({ limit: 2, fetchPage, validate }))
      .rejects.toThrow('Could not load the complete Needs You list');
    expect(fetchPage.mock.calls.reduce((sum, [, size]) => sum + size, 0)).toBe(NEEDS_YOU_MAX_CANDIDATES + 1);
  });

  it('accepts exhaustion exactly at the scan cap after a single probe', async () => {
    const fetchPage = fetcher(rows(NEEDS_YOU_MAX_CANDIDATES));
    expect(await collectNeedsYouPages({ limit: 1, fetchPage, validate })).toEqual([]);
    expect(fetchPage).toHaveBeenLastCalledWith(expect.any(Object), 1);
  });
});
