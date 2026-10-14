import { activateSource, activeTransportStatus, controlSource, sourceStatus } from '../../outlook-sync/service.js';
import { activateInput, controlInput } from '../../outlook-sync/contracts.js';
import { SyncDeniedError } from '../../outlook-sync/authorization.js';
import { mailboxProcedure, router } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

async function guarded<T>(callback: () => Promise<T>) {
  try {
    return await callback();
  } catch (error) {
    throw new TRPCError({
      code: error instanceof SyncDeniedError ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
      message:
        error instanceof SyncDeniedError ? 'Outlook sync denied' : 'Outlook sync unavailable',
    });
  }
}
export const outlookSyncRouter = router({
  activate: mailboxProcedure
    .input(activateInput)
    .mutation(({ ctx, input }) =>
      guarded(() =>
        activateSource(
          getDb(),
          ctx.auth,
          ctx.reqHeaders,
          ctx.activeTransportId,
          input,
          process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY ?? '',
        ),
      ),
    ),
  status: mailboxProcedure
    .input(z.object({ sourceId: z.string().min(1).max(512) }).strict())
    .query(({ ctx, input }) =>
      guarded(() =>
        sourceStatus(getDb(), ctx.auth, ctx.reqHeaders, ctx.activeTransportId, input.sourceId),
      ),
    ),
  statusForActiveMailbox: mailboxProcedure
    .input(z.object({}).strict())
    .query(({ ctx }) =>
      guarded(() => activeTransportStatus(getDb(), ctx.auth, ctx.reqHeaders, ctx.activeTransportId)),
    ),
  control: mailboxProcedure
    .input(controlInput)
    .mutation(({ ctx, input }) =>
      guarded(() => controlSource(getDb(), ctx.auth, ctx.reqHeaders, ctx.activeTransportId, input)),
    ),
});
