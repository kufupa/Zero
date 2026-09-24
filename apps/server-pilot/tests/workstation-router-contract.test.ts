import { workstationPingInput } from '../src/trpc/routes/workstation.js';
import { appRouter } from '../src/trpc/router.js';
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';

function sessionCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
  } as never);
}

function anonymousCaller() {
  return appRouter.createCaller({
    auth: {
      api: {
        getSession: async () => null,
      },
    },
    reqHeaders: new Headers(),
  } as never);
}

describe('Workstation tRPC Router Contract', () => {
  it('does not invent an Outlook product version when the caller omits it', () => {
    expect(workstationPingInput.parse({}).outlookVersion).toBe('unknown');
  });

  it('responds to workstation.ping with server timestamp and ok status', async () => {
    const res = await sessionCaller().workstation.ping({
      workstationUser: 'ropperman',
      outlookEmail: 'ropperman@legacyhotels.co.za',
      outlookVersion: '16.0',
    });

    expect(res.status).toBe('ok');
    expect(res.receivedEmail).toBe('ropperman@legacyhotels.co.za');
    expect(typeof res.serverTime).toBe('string');
  });

  it('rejects ping without a session', async () => {
    await expect(anonymousCaller().workstation.ping({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>);
  });
});
