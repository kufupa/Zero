export type QuoteIntent = 'quote' | 'other';

export type FactProvenance = 'extracted' | 'staff_corrected' | 'missing';

export type QuoteBoard = 'dinner_bb' | 'bb' | 'room_only' | 'unknown';

export type QuoteWorkflowPhase =
  | 'idle'
  | 'analysing'
  | 'unsynced'
  | 'missing_source'
  | 'failed'
  | 'unsupported'
  | 'non_quote'
  | 'requirements'
  | 'tools'
  | 'results'
  | 'review'
  | 'native_pending'
  | 'native_unknown'
  | 'native_verified';

export type QuoteSelectionBinding = {
  transportId: string;
  mailboxEmail: string;
  storeId: string;
  folderEntryId: string;
  entryId: string;
  internetMessageId?: string;
  threadId?: string;
  selectionEpoch: number;
  scopeEpoch: number;
};

export type StayGroupRequirement = {
  id: string;
  arrivalDate?: string;
  departureDate?: string;
  quantity?: number;
  roomPreference?: string;
  adults?: number;
  childrenAges: number[];
  board: QuoteBoard;
  organisation?: string;
  specialRequests: string[];
  fields: Record<string, FactProvenance>;
};

export type QuoteReviewItemKind =
  | 'pricing_fact'
  | 'document_failure'
  | 'question'
  | 'analysis_failure'
  | 'signature_noise';

export type QuoteReviewItemRank = 'pricing' | 'unread_source' | 'secondary';

export type QuoteDocumentFailure = {
  filename: string;
  reason: string;
  sourceKind: 'attachment' | 'email';
  sourceRef?: string;
};

export type QuoteReviewItem = {
  id: string;
  kind: QuoteReviewItemKind;
  rank: QuoteReviewItemRank;
  text: string;
  sourceLabel: string;
  sourceRef?: string;
  filename?: string;
  reason?: string;
  blocking: boolean;
  positivelyIdentifiedNoise?: boolean;
};

export type QuoteAnalysis = {
  intent: QuoteIntent;
  groups: StayGroupRequirement[];
  secondaryAsks: string[];
  alternatives: string[];
  reviewItems?: QuoteReviewItem[];
};

export type QuoteOfferKind = 'allocation' | 'alternative';

export type QuoteNight = { date: string; amountMinor: number };

export type QuoteScreenshot =
  | { artifactRef: string; toolRunId: string }
  | { unavailable: true; reason: string };

export type QuoteOffer = {
  id: string;
  kind: QuoteOfferKind;
  roomCode: string;
  roomLabel: string;
  board: string;
  rateCode: string;
  currency: 'ZAR';
  nightly: QuoteNight[];
  stayTotalMinor: number;
  observedAt: string;
  sourceRef: string;
  restrictions: string[];
  combinable: boolean;
  quoteRequestKey: string;
  coversGroupIds: string[];
  quantity?: number;
  adults?: number;
  childrenAges?: number[];
  screenshot?: QuoteScreenshot;
};

export type QuoteMailboxStatus = 'unsynced' | 'missing_source' | 'ready' | 'unavailable';

export type QuoteEvidenceKind = 'authorised' | 'fixture';

export type QuoteEvidenceProvenance = {
  kind: QuoteEvidenceKind;
  selectionEpoch: number;
  inputRevision: number;
};

export type QuotePdf = { fileName: string; bytesBase64: string };

export type ApprovedStayGroup = {
  id: string;
  arrivalDate?: string;
  departureDate?: string;
  quantity?: number;
  roomPreference?: string;
  adults?: number;
  childrenAges: number[];
  board: QuoteBoard;
  organisation?: string;
  specialRequests: string[];
};

export type QuoteStepBinding = {
  transportId: string;
  mailboxEmail: string;
  storeId: string;
  folderEntryId: string;
  entryId: string;
  internetMessageId?: string;
  selectionEpoch: number;
};

export type QuoteStepInputs = {
  stepKind: QuoteToolStep['kind'];
  binding: QuoteStepBinding;
  groups: ApprovedStayGroup[];
  party?: PartyLookupRef;
};

export type PartyLookupRef = {
  organisation: string;
  partyRef: string;
};

export type QuoteToolStepStatus = 'queued' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type QuoteToolStep = {
  id: string;
  kind: 'party_lookup' | 'quote_stay' | 'quote_proposal_pdf';
  title: string;
  inputs: Record<string, unknown>;
  dependsOn: string[];
  status: QuoteToolStepStatus;
  resultSummary?: string;
  retryGuidance?: string;
  shareKey?: string;
};

export type QuoteSession = {
  phase: QuoteWorkflowPhase;
  binding: QuoteSelectionBinding | null;
  analysis: QuoteAnalysis | null;
  groups: StayGroupRequirement[];
  inputRevision: number;
  offers: QuoteOffer[];
  selectedOfferIds: string[];
  pdf: QuotePdf | null;
  reviewedReplyHtml: string;
  steps: QuoteToolStep[];
  missing: string[];
  errorMessage: string | null;
  runningStepId: string | null;
  mailboxStatus: QuoteMailboxStatus | null;
  evidence: QuoteEvidenceProvenance | null;
  partyLookup: PartyLookupRef | null;
  reviewItems: QuoteReviewItem[];
  handledReviewItemIds: string[];
};

export type QuoteSessionAction =
  | { type: 'selection'; binding: QuoteSelectionBinding }
  | { type: 'analysis_started' }
  | { type: 'analysis_ready'; analysis: QuoteAnalysis }
  | { type: 'analysis_unsynced' }
  | { type: 'analysis_missing_source'; missing: string[]; documents?: QuoteDocumentFailure[] }
  | { type: 'analysis_failed'; message: string }
  | { type: 'handle_review_item'; itemId: string }
  | { type: 'unhandle_review_item'; itemId: string }
  | { type: 'review_documents_failed'; documents: QuoteDocumentFailure[] }
  | { type: 'analysis_unsupported'; message: string }
  | { type: 'patch_group'; groupId: string; patch: Partial<StayGroupRequirement> }
  | {
      type: 'results_ready';
      offers: QuoteOffer[];
      selectionEpoch?: number;
      inputRevision?: number;
      reviewedReplyHtml?: string;
      provenance: QuoteEvidenceProvenance;
    }
  | {
      type: 'results_unavailable';
      stepId: string;
      reason: string;
      selectionEpoch: number;
      inputRevision: number;
    }
  | {
      type: 'lookup_ready';
      stepId: string;
      selectionEpoch: number;
      inputRevision: number;
      party: PartyLookupRef;
    }
  | { type: 'step_running'; stepId: string }
  | { type: 'step_failed'; stepId: string; retryGuidance: string }
  | {
      type: 'pdf_ready';
      pdf: QuotePdf;
      selectionEpoch: number;
      inputRevision: number;
      selectedOfferIds: string[];
    }
  | { type: 'set_reviewed_reply'; html: string }
  | { type: 'select_offers'; offerIds: string[] }
  | { type: 'mailbox_status'; status: QuoteMailboxStatus | null };
