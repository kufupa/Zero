import type {
  BookingDraftReady,
  LunaAnalysisWire,
  QuoteBoard,
  RowPriceChoice,
  StaffQuoteHeader,
  QuoteSalesStrategyValue,
  StaffQuoteOtherCharge,
  StaffQuoteSource,
  StayGroupRequirement,
} from './types';
import { staffQuoteGroupsFromStay } from './staff-quote-bind';
import type { StaffQuoteGroupInput, StaffRowPriceWire } from './staff-quote-bind';

export type PrepareBookingDraftInput = {
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
};

export const UNQUOTED_BOOKING_REVISION_REF = 'unquoted';
export type PrepareUnquotedBookingDraftInput = {
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
  rateCode?: string;
};

export type PrepareBookingDraftResult =
  | { status: 'unavailable'; reason?: string }
  | ({ status: 'ready' } & BookingDraftReady);

export type BoundPrepareBookingDraft =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; payload: BookingDraftReady };

function rejectionReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'The request did not finish. Refresh the pane and try again.';
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
      reason: 'The booking draft cannot be prepared from this pane yet. Refresh the pane and try again.',
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
          : 'HMS did not return a booking draft. Check the quote, then try again.';
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
        reason: 'The booking draft is out of date because the selection changed. Select the email again.',
      };
    }
    if (!ready.draft || !Array.isArray(ready.draft.rooms) || !ready.options) {
      return { status: 'unavailable', reason: 'HMS returned an incomplete booking draft. Try again.' };
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
    return { status: 'unavailable', reason: rejectionReason(error) };
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
  /** Whether the earlier quote's total has the once-per-quote extras. Absent from an older server: treated as no. */
  onceExtras?: boolean;
};

function carriedStayId(group: { stayId?: string | null }): string | undefined {
  const id = typeof group.stayId === 'string' ? group.stayId.trim() : '';
  return id.length > 0 ? id : undefined;
}

function withinStayIndex(groups: { stayId?: string | null }[], index: number, stayId: string): number {
  let count = 0;
  for (let i = 0; i < index; i++) {
    if (carriedStayId(groups[i]) === stayId) count += 1;
  }
  return count;
}

function matchLunaGroup(
  lunaGroups: LunaAnalysisWire['groups'],
  group: StayGroupRequirement,
  index: number,
  groups: StayGroupRequirement[],
): LunaAnalysisWire['groups'][number] | undefined {
  const stayId = carriedStayId(group);
  const analysisHasStayId = lunaGroups.some((row) => carriedStayId(row));
  if (stayId && analysisHasStayId) {
    const ofStay = lunaGroups.filter((row) => carriedStayId(row) === stayId);
    return ofStay[withinStayIndex(groups, index, stayId)];
  }
  if (lunaGroups.length === groups.length) return lunaGroups[index];
  return undefined;
}

export function overlayLunaGroupsFromStaff(
  luna: LunaAnalysisWire,
  groups: StayGroupRequirement[],
): LunaAnalysisWire['groups'] {
  if (!groups.length) return luna.groups;
  return groups.map((group, index) => {
    const match = matchLunaGroup(luna.groups, group, index, groups);
    const stayId = carriedStayId(group) ?? carriedStayId(match ?? {});
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
      ...(stayId ? { stayId } : {}),
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
    return { status: 'unavailable', reason: 'Earlier quotes cannot be reused from this pane yet. Refresh the pane and try again.' };
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
          : 'HMS did not return a booking draft from the earlier quote. Try again.';
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
        reason: 'The earlier quote no longer matches the selected email. Select the email again.',
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
        onceExtras: result.onceExtras === true,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error) };
  }
}

export type PriorStaffQuoteRequotePayload = {
  groups: StaffQuoteGroupInput[];
  salesStrategy: QuoteSalesStrategyValue;
  company: string;
  agency: string;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceUnit?: 'per_person_per_night' | 'per_room_per_night' | 'per_person';
  dinnerAllowanceGroupIds?: string[];
  dinnerAllowanceLabel?: string;
  lunchAllowanceMinor?: number;
  lunchAllowanceLabel?: string;
  officeTransferMinor?: number;
  officeTransferDays?: number;
  shuttleRequested?: boolean;
  shuttleMinor?: number;
  shuttleTrips?: number;
  other?: StaffQuoteOtherCharge;
  notes?: string;
  /** The row prices the quote was run with, keyed by the stored row ids. A re-quote asks for the same prices again. */
  rowPrices?: StaffRowPriceWire[];
};

/**
 * A stored row price as a row's price. The payload names a saved rate by id only, so its name and amount are left for
 * the re-quote's row rates to show.
 */
function storedRowPrice(price: StaffRowPriceWire): RowPriceChoice {
  if (price.source === 'saved') return { source: 'saved', customRateId: price.customRateId, name: 'Saved rate', amountMinor: 0 };
  if (price.source === 'one_off') return { source: 'one_off', amountMinor: price.oneOffRate };
  return { source: 'override', rateCode: price.rateCode, amountMinor: price.overrideRate, note: price.note };
}

export type PriorStaffQuoteRequoteRow = {
  workflowRunId: string;
  revisionRef: string;
};

export const EXPIRED_PRIOR_QUOTE_REQUOTE_LABEL = 'Re-quote this stay';

export function expiredPriorQuoteToastMessage(): string {
  return 'This quote has expired. Re-quote the same stay, or run the search again.';
}

/** Prefer a matching expired revision over unrelated stay mismatches on the same thread. */
export function expiredPriorQuoteNotice(
  reasons: readonly string[],
  expiredPrior: PriorStaffQuoteRequoteRow | null,
): 'requote' | 'mismatch' | null {
  if (expiredPrior) return 'requote';
  if (reasons.includes('scope_mismatch')) return 'mismatch';
  return null;
}

/** Stay groups and party header for bindExecuteStaffQuote after an expired prior revision. */
export function buildExpiredPriorRequoteBindArgs(args: {
  stored: PriorStaffQuoteRequotePayload;
  sessionGroups: StayGroupRequirement[];
  sessionHeader: StaffQuoteHeader;
  staffEdited: boolean;
}): { groups: StayGroupRequirement[]; header: StaffQuoteHeader } {
  if (!args.staffEdited) {
    const oneStay = new Set(args.sessionGroups.map(dateKeyOf)).size <= 1;
    const mappedGroupIds = new Map<string, string>();
    const groups = args.stored.groups.map((group, index) => {
      // A row takes the id of the session row for the same stay, so another stay's row id never lands here.
      const within = args.stored.groups.slice(0, index).filter((row) => dateKeyOf(row) === dateKeyOf(group)).length;
      const sameStay = args.sessionGroups.filter((row) => dateKeyOf(row) === dateKeyOf(group));
      const price = args.stored.rowPrices?.find((row) => row.groupId === group.id);
      const id = sameStay[within]?.id ?? (oneStay ? args.sessionGroups[index]?.id : undefined) ?? group.id;
      mappedGroupIds.set(group.id, id);
      return {
        id,
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
        ...(price ? { rowPrice: storedRowPrice(price) } : {}),
      };
    });
    return {
      groups,
      header: {
        ...args.sessionHeader,
        salesStrategy: args.stored.salesStrategy,
        company: args.stored.company,
        agency: args.stored.agency,
        ...(args.stored.dinnerAllowanceMinor !== undefined
          ? { dinnerAllowanceMinor: args.stored.dinnerAllowanceMinor }
          : {}),
        ...(args.stored.shuttleRequested
          ? {
              shuttleRequested: true,
              ...(args.stored.shuttleMinor !== undefined
                ? { shuttleMinor: args.stored.shuttleMinor }
                : {}),
            }
          : {}),
        ...definedEntries({
          dinnerAllowanceLabel: args.stored.dinnerAllowanceLabel,
          dinnerAllowanceUnit: args.stored.dinnerAllowanceUnit,
          dinnerAllowanceGroupIds: args.stored.dinnerAllowanceGroupIds?.flatMap((id) => {
            const mapped = mappedGroupIds.get(id);
            return mapped ? [mapped] : [];
          }),
          lunchAllowanceMinor: args.stored.lunchAllowanceMinor,
          lunchAllowanceLabel: args.stored.lunchAllowanceLabel,
          officeTransferMinor: args.stored.officeTransferMinor,
          officeTransferDays: args.stored.officeTransferDays,
          shuttleTrips: args.stored.shuttleTrips,
          other: args.stored.other,
          notes: args.stored.notes,
        }),
      },
    };
  }
  // With several stays, re-quote only the session rows of the one stay this revision quoted. Every row in one run would
  // merge the stays. When that stay's dates were edited away, or the revision spans stays, there is nothing safe to send.
  if (new Set(args.sessionGroups.map(dateKeyOf)).size <= 1) {
    return { groups: args.sessionGroups, header: args.sessionHeader };
  }
  const quoted = new Set(args.stored.groups.map(dateKeyOf));
  const groups = quoted.size === 1 ? args.sessionGroups.filter((row) => quoted.has(dateKeyOf(row))) : [];
  return { groups, header: args.sessionHeader };
}

/** The stay a row belongs to, by its dates. */
function dateKeyOf(row: { arrivalDate?: string; departureDate?: string }): string {
  return `${row.arrivalDate ?? 'unknown'}:${row.departureDate ?? 'unknown'}`;
}

/** Copies only the keys that have a value, so a missing stored field keeps the session's own value. */
function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
    return { status: 'unavailable', reason: 'Earlier quotes cannot be loaded from this pane yet. Refresh the pane and try again.' };
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
            : 'The earlier quote could not be loaded. Run the search again.',
      };
    }
    return { status: 'ok', payload: result.payload };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error) };
  }
}
