import { findParty } from '../../ai/pane-party-lookup.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

// Read-only. strict(): no native id, kind or other key reaches the module. One name searches companies and agencies;
// staff pick the candidate in the pane.
const findPartyInput = z
  .object({
    name: z.string().max(256),
  })
  .strict();

export const panePartyLookupRouter = router({
  findParty: mailboxProcedure.input(findPartyInput).mutation(async ({ input }) => findParty(input)),
});
