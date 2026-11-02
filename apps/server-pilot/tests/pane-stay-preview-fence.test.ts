import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { createWorkItemPreviewPersist, recordStayPreview, takeStayPreview } from '../src/ai/pane-stay-preview-persist.js';

const key = { transportId: 'hotel', workItemId: 'work-1', stayId: 'stay-1' };
const record = { digest: 'a'.repeat(64), status: 'previewed' as const, expiresAt: 200 };

function fakeDb(events: unknown[], exists = true) {
  const calls: string[] = [];
  let reads = 0;
  const tx = {
    select: vi.fn(() => {
      const read = reads++;
      return { from: () => ({ where: () => ({ limit: () => {
        if (read === 2) {
          calls.push('fences');
          return Promise.resolve(events);
        }
        return { for: async () => {
          calls.push('lock');
          if (!exists) return [];
          return read === 0 ? [{ state: { stayPreviews: { 'stay-1': record } } }] : [{ id: key.workItemId }];
        } };
      } }) }) };
    }),
    update: vi.fn(() => ({ set: () => ({ where: async () => { calls.push('update'); } }) })),
  };
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB;
  return { db, calls, tx };
}

// Mocked ordering only; these tests do not prove PostgreSQL concurrency or locking.
describe('bound stay previews during create dispatch', () => {
  it('refuses recording or taking when a fence exists, including malformed events', async () => {
    for (const operation of ['record', 'take'] as const) {
      const fake = fakeDb([{ id: 'fence', value: null }]);
      const result = operation === 'record'
        ? recordStayPreview(fake.db, { ...key, record })
        : takeStayPreview(fake.db, { ...key, digest: record.digest, now: 100 });
      await expect(result).rejects.toMatchObject({ reason: 'active' });
      expect(fake.calls).toEqual(['lock', 'lock', 'fences']);
      expect(fake.tx.update).not.toHaveBeenCalled();
    }
  });

  it('permits bound preview writes only after the locked fence check passes', async () => {
    const recordDb = fakeDb([]);
    await expect(recordStayPreview(recordDb.db, { ...key, record })).resolves.toEqual({ status: 'recorded' });
    expect(recordDb.calls).toEqual(['lock', 'lock', 'fences', 'update']);
    const takeDb = fakeDb([]);
    await expect(takeStayPreview(takeDb.db, { ...key, digest: record.digest, now: 100 })).resolves.toBe(true);
    expect(takeDb.calls).toEqual(['lock', 'lock', 'fences', 'update']);
  });

  it('does not report a durable preview when its bound work item is missing', async () => {
    const fake = fakeDb([], false);
    const persist = createWorkItemPreviewPersist(fake.db, key.transportId, 100);
    await expect(persist.record({
      workItemId: key.workItemId, stayId: key.stayId, digest: record.digest, now: 100,
    })).rejects.toThrow('stay_preview_not_recorded');
    expect(fake.tx.update).not.toHaveBeenCalled();
  });

  it('does not read fences or mutate when the work item is absent', async () => {
    const fake = fakeDb([], false);
    await expect(recordStayPreview(fake.db, { ...key, record })).resolves.toEqual({ status: 'not_found' });
    expect(fake.calls).toEqual(['lock']);
    expect(fake.tx.update).not.toHaveBeenCalled();
  });
});
