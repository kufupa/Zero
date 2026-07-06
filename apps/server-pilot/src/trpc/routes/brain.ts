import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';
import type { PilotCapabilities } from '../../lib/driver/types.js';

export const pilotCapabilities = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: false,
  hotelCategories: true,
  staleDraftWarning: true,
} satisfies PilotCapabilities;

export const brainRouter = tRouter({
  getCapabilities: privateProcedure.query(() => pilotCapabilities),
  generateSummary: privateProcedure
    .input(z.object({ threadId: z.string().optional() }).optional())
    .query(() => null),
  getState: privateProcedure.query(() => ({ enabled: false, summary: null })),
  getPrompts: privateProcedure.query(() => []),
  updatePrompt: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ updated: false, disabled: true })),
});
