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
