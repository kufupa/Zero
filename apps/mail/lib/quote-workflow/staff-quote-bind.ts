import type {
  PrepareBookingDraftInput,
  PrepareBookingDraftResult,
  UsePriorQuoteForBookingInput,
  UsePriorQuoteForBookingReady,
} from './booking-draft-bind';
import type {
  QueueStatus,
  QuoteOffer,
  QuoteRunScreenshotResult,
  ReservationistStaffAction,
  StaffQuoteAllocation,
  StaffQuoteHeader,
  StaffQuoteSource,
  StayGroupRequirement,
} from './types';

const SOURCE_HASH = /^[a-f0-9]{64}$/;
/** Exact Centurion native room-type codes. Labels such as SINGLE are not codes. */
export const KNOWN_NATIVE_ROOM_CODES = new Set([
  'DLXKNG',
  'DLXQN',
  'DLXTWN',
  'LUXKNG',
  'SUITE',
  'SKNG',
  'EXKNG',
  'STQN',
  'STWN',
]);

export type NativeRoomCodeResolution =
  | { status: 'omitted' }
  | { status: 'codes'; codes: string[] }
  | { status: 'unresolved'; label: string };

export const STAFF_QUOTE_BIND_TARGETS = {
  staffActions: 'drafts.toDraftWire reviewSummary.staffActions',
  staffQuoteSource: 'workstation.staffQuoteSource',
  executeStaffQuote: 'workstation.executeStaffQuote',
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
};

export type ExecuteStaffQuoteInput = {
  messageId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  groups: StaffQuoteGroupInput[];
  salesStrategy: 'BAR' | 'Government';
  company: string;
  agency: string;
  attention: string;
  clientEmail: string;
  clientTelephone: string;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceGroupIds?: string[];
  shuttleRequested?: boolean;
  shuttleMinor?: number;
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
};

export type StaffQuoteSourceResult =
  | { status: 'ready'; messageId: string; threadId: string; sourceHash: string }
  | { status: 'message_not_synced' };

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
};

export type QualifiedStaffPdfResult = {
  revisionId: string;
  pdfHash: string;
  fileName: string;
  pdfBase64: string;
  totalMinor: number;
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

export const EXPIRED_STAFF_QUOTE_COPY = 'This quote has expired. Run the quote again.';

/** workstation.qualifiedQuoteProposalPdf messages for a quote run that is unrecorded or expired. */
const EXPIRED_STAFF_QUOTE_SERVER_MESSAGES = new Set([
  'Proposal source not found',
  'Proposal evidence expired during conversion',
]);

/** Plain staff copy for a PDF rejection; expired or unrecorded runs get the re-quote copy. */
export function qualifiedPdfFailureReason(error: unknown): string {
  if (error instanceof Error && EXPIRED_STAFF_QUOTE_SERVER_MESSAGES.has(error.message.trim()))
    return EXPIRED_STAFF_QUOTE_COPY;
  return rejectionReason(error);
}

function knownNativeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return KNOWN_NATIVE_ROOM_CODES.has(code) ? code : null;
}

export function resolveNativeRoomCodes(input: {
  roomPreference?: string;
  roomCodes?: string[];
}): NativeRoomCodeResolution {
  if (input.roomCodes?.length) {
    const codes: string[] = [];
    for (const raw of input.roomCodes) {
      const code = knownNativeCode(raw);
      if (!code) return { status: 'unresolved', label: raw.trim() || '(empty code)' };
      codes.push(code);
    }
    return { status: 'codes', codes };
  }
  const raw = input.roomPreference?.trim() ?? '';
  if (!raw) return { status: 'omitted' };
  const code = knownNativeCode(raw);
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
): { ok: StaffQuoteGroupInput[] } | { error: string } {
  const out: StaffQuoteGroupInput[] = [];
  for (const group of groups) {
    if (!group.arrivalDate || !group.departureDate) {
      return { error: 'Enter the arrival and departure dates before running the quote.' };
    }
    if (group.board === 'unknown') {
      return { error: 'Choose a meal plan for the stay before running the quote.' };
    }
    if (typeof group.quantity !== 'number' || typeof group.adults !== 'number') {
      return { error: 'Enter the number of rooms and adults before running the quote.' };
    }
    const rooms = resolveNativeRoomCodes({
      roomPreference: group.roomPreference,
      roomCodes: group.roomCodes,
    });
    if (rooms.status === 'unresolved') {
      return {
        error: `Room type "${rooms.label}" is not one HMS knows. Choose one of: ${[...KNOWN_NATIVE_ROOM_CODES].join(', ')}.`,
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
  const summary = (value as { reviewSummary?: { staffActions?: unknown } }).reviewSummary;
  const raw = summary?.staffActions ?? (value as { staffActions?: unknown }).staffActions;
  if (!Array.isArray(raw)) return [];
  const actions: ReservationistStaffAction[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const action = row as Record<string, unknown>;
    if (action.status !== 'open') continue;
    if (action.kind !== 'unanswered_question' && action.kind !== 'business_document_failure' && action.kind !== 'pricing_fact') {
      continue;
    }
    if (typeof action.id !== 'string' || !action.id.trim()) continue;
    if (typeof action.text !== 'string' || !action.text.trim()) continue;
    if (typeof action.sourceRef !== 'string' || !action.sourceRef.trim()) continue;
    if (typeof action.sourceHash !== 'string' || !SOURCE_HASH.test(action.sourceHash)) continue;
    if (typeof action.blockingQuote !== 'boolean') continue;
    actions.push({
      id: action.id,
      kind: action.kind,
      text: action.text,
      sourceRef: action.sourceRef,
      sourceHash: action.sourceHash,
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
    });
  }
  return actions;
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
  | { kind: 'ready'; actions: ReservationistStaffAction[] };

export async function bindStaffActions(args: {
  list?: (input: { threadId: string; limit?: number }) => Promise<unknown>;
  get?: (input: { id: string }) => Promise<unknown>;
  threadId?: string;
}): Promise<BoundStaffActions> {
  if (!args.threadId?.trim()) {
    return { kind: 'unavailable', reason: 'Actions for this email are not ready yet. Select it again.' };
  }
  if (!args.list && !args.get) {
    return { kind: 'unavailable', reason: 'Email actions cannot be loaded from this pane yet. Refresh the pane and try again.' };
  }
  try {
    if (args.list) {
      const listed = await args.list({ threadId: args.threadId, limit: 20 });
      const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === 'object' && Array.isArray((listed as { drafts?: unknown }).drafts)
          ? (listed as { drafts: unknown[] }).drafts
          : [];
      const collected: ReservationistStaffAction[] = [];
      for (const row of rows) {
        const fromList = readStaffActions(row);
        if (fromList.length) {
          collected.push(...fromList);
          continue;
        }
        const id = row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
          ? (row as { id: string }).id
          : '';
        if (id && args.get) {
          collected.push(...readStaffActions(await args.get({ id })));
        }
      }
      return { kind: 'ready', actions: collected };
    }
    return { kind: 'ready', actions: [] };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error) };
  }
}

/** Must match NATIVE_NO_MATCHING_RATE_PREFIX in apps/server-pilot/src/trpc/routes/workstation.ts. */
const NATIVE_NO_MATCHING_RATE_PREFIX = 'HMS has no rate for this meal plan under ';

export type BoundExecuteStaffQuote =
  | { status: 'unavailable'; reason: string; noMatchingRate?: boolean }
  | { status: 'ok'; offer: QuoteOffer; staffQuote: StaffQuoteAllocation; extrasReviewItems: string[] };

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
  | 'dinnerAllowanceGroupIds'
  | 'shuttleRequested'
  | 'shuttleMinor'
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
    ...(header.dinnerAllowanceMinor && header.dinnerAllowanceMinor > 0
      ? {
          dinnerAllowanceMinor: header.dinnerAllowanceMinor,
          ...(dinnerGroupIds ? { dinnerAllowanceGroupIds: dinnerGroupIds } : {}),
        }
      : {}),
    ...(header.shuttleRequested ? { shuttleRequested: true } : {}),
    ...(header.shuttleMinor && header.shuttleMinor > 0 ? { shuttleMinor: header.shuttleMinor } : {}),
  };
}

export async function bindExecuteStaffQuote(args: {
  mutate?: (input: ExecuteStaffQuoteInput) => Promise<ExecuteStaffQuoteResult | { status?: string; alternatives?: unknown }>;
  source: StaffQuoteSource;
  selectionEpoch: number;
  inputRevision: number;
  groups: StayGroupRequirement[];
  header: StaffQuoteHeader;
}): Promise<BoundExecuteStaffQuote> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason:
        'Quoting is not connected to this pane yet. Refresh the pane and try again.',
    };
  }
  const prepared = staffQuoteGroupsFromStay(args.groups);
  if ('error' in prepared) return { status: 'unavailable', reason: prepared.error };
  try {
    const header = approvedExecuteHeader(
      args.header,
      prepared.ok.map((group) => group.id),
    );
    const result = await args.mutate({
      messageId: args.source.messageId,
      sourceHash: args.source.sourceHash,
      selectionEpoch: args.selectionEpoch,
      inputRevision: args.inputRevision,
      groups: prepared.ok,
      ...header,
    });
    if (!result || typeof result !== 'object') {
      return { status: 'unavailable', reason: 'HMS returned no result for this quote. Try again.' };
    }
    if ('alternatives' in result && Array.isArray(result.alternatives) && result.alternatives.length) {
      return { status: 'unavailable', reason: 'HMS returned several room options. Pick one, then try again.' };
    }
    if (result.status !== 'ready' || !('workflowRunId' in result)) {
      return { status: 'unavailable', reason: 'HMS did not return a room option that can be booked. Try again.' };
    }
    if (result.selectionEpoch !== args.selectionEpoch || result.inputRevision !== args.inputRevision) {
      return { status: 'unavailable', reason: 'The quote is out of date because the stay details changed. Run it again.' };
    }
    if (result.messageId !== args.source.messageId) {
      return { status: 'unavailable', reason: 'The quote does not match the selected email. Select the email again, then run it again.' };
    }
    if (typeof result.workflowRunId !== 'string' || !result.workflowRunId.trim()) {
      return { status: 'unavailable', reason: 'HMS did not return a quote reference. Try again.' };
    }
    if (typeof result.revisionRef !== 'string' || !result.revisionRef.trim()) {
      return { status: 'unavailable', reason: 'HMS did not return a quote revision. Try again.' };
    }
    if (result.currency !== 'ZAR' || !Number.isSafeInteger(result.totalMinor) || result.totalMinor <= 0) {
      return { status: 'unavailable', reason: 'HMS returned a total that cannot be used. Try again, or check the rate in HMS.' };
    }
    const staffQuote: StaffQuoteAllocation = {
      workflowRunId: result.workflowRunId,
      revisionRef: result.revisionRef,
      factRefs: Array.isArray(result.factRefs) ? result.factRefs.filter((ref): ref is string => typeof ref === 'string') : [],
      messageId: result.messageId,
      threadId: result.threadId,
      sourceHash: args.source.sourceHash,
      selectionEpoch: result.selectionEpoch,
      inputRevision: result.inputRevision,
      inputDigest: result.inputDigest,
      totalMinor: result.totalMinor,
      currency: result.currency,
      quoteRequestKey: `${result.arrivalDate}:${result.departureDate}`,
      approvedHeader: {
        salesStrategy: header.salesStrategy,
        company: header.company,
        agency: header.agency,
        attention: header.attention,
        clientEmail: header.clientEmail,
        clientTelephone: header.clientTelephone,
      },
      runId: typeof result.runId === 'string' && result.runId.trim() ? result.runId : null,
      screenshots: Array.isArray(result.screenshots)
        ? result.screenshots.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        : [],
    };
    return {
      status: 'ok',
      offer: allocationFromStaffQuote(result, args.groups),
      staffQuote,
      extrasReviewItems: Array.isArray(result.extrasReviewItems)
        ? result.extrasReviewItems.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [],
    };
  } catch (error) {
    const reason = rejectionReason(error);
    return {
      status: 'unavailable',
      reason,
      noMatchingRate: reason.startsWith(NATIVE_NO_MATCHING_RATE_PREFIX),
    };
  }
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
      pdf.revisionId !== args.input.revisionRef ||
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
  executeStaffQuote?: { mutate: (input: ExecuteStaffQuoteInput) => Promise<ExecuteStaffQuoteResult> };
  hmsQueueStatus?: { query: () => Promise<QueueStatus> };
  quoteRunScreenshot?: {
    query: (input: { runId: string; name: string }) => Promise<QuoteRunScreenshotResult>;
  };
  qualifiedQuoteProposalPdf?: { mutate: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffPdfResult> };
  prepareBookingDraft?: { mutate: (input: PrepareBookingDraftInput) => Promise<PrepareBookingDraftResult> };
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
};

export function staffQuoteFromTrpc(trpc: unknown): {
  workstation: StaffQuoteClient;
  drafts: DraftsClient;
} {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return { workstation: {}, drafts: {} };
  const row = trpc as { workstation?: StaffQuoteClient; drafts?: DraftsClient };
  return { workstation: row.workstation ?? {}, drafts: row.drafts ?? {} };
}
