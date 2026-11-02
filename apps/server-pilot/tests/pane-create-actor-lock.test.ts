import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertCreateDispatchFenceOwner, type CreateFenceTransaction } from '../src/ai/pane-create-dispatch-fence.js';
import { withLockedCreateActor } from '../src/ai/pane-create-actor-lock.js';

vi.mock('../src/ai/pane-create-dispatch-fence.js', async (original) => ({
  ...await original<typeof import('../src/ai/pane-create-dispatch-fence.js')>(),
  assertCreateDispatchFenceOwner: vi.fn(async () => {}),
}));

function fixture() {
  const input = { transportId: 'transport-1', workItemId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a235', accessId: 'access-1',
    fence: { version: 'pane-create-fence/v1' as const, actorUserId: 'actor-1',
      grantId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a236', fenceId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a237',
      scope: { kind: 'batch' as const, manifestDigest: 'a'.repeat(64) } } };
  const transport = { id: input.transportId, isActive: true };
  const access = { id: input.accessId, userId: input.fence.actorUserId, transportId: input.transportId };
  const calls: string[] = [];
  const predicates: Array<ReturnType<PgDialect['sqlToQuery']>> = [];
  const dialect = new PgDialect();
  let count = 0;
  const tx = { select: () => {
    count += 1;
    const current = count;
    return { from: () => ({ where: (condition: SQL) => {
      predicates.push(dialect.sqlToQuery(condition));
      return { limit: () => ({ for: async (mode: string) => {
        calls.push(`${current === 1 ? 'transport' : 'access'}:${mode}`);
        return [current === 1 ? transport : access];
      } }) };
    } }) };
  } } as unknown as CreateFenceTransaction;
  return { input, transport, access, tx, calls, predicates };
}
beforeEach(() => vi.clearAllMocks());

// Mocked SQL proves invocation and binding only, not PostgreSQL concurrency.
describe('locked create actor seam', () => {
  it('revalidates the fence and locks exact access before awaiting the database continuation', async () => {
    const f = fixture();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const result = withLockedCreateActor(f.tx, f.input, async () => {
      f.calls.push('continue'); started(); await pending; f.calls.push('settled'); return 'ok';
    });
    await entered;
    expect(assertCreateDispatchFenceOwner).toHaveBeenCalledWith(f.tx,
      { transportId: f.input.transportId, workItemId: f.input.workItemId }, f.input.fence);
    expect(f.calls).toEqual(['transport:share', 'access:share', 'continue']);
    expect(f.predicates[0]?.params).toEqual(['transport-1', true]);
    expect(f.predicates[1]?.params).toEqual(['access-1', 'actor-1', 'transport-1']);
    release();
    await expect(result).resolves.toBe('ok');
    expect(f.calls.at(-1)).toBe('settled');
  });

  it('refuses an invalid persisted fence before locking access or continuing', async () => {
    const f = fixture(); const continuation = vi.fn();
    vi.mocked(assertCreateDispatchFenceOwner).mockRejectedValueOnce(new Error('create_fence_owner_mismatch'));
    await expect(withLockedCreateActor(f.tx, f.input, continuation)).rejects.toThrow('create_fence_owner_mismatch');
    expect(f.calls).toEqual([]);
    expect(continuation).not.toHaveBeenCalled();
  });

  it('refuses inactive or mismatched transports', async () => {
    for (const patch of [{ isActive: false }, { id: 'other' }]) {
      const f = fixture(); Object.assign(f.transport, patch);
      const continuation = vi.fn();
      await expect(withLockedCreateActor(f.tx, f.input, continuation)).rejects.toThrow('create_actor_unavailable');
      expect(f.calls).toEqual(['transport:share']);
      expect(continuation).not.toHaveBeenCalled();
    }
  });

  it('refuses a different access row, actor or transport', async () => {
    for (const patch of [{ id: 'other' }, { userId: 'other' }, { transportId: 'other' }]) {
      const f = fixture(); Object.assign(f.access, patch);
      const continuation = vi.fn();
      await expect(withLockedCreateActor(f.tx, f.input, continuation)).rejects.toThrow('create_actor_unavailable');
      expect(continuation).not.toHaveBeenCalled();
    }
  });

  it('snapshots the caller binding before asynchronous checks', async () => {
    const f = fixture();
    const result = withLockedCreateActor(f.tx, f.input, async () => 'ok');
    f.input.fence.actorUserId = 'other'; f.input.accessId = 'other';
    await expect(result).resolves.toBe('ok');
    expect(f.predicates[1]?.params).toEqual(['access-1', 'actor-1', 'transport-1']);
  });

  it('rejects malformed bindings and propagates continuation failures', async () => {
    const f = fixture(); const continuation = vi.fn();
    await expect(withLockedCreateActor(f.tx, { ...f.input, accessId: ' ' }, continuation)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(continuation).not.toHaveBeenCalled();
    await expect(withLockedCreateActor(f.tx, f.input, async () => { throw new Error('continuation failed'); }))
      .rejects.toThrow('continuation failed');
  });
});
