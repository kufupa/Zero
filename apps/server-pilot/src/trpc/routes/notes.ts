import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

const disabled = () => {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'NOTES_DISABLED_FOR_PILOT',
  });
};

export const notesRouter = tRouter({
  list: privateProcedure
    .input(z.object({ threadId: z.string().optional() }).optional())
    .query(() => []),
  create: privateProcedure.input(z.unknown()).mutation(disabled),
  update: privateProcedure.input(z.unknown()).mutation(disabled),
  delete: privateProcedure.input(z.unknown()).mutation(disabled),
  reorder: privateProcedure.input(z.unknown()).mutation(disabled),
});
