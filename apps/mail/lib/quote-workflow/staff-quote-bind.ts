import type {
  PrepareBookingDraftInput,
  PrepareBookingDraftResult,
  PrepareUnquotedBookingDraftInput,
  UsePriorQuoteForBookingInput,
  UsePriorQuoteForBookingReady,
} from './booking-draft-bind';
import { HMS_JOB_MAX_MISSES, HMS_JOB_POLL_MS } from './amend-find';
import { getMailCacheScope, inMailbox } from '../mail/mail-cache-scope';
import type {
  QueueStatus,
  QuoteOffer,
  QuoteRunScreenshotResult,
  RateOption,
  ReservationistPreparedTask,
  ReservationistStaffAction,
  StaffQuoteAllocation,
  StaffQuoteHeader,
  StaffQuoteParties,
  StaffQuoteOtherUnit,
  StaffQuoteParty,
  StaffQuoteSource,
  QuoteRoomAlternative,
  DinnerAddOnUnit,
  StaffRowRate,
  StaffStayExtras,
  StayGroupRequirement,
  AvailabilityBoardRow,
  QuoteSalesStrategy,
  QuoteSalesStrategyCode,
  QuoteSalesStrategyValue,
  QuoteStrategyRow,
  QuoteFailureCauseClass,
} from './types';
import {
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  HRDAV_ROOM_NAMES,
  staffHeaderFieldProblem,
  staffStayExtrasFor,
} from './types';
import { knownRoomCode, matchConfiguredRoomType, normaliseRoomLabel, ROOM_TYPE_CODES, unpickedTwinRoomCode } from './room-types';

const SOURCE_HASH = /^[a-f0-9]{64}$/;
/** Exact Centurion native room-type codes, from the room-types map. Labels such as SINGLE are not codes. */
export const KNOWN_NATIVE_ROOM_CODES: ReadonlySet<string> = new Set<string>(ROOM_TYPE_CODES);
const HRDAV_NATIVE_ROOM_CODES: ReadonlySet<string> = new Set<string>(Object.keys(HRDAV_ROOM_NAMES));
const EMPTY_NATIVE_ROOM_CODES: ReadonlySet<string> = new Set<string>();

function nativeRoomCodeList(propertyCode?: string): ReadonlySet<string> {
  if (propertyCode === HRDAV_PROPERTY_CODE) return HRDAV_NATIVE_ROOM_CODES;
  if (propertyCode === undefined || propertyCode === HRCEN_PROPERTY_CODE) return KNOWN_NATIVE_ROOM_CODES;
  return EMPTY_NATIVE_ROOM_CODES;
}

export type NativeRoomCodeResolution =
  | { status: 'omitted' }
  | { status: 'codes'; codes: string[] }
  | { status: 'unresolved'; label: string };

export const STAFF_QUOTE_BIND_TARGETS = {
  staffActions: 'drafts.toDraftWire reviewSummary.staffActions',
  staffQuoteSource: 'workstation.staffQuoteSource',
  executeStaffQuote: 'workstation.executeStaffQuote',
  queueStaffQuote: 'workstation.queueStaffQuote',
  staffQuoteJob: 'workstation.staffQuoteJob',
  qualifiedPdf: 'workstation.qualifiedQuoteProposalPdf',
  snapshot: 'backend scoped snapshot after focused verification',
} as const;

export type StaffQuoteGroupInput = {
  id: string;
  arrivalDate: string;
  departureDate: string;
  quantity: number;
  adults: number;
  childrenAges: number[];
  board: 'room_only' | 'bb' | 'dinner_bb';
  roomCodes?: string[];
  /** The HMS rate a rate card pinned. Absent means HMS picks the rate, as before. */
  rateCode?: string;
};

/** A row price as the server reads it (staffRowPriceInput). A saved rate is named by id only. */
export type StaffRowPriceWire =
  | { groupId: string; source: 'saved'; customRateId: string }
  | { groupId: string; source: 'one_off'; oneOffRate: number }
  | { groupId: string; source: 'override'; rateCode: string; overrideRate: number; note: string };

export type ExecuteStaffQuoteInput = {
  messageId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  groups: StaffQuoteGroupInput[];
  salesStrategy: QuoteSalesStrategyValue;
  company: string;
  agency: string;
  attention: string;
  clientEmail: string;
  clientTelephone: string;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceUnit?: DinnerAddOnUnit;
  dinnerAllowanceGroupIds?: string[];
  dinnerAllowanceLabel?: string;
  lunchAllowanceMinor?: number;
  lunchAllowanceLabel?: string;
  officeTransferMinor?: number;
  officeTransferDays?: number;
  shuttleRequested?: boolean;
  shuttleMinor?: number;
  shuttleTrips?: number;
  other?: { label: string; amountMinor: number; unit: StaffQuoteOtherUnit };
  notes?: string;
  /** Sent only when staff picked a company or agency in HMS. Without one the request is unchanged. */
  parties?: StaffQuoteParties;
  /** Sent only when staff priced a row. Without one the request is unchanged. */
  rowPrices?: StaffRowPriceWire[];
  /** All-room BAR search. Absent when a room type is already pinned. */
  maxOptionsPerGroup?: number;
};

export type ExecuteStaffQuoteResult = {
  status: 'ready';
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  threadId: string;
  factRefs: string[];
  extrasReviewItems?: string[];
  selectionEpoch: number;
  inputRevision: number;
  inputDigest: string;
  totalMinor: number;
  currency: string;
  arrivalDate: string;
  departureDate: string;
  description: string;
  /** Optional so a pane built before the server change still parses the result. */
  runId?: string | null;
  screenshots?: string[];
  dinnerAddOnRequired?: boolean;
  dinnerFallbackGroupIds?: string[];
  dinnerAddOn?: { label: string; amountMinor: number; unit: DinnerAddOnUnit; totalMinor: number };
  /** Optional: an older server sends none. */
  rateOptions?: RateOption[];
  /** Optional: an older server sends none. */
  availabilityBoard?: AvailabilityBoardRow[];
  availabilityTruncated?: boolean;
  /** Optional: an older server sends none. */
  rowRates?: StaffRowRate[];
};

export type StaffQuoteJobView = {
  runId: string;
  status: 'queued' | 'running' | 'retrying' | 'done' | 'failed';
  request?: { kind: 'staff_quote'; input: ExecuteStaffQuoteInput } | null;
  prefetch?: boolean;
  result: Record<string, unknown> | null;
  failureClass: string | null;
  asOf?: string | null;
};

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

const STAFF_QUOTE_NON_PRICE_FIELDS = new Set(
  'messageId sourceHash selectionEpoch inputRevision company agency attention clientEmail clientTelephone dinnerAllowanceLabel lunchAllowanceLabel notes maxOptionsPerGroup'.split(' '),
);

function staffQuoteRequestMatches(
  request: StaffQuoteJobView['request'],
  expected: ExecuteStaffQuoteInput,
  allowBoundStrategyMismatch = false,
): boolean {
  if (request?.kind !== 'staff_quote' || request.input.messageId !== expected.messageId ||
    request.input.sourceHash !== expected.sourceHash) return false;
  const boundParties = pickedParties(request.input.parties);
  const canIgnoreStrategy = allowBoundStrategyMismatch && boundParties !== undefined &&
    stableJson(boundParties) === stableJson(pickedParties(expected.parties));
  if (request.input.salesStrategy !== expected.salesStrategy && !canIgnoreStrategy) return false;
  const priceKey = (input: ExecuteStaffQuoteInput) => stableJson({
    ...Object.fromEntries(Object.entries(input).filter(([key]) => !STAFF_QUOTE_NON_PRICE_FIELDS.has(key))),
    ...(canIgnoreStrategy ? { salesStrategy: expected.salesStrategy } : {}),
    groups: input.groups.map((group) => ({
      id: group.id, arrivalDate: group.arrivalDate, departureDate: group.departureDate, quantity: group.quantity,
      adults: group.adults, childrenAges: group.childrenAges, board: group.board,
      roomCodes: [...(group.roomCodes ?? [])].sort(), rateCode: group.rateCode ?? null,
    })),
  });
  return priceKey(request.input) === priceKey(expected);
}

function staffQuoteStayTermsMatch(
  request: StaffQuoteJobView['request'],
  expected: ExecuteStaffQuoteInput,
): boolean {
  if (request?.kind !== 'staff_quote') return false;
  const terms = (groups: ExecuteStaffQuoteInput['groups']) =>
    stableJson(
      groups.map((group) => ({
        arrivalDate: group.arrivalDate,
        departureDate: group.departureDate,
        quantity: group.quantity,
        adults: group.adults,
        childrenAges: group.childrenAges,
        board: group.board,
        roomCodes: [...(group.roomCodes ?? [])].sort(),
      })),
    );
  return terms(request.input.groups) === terms(expected.groups);
}

type StaffQuoteCallOptions = {
  signal?: AbortSignal;
  context?: { activeTransportId: string };
};

export type StaffQuoteJobQuery = (
  input: { runId: string } | { input: ExecuteStaffQuoteInput },
  options?: StaffQuoteCallOptions,
) => Promise<StaffQuoteJobView | null>;

export type StaffQuoteJobQueue = (
  input: ExecuteStaffQuoteInput & { autoStart?: true },
  options?: StaffQuoteCallOptions,
) => Promise<{ runId: string | null }>;

function isExecuteStaffQuoteResult(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ExecuteStaffQuoteResult {
  const nonEmptyString = (field: unknown): field is string =>
    typeof field === 'string' && field.trim().length > 0;
  return (
    value.status === 'ready' &&
    nonEmptyString(value.workflowRunId) &&
    nonEmptyString(value.revisionRef) &&
    nonEmptyString(value.messageId) &&
    nonEmptyString(value.threadId) &&
    Array.isArray(value.factRefs) &&
    value.factRefs.every((ref) => typeof ref === 'string') &&
    typeof value.selectionEpoch === 'number' &&
    Number.isSafeInteger(value.selectionEpoch) &&
    typeof value.inputRevision === 'number' &&
    Number.isSafeInteger(value.inputRevision) &&
    nonEmptyString(value.inputDigest) &&
    typeof value.totalMinor === 'number' &&
    Number.isSafeInteger(value.totalMinor) &&
    typeof value.currency === 'string' &&
    nonEmptyString(value.arrivalDate) &&
    nonEmptyString(value.departureDate) &&
    typeof value.description === 'string'
  );
}

export type StaffQuoteSourceResult =
  | { status: 'ready'; messageId: string; threadId: string; sourceHash: string }
  | { status: 'message_not_synced' };

/** One further stay of a combined quote: its own attested run. */
export type QualifiedStayRun = {
  workflowRunId: string;
  revisionRef: string;
  factRefs: string[];
  notes?: string;
};

export type QualifiedStaffPdfInput = {
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  outlookEmail: string;
  factRefs: string[];
  attention: string;
  company: string;
  clientEmail: string;
  clientTelephone: string;
  agency: string;
  notes?: string;
  /** A combined quote: the other stays' runs. Absent for one stay. */
  additionalStays?: QualifiedStayRun[];
};

export type QualifiedStaffPdfResult = {
  revisionId: string;
  pdfHash: string;
  fileName: string;
  pdfBase64: string;
  totalMinor: number;
};

/** workstation.quoteWorkbook: the Excel for the same approved revision the PDF uses. */
export type QualifiedStaffWorkbookResult = {
  fileName: string;
  xlsxBase64: string;
  totalMinor: number;
  revisionId: string;
};

function bytesFromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function rejectionReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'The request did not finish. Refresh the pane and try again.';
}

/** True for markup brackets or C0 control characters, which never belong in an HMS label. */
function hasMarkupOrControl(value: string): boolean {
  return [...value].some((character) => character === '<' || character === '>' || character.codePointAt(0)! <= 0x1f);
}

// Staff labels such as "Children < 12" are plain text and every renderer escapes them, so only control characters fail.
function hasControl(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function shortRefusalReason(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0]!;
  const cleaned = [...firstLine]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
    })
    .join('')
    .replace(/(?:^|[\s/])[A-Z0-9_-]*TRACE(?:[-_ ]?(?:ID))?[-_: ]*[A-Z0-9._-]+/gi, ' ')
    .replace(/\b(?:request|correlation)[-_ ]?(?:id)?\s*[:=]?\s*[A-Z0-9._-]{8,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s/:]+$/g, '')
    .trim();
  return cleaned.slice(0, 100) || 'Search was refused.';
}

/** A rejected quote request is shown in plain language; the complete error is kept for the closed Details disclosure. */
export function readQuoteRoomAlternatives(value: unknown): QuoteRoomAlternative[] {
  if (!Array.isArray(value)) return [];
  const alternatives: QuoteRoomAlternative[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.groupId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.groupId) ||
      typeof row.roomCode !== 'string' || !/^[A-Z0-9_-]{1,16}$/.test(row.roomCode) ||
      typeof row.roomLabel !== 'string' || !row.roomLabel.trim() || row.roomLabel.length > 120 || hasMarkupOrControl(row.roomLabel) ||
      !Number.isSafeInteger(row.quantity) || (row.quantity as number) < 1 || (row.quantity as number) > 100
    ) continue;
    const key = `${row.groupId}|${row.roomCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push({ groupId: row.groupId, roomCode: row.roomCode, roomLabel: row.roomLabel.trim(), quantity: row.quantity as number });
  }
  return alternatives;
}

function roomAlternativesFromError(error: unknown): QuoteRoomAlternative[] {
  if (!error || typeof error !== 'object') return [];
  const root = error as Record<string, unknown>;
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const cause = data.cause && typeof data.cause === 'object'
    ? data.cause as Record<string, unknown>
    : root.cause && typeof root.cause === 'object'
      ? root.cause as Record<string, unknown>
      : {};
  return readQuoteRoomAlternatives(root.alternatives ?? data.alternatives ?? cause.alternatives);
}

function searchFailure(error: unknown): { reason: string; detail?: string; noMatchingRate?: boolean; alternatives?: QuoteRoomAlternative[] } {
  const detail = rejectionReason(error);
  const alternatives = roomAlternativesFromError(error);
  const withAlternatives = (value: { reason: string; detail?: string; noMatchingRate?: boolean }) =>
    alternatives.length ? { ...value, alternatives } : value;
  const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined;
  const isServerRefusal =
    data && typeof data === 'object' && 'code' in data && data.code === 'PRECONDITION_FAILED';
  if (detail.startsWith(NATIVE_NO_MATCHING_RATE_PREFIX)) {
    return withAlternatives({
      reason: 'HMS refused the search: No rate matches this meal plan under the selected rate plan.',
      detail,
      noMatchingRate: true,
    });
  }
  const refusal = /^HMS refused the search:\s*(.*)$/i.exec(detail);
  if (refusal) return withAlternatives({ reason: `HMS refused the search: ${shortRefusalReason(refusal[1] ?? '')}`, detail });
  if (/^(?:only\s+\d+\b|hms has only\s+\d+\b)/i.test(detail)) {
    return withAlternatives({ reason: `HMS refused the search: ${shortRefusalReason(detail)}`, detail });
  }
  if (isServerRefusal) return withAlternatives({ reason: detail, detail });
  if (/\b(?:timed?\s*out|timeout|deadline exceeded|ETIMEDOUT)\b/i.test(detail)) {
    return withAlternatives({ reason: "HMS didn't answer in time.", detail });
  }
  return withAlternatives({ reason: "HMS didn't answer in time.", detail });
}

export const EXPIRED_STAFF_QUOTE_COPY = 'This quote has expired. Run the quote again.';

/** workstation.qualifiedQuoteProposalPdf messages for a quote run that is unrecorded or expired. */
const EXPIRED_STAFF_QUOTE_SERVER_MESSAGES = new Set([
  'Proposal source not found',
  // HMS rates back a PDF for 15 minutes; after that the server refuses the evidence as not ready.
  'Proposal evidence is not ready',
  'Proposal evidence expired during conversion',
]);

/** Plain staff copy for a PDF rejection; expired or unrecorded runs get the re-quote copy. */
export function qualifiedPdfFailureReason(error: unknown): string {
  if (error instanceof Error && EXPIRED_STAFF_QUOTE_SERVER_MESSAGES.has(error.message.trim()))
    return EXPIRED_STAFF_QUOTE_COPY;
  return rejectionReason(error);
}

function hrdavKnownCode(raw: string): string | null {
  const code = raw.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (HRDAV_NATIVE_ROOM_CODES.has(code)) return code;
  const rooms = (Object.entries(HRDAV_ROOM_NAMES) as Array<[string, string]>).map(([code, label]) => ({ code, label }));
  return matchConfiguredRoomType([raw], rooms)?.code ?? null;
}

function knownNativeCode(raw: string, propertyCode?: string): string | null {
  if (propertyCode === HRDAV_PROPERTY_CODE) return hrdavKnownCode(raw);
  if (propertyCode === HRCEN_PROPERTY_CODE || propertyCode === undefined) {
    return knownRoomCode(normaliseRoomLabel(raw)) ?? knownRoomCode(raw);
  }
  return null;
}

export function resolveNativeRoomCodes(input: {
  roomPreference?: string;
  roomCodes?: string[];
  propertyCode?: string;
}): NativeRoomCodeResolution {
  if (input.roomCodes?.length) {
    const codes: string[] = [];
    for (const raw of input.roomCodes) {
      const code = knownNativeCode(raw, input.propertyCode);
      if (!code) return { status: 'unresolved', label: raw.trim() || '(empty code)' };
      codes.push(code);
    }
    return { status: 'codes', codes };
  }
  const raw = input.roomPreference?.trim() ?? '';
  if (!raw) return { status: 'omitted' };
  const twin =
    input.propertyCode === HRDAV_PROPERTY_CODE ||
    (input.propertyCode !== undefined && input.propertyCode !== HRCEN_PROPERTY_CODE)
      ? null
      : unpickedTwinRoomCode(raw);
  const code = knownNativeCode(raw, input.propertyCode) ?? twin ?? null;
  if (code) return { status: 'codes', codes: [code] };
  return { status: 'unresolved', label: raw };
}

/** @deprecated Use resolveNativeRoomCodes. Returns codes only for known native types. */
export function nativeRoomCodes(preference: string | undefined): string[] | undefined {
  const resolved = resolveNativeRoomCodes({ roomPreference: preference });
  return resolved.status === 'codes' ? resolved.codes : undefined;
}

export function splitStayGroups(groups: readonly StayGroupRequirement[]): StayGroupRequirement[][] {
  const byDates = new Map<string, StayGroupRequirement[]>();
  for (const group of groups) {
    const key = `${group.arrivalDate ?? ''}:${group.departureDate ?? ''}`;
    const list = byDates.get(key) ?? [];
    list.push(group);
    byDates.set(key, list);
  }
  return [...byDates.values()];
}

export function staffQuoteGroupsFromStay(
  groups: readonly StayGroupRequirement[],
  propertyCode?: string,
): { ok: StaffQuoteGroupInput[] } | { error: string } {
  if (
    propertyCode !== undefined &&
    propertyCode !== HRCEN_PROPERTY_CODE &&
    propertyCode !== HRDAV_PROPERTY_CODE
  ) {
    return { error: 'Could not identify the hotel for this mailbox. Refresh the pane before running the quote.' };
  }
  const out: StaffQuoteGroupInput[] = [];
  for (const group of groups) {
    if (!group.arrivalDate || !group.departureDate) {
      return { error: 'Enter the arrival and departure dates before running the quote.' };
    }
    if (group.board === 'unknown' || (propertyCode === HRDAV_PROPERTY_CODE && group.board === 'dinner_bb')) {
      return { error: 'Choose a meal plan for the stay before running the quote.' };
    }
    if (typeof group.quantity !== 'number' || typeof group.adults !== 'number') {
      return { error: 'Enter the number of rooms and adults before running the quote.' };
    }
    // Empty preference (no staff room pick) omits roomCodes so HMS returns every type for the BAR grid.
    // An explicit code list or a known preference still binds; garbage codes still refuse below.
    const rooms = resolveNativeRoomCodes({
      roomPreference: group.roomPreference,
      roomCodes: group.roomCodes?.length ? group.roomCodes : undefined,
      propertyCode,
    });
    // Ambiguous mail wording stays visible/editable, but its defaulted provenance means any type.
    if (rooms.status === 'unresolved' && group.fields.roomPreference !== 'defaulted') {
      return {
        error: `Not in this hotel's room list: "${rooms.label}". Choose one of: ${[...nativeRoomCodeList(propertyCode)].join(', ')}.`,
      };
    }
    out.push({
      id: group.id,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      adults: group.adults,
      childrenAges: [...group.childrenAges],
      board: group.board,
      ...(rooms.status === 'codes' ? { roomCodes: rooms.codes } : {}),
      ...(group.rateCode ? { rateCode: group.rateCode } : {}),
    });
  }
  const dates = new Set(out.map((group) => `${group.arrivalDate}/${group.departureDate}`));
  if (dates.size !== 1) {
    return { error: 'Each date range needs its own quote. Run them one at a time.' };
  }
  return { ok: out };
}

export function readStaffActions(value: unknown): ReservationistStaffAction[] {
  if (!value || typeof value !== 'object') return [];
  const envelope = value as { runId?: unknown; workItemId?: unknown; reviewSummary?: { staffActions?: unknown } };
  const summary = envelope.reviewSummary;
  const raw = summary?.staffActions ?? (value as { staffActions?: unknown }).staffActions;
  if (!Array.isArray(raw)) return [];
  const actions: ReservationistStaffAction[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const action = row as Record<string, unknown>;
    if (action.status !== 'open') continue;
    if (action.kind !== 'unanswered_question' && action.kind !== 'business_document_failure' && action.kind !== 'pricing_fact' && action.kind !== 'voucher_review') {
      continue;
    }
    if (typeof action.id !== 'string' || !action.id.trim()) continue;
    if (typeof action.text !== 'string' || !action.text.trim()) continue;
    if (typeof action.sourceRef !== 'string' || !action.sourceRef.trim()) continue;
    const metadataOnly = action.sourceIdentity === 'metadata_only' && action.sourceHash === undefined &&
      action.kind === 'business_document_failure' && action.sourceKind === 'attachment' &&
      typeof action.messageId === 'string' && !!action.messageId.trim();
    if (action.sourceIdentity === 'metadata_only' && !metadataOnly) continue;
    if (!metadataOnly && (typeof action.sourceHash !== 'string' || !SOURCE_HASH.test(action.sourceHash))) continue;
    if (action.kind === 'voucher_review' && (action.sourceKind !== 'message' || typeof action.messageId !== 'string' ||
        action.sourceRef !== `message:${action.messageId}`)) continue;
    if (typeof action.blockingQuote !== 'boolean') continue;
    actions.push({
      id: action.id,
      kind: action.kind,
      text: action.text,
      sourceRef: action.sourceRef,
      ...(typeof action.sourceHash === 'string' ? { sourceHash: action.sourceHash } : {}),
      ...(metadataOnly ? { sourceIdentity: 'metadata_only' as const } : {}),
      blockingQuote: action.blockingQuote,
      status: 'open',
      ...(action.sourceKind === 'message' || action.sourceKind === 'attachment'
        ? { sourceKind: action.sourceKind }
        : {}),
      ...(typeof action.messageId === 'string' && action.messageId.trim()
        ? { messageId: action.messageId }
        : {}),
      ...(typeof action.filename === 'string' && action.filename.trim()
        ? { filename: action.filename }
        : {}),
      ...(typeof action.reason === 'string' && action.reason.trim() ? { reason: action.reason } : {}),
      ...(action.kind === 'business_document_failure' && action.readable === true ? { readable: true } : {}),
      ...(typeof action.handled === 'boolean' ? { handled: action.handled } : {}),
      ...(typeof envelope.runId === 'string' && envelope.runId ? { runId: envelope.runId } : {}),
      ...(typeof envelope.workItemId === 'string' && envelope.workItemId ? { workItemId: envelope.workItemId } : {}),
    });
  }
  return actions;
}

/** The draft summary is display-only; the stored packet remains the action authority. */
export function readPreparedStaffTasks(value: unknown): ReservationistPreparedTask[] {
  if (!value || typeof value !== 'object') return [];
  const envelope = value as { runId?: unknown; workItemId?: unknown; reviewSummary?: { tasks?: unknown } };
  const summary = envelope.reviewSummary;
  if (!Array.isArray(summary?.tasks)) return [];
  const kinds = new Set(['quote', 'new_booking', 'acceptance', 'change', 'cancel_request', 'booking', 'channel_booking_sync', 'question', 'existing_document']);
  const tasks: ReservationistPreparedTask[] = [];
  const ids = new Set<string>();
  for (const item of summary.tasks) {
    if (!item || typeof item !== 'object') continue;
    const task = item as Record<string, unknown>;
    if (typeof task.id !== 'string' || !task.id.trim()) continue;
    const runId = typeof task.runId === 'string' ? task.runId : envelope.runId;
    const identity = JSON.stringify([runId ?? '', task.id]);
    if (ids.has(identity)) continue;
    if (typeof task.kind !== 'string' || !kinds.has(task.kind)) continue;
    if (typeof task.label !== 'string' || !task.label.trim()) continue;
    if (task.state !== 'Ready' && task.state !== 'Pending staff action' && task.state !== 'Needs review') continue;
    const allDetails = Array.isArray(task.details) ? task.details.filter((detail): detail is string => typeof detail === 'string' && !!detail.trim()) : [];
    const details = allDetails.length > 400
      ? [...allDetails.slice(0, 395), 'Some prepared details are not shown. Check the request and HMS.', ...allDetails.slice(-5)]
      : allDetails;
    ids.add(identity);
    const completion = typeof runId === 'string' && typeof envelope.workItemId === 'string' && typeof task.handled === 'boolean'
      ? { runId, workItemId: envelope.workItemId, handled: task.handled } : {};
    tasks.push({ id: task.id, kind: task.kind, label: task.label, state: task.state, details,
      ...(task.earlier === true ? { earlier: true } : {}), ...completion });
  }
  return tasks;
}

const RATE_OPTION_BOARDS = new Set<string>(['room_only', 'bb', 'dinner_bb']);

/**
 * The rate options on a staff quote result. An older server sends none, so the list is empty. A row missing a field
 * the cards need is dropped, so one bad row never breaks the quote.
 */
export function readRateOptions(value: unknown): RateOption[] {
  if (!Array.isArray(value)) return [];
  const options: RateOption[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    if (
      typeof raw.id !== 'string' ||
      typeof raw.groupId !== 'string' ||
      typeof raw.board !== 'string' ||
      !RATE_OPTION_BOARDS.has(raw.board) ||
      typeof raw.rateCode !== 'string' ||
      typeof raw.roomCode !== 'string' ||
      !Number.isSafeInteger(raw.perNightMinor) ||
      !Number.isSafeInteger(raw.totalMinor)
    ) {
      continue;
    }
    options.push({
      id: raw.id,
      groupId: raw.groupId,
      board: raw.board as RateOption['board'],
      boardLabel: typeof raw.boardLabel === 'string' ? raw.boardLabel : '',
      rateCode: raw.rateCode,
      rateLabel: typeof raw.rateLabel === 'string' ? raw.rateLabel : '',
      roomCode: raw.roomCode,
      roomLabel: typeof raw.roomLabel === 'string' ? raw.roomLabel : '',
      contract: raw.contract === true,
      onlyContract: raw.onlyContract === true,
      matchesRequest: raw.matchesRequest !== false,
      perNightMinor: raw.perNightMinor as number,
      totalMinor: raw.totalMinor as number,
      currency: typeof raw.currency === 'string' ? raw.currency : 'ZAR',
      priced: raw.priced === 'summary' ? 'summary' : 'full',
      selected: raw.selected === true,
      ...(raw.incomplete === true ? { incomplete: true } : {}),
      ...(typeof raw.roomsLeft === 'number' &&
      Number.isFinite(raw.roomsLeft) &&
      Number.isInteger(raw.roomsLeft) &&
      raw.roomsLeft >= 0
        ? { roomsLeft: raw.roomsLeft }
        : {}),
      ...(raw.hint === 'event_rate' ? { hint: 'event_rate' as const } : {}),
    });
  }
  return options;
}

function readAvailabilityBoard(value: unknown): AvailabilityBoardRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AvailabilityBoardRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    if (typeof raw.roomCode !== 'string' || typeof raw.rateCode !== 'string') continue;
    const nightlyPriceMinor =
      typeof raw.nightlyPriceMinor === 'number' && Number.isSafeInteger(raw.nightlyPriceMinor) && raw.nightlyPriceMinor > 0
        ? raw.nightlyPriceMinor
        : null;
    const roomsLeft =
      typeof raw.roomsLeft === 'number' && Number.isInteger(raw.roomsLeft) && raw.roomsLeft >= 0
        ? raw.roomsLeft
        : null;
    const rateScope =
      raw.rateScope === 'public' || raw.rateScope === 'contextual' || raw.rateScope === 'unknown'
        ? raw.rateScope
        : undefined;
    rows.push({
      groupId: typeof raw.groupId === 'string' ? raw.groupId : '',
      roomCode: raw.roomCode,
      roomLabel: typeof raw.roomLabel === 'string' ? raw.roomLabel : raw.roomCode,
      rateCode: raw.rateCode,
      rateLabel: typeof raw.rateLabel === 'string' ? raw.rateLabel : raw.rateCode,
      board: typeof raw.board === 'string' ? raw.board : '',
      boardLabel: typeof raw.boardLabel === 'string' ? raw.boardLabel : typeof raw.board === 'string' ? raw.board : '',
      nightlyPriceMinor,
      roomsLeft,
      ...(rateScope ? { rateScope } : {}),
    });
  }
  return rows;
}

/** The row prices on these rows, in the shape the server reads. A row without a price is left out, so HMS prices it. */
export function rowPricesFor(groups: readonly StayGroupRequirement[]): StaffRowPriceWire[] {
  return groups.flatMap((group): StaffRowPriceWire[] => {
    const price = group.rowPrice;
    if (!price) return [];
    if (price.source === 'saved') return [{ groupId: group.id, source: 'saved', customRateId: price.customRateId }];
    if (price.source === 'one_off') return [{ groupId: group.id, source: 'one_off', oneOffRate: price.amountMinor }];
    return [
      {
        groupId: group.id,
        source: 'override',
        rateCode: price.rateCode,
        overrideRate: price.amountMinor,
        note: price.note,
      },
    ];
  });
}

const ROW_RATE_SOURCES = new Set<string>(['hms', 'saved', 'one_off', 'override']);

/** The charged rate of each row on a run. A malformed row is dropped, so one bad row never breaks the quote. */
export function readRowRates(value: unknown): StaffRowRate[] {
  if (!Array.isArray(value)) return [];
  const isMoneyList = (list: unknown): list is number[] =>
    Array.isArray(list) && list.every((amount) => Number.isSafeInteger(amount));
  const rates: StaffRowRate[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    if (
      typeof raw.groupId !== 'string' ||
      typeof raw.source !== 'string' ||
      !ROW_RATE_SOURCES.has(raw.source) ||
      !isMoneyList(raw.hmsNightlyMinor) ||
      !isMoneyList(raw.nightlyMinor)
    ) {
      continue;
    }
    rates.push({
      groupId: raw.groupId,
      source: raw.source as StaffRowRate['source'],
      hmsNightlyMinor: raw.hmsNightlyMinor,
      nightlyMinor: raw.nightlyMinor,
      ...(typeof raw.customRateName === 'string' ? { customRateName: raw.customRateName } : {}),
      ...(typeof raw.rateCode === 'string' ? { rateCode: raw.rateCode } : {}),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
      ...(typeof raw.hmsComment === 'string' ? { hmsComment: raw.hmsComment } : {}),
    });
  }
  return rates;
}

/** Rate code and nightly amount the quote panel reads from a prepared staff_quote. */
export function preparedStayRate(
  group: StayGroupRequirement,
  quote?: StaffQuoteAllocation | null,
): { rateCode: string; amountMinor: number | null } {
  const row = quote?.rowRates?.find((item) => item.groupId === group.id);
  const selected = quote?.rateOptions?.find((item) => item.groupId === group.id && item.selected);
  const rateCode = (row?.rateCode ?? selected?.rateCode ?? group.rateCode ?? group.quotedRateCode ?? '').trim();
  const amountMinor = row?.nightlyMinor[0] ?? selected?.perNightMinor ?? group.quotedAmountMinor ?? group.rowPrice?.amountMinor ?? null;
  return { rateCode, amountMinor };
}

export function groupsWithPreparedStayRates(
  groups: StayGroupRequirement[],
  quote: StaffQuoteAllocation,
  groupIds: ReadonlySet<string>,
): StayGroupRequirement[] {
  return groups.map((group) => {
    if (!groupIds.has(group.id)) return group;
    const prepared = preparedStayRate(group, quote);
    if (!prepared.rateCode && prepared.amountMinor == null) return group;
    return {
      ...group,
      ...(prepared.rateCode ? { quotedRateCode: prepared.rateCode } : {}),
      ...(prepared.amountMinor != null ? { quotedAmountMinor: prepared.amountMinor } : {}),
    };
  });
}

export type BoundStaffSource =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'message_not_synced' }
  | { kind: 'ready'; source: StaffQuoteSource };

export async function bindStaffQuoteSource(args: {
  query?: (input: { internetMessageId: string }) => Promise<StaffQuoteSourceResult>;
  internetMessageId?: string;
}): Promise<BoundStaffSource> {
  const internetMessageId = args.internetMessageId?.trim();
  if (!internetMessageId) {
    return { kind: 'unavailable', reason: 'The selected email is not ready yet. Select it again.' };
  }
  if (!args.query) {
    return {
      kind: 'unavailable',
      reason: 'The email is not ready for quoting yet. Wait a moment, then select it again.',
    };
  }
  try {
    const result = await args.query({ internetMessageId });
    if (result.status === 'message_not_synced') return { kind: 'message_not_synced' };
    if (
      result.status !== 'ready' ||
      !result.messageId?.trim() ||
      !result.threadId?.trim() ||
      !SOURCE_HASH.test(result.sourceHash)
    ) {
      return { kind: 'unavailable', reason: 'The email could not be verified. Select it again.' };
    }
    return {
      kind: 'ready',
      source: { messageId: result.messageId, threadId: result.threadId, sourceHash: result.sourceHash },
    };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error) };
  }
}

export type BoundStaffActions =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; actions: ReservationistStaffAction[]; tasks?: ReservationistPreparedTask[] };

export async function bindStaffActions(args: {
  query?: (input: { threadId: string; messageId: string; workItemId?: string }) => Promise<unknown>;
  threadId?: string;
  messageId?: string;
  workItemId?: string;
}): Promise<BoundStaffActions> {
  if (!args.threadId?.trim() || !args.messageId?.trim()) {
    return { kind: 'unavailable', reason: 'Actions for this email are not ready yet. Select it again.' };
  }
  if (!args.query) {
    return { kind: 'unavailable', reason: 'Email actions cannot be loaded from this pane yet. Refresh the pane and try again.' };
  }
  try {
    const source = await args.query({ threadId: args.threadId, messageId: args.messageId,
      ...(args.workItemId ? { workItemId: args.workItemId } : {}) });
    if (source == null) return { kind: 'ready', actions: [] };
    if (typeof source !== 'object' || (source as { replyToMessageId?: unknown }).replyToMessageId !== args.messageId)
      return { kind: 'unavailable', reason: 'The email review changed. Select it again.' };
    const tasks = readPreparedStaffTasks(source);
    return { kind: 'ready', actions: readStaffActions(source), ...(tasks.length ? { tasks } : {}) };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error) };
  }
}

/** Must match NATIVE_NO_MATCHING_RATE_PREFIX in apps/server-pilot/src/trpc/routes/workstation.ts. */
const NATIVE_NO_MATCHING_RATE_PREFIX = 'HMS has no rate for this meal plan under ';

export type BoundExecuteStaffQuote =
  | { status: 'unavailable'; reason: string; detail?: string; noMatchingRate?: boolean; alternatives?: QuoteRoomAlternative[] }
  | { status: 'ok'; offer: QuoteOffer; staffQuote: StaffQuoteAllocation; extrasReviewItems: string[] };

export function isStaffQuoteRefusal(
  result: Pick<Extract<BoundExecuteStaffQuote, { status: 'unavailable' }>, 'reason' | 'noMatchingRate'>,
): boolean {
  return result.noMatchingRate === true ||
    /^HMS refused the search:/i.test(result.reason) ||
    /^(?:only\s+\d+\b|hms has only\s+\d+\b)/i.test(result.reason);
}

export function allocationFromStaffQuote(
  result: ExecuteStaffQuoteResult,
  groups: readonly StayGroupRequirement[],
): QuoteOffer {
  return {
    id: result.revisionRef,
    kind: 'allocation',
    roomCode: '',
    roomLabel: result.description.trim() || 'Selected room option',
    board: groups[0]?.board === 'unknown' ? 'bb' : groups[0]?.board ?? 'bb',
    rateCode: '',
    currency: 'ZAR',
    nightly: [],
    stayTotalMinor: result.totalMinor,
    observedAt: '',
    sourceRef: result.revisionRef,
    restrictions: [],
    combinable: true,
    quoteRequestKey: `${result.arrivalDate}:${result.departureDate}`,
    coversGroupIds: groups.map((group) => group.id),
    quantity: groups.reduce((sum, group) => sum + (group.quantity ?? 0), 0),
  };
}

/**
 * The dinner-allowance groups for one quote. The header holds ids from every date option, but the server
 * caps the list at 8 and charges only the listed groups, so each quote keeps just its own ids. An empty
 * list is kept on purpose: an omitted list would charge every group.
 */
function dinnerAllowanceGroupIdsFor(
  header: StaffQuoteHeader,
  quoteGroupIds?: readonly string[],
): string[] | undefined {
  const ids = header.dinnerAllowanceGroupIds;
  if (!ids?.length) return undefined;
  const inQuote = quoteGroupIds ? new Set(quoteGroupIds) : null;
  return [...new Set(ids)].filter((id) => !inQuote || inQuote.has(id));
}

export function approvedExecuteHeader(
  header: StaffQuoteHeader,
  quoteGroupIds?: readonly string[],
): Pick<
  ExecuteStaffQuoteInput,
  | 'salesStrategy'
  | 'company'
  | 'agency'
  | 'attention'
  | 'clientEmail'
  | 'clientTelephone'
  | 'dinnerAllowanceMinor'
  | 'dinnerAllowanceUnit'
  | 'dinnerAllowanceGroupIds'
  | 'dinnerAllowanceLabel'
  | 'lunchAllowanceMinor'
  | 'lunchAllowanceLabel'
  | 'officeTransferMinor'
  | 'officeTransferDays'
  | 'shuttleRequested'
  | 'shuttleMinor'
  | 'shuttleTrips'
  | 'other'
  | 'notes'
> {
  const salesStrategy = header.salesStrategy === 'Government' ? 'Government' : header.salesStrategy === 'BAR' ? 'BAR' : null;
  if (!salesStrategy) {
    throw new Error('Choose the rate type (BAR or Government) before running the quote.');
  }
  const dinnerGroupIds = dinnerAllowanceGroupIdsFor(header, quoteGroupIds);
  return {
    salesStrategy,
    company: header.company.trim(),
    agency: header.agency.trim(),
    attention: header.attention.trim(),
    clientEmail: header.clientEmail.trim(),
    clientTelephone: header.clientTelephone.trim(),
    ...(dinnerGroupIds ? { dinnerAllowanceGroupIds: dinnerGroupIds } : {}),
    ...(header.dinnerAllowanceMinor && header.dinnerAllowanceMinor > 0
      ? {
          dinnerAllowanceMinor: header.dinnerAllowanceMinor,
          ...(header.dinnerAllowanceUnit ? { dinnerAllowanceUnit: header.dinnerAllowanceUnit } : {}),
          ...(trimmedOrUndefined(header.dinnerAllowanceLabel)
            ? { dinnerAllowanceLabel: trimmedOrUndefined(header.dinnerAllowanceLabel) }
            : {}),
        }
      : {}),
    ...(positiveWhole(header.lunchAllowanceMinor)
      ? {
          lunchAllowanceMinor: positiveWhole(header.lunchAllowanceMinor),
          ...(trimmedOrUndefined(header.lunchAllowanceLabel)
            ? { lunchAllowanceLabel: trimmedOrUndefined(header.lunchAllowanceLabel) }
            : {}),
        }
      : {}),
    ...(positiveWhole(header.officeTransferMinor)
      ? {
          officeTransferMinor: positiveWhole(header.officeTransferMinor),
          ...(positiveWhole(header.officeTransferDays)
            ? { officeTransferDays: positiveWhole(header.officeTransferDays) }
            : {}),
        }
      : {}),
    ...(header.shuttleRequested ? { shuttleRequested: true } : {}),
    ...(header.shuttleMinor && header.shuttleMinor > 0 ? { shuttleMinor: header.shuttleMinor } : {}),
    ...(header.shuttleRequested && positiveWhole(header.shuttleTrips)
      ? { shuttleTrips: positiveWhole(header.shuttleTrips) }
      : {}),
    ...(otherChargeFor(header.other) ? { other: otherChargeFor(header.other) } : {}),
    ...(trimmedOrUndefined(header.notes) ? { notes: trimmedOrUndefined(header.notes) } : {}),
  };
}

/** Project the independently editable extras for one date range onto the existing HMS header wire shape. */
export function staffHeaderForStay(header: StaffQuoteHeader, stayKey: string): StaffQuoteHeader {
  const extras: StaffStayExtras = staffStayExtrasFor(header, stayKey);
  const scoped: StaffQuoteHeader = {
    ...header,
    fieldErrors: { ...header.fieldErrors, ...extras.fieldErrors },
    shuttleRequested: extras.shuttleEnabled,
    shuttleMinor: extras.shuttleEnabled ? extras.shuttleMinor : undefined,
    shuttleTrips: extras.shuttleEnabled ? extras.shuttleTrips : undefined,
    lunchAllowanceMinor: extras.lunchEnabled ? extras.lunchAllowanceMinor : undefined,
    lunchAllowanceLabel: extras.lunchEnabled ? extras.lunchAllowanceLabel : undefined,
    dinnerAllowanceRequired: extras.dinnerAllowanceRequired,
    dinnerAllowanceMinor: extras.dinnerEnabled ? extras.dinnerAllowanceMinor : undefined,
    dinnerAllowanceUnit: extras.dinnerEnabled ? extras.dinnerAllowanceUnit : undefined,
    dinnerAllowanceGroupIds: extras.dinnerEnabled ? extras.dinnerAllowanceGroupIds : undefined,
    dinnerAllowanceLabel: extras.dinnerEnabled ? extras.dinnerAllowanceLabel : undefined,
    other: extras.otherEnabled ? extras.other : undefined,
  };
  delete scoped.stayExtrasByKey;
  return scoped;
}

/** Whole positive amounts or counts only. Anything else is left off the request, never sent as zero. */
function positiveWhole(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * An "other" charge is sent when it has a positive amount. A blank label is sent as '' on purpose, so the
 * server raises a review item for it instead of dropping the amount.
 */
function otherChargeFor(
  other: StaffQuoteHeader['other'],
): ExecuteStaffQuoteInput['other'] | undefined {
  const amountMinor = positiveWhole(other?.amountMinor);
  if (!other || !amountMinor) return undefined;
  return { label: trimmedOrUndefined(other.label) ?? '', amountMinor, unit: other.unit };
}

/** Whether this stay has a single-charge extra: the shuttle, or an "other" charge per trip or as one item. */
export function hasPerStaySingleChargeExtras(header: StaffQuoteHeader): boolean {
  const other = otherChargeFor(header.other);
  const flatOther = other?.unit === 'per_trip' || other?.unit === 'item';
  return Boolean(header.shuttleRequested) || flatOther;
}

/**
 * The picked parties the quote sends: a company as company and an agency as agency, each with its HMS id and name. A pick
 * without a plain HMS id (an unverified suggestion, for one) is never sent. Undefined when nothing valid was picked.
 */
export function pickedParties(parties: StaffQuoteParties | undefined): StaffQuoteParties | undefined {
  const company = validPick(parties?.company, 'company');
  const agency = validPick(parties?.agency, 'agency');
  if (!company && !agency) return undefined;
  return { ...(company ? { company } : {}), ...(agency ? { agency } : {}) };
}

function validPick(party: StaffQuoteParty | undefined, kind: 'company' | 'agency'): StaffQuoteParty | undefined {
  if (!party || party.kind !== kind) return undefined;
  if (typeof party.nativeId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(party.nativeId)) return undefined;
  if (typeof party.name !== 'string' || !party.name.trim()) return undefined;
  return { kind, nativeId: party.nativeId, name: party.name };
}

type StaffQuoteRequestArgs = {
  source: StaffQuoteSource;
  selectionEpoch: number;
  inputRevision: number;
  groups: StayGroupRequirement[];
  header: StaffQuoteHeader;
  /** Prefer an explicit stay key when the request is built from a reconstructed stay. */
  stayKey?: string;
  /** Resolved quote-target property; staff quote requests refuse a missing or unknown code. */
  propertyCode?: string;
  /** Comparison rows are read-back bindings for an already prepared, property-allowed strategy. */
  strategyRequestValue?: QuoteSalesStrategyValue;
};

type BuiltStaffQuoteRequest = {
  input: ExecuteStaffQuoteInput;
  sent: StaffQuoteHeader;
  header: ReturnType<typeof approvedExecuteHeader>;
};

function staffQuoteRequest(
  args: StaffQuoteRequestArgs,
): BuiltStaffQuoteRequest | { error: string } {
  if (args.propertyCode !== HRCEN_PROPERTY_CODE && args.propertyCode !== HRDAV_PROPERTY_CODE) {
    return { error: 'Could not identify the hotel for this mailbox. Refresh the pane before running the quote.' };
  }
  const prepared = staffQuoteGroupsFromStay(args.groups, args.propertyCode);
  if ('error' in prepared) return { error: prepared.error };
  const first = prepared.ok[0];
  const stayKey =
    args.stayKey ?? `${first?.arrivalDate ?? 'unknown'}:${first?.departureDate ?? 'unknown'}`;
  const sent = staffHeaderForStay(args.header, stayKey);
  // A typed amount that cannot be read is never priced from the older saved amount.
  const fieldProblem = staffHeaderFieldProblem(sent);
  if (fieldProblem) return { error: `Fix the amounts before running this search. ${fieldProblem}` };
  try {
    const header = approvedExecuteHeader(
      sent,
      prepared.ok.map((group) => group.id),
    );
    const rowPrices = rowPricesFor(args.groups);
    const allRoomSearch = prepared.ok.every((group) => !group.roomCodes?.length);
    return {
      input: {
        messageId: args.source.messageId,
        sourceHash: args.source.sourceHash,
        selectionEpoch: args.selectionEpoch,
        inputRevision: args.inputRevision,
        groups: prepared.ok,
        ...header,
        ...(args.strategyRequestValue ? { salesStrategy: args.strategyRequestValue } : {}),
        ...(pickedParties(sent.parties) ? { parties: pickedParties(sent.parties) } : {}),
        ...(rowPrices.length ? { rowPrices } : {}),
        ...(allRoomSearch ? { maxOptionsPerGroup: 200 } : {}),
      },
      sent,
      header,
    };
  } catch (error) {
    return { error: rejectionReason(error) };
  }
}

/** True when the existing Get rates request builder has all of its required inputs. */
export function canBuildStaffQuoteRequest(args: StaffQuoteRequestArgs): boolean {
  return !('error' in staffQuoteRequest(args));
}

function boundStaffQuoteResult(
  rawResult: unknown,
  args: StaffQuoteRequestArgs,
  built: BuiltStaffQuoteRequest,
): BoundExecuteStaffQuote {
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    return { status: 'unavailable', reason: 'HMS returned no result for this quote. Try again.' };
  }
  const raw = rawResult as Record<string, unknown>;
  if ('alternatives' in raw && Array.isArray(raw.alternatives) && raw.alternatives.length) {
    return {
      status: 'unavailable',
      reason: 'HMS returned several room options. Pick one, then try again.',
    };
  }
  if (!isExecuteStaffQuoteResult(raw)) {
    return {
      status: 'unavailable',
      reason: 'HMS did not return a room option that can be booked. Try again.',
    };
  }
  const result = raw;
  if (
    result.selectionEpoch !== args.selectionEpoch ||
    result.inputRevision !== args.inputRevision
  ) {
    return {
      status: 'unavailable',
      reason: 'The quote is out of date because the stay details changed. Run it again.',
    };
  }
  if (result.messageId !== args.source.messageId) {
    return {
      status: 'unavailable',
      reason:
        'The quote does not match the selected email. Select the email again, then run it again.',
    };
  }
  if (
    result.currency !== 'ZAR' ||
    !Number.isSafeInteger(result.totalMinor) ||
    result.totalMinor <= 0
  ) {
    return {
      status: 'unavailable',
      reason: 'HMS returned a total that cannot be used. Try again, or check the rate in HMS.',
    };
  }
  const rateOptions = readRateOptions(result.rateOptions);
  const availabilityBoard = readAvailabilityBoard(result.availabilityBoard);
  const rowRates = readRowRates(result.rowRates);
  const hrdavQuote = args.propertyCode === HRDAV_PROPERTY_CODE;
  const dinnerFallbackGroupIds = hrdavQuote
    ? []
    : Array.isArray(result.dinnerFallbackGroupIds)
      ? [...new Set(result.dinnerFallbackGroupIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)))].slice(0, 8)
      : [];
  const dinnerAddOn = hrdavQuote ? undefined : readDinnerAddOn(result.dinnerAddOn);
  const dinnerFallbackGroupSet = new Set(dinnerFallbackGroupIds);
  const offerGroups = dinnerFallbackGroupSet.size
    ? args.groups.map((group) =>
        dinnerFallbackGroupSet.has(group.id) ? { ...group, board: 'bb' as const } : group,
      )
    : args.groups;
  const staffQuote: StaffQuoteAllocation = {
    workflowRunId: result.workflowRunId,
    revisionRef: result.revisionRef,
    factRefs: Array.isArray(result.factRefs)
      ? result.factRefs.filter((ref): ref is string => typeof ref === 'string')
      : [],
    messageId: result.messageId,
    threadId: result.threadId,
    sourceHash: args.source.sourceHash,
    selectionEpoch: result.selectionEpoch,
    inputRevision: result.inputRevision,
    inputDigest: result.inputDigest,
    totalMinor: result.totalMinor,
    currency: result.currency,
    quoteRequestKey: `${result.arrivalDate}:${result.departureDate}`,
    ...(typeof result.dinnerAddOnRequired === 'boolean' && !hrdavQuote
      ? { dinnerAddOnRequired: result.dinnerAddOnRequired }
      : {}),
    ...(dinnerFallbackGroupIds.length ? { dinnerFallbackGroupIds } : {}),
    ...(dinnerAddOn ? { dinnerAddOn } : {}),
    approvedHeader: {
      salesStrategy: built.sent.salesStrategy,
      company: built.header.company,
      agency: built.header.agency,
      attention: built.header.attention,
      clientEmail: built.header.clientEmail,
      clientTelephone: built.header.clientTelephone,
      ...(built.header.notes ? { notes: built.header.notes } : {}),
    },
    onceExtras: hasPerStaySingleChargeExtras(built.sent),
    runId: typeof result.runId === 'string' && result.runId.trim() ? result.runId : null,
    screenshots: Array.isArray(result.screenshots)
      ? result.screenshots.filter(
          (name): name is string => typeof name === 'string' && name.trim().length > 0,
        )
      : [],
    ...(rateOptions.length ? { rateOptions } : {}),
    ...(availabilityBoard.length ? { availabilityBoard } : {}),
    ...(result.availabilityTruncated === true ? { availabilityTruncated: true } : {}),
    ...(rowRates.length ? { rowRates } : {}),
  };
  return {
    status: 'ok',
    offer: allocationFromStaffQuote(result, offerGroups),
    staffQuote,
    extrasReviewItems: Array.isArray(result.extrasReviewItems)
      ? result.extrasReviewItems.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [],
  };
}

function readDinnerAddOn(value: unknown): StaffQuoteAllocation['dinnerAddOn'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 140 || hasControl(raw.label) ||
    !Number.isSafeInteger(raw.amountMinor) || (raw.amountMinor as number) <= 0 ||
    !Number.isSafeInteger(raw.totalMinor) || (raw.totalMinor as number) <= 0 ||
    !['per_person_per_night', 'per_room_per_night', 'per_person'].includes(String(raw.unit))
  ) return undefined;
  return {
    label: raw.label.trim(),
    amountMinor: raw.amountMinor as number,
    unit: raw.unit as DinnerAddOnUnit,
    totalMinor: raw.totalMinor as number,
  };
}

function settledStaffQuoteJob(view: StaffQuoteJobView): boolean {
  return view.status === 'done' || view.status === 'failed';
}

const STAFF_QUOTE_POLL_MAX_MS = 9 * 60_000;
const STAFF_QUOTE_RESULT_MAX_AGE_MS = 6 * 60 * 60_000;

function waitForStaffQuotePoll(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(elapsed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function pollStaffQuoteJob(
  query: StaffQuoteJobQuery,
  initial: StaffQuoteJobView,
  signal?: AbortSignal,
): Promise<StaffQuoteJobView> {
  let view = initial;
  let misses = 0;
  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, STAFF_QUOTE_POLL_MAX_MS);
  });
  const poll = async (): Promise<{ kind: 'settled'; view: StaffQuoteJobView }> => {
    while (!settledStaffQuoteJob(view) && !controller.signal.aborted) {
      const elapsed = await waitForStaffQuotePoll(HMS_JOB_POLL_MS, controller.signal);
      if (!elapsed || controller.signal.aborted) break;
      if (Date.now() - startedAt >= STAFF_QUOTE_POLL_MAX_MS) {
        return { kind: 'settled', view: { ...view, status: 'failed', failureClass: 'POLL_LOST' } };
      }
      const next = await query({ runId: view.runId }, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) break;
      if (Date.now() - startedAt >= STAFF_QUOTE_POLL_MAX_MS) {
        return { kind: 'settled', view: { ...view, status: 'failed', failureClass: 'POLL_LOST' } };
      }
      if (next) {
        view = next;
        misses = 0;
        continue;
      }
      misses += 1;
      if (misses >= HMS_JOB_MAX_MISSES) {
        return { kind: 'settled', view: { ...view, status: 'failed', failureClass: 'POLL_LOST' } };
      }
    }
    return { kind: 'settled', view };
  };
  try {
    const result = await Promise.race([poll(), timeout]);
    return result.kind === 'timeout'
      ? { ...view, status: 'failed', failureClass: 'POLL_LOST' }
      : result.view;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

function boundStaffQuoteJob(
  view: StaffQuoteJobView,
  args: StaffQuoteRequestArgs,
  built: BuiltStaffQuoteRequest,
): BoundExecuteStaffQuote {
  const result = view.result;
  if (result?.ok === false) {
    const code = typeof result.code === 'string' ? result.code : 'staff_quote_failed';
    const message =
      typeof result.message === 'string' && result.message.trim()
        ? result.message
        : 'The requested quote could not be qualified; review the stay inputs and try again.';
    const alternatives = readQuoteRoomAlternatives(result.alternatives);
    return {
      status: 'unavailable',
      reason: message,
      detail: code,
      ...(message.startsWith(NATIVE_NO_MATCHING_RATE_PREFIX) ? { noMatchingRate: true } : {}),
      ...(alternatives.length ? { alternatives } : {}),
    };
  }
  if (view.status === 'failed') {
    if (view.failureClass === 'POLL_LOST') {
      return {
        status: 'unavailable',
        reason:
          'The queued quote is still running, but Nava could not read its status. Try again in a minute.',
      };
    }
    if (view.failureClass === 'HMS_LOCK_BUSY') {
      return {
        status: 'unavailable',
        reason: 'HMS is busy with another quote or lookup. Try again in a minute.',
      };
    }
    if (view.failureClass === 'TRANSIENT_NETWORK') {
      return { status: 'unavailable', reason: "HMS didn't answer in time." };
    }
    return { status: 'unavailable', reason: 'The background quote could not be completed. Try again.' };
  }
  if (view.status !== 'done' || !result) {
    return { status: 'unavailable', reason: 'The queued quote did not return a result. Try again.' };
  }
  const bound = boundStaffQuoteResult(result, args, built);
  return bound.status === 'ok' && view.prefetch
    ? {
        ...bound,
        staffQuote: {
          ...bound.staffQuote,
          preparedByNava: true,
          ...(typeof view.asOf === 'string' && Number.isFinite(Date.parse(view.asOf))
            ? { preparedAt: view.asOf }
            : {}),
        },
      }
    : bound;
}

export async function bindExecuteStaffQuote(
  args: StaffQuoteRequestArgs & {
    mutate?: (
      input: ExecuteStaffQuoteInput,
    ) => Promise<ExecuteStaffQuoteResult | { status?: string; alternatives?: unknown }>;
    queue?: StaffQuoteJobQueue;
    staffQuoteJob?: StaffQuoteJobQuery;
  },
): Promise<BoundExecuteStaffQuote> {
  const built = staffQuoteRequest(args);
  if ('error' in built) return { status: 'unavailable', reason: built.error };
  if (!args.queue && !args.mutate) {
    return {
      status: 'unavailable',
      reason: 'Quoting is not connected to this pane yet. Refresh the pane and try again.',
    };
  }
  try {
    if (args.queue) {
      const queued = await args.queue(built.input);
      if (typeof queued?.runId === 'string' && queued.runId.trim()) {
        if (!args.staffQuoteJob) {
          return {
            status: 'unavailable',
            reason:
              'The queued quote status is not connected to this pane. Refresh the pane and try again.',
          };
        }
        const first = await args.staffQuoteJob({ runId: queued.runId });
        if (!first)
          return {
            status: 'unavailable',
            reason: 'Nava could not read the queued quote. Try again in a minute.',
          };
        return boundStaffQuoteJob(await pollStaffQuoteJob(args.staffQuoteJob, first), args, built);
      }
      if (queued?.runId !== null) {
        return { status: 'unavailable', reason: 'Nava did not return a queued quote. Try again.' };
      }
    }
    if (!args.mutate) {
      return {
        status: 'unavailable',
        reason: 'Quoting is not connected to this pane yet. Refresh the pane and try again.',
      };
    }
    return boundStaffQuoteResult(await args.mutate(built.input), args, built);
  } catch (error) {
    return { status: 'unavailable', ...searchFailure(error) };
  }
}

/** Starts and polls a staff quote only through the persisted job queue; it never falls back to inline HMS. */
export async function bindAutoStartStaffQuote(
  args: StaffQuoteRequestArgs & {
    queue?: StaffQuoteJobQueue;
    staffQuoteJob?: StaffQuoteJobQuery;
  },
): Promise<BoundExecuteStaffQuote | null> {
  const built = staffQuoteRequest(args);
  if ('error' in built || !args.queue) return null;
  try {
    const queued = await args.queue({ ...built.input, autoStart: true });
    if (queued?.runId === null) return null;
    if (typeof queued?.runId !== 'string' || !queued.runId.trim()) {
      return { status: 'unavailable', reason: 'Nava did not return a queued quote. Try again.' };
    }
    if (!args.staffQuoteJob) {
      return {
        status: 'unavailable',
        reason: 'The queued quote status is not connected to this pane. Refresh the pane and try again.',
      };
    }
    const first = await args.staffQuoteJob({ runId: queued.runId });
    if (!first) {
      return { status: 'unavailable', reason: 'Nava could not read the queued quote. Try again in a minute.' };
    }
    const settled = await pollStaffQuoteJob(args.staffQuoteJob, first);
    // The queue route returns a prepared run only after its server-side price-shape match. Its extracted display header
    // can legitimately differ from the pane's edited header, so rebase counters for that same source as well.
    const preparedForSource =
      settled.prefetch &&
      settled.request?.kind === 'staff_quote' &&
      settled.request.input.messageId === built.input.messageId &&
      settled.request.input.sourceHash === built.input.sourceHash;
    const rebased = (preparedForSource || staffQuoteRequestMatches(settled.request, built.input)) && settled.result
      ? {
          ...settled,
          result: {
            ...settled.result,
            selectionEpoch: args.selectionEpoch,
            inputRevision: args.inputRevision,
          },
        }
      : settled;
    return boundStaffQuoteJob(rebased, args, built);
  } catch (error) {
    return { status: 'unavailable', ...searchFailure(error) };
  }
}

/** Finds the latest persisted quote for the same semantic request after a pane remount, then polls it if still running. */
export async function bindReadBackStaffQuote(
  args: StaffQuoteRequestArgs & {
    query?: StaffQuoteJobQuery;
    signal?: AbortSignal;
  },
): Promise<BoundExecuteStaffQuote | null> {
  if (!args.query) return null;
  const built = staffQuoteRequest(args);
  if ('error' in built) return null;
  try {
    const first = args.signal
      ? await args.query({ input: built.input }, { signal: args.signal })
      : await args.query({ input: built.input });
    if (!first || args.signal?.aborted) return null;
    if (first.request && (
      !staffQuoteStayTermsMatch(first.request, built.input) ||
      !staffQuoteRequestMatches(first.request, built.input, first.prefetch === true)
    )) return null;
    if (
      first.status === 'done' &&
      (!first.asOf ||
        !Number.isFinite(Date.parse(first.asOf)) ||
        Date.now() - Date.parse(first.asOf) >= STAFF_QUOTE_RESULT_MAX_AGE_MS)
    ) {
      return null;
    }
    const settled = await pollStaffQuoteJob(args.query, first, args.signal);
    if (args.signal?.aborted) return null;
    if (settled.request && !staffQuoteRequestMatches(settled.request, built.input, settled.prefetch === true)) return null;
    const rebased = settled.result
      ? {
          ...settled,
          result: {
            ...settled.result,
            selectionEpoch: args.selectionEpoch,
            inputRevision: args.inputRevision,
          },
        }
      : settled;
    return boundStaffQuoteJob(rebased, args, built);
  } catch (error) {
    return { status: 'unavailable', ...searchFailure(error) };
  }
}

export type BoundStaffQuoteStrategy = {
  strategyCode: QuoteSalesStrategyCode;
  row: QuoteStrategyRow;
  /** A matching prepared job may become readable on a later pane effect. */
  retryable?: true;
  /** Present only when the existing prepared job returned a bindable quote. */
  result?: Extract<BoundExecuteStaffQuote, { status: 'ok' }>;
};

type StaffQuoteStrategyBindArgs = StaffQuoteRequestArgs & {
  registryStrategies: readonly QuoteSalesStrategy[];
  strategyCode: QuoteSalesStrategyCode;
  staffQuoteJob?: StaffQuoteJobQuery;
};

const QUOTE_STRATEGY_CODES: ReadonlySet<string> = new Set([
  'BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER',
]);
const QUOTE_STRATEGY_VALUES: ReadonlySet<string> = new Set([
  ...QUOTE_STRATEGY_CODES,
  'Government',
]);

function failedQuoteStrategy(
  strategyCode: QuoteSalesStrategyCode,
  message: string,
  causeClass: QuoteFailureCauseClass,
  retryable = false,
): BoundStaffQuoteStrategy {
  return {
    strategyCode,
    row: {
      status: 'failed',
      message,
      causeClass,
    },
    ...(retryable ? { retryable: true as const } : {}),
  };
}

function rowForBoundStrategy(
  strategyCode: QuoteSalesStrategyCode,
  result: Extract<BoundExecuteStaffQuote, { status: 'ok' }>,
  groups: readonly StayGroupRequirement[],
): BoundStaffQuoteStrategy {
  const selected = result.staffQuote.rateOptions?.filter((option) => option.selected) ?? [];
  const selectedGroupIds = new Set(selected.map((option) => option.groupId));
  if (!groups.length || groups.some((group) => !selectedGroupIds.has(group.id))) {
    return {
      strategyCode,
      row: {
        status: 'not_offered',
        message: 'No room option was returned for this strategy and stay.',
        causeClass: 'not_found',
      },
    };
  }
  return {
    strategyCode,
    row: {
      status: 'ready',
      roomLabels: selected.map((option) => option.roomLabel),
      boardLabels: selected.map((option) => option.boardLabel),
      nightlyMinor: selected.map((option) => option.perNightMinor),
      totalMinor: result.staffQuote.totalMinor,
    },
    result,
  };
}

/** Binds one U6a-prepared strategy job without starting a new quote or changing the active approval. */
export async function bindStaffQuoteStrategy(
  args: StaffQuoteStrategyBindArgs,
): Promise<BoundStaffQuoteStrategy> {
  const strategy = args.registryStrategies.find((item) => item.code === args.strategyCode);
  if (!strategy || !QUOTE_STRATEGY_CODES.has(strategy.code) || !QUOTE_STRATEGY_VALUES.has(strategy.requestValue)) {
    return failedQuoteStrategy(
      args.strategyCode,
      'This rate strategy is not configured for the selected hotel; no search was run.',
      'not_set_up',
    );
  }
  if (!args.staffQuoteJob) {
    return failedQuoteStrategy(
      args.strategyCode,
      'The quote comparison queue is disabled or unavailable; no search was run.',
      'not_set_up',
    );
  }

  try {
    const request = staffQuoteRequest({ ...args, strategyRequestValue: strategy.requestValue });
    if ('error' in request) return failedQuoteStrategy(args.strategyCode, request.error, 'needs_staff');
    const query: StaffQuoteJobQuery = async (lookup, options) => {
      const view = await args.staffQuoteJob!(lookup, options);
      if (
        view?.request?.kind === 'staff_quote' &&
        !staffQuoteRequestMatches(view.request, request.input)
      ) return null;
      return view;
    };
    const bound = await bindReadBackStaffQuote({
      ...args,
      strategyRequestValue: strategy.requestValue,
      query,
    });
    if (!bound) {
      return failedQuoteStrategy(
        args.strategyCode,
        'No prepared comparison job was found. The queue may be disabled; no search was run.',
        'not_set_up',
        true,
      );
    }
    if (bound.status !== 'ok') {
      const notOffered = bound.noMatchingRate === true || bound.detail === 'NATIVE_NO_MATCHING_RATE';
      return {
        strategyCode: args.strategyCode,
        row: {
          status: notOffered ? 'not_offered' : 'failed',
          message: bound.reason,
          causeClass: notOffered ? 'not_found' : causeClassForBoundReason(bound.reason),
        },
      };
    }
    if (bound.staffQuote.preparedByNava !== true) {
      return failedQuoteStrategy(
        args.strategyCode,
        'The comparison job was not prepared by Nava; its result was not bound.',
        'not_set_up',
      );
    }
    return rowForBoundStrategy(args.strategyCode, bound, args.groups);
  } catch (error) {
    const message = rejectionReason(error);
    return failedQuoteStrategy(args.strategyCode, message, causeClassForBoundReason(message));
  }
}

function causeClassForBoundReason(reason: string): QuoteFailureCauseClass {
  const text = reason.toLowerCase();
  if (text.includes('busy')) return 'busy';
  if (
    text.includes("didn't answer") ||
    text.includes('did not return') ||
    text.includes('could not be completed') ||
    text.includes('could not read its status')
  ) return 'hms_down';
  if (text.includes('not configured') || text.includes('disabled') || text.includes('not prepared')) return 'not_set_up';
  if (text.includes('no rate') || text.includes('no room') || text.includes('not found')) return 'not_found';
  return 'needs_staff';
}

/** Binds all active registry strategies independently; one failed or unavailable row cannot hide the others. */
export async function bindStaffQuoteStrategies(
  args: Omit<StaffQuoteStrategyBindArgs, 'strategyCode'> & {
    onResult?: (result: BoundStaffQuoteStrategy) => void;
  },
): Promise<BoundStaffQuoteStrategy[]> {
  const { onResult, ...bindArgs } = args;
  return Promise.all(
    bindArgs.registryStrategies.map(async (strategy) => {
      const result = await bindStaffQuoteStrategy({ ...bindArgs, strategyCode: strategy.code });
      onResult?.(result);
      return result;
    }),
  );
}

/**
 * The revision id a document must carry. One stay's document is named by that stay's revision. A combined document is
 * named by the set of its stays' revisions (quotes:...), which the client cannot rebuild, so it is checked by prefix.
 */
export function revisionMatchesRequest(input: QualifiedStaffPdfInput, revisionId: string): boolean {
  return input.additionalStays?.length ? revisionId.startsWith('quotes:') : revisionId === input.revisionRef;
}

export type BoundStaffPdf =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; pdf: QualifiedStaffPdfResult };

export async function bindQualifiedStaffProposalPdf(args: {
  mutate?: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffPdfResult & { centsReconciled?: unknown }>;
  input: QualifiedStaffPdfInput;
  expectedTotalMinor: number;
}): Promise<BoundStaffPdf> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason:
        'PDF creation is not connected to this pane yet. Refresh the pane and try again.',
    };
  }
  if (typeof args.input.company !== 'string' || typeof args.input.agency !== 'string') {
    return {
      status: 'unavailable',
      reason: 'The company or agency on the PDF does not match the quote. Run the quote again.',
    };
  }
  try {
    const pdf = await args.mutate({
      workflowRunId: args.input.workflowRunId,
      revisionRef: args.input.revisionRef,
      messageId: args.input.messageId,
      outlookEmail: args.input.outlookEmail,
      factRefs: args.input.factRefs,
      attention: args.input.attention,
      company: args.input.company,
      clientEmail: args.input.clientEmail,
      clientTelephone: args.input.clientTelephone,
      agency: args.input.agency,
      ...(args.input.notes ? { notes: args.input.notes } : {}),
      ...(args.input.additionalStays?.length ? { additionalStays: args.input.additionalStays } : {}),
    });
    if (
      !pdf ||
      typeof pdf.fileName !== 'string' ||
      !pdf.fileName.trim() ||
      typeof pdf.pdfBase64 !== 'string' ||
      !pdf.pdfBase64.trim() ||
      typeof pdf.pdfHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pdf.pdfHash) ||
      typeof pdf.revisionId !== 'string' ||
      !revisionMatchesRequest(args.input, pdf.revisionId) ||
      !Number.isSafeInteger(pdf.totalMinor) ||
      pdf.totalMinor <= 0 ||
      pdf.totalMinor !== args.expectedTotalMinor
    ) {
      return {
        status: 'unavailable',
        reason: 'The PDF could not be checked against the quote. Try again.',
      };
    }
    const bytes = bytesFromBase64(pdf.pdfBase64);
    const actualHash = bytes ? await sha256HexOfBytes(bytes) : null;
    if (!bytes?.length || actualHash !== pdf.pdfHash) {
      return {
        status: 'unavailable',
        reason: 'The PDF file did not match its check code. Try again.',
      };
    }
    return {
      status: 'ok',
      pdf: {
        revisionId: pdf.revisionId,
        pdfHash: pdf.pdfHash,
        fileName: pdf.fileName.trim(),
        pdfBase64: pdf.pdfBase64,
        totalMinor: pdf.totalMinor,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: qualifiedPdfFailureReason(error) };
  }
}

/**
 * Reads one audit screenshot of a staff quote run. A missing query, a failed read,
 * or a response that is not a PNG/JPEG data URL resolves to unavailable.
 */
export async function bindQuoteRunScreenshot(args: {
  query?: (input: { runId: string; name: string }) => Promise<QuoteRunScreenshotResult>;
  runId: string;
  name: string;
}): Promise<QuoteRunScreenshotResult> {
  if (!args.query) return { status: 'unavailable', reason: 'not_connected' };
  try {
    const result = await args.query({ runId: args.runId, name: args.name });
    if (result?.status === 'ready' && result.dataUrl.startsWith('data:image/')) return result;
    return { status: 'unavailable', reason: result?.status === 'unavailable' ? result.reason : 'invalid_response' };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error) };
  }
}

/**
 * Reads the caller's staff quote run status. A missing query (older server) or a
 * failed read resolves to null, so the poller keeps its last good status.
 */
export async function bindHmsQueueStatus(query?: () => Promise<QueueStatus>): Promise<QueueStatus | null> {
  if (!query) return null;
  try {
    return (await query()) ?? null;
  } catch {
    return null;
  }
}

type StaffQuoteClient = {
  staffQuoteSource?: { query: (input: { internetMessageId: string }) => Promise<StaffQuoteSourceResult> };
  executeStaffQuote?: {
    mutate: (input: ExecuteStaffQuoteInput, options?: StaffQuoteCallOptions) => Promise<ExecuteStaffQuoteResult>;
  };
  queueStaffQuote?: { mutate: StaffQuoteJobQueue };
  staffQuoteJob?: { query: StaffQuoteJobQuery };
  hmsQueueStatus?: { query: () => Promise<QueueStatus> };
  quoteRunScreenshot?: {
    query: (input: { runId: string; name: string }) => Promise<QuoteRunScreenshotResult>;
  };
  qualifiedQuoteProposalPdf?: { mutate: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffPdfResult> };
  quoteWorkbook?: { mutate: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffWorkbookResult> };
  prepareBookingDraft?: { mutate: (input: PrepareBookingDraftInput) => Promise<PrepareBookingDraftResult> };
  prepareUnquotedBookingDraft?: { mutate: (input: PrepareUnquotedBookingDraftInput) => Promise<PrepareBookingDraftResult> };
  listThreadQuoteRevisions?: {
    query: (input: { threadId: string }) => Promise<{ revisions?: Array<{ workflowRunId: string; revisionRef: string }> }>;
  };
  usePriorQuoteForBooking?: {
    mutate: (
      input: UsePriorQuoteForBookingInput,
    ) => Promise<
      | { status: 'unavailable'; reason?: string }
      | ({ status: 'ready' } & UsePriorQuoteForBookingReady)
    >;
  };
  getPriorStaffQuoteRequote?: {
    query: (
      input: { workflowRunId: string; revisionRef: string; threadId: string },
    ) => Promise<
      | { status: 'unavailable'; reason?: string }
      | {
          status: 'ready';
          payload: {
            groups: StaffQuoteGroupInput[];
            salesStrategy: 'BAR' | 'Government';
            company: string;
            agency: string;
          };
        }
    >;
  };
};

type DraftsClient = {
  list?: { query: (input: { threadId: string; limit?: number }) => Promise<unknown> };
  get?: { query: (input: { id: string }) => Promise<unknown> };
  reviewForMessage?: { query: (input: { threadId: string; messageId: string; workItemId?: string }, options?: StaffQuoteCallOptions) => Promise<unknown> };
  setRequestHandled?: { mutate: (input: { workItemId: string; runId: string; taskId: string; handled: boolean }, options?: StaffQuoteCallOptions) => Promise<unknown> };
  setVoucherReviewHandled?: { mutate: (input: { workItemId: string; runId: string; reviewItemId: string; handled: boolean }, options?: StaffQuoteCallOptions) => Promise<unknown> };
};

function staffQuoteCallOptions(
  options: StaffQuoteCallOptions | undefined,
  mailbox: ReturnType<typeof inMailbox>,
): StaffQuoteCallOptions | undefined {
  if (!mailbox) return options;
  return {
    ...options,
    context: { ...options?.context, ...mailbox.context },
  };
}

function mailboxStaffQuoteMutation<Input, Result>(
  route: { mutate: (input: Input, options?: StaffQuoteCallOptions) => Promise<Result> } | undefined,
  mailbox: ReturnType<typeof inMailbox>,
): { mutate: (input: Input, options?: StaffQuoteCallOptions) => Promise<Result> } | undefined {
  if (!route) return undefined;
  return {
    mutate: (input, options) => {
      const scoped = staffQuoteCallOptions(options, mailbox);
      return scoped ? route.mutate(input, scoped) : route.mutate(input);
    },
  };
}

function mailboxStaffQuoteQuery<Input, Result>(
  route: { query: (input: Input, options?: StaffQuoteCallOptions) => Promise<Result> } | undefined,
  mailbox: ReturnType<typeof inMailbox>,
): { query: (input: Input, options?: StaffQuoteCallOptions) => Promise<Result> } | undefined {
  if (!route) return undefined;
  return {
    query: (input, options) => {
      const scoped = staffQuoteCallOptions(options, mailbox);
      return scoped ? route.query(input, scoped) : route.query(input);
    },
  };
}

export function staffQuoteFromTrpc(trpc: unknown): {
  workstation: StaffQuoteClient;
  drafts: DraftsClient;
} {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return { workstation: {}, drafts: {} };
  const row = trpc as { workstation?: StaffQuoteClient; drafts?: DraftsClient };
  const routes = row.workstation ?? {};
  // A bound route may outlive the active mailbox, so every call through it stays on its starting transport.
  const mailbox = inMailbox(getMailCacheScope().activeTransportId);
  return {
    workstation: new Proxy(routes, {
      get(target, property) {
        const route = Reflect.get(target, property, target);
        if (property === 'executeStaffQuote') {
          return mailboxStaffQuoteMutation(route as StaffQuoteClient['executeStaffQuote'], mailbox);
        }
        if (property === 'queueStaffQuote') {
          return mailboxStaffQuoteMutation(route as StaffQuoteClient['queueStaffQuote'], mailbox);
        }
        if (property === 'staffQuoteJob') {
          return mailboxStaffQuoteQuery(route as StaffQuoteClient['staffQuoteJob'], mailbox);
        }
        return route;
      },
    }),
    drafts: new Proxy(row.drafts ?? {}, {
      get(target, property) {
        const route = Reflect.get(target, property, target);
        if (property === 'reviewForMessage') return mailboxStaffQuoteQuery(route as DraftsClient['reviewForMessage'], mailbox);
        if (property === 'setRequestHandled') return mailboxStaffQuoteMutation(route as DraftsClient['setRequestHandled'], mailbox);
        if (property === 'setVoucherReviewHandled') return mailboxStaffQuoteMutation(route as DraftsClient['setVoucherReviewHandled'], mailbox);
        return route;
      },
    }),
  };
}
