/**
 * User router — pilot stubs for the frontend's `user.delete` and
 * `user.getIntercomToken` calls. `getIntercomToken` returns null (no Intercom
 * in pilot). `delete` is a hard guardrail: refuses to delete the caller's
 * account to avoid accidental data loss during pilot; a later task may wire a
 * real delete-with-confirmation flow.
 */
import { TRPCError } from '@trpc/server';
import { privateProcedure, router as tRouter } from '../trpc.js';

export const userRouter = tRouter({
  getIntercomToken: privateProcedure.query(async () => {
    return { token: null as string | null };
  }),

  delete: privateProcedure.mutation(async () => {
    // Pilot guardrail: refuse account self-delete. The frontend danger-zone
    // page surfaces this as an error message; a real delete flow is deferred
    // to a later task with proper confirmation + data export.
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'account self-delete is disabled in pilot',
    });
  }),
});
