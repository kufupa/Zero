import { findParty } from '../../ai/pane-party-lookup.js';
import { suggestPartiesFor } from '../../ai/party-aliases.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

// Read-only. strict(): no native id, kind or other key reaches the module. One name searches companies and agencies;
// staff pick the candidate in the pane.
const findPartyInput = z
  .object({
    name: z.string().max(256),
  })
  .strict();

const suggestInput = z.object({ sender: z.string().max(320), body: z.string().max(20000) }).strict();

export const panePartyLookupRouter = router({
  findParty: mailboxProcedure.input(findPartyInput).mutation(async ({ input }) => findParty(input)),
  // Read-only. Suggestions come from the sender's domain and the body's names; only HMS-listed ids are ever attached.
  suggest: mailboxProcedure.input(suggestInput).query(({ input }) => ({ suggestions: suggestPartiesFor(input) })),
});
