import type { QuoteAnalysis } from './types';

/**
 * Existing backend APIs this quoting UI must bind to (this branch / origin/main).
 *
 * analyseSelection:
 *   `trpc.quoteWorkflow.analyseSelection` (`mailboxProcedure`)
 *   → `loadSyncedQuoteSelectionFromMailbox` (`getDb` + `message` + `attachment`)
 *   Does not enqueue HMS. No internetMessageId or no matching mailbox row → `unsynced`.
 *   Attachment filename without bytes → `missing_source`.
 *
 * runStep (live inventory — not owned overnight):
 *   `trpc.quoteWorkflow.runStep` currently returns `integration_unavailable`.
 *   Later bind the server procedure to `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })`.
 *   Do not import sibling `qualifiedProposalChoices` / `reservationist-*`.
 *
 * Native unsent draft (already bound):
 *   Classic Outlook `CREATE_REPLY_DRAFT` then `ADD_ATTACHMENT_TO_DRAFT`.
 *   PDF bytes come from reviewed session PDF, not `workstation.quoteProposalPdf` / RATE_TABLE.
 *
 * Not bound on this branch:
 *   sibling `qualifiedQuoteProposalPdf`, S3 attachment bodies, live PMS.
 */
export const QUOTE_WORKFLOW_BIND_TARGETS = {
  analyseSelection: 'quoteWorkflow.analyseSelection',
  runStep: 'quoteWorkflow.runStep',
  runStepServerLater: 'ai.enqueueHmsRead({ toolId: "hms_quote_stay" })',
  nativeReply: 'CREATE_REPLY_DRAFT',
  nativeAttach: 'ADD_ATTACHMENT_TO_DRAFT',
} as const;

export type AnalyseSelectionInput = {
  internetMessageId?: string;
  storeId: string;
  entryId: string;
  folderEntryId: string;
  selectionEpoch: number;
};

export type AnalyseSelectionResult =
  | { status: 'unsynced' }
  | { status: 'missing_source'; missing: string[] }
  | {
      status: 'ready';
      intent: QuoteAnalysis['intent'];
      groups: QuoteAnalysis['groups'];
      secondaryAsks: QuoteAnalysis['secondaryAsks'];
      alternatives: QuoteAnalysis['alternatives'];
      sourceRevision: number;
    };

export type RunStepResult =
  | { status: 'integration_unavailable'; reason: string }
  | { status: 'ok' };

type QuoteWorkflowClient = {
  analyseSelection?: { mutate: (input: AnalyseSelectionInput) => Promise<AnalyseSelectionResult> };
  runStep?: {
    mutate: (input: { stepId: string; selectionEpoch: number }) => Promise<RunStepResult>;
  };
};

export function quoteWorkflowFromTrpc(trpc: unknown): QuoteWorkflowClient {
  if (!trpc || typeof trpc !== 'object') return {};
  const quoteWorkflow = (trpc as { quoteWorkflow?: QuoteWorkflowClient }).quoteWorkflow;
  return quoteWorkflow ?? {};
}

export type BoundAnalyse =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unsynced' }
  | { kind: 'missing_source'; missing: string[] }
  | { kind: 'ready'; analysis: QuoteAnalysis; sourceRevision: number };

export async function bindAnalyseSelection(args: {
  mutate?: (input: AnalyseSelectionInput) => Promise<AnalyseSelectionResult>;
  input: AnalyseSelectionInput;
}): Promise<BoundAnalyse> {
  if (!args.mutate) {
    return {
      kind: 'unavailable',
      reason:
        'Client has no quoteWorkflow.analyseSelection. Bind to mailboxProcedure analyseSelection (getDb message/attachment).',
    };
  }
  const result = await args.mutate(args.input);
  if (result.status === 'unsynced') return { kind: 'unsynced' };
  if (result.status === 'missing_source') return { kind: 'missing_source', missing: result.missing };
  return {
    kind: 'ready',
    sourceRevision: result.sourceRevision,
    analysis: {
      intent: result.intent,
      groups: result.groups,
      secondaryAsks: result.secondaryAsks,
      alternatives: result.alternatives,
    },
  };
}

export type BoundRunStep =
  | { status: 'unavailable'; reason: string }
  | { status: 'integration_unavailable'; reason: string }
  | { status: 'ok' };

export async function bindRunStep(args: {
  mutate?: (input: { stepId: string; selectionEpoch: number }) => Promise<RunStepResult>;
  stepId: string;
  selectionEpoch: number;
}): Promise<BoundRunStep> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason:
        'Client has no quoteWorkflow.runStep. Server must later bind to ai.enqueueHmsRead(hms_quote_stay). Overnight this UI must not start a second PMS owner.',
    };
  }
  const result = await args.mutate({
    stepId: args.stepId,
    selectionEpoch: args.selectionEpoch,
  });
  if (result.status === 'integration_unavailable') {
    return { status: 'integration_unavailable', reason: result.reason };
  }
  return { status: 'ok' };
}
