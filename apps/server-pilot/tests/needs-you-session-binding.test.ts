import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
  dismiss: vi.fn(async () => ({ status: 'dismissed' })),
}));

vi.mock('../src/db/client.js', async (original) => ({ ...(await original()), getDb: mocks.getDb }));
vi.mock('../src/ai/work-items.js', async (original) => ({ ...(await original()), dismissWorkItem: mocks.dismiss }));

import { privateProcedure, router } from '../src/trpc/trpc.js';
import { workItemsRouter } from '../src/trpc/routes/work-items.js';

const workItemId = '00000000-0000-4000-8000-000000000001';
const actor = { userId: 'staff-a', sessionId: 'session-a' };

function caller(sessionId: string, userId = 'staff-a') {
  return workItemsRouter.createCaller({
    auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: userId, email: 'staff@example.invalid', name: null, sessionId },
    activeTransportId: 'mailbox-a', accessRole: 'owner', transportEmail: 'mailbox@example.invalid',
  } as never);
}

beforeEach(() => { mocks.getDb.mockClear(); mocks.dismiss.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe('deferred Needs-you dismissal', () => {
  it('rejects a different user or session before accessing the database', async () => {
    for (const changed of [caller('session-b'), caller('session-a', 'staff-b')]) {
      await expect(changed.dismiss({ workItemId, expectedActor: actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('allows the original session in the pinned mailbox', async () => {
    await expect(caller('session-a').dismiss({ workItemId, expectedActor: actor }))
      .resolves.toEqual({ status: 'dismissed' });
    expect(mocks.dismiss).toHaveBeenCalledWith(expect.anything(), {
      transportId: 'mailbox-a', workItemId, userId: 'staff-a',
    });
  });

  it('carries the server-verified session ID and profile without the token', async () => {
    vi.stubEnv('NAVA_AUTH_SESSION_PROFILE', 'remote');
    const probe = router({ identity: privateProcedure.query(({ ctx }) => ctx.sessionUser) });
    const auth = { api: { getSession: vi.fn(async () => ({
      user: { id: 'staff-a', email: 'staff@example.invalid', name: 'Staff' },
      session: { id: 'session-a', token: 'never-export-this' },
    })) } };
    const result = await probe.createCaller({ auth: auth as never, reqHeaders: new Headers() }).identity();
    expect(result).toEqual({ id: 'staff-a', email: 'staff@example.invalid', name: 'Staff',
      sessionId: 'session-a', sessionProfile: 'remote' });
    expect(result).not.toHaveProperty('token');
  });
});
