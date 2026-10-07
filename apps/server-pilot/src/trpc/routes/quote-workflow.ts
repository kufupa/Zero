import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteAttachment,
  type SyncedQuoteSelection,
} from '../../ai/quote-workflow-synced-selection.js';
import {
  analyseQuoteSelection,
  mapLlmDecision,
  quoteWorkflowLlmEnabled,
} from '../../ai/quote-workflow-llm.js';
import { createAzureLunaModel, LunaModelAdapter } from '../../ai/bedrock/luna.js';
import { analyseQuoteSources } from '../../ai/quote-workflow-analyse.js';
import type { LunaAnalysis } from '../../ai/reservationist-decision.js';
import type { ModelAdapter } from '../../ai/bedrock/adapter.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

export type LoadSyncedSelection = (input: {
  transportId: string;
  internetMessageId?: string;
  entryId: string;
  storeId: string;
  signal?: AbortSignal;
}) => Promise<SyncedQuoteSelection | null>;

/**
 * Default mailbox reader uses getDb() + message/attachment tables.
 * Tests may replace this. Never enqueue HMS from this module.
 */
export const quoteWorkflowLoaders: {
  loadSyncedSelection: LoadSyncedSelection | null;
  adapter: ModelAdapter | null;
  llmEnabled: (() => boolean) | null;
} = {
  loadSyncedSelection: null,
  adapter: null,
  llmEnabled: null,
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

function unreadAttachments(attachments: SyncedQuoteAttachment[]): SyncedQuoteAttachment[] {
  return attachments.filter((attachment) => !attachment.bytesPresent && !attachment.text);
}

function documentFailureItems(attachments: SyncedQuoteAttachment[]) {
  return unreadAttachments(attachments).map((attachment) => ({
    id: `unread:${attachment.id}`,
    kind: 'document_failure' as const,
    rank: 'unread_source' as const,
    text: `Attachment ${attachment.filename} could not be read (${attachment.readFailure ?? 'unavailable'}). Review it manually.`,
    sourceLabel: attachment.filename,
    sourceRef: attachment.id,
    sourceKind: 'attachment' as const,
    filename: attachment.filename,
    reason: attachment.readFailure ?? 'Content unavailable; review the original attachment.',
    blocking: true as const,
  }));
}

function questionItems(missing: Array<{ field: string; question: string }>) {
  return missing.map((item, index) => ({
    id: `missing:${item.field}:${index}`,
    kind: 'question' as const,
    rank: 'secondary' as const,
    text: item.question,
    sourceLabel: item.field,
    blocking: false as const,
  }));
}

function resolveAdapter(enabled: boolean): { enabled: boolean; adapter: ModelAdapter | null } {
  if (!enabled) return { enabled: false, adapter: null };
  if (quoteWorkflowLoaders.adapter) {
    return { enabled: true, adapter: quoteWorkflowLoaders.adapter };
  }
  try {
    return {
      enabled: true,
      adapter: new LunaModelAdapter({
        model: createAzureLunaModel(),
        reasoningEffort: 'medium',
        routeId: 'azure_quote',
        modelId: 'gpt-6-luna',
        protocol: 'azure-openai-responses',
      }),
    };
  } catch {
    return { enabled: false, adapter: null };
  }
}

export const quoteWorkflowRouter = router({
  analyseSelection: mailboxProcedure
    .input(analyseSelectionInput)
    .mutation(async ({ input, ctx }) => {
      const loader =
        quoteWorkflowLoaders.loadSyncedSelection ?? loadSyncedQuoteSelectionFromMailbox;
      const synced = await loader({
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
        entryId: input.entryId,
        storeId: input.storeId,
        signal: AbortSignal.timeout(15_000),
      });
      if (!synced) {
        return { status: 'unsynced' as const };
      }
      const unread = unreadAttachments(synced.attachments);
      const attachmentReviews = documentFailureItems(synced.attachments);
      const requested = quoteWorkflowLoaders.llmEnabled?.() ?? quoteWorkflowLlmEnabled(process.env);
      const resolved = resolveAdapter(requested);
      const llm = await analyseQuoteSelection({
        selection: synced,
        adapter: resolved.adapter,
        enabled: resolved.enabled,
        deadlineMs: 25_000,
      });
      if (llm.source === 'luna') {
        const flags: LunaAnalysis['flags'] = unread.length
          ? Array.from(new Set([...llm.analysis.flags, 'attachment_unread' as const]))
          : llm.analysis.flags;
        const luna: LunaAnalysis = { ...llm.analysis, flags };
        const mapped = mapLlmDecision(luna);
        return {
          status: 'ready' as const,
          intent: mapped.intent,
          groups: mapped.groups,
          secondaryAsks: mapped.secondaryAsks,
          alternatives: mapped.alternatives,
          reviewItems: [
            ...attachmentReviews,
            ...questionItems([...luna.missing, ...mapped.missing]),
          ],
          source: 'luna' as const,
          aiUnavailable: false as const,
          luna,
          workflow: luna.workflow,
          sourceRevision: input.selectionEpoch,
        };
      }
      console.warn('quote_workflow_fallback', llm.fallbackReason);
      const analysis = analyseQuoteSources({
        subject: synced.subject,
        bodyText: synced.bodyText,
        preceding: synced.preceding,
        attachments: synced.attachments,
      });
      return {
        status: 'ready' as const,
        ...analysis,
        reviewItems: attachmentReviews,
        source: 'regex_fallback' as const,
        fallbackReason: llm.fallbackReason,
        aiUnavailable: true as const,
        luna: null,
        sourceRevision: input.selectionEpoch,
      };
    }),
  runStep: mailboxProcedure.input(runStepInput).mutation(async () => {
    return {
      status: 'integration_unavailable' as const,
      reason:
        'Live staff quote execution is workstation.executeStaffQuote. Do not call ai.enqueueHmsRead from this UI route.',
    };
  }),
});
