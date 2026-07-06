import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

const disabled = () => {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'TEMPLATES_DISABLED_FOR_PILOT',
  });
};

export const templatesRouter = tRouter({
  list: privateProcedure.query(() => []),
  create: privateProcedure.input(z.unknown()).mutation(disabled),
  delete: privateProcedure.input(z.unknown()).mutation(disabled),
});
