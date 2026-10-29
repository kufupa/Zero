import { inMailbox } from '@/lib/mail/mail-cache-scope';
import type {
  QuoteAmendment,
  QuoteAnalysis,
  QuoteAnalysisSource,
  QuoteDocumentFailure,
  QuoteOffer,
  QuoteReviewItem,
  RatePlanCatalogueEntry,
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
  rateCatalogue: 'quoteWorkflow.rateCatalogue',
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
  /** The Outlook store's native EntryID; distinct from the canonical webmail sourceMessageId. */
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
      requestedRoomsByStay?: QuoteAnalysis['requestedRoomsByStay'];
      missingQuoteReplyFields?: QuoteAnalysis['missingQuoteReplyFields'];
      secondaryAsks: QuoteAnalysis['secondaryAsks'];
      alternatives: QuoteAnalysis['alternatives'];
      sourceRevision: number;
      reviewItems?: QuoteReviewItem[];
      source?: QuoteAnalysisSource;
      fallbackReason?: QuoteWorkflowFallbackReason;
      aiUnavailable?: boolean;
      luna?: LunaAnalysisWire | null;
      amendment?: QuoteAmendment | null;
      hmsTodoCard?: QuoteAnalysis['hmsTodoCard'];
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
  rateCatalogue?: { query: () => Promise<RatePlanCatalogueEntry[]> };
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
    ...(ready.requestedRoomsByStay ? { requestedRoomsByStay: ready.requestedRoomsByStay } : {}),
    ...(ready.missingQuoteReplyFields ? { missingQuoteReplyFields: ready.missingQuoteReplyFields } : {}),
    secondaryAsks: ready.secondaryAsks,
    alternatives: ready.alternatives,
    ...(ready.reviewItems?.length ? { reviewItems: ready.reviewItems } : {}),
    ...(ready.source ? { source: ready.source } : {}),
    ...(ready.fallbackReason ? { fallbackReason: ready.fallbackReason } : {}),
    ...(ready.aiUnavailable !== undefined ? { aiUnavailable: ready.aiUnavailable } : {}),
    ...(ready.luna !== undefined ? { luna: ready.luna } : {}),
    ...(ready.amendment !== undefined ? { amendment: ready.amendment } : {}),
    ...(ready.hmsTodoCard !== undefined ? { hmsTodoCard: ready.hmsTodoCard } : {}),
    ...(ready.noReplySender !== undefined ? { noReplySender: ready.noReplySender } : {}),
  };
}

/** The contact block's fields. Each is one `contact.<field>` event path. `company` is the sender's organisation. */
export type ContactField = 'name' | 'company' | 'endClient' | 'email' | 'phone';
export type StoredContact = Record<ContactField, string | null>;
/** One stay's last HMS commit, as workItems.getByMessage returns it. */
export type StoredStayCommit = {
  confirmationNumber: string | null;
  status: 'booked' | 'unknown';
  screenshotRef: { runId: string; name: string } | null;
  runId?: string;
  shots?: Array<{ name: string; sha256: string; at: string }>;
};
/** The translation the pane shows: aligned segments, or failed. Null when the read has none. */
export type StoredTranslation =
  | { status: 'succeeded'; segments: Array<{ clean: string; literal: string }>; truncated: boolean }
  | { status: 'failed' }
  | null;

/**
 * A mail's stored read from workItems.getByMessage. Ready carries its analysis and its work item (null until one is
 * opened, see bindStoredWork); none means read it live.
 */
export type StoredWork =
  | { status: 'none' }
  | { status: 'failed'; reason: string }
  | {
      status: 'ready';
      /** The stored mail kind, used to keep the selected-email classification in the shared pane vocabulary. */
      kind: string;
      existingStayInformation?: boolean;
      confirmationNumbers?: string[];
      workItemId: string | null;
      workItemStatus: string | null;
      extractionId: string;
      /** Group id to the stay and row it came from. A stay with dates and no rows has a null rowId. */
      refs: Record<string, { stayId: string; rowId: string | null }>;
      analysis: ReadyAnalyse;
      contact: StoredContact;
      /** Fingerprint of the saved agency and end-client source, from this read. */
      sourcePartyDigest?: string | null;
      /** Last HMS commit per stay id, including durable before/saved shots. Absent on older reads. */
      stays?: Record<string, StoredStayCommit>;
      /** The read's source language (ISO 639-1), or null when unclear. */
      language: string | null;
      translation: StoredTranslation;
    };

/** A field event as the server takes it. Edit, accept and reject only. */
export type RecordFieldEventInput = {
  workItemId: string;
  type: 'field.edit' | 'field.accept' | 'field.reject';
  fieldPath: string;
  /** `true` only on a `.removed` path: the person deleted that stay or row. */
  value?: string | number | number[] | true | null;
  msSinceOpen?: number;
};

/** The outcome of a translation retry. Only `done` carries a translation; the rest say why it did not run. */
export type TranslationRetryResult = { status: string; translation?: StoredTranslation };

/** One open item on the Needs-you list. The chip is derived from the item's latest run (KTD14). */
export type NeedsYouRow = {
  id: string;
  kind: string;
  status: 'needs_you' | 'review' | 'done' | 'dismissed';
  chip: 'needs_you' | 'queued' | 'in_hms' | 'review';
  threadId: string | null;
  /** Canonical Zero message row ID, distinct from the Outlook-native EntryID. */
  sourceMessageId?: string | null;
  /** Exact Outlook EntryID when present; current responses use null for legacy/non-Outlook rows. */
  outlookEntryId?: string | null;
  sender: string | null;
  subject: string | null;
  receivedAt: Date | null;
};

type WorkItemsClient = {
  getByMessage?: {
    query: (input: { internetMessageId: string }, opts?: { context: Record<string, unknown> }) => Promise<StoredWork>;
  };
  open?: {
    mutate: (input: { internetMessageId: string }, opts?: { context: Record<string, unknown> }) => Promise<StoredWork>;
  };
  recordEvent?: {
    mutate: (input: RecordFieldEventInput, opts?: { context: Record<string, unknown> }) => Promise<unknown>;
  };
  acceptFields?: {
    mutate: (
      input: { workItemId: string; fieldPaths: string[] },
      opts?: { context: Record<string, unknown> },
    ) => Promise<unknown>;
  };
  retryTranslation?: { mutate: (input: { workItemId: string }) => Promise<TranslationRetryResult> };
  list?: {
    query: (input: { limit?: number; statuses?: NeedsYouRow['status'][] }) => Promise<NeedsYouRow[]>;
  };
  dismiss?: {
    mutate: (input: { workItemId: string }, opts?: ReturnType<typeof inMailbox>) => Promise<unknown>;
  };
};

export function workItemsFromTrpc(trpc: unknown): WorkItemsClient {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return {};
  const workItems = (trpc as { workItems?: WorkItemsClient }).workItems;
  return workItems ?? {};
}

/**
 * Reads the stored work for one mail. A missing route or a failed call reads as unavailable, so the pane reads live.
 * The read writes nothing. A stored read with no work item yet is opened once (workItems.open) so edits have an item;
 * if that cannot run (no route, a failed call, the preview), the read still shows and edits are not logged.
 * Both calls go out under `transportId` (the mailbox the lookup was made in), and no open is sent once `isStale` says
 * the pane moved on (another mail or mailbox), so a late read never opens a work item in the mailbox switched to.
 */
export async function bindStoredWork(args: {
  query?: WorkItemsClient['getByMessage'];
  open?: WorkItemsClient['open'];
  internetMessageId: string;
  /** The mailbox the lookup was made in. Null sends under whichever mailbox is active. */
  transportId?: string | null;
  /** True once the caller no longer wants this lookup. Checked after the read, before any open. */
  isStale?: () => boolean;
  /** Called when the stored read is in and only the open is left, so the caller's lookup deadline can stop there. */
  onRead?: () => void;
  /** How long the open may take. Past it the read shows without an item, the same as a failed open. */
  openTimeoutMs?: number;
}): Promise<StoredWork | { status: 'unavailable' }> {
  if (!args.query) return { status: 'unavailable' };
  const input = { internetMessageId: args.internetMessageId };
  const pinned = inMailbox(args.transportId ?? null);
  let stored: StoredWork;
  try {
    stored = await (pinned ? args.query.query(input, pinned) : args.query.query(input));
  } catch {
    return { status: 'unavailable' };
  }
  if (
    stored.status !== 'ready' ||
    stored.workItemId ||
    stored.existingStayInformation ||
    !args.open ||
    args.isStale?.()
  ) {
    return stored;
  }
  args.onRead?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<StoredWork>((resolve) => {
    if (args.openTimeoutMs !== undefined) timer = setTimeout(() => resolve(stored), args.openTimeoutMs);
  });
  try {
    const opening = pinned ? args.open.mutate(input, pinned) : args.open.mutate(input);
    const opened = await Promise.race([opening, late]);
    return opened.status === 'ready' && opened.workItemId ? opened : stored;
  } catch {
    return stored;
  } finally {
    clearTimeout(timer);
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
