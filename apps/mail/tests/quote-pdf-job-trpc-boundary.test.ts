import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests } from '../../server-pilot/src/db/client.js';
import { workstationRouter } from '../../server-pilot/src/trpc/routes/workstation.js';
import { router } from '../../server-pilot/src/trpc/trpc.js';

describe('quotePdfJob tRPC wire contract', () => {
  afterEach(() => __setDbForTests(null));

  it('returns the persisted job shape through a function-backed client and the workstation route', async () => {
    const artifact = {
      kind: 'quote_pdf' as const,
      revisionId: 'revision-wire',
      pdfHash: 'ab'.repeat(32),
      fileName: 'Quote - Example.pdf',
      totalMinor: 272000,
      pdfBase64: 'JVBERi0xLjQK',
    };
    const row = { id: 'pdf-job-wire', state: 'succeeded', readResult: artifact };
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    __setDbForTests({ db: { select } as never, conn: null as never });

    const activeTransportId = '00000000-0000-4000-8000-000000000031';
    const testRouter = router({ workstation: workstationRouter });
    const client = createTRPCClient<typeof testRouter>({
      links: [
        httpBatchLink({
          url: 'http://test/api/trpc',
          transformer: superjson,
          fetch: (input, init) =>
            fetchRequestHandler({
              endpoint: '/api/trpc',
              req: new Request(input, init),
              router: testRouter,
              createContext: ({ req }) =>
                ({
                  auth: {} as never,
                  reqHeaders: req.headers,
                  sessionUser: { id: 'staff-wire', email: 'staff@example.invalid', name: 'Staff' },
                  activeTransportId,
                  transportEmail: 'mailbox@example.invalid',
                  accessRole: 'member',
                }) as never,
            }),
        }),
      ],
    });

    await expect(
      client.workstation.quotePdfJob.query({
        workItemId: '00000000-0000-4000-8000-000000000041',
        revisionRef: 'revision-wire',
        attention: '',
        company: '',
        clientEmail: '',
        clientTelephone: '',
        agency: 'Example Agency',
      }),
    ).resolves.toEqual({ runId: 'pdf-job-wire', state: 'succeeded', result: artifact });
    expect(select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
  });
});
