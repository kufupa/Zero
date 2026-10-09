import type {
  QuoteAmendment,
  QuoteAnalysis,
  QuoteAnalysisSource,
  QuoteDocumentFailure,
  QuoteOffer,
  QuoteReviewItem,
  QuoteWorkflowFallbackReason,
  LunaAnalysisWire,
} from './types';

/**
 * Published staff-quote contract (handoff 2026-10-06). Adapter types live in this tree;
 * do not import the sibling snapshot wholesale. Do not call enqueueHmsRead.
 *
 * analyseSelection remains mailbox-synced source admission.
 * Live stay execution is workstation.executeStaffQuote (party resolved internally).
 * PDF is workstation.qualifiedQuoteProposalPdf (real bytes/hash, no minted centsReconciled).
 * U1 actions are drafts/toDraftWire reviewSummary.staffActions.
 */
export const QUOTE_WORKFLOW_BIND_TARGETS = {
  analyseSelection: 'quoteWorkflow.analyseSelection',
  staffActions: 'drafts.toDraftWire reviewSummary.staffActions',
  staffQuoteSource: 'workstation.staffQuoteSource',
  executeStaffQuote: 'workstation.executeStaffQuote',
  qualifiedPdf: 'workstation.qualifiedQuoteProposalPdf',
  nativeReply: 'CREATE_REPLY_DRAFT',
  nativeAttach: 'ADD_ATTACHMENT_TO_DRAFT',
} as const;

/** Snapshot and connected PMS/PDF still pending. Contract names are published. */
export const STAFF_QUOTE_PILOT_MISSING = {
  handoffFile: 'docs/plans/handoff-reports/2026-10-06-staff-quote-pilot-backend-handoff.md',
  snapshot: 'backend scoped file snapshot after focused verification',
  connectedIntegration: 'connected executeStaffQuote / qualifiedQuoteProposalPdf / native insertion (U4)',
} as const;

export type AnalyseSelectionInput = {
  internetMessageId?: string;
  storeId: string;
  entryId: string;
  folderEntryId: string;
  selectionEpoch: number;
  treatAs?: 'quote' | 'create_booking';
  staffNote?: string;
};

export type AnalyseSelectionResult =
  | { status: 'unsynced' }
  | { status: 'missing_source'; missing: string[]; documentFailures?: QuoteDocumentFailure[] }
  | {
      status: 'ready';
      intent: QuoteAnalysis['intent'];
      groups: QuoteAnalysis['groups'];
      secondaryAsks: QuoteAnalysis['secondaryAsks'];
      alternatives: QuoteAnalysis['alternatives'];
      sourceRevision: number;
      reviewItems?: QuoteReviewItem[];
      source?: QuoteAnalysisSource;
      fallbackReason?: QuoteWorkflowFallbackReason;
      aiUnavailable?: boolean;
      luna?: LunaAnalysisWire | null;
      amendment?: QuoteAmendment | null;
      noReplySender?: boolean;
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
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return {};
  const quoteWorkflow = (trpc as { quoteWorkflow?: QuoteWorkflowClient }).quoteWorkflow;
  return quoteWorkflow ?? {};
}

function rejectionReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'The request did not finish. Refresh the pane and try again.';
}

export type BoundAnalyse =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unsynced' }
  | { kind: 'missing_source'; missing: string[]; documents: QuoteDocumentFailure[] }
  | { kind: 'ready'; analysis: QuoteAnalysis; sourceRevision: number };

export async function bindAnalyseSelection(args: {
  mutate?: (input: AnalyseSelectionInput) => Promise<AnalyseSelectionResult>;
  input: AnalyseSelectionInput;
}): Promise<BoundAnalyse> {
  if (!args.mutate) {
    return {
      kind: 'unavailable',
      reason:
        'Nava cannot read emails in this pane yet. Refresh the pane and try again.',
    };
  }
  try {
    const result = await args.mutate(args.input);
    if (result.status === 'unsynced') return { kind: 'unsynced' };
    if (result.status === 'missing_source') {
      return {
        kind: 'missing_source',
        missing: result.missing,
        documents: Array.isArray(result.documentFailures) ? result.documentFailures : [],
      };
    }
    return {
      kind: 'ready',
      sourceRevision: result.sourceRevision,
      analysis: quoteAnalysisOf(result),
    };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error) };
  }
}

/** The ready part of an analysis, as the live read returns it. A stored read returns the same shape. */
export type ReadyAnalyse = Omit<Extract<AnalyseSelectionResult, { status: 'ready' }>, 'status' | 'sourceRevision'>;

/** The pane's analysis. The live read and a stored read both map through here, so the pane sees one shape. */
export function quoteAnalysisOf(ready: ReadyAnalyse): QuoteAnalysis {
  return {
    intent: ready.intent,
    groups: ready.groups,
    secondaryAsks: ready.secondaryAsks,
    alternatives: ready.alternatives,
    ...(ready.reviewItems?.length ? { reviewItems: ready.reviewItems } : {}),
    ...(ready.source ? { source: ready.source } : {}),
    ...(ready.fallbackReason ? { fallbackReason: ready.fallbackReason } : {}),
    ...(ready.aiUnavailable !== undefined ? { aiUnavailable: ready.aiUnavailable } : {}),
    ...(ready.luna !== undefined ? { luna: ready.luna } : {}),
    ...(ready.amendment !== undefined ? { amendment: ready.amendment } : {}),
    ...(ready.noReplySender !== undefined ? { noReplySender: ready.noReplySender } : {}),
  };
}

/** A mail's stored read from workItems.getByMessage. Ready carries its work item and analysis; none means read it live. */
export type StoredWork =
  | { status: 'none' }
  | { status: 'failed'; reason: string }
  | {
      status: 'ready';
      workItemId: string;
      workItemStatus: string;
      extractionId: string;
      /** Group id to the stay and row it came from. A stay with dates and no rows has a null rowId. */
      refs: Record<string, { stayId: string; rowId: string | null }>;
      analysis: ReadyAnalyse;
    };

/** A field event as the server takes it. Edit, accept and reject only. */
export type RecordFieldEventInput = {
  workItemId: string;
  type: 'field.edit' | 'field.accept' | 'field.reject';
  fieldPath: string;
  value?: string | number | number[] | null;
  msSinceOpen?: number;
};

type WorkItemsClient = {
  getByMessage?: { query: (input: { internetMessageId: string }) => Promise<StoredWork> };
  recordEvent?: { mutate: (input: RecordFieldEventInput) => Promise<unknown> };
};

export function workItemsFromTrpc(trpc: unknown): WorkItemsClient {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return {};
  const workItems = (trpc as { workItems?: WorkItemsClient }).workItems;
  return workItems ?? {};
}

/** Reads the stored work for one mail. A missing route or a failed call reads as unavailable, so the pane reads live. */
export async function bindStoredWork(args: {
  query?: WorkItemsClient['getByMessage'];
  internetMessageId: string;
}): Promise<StoredWork | { status: 'unavailable' }> {
  if (!args.query) return { status: 'unavailable' };
  try {
    return await args.query.query({ internetMessageId: args.internetMessageId });
  } catch {
    return { status: 'unavailable' };
  }
}

export type BoundRunStep =
  | { status: 'unavailable'; reason: string }
  | { status: 'integration_unavailable'; reason: string }
  | { status: 'ok'; kind: 'quote_stay'; offers: QuoteOffer[]; reviewedReplyHtml?: string };

export async function bindRunStep(args: {
  mutate?: (input: RunStepRequest) => Promise<RunStepResult>;
  stepId: string;
  selectionEpoch: number;
  inputRevision: number;
  inputs: Record<string, unknown>;
}): Promise<BoundRunStep> {
  if (args.inputs.stepKind === 'party_lookup') {
    return {
      status: 'unavailable',
      reason: 'The company lookup runs automatically with the quote. No need to run it separately.',
    };
  }
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason:
        'This step is not available here. Use the quote search instead.',
    };
  }
  try {
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
        reason: 'HMS returned no room options for this search. Check HMS directly.',
      };
    }
    return { status: 'ok', kind: 'quote_stay', offers, reviewedReplyHtml: result.reviewedReplyHtml };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error) };
  }
}

export type BoundQualifiedPdf =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; pdf: QualifiedProposalPdfResult };

export async function bindQualifiedProposalPdf(args: {
  mutate?: (input: QualifiedProposalPdfInput) => Promise<QualifiedProposalPdfResult>;
  input: QualifiedProposalPdfInput;
}): Promise<BoundQualifiedPdf> {
  void args;
  return {
    status: 'unavailable',
    reason:
      'PDF creation is not connected to this pane yet. Refresh the pane and try again.',
  };
}
