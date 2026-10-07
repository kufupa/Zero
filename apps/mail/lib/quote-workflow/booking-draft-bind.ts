import type {
  BookingDraftReady,
  LunaAnalysisWire,
  QuoteBoard,
  StaffQuoteHeader,
  StaffQuoteSource,
  StayGroupRequirement,
} from './types';
import { staffQuoteGroupsFromStay } from './staff-quote-bind';
import type { StaffQuoteGroupInput } from './staff-quote-bind';

export type PrepareBookingDraftInput = {
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
};

export type PrepareBookingDraftResult =
  | { status: 'unavailable'; reason?: string }
  | ({ status: 'ready' } & BookingDraftReady);

export type BoundPrepareBookingDraft =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; payload: BookingDraftReady };

function rejectionReason(error: unknown, label: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `${label} failed.`;
}

export async function bindPrepareBookingDraft(args: {
  mutate?: (input: PrepareBookingDraftInput) => Promise<PrepareBookingDraftResult | { status?: string }>;
  source: StaffQuoteSource;
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
}): Promise<BoundPrepareBookingDraft> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason: 'Client has no workstation.prepareBookingDraft.',
    };
  }
  try {
    const result = await args.mutate({
      workflowRunId: args.workflowRunId,
      revisionRef: args.revisionRef,
      messageId: args.messageId,
      selectionEpoch: args.selectionEpoch,
      inputRevision: args.inputRevision,
      analysis: args.analysis,
    });
    if (!result || typeof result !== 'object' || result.status !== 'ready') {
      const reason =
        result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : 'prepareBookingDraft did not return a ready draft.';
      return { status: 'unavailable', reason };
    }
    const ready = result as { status: 'ready' } & BookingDraftReady;
    if (
      ready.selectionEpoch !== args.selectionEpoch ||
      ready.inputRevision !== args.inputRevision ||
      ready.messageId !== args.source.messageId ||
      ready.revisionRef !== args.revisionRef
    ) {
      return {
        status: 'unavailable',
        reason: 'prepareBookingDraft result is stale against the current selection.',
      };
    }
    if (!ready.draft || !Array.isArray(ready.draft.rooms) || !ready.options) {
      return { status: 'unavailable', reason: 'prepareBookingDraft omitted draft rooms or options.' };
    }
    return {
      status: 'ok',
      payload: {
        draft: ready.draft,
        options: ready.options,
        messageId: ready.messageId,
        selectionEpoch: ready.selectionEpoch,
        inputRevision: ready.inputRevision,
        revisionRef: ready.revisionRef,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'prepareBookingDraft') };
  }
}

export type UsePriorQuoteForBookingInput = PrepareBookingDraftInput & { threadId: string };

export type UsePriorQuoteForBookingReady = BookingDraftReady & {
  workflowRunId: string;
  totalMinor: number;
  currency: string;
  arrivalDate: string;
  departureDate: string;
  roomCode: string;
  rateCode: string;
  board: QuoteBoard;
};

export function overlayLunaGroupsFromStaff(
  luna: LunaAnalysisWire,
  groups: StayGroupRequirement[],
): LunaAnalysisWire['groups'] {
  if (!groups.length) return luna.groups;
  return groups.map((group, index) => {
    const match =
      luna.groups.find(
        (row) => row.arrival === (group.arrivalDate ?? null) && row.departure === (group.departureDate ?? null),
      ) ?? luna.groups[index];
    return {
      arrival: group.arrivalDate ?? null,
      departure: group.departureDate ?? null,
      rooms: group.quantity ?? null,
      adultsPerRoom: group.adults ?? null,
      childAges: [...(group.childrenAges ?? [])],
      board:
        group.board === 'dinner_bb'
          ? 'dbb'
          : group.board === 'unknown' || !group.board
            ? null
            : group.board,
      roomPreference: group.roomPreference ?? null,
      guestNames: [...(match?.guestNames ?? [])],
    };
  });
}

export function offerBoardFromRevision(board: string | null | undefined): QuoteBoard {
  if (board === 'room_only') return 'room_only';
  if (board === 'dinner_bed_breakfast' || board === 'dinner_bb' || board === 'dbb') return 'dinner_bb';
  return 'bb';
}

export type BoundUsePriorQuoteForBooking =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; payload: UsePriorQuoteForBookingReady };

export async function bindListThreadQuoteRevisions(args: {
  query?: (input: { threadId: string }) => Promise<{ revisions?: Array<{ workflowRunId: string; revisionRef: string }> }>;
  threadId: string;
}): Promise<{ workflowRunId: string; revisionRef: string }[]> {
  if (!args.query) return [];
  try {
    const result = await args.query({ threadId: args.threadId });
    return Array.isArray(result?.revisions) ? result.revisions.filter((row) => row.workflowRunId && row.revisionRef) : [];
  } catch {
    return [];
  }
}

export async function bindUsePriorQuoteForBooking(args: {
  mutate?: (
    input: UsePriorQuoteForBookingInput,
  ) => Promise<
    | { status: 'unavailable'; reason?: string }
    | ({ status: 'ready' } & UsePriorQuoteForBookingReady)
  >;
  source: StaffQuoteSource;
  workflowRunId: string;
  revisionRef: string;
  threadId: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
}): Promise<BoundUsePriorQuoteForBooking> {
  if (!args.mutate) {
    return { status: 'unavailable', reason: 'Client has no workstation.usePriorQuoteForBooking.' };
  }
  try {
    const result = await args.mutate({
      workflowRunId: args.workflowRunId,
      revisionRef: args.revisionRef,
      threadId: args.threadId,
      messageId: args.messageId,
      selectionEpoch: args.selectionEpoch,
      inputRevision: args.inputRevision,
      analysis: args.analysis,
    });
    if (!result || typeof result !== 'object' || result.status !== 'ready') {
      const reason =
        result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : 'usePriorQuoteForBooking did not return a ready draft.';
      return { status: 'unavailable', reason };
    }
    if (
      result.selectionEpoch !== args.selectionEpoch ||
      result.inputRevision !== args.inputRevision ||
      result.messageId !== args.source.messageId ||
      result.revisionRef !== args.revisionRef
    ) {
      return {
        status: 'unavailable',
        reason: 'usePriorQuoteForBooking result is stale against the current selection.',
      };
    }
    return {
      status: 'ok',
      payload: {
        draft: result.draft,
        options: result.options,
        messageId: result.messageId,
        selectionEpoch: result.selectionEpoch,
        inputRevision: result.inputRevision,
        revisionRef: result.revisionRef,
        workflowRunId: result.workflowRunId,
        totalMinor: result.totalMinor,
        currency: result.currency,
        arrivalDate: result.arrivalDate,
        departureDate: result.departureDate,
        roomCode: result.roomCode,
        rateCode: result.rateCode,
        board: offerBoardFromRevision(result.board),
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'usePriorQuoteForBooking') };
  }
}

export type PriorStaffQuoteRequotePayload = {
  groups: StaffQuoteGroupInput[];
  salesStrategy: 'BAR' | 'Government';
  company: string;
  agency: string;
};

export type PriorStaffQuoteRequoteRow = {
  workflowRunId: string;
  revisionRef: string;
};

export const EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL = 'Re-quote same stay';

export function expiredPriorQuoteToastMessage(): string {
  return 'This quote expired — re-quote the same stay or run Quote again';
}

/** Stay groups and party header for bindExecuteStaffQuote after an expired prior revision. */
export function buildExpiredPriorRequoteBindArgs(args: {
  stored: PriorStaffQuoteRequotePayload;
  sessionGroups: StayGroupRequirement[];
  sessionHeader: StaffQuoteHeader;
  staffEdited: boolean;
}): { groups: StayGroupRequirement[]; header: StaffQuoteHeader } {
  if (!args.staffEdited) {
    const groups = args.stored.groups.map((group, index) => ({
      id: args.sessionGroups[index]?.id ?? group.id,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      adults: group.adults,
      childrenAges: [...group.childrenAges],
      board: group.board,
      roomCodes: group.roomCodes ? [...group.roomCodes] : undefined,
      roomPreference: group.roomCodes?.[0],
      specialRequests: [],
      fields: {},
    }));
    return {
      groups,
      header: {
        ...args.sessionHeader,
        salesStrategy: args.stored.salesStrategy,
        company: args.stored.company,
        agency: args.stored.agency,
      },
    };
  }
  return { groups: args.sessionGroups, header: args.sessionHeader };
}

export function staffQuoteGroupsForExpiredPriorRequote(args: {
  stored: PriorStaffQuoteRequotePayload;
  sessionGroups: StayGroupRequirement[];
  staffEdited: boolean;
}): StaffQuoteGroupInput[] | { error: string } {
  const { groups } = buildExpiredPriorRequoteBindArgs({
    stored: args.stored,
    sessionGroups: args.sessionGroups,
    sessionHeader: { salesStrategy: args.stored.salesStrategy, company: '', agency: '', attention: '', clientEmail: '', clientTelephone: '' },
    staffEdited: args.staffEdited,
  });
  const prepared = staffQuoteGroupsFromStay(groups);
  if ('error' in prepared) return prepared;
  return prepared.ok;
}

export async function bindGetPriorStaffQuoteRequote(args: {
  query?: (input: PriorStaffQuoteRequoteRow & { threadId: string }) => Promise<
    | { status: 'unavailable'; reason?: string }
    | { status: 'ready'; payload: PriorStaffQuoteRequotePayload }
  >;
  threadId: string;
  row: PriorStaffQuoteRequoteRow;
}): Promise<
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; payload: PriorStaffQuoteRequotePayload }
> {
  if (!args.query) {
    return { status: 'unavailable', reason: 'Client has no workstation.getPriorStaffQuoteRequote.' };
  }
  try {
    const result = await args.query({
      workflowRunId: args.row.workflowRunId,
      revisionRef: args.row.revisionRef,
      threadId: args.threadId,
    });
    if (!result || result.status !== 'ready' || !result.payload?.groups?.length) {
      return {
        status: 'unavailable',
        reason:
          result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string'
            ? result.reason
            : 'getPriorStaffQuoteRequote did not return stored groups.',
      };
    }
    return { status: 'ok', payload: result.payload };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'getPriorStaffQuoteRequote') };
  }
}
