import { __setDbForTests, type DB } from '../src/db/client.js';
import { outlookSyncRouter } from '../src/trpc/routes/outlook-sync.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

function caller(getSession: () => Promise<unknown>) {
  return outlookSyncRouter.createCaller({
    auth: { api: { getSession } } as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'staff', email: 'staff@example.test', name: 'Staff' },
    activeTransportId: 'transport',
    transportEmail: 'hotel@example.test',
    accessRole: 'member',
  } as never);
}

function transactionDb(): DB {
  const db = {} as DB;
  Object.assign(db, {
    transaction: async (callback: (tx: DB) => Promise<unknown>) => callback(db),
  });
  return db;
}

afterEach(() => {
  __setDbForTests(null);
  vi.unstubAllEnvs();
});

describe('Outlook active-mailbox status auth profile', () => {
  it('returns not applicable for the remote session profile', async () => {
    vi.stubEnv('NAVA_AUTH_SESSION_PROFILE', 'remote');
    const getSession = vi.fn(async () => null);
    __setDbForTests({ db: transactionDb(), conn: null as never });

    await expect(caller(getSession).statusForActiveMailbox({})).resolves.toEqual({
      state: 'not_applicable',
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('keeps genuine legacy-session denials forbidden', async () => {
    vi.stubEnv('NAVA_AUTH_SESSION_PROFILE', 'legacy');
    const getSession = vi.fn(async () => null);
    __setDbForTests({ db: transactionDb(), conn: null as never });

    await expect(caller(getSession).statusForActiveMailbox({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
