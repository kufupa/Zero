import { findParty } from '../../ai/pane-party-lookup.js';
import { suggestPartiesFor } from '../../ai/party-aliases.js';
import { typeaheadPartyIndex } from '../../ai/party-index.js';
import { assertCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

// Read-only. strict(): no native id or other key reaches the module. One name searches companies and agencies, or one
// kind when given; staff pick the candidate in the pane.
// threadId is required for pane/thread searches so Da Vinci origin is refused before any HMS run.
// Omitted only for non-thread callers (tests, bindings with no mail) — not a pane compatibility skip.
const findPartyInput = z
  .object({
    name: z.string().max(256),
    kind: z.enum(['company', 'agency']).optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

const suggestInput = z.object({ sender: z.string().max(320), body: z.string().max(20000) }).strict();
const typeaheadInput = z.object({ query: z.string().max(256) }).strict();

export const panePartyLookupRouter = router({
  findParty: mailboxProcedure.input(findPartyInput).mutation(async ({ input, ctx }) => {
    if (input.threadId) {
      await assertCenturionHmsMailboxOrigin({
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
      });
    }
    return findParty({ name: input.name, kind: input.kind });
  }),
  // Read-only. Suggestions come from the sender's domain and the body's names; only HMS-listed ids are ever attached.
  suggest: mailboxProcedure.input(suggestInput).query(({ input }) => ({ suggestions: suggestPartiesFor(input) })),
  // Read-only and local: the HMS list the sweep wrote. It never reaches HMS, and it is empty when there is no list.
  typeahead: mailboxProcedure.input(typeaheadInput).query(({ input }) => typeaheadPartyIndex(input.query)),
});
