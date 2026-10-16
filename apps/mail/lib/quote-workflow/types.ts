import type { RoomTypeCode } from './room-types';

export type QuoteIntent = 'quote' | 'other';

export type FactProvenance = 'extracted' | 'staff_corrected' | 'missing' | 'defaulted';

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
  /** One row of a stay. Each row is still one server group. */
  id: string;
  /** The stay this row belongs to. Rows with the same stayId are one stay. Missing: the row's dates make its stay. */
  stayId?: string;
  arrivalDate?: string;
  departureDate?: string;
  quantity?: number;
  roomPreference?: string;
  /** Server projection of the same preference; absent when unmatched or from a mail-only draft. */
  roomTypeCode?: RoomTypeCode;
  /** Never collapsed to one guess when the extracted wording matches multiple native types. */
  roomTypeSuggestions?: RoomTypeCode[];
  /** Explicit native room-type codes. A name is accepted only when it resolves to exactly one code. */
  roomCodes?: string[];
  adults?: number;
  childrenAges: number[];
  board: QuoteBoard;
  organisation?: string;
  specialRequests: string[];
  fields: Record<string, FactProvenance>;
  /** HMS rate code pinned from a rate card. Cleared when staff change the board, dates or room type by hand. */
  rateCode?: string;
  /** Rate code from a prepared staff quote, shown on the booking card. Not a staff pin. */
  quotedRateCode?: string;
  /** Nightly amount from a prepared staff quote, shown on the booking card. */
  quotedAmountMinor?: number;
  /** The price staff chose for this row instead of HMS's nightly rate. Absent means HMS prices the row. */
  rowPrice?: RowPriceChoice;
};

/** Staff's price for one row (KTD6). A saved rate is named by id; its name and amount are copied for display. */
export type RowPriceChoice =
  | { source: 'saved'; customRateId: string; name: string; amountMinor: number }
  | { source: 'one_off'; amountMinor: number }
  | { source: 'override'; rateCode: string; amountMinor: number; note: string };

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
  sourceHash?: string;
  sourceKind?: 'message' | 'attachment' | 'email';
  messageId?: string;
  filename?: string;
  reason?: string;
  blocking: boolean;
  positivelyIdentifiedNoise?: boolean;
};

/** U1 drafts/toDraftWire staffActions. Copied from the published handoff; not imported from the sibling tree. */
export type ReservationistStaffAction = {
  id: string;
  kind: 'unanswered_question' | 'business_document_failure' | 'pricing_fact';
  text: string;
  sourceRef: string;
  sourceHash: string;
  sourceKind?: 'message' | 'attachment';
  messageId?: string;
  filename?: string;
  reason?: string;
  blockingQuote: boolean;
  status: 'open';
};

/** Local wire type mirroring server lunaAnalysisSchema. Do not import the server module. */
export type LunaAnalysisWire = {
  workflow: 'quote' | 'create_booking' | 'other' | 'skip';
  flags: Array<
    | 'conference_or_group'
    | 'rooms_only_group'
    | 'amendment_or_cancel'
    | 'long_stay'
    | 'discount_or_negotiation'
    | 'multi_date'
    | 'extras'
    | 'mixed_request'
    | 'attachment_unread'
  >;
  groups: Array<{
    arrival: string | null;
    departure: string | null;
    rooms: number | null;
    adultsPerRoom: number | null;
    childAges: number[];
    board: 'room_only' | 'bb' | 'dbb' | 'half_board' | null;
    roomPreference: string | null;
    guestNames: string[];
  }>;
  party: {
    kind: 'agency' | 'organization' | 'government' | 'private' | null;
    name: string | null;
    reference: string | null;
  };
  rateClaims: Array<{
    kind: 'exact' | 'ceiling' | 'budget' | 'average_daily' | 'total' | 'paid';
    amount: string;
    currency: string;
    basis: 'per_room_per_night' | 'total' | 'unknown';
    taxBasis: 'gross_included' | 'exclusive' | 'unknown';
    quote: string;
  }>;
  missing: Array<{ field: string; question: string }>;
  evidence: Array<{ field: string; quote: string; source?: 'staff_note' }>;
  tasks: Array<{
    kind: 'quote' | 'create_booking' | 'amend' | 'cancel' | 'availability' | 'other';
    groupIndexes: number[];
    note: string;
  }>;
};

/** Server analyse payload `amendment`. Null unless Luna classed the mail as amend or cancel. */
export type QuoteAmendment = {
  kind: 'amend' | 'cancel';
  confirmationNumber: string | null;
  guestLastName: string | null;
  /** ISO day of the booking as it stands, as stated in the email. The lookup uses it. */
  arrival: string | null;
  departure: string | null;
  /** ISO days of the stay the guest wants after the change. Absent on payloads from before they were read. */
  requestedArrival?: string | null;
  requestedDeparture?: string | null;
  requestedChange: string | null;
};

export type QuoteAnalysisSource = 'luna' | 'regex_fallback';

export type QuoteWorkflowFallbackReason = 'timeout' | 'error' | 'disabled' | 'invalid_output';

export type QuoteAnalysis = {
  intent: QuoteIntent;
  groups: StayGroupRequirement[];
  /** Extraction totals kept at stay level so row-count changes can promote or demote the one-row default. */
  requestedRoomsByStay?: Record<string, number>;
  secondaryAsks: string[];
  alternatives: string[];
  /** Fields requested by the reply-only draft when no complete quote date range was found. */
  missingQuoteReplyFields?: string[];
  reviewItems?: QuoteReviewItem[];
  staffActions?: ReservationistStaffAction[];
  luna?: LunaAnalysisWire | null;
  /** Intent stays other for amend and cancel. This only feeds the HMS lookup panel. */
  amendment?: QuoteAmendment | null;
  /** Staff checklist of facts to type into HMS. Null unless the mail is a booking, amend, cancel, payment proof, or billing ask. */
  hmsTodoCard?: {
    kind: 'new_booking' | 'amend' | 'cancel' | 'payment_proof' | 'send_document';
    title: string;
    steps: Array<{ label: string; value: string | null; source: 'mail' | 'attachment' | 'missing' }>;
    missing: string[];
    writesEnabled: false;
    prefill?: { fields: Array<{ label: string; value: string }>; stillNeeded: string[] };
  } | null;
  /** The email came from an automated mailbox staff cannot answer. The pane hides Insert draft for it. */
  noReplySender?: boolean;
  aiUnavailable?: boolean;
  source?: QuoteAnalysisSource;
  fallbackReason?: QuoteWorkflowFallbackReason;
};

export type RatePlanBoard = 'room_only' | 'bed_breakfast' | 'dinner_bed_breakfast' | 'unknown';

/** The server's read-only Centurion catalogue; flags group choices, but do not prove rate eligibility. */
export type RatePlanCatalogueEntry = {
  code: string;
  name: string;
  board: RatePlanBoard;
  contract?: boolean;
  government?: boolean;
  event?: boolean;
};

export type StaffQuoteSource = {
  messageId: string;
  threadId: string;
  sourceHash: string;
};

/** A rate HMS returned for one room group. The rate cards show these; the server sends them on executeStaffQuote. */
export type RateOption = {
  id: string;
  groupId: string;
  board: 'room_only' | 'bb' | 'dinner_bb';
  boardLabel: string;
  rateCode: string;
  rateLabel: string;
  roomCode: string;
  roomLabel: string;
  contract: boolean;
  onlyContract: boolean;
  matchesRequest: boolean;
  perNightMinor: number;
  totalMinor: number;
  currency: string;
  priced: 'full' | 'summary';
  selected: boolean;
  /** Staff-only label. Ranking, matching and pricing never read it. */
  hint?: 'event_rate';
};

/** What one row was charged on its last run: HMS's nightly rates, the rates charged, and for an override its HMS comment. */
export type StaffRowRate = {
  groupId: string;
  source: 'hms' | 'saved' | 'one_off' | 'override';
  hmsNightlyMinor: number[];
  nightlyMinor: number[];
  customRateName?: string;
  rateCode?: string;
  note?: string;
  /** The line staff paste into the HMS comments. Never shown to the client. */
  hmsComment?: string;
};

export type StaffQuoteAllocation = {
  workflowRunId: string;
  revisionRef: string;
  factRefs: string[];
  messageId: string;
  threadId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  inputDigest: string;
  /** A completed background quote prepared by Nava before staff opened this email. */
  preparedByNava?: boolean;
  /** The saved result's as-of time, displayed next to the preparation label. */
  preparedAt?: string;
  totalMinor: number;
  currency: string;
  quoteRequestKey: string;
  dinnerAddOnRequired?: boolean;
  dinnerFallbackGroupIds?: string[];
  dinnerAddOn?: {
    label: string;
    amountMinor: number;
    unit: DinnerAddOnUnit;
    totalMinor: number;
  };
  approvedHeader: {
    salesStrategy: 'BAR' | 'Government';
    company: string;
    agency: string;
    attention: string;
    clientEmail: string;
    clientTelephone: string;
    notes?: string;
  };
  /** True when this stay's run carried a single-charge extra (shuttle, per-trip or one-item "other"). */
  onceExtras?: boolean;
  /** HMS evidence run for the audit view; null when the run left no screenshots. */
  runId?: string | null;
  /** Screenshot file names for runId, in capture order. */
  screenshots?: string[];
  /** Rate options from this run. Carried on the allocation because the pane dispatches the allocation alone. */
  rateOptions?: RateOption[];
  /** Each row's charged rate from this run, with the HMS comment for an override. */
  rowRates?: StaffRowRate[];
};

/** The HMS company or agency staff picked with Find in HMS. nativeId is HMS's id; the server re-checks it before any rate. */
export type StaffQuoteParty = {
  kind: 'agency' | 'company';
  nativeId: string;
  name: string;
};

/** The company and the agency staff picked, one of each at most. Either may be absent. */
export type StaffQuoteParties = {
  company?: StaffQuoteParty;
  agency?: StaffQuoteParty;
};

export type StaffQuoteHeader = {
  salesStrategy: 'BAR' | 'Government';
  company: string;
  agency: string;
  attention: string;
  clientEmail: string;
  clientTelephone: string;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceUnit?: DinnerAddOnUnit;
  /** Set when a dinner quote fell back to B&B: staff must enter the allowance; never priced by us. */
  dinnerAllowanceRequired?: boolean;
  /** The groups that took the B&B fallback. The allowance is charged only to these groups' guests. */
  dinnerAllowanceGroupIds?: string[];
  /** Optional qualifier on the dinner line, e.g. "food only". Printed in brackets. */
  dinnerAllowanceLabel?: string;
  lunchAllowanceMinor?: number;
  lunchAllowanceLabel?: string;
  /** R per person per day, return trip. */
  officeTransferMinor?: number;
  /** Days charged for the office transfer. Absent means the nights of the stay. */
  officeTransferDays?: number;
  shuttleRequested?: boolean;
  /** R per trip. A legacy header with only this set means one trip. */
  shuttleMinor?: number;
  /** Number of shuttle trips. Absent means one trip. */
  shuttleTrips?: number;
  other?: StaffQuoteOtherCharge;
  /** Unpriced note for the reply and the PDF. */
  notes?: string;
  /** Independent extras for each quoted stay, keyed by arrivalDate:departureDate. */
  stayExtrasByKey?: Record<string, StaffStayExtras>;
  /**
   * Unreadable or over-cap text in an amount or count field. While any entry is here, the quote cannot run,
   * no PDF, Excel or reply can be made, and the saved amount is never used silently.
   */
  fieldErrors?: Partial<Record<StaffExtraField, string>>;
  /** Absent means public rates, as before. Contract rates come only from HMS-flagged rows of a picked party. */
  parties?: StaffQuoteParties;
};

/** Per-stay PDF extras. Checkbox flags preserve entered amounts when an item is temporarily disabled. */
export type StaffStayExtras = {
  shuttleEnabled: boolean;
  shuttleMinor?: number;
  shuttleTrips?: number;
  lunchEnabled: boolean;
  lunchAllowanceMinor?: number;
  lunchAllowanceLabel?: string;
  dinnerEnabled: boolean;
  /** B&B fallback requires a staff-entered dinner allowance for this stay before documents can be made. */
  dinnerAllowanceRequired?: boolean;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceUnit?: DinnerAddOnUnit;
  dinnerAllowanceGroupIds?: string[];
  dinnerAllowanceLabel?: string;
  otherEnabled: boolean;
  other?: StaffQuoteOtherCharge;
  fieldErrors?: Partial<Record<StaffExtraField, string>>;
};

export type DinnerAddOnUnit = 'per_person_per_night' | 'per_room_per_night' | 'per_person';

/** Amount and count fields whose typed text the pane reads. */
export type StaffExtraField =
  | 'dinnerAllowance'
  | 'lunchAllowance'
  | 'officeTransfer'
  | 'officeTransferDays'
  | 'shuttleAmount'
  | 'shuttleTrips'
  | 'otherAmount';

const STAFF_EXTRA_FIELD_LABELS: Record<StaffExtraField, string> = {
  dinnerAllowance: 'Dinner allowance',
  lunchAllowance: 'Lunch allowance',
  officeTransfer: 'Office transfer',
  officeTransferDays: 'Office transfer days',
  shuttleAmount: 'Shuttle price',
  shuttleTrips: 'Shuttle trips',
  otherAmount: 'Other amount',
};

/** Default each stay's checkboxes and values from email-derived or legacy quote-wide extras. */
export function defaultStaffStayExtras(header: StaffQuoteHeader): StaffStayExtras {
  return {
    shuttleEnabled: Boolean(header.shuttleRequested),
    shuttleMinor: header.shuttleMinor,
    shuttleTrips: header.shuttleTrips,
    lunchEnabled: header.lunchAllowanceMinor !== undefined,
    lunchAllowanceMinor: header.lunchAllowanceMinor,
    lunchAllowanceLabel: header.lunchAllowanceLabel,
    dinnerEnabled: header.dinnerAllowanceMinor !== undefined || header.dinnerAllowanceRequired === true,
    dinnerAllowanceRequired: header.dinnerAllowanceRequired,
    dinnerAllowanceMinor: header.dinnerAllowanceMinor,
    dinnerAllowanceUnit: header.dinnerAllowanceUnit,
    dinnerAllowanceGroupIds: header.dinnerAllowanceGroupIds,
    dinnerAllowanceLabel: header.dinnerAllowanceLabel,
    otherEnabled: Boolean(header.other?.amountMinor),
    other: header.other ?? { label: '', unit: 'item' },
    fieldErrors: header.fieldErrors,
  };
}

/** The saved stay values, falling back to legacy/email-derived header values until a stay is edited. */
export function staffStayExtrasFor(header: StaffQuoteHeader, stayKey: string): StaffStayExtras {
  const fallback = defaultStaffStayExtras(header);
  const saved = header.stayExtrasByKey?.[stayKey];
  if (!saved) return fallback;
  return {
    ...fallback,
    ...saved,
    fieldErrors: { ...fallback.fieldErrors, ...saved.fieldErrors },
  };
}

/**
 * The first unreadable or over-cap amount, as "Label: message", or null when every field reads cleanly. With
 * currentStayKeys, only those stays count: a removed stay keeps its saved extras for undo, but not its errors.
 */
export function staffHeaderFieldProblem(
  header: Pick<StaffQuoteHeader, 'fieldErrors' | 'stayExtrasByKey'> | null | undefined,
  stayKey?: string,
  currentStayKeys?: ReadonlySet<string>,
): string | null {
  const findProblem = (errors: Partial<Record<StaffExtraField, string>> | undefined) => {
    for (const field of Object.keys(STAFF_EXTRA_FIELD_LABELS) as StaffExtraField[]) {
      const message = errors?.[field];
      if (message) return `${STAFF_EXTRA_FIELD_LABELS[field]}: ${message}`;
    }
    return null;
  };
  const globalProblem = findProblem(header?.fieldErrors);
  if (globalProblem) return globalProblem;
  if (stayKey) return findProblem(header?.stayExtrasByKey?.[stayKey]?.fieldErrors);
  for (const [key, extras] of Object.entries(header?.stayExtrasByKey ?? {})) {
    if (currentStayKeys && !currentStayKeys.has(key)) continue;
    const problem = findProblem(extras.fieldErrors);
    if (problem) return problem;
  }
  return null;
}

export type StaffQuoteOtherUnit = 'per_person_night' | 'per_person' | 'per_trip' | 'item';

export type StaffQuoteOtherCharge = {
  label: string;
  amountMinor?: number;
  unit: StaffQuoteOtherUnit;
};

export function emptyStaffQuoteHeader(): StaffQuoteHeader {
  return {
    salesStrategy: 'BAR',
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };
}

/** workstation.quoteRunScreenshot result. dataUrl is a PNG data URL. */
export type QuoteRunScreenshotResult =
  | { status: 'ready'; name: string; mimeType: string; sizeBytes: number; dataUrl: string }
  | { status: 'unavailable'; reason: string };

/** workstation.hmsQueueStatus: this caller's staff quote run. `message` is plain English. */
export type QueueStatus = {
  state: 'idle' | 'running' | 'waiting' | 'unavailable';
  phase?: string;
  phaseIndex?: number;
  phaseCount?: number;
  runningForMs?: number;
  aheadCount?: number;
  etaMinutes?: number;
  message: string;
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

export type QuotePdf = {
  fileName: string;
  bytesBase64: string;
  pdfHash?: string;
  revisionId?: string;
  totalMinor?: number;
};

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
  /** Raw diagnostic text, rendered only inside the closed Details disclosure. */
  errorDetail?: string;
  roomAlternatives?: QuoteRoomAlternative[];
  shareKey?: string;
};

export type QuoteRoomAlternative = {
  groupId: string;
  roomCode: string;
  roomLabel: string;
  quantity: number;
};

export type BookingDraftRoom = {
  groupId: string;
  roomIndex: number;
  /** The board the approved quote uses. Absent on older payloads, which then copy nothing. */
  board?: QuoteBoard;
  request: Record<string, unknown>;
  schemaErrors: string[];
};

export type BookingRateCheck = {
  status: 'match' | 'mismatch' | 'cannot_check';
  claimQuote: string;
  assumedTaxBasis: boolean;
  reason?: string;
  differenceMinor?: number;
};

export type BookingDraftPayload = {
  rooms: BookingDraftRoom[];
  rateCheck: BookingRateCheck[];
  missing: Array<{ field: string; question: string }>;
  flags: string[];
};

export type BookingDraftReady = {
  draft: BookingDraftPayload;
  options: {
    track: string[];
    sourceOfBusiness: string[];
    guaranteeType: string[];
    roomType: string[];
  };
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  revisionRef: string;
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
  /** Marks generated replies that a later quote result can refresh; staff edits clear the marker. */
  reviewedReplySource?: 'missing_quote_details' | 'quote_decline' | 'quote_generated';
  /** Remembers a deliberate staff edit, including clearing the reply while a PDF is being prepared. */
  reviewedReplyEdited?: boolean;
  steps: QuoteToolStep[];
  missing: string[];
  errorMessage: string | null;
  runningStepId: string | null;
  /** Companies or agencies whose automatic HMS search has not yet decided the pick. A rates run waits for them. */
  pendingPartyKinds?: StaffQuoteParty['kind'][];
  mailboxStatus: QuoteMailboxStatus | null;
  evidence: QuoteEvidenceProvenance | null;
  partyLookup: PartyLookupRef | null;
  staffSource: StaffQuoteSource | null;
  staffQuote: StaffQuoteAllocation | null;
  /** Per-date authentic execute revisions. Combined PDF must not sum these. */
  staffQuotes: Record<string, StaffQuoteAllocation>;
  /** Per-date PDF bytes. Each option keeps its own PDF; the server issues one only for that option's latest run. */
  stayPdfs: Record<string, QuotePdf>;
  staffHeader: StaffQuoteHeader;
  staffActions: ReservationistStaffAction[];
  selectedStayKey: string | null;
  handledSourceKey: string | null;
  reviewItems: QuoteReviewItem[];
  handledReviewItemIds: string[];
  /** Rate cards for the latest run of each room group. Kept while a pinned re-run is pending. */
  rateOptions?: RateOption[];
  /** U8 booking cards, one per stay whose matching prepareBookingDraft result has arrived. */
  bookingDrafts: Record<string, BookingDraftReady>;
  /** Staff override that re-runs analyseSelection as quote or booking. */
  treatAs: 'quote' | 'create_booking' | null;
  /** Staff "Tell Luna" note re-submitted as top-priority evidence. */
  staffNote: string | null;
  /**
   * Bumped only by stay/group edits (patch_group, restored groups). Header edits bump
   * inputRevision but not this, so they never make a Tell Luna result look stale.
   */
  stayRevision: number;
  /**
   * stayRevision when the in-flight analyseSelection request started. If it has moved by
   * the time the result lands, staff edited stays during the run, so their edits are kept.
   */
  analysisStartStayRevision?: number | null;
};

/**
 * A removed stay, kept by the shell so Undo can put it back. Rates come back only when the input revision has not
 * moved since the removal.
 */
export type RemovedStay = {
  /** The email (admission) the stay was removed from. Undo on another email does nothing. */
  admission: string | null;
  rows: StayGroupRequirement[];
  index: number;
  inputRevision: number;
  /** The other stays' rows on the same dates when it was removed. Their rates come back only if these are unchanged. */
  sharedRows: StayGroupRequirement[];
  staffQuotes: Record<string, StaffQuoteAllocation>;
  stayPdfs: Record<string, QuotePdf>;
  offers: QuoteOffer[];
  rateOptions: RateOption[];
  evidence: QuoteEvidenceProvenance | null;
  /** The stay's selection, when the removed stay was the selected one. */
  selection: Pick<QuoteSession, 'phase' | 'selectedStayKey' | 'selectedOfferIds' | 'staffQuote' | 'pdf'> | null;
};

/** `token` makes the ids of rows and stays a new action creates; the reducer stays pure. */
export type StayEditAction =
  | { type: 'add_stay'; token: string }
  | { type: 'add_row'; stayId: string; token: string }
  | { type: 'duplicate_row'; groupId: string; token: string }
  | { type: 'remove_row'; groupId: string }
  | { type: 'duplicate_stay'; stayId: string; token: string }
  | { type: 'remove_stay'; stayId: string };

export type QuoteSessionAction =
  | StayEditAction
  | { type: 'restore_stay'; removal: RemovedStay }
  | { type: 'reset' }
  | { type: 'selection'; binding: QuoteSelectionBinding }
  | { type: 'analysis_started' }
  | { type: 'treat_as'; treatAs: 'quote' | 'create_booking' }
  | { type: 'staff_note'; staffNote: string }
  | { type: 'analysis_ready'; analysis: QuoteAnalysis }
  | { type: 'analysis_unsynced' }
  | { type: 'analysis_missing_source'; missing: string[]; documents?: QuoteDocumentFailure[] }
  | { type: 'analysis_failed'; message: string }
  | { type: 'handle_review_item'; itemId: string }
  | { type: 'unhandle_review_item'; itemId: string }
  | { type: 'review_documents_failed'; documents: QuoteDocumentFailure[] }
  | { type: 'staff_source_ready'; source: StaffQuoteSource }
  | { type: 'staff_actions_ready'; actions: ReservationistStaffAction[] }
  | { type: 'patch_staff_header'; header: Partial<StaffQuoteHeader> }
  | { type: 'patch_staff_stay_extras'; stayKey: string; extras: Partial<StaffStayExtras> }
  | { type: 'party_lookup_pending'; kind: StaffQuoteParty['kind']; pending: boolean }
  | { type: 'select_stay_key'; stayKey: string }
  | {
      type: 'staff_quote_ready';
      offer: QuoteOffer;
      staffQuote: StaffQuoteAllocation;
      selectionEpoch: number;
      inputRevision: number;
      reviewedReplyHtml?: string;
      extrasReviewItems?: string[];
      /** Apply without bumping inputRevision — the quote already used this header. */
      approvedHeader?: StaffQuoteHeader;
      groups?: StayGroupRequirement[];
      /**
       * The stayRevision the run read its rows at, for runs no quote step tracks. A stay edit since then makes the
       * result stale: a scoped stay edit does not move inputRevision.
       */
      stayRevision?: number;
    }
  | { type: 'booking_draft_ready'; payload: BookingDraftReady; sourceHash: string }
  | { type: 'analysis_unsupported'; message: string }
  | { type: 'patch_group'; groupId: string; patch: Partial<StayGroupRequirement> }
  | { type: 'staff_dinner_bb_fallback'; groupIds: string[] }
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
      detail?: string;
      alternatives?: QuoteRoomAlternative[];
      /** A one-line reply for an explicit no-rate/refusal result; alternatives remain staff-only. */
      declineReplyHtml?: string;
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
  | { type: 'step_stale'; stepId: string; selectionEpoch: number; inputRevision: number }
  | { type: 'step_failed'; stepId: string; retryGuidance: string }
  | {
      type: 'pdf_ready';
      pdf: QuotePdf;
      selectionEpoch: number;
      inputRevision: number;
      selectedOfferIds: string[];
      reviewedReplyHtml?: string;
    }
  | { type: 'set_reviewed_reply'; html: string; source?: 'missing_quote_details' | 'quote_decline'; staffEdited?: boolean }
  | { type: 'select_offers'; offerIds: string[] }
  | { type: 'mailbox_status'; status: QuoteMailboxStatus | null };
