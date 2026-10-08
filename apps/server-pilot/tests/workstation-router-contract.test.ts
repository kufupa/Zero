import { workstationPingInput } from '../src/trpc/routes/workstation.js';
import { appRouter } from '../src/trpc/router.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { __setDbForTests } from '../src/db/client.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const quoteInput = {
  agency: 'CIDB',
  dateLabel: '15-17 Sep',
  lines: [{ dateLabel: '15-17 Sep', qty: 1, roomCode: 'STQN', meal: 'bb' as const, nights: 2, rate: 2150 }],
};

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
  it('logs native bridge refusals with EntryID-like tokens masked and rejects anonymous callers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const caller = appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
        sessionUser: { id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
        activeTransportId: 'transport-centurion', accessRole: 'member' } as never);
      await expect(caller.workstation.reportBridgeFailure({ action: 'GET_CAPABILITIES', code: 'NATIVE_DENIED',
        message: 'Observed folder 00000000AABBCCDDEEFF00112233445566778899 was not server-approved.' }))
        .resolves.toEqual({ logged: true });
      expect(warn).toHaveBeenCalledWith('outlook_bridge_native_failure', { transportId: 'transport-centurion',
        action: 'GET_CAPABILITIES', code: 'NATIVE_DENIED', message: 'Observed folder <id> was not server-approved.' });
      await expect(anonymousCaller().workstation.reportBridgeFailure({ action: 'PING', message: 'x' }))
        .rejects.toBeInstanceOf(TRPCError);
      await expect(caller.workstation.reportBridgeFailure({ action: 'get capabilities', message: 'x' }))
        .rejects.toBeInstanceOf(TRPCError);
    } finally { warn.mockRestore(); }
  });

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

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('workstation quote mailbox authorization (disposable DB)', () => {
  afterEach(() => {
    __setDbForTests(null);
    vi.unstubAllGlobals();
    delete process.env.GOTENBERG_URL;
  });

  it('lets provisioned staff quote from an approved shared mailbox despite different login email', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      process.env.GOTENBERG_URL = 'http://gotenberg.test';
      const fetchMock = vi.fn(async () => new Response(Buffer.from('%PDF-1.4 test'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await sessionCaller().workstation.quoteProposalPdf({
        ...quoteInput,
        outlookEmail: 'CENTURION@legacyhotels.co.za',
      });
      expect(result.fileName).toBe('Quote - CIDB 15-17 Sep.pdf');
      expect(Buffer.from(result.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 test');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects another transport even if the staff login email claims to match it', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers(),
        sessionUser: { id: 'user-ropperman', email: 'navaai@legacyhotels.co.za', name: 'R Opperman' },
      } as never);
      await expect(caller.workstation.quoteProposalPdf({
        ...quoteInput,
        outlookEmail: 'navaai@legacyhotels.co.za',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>);
    });
  });
});
