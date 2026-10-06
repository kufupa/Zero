import type {
  QuoteOffer,
  ReservationistStaffAction,
  StaffQuoteAllocation,
  StaffQuoteHeader,
  StaffQuoteSource,
  StayGroupRequirement,
} from './types';

const SOURCE_HASH = /^[a-f0-9]{64}$/;
const NATIVE_ROOM_CODE = /^[A-Z0-9_-]{1,16}$/;
const ROOM_LABELS = new Set([
  'SUITE',
  'TWIN',
  'KING',
  'STANDARD',
  'DELUXE',
  'DOUBLE',
  'SINGLE',
  'FAMILY',
  'STUDIO',
  'ROOM',
  'EXECUTIVE',
  'PREMIUM',
  'CLASSIC',
  'SUPERIOR',
  'QUEEN',
  'JUNIOR',
  'APARTMENT',
  'STANDARDKING',
  'STANDARDTWIN',
  'STANDARDDOUBLE',
]);

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
};

export type ExecuteStaffQuoteResult = {
  status: 'ready';
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  threadId: string;
  factRefs: string[];
  selectionEpoch: number;
  inputRevision: number;
  inputDigest: string;
  totalMinor: number;
  currency: string;
  arrivalDate: string;
  departureDate: string;
  description: string;
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

function rejectionReason(error: unknown, label: string): string {
  return error instanceof Error && error.message.trim() ? error.message : `${label} rejected`;
}

export function nativeRoomCodes(preference: string | undefined): string[] | undefined {
  const raw = preference?.trim() ?? '';
  if (!raw) return undefined;
  const code = raw.toUpperCase();
  if (!NATIVE_ROOM_CODE.test(code)) return undefined;
  if (ROOM_LABELS.has(code.replace(/[-_]/g, ''))) return undefined;
  return [code];
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
      return { error: 'Arrival and departure dates are required before executeStaffQuote.' };
    }
    if (group.board === 'unknown') {
      return { error: 'Board is unknown. Correct the stay facts before executeStaffQuote.' };
    }
    if (typeof group.quantity !== 'number' || typeof group.adults !== 'number') {
      return { error: 'Quantity and adult occupancy are required before executeStaffQuote.' };
    }
    const roomCodes = nativeRoomCodes(group.roomPreference);
    out.push({
      id: group.id,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      adults: group.adults,
      childrenAges: [...group.childrenAges],
      board: group.board,
      ...(roomCodes ? { roomCodes } : {}),
    });
  }
  const dates = new Set(out.map((group) => `${group.arrivalDate}/${group.departureDate}`));
  if (dates.size !== 1) {
    return { error: 'Distinct stays need separate executeStaffQuote calls.' };
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
    return { kind: 'unavailable', reason: 'staffQuoteSource needs the selected internetMessageId.' };
  }
  if (!args.query) {
    return {
      kind: 'unavailable',
      reason: 'Client has no workstation.staffQuoteSource. Snapshot still pending.',
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
      return { kind: 'unavailable', reason: 'staffQuoteSource did not return a server-resolved sourceHash.' };
    }
    return {
      kind: 'ready',
      source: { messageId: result.messageId, threadId: result.threadId, sourceHash: result.sourceHash },
    };
  } catch (error) {
    return { kind: 'unavailable', reason: rejectionReason(error, 'staffQuoteSource') };
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
    return { kind: 'unavailable', reason: 'staffActions need the server-resolved threadId.' };
  }
  if (!args.list && !args.get) {
    return { kind: 'unavailable', reason: 'Client has no drafts.list/get for staffActions.' };
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
    return { kind: 'unavailable', reason: rejectionReason(error, 'staffActions') };
  }
}

export type BoundExecuteStaffQuote =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; offer: QuoteOffer; staffQuote: StaffQuoteAllocation };

export function allocationFromStaffQuote(
  result: ExecuteStaffQuoteResult,
  groups: readonly StayGroupRequirement[],
): QuoteOffer {
  return {
    id: result.revisionRef,
    kind: 'allocation',
    roomCode: '',
    roomLabel: result.description.trim() || 'Selected allocation',
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

function headerFields(header: StaffQuoteHeader): Pick<
  ExecuteStaffQuoteInput,
  'salesStrategy' | 'company' | 'agency' | 'attention' | 'clientEmail' | 'clientTelephone'
> {
  return {
    salesStrategy: header.salesStrategy === 'Government' ? 'Government' : 'BAR',
    company: header.company.trim(),
    agency: header.agency.trim(),
    attention: header.attention.trim(),
    clientEmail: header.clientEmail.trim(),
    clientTelephone: header.clientTelephone.trim(),
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
        'Client has no workstation.executeStaffQuote. Do not call enqueueHmsRead or execute party separately.',
    };
  }
  const prepared = staffQuoteGroupsFromStay(args.groups);
  if ('error' in prepared) return { status: 'unavailable', reason: prepared.error };
  try {
    const header = headerFields(args.header);
    const result = await args.mutate({
      messageId: args.source.messageId,
      sourceHash: args.source.sourceHash,
      selectionEpoch: args.selectionEpoch,
      inputRevision: args.inputRevision,
      groups: prepared.ok,
      ...header,
    });
    if (!result || typeof result !== 'object') {
      return { status: 'unavailable', reason: 'executeStaffQuote returned an empty result.' };
    }
    if ('alternatives' in result && Array.isArray(result.alternatives) && result.alternatives.length) {
      return { status: 'unavailable', reason: 'executeStaffQuote returned alternatives. One selected allocation is required.' };
    }
    if (result.status !== 'ready') {
      return { status: 'unavailable', reason: 'executeStaffQuote did not return a ready selected allocation.' };
    }
    if (result.selectionEpoch !== args.selectionEpoch || result.inputRevision !== args.inputRevision) {
      return { status: 'unavailable', reason: 'executeStaffQuote result is stale against the current input revision.' };
    }
    if (result.messageId !== args.source.messageId) {
      return { status: 'unavailable', reason: 'executeStaffQuote result messageId does not match staffQuoteSource.' };
    }
    if (typeof result.workflowRunId !== 'string' || !result.workflowRunId.trim()) {
      return { status: 'unavailable', reason: 'executeStaffQuote omitted workflowRunId.' };
    }
    if (typeof result.revisionRef !== 'string' || !result.revisionRef.trim()) {
      return { status: 'unavailable', reason: 'executeStaffQuote omitted revisionRef.' };
    }
    if (result.currency !== 'ZAR' || !Number.isSafeInteger(result.totalMinor) || result.totalMinor < 0) {
      return { status: 'unavailable', reason: 'executeStaffQuote total is not an authentic ZAR minor amount.' };
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
    };
    return {
      status: 'ok',
      offer: allocationFromStaffQuote(result, args.groups),
      staffQuote,
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'executeStaffQuote') };
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
        'Client has no workstation.qualifiedQuoteProposalPdf. Do not invent a second PDF engine or mint centsReconciled:true.',
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
      !pdf.pdfHash.trim() ||
      typeof pdf.revisionId !== 'string' ||
      pdf.revisionId !== args.input.revisionRef ||
      !Number.isSafeInteger(pdf.totalMinor) ||
      pdf.totalMinor !== args.expectedTotalMinor
    ) {
      return {
        status: 'unavailable',
        reason: 'qualifiedQuoteProposalPdf omitted real bytes/hash/revision identity or total does not match the selected revision.',
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
    return { status: 'unavailable', reason: rejectionReason(error, 'qualifiedQuoteProposalPdf') };
  }
}

type StaffQuoteClient = {
  staffQuoteSource?: { query: (input: { internetMessageId: string }) => Promise<StaffQuoteSourceResult> };
  executeStaffQuote?: { mutate: (input: ExecuteStaffQuoteInput) => Promise<ExecuteStaffQuoteResult> };
  qualifiedQuoteProposalPdf?: { mutate: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffPdfResult> };
};

type DraftsClient = {
  list?: { query: (input: { threadId: string; limit?: number }) => Promise<unknown> };
  get?: { query: (input: { id: string }) => Promise<unknown> };
};

export function staffQuoteFromTrpc(trpc: unknown): {
  workstation: StaffQuoteClient;
  drafts: DraftsClient;
} {
  if (!trpc || typeof trpc !== 'object') return { workstation: {}, drafts: {} };
  const row = trpc as { workstation?: StaffQuoteClient; drafts?: DraftsClient };
  return { workstation: row.workstation ?? {}, drafts: row.drafts ?? {} };
}
