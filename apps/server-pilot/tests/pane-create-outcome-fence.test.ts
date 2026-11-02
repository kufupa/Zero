import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { recordStayActionResult, recordStayCommit } from '../src/ai/work-items.js';
import type { CreateFenceIdentity } from '../src/ai/pane-create-dispatch-fence.js';

const key = { transportId: 'hotel', workItemId: 'work-1', stayId: 'stay-1' };
const record = { confirmationNumber: '123456-1', status: 'booked' as const, screenshotRef: null };
const identity: CreateFenceIdentity = {
  version: 'pane-create-fence/v1', actorUserId: 'staff', grantId: '11111111-1111-4111-8111-111111111111',
  fenceId: '22222222-2222-4222-8222-222222222222',
  scope: { kind: 'single', stayId: key.stayId, requestDigest: 'a'.repeat(64) },
};
const { fenceId, ...stored } = identity;
const start = { id: fenceId, value: stored };

function fakeDb(events: unknown[], state: Record<string, unknown> = {}) {
  const operations: string[] = [];
  let reads = 0;
  const tx = {
    select: vi.fn(() => {
      const read = reads++;
      return { from: () => ({ where: () => ({ limit: () => {
        if (read === 2) { operations.push('fences'); return Promise.resolve(events); }
        return { for: async () => { operations.push('lock'); return read === 0 ? [{ state }] : [{ id: key.workItemId }]; } };
      } }) }) };
    }),
    update: vi.fn(() => ({ set: () => ({ where: async () => { operations.push('update'); } }) })),
  };
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB;
  return { db, operations, update: tx.update };
}

// Operation ordering is mocked; this does not prove actual PostgreSQL concurrency.
describe('create outcome fence ownership', () => {
  it('permits an unfenced outcome only after checking under the item lock', async () => {
    const fake = fakeDb([]);
    await expect(recordStayCommit(fake.db, { ...key, record })).resolves.toEqual({ status: 'recorded' });
    expect(fake.operations).toEqual(['lock', 'lock', 'fences', 'update']);
  });

  it('refuses an external outcome while a create fence exists', async () => {
    const fake = fakeDb([start]);
    await expect(recordStayCommit(fake.db, { ...key, record })).rejects.toMatchObject({ reason: 'active' });
    expect(fake.operations).toEqual(['lock', 'lock', 'fences']);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('permits the exact single-stay fence owner to record its result without releasing the fence', async () => {
    const fake = fakeDb([start]);
    await expect(recordStayCommit(fake.db, { ...key, record, fence: identity })).resolves.toEqual({ status: 'recorded' });
    expect(fake.operations).toEqual(['lock', 'lock', 'fences', 'update']);
  });

  it('refuses missing, different, malformed and wrong-stay owner fences', async () => {
    for (const events of [[], [{ ...start, id: '33333333-3333-4333-8333-333333333333' }], [{ ...start, value: null }]]) {
      const fake = fakeDb(events);
      await expect(recordStayCommit(fake.db, { ...key, record, fence: identity })).rejects.toMatchObject({ reason: 'owner_mismatch' });
      expect(fake.update).not.toHaveBeenCalled();
    }
    const wrongStay = fakeDb([start]);
    await expect(recordStayCommit(wrongStay.db, { ...key, stayId: 'stay-2', record, fence: identity }))
      .rejects.toMatchObject({ reason: 'owner_mismatch' });
    expect(wrongStay.update).not.toHaveBeenCalled();
  });

  it('refuses batch owners until manifest child scope is verified', async () => {
    const batch: CreateFenceIdentity = { ...identity, scope: { kind: 'batch', manifestDigest: 'b'.repeat(64) } };
    const fake = fakeDb([{ id: fenceId, value: { ...stored, scope: batch.scope } }]);
    await expect(recordStayCommit(fake.db, { ...key, record, fence: batch })).rejects.toMatchObject({ reason: 'owner_mismatch' });
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('blocks an unrelated stay-action mutation while a create is fenced', async () => {
    const fake = fakeDb([start]);
    await expect(recordStayActionResult(fake.db, { ...key, confirmationNumber: '123456-1', screenshotRef: null }))
      .rejects.toMatchObject({ reason: 'active' });
    expect(fake.operations).toEqual(['lock', 'lock', 'fences']);
    expect(fake.update).not.toHaveBeenCalled();
  });
});
