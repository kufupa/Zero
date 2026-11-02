import { describe, expect, it, vi } from 'vitest';
import {
  assertCreateDispatchFenceOwner,
  assertNoCreateDispatchFence,
  beginCreateDispatchFence,
  CreateFenceError,
  type CreateFenceBinding,
  type CreateFenceTransaction,
} from '../src/ai/pane-create-dispatch-fence.js';

const key = { transportId: 'hotel', workItemId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a235' };
const grantId = '7d9c2e1a-aeee-4d2d-b7b1-4930c19417ea';
const fenceId = '41597e10-a4de-44a3-af9c-cb7430ccc1a0';
const single: CreateFenceBinding = {
  version: 'pane-create-fence/v1', actorUserId: 'staff-1', grantId,
  scope: { kind: 'single', stayId: 'stay-1', requestDigest: 'a'.repeat(64) },
};
const batch: CreateFenceBinding = {
  version: 'pane-create-fence/v1', actorUserId: 'staff-1', grantId,
  scope: { kind: 'batch', manifestDigest: 'b'.repeat(64) },
};

type Row = { id: string; value: unknown };
function fakeTx(opts: { exists?: boolean; events?: Row[] } = {}) {
  const calls: string[] = [];
  const inserts: unknown[] = [];
  let selectNumber = 0;
  const tx = {
    select: vi.fn(() => {
      selectNumber += 1;
      if (selectNumber % 2 === 1) {
        return { from: () => ({ where: () => ({ limit: () => ({
          for: async (mode: string) => {
            calls.push(`lock:${mode}`);
            return opts.exists === false ? [] : [{ id: key.workItemId }];
          },
        }) }) }) };
      }
      return { from: () => ({ where: () => ({ limit: async () => {
        calls.push('read-fences');
        return opts.events ?? [];
      } }) }) };
    }),
    insert: vi.fn(() => ({ values: async (value: unknown) => { calls.push('insert'); inserts.push(value); } })),
  } as unknown as CreateFenceTransaction;
  return { tx, calls, inserts };
}

// These are mocked operation-order tests, not evidence of PostgreSQL locking.
describe('durable create dispatch fence', () => {
  it('locks the item, checks existing starts, then writes the single-scope binding', async () => {
    const fake = fakeTx();
    const result = await beginCreateDispatchFence(fake.tx, key, single);
    expect(fake.calls).toEqual(['lock:update', 'read-fences', 'insert']);
    expect(result).toEqual({ fenceId: expect.any(String), ...single });
    expect(fake.inserts).toEqual([expect.objectContaining({
      id: result.fenceId, workItemId: key.workItemId, actorKind: 'system', actorUserId: single.actorUserId,
      type: 'create.fence.started', value: single,
    })]);
  });

  it('stores a batch-wide manifest instead of a child-specific scope', async () => {
    const fake = fakeTx();
    const result = await beginCreateDispatchFence(fake.tx, key, batch);
    expect(result.scope).toEqual(batch.scope);
    expect(fake.inserts[0]).toMatchObject({ value: batch });
  });

  it('refuses a second start or an external mutation while any start is present, even malformed', async () => {
    const events = [{ id: fenceId, value: null }];
    const start = fakeTx({ events });
    await expect(beginCreateDispatchFence(start.tx, key, single)).rejects.toMatchObject({ reason: 'active' });
    expect(start.inserts).toHaveLength(0);
    await expect(assertNoCreateDispatchFence(fakeTx({ events }).tx, key)).rejects.toMatchObject({ reason: 'active' });
    await expect(assertNoCreateDispatchFence(fakeTx().tx, key)).resolves.toBeUndefined();
  });

  it('does not use time or lease expiry to release an unresolved fence', async () => {
    const events = [{ id: fenceId, value: { ...batch, expiresAt: '2000-01-01T00:00:00Z' } }];
    await expect(assertNoCreateDispatchFence(fakeTx({ events }).tx, key)).rejects.toMatchObject({ reason: 'active' });
  });

  it('requires an existing item and a valid server binding before creating a fence', async () => {
    const missing = fakeTx({ exists: false });
    await expect(beginCreateDispatchFence(missing.tx, key, single)).rejects.toMatchObject({ reason: 'not_found' });
    expect(missing.inserts).toHaveLength(0);
    const invalid = fakeTx();
    await expect(beginCreateDispatchFence(invalid.tx, key, { ...single, grantId: 'wrong' })).rejects.toMatchObject({ reason: 'invalid_binding' });
    expect(invalid.calls).toEqual([]);
    await expect(beginCreateDispatchFence(fakeTx().tx, key, { ...single, actorUserId: 'staff\n1' })).rejects.toMatchObject({ reason: 'invalid_binding' });
    await expect(beginCreateDispatchFence(fakeTx().tx, key, { ...single, actorUserId: 'staff\u007f1' })).rejects.toMatchObject({ reason: 'invalid_binding' });
  });

  it('requires exactly one matching fence, actor, grant and complete single scope', async () => {
    const events = [{ id: fenceId, value: single }];
    const identity = { fenceId, ...single };
    await expect(assertCreateDispatchFenceOwner(fakeTx({ events }).tx, key, identity)).resolves.toBeUndefined();
    for (const changed of [
      { ...identity, fenceId: grantId },
      { ...identity, actorUserId: 'staff-2' },
      { ...identity, grantId: fenceId },
      { ...identity, scope: { kind: 'single' as const, stayId: 'stay-2', requestDigest: 'a'.repeat(64) } },
      { ...identity, scope: { kind: 'single' as const, stayId: 'stay-1', requestDigest: 'c'.repeat(64) } },
    ]) {
      await expect(assertCreateDispatchFenceOwner(fakeTx({ events }).tx, key, changed)).rejects.toMatchObject({ reason: 'owner_mismatch' });
    }
    await expect(assertCreateDispatchFenceOwner(fakeTx({ events: [...events, events[0]!] }).tx, key, identity)).rejects.toBeInstanceOf(CreateFenceError);
    await expect(assertCreateDispatchFenceOwner(fakeTx({ events: [{ id: fenceId, value: null }] }).tx, key, identity)).rejects.toMatchObject({ reason: 'owner_mismatch' });
  });

  it('keeps batch ownership tied to its immutable manifest', async () => {
    const events = [{ id: fenceId, value: batch }];
    await expect(assertCreateDispatchFenceOwner(fakeTx({ events }).tx, key, { fenceId, ...batch })).resolves.toBeUndefined();
    await expect(assertCreateDispatchFenceOwner(fakeTx({ events }).tx, key, {
      fenceId, ...batch, scope: { kind: 'batch', manifestDigest: 'c'.repeat(64) },
    })).rejects.toMatchObject({ reason: 'owner_mismatch' });
  });
});
