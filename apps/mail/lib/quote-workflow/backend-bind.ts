import type { QuoteAnalysis, QuoteOffer } from './types';

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
  qualifiedPdf: 'qualifiedQuoteProposalPdf (not on this branch)',
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

export type RunStepRequest = {
  stepId: string;
  selectionEpoch: number;
  inputRevision: number;
  inputs: Record<string, unknown>;
};

export type RunStepResult =
  | { status: 'integration_unavailable'; reason: string }
  | { status: 'ok'; offers: QuoteOffer[]; reviewedReplyHtml?: string };

/** Minimal typed bind for live PDF. Not implemented on this branch. */
export type QualifiedProposalPdfInput = {
  selectedOfferIds: string[];
  sourceRevision: number;
  mailboxTransportId: string;
};

export type QualifiedProposalPdfResult = {
  fileName: string;
  pdfBase64: string;
  centsReconciled: true;
};

type QuoteWorkflowClient = {
  analyseSelection?: { mutate: (input: AnalyseSelectionInput) => Promise<AnalyseSelectionResult> };
  runStep?: {
    mutate: (input: RunStepRequest) => Promise<RunStepResult>;
  };
  qualifiedProposalPdf?: {
    mutate: (input: QualifiedProposalPdfInput) => Promise<QualifiedProposalPdfResult>;
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
  | { status: 'ok'; offers: QuoteOffer[]; reviewedReplyHtml?: string };

export async function bindRunStep(args: {
  mutate?: (input: RunStepRequest) => Promise<RunStepResult>;
  stepId: string;
  selectionEpoch: number;
  inputRevision: number;
  inputs: Record<string, unknown>;
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
    inputRevision: args.inputRevision,
    inputs: args.inputs,
  });
  if (result.status === 'integration_unavailable') {
    return { status: 'integration_unavailable', reason: result.reason };
  }
  const offers = 'offers' in result ? result.offers : undefined;
  if (!Array.isArray(offers) || offers.length === 0) {
    return {
      status: 'unavailable',
      reason: 'runStep returned ok without offers. Do not synthesize inventory.',
    };
  }
  return { status: 'ok', offers, reviewedReplyHtml: result.reviewedReplyHtml };
}

export type BoundQualifiedPdf =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; pdf: QualifiedProposalPdfResult };

export async function bindQualifiedProposalPdf(args: {
  mutate?: (input: QualifiedProposalPdfInput) => Promise<QualifiedProposalPdfResult>;
  input: QualifiedProposalPdfInput;
}): Promise<BoundQualifiedPdf> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason:
        'qualifiedQuoteProposalPdf / qualifiedProposalChoices are not on origin/main. Do not invent a second PDF engine. Do not substitute fixture PDF bytes.',
    };
  }
  const pdf = await args.mutate(args.input);
  return { status: 'ok', pdf };
}
