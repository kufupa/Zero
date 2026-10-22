import { z } from 'zod';
import { router as tRouter, privateProcedure } from '../trpc.js';
import type { PilotCapabilities } from '../../lib/driver/types.js';
import { isCatchupUploadEnabled } from '../../env.js';
import { paneWriteModes } from '../../ai/pane-stay-save.js';

export const pilotCapabilities = {
  ai: false,
  brain: false,
  notes: false,
  templates: false,
  bimi: false,
  gmailSearchGrammar: true,
  hotelCategories: true,
  staleDraftWarning: true,
  catchupUpload: false,
  paneSave: false,
  paneSaveMode: 'off',
  paneWrite: {
    create: 'off',
    amendUnpaid: 'off',
    amendPaid: 'off',
    cancelUnpaid: 'off',
    cancelPaid: 'off',
  },
} satisfies PilotCapabilities;

export function getPilotCapabilities(): PilotCapabilities {
  const paneWrite = paneWriteModes();
  return {
    ...pilotCapabilities,
    catchupUpload: isCatchupUploadEnabled(),
    paneWrite,
    paneSave: paneWrite.create !== 'off',
    paneSaveMode: paneWrite.create,
  };
}

export const brainRouter = tRouter({
  getCapabilities: privateProcedure.query(() => getPilotCapabilities()),
  generateSummary: privateProcedure
    .input(z.object({ threadId: z.string().optional() }).optional())
    .query(() => null),
  getState: privateProcedure.query(() => ({ enabled: false, summary: null })),
  getPrompts: privateProcedure.query(() => []),
  updatePrompt: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ updated: false, disabled: true })),
});
