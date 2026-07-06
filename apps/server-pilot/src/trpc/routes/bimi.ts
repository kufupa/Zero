import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

export const bimiRouter = tRouter({
  getByEmail: privateProcedure
    .input(z.object({ email: z.string().email() }))
    .query(() => null),
});
