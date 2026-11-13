import { expect, it } from 'vitest';
import { ensureWorkItem } from '../src/ai/work-items.js';
import type { DB } from '../src/db/client.js';

it('invalidates stale edits once when an extraction is relinked', async () => {
  const item = { id: 'item', status: 'needs_you', state: { 'contact.company': 'Saved' },
    extractionId: 'old', revision: 2, revisionHead: 3, revisionSeq: 7 };
  const reads = [{ id: 'old', createdAt: new Date('2026-01-01'), payload: null },
    { id: 'new', createdAt: new Date('2026-01-02'), payload: null }];
  const query = (rows: unknown[]) => {
    const q = Object.assign(Promise.resolve(rows), { from: () => q, where: () => q, orderBy: () => q,
      limit: () => q, for: async () => rows });
    return q;
  };
  let selected = 0;
  const insert = () => ({ values: () => ({ onConflictDoNothing: async () => {} }) });
  const tx = { execute: async () => {}, insert, select: () => {
    const index = selected++; return query(index === 0 ? [] : index === 1 ? [{ ...item }] : reads);
  },
    update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => Object.assign(item, value) }) }) };
  const db = { transaction: (fn: (transaction: unknown) => unknown) => { selected = 0; return fn(tx); } } as unknown as DB;
  const input = { transportId: 'hotel', threadId: 'thread', messageId: 'message',
    kind: 'booking' as const, extractionId: 'new' };

  expect(await ensureWorkItem(db, input)).toMatchObject({ extractionId: 'new', revisionSeq: 8,
    revision: 2, revisionHead: 3, state: { 'contact.company': 'Saved' } });
  expect(await ensureWorkItem(db, input)).toMatchObject({ extractionId: 'new', revisionSeq: 8 });
});
