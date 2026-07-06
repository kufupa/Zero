import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';

export const aiRouter = tRouter({
  generateSearchQuery: privateProcedure
    .input(z.object({ prompt: z.string().optional() }).optional())
    .query(() => ({ query: '', disabled: true })),

  webSearch: privateProcedure
    .input(z.object({ query: z.string().optional() }).optional())
    .query(() => ({ results: [], disabled: true })),

  compose: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ text: '', disabled: true })),

  generateEmailSubject: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ subject: '', disabled: true })),
});
