import { z } from 'zod';
import { mailboxProcedure, router } from '../trpc.js';
import { analyseQuoteSources } from '../../ai/quote-workflow-analyse.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteSelection,
} from '../../ai/quote-workflow-synced-selection.js';

export type LoadSyncedSelection = (input: {
  transportId: string;
  internetMessageId?: string;
  entryId: string;
  storeId: string;
}) => Promise<SyncedQuoteSelection | null>;

/**
 * Default mailbox reader uses getDb() + message/attachment tables.
 * Tests may replace this. Never enqueue HMS from this module.
 */
export const quoteWorkflowLoaders: { loadSyncedSelection: LoadSyncedSelection | null } = {
  loadSyncedSelection: null,
};

export const analyseSelectionInput = z.object({
  internetMessageId: z.string().optional(),
  storeId: z.string().min(1),
  entryId: z.string().min(1),
  folderEntryId: z.string().min(1),
  selectionEpoch: z.number().int(),
});

export const runStepInput = z.object({
  stepId: z.string().min(1),
  selectionEpoch: z.number().int(),
  inputRevision: z.number().int(),
  inputs: z.record(z.unknown()),
});

export const quoteWorkflowRouter = router({
  analyseSelection: mailboxProcedure.input(analyseSelectionInput).mutation(async ({ input, ctx }) => {
    const loader = quoteWorkflowLoaders.loadSyncedSelection ?? loadSyncedQuoteSelectionFromMailbox;
    const synced = await loader({
      transportId: ctx.activeTransportId,
      internetMessageId: input.internetMessageId,
      entryId: input.entryId,
      storeId: input.storeId,
    });
    if (!synced) {
      return { status: 'unsynced' as const };
    }
    const missing = synced.attachments
      .filter((attachment) => !attachment.bytesPresent && !attachment.text)
      .map((attachment) => attachment.id);
    if (missing.length) {
      return { status: 'missing_source' as const, missing };
    }
    const analysis = analyseQuoteSources({
      subject: synced.subject,
      bodyText: synced.bodyText,
      preceding: synced.preceding,
      attachments: synced.attachments,
    });
    return {
      status: 'ready' as const,
      ...analysis,
      sourceRevision: input.selectionEpoch,
    };
  }),
  runStep: mailboxProcedure.input(runStepInput).mutation(async () => {
    // Approved current inputs/inputRevision are accepted on the contract.
    // Bind target on main: ai.enqueueHmsRead({ toolId: 'hms_quote_stay' }).
    // Overnight this UI must not call it (single PMS owner). Sibling
    // qualifiedProposalChoices is not on this branch.
    return {
      status: 'integration_unavailable' as const,
      reason:
        'Live PMS search is not owned by this quoting UI. A single authorised PMS owner must execute the read. Bind later to ai.enqueueHmsRead(hms_quote_stay) without a second browser owner.',
    };
  }),
});
