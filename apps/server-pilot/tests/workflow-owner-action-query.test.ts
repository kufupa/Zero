import { describe, expect, it, vi } from 'vitest';
import { __setDbForTests } from '../src/db/client.js';
import { mailActionLabel } from '../src/db/schema/mail.js';
import { workflowFoldersRouter } from '../src/trpc/routes/workflow-folders.js';

const TRANSPORT_ID = 'transport-centurion';
const MESSAGE_ID = 'message-source-1';

function caller(accessRole: 'owner' | 'admin' | 'member' = 'owner') {
  return workflowFoldersRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'user-owner', email: 'owner@example.com', name: 'Owner' },
    activeTransportId: TRANSPORT_ID,
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole,
  } as never);
}

function fakeLabelDb(action: string | null) {
  const reads: unknown[] = [];
  const insert = vi.fn();
  const db = {
    select: () => {
      const query = {
        table: undefined as unknown,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        where() {
          return query;
        },
        async limit() {
          reads.push(query.table);
          return query.table === mailActionLabel && action ? [{ action }] : [];
        },
      };
      return query;
    },
    insert,
  };
  return { db, reads, insert };
}

async function withFakeDb<T>(db: unknown, run: () => Promise<T>): Promise<T> {
  __setDbForTests({ db: db as never, conn: {} as never });
  try {
    return await run();
  } finally {
    __setDbForTests(null);
  }
}

function getOwnerActionLabel(accessRole: 'owner' | 'admin' | 'member' = 'owner') {
  return (
    caller(accessRole) as unknown as {
      getOwnerActionLabel?: (input: unknown) => Promise<unknown>;
    }
  ).getOwnerActionLabel;
}

describe('workflowFolders.getOwnerActionLabel', () => {
  it('forbids member access before reading owner labels', async () => {
    const query = getOwnerActionLabel('member');
    expect(query).toBeTypeOf('function');
    if (!query) throw new Error('getOwnerActionLabel query is missing');
    const fake = fakeLabelDb('cancel');

    await expect(
      withFakeDb(fake.db, () => query({ messageId: MESSAGE_ID })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.reads).toHaveLength(0);
  });

  it('returns the active mailbox message owner action without writing', async () => {
    const query = getOwnerActionLabel();
    expect(query).toBeTypeOf('function');
    if (!query) throw new Error('getOwnerActionLabel query is missing');
    const fake = fakeLabelDb('cancel');

    const result = await withFakeDb(fake.db, () => query({ messageId: MESSAGE_ID }));

    expect(result).toBe('cancel');
    expect(fake.reads).toEqual([mailActionLabel]);
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it('returns null when no owner action exists', async () => {
    const query = getOwnerActionLabel();
    expect(query).toBeTypeOf('function');
    if (!query) throw new Error('getOwnerActionLabel query is missing');
    const fake = fakeLabelDb(null);

    const result = await withFakeDb(fake.db, () => query({ messageId: MESSAGE_ID }));

    expect(result).toBeNull();
  });
});

it('waits for the selected message lock before inserting an owner action', async () => {
  let acquired!: () => void;
  let unlock!: () => void;
  const entered = new Promise<void>((resolve) => { acquired = resolve; });
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const insert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => ({
    returning: async () => [{ action: 'cancel', markedAt: new Date('2026-01-01T00:00:00Z') }],
  }) }) }));
  const tx = {
    select: () => {
      const query = { from: () => query, where: () => query, limit: () => query,
        for: async (mode: string) => {
          expect(mode).toBe('no key update');
          acquired();
          await held;
          return [{ id: MESSAGE_ID }];
        } };
      return query;
    },
    insert,
  };
  const db = { transaction: (fn: (value: typeof tx) => unknown) => fn(tx) };
  const write = withFakeDb(db, () => caller().setActionLabel({ messageId: MESSAGE_ID, action: 'cancel' }));
  await entered;
  expect(insert).not.toHaveBeenCalled();
  unlock();
  await expect(write).resolves.toEqual({ action: 'cancel', markedAt: '2026-01-01T00:00:00.000Z' });
  expect(insert).toHaveBeenCalledOnce();
});
