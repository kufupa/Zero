import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { staffQuoteCauseSummary } from '../../server-pilot/src/ai/staff-quote-run.js';
import { publicProcedure, router } from '../../server-pilot/src/trpc/trpc.js';

describe('staff quote alternatives across the tRPC boundary', () => {
  it('returns checked alternatives in typed error data to a real tRPC client', async () => {
    const staffMessage = 'Verify combined availability for the requested rooms and dates.';
    const alternatives = [
      { groupId: 'r_1', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 2 },
    ];
    const cause = staffQuoteCauseSummary({
      code: 'native_quote_insufficient_inventory',
      message: 'Only 1 Standard King free for these dates.',
      detail: {
        alternatives: [
          ...alternatives,
          { groupId: 'r_1', roomCode: 'BAD<CODE', roomLabel: '<script>unsafe</script>', quantity: 2 },
        ],
      },
    });
    const testRouter = router({
      executeStaffQuote: publicProcedure.mutation(() => {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: staffMessage,
          cause,
        });
      }),
    });
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
              createContext: ({ req }) => ({ auth: {} as never, reqHeaders: req.headers }),
            }),
        }),
      ],
    });

    await expect(client.executeStaffQuote.mutate(undefined)).rejects.toMatchObject({
      message: staffMessage,
      data: { alternatives },
    });
  });

  it('filters malformed alternatives on a marked refusal before sending error data', async () => {
    const staffMessage = 'Verify combined availability for the requested rooms and dates.';
    const alternatives = [
      { groupId: 'r_1', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 2 },
    ];
    const testRouter = router({
      executeStaffQuote: publicProcedure.mutation(() => {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: staffMessage,
          cause: {
            name: 'Error',
            code: 'native_quote_insufficient_inventory',
            message: 'unsafe internal error details',
            staffQuoteRefusal: true,
            alternatives: [
              ...alternatives,
              { groupId: 'r_1', roomCode: 'BAD<CODE', roomLabel: '<script>unsafe</script>', quantity: 2 },
            ],
          },
        });
      }),
    });
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
              createContext: ({ req }) => ({ auth: {} as never, reqHeaders: req.headers }),
            }),
        }),
      ],
    });

    const error = await client.executeStaffQuote.mutate(undefined).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: staffMessage });
    expect(error).toHaveProperty('data.alternatives', alternatives);
  });
});
