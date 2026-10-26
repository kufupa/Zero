import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  allocationTotal,
  amendmentOf,
  canRunQuoteStep,
  canCreatePdf,
  currentStayRun,
  draftStayGroup,
  groupStays,
  isMultiStay,
  partyLookupWaitReason,
  quoteRunBlockReason,
  requestedQuoteKeys,
  rowRoomCode,
  stayAskAction,
  stayKeyForGroup,
  staffSourceReady,
  stayTotals,
} from '@/lib/quote-workflow/session';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import { emptyStaffQuoteHeader, HRCEN_PROPERTY_CODE } from '@/lib/quote-workflow/types';
import type { HmsJobTransport } from '@/lib/quote-workflow/amend-find';
import type { PartyFinder, PartyIndexSearcher, PartySuggestion } from '@/lib/quote-workflow/party-lookup';
import type {
  QueueStatus,
  QuoteOffer,
  QuoteReviewItem,
  QuoteSession,
  QuoteToolStep,
  QuoteBoard,
  RatePlanBoard,
  RatePlanCatalogueEntry,
  RateOption,
  RowPriceChoice,
  StaffQuoteHeader,
  StaffStayExtras,
  QuoteSalesStrategyCode,
  QuoteStrategyRow,
  StayEditAction,
  StayGroupRequirement,
  QuotePaneConfig,
} from '@/lib/quote-workflow/types';
import {
  Disclosure,
  Field,
  LinkButton,
  Notice,
  PrimaryButton,
  Section,
  SecondaryButton,
  paneFieldClass,
  paneTextareaClass,
  StepState,
} from '@/components/nava-pane/pane-ui';
import { BOARD_LABELS, BookingCards } from './booking-card';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { pdfBlockReason } from './document-review';
import { QuoteDocumentsStep, type CurrentQuoteAction } from './quote-documents-step';
import { QuotePeopleStep } from './quote-people-step';
import { QuoteStayStep, StayAskChrome } from './quote-stay-step';
import { useFailedHmsJobNoticeMessage } from './hms-job-notices';
import { HmsQueueStatusLine } from './hms-queue-status';
import { HmsTodoCard } from './hms-todo-card';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { PaneStatusLine } from './pane-status-line';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import { projectBarGrid, RateCards, type BarGridCell } from './rate-cards';
import {
  CopyHmsNotesButton,
  hmsNotesBlock,
  RowRateControls,
  savedPrice,
  useSavedRates,
  type SavedRate,
  type SavedRatesClient,
} from './rate-controls';
import { DEFAULT_ROOM_TYPES } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import {
  matchConfiguredRoomType,
  rowRoomLabel,
  rowRoomTypeCode,
} from '@/lib/quote-workflow/room-types';

const TELL_NAVA_ENABLED = false;

function analysingCopy(session: QuoteSession): string {
  return session.staffNote ? 'Nava is re-reading with your note…' : 'Nava is reading the email…';
}

/**
 * Staff's correction to what Nava read. Closed unless a note is already set. Submitting re-reads the email with the
 * note, and the note wins over the email.
 */
function CorrectionNote({
  onStaffNote,
  draft,
  onDraftChange,
}: {
  onStaffNote?: (note: string) => void;
  /** The owner keeps the draft when this note unmounts. Without it the note keeps its own. */
  draft?: string;
  onDraftChange?: (value: string) => void;
}) {
  const [localNote, setLocalNote] = useState('');
  const note = draft ?? localNote;
  const setNote = onDraftChange ?? setLocalNote;
  const [open, setOpen] = useState(() => note.trim() !== '');
  return (
    <div className="flex flex-col gap-2">
      <LinkButton ariaExpanded={open} onClick={() => setOpen((value) => !value)}>
        Something wrong? Tell Nava
      </LinkButton>
      {open ? (
        <form
          className="flex flex-col gap-2 rounded-[3px] border border-[#e2e8f0] bg-[#f8fafc] p-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = note.trim();
            if (!trimmed) return;
            onStaffNote?.(trimmed);
          }}
        >
          <p className="text-[11.5px] text-[#475569]">
            Nava re-reads the email using your note and updates the fields below. Example: 3 nights from 12 Nov, 2
            adults, dinner included.
          </p>
          <textarea
            id="tell-luna-note"
            aria-label="Tell Nava what's wrong"
            placeholder="Type your note for Nava"
            className={paneTextareaClass}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div>
            <SecondaryButton type="submit">Re-read with my note</SecondaryButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}

type RatePlanCategory = 'public' | 'contract' | 'government' | 'other';
type RatePlanChoice = RatePlanCatalogueEntry & {
  category: RatePlanCategory;
  readByNava: boolean;
};

const RATE_OPTION_BOARD: Record<RateOption['board'], RatePlanBoard> = {
  room_only: 'room_only',
  bb: 'bed_breakfast',
  dinner_bb: 'dinner_bed_breakfast',
};

function ratePlanCategory(entry: RatePlanCatalogueEntry): RatePlanCategory {
  if (entry.event) return 'other';
  if (entry.government) return 'government';
  if (entry.contract) return 'contract';
  return 'public';
}

const PUBLIC_RATE_CODES = new Set(['BAR', 'BARRO']);
const GRID_TAG_LABEL: Record<Exclude<RatePlanCategory, 'other'>, string> = {
  public: 'Public',
  government: 'Government',
  contract: 'Contract',
};

/** Contract tags need the existing staff_quote read for a confirmed party. No new HMS read. */
function confirmedPartyRead(header: StaffQuoteHeader, stayFound: boolean): boolean {
  return (
    stayFound && Boolean(header.parties?.company?.nativeId || header.parties?.agency?.nativeId)
  );
}

/**
 * Grid tag from facts already on the board cell. Contract only when the party read ran and this
 * cell's rateScope is contextual. Never from a public code or the catalogue contract flag.
 */
function gridRateTag(
  rateCode: string,
  rateScope: BarGridCell['rateScope'],
  args: {
    contractChecked: boolean;
    plans: readonly RatePlanChoice[];
  },
): Exclude<RatePlanCategory, 'other'> | null {
  const code = rateCode.trim().toUpperCase();
  if (!code) return null;
  const plan = args.plans.find((item) => item.code === code);
  if (args.contractChecked && rateScope === 'contextual') return 'contract';
  if (plan?.category === 'government') return 'government';
  if (rateScope === 'public' || PUBLIC_RATE_CODES.has(code) || plan?.category === 'public') return 'public';
  return null;
}

/** Add HMS-only codes without treating their labels or flags as static catalogue facts. */
function ratePlanChoices(
  catalogue: readonly RatePlanCatalogueEntry[],
  hmsOptions: readonly RateOption[],
): RatePlanChoice[] {
  const readByNavaCodes = new Set(
    hmsOptions.map((option) => option.rateCode.trim().toUpperCase()).filter(Boolean),
  );
  const choices = new Map<string, RatePlanChoice>();
  for (const entry of catalogue) {
    const code = entry.code.trim().toUpperCase();
    if (code) {
      choices.set(code, {
        ...entry,
        code,
        category: ratePlanCategory(entry),
        readByNava: readByNavaCodes.has(code),
      });
    }
  }
  for (const option of hmsOptions) {
    const code = option.rateCode.trim().toUpperCase();
    if (!code || choices.has(code)) continue;
    const event = option.hint === 'event_rate';
    choices.set(code, {
      code,
      name: code,
      board: RATE_OPTION_BOARD[option.board],
      ...(event ? { event: true } : {}),
      ...(option.contract ? { contract: true } : {}),
      category: event ? 'other' : option.contract ? 'contract' : 'other',
      readByNava: true,
    });
  }
  return [...choices.values()];
}

function filteredRateOptions(
  options: RateOption[],
  selectedPlan: string,
  choices: RatePlanChoice[],
): RateOption[] {
  if (selectedPlan === 'all') return options;
  if (selectedPlan === 'government' || selectedPlan === 'public') {
    // Public (BAR) is every code that is not a government code, so it still filters with no catalogue.
    const governmentCodes = new Set(
      choices.filter((choice) => choice.category === 'government').map((choice) => choice.code),
    );
    // No government category is known (the catalogue query failed, or HMS-only codes): the search already
    // priced under Government, so show what HMS returned instead of hiding every rate.
    if (selectedPlan === 'government' && governmentCodes.size === 0) return options;
    const wantGovernment = selectedPlan === 'government';
    return options.filter(
      (option) => governmentCodes.has(option.rateCode.trim().toUpperCase()) === wantGovernment,
    );
  }
  const selected = selectedPlan.toUpperCase();
  return options.filter((option) => option.rateCode.trim().toUpperCase() === selected);
}

/** Rate plan filters returned options. Contract eligibility still comes only from each HMS result. */
function RatePlanSelect({
  ratePlans,
  ratePlan,
  onRatePlanChange,
}: {
  ratePlans: RatePlanChoice[];
  ratePlan: string;
  onRatePlanChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Showing rates for" htmlFor="quote-rate-plan">
        <select
          id="quote-rate-plan"
          aria-label="Rate plan"
          className={paneFieldClass}
          value={ratePlan}
          onChange={(event) => onRatePlanChange(event.target.value)}
        >
          <option value="all">All rates</option>
          {(['public', 'contract', 'government', 'other'] as const).map((category) => {
            const plans = ratePlans
              .filter((entry) => entry.category === category)
              .sort((left, right) => Number(right.readByNava) - Number(left.readByNava));
            // Public (BAR) and government keep their "All" choice even when the catalogue is down.
            if (!plans.length && category !== 'government' && category !== 'public') return null;
            const label = category === 'other' ? 'Other HMS rates' : `${category[0]!.toUpperCase()}${category.slice(1)}`;
            return (
              <optgroup key={category} label={label}>
                {category === 'public' ? <option value="public">All public rates (BAR)</option> : null}
                {category === 'government' ? <option value="government">All government rates</option> : null}
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name === plan.code ? plan.code : `${plan.code}: ${plan.name}`}
                    {plan.readByNava ? ' (read by Nava)' : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <span className="mt-0.5 block text-[13px] font-normal text-[#64748b]">
          All rates shows every code HMS returned. Choosing a plan filters the cards below.
        </span>
      </Field>
    </div>
  );
}

/** Read-only BAR table with public / government / contract tags from the existing read. */
function RatesBarGrid({
  cells,
  contractChecked,
  plans,
}: {
  cells: BarGridCell[];
  contractChecked: boolean;
  plans: readonly RatePlanChoice[];
}) {
  if (!cells.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">BAR by room, rate and board</h5>
      {contractChecked ? null : (
        <p className="text-[12px] text-[#64748b]">Public rates — contract not checked</p>
      )}
      <table className="w-full border-collapse text-[12px]" aria-label="BAR by room, rate and board">
        <thead>
          <tr className="border-b border-[#e2e8f0] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748b]">
            <th className="py-1 pr-2 font-semibold">Room</th>
            <th className="py-1 pr-2 font-semibold">Rate</th>
            <th className="py-1 pr-2 font-semibold">Board</th>
            <th className="py-1 pr-2 font-semibold">Nightly</th>
            <th className="py-1 pr-2 font-semibold">Rooms left</th>
            <th className="py-1 font-semibold">Tag</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            const tag = gridRateTag(cell.rateCode, cell.rateScope, { contractChecked, plans });
            return (
              <tr
                key={`${cell.groupId}|${cell.roomCode}|${cell.rateCode}|${cell.board}`}
                className="border-b border-[#f1f5f9] text-[#1e293b]"
              >
                <td className="py-1 pr-2">{`${cell.roomLabel} (${cell.roomCode})`}</td>
                <td className="py-1 pr-2">{cell.rateCode}</td>
                <td className="py-1 pr-2">{cell.boardLabel}</td>
                <td className="py-1 pr-2">
                  {cell.nightlyPriceMinor === null ? 'not checked' : draftMoney(cell.nightlyPriceMinor)}
                </td>
                <td className="py-1 pr-2">{cell.roomsLeft === null ? 'not checked' : String(cell.roomsLeft)}</td>
                <td className="py-1">
                  {tag ? (
                    <span className="rounded-[2px] bg-[#eff6ff] px-1 py-px text-[10px] font-semibold text-[#0066cc]">
                      {GRID_TAG_LABEL[tag]}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HmsNotesFields({
  notesBlock,
  notes,
  onNotesChange,
}: {
  notesBlock: string;
  /** The staff note for HMS, stored on the quote header so it survives the pane and goes to the booking. */
  notes: string;
  onNotesChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Disclosure summary={<span>HMS notes (optional)</span>}>
        <Field label="Notes for HMS" htmlFor="quote-hms-notes">
          <textarea
            id="quote-hms-notes"
            aria-label="Notes for HMS"
            className={paneTextareaClass}
            placeholder="Add a staff note for the HMS handoff"
            value={notes}
            onChange={(event) => onNotesChange(event.target.value)}
          />
        </Field>
        <CopyHmsNotesButton block={notesBlock} />
      </Disclosure>
    </div>
  );
}

function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <p aria-live="polite" className="rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-[13px] text-[#475569]">
      {children}
    </p>
  );
}

function money(minor: number): string {
  return `R${(minor / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The picked company, else the picked agency. A contract rate is named after one of them. */
function contractPartyName(header: StaffQuoteHeader): string | undefined {
  const party = header.parties?.company ?? header.parties?.agency;
  return party?.name?.trim() || undefined;
}

function OfferCard({
  offer,
  selected,
  onSelect,
  showShot = true,
}: {
  offer: QuoteOffer;
  selected: boolean;
  onSelect?: (id: string) => void;
  /** A staff quote shows its HMS audit screenshot beside the card instead. */
  showShot?: boolean;
}) {
  const varying = new Set(offer.nightly.map((n) => n.amountMinor)).size > 1;
  const shot =
    offer.screenshot && 'unavailable' in offer.screenshot
      ? offer.screenshot.reason
      : offer.screenshot
        ? `Screenshot from HMS search ${offer.screenshot.toolRunId}`
        : 'No screenshot is attached to this HMS search. Check the quoted details and PDF.';
  return (
    <button
      type="button"
      onClick={() => onSelect?.(offer.id)}
      aria-pressed={selected}
      className={`flex flex-col gap-1 rounded-xs border p-3 text-left ${
        selected ? 'border-[#1a4332] bg-[#eaf4ee]' : 'border-[#cbd5e1] bg-white'
      }`}
    >
      <span className="text-[13px] font-bold text-[#1e293b]">
        {offer.roomLabel} · {offer.rateCode} · {offer.board}
      </span>
      <span className="text-[13px] text-[#64748b]">
        {offer.kind === 'alternative' ? 'Alternative — not counted in the total' : 'Counted in the total'}
      </span>
      <span className="text-[13.5px] font-extrabold text-[#1e293b]">{money(offer.stayTotalMinor)}</span>
      <span className="text-[10px] text-[#64748b]">Checked in HMS {offer.observedAt}</span>
      {varying ? (
        <details>
          <summary className="text-[13px] text-[#0066cc]">Nightly breakdown</summary>
          <ul className="text-[13px] text-[#475569]">
            {offer.nightly.map((night) => (
              <li key={night.date}>
                {night.date}: {money(night.amountMinor)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {offer.restrictions.map((restriction) => (
        <p key={restriction} className="text-[13px] text-amber-800">
          {restriction}
        </p>
      ))}
      {showShot ? <p className="text-[13px] text-[#64748b]">{shot}</p> : null}
    </button>
  );
}

function hideQuoteWorkspace(phase: QuoteSession['phase']): boolean {
  return (
    phase === 'idle' ||
    phase === 'unsynced' ||
    phase === 'unsupported' ||
    phase === 'non_quote'
  );
}

const CONTACT_QUESTION_FIELDS = new Set([
  'contact',
  'attention',
  'booker',
  'contactname',
  'clientname',
  'email',
  'clientemail',
  'contactemail',
  'phone',
  'telephone',
  'clienttelephone',
  'contactphone',
]);

/** The first quote fact to resolve follows the reservationist's decision order, not model output order. */
function missingQuestionPriority(field: string): number {
  const key = field.toLowerCase().replace(/[\s_-]/g, '');
  if (/(party|company|agency)/.test(key)) return 0;
  if (/(authority|authoris|authoriz|approv|rateplan|salesstrategy|contract)/.test(key)) return 1;
  if (/(arrival|departure|checkin|checkout|stay|date|room|guest|adult|child|occupancy)/.test(key)) return 2;
  if (/(availability|price|amount|rate|nightly|cost)/.test(key)) return 3;
  if (/(extra|meal|dinner|lunch|breakfast|shuttle|alternative|option)/.test(key)) return 4;
  if (/(document|pdf|attachment|reply)/.test(key)) return 5;
  return 6;
}

/** A defaulted ambiguous preference such as "Twin" intentionally lets HMS search any room type. */
function roomRequirementReady(group: StayGroupRequirement): boolean {
  return rowRoomCode(group) !== null ||
    (group.fields.roomPreference === 'defaulted' && Boolean(group.roomPreference?.trim()));
}

/** Ignore analysis questions whose current editable quote value is already present. */
function missingQuestionAnswered(
  field: string,
  groups: StayGroupRequirement[],
  header: StaffQuoteHeader,
): boolean {
  const key = field.toLowerCase().replace(/[\s_-]/g, '');
  if (CONTACT_QUESTION_FIELDS.has(key)) return true;
  const everyGroup = (answered: (group: StayGroupRequirement) => boolean) =>
    groups.length > 0 && groups.every(answered);

  if (['arrival', 'arrivaldate', 'checkin', 'checkindate'].includes(key)) {
    return everyGroup((group) => Boolean(group.arrivalDate));
  }
  if (['departure', 'departuredate', 'checkout', 'checkoutdate'].includes(key)) {
    return everyGroup((group) => Boolean(group.departureDate));
  }
  if (['date', 'dates', 'staydates', 'daterange'].includes(key)) {
    return everyGroup((group) => Boolean(group.arrivalDate && group.departureDate));
  }
  if (key === 'stay' || key === 'staydetails') {
    return everyGroup(
      (group) => Boolean(
        group.arrivalDate &&
          group.departureDate &&
          roomRequirementReady(group) &&
          group.quantity &&
          group.adults,
      ),
    );
  }
  if (key === 'party') {
    return Boolean(header.parties?.company?.nativeId || header.parties?.agency?.nativeId);
  }
  if (key === 'company') return Boolean(header.company.trim() || header.parties?.company?.nativeId);
  if (key === 'agency') return Boolean(header.agency.trim() || header.parties?.agency?.nativeId);
  if (
    ['room', 'roomtype', 'roomtypes', 'roompreference', 'roomtypecode', 'roomcodes'].includes(key)
  ) {
    return everyGroup((group) =>
      Boolean(rowRoomTypeCode(group) || group.roomPreference?.trim() || group.roomCodes?.length),
    );
  }
  if (['quantity', 'rooms', 'roomcount', 'numberofrooms'].includes(key)) {
    return everyGroup((group) => (group.quantity ?? 0) > 0);
  }
  if (['adult', 'adults', 'adultsperroom'].includes(key)) {
    return everyGroup((group) => (group.adults ?? 0) > 0);
  }
  if (['childages', 'childrenages'].includes(key)) {
    return everyGroup((group) => group.childrenAges.length > 0);
  }
  return false;
}

function scrollToStep(id: string): void {
  document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

/** Why this stay's availability search cannot run yet, or null when its one HMS step can run. */
function stayRatesBlockReason(
  session: QuoteSession,
  rows: StayGroupRequirement[],
  step: QuoteToolStep | undefined,
): string | null {
  const lookupWait = partyLookupWaitReason(session);
  if (lookupWait) return lookupWait;
  if (!rows.length) return 'Add a stay before searching.';
  if (rows.some((group) => !group.arrivalDate || !group.departureDate)) {
    return 'Add arrival and departure dates first.';
  }
  if (rows.some((group) => !group.quantity)) return 'Add the number of rooms first.';
  if (!step) return 'The HMS search is not ready yet.';
  if (step.status === 'succeeded') return null;
  const stepWait = quoteRunBlockReason(session, step);
  if (stepWait) return stepWait;
  if (!canRunQuoteStep(step, session.steps, null)) return 'Wait for the earlier HMS search to finish.';
  return null;
}

/** A row price or rate change waiting to reach the session. Once every `check` has landed, the stay re-runs. */
type PinRun = { stepId: string; changes: { groupId: string; check: Partial<StayGroupRequirement> }[] };
type QueuedStayRun = { stepId: string; selectionEpoch: number };
/** Equal for a session check. A cleared price (undefined) matches a row with no price. */
function sameValue(current: unknown, wanted: unknown): boolean {
  return JSON.stringify(current) === JSON.stringify(wanted);
}

/** The generated room/rate summary remains available to copy alongside the editable handoff note. */
function quoteNotesBlock(
  session: QuoteSession,
  rowLabels: ReadonlyMap<string, string>,
  contact: StoredContact | null | undefined,
): string {
  const confirmation = session.analysis?.amendment?.confirmationNumber;
  return hmsNotesBlock({
    booker: contact?.name,
    company: contact?.company,
    confirmations: confirmation ? [confirmation] : [],
    rooms: session.groups.map((group) => {
      const rowRate = session.staffQuotes[stayKeyForGroup(group)]?.rowRates?.find((item) => item.groupId === group.id);
      const override = group.rowPrice?.source === 'override' ? group.rowPrice : null;
      const saved = group.rowPrice?.source === 'saved' ? group.rowPrice : null;
      const code = rowRate?.rateCode ?? override?.rateCode ?? group.rateCode;
      const option = (session.rateOptions ?? []).find((item) => item.groupId === group.id && item.rateCode === code);
      return {
        label: rowLabels.get(group.id) ?? 'Room',
        specialRequests: group.specialRequests,
        authorisedBy: override?.note,
        rate: {
          code,
          label: rowRate?.customRateName ?? saved?.name ?? option?.rateLabel,
          nightlyMinor: rowRate?.nightlyMinor ?? (group.rowPrice ? [group.rowPrice.amountMinor] : undefined),
          stay:
            group.arrivalDate && group.departureDate
              ? { arrival: group.arrivalDate, departure: group.departureDate }
              : null,
          board: BOARD_LABELS[group.board],
        },
      };
    }),
  });
}

function stayDisplayTotal(session: QuoteSession, stayKey: string): number | null {
  const run = currentStayRun(session, stayKey);
  if (run) return run.totalMinor;
  const selected = session.offers.filter(
    (offer) => offer.quoteRequestKey === stayKey && offer.kind === 'allocation' && session.selectedOfferIds.includes(offer.id),
  );
  return selected.length ? allocationTotal(selected) : null;
}

function allStaysDisplayTotal(session: QuoteSession): { total: number | null; rated: number; stays: number } {
  const keys = requestedQuoteKeys(session.groups);
  const amounts = keys.map((key) => stayDisplayTotal(session, key));
  const known = amounts.filter((amount): amount is number => amount !== null);
  return {
    total: amounts.length > 0 && known.length === amounts.length ? known.reduce((sum, amount) => sum + amount, 0) : null,
    rated: known.length,
    stays: keys.length,
  };
}

export function QuoteWorkflowPanel({
  session,
  onPatchGroup,
  onStayAction,
  onRunNext,
  onRunStep,
  onSelectOffer,
  onReplyChange,
  replyContent,
  onPreparePdf,
  onDownloadWorkbook,
  workbookPending,
  pdfPending,
  onHandleReviewItem,
  onUndoReviewItem,
  onRetryRead,
  onViewSource,
  onEditReply,
  onPatchStaffHeader,
  onPatchStayExtras,
  findParty,
  partyJobTransport,
  onPartyLookupPending,
  onSelectStayKey,
  onSelectQuoteStrategy,
  quoteStrategyRows,
  onStaffNote,
  staffNoteDraft,
  onStaffNoteDraftChange,
  hmsQueue,
  onLoadRunScreenshot,
  paneSave,
  partySuggestions,
  partyIndex,
  rates,
  rateCatalogue,
  paneConfig,
  contact,
  makeQuote = true,
}: {
  session: QuoteSession;
  /** Set only when the server pane save flag is on. Null keeps the booking card copy-only. */
  paneSave?: PaneStayClient | null;
  /** The stored read's contact (booker and company) for the HMS notes. Null while the mail has no stored read. */
  contact?: StoredContact | null;
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
  /** Persisted party searches use the shared HMS job transport. */
  partyJobTransport?: HmsJobTransport | null;
  /** The saved rates for each row's price. Null or absent: no saved-rate picker, but one-off and override still show. */
  rates?: SavedRatesClient | null;
  /** Rate plans returned with the active mailbox's quote pane config. */
  rateCatalogue?: RatePlanCatalogueEntry[];
  /** Null means the mailbox config is loading or was refused; undefined preserves legacy CEN-only callers. */
  paneConfig?: QuotePaneConfig | null;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  /** Adds, duplicates or removes a room or a stay. The shell keeps a removed stay for Undo. */
  onStayAction?: (action: StayEditAction) => void;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
  onSelectOffer?: (offerId: string) => void;
  onReplyChange?: (html: string) => void;
  /** The surface-specific reply/save action, kept inside the Quote step. */
  replyContent?: ReactNode;
  onPreparePdf?: () => void;
  onDownloadWorkbook?: () => void;
  /** An Excel export is being made; the Excel button is disabled meanwhile. */
  workbookPending?: boolean;
  /** A PDF is being prepared; both PDF actions stay disabled until it settles. */
  pdfPending?: boolean;
  onHandleReviewItem?: (itemId: string) => void;
  onUndoReviewItem?: (itemId: string) => void;
  /** Runs the read again after an analysis failure. Absent when there is nothing to retry. */
  onRetryRead?: () => void;
  onViewSource?: (item: QuoteReviewItem) => void;
  onEditReply?: () => void;
  onPatchStaffHeader?: (header: Partial<StaffQuoteHeader>, options?: { staffEdit?: boolean }) => void;
  onPatchStayExtras?: (stayKey: string, extras: Partial<StaffStayExtras>) => void;
  /** HMS company and agency search for the quote header's Find in HMS picker. Null or absent: no picker. */
  findParty?: PartyFinder | null;
  /** Tells the pane whether a company or agency search still decides its pick. A rates run waits for it. */
  onPartyLookupPending?: (kind: 'company' | 'agency', pending: boolean) => void;
  onSelectStayKey?: (stayKey: string) => void;
  /** Display-only outcomes keyed by stay and registry strategy code; bind/session owns their lifecycle. */
  quoteStrategyRows?: Record<string, Partial<Record<QuoteSalesStrategyCode, QuoteStrategyRow>>>;
  /** Optional seam for the bind/session follow-up to connect the staff choice. */
  onSelectQuoteStrategy?: (stayKey: string, strategyCode: QuoteSalesStrategyCode) => void;
  onStaffNote?: (note: string) => void;
  /** A retained staff correction, owned by the pane so it survives a trip off the tool screen. */
  staffNoteDraft?: string;
  onStaffNoteDraftChange?: (value: string) => void;
  /** HMS queue progress for the staff quote run in flight. */
  hmsQueue?: { pending: boolean; status: QueueStatus | null };
  /** Loads one HMS audit screenshot of a completed staff quote run. */
  onLoadRunScreenshot?: LoadRunScreenshot;
  /** Server-backed Make quote. False disables Search availability / Make quote. Default true. */
  makeQuote?: boolean;
}) {
  const currentEmailKey = session.binding?.internetMessageId ?? session.binding?.entryId ?? null;
  const failedRatesNotice = useFailedHmsJobNoticeMessage('quote-rates', currentEmailKey);
  // A row price or rate tapped and waiting for its pin to reach the session. The re-run starts once every pin is there, so it reads them.
  const [pinRun, setPinRun] = useState<PinRun | null>(null);
  const [queuedStayRuns, setQueuedStayRuns] = useState<QueuedStayRun[]>([]);
  const queuedLaunchPending = useRef(false);
  const [ratePlanState, setRatePlanState] = useState<{
    selectionEpoch: number;
    analysis: QuoteSession['analysis'];
    value: string;
  } | null>(null);
  const [mealPlanFilters, setMealPlanFilters] = useState<Record<string, QuoteBoard | 'all'>>({});
  const selectionEpoch = session.binding?.selectionEpoch ?? 0;
  const editedPartyFields = useRef({ selectionEpoch, company: false, agency: false });
  if (editedPartyFields.current.selectionEpoch !== selectionEpoch) {
    editedPartyFields.current = { selectionEpoch, company: false, agency: false };
  }
  const markPartyFieldEdited = (kind: 'company' | 'agency') => {
    editedPartyFields.current[kind] = true;
  };
  const contactAgency = contact?.company?.trim() ?? '';
  const contactCompany = contact?.endClient?.trim() ?? '';
  const contactPrefillKey = contact
    ? JSON.stringify([selectionEpoch, session.binding?.entryId ?? '', contactAgency, contactCompany])
    : null;
  const appliedContactPrefill = useRef<string | null>(null);
  useEffect(() => {
    if (!pinRun) return;
    if (session.runningStepId || hmsQueue?.pending) return;
    const landed = pinRun.changes.every(({ groupId, check }) => {
      const group = session.groups.find((item) => item.id === groupId);
      return (
        group !== undefined &&
        Object.entries(check).every(([key, value]) => sameValue(group[key as keyof StayGroupRequirement], value))
      );
    });
    if (!landed) return;
    setPinRun(null);
    onRunStep?.(pinRun.stepId);
  }, [pinRun, session.groups, session.runningStepId, hmsQueue?.pending, onRunStep]);
  useEffect(() => {
    if (session.runningStepId || hmsQueue?.pending || pinRun) {
      queuedLaunchPending.current = false;
      return;
    }
    const next = queuedStayRuns[0];
    if (!next) return;
    if (next.selectionEpoch !== selectionEpoch) {
      setQueuedStayRuns((current) => current.slice(1));
      return;
    }
    const step = session.steps.find((item) => item.id === next.stepId);
    const rows = session.groups.filter((group) => step?.shareKey === stayKeyForGroup(group));
    const reason = step
      ? stayRatesBlockReason(session, rows, step)
      : 'The stay changed before its search could start.';
    if (reason) {
      setQueuedStayRuns((current) => current.slice(1));
      toast.warning(reason);
      return;
    }
    if (!onRunStep || queuedLaunchPending.current) return;
    queuedLaunchPending.current = true;
    setQueuedStayRuns((current) => current.slice(1));
    onRunStep(next.stepId);
  }, [
    hmsQueue?.pending,
    onRunStep,
    pinRun,
    queuedStayRuns,
    selectionEpoch,
    session.groups,
    session.runningStepId,
    session.steps,
  ]);
  useEffect(() => {
    if (!contactPrefillKey || !onPatchStaffHeader || appliedContactPrefill.current === contactPrefillKey) return;
    appliedContactPrefill.current = contactPrefillKey;
    const party = session.analysis?.luna?.party;
    const partyName = party?.name?.trim();
    const agency = session.staffHeader.agency.trim();
    const company = session.staffHeader.company.trim();
    const usesLunaAgency = party?.kind === 'agency' && agency === partyName;
    const usesLunaCompany =
      (party?.kind === 'organization' || party?.kind === 'government') && company === partyName;
    const patch: Partial<StaffQuoteHeader> = {};
    if (
      contactAgency &&
      !editedPartyFields.current.agency &&
      !session.staffHeader.parties?.agency &&
      (!agency || usesLunaAgency)
    ) {
      patch.agency = contactAgency;
    }
    if (
      contactCompany &&
      !editedPartyFields.current.company &&
      !session.staffHeader.parties?.company &&
      (!company || usesLunaCompany)
    ) {
      patch.company = contactCompany;
    }
    if (Object.keys(patch).length) onPatchStaffHeader(patch);
  }, [
    contactAgency,
    contactCompany,
    contactPrefillKey,
    onPatchStaffHeader,
    session.analysis?.luna?.party,
    session.staffHeader.agency,
    session.staffHeader.company,
  ]);
  // The session and pin as of the last render. A saved-rate edit lands after an await, so it reads these, not the ones it began with.
  const latest = useRef({ session, pinRun });
  latest.current = { session, pinRun };
  // Saved rates are per mailbox. The pane stays mounted across a mailbox switch, so the list follows the binding.
  const saved = useSavedRates(rates ?? null, session.binding?.transportId ?? null);
  if (session.phase === 'idle') {
    return <StatusNote>Select an email in Outlook. Nava will read it and list what the quote needs.</StatusNote>;
  }
  if (session.phase === 'unsynced') {
    return (
      <div className="flex flex-col gap-3">
        <StatusNote>This email has not finished syncing yet. Wait a moment, then select it again.</StatusNote>
        {replyContent ? <div className="flex flex-col gap-2.5">{replyContent}</div> : null}
      </div>
    );
  }
  if (session.phase === 'unsupported') {
    return (
      <StatusNote>{session.errorMessage ?? 'Nava cannot handle this email yet. Handle it by hand in Outlook.'}</StatusNote>
    );
  }
  const amendment = amendmentOf(session);
  const bookCardShowing = requestedQuoteKeys(session.groups).some((key) => session.bookingDrafts[key]);
  const hmsTodoCard =
    bookCardShowing && session.analysis?.hmsTodoCard?.kind === 'new_booking'
      ? undefined
      : session.analysis?.hmsTodoCard;
  if (session.phase === 'non_quote') {
    // One notice. Staff only see more when Nava flagged something they must act on: the not-supported guidance, or a file it could not read.
    const unreadFiles = (session.reviewItems ?? []).filter((item) => item.kind === 'document_failure');
    const amendStays = groupStays(session.groups).filter((stay) => {
      const action = stayAskAction(session, stay.id);
      return action === 'amend' || action === 'cancel';
    });
    return (
      <div className="flex flex-col gap-3">
        {TELL_NAVA_ENABLED ? (
          <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
        ) : null}
        {amendStays.map((stay) => (
          <StayAskChrome key={stay.id} session={session} stay={stay} onSelectStayKey={onSelectStayKey} />
        ))}
        <HmsTodoCard card={hmsTodoCard} />
        <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} amendment={amendment} unreadFiles={unreadFiles.length > 0} />
        {unreadFiles.map((item) => (
          <Notice key={item.id} tone="warn">
            {item.text}
          </Notice>
        ))}
      </div>
    );
  }

  const openItems = openReviewItems(session);
  // Each unread file has its own notice in the items below, so the generic unread-attachment flag line is left out.
  const hasUnreadFiles = (session.reviewItems ?? []).some((item) => item.kind === 'document_failure');
  const handledItems = (session.reviewItems ?? []).filter(
    (item) =>
      notNoise(item) &&
      item.kind !== 'pricing_fact' &&
      !item.blocking &&
      (session.handledReviewItemIds ?? []).includes(item.id),
  );
  const authorizedPartial =
    staffSourceReady(session) &&
    (session.phase === 'failed' || session.phase === 'missing_source' || session.phase === 'analysing');
  const showWorkspace = !hideQuoteWorkspace(session.phase);
  const showReply =
    Boolean(
      session.offers.length ||
        session.reviewedReplyHtml ||
        session.reviewedReplySource === 'quote_decline' ||
        canCreatePdf(session) ||
        authorizedPartial ||
        openItems.length,
    );

  // While Nava reads, or after a read failed, a blank stay keeps the form open so she can type before the read lands.
  const formGroups =
    !session.groups.length && (session.phase === 'analysing' || session.phase === 'failed')
      ? [draftStayGroup()]
      : session.groups;

  const header = session.staffHeader ?? emptyStaffQuoteHeader();
  const ratePlans = ratePlanChoices(rateCatalogue ?? [], session.rateOptions ?? []);
  const roomTypesByCode = new Map(
    (paneConfig === undefined ? DEFAULT_ROOM_TYPES : paneConfig?.roomTypes ?? []).map((room) => [room.code, room]),
  );
  for (const code of Object.values(session.bookingDrafts).flatMap((draft) => draft.options.roomType)) {
    if (!roomTypesByCode.has(code)) roomTypesByCode.set(code, { code, label: code });
  }
  for (const alternative of session.steps.flatMap((step) => step.roomAlternatives ?? [])) {
    if (!roomTypesByCode.has(alternative.roomCode)) {
      roomTypesByCode.set(alternative.roomCode, { code: alternative.roomCode, label: alternative.roomLabel });
    }
  }
  for (const group of formGroups) {
    for (const code of group.roomCodes ?? []) {
      if (!roomTypesByCode.has(code)) {
        const label = group.roomCodes?.length === 1 ? group.roomPreference || code : code;
        roomTypesByCode.set(code, { code, label });
      }
    }
  }
  const paneRoomTypes = [...roomTypesByCode.values()];
  const strictRoomTypes = paneConfig !== undefined;
  const paneBoards = paneConfig === undefined ? undefined : paneConfig?.boards ?? [];
  const salesStrategies = [...(paneConfig?.salesStrategies ?? [])].sort(
    (left, right) => Number(right.code === 'BAR') - Number(left.code === 'BAR'),
  );
  const overrideRateCodes = paneConfig === undefined ? undefined : paneConfig?.overrideRateCodes ?? [];
  const eventRateCodes = paneConfig === undefined ? undefined : paneConfig?.eventRateCodes ?? [];
  const ratePlan =
    ratePlanState?.selectionEpoch === selectionEpoch && ratePlanState.analysis === session.analysis
      ? ratePlanState.value
      : header.salesStrategy === 'Government'
        ? 'government'
        : 'all';
  // Government parties and Dinner B&B asks default to Government; "All rates" returns to that default.
  const governmentParty = session.analysis?.luna?.party?.kind === 'government';
  const dinnerBbAsk = session.groups.length > 0 && session.groups.every((group) => group.board === 'dinner_bb');
  const changeRatePlan = (value: string) => {
    setRatePlanState({ selectionEpoch, analysis: session.analysis, value });
    // The search's sales strategy lives in the header. "All rates" restores the default for
    // government parties and Dinner B&B asks; public and other plans ask HMS for BAR pricing.
    const government =
      value === 'all'
        ? governmentParty || dinnerBbAsk
        : value === 'government' || ratePlans.some((plan) => plan.code === value && plan.category === 'government');
    const salesStrategy = government ? 'Government' : 'BAR';
    if (salesStrategy !== header.salesStrategy) onPatchStaffHeader?.({ salesStrategy }, { staffEdit: true });
  };
  const stays = groupStays(formGroups);
  const roomTotals = stayTotals(session.groups);
  const mealPlanForStay = (stayId: string, rows: StayGroupRequirement[]): QuoteBoard | 'all' => {
    const saved = mealPlanFilters[stayId];
    if (saved) return saved;
    const boards = new Set(rows.map((row) => row.board).filter((board) => board !== 'unknown'));
    return boards.size === 1 ? [...boards][0]! : 'all';
  };
  // Room names follow the type and count, so a rate or override always identifies the actual row.
  const rowLabels = new Map<string, string>();
  const roomLabel = (row: StayGroupRequirement): string => {
    if (paneConfig === undefined) return rowRoomLabel(row);
    const room = matchConfiguredRoomType([
      ...(row.roomCodes?.length === 1 ? row.roomCodes : []),
      row.roomPreference,
      row.roomTypeCode,
    ], paneRoomTypes, {
      allowCenturionRoomAliases: paneConfig?.propertyCode === HRCEN_PROPERTY_CODE,
    });
    const name = room?.label ?? 'Room type needed';
    const count = typeof row.quantity === 'number' && row.quantity > 0 ? row.quantity : '?';
    return `${name} ×${count}`;
  };
  stays.forEach((stay, stayIndex) =>
    stay.rows.forEach((row) =>
      rowLabels.set(row.id, stays.length > 1 ? `Stay ${stayIndex + 1} · ${roomLabel(row)}` : roomLabel(row)),
    ),
  );
  const running = Boolean(session.runningStepId) || Boolean(hmsQueue?.pending);
  const activeStep = session.steps.find((step) => step.id === session.runningStepId);
  const runningStayKey = activeStep?.shareKey ?? (running ? session.selectedStayKey : null);
  const stayReady =
    stays.length > 0 &&
    stays.every(
      (stay) =>
        stay.rows.length > 0 &&
        stay.rows.every(
          (row) => Boolean(row.arrivalDate && row.departureDate && row.quantity && row.adults),
        ),
    );
  const partyState =
    session.pendingPartyKinds?.length
      ? 'Looking up'
      : !header.company.trim() && !header.agency.trim()
      ? 'Optional'
      : header.parties?.company || header.parties?.agency
        ? 'Done'
        : 'Pending';
  const rateKeys = requestedQuoteKeys(session.groups);
  const ratesReady =
    session.offers.length > 0 ||
    (rateKeys.length > 0 && rateKeys.every((key) => Boolean(session.staffQuotes[key] ?? (session.selectedStayKey === key ? session.staffQuote : null))));
  const ratesState = running ? 'Looking up' : ratesReady ? 'Done' : 'Pending';
  const quoteState = session.pdf || session.reviewedReplyHtml.trim() ? 'Done' : 'Pending';
  const showRates = session.phase !== 'failed' && session.phase !== 'missing_source';
  /** The stay step a row belongs to. A re-run of that step prices the row. */
  const stepFor = (group: StayGroupRequirement) =>
    session.steps.find((item) => item.kind === 'quote_stay' && item.shareKey === stayKeyForGroup(group));
  // All returned codes stay visible under All rates; a plan filters cards, and the meal dropdown only highlights them.
  const rateGroups = session.groups.flatMap((group) => {
    const groupOptions = (session.rateOptions ?? []).filter(
      (option) => option.groupId === group.id && option.incomplete !== true,
    );
    const options = filteredRateOptions(groupOptions, ratePlan, ratePlans);
    if (!groupOptions.length) return [];
    const step = stepFor(group);
    const pinned = pinRun?.changes.find((change) => change.groupId === group.id);
    return [
      {
        group,
        options,
        step,
        blockReason: step ? quoteRunBlockReason(session, step) : 'Nothing is ready to search yet.',
        pendingRateCode:
          pinned?.check.rateCode ??
          (step !== undefined && session.runningStepId === step.id ? (group.rateCode ?? null) : null),
      },
    ];
  });
  const quotationTotal = allStaysDisplayTotal(session);
  /** Tapping a rate pins it on its group and re-runs that date option. Only a card whose run is not in flight can start one. */
  const pickRate = (option: RateOption) => {
    const group = session.groups.find((item) => item.id === option.groupId);
    if (!group || !onPatchGroup) return;
    const step = stepFor(group);
    if (!step || quoteRunBlockReason(session, step)) return;
    // A card is an HMS price, so it replaces the row's own price. Otherwise the run would charge a price the card does not show.
    onPatchGroup(group.id, {
      board: option.board,
      roomCodes: [option.roomCode],
      rateCode: option.rateCode,
      ...(group.rowPrice ? { rowPrice: undefined } : {}),
    });
    if (group.rowPrice) toast.warning(`${rowLabels.get(group.id) ?? 'The row'} is back on the HMS rate of the card you picked.`);
    setPinRun({ stepId: step.id, changes: [{ groupId: group.id, check: { rateCode: option.rateCode } }] });
  };
  /**
   * Sets the price on rows, then re-runs their stay so the totals follow. Only rows in one stay re-run together. Rows that
   * span stays are set but not re-run. Returns whether a re-run started.
   */
  const setRowPrices = (changes: { group: StayGroupRequirement; rowPrice: RowPriceChoice | undefined }[]): boolean => {
    if (!onPatchGroup || changes.length === 0) return false;
    const { session: current, pinRun: pending } = latest.current;
    for (const { group, rowPrice } of changes) onPatchGroup(group.id, { rowPrice });
    // A run in flight or another price waiting for its re-run keeps its turn. These rows wait for the next run.
    if (pending) return false;
    const steps = changes.map(({ group }) =>
      current.steps.find((item) => item.kind === 'quote_stay' && item.shareKey === stayKeyForGroup(group)),
    );
    const first = steps[0];
    if (first === undefined || steps.some((step) => step?.id !== first.id) || quoteRunBlockReason(current, first)) {
      return false;
    }
    setPinRun({
      stepId: first.id,
      changes: changes.map(({ group, rowPrice }) => ({ groupId: group.id, check: { rowPrice } })),
    });
    return true;
  };
  /** A saved rate was edited or archived. Rows priced from it follow: an archived rate sends them back to the HMS rate. */
  const followSavedRate = (rateId: string, next: SavedRate | null) => {
    // The rows as they are now: a row moved to another price while the edit was saving keeps that price.
    const affected = latest.current.session.groups.filter(
      (group) => group.rowPrice?.source === 'saved' && group.rowPrice.customRateId === rateId,
    );
    if (affected.length === 0) return;
    const rerun = setRowPrices(affected.map((group) => ({ group, rowPrice: next ? savedPrice(next) : undefined })));
    const many = affected.length > 1;
    const subject = many ? `${affected.length} rows that used this saved rate` : 'A row that used this saved rate';
    const verb = many ? 'are' : 'is';
    const outcome = next ? `${verb} now priced at the new amount` : `${verb} back on the HMS rate`;
    toast.warning(`${subject} ${outcome}.${rerun ? '' : ' Search availability to update the totals.'}`);
  };
  const requestStayRun = (stepId: string) => {
    if (session.runningStepId || hmsQueue?.pending || pinRun) {
      setQueuedStayRuns((current) =>
        current.some((item) => item.stepId === stepId && item.selectionEpoch === selectionEpoch)
          ? current
          : [...current, { stepId, selectionEpoch }],
      );
      return;
    }
    onRunStep?.(stepId);
  };
  const nextRateStep = session.steps.find(
    (step) => step.kind === 'quote_stay' && canRunQuoteStep(step, session.steps, session.runningStepId),
  );
  const nextRateStay = nextRateStep?.shareKey
    ? stays.find((stay) => stay.rows.some((group) => stayKeyForGroup(group) === nextRateStep.shareKey))
    : undefined;
  const nextRateReason = !showRates
    ? 'Wait for Nava to finish reading this email before searching.'
    : running
      ? 'An HMS search is already running. You can keep working.'
      : pinRun
        ? 'The rate change is still being saved before the next search.'
        : nextRateStep
          ? nextRateStay
            ? stayRatesBlockReason(session, nextRateStay.rows, nextRateStep) ??
              (!onRunStep && !onRunNext ? 'Search is not available in this view.' : null)
            : 'Add a date range before searching.'
          : rateKeys.length
            ? 'Every date range has results. Use a date-range action below to search again.'
            : 'Add a date range before searching.';
  const lunaMissing = session.analysis?.luna?.missing ?? [];
  const orderedMissing = lunaMissing
    .filter((item) => !missingQuestionAnswered(item.field, formGroups, header))
    .map((item, index) => ({ item, index, priority: missingQuestionPriority(item.field) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const hasPartyBlocker = orderedMissing.some(({ priority }) => priority === 0);
  const hasUnconfirmedParty = partyState === 'Pending' || partyState === 'Looking up';
  const missingStayDates = formGroups.length === 0 || formGroups.some((group) => !group.arrivalDate || !group.departureDate);
  const hasStayBlocker = orderedMissing.some(({ priority }) => priority === 2);
  const missingCandidates = orderedMissing.map(({ item, index, priority }) => ({ item, index, priority }));
  if (hasUnconfirmedParty && !hasPartyBlocker) {
    missingCandidates.push({
      item: { field: 'party', question: 'Confirm the company or agency in HMS before using a contract rate.' },
      index: -1,
      priority: 0,
    });
  }
  if (!stayReady && !hasStayBlocker) {
    missingCandidates.push({
      item: {
        field: missingStayDates ? 'arrivalDate' : 'stay',
        question: missingStayDates
          ? 'What arrival and departure dates should be quoted?'
          : 'What room types and guest details should be quoted?',
      },
      index: lunaMissing.length,
      priority: 2,
    });
  }
  const firstMissingAnswer = missingCandidates.sort(
    (left, right) => left.priority - right.priority || left.index - right.index,
  )[0]?.item;
  const currentAction: CurrentQuoteAction = firstMissingAnswer
    ? missingQuestionPriority(firstMissingAnswer.field) === 0
      ? { kind: 'scroll', targetId: 'quote-party', label: 'Review agency & company' }
      : missingQuestionPriority(firstMissingAnswer.field) === 1
        ? { kind: 'scroll', targetId: 'quote-rates', label: 'Choose rate plan' }
        : missingQuestionPriority(firstMissingAnswer.field) === 2
          ? {
              kind: 'scroll',
              targetId: 'quote-stay',
              label: missingStayDates ? 'Add stay dates' : 'Complete stay details',
            }
          : missingQuestionPriority(firstMissingAnswer.field) === 3
            ? { kind: 'search', label: 'Search availability' }
            : missingQuestionPriority(firstMissingAnswer.field) === 4
              ? { kind: 'scroll', targetId: 'quote-stay', label: 'Review extras in Stay' }
              : { kind: 'scroll', targetId: 'quote-quote', label: 'Review documents' }
    : ratesReady
      ? session.pdf
        ? { kind: 'scroll', targetId: 'quote-quote', label: 'Review documents' }
        : { kind: 'documents', label: isMultiStay(session) ? 'Prepare quote' : 'Prepare PDF' }
      : { kind: 'search', label: 'Search availability' };
  const canPreparePdfAtTop =
    currentAction.kind === 'documents' && !session.pdf && canCreatePdf(session);
  const makeQuoteBlockReason = makeQuote
    ? null
    : 'Make quote is not available for this mailbox.';
  const runNextRate = () => {
    if (!nextRateStep) return;
    if (nextRateStep.shareKey) onSelectStayKey?.(nextRateStep.shareKey);
    if (onRunStep) requestStayRun(nextRateStep.id);
    else onRunNext?.();
  };

  return (
    <div className="flex flex-col gap-3.5">
      {TELL_NAVA_ENABLED ? (
        <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
      ) : null}
      {session.phase === 'analysing' ? <StatusNote>{analysingCopy(session)}</StatusNote> : null}
      <PaneStatusLine session={session} />
      {session.analysis?.alternatives.length ? (
        <StatusNote>The email also mentions: {session.analysis.alternatives.join(', ')}. These are not quoted yet.</StatusNote>
      ) : null}
      {showWorkspace && (firstMissingAnswer || currentAction.kind !== 'documents' || canPreparePdfAtTop) ? (
        <div className="flex flex-col gap-2">
          {firstMissingAnswer || currentAction.kind !== 'documents' ? (
            <NeedsAnswerList missing={firstMissingAnswer ? [firstMissingAnswer] : undefined} />
          ) : null}
          {currentAction.kind !== 'documents' ? (
            <PrimaryButton
              disabled={Boolean(makeQuoteBlockReason) || (currentAction.kind === 'search' && nextRateReason !== null)}
              disabledReason={makeQuoteBlockReason ?? (currentAction.kind === 'search' ? nextRateReason : null)}
              onClick={() => {
                if (currentAction.kind === 'search') runNextRate();
                else if (currentAction.kind === 'scroll') scrollToStep(currentAction.targetId);
              }}
            >
              {currentAction.label}
            </PrimaryButton>
          ) : canPreparePdfAtTop ? (
            <PrimaryButton
              disabled={Boolean(makeQuoteBlockReason) || Boolean(pdfPending) || !canCreatePdf(session) || !onPreparePdf}
              disabledReason={
                makeQuoteBlockReason ??
                (pdfPending
                  ? 'Preparing PDF…'
                  : pdfBlockReason(session) ?? (!onPreparePdf ? 'PDF preparation is not available in this view.' : null))
              }
              onClick={onPreparePdf}
            >
              {pdfPending ? 'Preparing PDF…' : 'Make quote'}
            </PrimaryButton>
          ) : null}
        </div>
      ) : null}
      {showWorkspace ? (
        <QuotePeopleStep
          session={session}
          partyState={partyState}
          header={header}
          onPatchStaffHeader={onPatchStaffHeader}
          onFieldEdit={markPartyFieldEdited}
          findParty={findParty}
          partySuggestions={partySuggestions}
          partyIndex={partyIndex}
          partyJobTransport={partyJobTransport}
          onPartyLookupPending={onPartyLookupPending}
          scrollToStep={scrollToStep}
        />
      ) : null}
      {showWorkspace ? (
        <Section
          step={2}
          title="HMS notes"
          id="quote-authority"
          action={<StepState state={header.notes?.trim() ? 'Done' : 'Optional'} />}
        >
          <HmsNotesFields
            key={selectionEpoch}
            notesBlock={quoteNotesBlock(session, rowLabels, contact)}
            notes={header.notes ?? ''}
            onNotesChange={(value) => onPatchStaffHeader?.({ notes: value }, { staffEdit: true })}
          />
          <SecondaryButton className="w-full" onClick={() => scrollToStep('quote-stay')}>
            Continue to Stay
          </SecondaryButton>
        </Section>
      ) : null}
      {showWorkspace ? (
        <QuoteStayStep
          session={session}
          stays={stays}
          stayReady={stayReady}
          roomTotals={roomTotals}
          header={header}
          mealPlanForStay={mealPlanForStay}
          setMealPlanFilters={setMealPlanFilters}
          paneConfig={paneConfig}
          paneRoomTypes={paneRoomTypes}
          strictRoomTypes={strictRoomTypes}
          paneBoards={paneBoards}
          onPatchGroup={onPatchGroup}
          onStayAction={onStayAction}
          onPatchStayExtras={onPatchStayExtras}
          onSelectStayKey={onSelectStayKey}
        />
      ) : null}
      {showWorkspace ? (
        <Section step={4} title="Availability & rates" id="quote-rates" action={<StepState state={ratesState} />}>
          <RatePlanSelect
            ratePlans={ratePlans}
            ratePlan={ratePlan}
            onRatePlanChange={changeRatePlan}
          />
          {showRates ? (
            <h4 className="text-[13px] font-semibold text-[#475569]">Search availability & room rates</h4>
          ) : null}
          {currentAction.kind !== 'search' ? (
            <SecondaryButton
              className="w-full"
              disabled={Boolean(makeQuoteBlockReason) || nextRateReason !== null}
              disabledReason={makeQuoteBlockReason ?? nextRateReason}
              onClick={runNextRate}
            >
              Search availability
            </SecondaryButton>
          ) : null}
          {showRates ? (
            <>
              {stays.map((stay, stayIndex) => {
                const first = stay.rows[0];
                if (!first) return null;
                const stayKey = stayKeyForGroup(first);
                const step = stepFor(first);
                const reason = stayRatesBlockReason(session, stay.rows, step);
                const actionReason = reason ?? (!onRunStep && !onRunNext ? 'Search is not available in this view.' : null);
                const retryActionReason = reason ?? (!onRunStep ? 'Search is not available in this view.' : null);
                const loadingThisStay =
                  running && stayKey === runningStayKey;
                const pinRunningThisStay = pinRun?.stepId === step?.id;
                const queuedThisStay = queuedStayRuns.some(
                  (item) => item.stepId === step?.id && item.selectionEpoch === selectionEpoch,
                );
                const stayTotal = stayDisplayTotal(session, stayKey);
                // Each stay's Details lists only its own HMS search. The steps are session-wide, so the full list would repeat under every card.
                const stayRunSteps = session.steps.filter((item) => item.shareKey === stayKey);
                // Stays with the same dates share one HMS search and one total, so it is shown once, on the first of them.
                const sameDateStays = stays.flatMap((item, index) =>
                  item.rows[0] && stayKeyForGroup(item.rows[0]) === stayKey ? [index + 1] : [],
                );
                const countedInStay = sameDateStays.length > 1 && sameDateStays[0] !== stayIndex + 1 ? sameDateStays[0] : null;
                // This stay's own HMS result. The selected stay's result is also session.staffQuote.
                const selectedQuote = session.selectedStayKey === stayKey ? session.staffQuote : null;
                const stayQuote = session.staffQuotes[stayKey] ?? selectedQuote;
                const stayFound = Boolean(stayQuote);
                const preparedAt = stayQuote?.preparedAt ? new Date(stayQuote.preparedAt) : null;
                const preparedAtLabel = preparedAt && Number.isFinite(preparedAt.getTime())
                  ? preparedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                  : null;
                const stayBoard = stayQuote?.availabilityBoard ?? [];
                const contractChecked = confirmedPartyRead(header, stayFound);
                const comparisonRows = salesStrategies.map((strategy) => {
                  const row = quoteStrategyRows?.[stayKey]?.[strategy.code];
                  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].join(', ') || '—';
                  const room = row?.status === 'ready' ? unique(row.roomLabels) : '—';
                  const board = row?.status === 'ready' ? unique(row.boardLabels) : '—';
                  const nightly = row?.status === 'ready' ? unique(row.nightlyMinor.map(money)) : '—';
                  const status = row?.status === 'ready'
                    ? 'Rates found'
                    : row?.status === 'not_offered'
                      ? 'Not offered for these dates'
                      : row?.status === 'failed'
                        ? 'Search failed'
                        : row?.status === 'pending'
                          ? 'Searching…'
                          : 'Not checked';
                  return { strategy, row, room, board, nightly, status };
                });
                const comparisonsComplete = comparisonRows.length > 0 && comparisonRows.every(({ row }) =>
                  row?.status === 'ready' || row?.status === 'not_offered' || row?.status === 'failed',
                );
                return (
                  <article key={`${stay.id}-search`} className="flex flex-col gap-3 rounded-[4px] border border-[#cbd5e1] bg-white p-3">
                    {stayQuote?.preparedByNava ? (
                      <p className="text-[12px] font-semibold text-[#475569]">
                        Prepared by Nava{preparedAtLabel ? ` · ${preparedAtLabel}` : ''}
                      </p>
                    ) : null}
                    <div className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-[13px] font-bold text-[#1e293b]">Availability for this date range</h4>
                        {stayFound ? (
                          <span className="rounded-full bg-[#eaf4ee] px-2 py-0.5 text-[11px] font-bold text-[#1a4332]">
                            Available
                          </span>
                        ) : null}
                      </div>
                      <p className="text-[13px] text-[#64748b]">Separate HMS booking · one availability search for these dates.</p>
                    </div>
                    {step?.status === 'succeeded' ? (
                      <>
                        <SecondaryButton
                          className="w-full"
                          disabled={loadingThisStay || queuedThisStay}
                          disabledReason={
                            loadingThisStay
                              ? 'A search is running for this stay.'
                              : queuedThisStay
                                ? 'Waiting for the earlier search to finish.'
                                : null
                          }
                          onClick={() => {
                            onSelectStayKey?.(stayKey);
                            if (step && onRunStep) requestStayRun(step.id);
                            else toast.warning(retryActionReason ?? 'Search is not available in this view.');
                          }}
                        >
                          {`Search this date range for Stay ${stayIndex + 1}`}
                        </SecondaryButton>
                        {queuedThisStay ? <p role="status">Search queued until the current stay finishes.</p> : null}
                        {retryActionReason ? <p className="text-[13px] text-[#334155]">{retryActionReason}</p> : null}
                      </>
                    ) : (
                      <>
                        <SecondaryButton
                          className="w-full"
                          onClick={() => {
                            onSelectStayKey?.(stayKey);
                            if (step && onRunStep) requestStayRun(step.id);
                            else onRunNext?.();
                          }}
                          disabled={actionReason !== null || loadingThisStay || queuedThisStay}
                          disabledReason={
                            loadingThisStay
                              ? 'Looking up in HMS — you can keep working.'
                              : queuedThisStay
                                ? 'Waiting for the earlier search to finish.'
                                : actionReason
                          }
                        >
                          {step?.status === 'failed'
                            ? `Retry date range for Stay ${stayIndex + 1}`
                            : `Search this date range for Stay ${stayIndex + 1}`}
                        </SecondaryButton>
                        {queuedThisStay ? <p role="status">Search queued until the current stay finishes.</p> : null}
                        {step?.status === 'failed' && !failedRatesNotice ? (
                          <p className="text-[13px] text-[#334155]">
                            HMS could not complete this search. Retry the date range.
                          </p>
                        ) : null}
                      </>
                    )}
                    {stayRunSteps.length ? (
                      <details className="text-[13px] text-[#64748b]">
                        <summary className="w-fit cursor-pointer font-semibold text-[#0066cc]">Details</summary>
                        <div className="mt-2 rounded-[3px] border border-[#e2e8f0] bg-[#f8fafc] p-2">
                          <ToolStepList
                            steps={stayRunSteps}
                            runningStepId={session.runningStepId}
                            onRunStep={onRunStep}
                            blockReason={(item) => quoteRunBlockReason(session, item)}
                          />
                        </div>
                      </details>
                    ) : null}
                    {comparisonRows.length ? (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-[12px]" aria-label="Quote strategy comparison">
                          <thead>
                            <tr className="border-b border-[#e2e8f0] text-left text-[#475569]">
                              <th scope="col" className="p-1.5">Code</th>
                              <th scope="col" className="p-1.5">Strategy</th>
                              <th scope="col" className="p-1.5">Room</th>
                              <th scope="col" className="p-1.5">Board</th>
                              <th scope="col" className="p-1.5">Nightly</th>
                              <th scope="col" className="p-1.5">Total</th>
                              <th scope="col" className="p-1.5">Status</th>
                              <th scope="col" className="p-1.5">Staff choice</th>
                            </tr>
                          </thead>
                          <tbody>
                            {comparisonRows.map(({ strategy, row, room, board, nightly, status }) => (
                              <tr key={strategy.code} className="border-b border-[#e2e8f0] align-top">
                                <td className="p-1.5 font-semibold">{strategy.code}</td>
                                <td className="p-1.5">{strategy.label}</td>
                                <td className="p-1.5">{room}</td>
                                <td className="p-1.5">{board}</td>
                                <td className="p-1.5">{nightly}</td>
                                <td className="p-1.5">{row?.status === 'ready' ? money(row.totalMinor) : '—'}</td>
                                <td className="p-1.5" title={row && 'message' in row ? row.message : undefined}>{status}</td>
                                <td className="p-1.5">
                                  {row?.status === 'ready' ? (
                                    <SecondaryButton
                                      className="w-auto"
                                      disabled={!onSelectQuoteStrategy || !comparisonsComplete || loadingThisStay || queuedThisStay}
                                      disabledReason={
                                        loadingThisStay
                                          ? 'A search is running for this stay.'
                                          : queuedThisStay
                                            ? 'A search is queued for this stay.'
                                            : !onSelectQuoteStrategy
                                              ? 'Strategy selection is part of the bind/session follow-up.'
                                              : !comparisonsComplete
                                                ? 'Wait for each strategy search to finish before choosing a rate.'
                                                : null
                                      }
                                      onClick={() => onSelectQuoteStrategy?.(stayKey, strategy.code)}
                                    >
                                      {`Use ${strategy.label} (${strategy.code}) rates`}
                                    </SecondaryButton>
                                  ) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {stayQuote?.availabilityTruncated === true ? (
                      <p className="text-[12px] text-[#64748b]">More room options exist than this grid shows.</p>
                    ) : null}
                    {stay.rows.map((group) => {
                      const rateGroup = rateGroups.find((item) => item.group.id === group.id);
                      const rowStep = stepFor(group);
                      const alternatives = rowStep?.roomAlternatives?.filter((alternative) => alternative.groupId === group.id) ?? [];
                      const rowPinRunning = pinRun?.stepId === rowStep?.id;
                      const rowRate = session.staffQuotes[stayKeyForGroup(group)]?.rowRates?.find(
                        (item) => item.groupId === group.id,
                      );
                      const priceRunning =
                        pinRun?.changes.some((change) => change.groupId === group.id) === true ||
                        (rowStep !== undefined && session.runningStepId === rowStep.id);
                      const pendingCode = rateGroup?.pendingRateCode ?? null;
                      const cardHostsControls =
                        rateGroup?.options.some((option) => (pendingCode !== null ? option.rateCode === pendingCode : option.selected)) === true;
                      // With no card selected (none returned, or the saved rate left the list), the controls sit under the
                      // section, so a saved price can still be changed or removed.
                      const rowControlsHostedBelow =
                        !cardHostsControls && (Boolean(rateGroup?.options.length) || group.rowPrice !== undefined || rowRate !== undefined);
                      const rowControls = (
                        <div className="border-t border-[#dce8df] bg-white p-2.5">
                          <RowRateControls
                            group={group}
                            label={rowLabels.get(group.id) ?? 'Room type needed'}
                            toggleLabel="Special price"
                            rowRate={rowRate}
                            saved={saved}
                            pending={priceRunning}
                            busy={loadingThisStay || pinRunningThisStay}
                            blockReason={rowStep ? quoteRunBlockReason(session, rowStep) : 'Search availability first.'}
                            onSetPrice={(rowPrice) => setRowPrices([{ group, rowPrice }])}
                            overrideRateCodes={overrideRateCodes}
                            eventRateCodes={eventRateCodes}
                            onSavedRateChanged={followSavedRate}
                          />
                        </div>
                      );
                      const draftRateCode = Object.values(session.bookingDrafts)
                        .flatMap((draft) => draft.draft.rooms)
                        .find((room) => room.groupId === group.id)?.request.ratePlan;
                      const rateCode =
                        group.rateCode ||
                        group.quotedRateCode ||
                        (typeof draftRateCode === 'string' ? draftRateCode : '');
                      return (
                        <div key={group.id} className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2.5">
                          <h5 className="text-[13px] font-semibold text-[#475569]">{`${rowLabels.get(group.id) ?? 'Room type needed'} rates`}</h5>
                          <Field label="Rate code" htmlFor={`rate-code-${group.id}`}>
                            <input
                              key={`${group.id}:${rateCode}`}
                              id={`rate-code-${group.id}`}
                              aria-label="Rate code"
                              className={paneFieldClass}
                              maxLength={10}
                              disabled={!onPatchGroup || loadingThisStay || pinRunningThisStay}
                              defaultValue={rateCode}
                              onBlur={(event) => {
                                const value = event.currentTarget.value.trim().toUpperCase();
                                event.currentTarget.value = value;
                                if (value === rateCode.trim().toUpperCase()) return;
                                onPatchGroup?.(group.id, { rateCode: value || undefined });
                              }}
                            />
                          </Field>
                          <RatesBarGrid
                            cells={projectBarGrid(stayBoard.filter((row) => row.groupId === group.id))}
                            contractChecked={contractChecked}
                            plans={ratePlans}
                          />
                          {rateGroup?.options.length ? (
                            <RateCards
                              options={rateGroup.options}
                              partyName={contractPartyName(header)}
                              disabled={loadingThisStay || pinRunningThisStay || rateGroup.blockReason !== null}
                              pendingRateCode={rateGroup.pendingRateCode}
                              preferredBoard={mealPlanForStay(stay.id, stay.rows)}
                              selectedControls={cardHostsControls ? rowControls : undefined}
                              onPick={pickRate}
                            />
                          ) : session.rateOptions?.some(
                              (option) => option.groupId === group.id && option.incomplete !== true,
                            ) ? (
                            <p className="text-[13px] text-[#64748b]">No rates match this filter. Choose All rates to show every HMS code.</p>
                          ) : null}
                          {alternatives.map((alternative) => (
                            <div
                              key={`${alternative.roomCode}:${alternative.quantity}`}
                              role="group"
                              aria-label={`Alternative room for ${rowLabels.get(group.id) ?? 'room type needed'}`}
                              className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e2e8f0] pt-2"
                            >
                              <p className="text-[13px] text-[#334155]">
                                Not available — instead: {alternative.roomLabel} × {alternative.quantity}
                              </p>
                              <SecondaryButton
                                className="min-h-11 w-auto"
                                disabled={loadingThisStay || rowPinRunning || !onPatchGroup}
                                onClick={() => {
                                  if (!onPatchGroup || !rowStep) return;
                                  const check = {
                                    roomCodes: [alternative.roomCode],
                                    roomPreference: alternative.roomLabel,
                                    roomTypeSuggestions: [],
                                    quantity: alternative.quantity,
                                    ...(group.rateCode ? { rateCode: group.rateCode } : {}),
                                    rowPrice: undefined,
                                  } satisfies Partial<StayGroupRequirement>;
                                  onPatchGroup(group.id, check);
                                  setPinRun({ stepId: rowStep.id, changes: [{ groupId: group.id, check }] });
                                }}
                              >
                                Use this
                              </SecondaryButton>
                            </div>
                          ))}
                          {rowControlsHostedBelow ? rowControls : null}
                        </div>
                      );
                    })}
                    <div className="stay-subtotal flex items-center justify-between gap-2 border-t border-[#e2e8f0] pt-2 text-[13px]">
                      <span className="font-semibold text-[#475569]">Stay subtotal</span>
                      <span className="font-bold text-[#1e293b]">
                        {countedInStay !== null
                          ? `Counted in Stay ${countedInStay}`
                          : stayTotal === null
                            ? 'Search availability to calculate'
                            : sameDateStays.length > 1
                              ? `${money(stayTotal)} for Stays ${sameDateStays.join(', ')}`
                              : money(stayTotal)}
                      </span>
                    </div>
                  </article>
                );
              })}
              {running ? (
                <HmsQueueStatusLine
                  pending={running}
                  status={hmsQueue?.status ?? null}
                  staffQuote={Boolean(hmsQueue?.pending)}
                />
              ) : null}
            </>
          ) : null}
          {!showRates ? <p className="text-[13px] text-[#64748b]">Rates will appear when the email details are ready to search.</p> : null}
          {session.offers.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold text-[#475569]">HMS results and evidence</h3>
              <p className="text-[13px] text-[#64748b]">
                Selected rates total {money(allocationTotal(session.offers.filter((o) => session.selectedOfferIds.includes(o.id))))}.
                Alternatives are not added to this total.
                {new Set(session.offers.filter((o) => o.kind === 'allocation').map((o) => o.quoteRequestKey)).size > 1
                  ? ' Every date range is quoted separately, then included in one quotation.'
                  : ''}
              </p>
              {session.offers.map((offer) => {
                const candidate = session.staffQuotes[offer.quoteRequestKey] ?? session.staffQuote;
                const staffQuote = candidate?.revisionRef === offer.id ? candidate : null;
                return (
                  <Fragment key={offer.id}>
                    <OfferCard
                      offer={offer}
                      selected={session.selectedOfferIds.includes(offer.id)}
                      onSelect={onSelectOffer}
                      showShot={!staffQuote}
                    />
                    {staffQuote ? (
                      <QuoteAuditScreenshot
                        key={staffQuote.runId ?? staffQuote.revisionRef}
                        runId={staffQuote.runId ?? null}
                        screenshots={staffQuote.screenshots ?? []}
                        loadScreenshot={onLoadRunScreenshot}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          ) : null}
          {showRates ? (
            <div aria-label="Quotation total" className="flex flex-col gap-1 rounded-[4px] border border-[#cbd5e1] bg-[#f8fafc] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-bold text-[#1e293b]">Quotation total (all stays)</h3>
                <span className="text-[14px] font-extrabold text-[#1e293b]">
                  {quotationTotal.total === null ? 'Not ready' : money(quotationTotal.total)}
                </span>
              </div>
              {quotationTotal.total === null ? (
                <p className="text-[13px] text-[#64748b]">
                  {quotationTotal.stays
                    ? `${quotationTotal.rated} of ${quotationTotal.stays} stays rated. Search each date range for the complete total.`
                    : 'Add a date range and search availability to see the total.'}
                </p>
              ) : (
                <p className="text-[13px] text-[#64748b]">Extras are shown as their own lines in the quotation PDF.</p>
              )}
            </div>
          ) : null}
        </Section>
      ) : null}
      {showWorkspace ? (
        <QuoteDocumentsStep
          session={session}
          showReply={showReply}
          currentAction={currentAction}
          quoteState={quoteState}
          onReplyChange={onReplyChange}
          onPreparePdf={onPreparePdf}
          onDownloadWorkbook={onDownloadWorkbook}
          workbookPending={workbookPending}
          pdfPending={pdfPending}
          replyContent={replyContent}
        />
      ) : replyContent ? (
        <div className="flex flex-col gap-2.5">{replyContent}</div>
      ) : null}
      {showWorkspace ? (
        <>
          <HmsTodoCard card={hmsTodoCard} />
          <NotSupportedList
            flags={session.analysis?.luna?.flags}
            tasks={session.analysis?.luna?.tasks}
            amendment={amendment}
            unreadFiles={hasUnreadFiles}
          />
          <ItemsForYou
            openItems={openItems}
            handledItems={handledItems}
            onViewSource={onViewSource}
            onEditReply={onEditReply}
            onHandle={onHandleReviewItem}
            onUndo={onUndoReviewItem}
            onRetry={onRetryRead}
          />
        </>
      ) : null}
      {requestedQuoteKeys(session.groups)
        .filter((key) => session.bookingDrafts[key])
        .map((key) => (
          <Fragment key={key}>
            {isMultiStay(session) ? (
              <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p>
            ) : null}
            <BookingCards
              draft={session.bookingDrafts[key]!}
              groups={session.groups}
              paneSave={paneSave}
              contact={contact}
              parties={session.staffHeader.parties}
            />
          </Fragment>
        ))}
    </div>
  );
}
