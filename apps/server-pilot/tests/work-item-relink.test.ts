import { expect, it } from 'vitest';
import { ensureWorkItem } from '../src/ai/work-items.js';
import type { DB } from '../src/db/client.js';

it('invalidates stale edits once when an extraction is relinked', async () => {
  const item = { id: 'item', status: 'needs_you', state: { 'contact.company': 'Saved' },
    extractionId: 'old', revision: 2, revisionHead: 3, revisionSeq: 7 };
  const reads = [{ id: 'old', createdAt: new Date('2026-01-01'), payload: null },
    { id: 'new', createdAt: new Date('2026-01-02'), payload: null }];
  const query = (rows: unknown[]) => {
    const q = { from: () => q, where: () => q, limit: () => q, for: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return q;
  };
  let selected = 0;
  const tx = { select: () => query(selected++ === 0 ? [{ ...item }] : reads),
    update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => Object.assign(item, value) }) }) };
  const db = { insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => query([{ ...item }]), transaction: (fn: (transaction: unknown) => unknown) => fn(tx) } as unknown as DB;
  const input = { transportId: 'hotel', threadId: 'thread', messageId: 'message',
    kind: 'booking' as const, extractionId: 'new' };

  expect(await ensureWorkItem(db, input)).toMatchObject({ extractionId: 'new', revisionSeq: 8,
    revision: 2, revisionHead: 3, state: { 'contact.company': 'Saved' } });
  expect(await ensureWorkItem(db, input)).toMatchObject({ extractionId: 'new', revisionSeq: 8 });
});
