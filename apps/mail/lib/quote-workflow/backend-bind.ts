import type { PartyLookupRef, QuoteAnalysis, QuoteDocumentFailure, QuoteOffer, QuoteReviewItem } from './types';

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

/** U1/U2 handoff unpublished at U3 start. Do not guess enqueueHmsRead or mint centsReconciled:true. */
export const STAFF_QUOTE_PILOT_MISSING = {
  handoffFile: 'docs/plans/handoff-reports/2026-10-06-staff-quote-pilot-backend-handoff.md',
  reviewProjection:
    'source-bound review-item DTO from validated task/recovery output (analyseSelection or drafts review summary)',
  approvedInputExecution:
    'authorized staff-approved stay execution seam bound to mailbox/message/inputRevision/canonical request digest — not enqueueHmsRead',
  qualifiedArtifactRefs:
    'qualified proposal/revision/artifact references for PDF; UI must not mint centsReconciled:true or typed room prices',
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
  | { status: 'missing_source'; missing: string[]; documentFailures?: QuoteDocumentFailure[] }
  | {
      status: 'ready';
      intent: QuoteAnalysis['intent'];
      groups: QuoteAnalysis['groups'];
      secondaryAsks: QuoteAnalysis['secondaryAsks'];
      alternatives: QuoteAnalysis['alternatives'];
      sourceRevision: number;
      reviewItems?: QuoteReviewItem[];
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

function rejectionReason(error: unknown, label: string): string {
  return error instanceof Error && error.message.trim() ? error.message : `${label} rejected`;
}

function readPartyLookup(result: unknown): PartyLookupRef | null {
  if (!result || typeof result !== 'object') return null;
  const row = result as Record<string, unknown>;
  const nested = row.party && typeof row.party === 'object' ? (row.party as Record<string, unknown>) : row;
  const partyRef = typeof nested.partyRef === 'string' ? nested.partyRef.trim() : '';
  const organisation = typeof nested.organisation === 'string' ? nested.organisation.trim() : '';
  if (!partyRef) return null;
  return { organisation, partyRef };
}

function isQualifiedPdf(value: unknown): value is QualifiedProposalPdfResult {
  if (!value || typeof value !== 'object') return false;
  const pdf = value as Record<string, unknown>;
  return (
    pdf.centsReconciled === true &&
    typeof pdf.fileName === 'string' &&
    pdf.fileName.trim() !== '' &&
    typeof pdf.pdfBase64 === 'string' &&
    pdf.pdfBase64.trim() !== ''
  );
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
        'Client has no quoteWorkflow.analyseSelection. Bind to mailboxProcedure analyseSelection (getDb message/attachment).',
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
      analysis: {
        intent: result.intent,
        groups: result.groups,
        secondaryAsks: result.secondaryAsks,
        alternatives: result.alternatives,
        ...(result.reviewItems?.length ? { reviewItems: result.reviewItems } : {}),
      },
    };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error, 'analyseSelection') };
  }
}

export type BoundRunStep =
  | { status: 'unavailable'; reason: string }
  | { status: 'integration_unavailable'; reason: string }
  | { status: 'ok'; kind: 'party_lookup'; party: PartyLookupRef }
  | { status: 'ok'; kind: 'quote_stay'; offers: QuoteOffer[]; reviewedReplyHtml?: string };

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
    if (args.inputs.stepKind === 'party_lookup') {
      const party = readPartyLookup(result);
      if (!party) {
        return {
          status: 'unavailable',
          reason: 'runStep returned party lookup without partyRef. Do not invent entitlement.',
        };
      }
      return { status: 'ok', kind: 'party_lookup', party };
    }
    const offers = 'offers' in result ? result.offers : undefined;
    if (!Array.isArray(offers) || offers.length === 0) {
      return {
        status: 'unavailable',
        reason: 'runStep returned ok without offers. Do not synthesize inventory.',
      };
    }
    return { status: 'ok', kind: 'quote_stay', offers, reviewedReplyHtml: result.reviewedReplyHtml };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'runStep') };
  }
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
  try {
    const pdf = await args.mutate(args.input);
    if (!isQualifiedPdf(pdf)) {
      return {
        status: 'unavailable',
        reason:
          'qualifiedProposalPdf returned unqualified bytes. centsReconciled must be true with nonempty filename and pdfBase64.',
      };
    }
    return {
      status: 'ok',
      pdf: {
        fileName: pdf.fileName.trim(),
        pdfBase64: pdf.pdfBase64,
        centsReconciled: true,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'qualifiedProposalPdf') };
  }
}
