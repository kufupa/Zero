import type {
  ApprovedStayGroup,
  LunaAnalysisWire,
  PartyLookupRef,
  QuoteAmendment,
  QuoteAnalysis,
  QuoteEvidenceProvenance,
  QuoteOffer,
  QuoteSession,
  QuoteSessionAction,
  QuoteSelectionBinding,
  QuoteStepInputs,
  QuoteToolStep,
  RemovedStay,
  DinnerAddOnUnit,
  StaffQuoteAllocation,
  StaffStayExtras,
  StayGroupRequirement,
  StaffQuoteHeader,
  QuotePdf,
  QuoteSalesStrategyCode,
  QuoteStrategyRow,
} from './types';
import {
  emptyStaffQuoteHeader,
  staffHeaderFieldProblem,
  staffStayExtrasFor,
  type StaffExtraField,
} from './types';
import { documentFailureItems, projectQuoteReviewItems } from './review-items';
import {
  approvedExecuteHeader,
  groupsWithPreparedStayRates,
  hasPerStaySingleChargeExtras,
  staffHeaderForStay,
} from './staff-quote-bind';
import { rowRoomLabel, rowRoomTypeCode, type RoomTypeCode } from './room-types';

export type QuoteStrategyResult = {
  offer: QuoteOffer;
  staffQuote: StaffQuoteAllocation;
  extrasReviewItems?: string[];
  /** Per-strategy document cache; changing the selected row never discards earlier PDFs. */
  pdf?: QuotePdf;
};

export type QuoteWorkflowSession = QuoteSession & {
  quoteStrategyRows: Record<string, Partial<Record<QuoteSalesStrategyCode, QuoteStrategyRow>>>;
  quoteStrategyResults: Record<string, Partial<Record<QuoteSalesStrategyCode, QuoteStrategyResult>>>;
  quoteStrategyRevisions: Record<string, number>;
  quoteStrategySelections: Record<string, QuoteSalesStrategyCode>;
};

type QuoteStrategySessionState = Pick<
  QuoteWorkflowSession,
  'quoteStrategyRows' | 'quoteStrategyResults' | 'quoteStrategyRevisions' | 'quoteStrategySelections'
>;

type QuoteStrategyRequestAction = { stayKey: string; selectionEpoch: number; stayRevision: number };
export type QuoteStrategySessionAction =
  | (QuoteStrategyRequestAction & { type: 'quote_strategy_comparison_started'; strategyCodes: QuoteSalesStrategyCode[] })
  | (QuoteStrategyRequestAction & {
      type: 'quote_strategy_comparison_result';
      strategyCode: QuoteSalesStrategyCode;
      outcome: { strategyCode: QuoteSalesStrategyCode; row: QuoteStrategyRow; result?: QuoteStrategyResult };
    })
  | { type: 'quote_strategy_selected'; stayKey: string; strategyCode: QuoteSalesStrategyCode };

/**
 * The amendment Luna reported on this email, or null. It lives on the analysis, so it survives every reducer
 * that keeps analysis. The workflow badge takes its kind: amendmentKind={amendmentOf(session)?.kind ?? null}.
 * Selecting an amend/cancel stay overlays that card's confirmation so CHECK/amend opens on it.
 */
export function amendmentOf(session: QuoteSession): QuoteAmendment | null {
  const base = session.analysis?.amendment ?? null;
  if (!base) return null;
  const unbound = () => ({
    ...base, confirmationNumber: null, guestLastName: null, arrival: null, departure: null,
    requestedArrival: null, requestedDeparture: null, requestedChange: null,
  });
  const selectedKey = session.selectedStayKey;
  if (!selectedKey) return base;
  const rows = stayAskRows(session, selectedKey);
  if (new Set(rows.map(stayIdOf)).size > 1) return unbound();
  const stays = groupStays(session.groups);
  const stay =
    stays.find((item) => item.id === selectedKey) ??
    stays.find(
      (item) =>
        item.rows.some((row) => stayIdOf(row) === selectedKey) ||
        Boolean(item.rows[0] && stayKeyForGroup(item.rows[0]) === selectedKey),
    );
  if (!stay) return unbound();
  const action = stayAskAction(session, selectedKey);
  if (action !== 'amend' && action !== 'cancel') return unbound();
  const roster = storedStayGuests(session, selectedKey);
  if (roster !== null) {
    const row = rows[0];
    const original = row && session.analysis?.groups.find((item) => item.id === row.id && stayIdOf(item) === stayIdOf(row));
    if (!row || !original) return unbound();
    if (rows.length !== 1 || roster.length > 1 || (row.quantity != null && row.quantity !== 1)) {
      return { ...base, confirmationNumber: null };
    }
    const assigned = trimmedConfirmation(row.confirmationNumber);
    // The stored projection assigns source and thread numbers only when this is the single original room.
    return { ...base, confirmationNumber: assigned };
  }
  // Stored rosters are case-scoped; a newly added or copied stay cannot inherit another case's lookup.
  if (session.analysis?.groups.some((group) => 'stayGuests' in group && Array.isArray(group.stayGuests))) return unbound();
  const confirmations = [...new Set(stayAskGuests(session, selectedKey)
    .map((guest) => guest.confirmationNumber).filter((value): value is string => Boolean(value)))];
  if (confirmations.length > 1) return { ...base, confirmationNumber: null };
  return confirmations[0] ? { ...base, confirmationNumber: confirmations[0] } : base;
}

export function toApprovedStayGroup(group: StayGroupRequirement): ApprovedStayGroup {
  return {
    id: group.id,
    arrivalDate: group.arrivalDate,
    departureDate: group.departureDate,
    quantity: group.quantity,
    roomPreference: group.roomPreference,
    adults: group.adults,
    childrenAges: [...group.childrenAges],
    board: group.board,
    organisation: group.organisation,
    specialRequests: [...group.specialRequests],
  };
}

/**
 * The header an automatic (auto-start or read-back) rate run sends. It mirrors the background prepare in
 * quote-ready.ts: Government only when every requested row is Dinner B&B, else BAR, so the prepared run matches.
 */
export function autoRunHeader(session: Pick<QuoteSession, 'staffHeader' | 'groups'>): StaffQuoteHeader {
  const allDinner = session.groups.length > 0 && session.groups.every((group) => group.board === 'dinner_bb');
  return { ...session.staffHeader, salesStrategy: allDinner ? 'Government' : 'BAR' };
}

export function groupsForQuoteStep(
  session: Pick<QuoteSession, 'groups'>,
  step: QuoteToolStep,
): StayGroupRequirement[] {
  if (step.kind === 'quote_stay' && step.shareKey) {
    return session.groups.filter(
      (group) => `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}` === step.shareKey,
    );
  }
  return session.groups;
}

export function buildQuoteStepInputs(session: QuoteSession, step: QuoteToolStep): QuoteStepInputs {
  const binding = session.binding;
  return {
    stepKind: step.kind,
    binding: {
      transportId: binding?.transportId ?? '',
      mailboxEmail: binding?.mailboxEmail ?? '',
      storeId: binding?.storeId ?? '',
      folderEntryId: binding?.folderEntryId ?? '',
      entryId: binding?.entryId ?? '',
      internetMessageId: binding?.internetMessageId,
      selectionEpoch: binding?.selectionEpoch ?? 0,
    },
    groups: groupsForQuoteStep(session, step).map(toApprovedStayGroup),
    ...(session.partyLookup ? { party: session.partyLookup } : {}),
  };
}

export function stayKeyForGroup(group: StayGroupRequirement): string {
  return `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}`;
}

/** The stay a row belongs to. A row with no stayId belongs to the stay its dates make. */
export function stayIdOf(group: StayGroupRequirement): string {
  return group.stayId ?? `d:${stayKeyForGroup(group)}`;
}

/** The rows grouped into stays, in the order each stay's first row appears. Same dates are one stay. */
export function groupStays(groups: StayGroupRequirement[]): Array<{ id: string; rows: StayGroupRequirement[] }> {
  const byKey = new Map<string, StayGroupRequirement[]>();
  for (const group of groups) {
    const dateKey = stayKeyForGroup(group);
    const id = group.arrivalDate && group.departureDate
      ? dateKey
      : group.arrivalDate
        ? `a:${group.arrivalDate}`
        : stayIdOf(group);
    byKey.set(id, [...(byKey.get(id) ?? []), group]);
  }
  return [...byKey].map(([id, rows]) => ({ id, rows }));
}

/** Rows a stay action names: an extracted stay id, or the date-set id the pane card uses. */
function groupsForStayAction(groups: StayGroupRequirement[], stayId: string): StayGroupRequirement[] {
  const byId = groups.filter((group) => stayIdOf(group) === stayId);
  if (byId.length) return byId;
  return groups.filter((group) => stayKeyForGroup(group) === stayId);
}

/** The room a row quotes: staff picks first, the server's projected roomTypeCode last. See rowRoomTypeCode. */
export function rowRoomCode(group: StayGroupRequirement): RoomTypeCode | null {
  return rowRoomTypeCode(group);
}

/** Rooms and guests over the rows given; children in a row are counted once per room. */
export function stayTotals(groups: StayGroupRequirement[]): { rooms: number; guests: number } {
  return groups.reduce(
    (sum, group) => ({
      rooms: sum.rooms + (group.quantity ?? 0),
      guests: sum.guests + (group.quantity ?? 0) * ((group.adults ?? 0) + group.childrenAges.length),
    }),
    { rooms: 0, guests: 0 },
  );
}

export type StayAskGuest = { name: string; confirmationNumber: string | null };
export type StayAskAction = 'quote' | 'booking' | 'amend' | 'cancel' | 'other';

type LunaStayGroup = LunaAnalysisWire['groups'][number] & { confirmationNumber?: string | null };

/** Extra fields a stored read already puts on a room row. Not on the published StayGroupRequirement type. */
type StayAskRow = StayGroupRequirement & {
  guestNames?: string[];
  confirmationNumber?: string | null;
  /** Extraction-level guests; their position here does not assign them to this room. */
  stayGuests?: StayAskGuest[];
};

function lunaStayGroups(session: Pick<QuoteSession, 'analysis'>): LunaStayGroup[] {
  return (session.analysis?.luna?.groups ?? []) as LunaStayGroup[];
}

function stayAskRows(session: QuoteSession, stayId: string): StayAskRow[] {
  return groupsForStayAction(session.groups, stayId) as StayAskRow[];
}

function trimmedConfirmation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function guestsFromNamed(
  names: string[],
  confirmation: string | null,
): StayAskGuest[] {
  const cleaned = names.map((name) => name.trim()).filter((name) => name.length > 0);
  return cleaned.map((name, index) => ({
    name,
    confirmationNumber: cleaned.length === 1 || index === 0 ? confirmation : null,
  }));
}

function lunaGroupsMatchingStay(session: QuoteSession, stayId: string): LunaStayGroup[] {
  const rows = stayAskRows(session, stayId);
  const luna = lunaStayGroups(session);
  const byId = luna.filter((group) => group.stayId === stayId);
  if (byId.length) return byId;
  const first = rows[0];
  if (!first) return [];
  const byDates = luna.filter(
    (group) => group.arrival === (first.arrivalDate ?? null) && group.departure === (first.departureDate ?? null),
  );
  if (byDates.length) return byDates;
  if (groupStays(session.groups).length === 1 && luna.length) return luna;
  return [];
}

/** The roster belongs to the source stay, even when staff remove or duplicate a room row. */
function storedStayGuests(session: QuoteSession, stayId: string): StayAskGuest[] | null {
  const ids = new Set(stayAskRows(session, stayId).map(stayIdOf));
  const source = ((session.analysis?.groups ?? []) as StayAskRow[])
    .filter((row) => ids.has(stayIdOf(row)) && Array.isArray(row.stayGuests));
  if (!source.length) return null;
  return source.flatMap((row) => (row.stayGuests ?? [])
    .filter((guest) => guest.name.trim())
    .map((guest) => ({ name: guest.name, confirmationNumber: trimmedConfirmation(guest.confirmationNumber) })));
}

/**
 * Named guests on this stay. A stored read puts names and booking numbers on analysis.groups (the session rows).
 * A live analysis puts names on luna.groups.
 */
export function stayAskGuests(session: QuoteSession, stayId: string): StayAskGuest[] {
  const stored = storedStayGuests(session, stayId);
  if (stored !== null) return stored;
  const rows = stayAskRows(session, stayId);
  const luna = lunaGroupsMatchingStay(session, stayId);
  const fromRows = rows.flatMap((row) => guestsFromNamed(row.guestNames ?? [], trimmedConfirmation(row.confirmationNumber)));
  if (fromRows.length) return fromRows;
  return luna.flatMap((group, index) =>
    guestsFromNamed(
      group.guestNames,
      trimmedConfirmation(group.confirmationNumber) ?? trimmedConfirmation(rows[index]?.confirmationNumber),
    ),
  );
}

function stayAskActionFromTask(kind: LunaAnalysisWire['tasks'][number]['kind']): StayAskAction | null {
  if (kind === 'quote') return 'quote';
  if (kind === 'create_booking') return 'booking';
  if (kind === 'amend') return 'amend';
  if (kind === 'cancel') return 'cancel';
  if (kind === 'other') return 'other';
  return null;
}

/** Stay ids a task named, taken from the analysis groups at those indexes so a later remove cannot retarget it. */
function taskStayIds(session: QuoteSession, task: LunaAnalysisWire['tasks'][number]): string[] {
  const analysisGroups = session.analysis?.groups ?? [];
  return task.groupIndexes.flatMap((index) => {
    const group = analysisGroups[index];
    return group ? [stayIdOf(group)] : [];
  });
}

/** The action this stay card should show. Tasks bind by stay id; a date-set card matches every row on those dates. */
export function stayAskAction(session: QuoteSession, stayId: string): StayAskAction {
  const tasks = session.analysis?.luna?.tasks ?? [];
  const rowIds = new Set(stayAskRows(session, stayId).map(stayIdOf));
  const ids = new Set([...rowIds, stayId]);
  const actions = new Set<StayAskAction>();
  const covered = new Set<string>();
  for (const task of tasks) {
    const matching = taskStayIds(session, task).filter((id) => ids.has(id));
    if (!matching.length) continue;
    const mapped = stayAskActionFromTask(task.kind);
    if (mapped) {
      actions.add(mapped);
      matching.forEach((id) => covered.add(id));
    }
  }
  // The pane can still group separate cases by date. Never label their combined card as just one action.
  if (actions.size > 1 || (actions.size && rowIds.size > 1 && [...rowIds].some((id) => !covered.has(id)))) return 'other';
  if (actions.size === 1) return [...actions][0]!;
  const workflow = session.analysis?.luna?.workflow;
  if (workflow === 'create_booking') return 'booking';
  if (workflow === 'quote') return 'quote';
  if (workflow === 'amend') return 'amend';
  if (workflow === 'cancel') return 'cancel';
  const amendmentKind = session.analysis?.amendment?.kind;
  if (amendmentKind === 'amend' || amendmentKind === 'cancel') return amendmentKind;
  if (session.analysis?.intent === 'quote') return 'quote';
  return 'other';
}

export function stayAskActionLabel(action: StayAskAction): string | null {
  if (action === 'quote') return 'Quote';
  if (action === 'booking') return 'New booking';
  if (action === 'amend') return 'Amendment';
  if (action === 'cancel') return 'Cancellation';
  return null;
}

/** Amend and cancel analyses keep their stays so each card can open CHECK. Other non-quote mail still has no stays. */
export function keepNonQuoteStays(analysis: QuoteAnalysis): boolean {
  const kind = analysis.amendment?.kind ?? analysis.luna?.workflow;
  return kind === 'amend' || kind === 'cancel';
}

/** A random part for the ids of rows and stays that a structural edit creates. The reducer takes it as input. */
export function newQuoteToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * One search step per date option. Every option is runnable; serial order is enforced by
 * canRunQuoteStep (one run at a time). Options already in `doneStaffQuotes` start succeeded.
 */
export function planQuoteSteps(
  groups: StayGroupRequirement[],
  doneStaffQuotes: Readonly<Record<string, StaffQuoteAllocation>> = {},
): QuoteToolStep[] {
  const byDates = new Map<string, StayGroupRequirement[]>();
  for (const group of groups) {
    const key = stayKeyForGroup(group);
    const list = byDates.get(key) ?? [];
    list.push(group);
    byDates.set(key, list);
  }
  return [...byDates].map(([key, grouped]): QuoteToolStep => ({
    id: `quote-stay-${key}`,
    kind: 'quote_stay',
    title: `Search availability ${key.replace(':', ' → ')}`,
    inputs: {
      quoteRequestKey: key,
      groupIds: grouped.map((group) => group.id),
      groups: grouped.map(toApprovedStayGroup),
    },
    dependsOn: [],
    status: doneStaffQuotes[key] ? 'succeeded' : 'ready',
    shareKey: key,
  }));
}

export function requestedQuoteKeys(groups: StayGroupRequirement[]): string[] {
  return [
    ...new Set(groups.map((group) => `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}`)),
  ];
}

/** Option label for the Nth date option in groups order: A, B, C. */
export function optionLetter(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * First date option that has a staff quote but no PDF yet. The server issues a PDF only for
 * the latest staff-approved run (workstation.qualifiedQuoteProposalPdf), so the next run waits.
 */
export function pendingPdfStayKey(
  session: Pick<QuoteSession, 'groups' | 'staffQuotes' | 'stayPdfs'>,
): string | null {
  // A combined quote has one PDF for all stays, so no single stay waits for its own.
  if (isMultiStay(session)) return null;
  return (
    requestedQuoteKeys(session.groups).find(
      (key) => Boolean(session.staffQuotes[key]) && !session.stayPdfs[key],
    ) ?? null
  );
}

/** Why a run must wait while an automatic HMS company or agency search still decides the pick, or null. */
export function partyLookupWaitReason(session: Pick<QuoteSession, 'pendingPartyKinds'>): string | null {
  const pending = session.pendingPartyKinds ?? [];
  if (!pending.length) return null;
  const names = (['company', 'agency'] as const).filter((kind) => pending.includes(kind));
  return `Finding the ${names.join(' and ')} in HMS…`;
}

/** Plain-English reason this date option must wait, or null when it may run. */
export function quoteRunBlockReason(
  session: Pick<QuoteSession, 'groups' | 'staffQuotes' | 'stayPdfs' | 'staffHeader' | 'pendingPartyKinds'>,
  step: QuoteToolStep,
): string | null {
  if (
    step.kind === 'quote_stay' &&
    step.shareKey &&
    groupsForQuoteStep(session, step).some((group) => !group.arrivalDate || !group.departureDate)
  ) {
    return 'Add the missing arrival and departure dates before searching availability.';
  }
  const lookupWait = partyLookupWaitReason(session);
  if (lookupWait) return lookupWait;
  if (step.kind === 'quote_stay' && step.shareKey) {
    const problem = staffHeaderFieldProblem(staffHeaderForStay(session.staffHeader, step.shareKey));
    if (problem) return `Fix the amounts before running this search. ${problem}`;
  }
  if (step.kind !== 'quote_stay' || !step.shareKey) return null;
  const pending = pendingPdfStayKey(session);
  if (!pending || pending === step.shareKey) return null;
  const keys = requestedQuoteKeys(session.groups);
  const pendingLetter = optionLetter(keys.indexOf(pending));
  const targetIndex = keys.indexOf(step.shareKey);
  if (targetIndex < 0) return `Finish the PDF for option ${pendingLetter} first, then run this option.`;
  return `Finish the PDF for option ${pendingLetter} first, then run option ${optionLetter(targetIndex)}.`;
}

/** Children's ages as typed: whole years 0 to 17, at most 9, the same limits the saved work item takes. */
export function parseChildrenAges(raw: string): number[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => Number(part))
    .filter((age) => Number.isInteger(age) && age >= 0 && age <= 17)
    .slice(0, 9);
}

/**
 * One HMS step's inputs in a line. A step searches one stay (one set of dates), so its groups are that stay's rooms:
 * "Dates 2026-11-02 → 2026-11-06 · Standard Queen ×15, 1 adult · Standard Twin ×15, 2 adults".
 */
export function formatQuoteStepInputs(inputs: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof inputs.organisation === 'string' && inputs.organisation.trim()) {
    bits.push(`Company ${inputs.organisation.trim()}`);
  }
  if (typeof inputs.quoteRequestKey === 'string') {
    bits.push(`Dates ${inputs.quoteRequestKey.replace(':', ' → ')}`);
  }
  if (Array.isArray(inputs.groups)) {
    for (const raw of inputs.groups) {
      if (!raw || typeof raw !== 'object') continue;
      const group = raw as Record<string, unknown>;
      const qty = typeof group.quantity === 'number' ? group.quantity : 1;
      const room =
        typeof group.roomPreference === 'string' && group.roomPreference.trim()
          ? group.roomPreference
          : '';
      const adults =
        typeof group.adults === 'number' ? `${group.adults} ${group.adults === 1 ? 'adult' : 'adults'}` : 'adults not set';
      bits.push(`${rowRoomLabel({ roomPreference: room, quantity: qty })}, ${adults}`);
    }
  }
  return bits.length ? bits.join(' · ') : 'Nothing to search yet';
}

export function canRunQuoteStep(
  step: QuoteToolStep,
  steps: readonly QuoteToolStep[],
  runningStepId: string | null,
): boolean {
  if (runningStepId) return false;
  if (step.status !== 'ready' && step.status !== 'failed') return false;
  return step.dependsOn.every((dep) => steps.find((item) => item.id === dep)?.status === 'succeeded');
}

export function pickNextRunnableStep(
  steps: readonly QuoteToolStep[],
  runningStepId: string | null,
): QuoteToolStep | undefined {
  return steps.find((step) => canRunQuoteStep(step, steps, runningStepId));
}

export function nextSelectedOfferIds(session: QuoteSession, offerId: string): string[] {
  const offer = session.offers.find((item) => item.id === offerId);
  if (!offer) return session.selectedOfferIds;
  if (session.selectedOfferIds.includes(offerId)) {
    return session.selectedOfferIds.filter((id) => id !== offerId);
  }
  if (offer.kind === 'alternative') {
    const hasAllocation = session.selectedOfferIds.some(
      (id) => session.offers.find((item) => item.id === id)?.kind === 'allocation',
    );
    if (hasAllocation) return session.selectedOfferIds;
    return [offerId];
  }
  const kept = session.selectedOfferIds.filter((id) => {
    const other = session.offers.find((item) => item.id === id);
    if (!other || other.kind !== 'allocation') return false;
    return !coversGroupOverlap(other, offer);
  });
  return [...kept, offerId];
}

export function selectionDigest(binding: QuoteSelectionBinding): string {
  return [
    binding.transportId,
    binding.mailboxEmail,
    binding.storeId,
    binding.folderEntryId,
    binding.entryId,
    binding.internetMessageId ?? '',
  ].join('|');
}

export function admissionKey(binding: QuoteSelectionBinding): string {
  return `${selectionDigest(binding)}|${binding.selectionEpoch}|${binding.scopeEpoch}`;
}

export function analysisRetryKey(
  admission: string,
  phase: QuoteSession['phase'],
  syncCommitted?: number,
  treatAs?: 'quote' | 'create_booking' | null,
  staffNote?: string | null,
): string {
  const base =
    phase === 'unsynced' && Number.isFinite(syncCommitted)
      ? `${admission}|committed:${syncCommitted}`
      : admission;
  const withTreat = treatAs ? `${base}|treatAs:${treatAs}` : base;
  return staffNote ? `${withTreat}|note:${staffNote}` : withTreat;
}

export function initialQuoteSession(): QuoteWorkflowSession {
  return {
    phase: 'idle',
    binding: null,
    analysis: null,
    groups: [],
    inputRevision: 1,
    offers: [],
    selectedOfferIds: [],
    pdf: null,
    reviewedReplyHtml: '',
    steps: [],
    missing: [],
    errorMessage: null,
    runningStepId: null,
    mailboxStatus: null,
    evidence: null,
    partyLookup: null,
    staffSource: null,
    staffQuote: null,
    staffQuotes: {},
    stayPdfs: {},
    rateOptions: [],
    roomRateBoardSelections: {},
    staffHeader: emptyStaffQuoteHeader(),
    staffActions: [],
    selectedStayKey: null,
    handledSourceKey: null,
    reviewItems: [],
    handledReviewItemIds: [],
    bookingDrafts: {},
    treatAs: null,
    staffNote: null,
    stayRevision: 1,
    analysisStartStayRevision: null,
    quoteStrategyRows: {},
    quoteStrategyResults: {},
    quoteStrategyRevisions: {},
    quoteStrategySelections: {},
  };
}

export function allocationTotal(offers: readonly QuoteOffer[]): number {
  return offers
    .filter((offer) => offer.kind === 'allocation')
    .reduce((sum, offer) => sum + offer.stayTotalMinor, 0);
}

export function evidenceMatchesSession(session: QuoteSession): boolean {
  const evidence = session.evidence;
  if (!evidence) return false;
  if (evidence.inputRevision !== session.inputRevision) return false;
  if (session.binding && evidence.selectionEpoch !== session.binding.selectionEpoch) return false;
  return true;
}

function coversGroupOverlap(left: QuoteOffer, right: QuoteOffer): boolean {
  return left.coversGroupIds.some((id) => right.coversGroupIds.includes(id));
}

function coveringAllocations(selected: readonly QuoteOffer[], groupId: string): QuoteOffer[] {
  return selected.filter((offer) => offer.coversGroupIds.includes(groupId));
}

function agesMatch(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((age, i) => age === b[i]);
}

function occupancySatisfied(group: StayGroupRequirement, covering: readonly QuoteOffer[]): boolean {
  if (covering.length === 0) return false;
  if (!group.arrivalDate || !group.departureDate) return false;
  if (group.board === 'unknown') return false;
  if (typeof group.quantity !== 'number') return false;
  const dateKey = `${group.arrivalDate}:${group.departureDate}`;
  let haveQty = 0;
  for (const offer of covering) {
    if (typeof offer.quantity !== 'number') return false;
    if (offer.quoteRequestKey !== dateKey) return false;
    if (offer.board !== group.board) return false;
    if (!agesMatch(offer.childrenAges ?? [], group.childrenAges)) return false;
    if (group.adults != null && offer.adults !== group.adults) return false;
    haveQty += offer.quantity;
  }
  return haveQty === group.quantity;
}

export function staffQuoteForStay(
  session: Pick<QuoteSession, 'staffQuote' | 'staffQuotes' | 'selectedStayKey'>,
  stayKey = session.selectedStayKey,
): StaffQuoteAllocation | null {
  if (!stayKey) return null;
  return session.staffQuotes[stayKey] ?? (session.staffQuote?.quoteRequestKey === stayKey ? session.staffQuote : null);
}

/** More than one date option. The combined quote then needs a current staff run for every stay. */
export function isMultiStay(session: Pick<QuoteSession, 'groups'>): boolean {
  return requestedQuoteKeys(session.groups).length > 1;
}

/**
 * A stay's staff run when it still matches the session: the same selection and inputs, the same source and header,
 * and the offer it was booked on. Null when the stay has no run or the run is stale.
 */
export function currentStayRun(session: QuoteSession, key: string): StaffQuoteAllocation | null {
  const quote = session.staffQuotes[key];
  const source = session.staffSource;
  const binding = session.binding;
  if (!quote || !source || !binding || !staffSourceReady(session)) return null;
  const offer = session.offers.find((item) => item.id === quote.revisionRef);
  if (!offer || offer.kind !== 'allocation' || offer.nightly.length) return null;
  let header: ReturnType<typeof approvedExecuteHeader>;
  try {
    header = approvedExecuteHeader(staffHeaderForStay(session.staffHeader, key));
  } catch {
    return null;
  }
  const current =
    quote.totalMinor > 0 &&
    quote.quoteRequestKey === key &&
    quote.selectionEpoch === binding.selectionEpoch &&
    quote.inputRevision === session.inputRevision &&
    quote.sourceHash === source.sourceHash &&
    quote.messageId === source.messageId &&
    quote.threadId === source.threadId &&
    quote.approvedHeader.salesStrategy === header.salesStrategy &&
    quote.approvedHeader.company === header.company &&
    quote.approvedHeader.agency === header.agency &&
    offer.stayTotalMinor === quote.totalMinor;
  if (!current) return null;
  // Each stay owns its one-time extras; a stale run must not add or lose that stay's charge.
  if (Boolean(quote.onceExtras) !== runCarriesSingleChargeExtras(session, key)) return null;
  return quote;
}

/** Whether this stay's run carries a single-charge extra (shuttle, per-trip or one-item "other"). */
export function runCarriesSingleChargeExtras(
  session: Pick<QuoteSession, 'groups' | 'staffHeader'>,
  stayKey: string,
): boolean {
  return hasPerStaySingleChargeExtras(staffHeaderForStay(session.staffHeader, stayKey));
}

/** Every date option's current staff run in option order, or null while any stay is unrated or its run is stale. */
export function combinedStayRuns(session: QuoteSession): StaffQuoteAllocation[] | null {
  const keys = requestedQuoteKeys(session.groups);
  const runs = keys.map((key) => currentStayRun(session, key));
  return keys.length > 0 && runs.every((run): run is StaffQuoteAllocation => run !== null) ? runs : null;
}

/** How many date options have a current staff run. Drives the "1 of 2 stays rated" message. */
export function ratedStayCount(session: QuoteSession): { rated: number; total: number } {
  const keys = requestedQuoteKeys(session.groups);
  return { rated: keys.filter((key) => currentStayRun(session, key) !== null).length, total: keys.length };
}

export function staffSourceReady(session: Pick<QuoteSession, 'staffSource'>): boolean {
  const source = session.staffSource;
  return Boolean(
    source &&
      /^[a-f0-9]{64}$/.test(source.sourceHash) &&
      source.messageId.trim() &&
      source.threadId.trim(),
  );
}

export function reviewSourceKey(session: QuoteSession): string {
  return session.staffSource?.sourceHash ?? '';
}

export function staffQuoteMatchesSession(session: QuoteSession): boolean {
  const quote = staffQuoteForStay(session);
  const source = session.staffSource;
  if (!quote || !source || !session.binding) return false;
  if (quote.totalMinor <= 0) return false;
  if (quote.selectionEpoch !== session.binding.selectionEpoch) return false;
  if (quote.inputRevision !== session.inputRevision) return false;
  if (quote.sourceHash !== source.sourceHash) return false;
  if (quote.messageId !== source.messageId) return false;
  if (!session.selectedStayKey || quote.quoteRequestKey !== session.selectedStayKey) return false;
  if (session.selectedOfferIds.length !== 1 || session.selectedOfferIds[0] !== quote.revisionRef) return false;
  const offer = session.offers.find((item) => item.id === quote.revisionRef);
  if (!offer || offer.kind !== 'allocation' || offer.stayTotalMinor !== quote.totalMinor) return false;
  if (offer.nightly.length) return false;
  const selectedKeys = new Set(
    session.selectedOfferIds
      .map((id) => session.offers.find((item) => item.id === id)?.quoteRequestKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (selectedKeys.size !== 1) return false;
  const current = approvedExecuteHeader(session.staffHeader);
  const approved = quote.approvedHeader;
  if (!approved) return false;
  if (current.company !== approved.company || current.agency !== approved.agency) return false;
  if (current.salesStrategy !== approved.salesStrategy) return false;
  return true;
}

/**
 * Why the PDF cannot be made yet: the first check that fails, in the order canCreatePdf runs them. Null when the PDF
 * can be made. canCreatePdf is this returning null, so the reason staff see always names the check that failed.
 */
export type PdfBlocker =
  /** A typed amount in the quote header cannot be read. */
  | { kind: 'amounts'; problem: string }
  /** A required dinner add-on has no verified amount or charging unit yet. */
  | { kind: 'dinner_add_on'; problem: string }
  /** The quote request is missing a complete arrival/departure range. */
  | { kind: 'missing_stay_details' }
  /** The email is not yet linked to its synced mailbox copy (hash, message and thread). */
  | { kind: 'source_not_ready'; unsynced: boolean }
  /** No rates were found for this email. */
  | { kind: 'no_rates' }
  /** The rates are sample data, not a live HMS run. */
  | { kind: 'sample_rates' }
  /** The rates were found for other details: the stays, header or email changed since. */
  | { kind: 'rates_stale' }
  /** A combined quote with a stay that has no current run. */
  | { kind: 'stays_unrated'; rated: number; total: number }
  /** A one-stay quote with room options picked from more than one date search. */
  | { kind: 'mixed_stays' }
  /** The rates are current, but the picked option is not the one they were found for. */
  | { kind: 'rated_option_not_picked' }
  /** No stay rows match the selected stay. */
  | { kind: 'no_stay' }
  /** No room option is picked. */
  | { kind: 'nothing_picked' }
  /** A picked option is no longer in the results, or is not a priced room. */
  | { kind: 'pick_gone' }
  /** The picked rooms do not match the rooms, guests, dates or meal plan asked for. */
  | { kind: 'occupancy' };

export function pdfBlocker(session: QuoteSession): PdfBlocker | null {
  if (session.groups.some((group) => !group.arrivalDate || !group.departureDate)) {
    return { kind: 'missing_stay_details' };
  }
  const dinnerProblem = dinnerAddOnInputProblem(session);
  if (dinnerProblem) return { kind: 'dinner_add_on', problem: dinnerProblem };
  // An unreadable amount means the saved one is not what staff see: no PDF, Excel or reply until it is fixed.
  const problem = staffHeaderFieldProblem(session.staffHeader, undefined, new Set(session.groups.map(stayKeyForGroup)));
  if (problem) return { kind: 'amounts', problem };
  if (!staffSourceReady(session)) return { kind: 'source_not_ready', unsynced: session.mailboxStatus === 'unsynced' };
  if (!evidenceMatchesSession(session) || session.evidence?.kind !== 'authorised') {
    if (session.evidence?.kind === 'fixture') return { kind: 'sample_rates' };
    const anyResults =
      session.offers.length > 0 || Boolean(session.staffQuote) || Object.keys(session.staffQuotes).length > 0;
    return session.evidence || anyResults ? { kind: 'rates_stale' } : { kind: 'no_rates' };
  }
  // A combined quote is one document for every stay: each stay needs its current run, not one selection.
  if (isMultiStay(session)) {
    if (combinedStayRuns(session) !== null) return null;
    return { kind: 'stays_unrated', ...ratedStayCount(session) };
  }
  const selectedKeys = new Set(
    session.selectedOfferIds
      .map((id) => session.offers.find((item) => item.id === id)?.quoteRequestKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (selectedKeys.size > 1) return { kind: 'mixed_stays' };
  const quote = staffQuoteForStay(session);
  if (quote) {
    if (!staffQuoteMatchesSession(session)) {
      return ratedOptionOnlyMismatch(session, quote) ? { kind: 'rated_option_not_picked' } : { kind: 'rates_stale' };
    }
    const scoped = session.groups.filter((group) => stayKeyForGroup(group) === session.selectedStayKey);
    return scoped.length > 0 ? null : { kind: 'no_stay' };
  }
  const selected = session.selectedOfferIds
    .map((id) => session.offers.find((offer) => offer.id === id))
    .filter((offer): offer is QuoteOffer => Boolean(offer && offer.kind === 'allocation' && offer.sourceRef));
  if (session.selectedOfferIds.length === 0) return { kind: 'nothing_picked' };
  if (selected.length !== session.selectedOfferIds.length) return { kind: 'pick_gone' };
  const scoped = session.selectedStayKey
    ? session.groups.filter((group) => stayKeyForGroup(group) === session.selectedStayKey)
    : session.groups;
  if (scoped.length === 0) return { kind: 'no_stay' };
  return scoped.every((group) => occupancySatisfied(group, coveringAllocations(selected, group.id)))
    ? null
    : { kind: 'occupancy' };
}

/** True when the stay's run would still match if its own option were the pick: only the selection is off. */
function ratedOptionOnlyMismatch(session: QuoteSession, quote: StaffQuoteAllocation): boolean {
  if (session.selectedOfferIds.length === 1 && session.selectedOfferIds[0] === quote.revisionRef) return false;
  try {
    return staffQuoteMatchesSession({ ...session, selectedOfferIds: [quote.revisionRef] });
  } catch {
    // An unreadable header is not a selection problem. Report the rates as out of date, never throw.
    return false;
  }
}

export function canCreatePdf(session: QuoteSession): boolean {
  return pdfBlocker(session) === null;
}

/** A missing-stay-details response asks for context only; it must not turn a partial read into an HMS quote. */
export function missingQuoteDetailsReplyOnly(
  session: Pick<QuoteSession, 'analysis' | 'groups'>,
): boolean {
  return Boolean(
    session.analysis?.intent === 'quote' &&
      session.analysis.missingQuoteReplyFields?.length &&
      !session.groups.some((group) => group.arrivalDate && group.departureDate),
  );
}

/** A refused quote may be drafted without a PDF; alternatives remain available only in the staff pane. */
export function quoteDeclineReplyOnly(
  session: Pick<QuoteSession, 'reviewedReplyHtml' | 'reviewedReplySource'>,
): boolean {
  return session.reviewedReplySource === 'quote_decline' && session.reviewedReplyHtml.trim().length > 0;
}

/** The request-only reply follows current staff-edited rows, not the analysis snapshot. */
export function missingQuoteReplyFieldsForGroups(groups: readonly StayGroupRequirement[]): string[] {
  const fields: string[] = [];
  const targets: readonly Partial<StayGroupRequirement>[] = groups.length
    ? groups
    : [{ id: 'g1', childrenAges: [], board: 'unknown' as const, specialRequests: [], fields: {} }];
  targets.forEach((group, index) => {
    const stay = index + 1;
    if (!group.arrivalDate) fields.push(`Arrival date for stay ${stay}`);
    if (!group.departureDate) fields.push(`Departure date for stay ${stay}`);
    if (group.quantity == null && group.adults == null) {
      fields.push(`Number of rooms and occupancy per room for stay ${stay}`);
    } else if (group.quantity == null) {
      fields.push(`Number of rooms for stay ${stay}`);
    } else if (group.adults == null) {
      fields.push(`Number of guests per room for stay ${stay}`);
    }
  });
  return fields;
}

/** The regex fallback supplies deterministic stays, not the Luna request-field list. */
function withFallbackMissingQuoteReplyFields(analysis: QuoteAnalysis): QuoteAnalysis {
  if (analysis.source !== 'regex_fallback' || analysis.intent !== 'quote') return analysis;
  const hasIncompleteDates = analysis.groups.some(
    (group) => !group.arrivalDate || !group.departureDate,
  );
  return {
    ...analysis,
    missingQuoteReplyFields: hasIncompleteDates
      ? missingQuoteReplyFieldsForGroups(analysis.groups)
      : [],
  };
}

export function canCreateNativeDraft(session: QuoteSession): boolean {
  // A combined quote's reply is the multi-stay draft, which checks its own PDF. The single-stay reply never applies.
  if (isMultiStay(session)) return Boolean(session.pdf) && canCreatePdf(session);
  if (!session.pdf || !session.reviewedReplyHtml.trim() || !canCreatePdf(session)) return false;
  const quote = staffQuoteForStay(session);
  if (!quote) return true;
  return (
    session.pdf.revisionId === quote.revisionRef &&
    session.pdf.totalMinor === quote.totalMinor &&
    typeof session.pdf.pdfHash === 'string' &&
    /^[a-f0-9]{64}$/.test(session.pdf.pdfHash)
  );
}

function quoteStrategyState(session: QuoteSession): QuoteStrategySessionState {
  const state = session as Partial<QuoteWorkflowSession>;
  return { quoteStrategyRows: state.quoteStrategyRows ?? {}, quoteStrategyResults: state.quoteStrategyResults ?? {},
    quoteStrategyRevisions: state.quoteStrategyRevisions ?? {}, quoteStrategySelections: state.quoteStrategySelections ?? {} };
}

export function quoteStrategyStayRevision(session: QuoteSession, stayKey: string): number {
  return quoteStrategyState(session).quoteStrategyRevisions[stayKey] ?? 1;
}

function invalidatedQuoteStrategyState(session: QuoteSession): QuoteStrategySessionState {
  const state = quoteStrategyState(session);
  const revisions = { ...state.quoteStrategyRevisions };
  const keys = new Set([
    ...Object.keys(state.quoteStrategyRows),
    ...Object.keys(state.quoteStrategyResults),
    ...Object.keys(state.quoteStrategyRevisions),
    ...Object.keys(state.quoteStrategySelections),
  ]);
  for (const key of keys) revisions[key] = quoteStrategyStayRevision(session, key) + 1;
  return {
    quoteStrategyRows: {},
    quoteStrategyResults: {},
    quoteStrategyRevisions: revisions,
    quoteStrategySelections: {},
  };
}

function quoteStrategyStateAfterStayEdit(
  session: QuoteSession,
  affected: ReadonlySet<string>,
): QuoteStrategySessionState {
  const state = quoteStrategyState(session);
  const quoteStrategyRows = { ...state.quoteStrategyRows };
  const quoteStrategyResults = { ...state.quoteStrategyResults };
  const quoteStrategyRevisions = { ...state.quoteStrategyRevisions };
  const quoteStrategySelections = { ...state.quoteStrategySelections };
  for (const key of affected) {
    delete quoteStrategyRows[key];
    delete quoteStrategyResults[key];
    delete quoteStrategySelections[key];
    quoteStrategyRevisions[key] = quoteStrategyStayRevision(session, key) + 1;
  }
  return { quoteStrategyRows, quoteStrategyResults, quoteStrategyRevisions, quoteStrategySelections };
}

function quoteStrategyStayExists(session: QuoteSession, stayKey: string): boolean {
  return session.groups.some((group) => stayKeyForGroup(group) === stayKey);
}

function quoteStrategyOutcomeIsCurrent(
  session: QuoteSession,
  stayKey: string,
  selectionEpoch: number,
  outcome: { row: QuoteStrategyRow; result?: QuoteStrategyResult },
): outcome is { row: Extract<QuoteStrategyRow, { status: 'ready' }>; result: QuoteStrategyResult } {
  if (outcome.row.status !== 'ready' || !outcome.result) return false;
  const source = session.staffSource;
  const { offer, staffQuote } = outcome.result;
  const expectedGroupIds = session.groups
    .filter((group) => stayKeyForGroup(group) === stayKey)
    .map((group) => group.id);
  if (!source || !expectedGroupIds.length) return false;
  return (
    expectedGroupIds.every((id) => offer.coversGroupIds.includes(id)) &&
    offer.kind === 'allocation' && offer.quoteRequestKey === stayKey &&
    offer.id === staffQuote.revisionRef && offer.stayTotalMinor === staffQuote.totalMinor &&
    staffQuote.totalMinor > 0 && staffQuote.selectionEpoch === selectionEpoch &&
    staffQuote.sourceHash === source.sourceHash && staffQuote.messageId === source.messageId &&
    staffQuote.threadId === source.threadId
  );
}

function reduceQuoteStrategySession(
  session: QuoteSession,
  action: QuoteStrategySessionAction,
): QuoteWorkflowSession {
  const state = session as QuoteWorkflowSession;
  if (action.type === 'quote_strategy_comparison_started') {
    if (
      !state.binding ||
      state.binding.selectionEpoch !== action.selectionEpoch ||
      !quoteStrategyStayExists(state, action.stayKey) ||
      quoteStrategyStayRevision(state, action.stayKey) !== action.stayRevision
    ) return state;
    const rows = { ...state.quoteStrategyRows[action.stayKey] };
    const results = { ...state.quoteStrategyResults[action.stayKey] };
    for (const code of action.strategyCodes) {
      rows[code] = { status: 'pending' };
      delete results[code];
    }
    return {
      ...state,
      quoteStrategyRows: { ...state.quoteStrategyRows, [action.stayKey]: rows },
      quoteStrategyResults: { ...state.quoteStrategyResults, [action.stayKey]: results },
      quoteStrategyRevisions: { ...state.quoteStrategyRevisions, [action.stayKey]: action.stayRevision },
    };
  }

  if (action.type === 'quote_strategy_comparison_result') {
    if (
      !state.binding ||
      state.binding.selectionEpoch !== action.selectionEpoch ||
      action.outcome.strategyCode !== action.strategyCode ||
      !quoteStrategyStayExists(state, action.stayKey) ||
      quoteStrategyStayRevision(state, action.stayKey) !== action.stayRevision ||
      state.quoteStrategyRows[action.stayKey]?.[action.strategyCode]?.status !== 'pending'
    ) return state;

    const { row } = action.outcome;
    const results = { ...state.quoteStrategyResults[action.stayKey] };
    if (row.status === 'ready') {
      if (!quoteStrategyOutcomeIsCurrent(state, action.stayKey, action.selectionEpoch, action.outcome)) return state;
      const result = action.outcome.result!;
      results[action.strategyCode] = {
        ...result,
        offer: { ...result.offer, quoteRequestKey: action.stayKey },
        staffQuote: {
          ...result.staffQuote,
          quoteRequestKey: action.stayKey,
          // A change to another stay may move the global input revision. This result was admitted by the unchanged
          // per-stay revision above, so rebase it for the active session without making other rows stale.
          inputRevision: state.inputRevision,
        },
      };
    } else {
      if ((row.status !== 'not_offered' && row.status !== 'failed') || !row.message.trim()) return state;
      delete results[action.strategyCode];
    }
    return {
      ...state,
      quoteStrategyRows: {
        ...state.quoteStrategyRows,
        [action.stayKey]: { ...state.quoteStrategyRows[action.stayKey], [action.strategyCode]: row },
      },
      quoteStrategyResults: { ...state.quoteStrategyResults, [action.stayKey]: results },
    };
  }

  const row = state.quoteStrategyRows[action.stayKey]?.[action.strategyCode];
  const result = state.quoteStrategyResults[action.stayKey]?.[action.strategyCode];
  if (!state.binding || row?.status !== 'ready' || !result) return state;
  const staffQuote = { ...result.staffQuote, quoteRequestKey: action.stayKey, inputRevision: state.inputRevision };
  const offer = { ...result.offer, quoteRequestKey: action.stayKey };
  const quoteChanged = state.quoteStrategySelections[action.stayKey] !== action.strategyCode ||
    state.staffQuote?.revisionRef !== staffQuote.revisionRef;
  const runGroupIds = new Set(offer.coversGroupIds);
  const stayPdfs = { ...state.stayPdfs };
  if (result.pdf) stayPdfs[action.stayKey] = result.pdf;
  else delete stayPdfs[action.stayKey];
  return {
    ...state,
    phase: state.phase === 'requirements' ? 'results' : state.phase,
    selectedStayKey: action.stayKey,
    selectedOfferIds: [offer.id],
    rateOptions: [...(state.rateOptions ?? []).filter((option) => !runGroupIds.has(option.groupId)), ...(staffQuote.rateOptions ?? [])],
    offers: [
      ...state.offers.filter((item) => item.kind !== 'allocation' || item.quoteRequestKey !== action.stayKey),
      offer,
    ],
    staffQuote,
    staffQuotes: { ...state.staffQuotes, [action.stayKey]: staffQuote },
    stayPdfs,
    pdf: isMultiStay(state) ? null : result.pdf ?? null,
    evidence: {
      kind: 'authorised',
      selectionEpoch: state.binding.selectionEpoch,
      inputRevision: state.inputRevision,
    },
    bookingDrafts: keepKeys(state.bookingDrafts, new Set([action.stayKey]), false),
    quoteStrategySelections: { ...state.quoteStrategySelections, [action.stayKey]: action.strategyCode },
    reviewItems: reviewItemsFromExtrasNotes(state, result.extrasReviewItems ?? []),
    ...(quoteChanged ? { reviewedReplyHtml: '', reviewedReplySource: undefined, reviewedReplyEdited: false } : {}),
  };
}

function clearDownstream(session: QuoteSession, preserveQuoteStrategies = false): QuoteSession {
  const strategyState = preserveQuoteStrategies
    ? quoteStrategyState(session)
    : invalidatedQuoteStrategyState(session);
  return {
    ...session,
    ...strategyState,
    ...(session.reviewedReplySource === 'quote_decline'
      ? { reviewedReplyHtml: '', reviewedReplySource: undefined }
      : {}),
    offers: [],
    selectedOfferIds: [],
    pdf: null,
    runningStepId: null,
    evidence: null,
    errorMessage: null,
    partyLookup: null,
    staffQuote: null,
    staffQuotes: {},
    stayPdfs: {},
    rateOptions: [],
    bookingDrafts: {},
    // Results are gone, so every date option is runnable again.
    steps: session.steps.map((step) =>
      step.kind === 'quote_stay'
        ? { ...step, status: 'ready' as const, retryGuidance: undefined, errorDetail: undefined }
        : step,
    ),
  };
}

function requestMatchesCurrent(
  session: QuoteSession,
  selectionEpoch: number,
  inputRevision: number,
): boolean {
  if (!session.binding) return false;
  return (
    session.binding.selectionEpoch === selectionEpoch && session.inputRevision === inputRevision
  );
}

function sameSelectedOfferIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, i) => id === b[i]);
}

function provenanceMatches(
  session: QuoteSession,
  provenance: QuoteEvidenceProvenance,
  selectionEpoch?: number,
  inputRevision?: number,
): boolean {
  if (provenance.inputRevision !== session.inputRevision) return false;
  if (inputRevision !== undefined && inputRevision !== session.inputRevision) return false;
  if (session.binding && provenance.selectionEpoch !== session.binding.selectionEpoch) return false;
  if (
    selectionEpoch !== undefined &&
    session.binding &&
    selectionEpoch !== session.binding.selectionEpoch
  ) {
    return false;
  }
  return true;
}

export function hasStaffStayEdits(session: QuoteSession): boolean {
  // Stay edits move stayRevision and give rows a stayId. Structure staff built must survive a re-read too.
  if (session.inputRevision > 1 || session.stayRevision > 1) return true;
  return session.groups.some(
    (group) =>
      group.stayId !== undefined ||
      Object.values(group.fields).some((provenance) => provenance === 'staff_corrected'),
  );
}

function shuttleRequestedFromAnalysis(analysis: QuoteAnalysis): boolean {
  const texts = [
    ...(analysis.luna?.evidence ?? []).map((row) => row.quote),
    ...(analysis.luna?.missing ?? []).map((row) => row.question),
    ...(analysis.groups ?? []).flatMap((group) => group.specialRequests ?? []),
  ];
  // A bare "transfer" is a payment or bank transfer, not a shuttle. "airport transfer" still matches via "airport".
  return texts.some((text) => /shuttle|airport/i.test(text));
}

/** Government for a government party or when every row asks Dinner B&B; otherwise BAR. */
function automaticSalesStrategy(
  groups: readonly { board: string }[],
  partyKind: string | null | undefined,
): StaffQuoteHeader['salesStrategy'] {
  const allDinner = groups.length > 0 && groups.every((group) => group.board === 'dinner_bb');
  return partyKind === 'government' || allDinner ? 'Government' : 'BAR';
}

function prefillStaffHeaderFromLuna(
  header: StaffQuoteHeader,
  analysis: QuoteAnalysis,
  staffSalesStrategyEdited: boolean,
): StaffQuoteHeader {
  let next = header;
  const party = analysis.luna?.party;
  const name = party?.name?.trim();
  if (party && name && !header.company.trim() && !header.agency.trim()) {
    if (party.kind === 'agency') next = { ...next, agency: name };
    else if (party.kind === 'organization') next = { ...next, company: name };
    else if (party.kind === 'government') {
      next = {
        ...next,
        company: name,
        ...(!staffSalesStrategyEdited ? { salesStrategy: 'Government' } : {}),
      };
    }
  }
  // Until staff pick a strategy, each read decides it again, so a corrected read without dinner returns to BAR.
  if (!staffSalesStrategyEdited) {
    next = { ...next, salesStrategy: automaticSalesStrategy(analysis.groups, party?.kind) };
  }
  if (!next.shuttleRequested && shuttleRequestedFromAnalysis(analysis)) {
    next = { ...next, shuttleRequested: true };
  }
  return next;
}

function reviewItemsFromExtrasNotes(
  session: QuoteSession,
  notes: readonly string[],
): QuoteSession['reviewItems'] {
  const kept = session.reviewItems.filter((item) => item.sourceLabel !== 'Quote extras');
  if (!notes.length) return kept;
  const existing = new Set(kept.map((item) => item.text));
  const added = notes
    .filter((text) => text.trim() && !existing.has(text))
    .map((text, index) => ({
      id: `staff-extras-review-${index}-${text.length}`,
      kind: 'question' as const,
      rank: 'secondary' as const,
      text,
      sourceLabel: 'Quote extras',
      blocking: false,
    }));
  return added.length ? [...kept, ...added] : kept;
}

/** Fields that decide which rate HMS quotes. A rate pin does not survive a change to any of them. */
const RATE_PIN_FIELDS = ['board', 'arrivalDate', 'departureDate', 'roomPreference', 'roomCodes'] as const;

/** The blank stay the form shows while Nava reads the email or after a failed read, so she can type before it lands. */
export const DRAFT_GROUP_ID = 'draft-stay';

export function draftStayGroup(): StayGroupRequirement {
  return { id: DRAFT_GROUP_ID, childrenAges: [], board: 'unknown', specialRequests: [], fields: {} };
}

function applyGroupPatch(
  group: StayGroupRequirement,
  patch: Partial<StayGroupRequirement>,
): StayGroupRequirement {
  const fields = { ...group.fields };
  for (const key of Object.keys(patch) as (keyof StayGroupRequirement)[]) {
    if (key === 'id' || key === 'fields') continue;
    fields[String(key)] = 'staff_corrected';
  }
  const next: StayGroupRequirement = { ...group, ...patch, id: group.id, fields };
  // A rate pick sends its rateCode with the board and room. Editing one of those fields by hand unpins the rate.
  if (!('rateCode' in patch) && RATE_PIN_FIELDS.some((key) => key in patch)) delete next.rateCode;
  return next;
}

/** Keeps the entries whose key is in `keys` (keep true) or is not (keep false). */
function keepKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>, keep: boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keys.has(key) === keep));
}

/** The date options (quote requests) that the rows fall in. */
function dateKeysOf(groups: StayGroupRequirement[]): Set<string> {
  return new Set(groups.map(stayKeyForGroup));
}

/** Gives a stay that has no stayId the id it already answers to, so the stay keeps that id when its dates change. */
function pinStay(groups: StayGroupRequirement[], stayId: string): StayGroupRequirement[] {
  return groups.map((group) => (group.stayId === undefined && stayIdOf(group) === stayId ? { ...group, stayId } : group));
}

/** Puts rows right after the last row of their stay. */
function insertAfterStay(
  groups: StayGroupRequirement[],
  stayId: string,
  rows: StayGroupRequirement[],
): StayGroupRequirement[] {
  const last = groups.reduce((found, group, index) => (stayIdOf(group) === stayId ? index : found), -1);
  return [...groups.slice(0, last + 1), ...rows, ...groups.slice(last + 1)];
}

/** A stay total is a row default only while one uncorrected room row remains. */
function syncTotalRoomsForStay(
  session: QuoteSession,
  groups: StayGroupRequirement[],
  stayId: string,
): StayGroupRequirement[] {
  const totalRooms = session.analysis?.requestedRoomsByStay?.[stayId];
  if (totalRooms === undefined) return groups;

  const rows = groups.filter((group) => stayIdOf(group) === stayId);
  if (rows.length === 1) {
    const row = rows[0]!;
    if (
      row.quantity != null ||
      row.fields.quantity === 'staff_corrected' ||
      row.fields.quantity === 'extracted'
    ) {
      return groups;
    }
    return groups.map((group) =>
      group.id === row.id
        ? { ...group, quantity: totalRooms, fields: { ...group.fields, quantity: 'defaulted' } }
        : group,
    );
  }

  const defaultedRows = new Set(
    rows
      .filter((row) => row.fields.quantity === 'defaulted' && row.quantity === totalRooms)
      .map((row) => row.id),
  );
  if (!defaultedRows.size) return groups;
  return groups.map((group) =>
    defaultedRows.has(group.id)
      ? { ...group, quantity: undefined, fields: { ...group.fields, quantity: 'missing' } }
      : group,
  );
}

/** A new row with no room type, rooms or adults yet. The steppers show a dash until staff enter them. */
function blankRow(
  id: string,
  stayId: string,
  dates: Pick<StayGroupRequirement, 'arrivalDate' | 'departureDate' | 'board'>,
): StayGroupRequirement {
  return { id, stayId, ...dates, childrenAges: [], specialRequests: [], fields: {} };
}

/**
 * A duplicate row: the same values under a new id and stay, with no rate pin or row price. Staff own every value in the
 * copy, and an approved override belongs to the row it was approved for.
 */
function copyRow(source: StayGroupRequirement, id: string, stayId: string): StayGroupRequirement {
  const copy: StayGroupRequirement = {
    ...source,
    id,
    stayId,
    roomCodes: source.roomCodes?.slice(),
    childrenAges: [...source.childrenAges],
    specialRequests: [...source.specialRequests],
    fields: Object.fromEntries(Object.keys(source.fields).map((key) => [key, 'staff_corrected' as const])),
  };
  delete copy.rateCode;
  delete copy.rowPrice;
  // A copied row or stay is a new target; source names and booking numbers do not follow it.
  const details = copy as StayAskRow;
  delete details.guestNames;
  delete details.confirmationNumber;
  delete details.stayGuests;
  return copy;
}

/** A copied room stays on its stay's dinner allowance after a B&B fallback. */
function withDinnerCopies(session: QuoteSession, copies: ReadonlyArray<readonly [string, string]>): QuoteSession {
  const header = session.staffHeader;
  const stayExtrasByKey = { ...header.stayExtrasByKey };
  const globalIds = header.dinnerAllowanceGroupIds;
  const addedGlobal = globalIds?.length
    ? copies.filter(([source]) => globalIds.includes(source)).map(([, copy]) => copy)
    : [];
  for (const [key, extras] of Object.entries(header.stayExtrasByKey ?? {})) {
    const ids = extras.dinnerAllowanceGroupIds;
    if (!ids?.length) continue;
    const added = copies.filter(([source]) => ids.includes(source)).map(([, copy]) => copy);
    if (added.length) stayExtrasByKey[key] = { ...extras, dinnerAllowanceGroupIds: [...ids, ...added] };
  }
  const hadLocalChanges = Object.entries(stayExtrasByKey).some(
    ([key, extras]) => extras !== header.stayExtrasByKey?.[key],
  );
  if (!addedGlobal.length && !hadLocalChanges) return session;
  return {
    ...session,
    staffHeader: {
      ...header,
      ...(addedGlobal.length && globalIds ? { dinnerAllowanceGroupIds: [...globalIds, ...addedGlobal] } : {}),
      stayExtrasByKey,
    },
  };
}

/** Steps for the groups. An option the edit did not touch keeps its step, so a running or failed option stays as it was. */
function rePlanSteps(
  session: QuoteSession,
  groups: StayGroupRequirement[],
  staffQuotes: Record<string, StaffQuoteAllocation>,
  affected: ReadonlySet<string>,
): QuoteToolStep[] {
  return planQuoteSteps(groups, staffQuotes).map((planned) => {
    const previous = session.steps.find((step) => step.id === planned.id);
    const touched = planned.shareKey === undefined || affected.has(planned.shareKey);
    return previous && !touched ? previous : planned;
  });
}

/**
 * A stay edit. The rates of the date options it touches (`affected`) go. Every other option keeps its rates and any
 * run in flight. The input revision moves only when the running option is one of the touched ones: its result would
 * otherwise land on rows that changed under it. `keepRatesOf` keeps one row's rate cards while its pinned re-run waits.
 */
/**
 * Puts a re-run stay's rows in place of that stay's old rows. The other stays keep their rows and order. With one stay
 * the new rows are the whole session, as before.
 */
function replaceStayRows(current: StayGroupRequirement[], next: StayGroupRequirement[]): StayGroupRequirement[] {
  if (requestedQuoteKeys(current).length <= 1) return next;
  const keys = new Set(next.map(stayKeyForGroup));
  const at = current.findIndex((group) => keys.has(stayKeyForGroup(group)));
  if (at < 0) return [...current, ...next];
  // A re-run keeps the stay's identity, so its new rows keep the stayId the old rows had.
  const stayId = current[at]?.stayId;
  const rows = stayId ? next.map((group) => ({ ...group, stayId })) : next;
  const rest = current.filter((group) => !keys.has(stayKeyForGroup(group)));
  return [...rest.slice(0, at), ...rows, ...rest.slice(at)];
}

/**
 * Per-stay extras are saved under the stay's dates. When a date edit leaves no row on the old dates, the saved extras
 * move to the new dates, unless a stay there already has its own.
 */
function carryStayExtras(
  header: StaffQuoteHeader,
  groups: StayGroupRequirement[],
  from: string,
  to: string,
): StaffQuoteHeader {
  const saved = header.stayExtrasByKey;
  if (from === to || !saved?.[from] || saved[to]) return header;
  if (groups.some((group) => stayKeyForGroup(group) === from)) return header;
  const { [from]: extras, ...rest } = saved;
  return { ...header, stayExtrasByKey: { ...rest, [to]: extras } };
}

function editStays(
  session: QuoteSession,
  groups: StayGroupRequirement[],
  touched: ReadonlySet<string>,
  keepRatesOf?: string,
): QuoteSession {
  const running = session.steps.find((step) => step.id === session.runningStepId);
  const keys = requestedQuoteKeys(groups);
  // If a stay's one-time extras changed, a preserved run with a different extras selection is stale too.
  const misplaced = Object.entries(session.staffQuotes)
    .filter(
      ([key, run]) =>
        keys.includes(key) &&
        Boolean(run.onceExtras) !== runCarriesSingleChargeExtras({ groups, staffHeader: session.staffHeader }, key),
    )
    .map(([key]) => key);
  const affected: ReadonlySet<string> = misplaced.length ? new Set([...touched, ...misplaced]) : touched;
  const strategyState = quoteStrategyStateAfterStayEdit(session, affected);
  const selectedStayKey =
    session.selectedStayKey && keys.includes(session.selectedStayKey)
      ? session.selectedStayKey
      : keys.length === 1
        ? keys[0]!
        : session.selectedStayKey;
  const reviewItems = projectQuoteReviewItems(
    session.analysis,
    groups,
    session.reviewItems.filter((item) => item.kind === 'document_failure' || item.kind === 'analysis_failure'),
    session.staffActions,
  );
  const completedRequestReply =
    session.reviewedReplySource === 'missing_quote_details' &&
    !missingQuoteDetailsReplyOnly({ ...session, groups });
  const replacedDeclineReply = session.reviewedReplySource === 'quote_decline';
  const edited = {
    ...session,
    groups,
    stayRevision: session.stayRevision + 1,
    selectedStayKey,
    reviewItems,
    ...(completedRequestReply || replacedDeclineReply
      ? { reviewedReplyHtml: '', reviewedReplySource: undefined }
      : {}),
  };
  if (running?.shareKey && affected.has(running.shareKey)) {
    const cleared = clearDownstream({
      ...edited,
      inputRevision: session.inputRevision + 1,
      phase: 'requirements',
      steps: planQuoteSteps(groups),
    }, true);
    return {
      ...cleared,
      ...strategyState,
      rateOptions: (session.rateOptions ?? []).filter((option) => option.groupId === keepRatesOf),
    };
  }
  const staffQuotes = keepKeys(session.staffQuotes, affected, false);
  const offers = session.offers.filter((offer) => !affected.has(offer.quoteRequestKey));
  const affectedGroupIds = new Set(
    [...session.groups, ...groups].filter((group) => affected.has(stayKeyForGroup(group))).map((group) => group.id),
  );
  const selectedAffected = Boolean(session.selectedStayKey && affected.has(session.selectedStayKey));
  const hasResults = Object.keys(staffQuotes).length > 0 || offers.length > 0;
  // Review's PDF and booking draft rest on the results, so with none left review falls back too.
  const resultsPhase = session.phase === 'results' || session.phase === 'tools' || session.phase === 'review';
  return {
    ...edited,
    ...strategyState,
    phase: !hasResults && resultsPhase ? 'requirements' : session.phase,
    steps: rePlanSteps(session, groups, staffQuotes, affected),
    staffQuotes,
    stayPdfs: keepKeys(session.stayPdfs, affected, false),
    offers,
    selectedOfferIds: session.selectedOfferIds.filter((id) => offers.some((offer) => offer.id === id)),
    staffQuote: selectedAffected ? null : session.staffQuote,
    // A combined PDF covers every stay, so any edit to the stays makes it stale.
    pdf: selectedAffected || keys.length > 1 || isMultiStay(session) ? null : session.pdf,
    // The evidence still backs the results of the stays that were not touched. It goes only with the last result.
    evidence: hasResults ? session.evidence : null,
    // Only the edited stays lose their booking drafts. A single stay has no other drafts to keep.
    bookingDrafts: isMultiStay(session) ? keepKeys(session.bookingDrafts, affected, false) : {},
    rateOptions: (session.rateOptions ?? []).filter(
      (option) => option.groupId === keepRatesOf || !affectedGroupIds.has(option.groupId),
    ),
  };
}

/** What Undo needs to put a stay back: its rows, where they sat, and the rates of its date options. Null if no row has it. */
export function removedStayFor(session: QuoteSession, stayId: string): RemovedStay | null {
  const rows = groupsForStayAction(session.groups, stayId);
  if (!rows.length) return null;
  const keys = dateKeysOf(rows);
  const groupIds = new Set(session.groups.filter((group) => keys.has(stayKeyForGroup(group))).map((group) => group.id));
  const selected = Boolean(session.selectedStayKey && keys.has(session.selectedStayKey));
  return {
    admission: session.binding ? admissionKey(session.binding) : null,
    rows,
    index: session.groups.findIndex((group) => stayIdOf(group) === stayId),
    inputRevision: session.inputRevision,
    sharedRows: session.groups.filter((group) => stayIdOf(group) !== stayId && keys.has(stayKeyForGroup(group))),
    staffQuotes: keepKeys(session.staffQuotes, keys, true),
    stayPdfs: keepKeys(session.stayPdfs, keys, true),
    offers: session.offers.filter((offer) => keys.has(offer.quoteRequestKey)),
    rateOptions: (session.rateOptions ?? []).filter((option) => groupIds.has(option.groupId)),
    evidence: session.evidence,
    selection: selected
      ? {
          phase: session.phase,
          selectedStayKey: session.selectedStayKey,
          selectedOfferIds: session.selectedOfferIds,
          staffQuote: session.staffQuote,
          pdf: session.pdf,
        }
      : null,
  };
}

function keptFieldErrors(
  errors: Partial<Record<StaffExtraField, string>>,
): Partial<Record<StaffExtraField, string>> {
  const kept: Partial<Record<StaffExtraField, string>> = {};
  for (const field of Object.keys(errors) as StaffExtraField[]) {
    const message = errors[field];
    if (message) kept[field] = message;
  }
  return kept;
}

/** A B&B fallback needs an explicit staff price and unit, then a refreshed server quote before any document. */
export function dinnerAllowanceStillRequired(
  value:
    | Pick<StaffQuoteHeader, 'dinnerAllowanceRequired' | 'dinnerAllowanceMinor' | 'dinnerAllowanceUnit' | 'stayExtrasByKey'>
    | Pick<QuoteSession, 'staffHeader' | 'groups'>,
): boolean {
  return dinnerAddOnInputProblem(value) !== null;
}

/** Why staff still need to finish a required dinner add-on, or null when amount and charging unit are explicit. */
export function dinnerAddOnInputProblem(
  value:
    | Pick<StaffQuoteHeader, 'dinnerAllowanceRequired' | 'dinnerAllowanceMinor' | 'dinnerAllowanceUnit' | 'stayExtrasByKey'>
    | Pick<QuoteSession, 'staffHeader' | 'groups'>,
): string | null {
  const header = 'staffHeader' in value ? value.staffHeader : value;
  const extras =
    'staffHeader' in value
      ? requestedQuoteKeys(value.groups).map((key) => staffStayExtrasFor(value.staffHeader, key))
      : Object.values(header.stayExtrasByKey ?? {});
  const required = extras.filter((item) => item.dinnerAllowanceRequired);
  if (required.length) {
    let hasEnteredDinnerPrice = false;
    for (const item of required) {
      if (!item.dinnerEnabled || !(item.dinnerAllowanceMinor && item.dinnerAllowanceMinor > 0)) {
        return 'Dinner price — enter amount.';
      }
      if (!isDinnerAddOnUnit(item.dinnerAllowanceUnit)) return 'Choose how the dinner price is charged.';
      hasEnteredDinnerPrice = true;
    }
    return hasEnteredDinnerPrice ? 'Run Get rates again to apply the dinner price before preparing documents.' : null;
  }
  if (!header.dinnerAllowanceRequired) return null;
  if (!(header.dinnerAllowanceMinor && header.dinnerAllowanceMinor > 0)) return 'Dinner price — enter amount.';
  if (!isDinnerAddOnUnit(header.dinnerAllowanceUnit)) return 'Choose how the dinner price is charged.';
  return 'Run Get rates again to apply the dinner price before preparing documents.';
}

function isDinnerAddOnUnit(value: unknown): value is DinnerAddOnUnit {
  return value === 'per_person_per_night' || value === 'per_room_per_night' || value === 'per_person';
}

/** A quote run and the actions it offers belong to one selection and one input revision. Once either moves on, they are stale. */
export function quoteRunIsCurrent(
  session: Pick<QuoteSession, 'binding' | 'inputRevision' | 'stayRevision'>,
  run: { selectionEpoch: number; inputRevision: number; stayRevision?: number },
): boolean {
  return (
    (session.binding?.selectionEpoch ?? 0) === run.selectionEpoch &&
    session.inputRevision === run.inputRevision &&
    // A row edit after a run ends does not move inputRevision. The rows the run read must still be the rows.
    (run.stayRevision === undefined || session.stayRevision === run.stayRevision)
  );
}

/** A quote-step result stays valid when another date option changes, but not when its own key or inputs move. */
export function quoteStayRunIsCurrent(
  session: Pick<QuoteSession, 'binding' | 'inputRevision' | 'steps' | 'groups'>,
  run: {
    selectionEpoch: number;
    inputRevision: number;
    stepId: string;
    stayKey: string;
    groups: readonly StayGroupRequirement[];
  },
): boolean {
  const step = session.steps.find(
    (item) => item.id === run.stepId && item.kind === 'quote_stay' && item.shareKey === run.stayKey,
  );
  const currentGroups = session.groups.filter((group) => stayKeyForGroup(group) === run.stayKey);
  return (
    (session.binding?.selectionEpoch ?? 0) === run.selectionEpoch &&
    session.inputRevision === run.inputRevision &&
    Boolean(step) &&
    JSON.stringify(currentGroups) === JSON.stringify(run.groups)
  );
}

export function reduceQuoteSession(
  session: QuoteSession,
  action: QuoteSessionAction | QuoteStrategySessionAction,
): QuoteWorkflowSession;
export function reduceQuoteSession(
  session: QuoteSession,
  action: QuoteSessionAction | QuoteStrategySessionAction,
): QuoteSession {
  if (!('quoteStrategyRows' in session)) session = { ...session, ...quoteStrategyState(session) };
  if (
    action.type === 'quote_strategy_comparison_started' ||
    action.type === 'quote_strategy_comparison_result' ||
    action.type === 'quote_strategy_selected'
  ) {
    return reduceQuoteStrategySession(session, action);
  }
  if (action.type === 'analysis_ready') {
    const analysis = withFallbackMissingQuoteReplyFields(action.analysis);
    if (analysis !== action.analysis) action = { ...action, analysis };
  }
  switch (action.type) {
    case 'reset':
      return initialQuoteSession();
    case 'selection': {
      const current = session.binding ? admissionKey(session.binding) : null;
      const next = admissionKey(action.binding);
      if (current === next) {
        return { ...session, binding: action.binding };
      }
      return {
        ...initialQuoteSession(),
        binding: action.binding,
      };
    }
    case 'treat_as': {
      if (action.treatAs === session.treatAs) return session;
      const chosen = { ...session, treatAs: action.treatAs };
      // Rates were got for the old type. A booking needs its cards and a quote must not keep them, so the results go
      // and Get rates runs again for the chosen type. The stays staff have are kept.
      if (
        !session.staffQuote &&
        Object.keys(session.bookingDrafts).length === 0 &&
        Object.keys(session.staffQuotes ?? {}).length === 0 &&
        Object.keys(quoteStrategyState(session).quoteStrategyResults).length === 0
      ) {
        return chosen;
      }
      return clearDownstream({
        ...chosen,
        inputRevision: session.inputRevision + 1,
        phase: 'requirements',
        steps: planQuoteSteps(session.groups),
      });
    }
    case 'staff_note':
      return { ...session, staffNote: action.staffNote.trim() || null };
    case 'analysis_started':
      return {
        ...session,
        phase: 'analysing',
        errorMessage: null,
        analysisStartStayRevision: session.stayRevision,
      };
    case 'analysis_ready': {
      const draft = session.groups.length === 1 && session.groups[0]!.id === DRAFT_GROUP_ID ? session.groups[0]! : null;
      if (draft) {
        // She typed into the blank stay while Nava read. Take the read, then lay what she typed over each of its stays.
        const typed: Partial<StayGroupRequirement> = {};
        for (const key of Object.keys(draft) as (keyof StayGroupRequirement)[]) {
          if (draft.fields[String(key)] === 'staff_corrected') Object.assign(typed, { [key]: draft[key] });
        }
        // Read as a first read (no groups, revisions 0), then move the revisions on past hers so they only ever grow.
        const read = reduceQuoteSession(
          { ...session, groups: [], inputRevision: 0, stayRevision: 0, analysisStartStayRevision: null },
          action,
        );
        const landed = {
          ...read,
          inputRevision: session.inputRevision + read.inputRevision + 1,
          stayRevision: session.stayRevision + read.stayRevision + 1,
        };
        if (!landed.groups.length) return landed;
        return landed.groups.reduce(
          (next, group) => reduceQuoteSession(next, { type: 'patch_group', groupId: group.id, patch: typed }),
          landed,
        );
      }
      const staffEditedDuringRun =
        session.analysisStartStayRevision != null && session.analysisStartStayRevision !== session.stayRevision;
      const loadingDone = session.phase === 'analysing' ? 'requirements' : session.phase;
      if (staffEditedDuringRun) {
        // Staff corrected stay fields after this run started. Keep their groups and take
        // only the new read-out, so a late result never overwrites those edits.
        const staffActions = action.analysis.staffActions ?? session.staffActions;
        const reviewItems = projectQuoteReviewItems(action.analysis, session.groups, [], staffActions);
        const sourceKey = reviewSourceKey(session);
        const handled = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
        return {
          ...session,
          phase: loadingDone,
          analysis: action.analysis,
          analysisStartStayRevision: null,
          staffActions,
          staffHeader: prefillStaffHeaderFromLuna(
            session.staffHeader,
            action.analysis,
            session.staffSalesStrategyEdited === true,
          ),
          reviewItems,
          handledReviewItemIds: handled.filter((id) => reviewItems.some((item) => item.id === id)),
        };
      }
      // A header patch made while Nava reads (contact prefill, party auto-lookup) moves inputRevision
      // but leaves no stays to keep, so it must not turn a first read into a re-read that drops it.
      const keepsStays = session.groups.length > 0 || session.stayRevision > 1;
      if (keepsStays && hasStaffStayEdits(session) && !session.staffNote) {
        const extras = session.reviewItems.filter(
          (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
        );
        // Staff stay edits win over a re-read. A type staff chose (quote or booking) still applies: the re-read's
        // workflow is taken, the edited stays are kept.
        const typeChanged =
          Boolean(session.treatAs) && action.analysis.luna?.workflow !== session.analysis?.luna?.workflow;
        const analysis = typeChanged ? action.analysis : session.analysis;
        return {
          ...session,
          phase: loadingDone,
          analysis,
          analysisStartStayRevision: null,
          reviewItems: projectQuoteReviewItems(analysis, session.groups, extras, session.staffActions),
        };
      }
      if (action.analysis.intent !== 'quote') {
        const unreadItems = (action.analysis.reviewItems ?? []).filter(
          (item) => item.kind === 'document_failure',
        );
        const groups = keepNonQuoteStays(action.analysis) ? action.analysis.groups : [];
        const stays = groupStays(groups);
        return {
          ...clearDownstream(session),
          phase: 'non_quote',
          analysisStartStayRevision: null,
          analysis: action.analysis,
          groups,
          selectedStayKey:
            stays.length === 1
              ? stays[0]!.id
              : session.selectedStayKey &&
                  groups.some(
                    (group) =>
                      stayIdOf(group) === session.selectedStayKey ||
                      stayKeyForGroup(group) === session.selectedStayKey,
                  )
                ? session.selectedStayKey
                : null,
          reviewItems: unreadItems,
          handledReviewItemIds: [],
          staffHeader: prefillStaffHeaderFromLuna(
            session.staffHeader,
            action.analysis,
            session.staffSalesStrategyEdited === true,
          ),
        };
      }
      const keys = requestedQuoteKeys(action.analysis.groups);
      const selectedStayKey = keys.length === 1 ? keys[0]! : session.selectedStayKey && keys.includes(session.selectedStayKey) ? session.selectedStayKey : null;
      const reviewItems = projectQuoteReviewItems(
        action.analysis,
        action.analysis.groups,
        [],
        action.analysis.staffActions ?? session.staffActions,
      );
      const sourceKey = reviewSourceKey({ ...session, analysis: action.analysis });
      const handled = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      const requirementsChanged = session.analysis !== null && JSON.stringify(session.groups) !== JSON.stringify(action.analysis.groups);
      const base = requirementsChanged ? clearDownstream(session) : session;
      return {
        ...base,
        phase: 'requirements',
        analysisStartStayRevision: null,
        analysis: action.analysis,
        groups: action.analysis.groups,
        inputRevision: session.inputRevision + (requirementsChanged ? 1 : 0),
        selectedStayKey,
        steps: session.runningStepId && !requirementsChanged
          ? session.steps
          : planQuoteSteps(action.analysis.groups, base.staffQuotes),
        staffActions: action.analysis.staffActions ?? session.staffActions,
        staffHeader: prefillStaffHeaderFromLuna(
          session.staffHeader,
          action.analysis,
          session.staffSalesStrategyEdited === true,
        ),
        reviewItems,
        handledSourceKey: sourceKey || null,
        handledReviewItemIds: handled.filter((id) => reviewItems.some((item) => item.id === id)),
      };
    }
    case 'analysis_unsynced':
      return { ...session, phase: 'unsynced' };
    case 'analysis_missing_source': {
      const documents = documentFailureItems(action.documents ?? []);
      return {
        ...session,
        phase: 'missing_source',
        missing: action.missing,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, documents, session.staffActions),
      };
    }
    case 'analysis_failed': {
      const failed = {
        id: 'analysis-failed',
        kind: 'analysis_failure' as const,
        rank: 'unread_source' as const,
        text: action.message,
        sourceLabel: 'This email',
        blocking: false,
      };
      return {
        ...session,
        phase: 'failed',
        errorMessage: action.message,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, [failed], session.staffActions),
      };
    }
    case 'review_documents_failed': {
      const documents = documentFailureItems(action.documents);
      return {
        ...session,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, documents, session.staffActions),
      };
    }
    case 'staff_source_ready': {
      if (!/^[a-f0-9]{64}$/.test(action.source.sourceHash) || !action.source.messageId.trim()) {
        return session;
      }
      const keepHandled = session.handledSourceKey === action.source.sourceHash;
      return {
        ...session,
        staffSource: action.source,
        handledSourceKey: action.source.sourceHash,
        handledReviewItemIds: keepHandled ? session.handledReviewItemIds : [],
      };
    }
    case 'staff_actions_ready': {
      const extras = session.reviewItems.filter(
        (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
      );
      const reviewItems = projectQuoteReviewItems(
        session.analysis,
        session.groups,
        extras,
        action.actions,
      );
      const sourceKey = reviewSourceKey({ ...session, staffActions: action.actions });
      const handled = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      return {
        ...session,
        staffActions: action.actions,
        reviewItems,
        handledSourceKey: sourceKey || session.handledSourceKey,
        handledReviewItemIds: handled.filter((id) => reviewItems.some((item) => item.id === id)),
      };
    }
    case 'party_lookup_pending': {
      const pending = session.pendingPartyKinds ?? [];
      if (pending.includes(action.kind) === action.pending) return session;
      const pendingPartyKinds = action.pending
        ? [...pending, action.kind]
        : pending.filter((kind) => kind !== action.kind);
      return { ...session, pendingPartyKinds };
    }
    case 'room_rate_board_selected': {
      const group = session.groups.find((item) => item.id === action.groupId);
      if (!group) return session;
      const quote = staffQuoteForStay(session, stayKeyForGroup(group));
      const knownRow = quote?.availabilityBoard?.some(
        (row) =>
          row.groupId === action.groupId &&
          row.roomCode === action.selection.roomCode &&
          row.rateCode === action.selection.rateCode &&
          row.board === action.selection.board,
      );
      if (!knownRow) return session;

      const previous = session.roomRateBoardSelections?.[action.groupId];
      if (
        previous?.roomCode === action.selection.roomCode &&
        previous.rateCode === action.selection.rateCode &&
        previous.board === action.selection.board
      ) {
        return session;
      }
      // Keep this as staff intent only: a grid choice does not create or validate a quote.
      return {
        ...session,
        roomRateBoardSelections: {
          ...(session.roomRateBoardSelections ?? {}),
          [action.groupId]: {
            roomCode: action.selection.roomCode,
            rateCode: action.selection.rateCode,
            board: action.selection.board,
          },
        },
      };
    }
    case 'patch_staff_header': {
      // Field errors alone do not change the quote, so they neither bump the input revision nor clear results.
      const { fieldErrors, ...amounts } = action.header;
      if (fieldErrors !== undefined && Object.keys(amounts).length === 0) {
        return { ...session, staffHeader: { ...session.staffHeader, fieldErrors: keptFieldErrors(fieldErrors) } };
      }
      const staffHeader = { ...session.staffHeader, ...action.header };
      if (action.header.agency !== undefined && !action.header.agency.trim()) {
        staffHeader.agency = '';
      }
      return clearDownstream({
        ...session,
        staffHeader,
        ...(session.staffSalesStrategyEdited || action.header.salesStrategy !== undefined
          ? { staffSalesStrategyEdited: true }
          : {}),
        inputRevision: session.inputRevision + 1,
      });
    }
    case 'patch_staff_stay_extras': {
      const header = session.staffHeader;
      const stayExtrasByKey = { ...header.stayExtrasByKey };
      const previous = stayExtrasByKey[action.stayKey] ?? staffStayExtrasFor(header, action.stayKey);
      const { fieldErrors, ...values } = action.extras;
      const extras: StaffStayExtras = {
        ...previous,
        ...values,
        ...(fieldErrors !== undefined ? { fieldErrors: keptFieldErrors(fieldErrors) } : {}),
      };
      stayExtrasByKey[action.stayKey] = extras;
      const staffHeader = { ...header, stayExtrasByKey };
      if (Object.keys(values).length === 0) return { ...session, staffHeader };
      return editStays({ ...session, staffHeader }, session.groups, new Set([action.stayKey]));
    }
    case 'select_stay_key': {
      const byStayId = session.groups.some((group) => stayIdOf(group) === action.stayKey);
      const dateKey = byStayId
        ? stayKeyForGroup(session.groups.find((group) => stayIdOf(group) === action.stayKey)!)
        : action.stayKey;
      if (!byStayId && !session.groups.some((group) => stayKeyForGroup(group) === action.stayKey)) return session;
      if (session.selectedStayKey === action.stayKey) return session;
      // Date key still looks up the combined quote. Stay id is what CHECK/amend uses when Find this booking fires.
      const quote = session.staffQuotes[dateKey] ?? null;
      return {
        ...session,
        selectedStayKey: action.stayKey,
        staffQuote: quote,
        selectedOfferIds: quote ? [quote.revisionRef] : [],
        // A combined PDF covers every stay, so it stays when the selection moves between them.
        pdf: isMultiStay(session) ? session.pdf : (session.stayPdfs[dateKey] ?? null),
      };
    }
    case 'staff_quote_ready': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) return session;
      if (action.stayRevision !== undefined && action.stayRevision !== session.stayRevision) return session;
      const source = session.staffSource;
      if (!source || source.sourceHash !== action.staffQuote.sourceHash) return session;
      if (source.messageId !== action.staffQuote.messageId) return session;
      if (action.offer.kind !== 'allocation') return session;
      if (action.offer.id !== action.staffQuote.revisionRef) return session;
      if (action.offer.stayTotalMinor !== action.staffQuote.totalMinor) return session;
      if (action.staffQuote.totalMinor <= 0) return session;
      if (action.offer.nightly.length) return session;
      const stayKey = action.offer.quoteRequestKey;
      const staffQuote = { ...action.staffQuote, quoteRequestKey: stayKey };
      const strategyState = quoteStrategyState(session);
      const quoteStrategySelections = { ...strategyState.quoteStrategySelections };
      delete quoteStrategySelections[stayKey];
      const stayCount = requestedQuoteKeys(session.groups).length;
      // A new run replaces only this option's result and PDF. Other options keep theirs.
      const stayPdfs = { ...session.stayPdfs };
      delete stayPdfs[stayKey];
      // The same goes for rate cards: this run's groups get its options, and the other groups keep theirs.
      const runGroupIds = new Set(action.offer.coversGroupIds);
      const fallbackGroupIds = [...new Set(staffQuote.dinnerFallbackGroupIds ?? [])].filter((id) => runGroupIds.has(id));
      // The search approved only its own stay's extras; other stays keep what staff entered since.
      let staffHeader = action.approvedHeader
        ? {
            ...session.staffHeader,
            ...action.approvedHeader,
            stayExtrasByKey: {
              ...session.staffHeader.stayExtrasByKey,
              ...(action.approvedHeader.stayExtrasByKey?.[stayKey]
                ? { [stayKey]: action.approvedHeader.stayExtrasByKey[stayKey] }
                : {}),
            },
          }
        : session.staffHeader;
      const existingDinner = staffStayExtrasFor(staffHeader, stayKey);
      const dinnerAddOn = staffQuote.dinnerAddOn;
      if (
        fallbackGroupIds.length ||
        staffQuote.dinnerAddOnRequired === true ||
        (existingDinner.dinnerAllowanceRequired && dinnerAddOn)
      ) {
        staffHeader = {
          ...staffHeader,
          stayExtrasByKey: {
            ...staffHeader.stayExtrasByKey,
            [stayKey]: {
              ...existingDinner,
              dinnerEnabled: true,
              dinnerAllowanceRequired: staffQuote.dinnerAddOnRequired === true || !dinnerAddOn,
              dinnerAllowanceMinor: dinnerAddOn?.amountMinor ?? existingDinner.dinnerAllowanceMinor,
              dinnerAllowanceUnit: dinnerAddOn?.unit ?? existingDinner.dinnerAllowanceUnit,
              dinnerAllowanceLabel: existingDinner.dinnerAllowanceLabel,
              // A dinner charge staff already approved keeps its groups; fallback ids only scope a charge the fallback added.
              dinnerAllowanceGroupIds:
                existingDinner.dinnerEnabled || !fallbackGroupIds.length
                  ? existingDinner.dinnerAllowanceGroupIds
                  : fallbackGroupIds,
            },
          },
        };
      }
      return {
        ...session,
        ...strategyState,
        quoteStrategySelections,
        phase: stayCount > 1 ? 'tools' : 'results',
        rateOptions: [
          ...(session.rateOptions ?? []).filter((option) => !runGroupIds.has(option.groupId)),
          ...(action.staffQuote.rateOptions ?? []),
        ],
        offers: [
          ...session.offers.filter(
            (offer) =>
              offer.id !== action.offer.id &&
              !(offer.kind === 'allocation' && offer.quoteRequestKey === stayKey),
          ),
          action.offer,
        ],
        selectedOfferIds: [action.offer.id],
        selectedStayKey: stayKey,
        staffQuote,
        staffQuotes: { ...session.staffQuotes, [stayKey]: staffQuote },
        stayPdfs,
        pdf: null,
        evidence: {
          kind: 'authorised',
          selectionEpoch: action.selectionEpoch,
          inputRevision: action.inputRevision,
        },
        errorMessage: null,
        runningStepId: null,
        reviewedReplyHtml:
          action.reviewedReplyHtml ??
          (session.reviewedReplySource === 'missing_quote_details' || session.reviewedReplySource === 'quote_decline'
            ? ''
            : session.reviewedReplyHtml),
        reviewedReplySource:
          action.reviewedReplyHtml !== undefined ||
          session.reviewedReplySource === 'missing_quote_details' ||
          session.reviewedReplySource === 'quote_decline'
            ? undefined
            : session.reviewedReplySource,
        staffHeader,
        groups: groupsWithPreparedStayRates(
          action.groups?.length ? replaceStayRows(session.groups, action.groups) : session.groups,
          staffQuote,
          runGroupIds,
        ),
        stayRevision: action.groups?.length ? session.stayRevision + 1 : session.stayRevision,
        reviewItems: reviewItemsFromExtrasNotes(session, action.extrasReviewItems ?? []),
        steps: session.steps.map((step) =>
          step.shareKey === stayKey
            ? {
                ...step,
                status: 'succeeded' as const,
                retryGuidance: undefined,
                errorDetail: undefined,
                roomAlternatives: undefined,
              }
            : step,
        ),
        // Only this stay's booking draft is stale. The other stays' drafts still match their own runs.
        bookingDrafts: stayCount > 1 ? keepKeys(session.bookingDrafts, new Set([stayKey]), false) : {},
      } as QuoteWorkflowSession;
    }
    case 'booking_draft_ready': {
      if (!requestMatchesCurrent(session, action.payload.selectionEpoch, action.payload.inputRevision)) {
        return session;
      }
      // No stay-revision check: an edit to the run's own stay drops its run, so the revisionRef match below already
      // proves its rows are unchanged. An edit to another stay must not throw the cards away.
      const source = session.staffSource;
      if (!source || source.sourceHash !== action.sourceHash) return session;
      if (source.messageId !== action.payload.messageId) return session;
      // A draft belongs to the stay whose run it was prepared from. With no matching run it is stale.
      const draftKey = Object.keys(session.staffQuotes).find(
        (key) => session.staffQuotes[key]?.revisionRef === action.payload.revisionRef,
      );
      if (draftKey) return { ...session, bookingDrafts: { ...session.bookingDrafts, [draftKey]: action.payload } };
      const keys = requestedQuoteKeys(session.groups);
      const room = action.payload.draft.rooms[0]?.request;
      const stayKey =
        typeof room?.arrival === 'string' && typeof room?.departure === 'string'
          ? `${room.arrival}:${room.departure}`
          : keys[0];
      if (action.payload.revisionRef !== 'unquoted' || Object.keys(session.staffQuotes).length > 0 || keys.length !== 1 || stayKey !== keys[0]) {
        return session;
      }
      return { ...session, bookingDrafts: { ...session.bookingDrafts, [stayKey]: action.payload } };
    }
    case 'handle_review_item': {
      const item = session.reviewItems.find((row) => row.id === action.itemId);
      if (!item || item.blocking || item.kind === 'pricing_fact') return session;
      const sourceKey = reviewSourceKey(session);
      const existing = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      if (existing.includes(action.itemId)) return session;
      return {
        ...session,
        handledSourceKey: sourceKey || null,
        handledReviewItemIds: [...existing, action.itemId],
      };
    }
    case 'unhandle_review_item':
      return {
        ...session,
        handledReviewItemIds: session.handledReviewItemIds.filter((id) => id !== action.itemId),
      };
    case 'analysis_unsupported':
      return { ...session, phase: 'unsupported', errorMessage: action.message };
    case 'staff_dinner_bb_fallback': {
      if (!action.groupIds.length) return session;
      const patched = action.groupIds.reduce<QuoteSession>(
        (next, groupId) => reduceQuoteSession(next, { type: 'patch_group', groupId, patch: { board: 'bb' } }),
        session,
      );
      // Keep fallback allowances scoped to the stay(s) containing these groups, then clear those stay results.
      const stayExtrasByKey = { ...patched.staffHeader.stayExtrasByKey };
      for (const key of new Set(action.groupIds.map((id) => {
        const group = patched.groups.find((item) => item.id === id);
        return group ? stayKeyForGroup(group) : null;
      }).filter((key): key is string => key !== null))) {
        const ids = patched.groups.filter((group) => stayKeyForGroup(group) === key && action.groupIds.includes(group.id)).map((group) => group.id);
        const current = stayExtrasByKey[key] ?? staffStayExtrasFor(patched.staffHeader, key);
        stayExtrasByKey[key] = {
          ...current,
          dinnerEnabled: true,
          dinnerAllowanceRequired: true,
          dinnerAllowanceGroupIds: [...new Set([...(current.dinnerAllowanceGroupIds ?? []), ...ids])],
        };
      }
      return editStays(
        { ...patched, staffHeader: { ...patched.staffHeader, stayExtrasByKey } },
        patched.groups,
        new Set(action.groupIds.flatMap((id) => {
          const group = patched.groups.find((item) => item.id === id);
          return group ? [stayKeyForGroup(group)] : [];
        })),
      );
    }
    case 'patch_group': {
      // The first edit to the blank stay makes it a real group. Her edit then wins over a read that lands later.
      const base =
        action.groupId === DRAFT_GROUP_ID && !session.groups.some((group) => group.id === DRAFT_GROUP_ID)
          ? [...session.groups, draftStayGroup()]
          : session.groups;
      const target = base.find((group) => group.id === action.groupId);
      if (!target) return session;
      const groups = pinStay(base, stayIdOf(target)).map((group) =>
        group.id === action.groupId ? applyGroupPatch(group, action.patch) : group,
      );
      const patched = groups.find((group) => group.id === action.groupId)!;
      // A date edit moves the stay: its saved extras follow it to the new dates.
      const staffHeader = carryStayExtras(session.staffHeader, groups, stayKeyForGroup(target), stayKeyForGroup(patched));
      // A board edit can change the automatic strategy; a strategy staff picked stays.
      const salesStrategy = session.staffSalesStrategyEdited
        ? staffHeader.salesStrategy
        : automaticSalesStrategy(groups, session.analysis?.luna?.party?.kind);
      const header = salesStrategy === staffHeader.salesStrategy ? staffHeader : { ...staffHeader, salesStrategy };
      // A rate pick or a row price keeps its own cards on screen while the re-run is pending. Other edits clear them.
      return editStays(
        header === session.staffHeader ? session : { ...session, staffHeader: header },
        groups,
        new Set([stayKeyForGroup(target), stayKeyForGroup(patched)]),
        'rateCode' in action.patch || 'rowPrice' in action.patch ? action.groupId : undefined,
      );
    }
    case 'add_stay': {
      const row = blankRow(`r_${action.token}`, `s_${action.token}`, { board: session.groups[0]?.board ?? 'unknown' });
      return editStays(session, [...session.groups, row], new Set([stayKeyForGroup(row)]));
    }
    case 'add_row': {
      const matching = groupsForStayAction(session.groups, action.stayId);
      const template = matching[matching.length - 1];
      if (!template) return session;
      const stayId = stayIdOf(template);
      const row = blankRow(`r_${action.token}`, stayId, {
        arrivalDate: template.arrivalDate,
        departureDate: template.departureDate,
        board: template.board,
      });
      const groups = syncTotalRoomsForStay(
        session,
        insertAfterStay(pinStay(session.groups, stayId), stayId, [row]),
        stayId,
      );
      return editStays(session, groups, new Set([stayKeyForGroup(template)]));
    }
    case 'duplicate_row': {
      const source = session.groups.find((group) => group.id === action.groupId);
      if (!source) return session;
      const stayId = stayIdOf(source);
      const totalRooms = session.analysis?.requestedRoomsByStay?.[stayId];
      const sourceRows = session.groups.filter((group) => stayIdOf(group) === stayId);
      const copiedTotalDefault =
        sourceRows.length === 1 &&
        totalRooms !== undefined &&
        source.quantity === totalRooms &&
        source.fields.quantity === 'defaulted';
      const copySource = copiedTotalDefault
        ? { ...source, quantity: undefined, fields: { ...source.fields, quantity: 'missing' as const } }
        : source;
      const copied = copyRow(copySource, `r_${action.token}`, stayId);
      const copy = copiedTotalDefault
        ? { ...copied, fields: { ...copied.fields, quantity: 'missing' as const } }
        : copied;
      const groups = syncTotalRoomsForStay(
        session,
        insertAfterStay(pinStay(session.groups, stayId), stayId, [copy]),
        stayId,
      );
      return editStays(withDinnerCopies(session, [[source.id, copy.id]]), groups, new Set([stayKeyForGroup(source)]));
    }
    case 'remove_row': {
      const source = session.groups.find((group) => group.id === action.groupId);
      if (!source) return session;
      const stayId = stayIdOf(source);
      // A date-set card keeps at least one row. Its last row goes with the whole stay, which Undo can bring back.
      if (groupsForStayAction(session.groups, stayKeyForGroup(source)).length < 2) return session;
      const groups = syncTotalRoomsForStay(
        session,
        pinStay(session.groups, stayId).filter((group) => group.id !== action.groupId),
        stayId,
      );
      return editStays(session, groups, new Set([stayKeyForGroup(source)]));
    }
    case 'duplicate_stay': {
      const rows = groupsForStayAction(session.groups, action.stayId);
      if (!rows.length) return session;
      const stayId = `s_${action.token}`;
      const copies = rows.map((row, index) => copyRow(row, `r_${action.token}_${index}`, stayId));
      const ids = new Set(rows.map((row) => row.id));
      const last = session.groups.reduce((found, group, index) => (ids.has(group.id) ? index : found), -1);
      const groups = [...session.groups.slice(0, last + 1), ...copies, ...session.groups.slice(last + 1)];
      const pairs = rows.map((row, index) => [row.id, copies[index]!.id] as const);
      return editStays(withDinnerCopies(session, pairs), groups, dateKeysOf(rows));
    }
    case 'remove_stay': {
      const rows = groupsForStayAction(session.groups, action.stayId);
      if (!rows.length) return session;
      const ids = new Set(rows.map((row) => stayIdOf(row)));
      const groups = session.groups.filter((group) => !ids.has(stayIdOf(group)));
      return editStays(session, groups, dateKeysOf(rows));
    }
    case 'restore_stay': {
      const { removal } = action;
      // Undo belongs to the email the stay was removed from. Staff may have moved on before tapping it.
      if ((session.binding ? admissionKey(session.binding) : null) !== removal.admission) return session;
      if (session.groups.some((group) => removal.rows.some((row) => row.id === group.id))) return session;
      const at = Math.min(removal.index, session.groups.length);
      const groups = [...session.groups.slice(0, at), ...removal.rows, ...session.groups.slice(at)];
      const keys = dateKeysOf(removal.rows);
      const restored = editStays(session, groups, keys);
      // The rates were got under one input revision. They come back only if no edit has moved it since, and if the
      // other stays on those dates are as they were: a row edit there does not move the revision but changes the price.
      if (restored.inputRevision !== removal.inputRevision) return restored;
      const sharedNow = session.groups.filter((group) => keys.has(stayKeyForGroup(group)));
      if (JSON.stringify(sharedNow) !== JSON.stringify(removal.sharedRows ?? [])) return restored;
      // A restored stay's run is reusable only when its per-stay extras still match what the run included.
      const placed = { groups, staffHeader: restored.staffHeader };
      if (
        Object.entries(removal.staffQuotes).some(
          ([key, run]) => Boolean(run.onceExtras) !== runCarriesSingleChargeExtras(placed, key),
        )
      ) {
        return restored;
      }
      const staffQuotes = { ...restored.staffQuotes, ...removal.staffQuotes };
      const offers = [
        ...restored.offers,
        ...removal.offers.filter((offer) => !restored.offers.some((item) => item.id === offer.id)),
      ];
      const groupIds = new Set(groups.map((group) => group.id));
      const rateOptions = [
        ...(restored.rateOptions ?? []),
        ...removal.rateOptions.filter(
          (option) =>
            groupIds.has(option.groupId) && !(restored.rateOptions ?? []).some((item) => item.id === option.id),
        ),
      ];
      // The stay was the selected one and nothing has been selected since: its selection and PDF come back too.
      const selection = removal.selection && !restored.staffQuote ? removal.selection : null;
      return {
        ...restored,
        ...(selection
          ? {
              ...selection,
              selectedOfferIds: selection.selectedOfferIds.filter((id) => offers.some((offer) => offer.id === id)),
            }
          : {}),
        staffQuotes,
        stayPdfs: { ...restored.stayPdfs, ...removal.stayPdfs },
        offers,
        rateOptions,
        // The removal dropped the evidence only if it took the last result. Same revision, so it still holds.
        evidence: restored.evidence ?? removal.evidence,
        steps: rePlanSteps(restored, groups, staffQuotes, keys),
      };
    }
    case 'results_ready': {
      if (!action.provenance) return session;
      if (!provenanceMatches(session, action.provenance, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      const incomingGroups = new Set(action.offers.flatMap((offer) => offer.coversGroupIds));
      const incomingKeys = new Set(action.offers.map((offer) => offer.quoteRequestKey));
      const kept = incomingGroups.size
        ? session.offers.filter((offer) => !offer.coversGroupIds.some((id) => incomingGroups.has(id)))
        : session.offers.filter((offer) => !incomingKeys.has(offer.quoteRequestKey));
      return {
        ...session,
        phase: 'results',
        offers: [...kept, ...action.offers],
        evidence: action.provenance,
        errorMessage: null,
        runningStepId: null,
        reviewedReplyHtml:
          action.reviewedReplyHtml ??
          (session.reviewedReplySource === 'missing_quote_details' || session.reviewedReplySource === 'quote_decline'
            ? ''
            : session.reviewedReplyHtml),
        reviewedReplySource:
          action.reviewedReplyHtml !== undefined ||
          session.reviewedReplySource === 'missing_quote_details' ||
          session.reviewedReplySource === 'quote_decline'
            ? undefined
            : session.reviewedReplySource,
        steps: session.steps.map((step) =>
          step.status === 'running' || step.id === session.runningStepId
            ? { ...step, status: 'succeeded' as const }
            : step,
        ),
      };
    }
    case 'lookup_ready': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      const partyRef = action.party.partyRef.trim();
      if (!partyRef) return session;
      const party: PartyLookupRef = {
        organisation: action.party.organisation.trim(),
        partyRef,
      };
      const succeededIds = new Set(
        session.steps
          .filter((step) => step.status === 'succeeded' || step.id === action.stepId)
          .map((step) => step.id),
      );
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        errorMessage: null,
        partyLookup: party,
        steps: session.steps.map((step) => {
          if (step.id === action.stepId) {
            return {
              ...step,
              status: 'succeeded' as const,
              resultSummary: `Party ${party.partyRef}`,
            };
          }
          if (step.status === 'queued' && step.dependsOn.every((dep) => succeededIds.has(dep))) {
            return { ...step, status: 'ready' as const };
          }
          return step;
        }),
      };
    }
    case 'results_unavailable': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      // A failed option marks only its own step. Results for the other date options stay.
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        errorMessage: null,
        // A reply staff wrote during the search stays; only an empty or generated reply becomes the decline.
        ...(action.declineReplyHtml !== undefined &&
        !isMultiStay(session) &&
        (!session.reviewedReplyEdited || !session.reviewedReplyHtml.trim())
          ? { reviewedReplyHtml: action.declineReplyHtml, reviewedReplySource: 'quote_decline' as const }
          : {}),
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? {
                ...step,
                status: 'failed' as const,
                retryGuidance: action.reason,
                errorDetail: action.detail,
                roomAlternatives: action.alternatives,
              }
            : step,
        ),
      };
    }
    case 'step_running':
      return {
        ...session,
        phase: 'tools',
        runningStepId: action.stepId,
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? { ...step, status: 'running' as const, roomAlternatives: undefined }
            : step,
        ),
      };
    case 'step_stale': {
      if (
        session.runningStepId !== action.stepId ||
        !requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)
      ) {
        return session;
      }
      return {
        ...session,
        runningStepId: null,
        steps: session.steps.map((step) =>
          step.id === action.stepId && step.status === 'running' ? { ...step, status: 'ready' as const } : step,
        ),
      };
    }
    case 'step_failed':
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? { ...step, status: 'failed' as const, retryGuidance: action.retryGuidance }
            : step,
        ),
      };
    case 'pdf_ready': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      // A combined PDF is for the stays' current runs (the action names them), whichever option is selected.
      const expectedIds = isMultiStay(session)
        ? (combinedStayRuns(session)?.map((run) => run.revisionRef) ?? [])
        : session.selectedOfferIds;
      if (!sameSelectedOfferIds(action.selectedOfferIds, expectedIds)) {
        return session;
      }
      const stayKey = session.selectedStayKey;
      const strategyState = quoteStrategyState(session);
      const selectedStrategy = stayKey ? strategyState.quoteStrategySelections[stayKey] : undefined;
      let quoteStrategyResults = strategyState.quoteStrategyResults;
      if (stayKey && selectedStrategy && strategyState.quoteStrategyResults[stayKey]?.[selectedStrategy]) {
        quoteStrategyResults = {
          ...strategyState.quoteStrategyResults,
          [stayKey]: {
            ...strategyState.quoteStrategyResults[stayKey],
            [selectedStrategy]: {
              ...strategyState.quoteStrategyResults[stayKey]![selectedStrategy]!,
              pdf: action.pdf,
            },
          },
        };
      }
      const generatedReply =
        session.reviewedReplySource === 'missing_quote_details' ||
        session.reviewedReplySource === 'quote_decline' ||
        session.reviewedReplySource === 'quote_generated';
      const replaceReply =
        !isMultiStay(session) &&
        (generatedReply || (!session.reviewedReplyHtml.trim() && !session.reviewedReplyEdited));
      const preserveGeneratedReplySource = !replaceReply && session.reviewedReplySource === 'quote_generated';
      const reviewedReplyHtml = replaceReply
        ? action.reviewedReplyHtml ?? (generatedReply ? '' : session.reviewedReplyHtml)
        : session.reviewedReplyHtml;
      const reviewedReplySource = replaceReply && action.reviewedReplyHtml?.trim()
        ? 'quote_generated'
        : generatedReply && !preserveGeneratedReplySource
          ? undefined
          : session.reviewedReplySource;
      return {
        ...session,
        ...strategyState,
        quoteStrategyResults,
        pdf: action.pdf,
        phase: 'review',
        reviewedReplyHtml,
        reviewedReplySource,
        reviewedReplyEdited: replaceReply ? false : session.reviewedReplyEdited,
        // A combined PDF is one document for all stays, so it is not kept under any one of them.
        stayPdfs: stayKey && !isMultiStay(session) ? { ...session.stayPdfs, [stayKey]: action.pdf } : session.stayPdfs,
      } as QuoteWorkflowSession;
    }
    case 'set_reviewed_reply':
      return {
        ...session,
        reviewedReplyHtml: action.html,
        reviewedReplyEdited: action.staffEdited === true,
        // A cleared decline keeps its marker so the editor stays open for the staff's own text.
        reviewedReplySource: action.source ?? (session.reviewedReplySource === 'quote_decline' ? 'quote_decline' : undefined),
      };
    case 'select_offers':
      if (sameSelectedOfferIds(action.offerIds, session.selectedOfferIds)) return session;
      // A combined PDF covers every stay's run, not the selection, so it stays.
      return {
        ...session,
        selectedOfferIds: action.offerIds,
        pdf: isMultiStay(session) ? session.pdf : null,
      };
    case 'mailbox_status':
      return { ...session, mailboxStatus: action.status };
    default:
      return session;
  }
}
