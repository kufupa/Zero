import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  allocationTotal,
  amendmentOf,
  canCreatePdf,
  canRunQuoteStep,
  currentStayRun,
  draftStayGroup,
  groupStays,
  isMultiStay,
  newQuoteToken,
  partyLookupWaitReason,
  quoteRunBlockReason,
  requestedQuoteKeys,
  rowRoomCode,
  stayKeyForGroup,
  staffSourceReady,
  stayTotals,
} from '@/lib/quote-workflow/session';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { EXTRA_AMOUNT_FORMAT_MESSAGE, parseCountInput, parseZarInput } from '@/lib/quote-workflow/zar-input';
import { emptyStaffQuoteHeader, staffStayExtrasFor } from '@/lib/quote-workflow/types';
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
  StaffExtraField,
  StaffQuoteOtherUnit,
  StaffStayExtras,
  DinnerAddOnUnit,
  StayEditAction,
  StayGroupRequirement,
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
import { PartyPicker } from './party-picker';
import { DocumentReview } from './document-review';
import { useFailedHmsJobNoticeMessage } from './hms-job-notices';
import { HmsQueueStatusLine } from './hms-queue-status';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { PaneStatusLine } from './pane-status-line';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import { RateCards } from './rate-cards';
import {
  CopyHmsNotesButton,
  hmsNotesBlock,
  RowRateControls,
  savedPrice,
  useSavedRates,
  type SavedRate,
  type SavedRatesClient,
} from './rate-controls';
import { StayCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import { WorkflowBadge, type QuoteIntent } from './workflow-badge';
import { rowRoomLabel, rowRoomTypeCode } from '@/lib/quote-workflow/room-types';

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

function formatZarMinor(minor: number | undefined): string {
  return minor !== undefined && minor > 0 ? (minor / 100).toFixed(2).replace(/\.00$/, '') : '';
}

/**
 * A rand amount typed by staff. Text that cannot be read, or an amount over the cap, stays on screen with an
 * inline message and is reported to the quote gate. The saved amount is not changed by it.
 */
function ZarMinorInput({
  ariaLabel,
  minor,
  disabled = false,
  onMinorChange,
  onErrorChange,
}: {
  ariaLabel: string;
  minor: number | undefined;
  disabled?: boolean;
  onMinorChange: (minor: number | undefined) => void;
  /** Reports unreadable or over-cap text to the quote gate; null once the text reads cleanly. */
  onErrorChange?: (message: string | null) => void;
}) {
  const formatted = formatZarMinor(minor);
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = (message: string | null) => {
    setError(message);
    onErrorChange?.(message);
  };
  useEffect(() => {
    if (!focused && !error) setDraft(formatted);
  }, [formatted, focused, error]);
  const apply = (raw: string) => {
    const result = parseZarInput(raw);
    if (result.status === 'ok') {
      report(null);
      onMinorChange(result.minor);
    } else if (result.status === 'empty') {
      report(null);
      onMinorChange(undefined);
    } else {
      report(result.status === 'partial' ? EXTRA_AMOUNT_FORMAT_MESSAGE : result.message);
    }
  };
  return (
    <>
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={paneFieldClass}
        inputMode="decimal"
        value={focused || error ? draft : formatted}
        onFocus={() => {
          setDraft(formatted);
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          apply(draft.replace(/\.$/, ''));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          apply(event.target.value);
        }}
      />
      {error ? <span className="mt-0.5 block text-[13px] font-normal text-[#b45309]">{error}</span> : null}
    </>
  );
}

/** A whole number of trips or days, up to max. Anything else is reported to the quote gate and not saved. */
function CountInput({
  ariaLabel,
  value,
  max,
  placeholder,
  onValueChange,
  onErrorChange,
}: {
  ariaLabel: string;
  value: number | undefined;
  max: number;
  placeholder?: string;
  onValueChange: (value: number | undefined) => void;
  onErrorChange?: (message: string | null) => void;
}) {
  const formatted = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = (message: string | null) => {
    setError(message);
    onErrorChange?.(message);
  };
  useEffect(() => {
    if (!focused && !error) setDraft(formatted);
  }, [formatted, focused, error]);
  const apply = (raw: string) => {
    const result = parseCountInput(raw, max);
    if (result.status === 'ok') {
      report(null);
      onValueChange(result.count);
    } else if (result.status === 'empty') {
      report(null);
      onValueChange(undefined);
    } else {
      report(result.message);
    }
  };
  return (
    <>
      <input
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        className={paneFieldClass}
        inputMode="numeric"
        placeholder={placeholder}
        value={focused || error ? draft : formatted}
        onFocus={() => {
          setDraft(formatted);
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          apply(draft);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          apply(event.target.value);
        }}
      />
      {error ? <span className="mt-0.5 block text-[13px] font-normal text-[#b45309]">{error}</span> : null}
    </>
  );
}

function withoutFieldErrors(
  errors: Partial<Record<StaffExtraField, string>> | undefined,
  fields: StaffExtraField[],
): Partial<Record<StaffExtraField, string>> {
  const kept = { ...errors };
  for (const field of fields) delete kept[field];
  return kept;
}

/** Editing a field away from its picked name drops that pick, so the quote never sends a party the text no longer names. */
function pickClearedBy(kind: 'company' | 'agency', header: StaffQuoteHeader, text: string): Partial<StaffQuoteHeader> {
  const picked = header.parties?.[kind];
  if (!picked || text === picked.name) return {};
  return { parties: { ...header.parties, [kind]: undefined } };
}

type RatePlanCategory = 'public' | 'contract' | 'government' | 'other';
type RatePlanChoice = RatePlanCatalogueEntry & { category: RatePlanCategory };

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

/** Add HMS-only codes without treating their labels or flags as static catalogue facts. */
function ratePlanChoices(
  catalogue: readonly RatePlanCatalogueEntry[],
  hmsOptions: readonly RateOption[],
): RatePlanChoice[] {
  const choices = new Map<string, RatePlanChoice>();
  for (const entry of catalogue) {
    const code = entry.code.trim().toUpperCase();
    if (code) choices.set(code, { ...entry, code, category: ratePlanCategory(entry) });
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
function StaffPartyFields({
  header,
  onPatch,
  onFieldEdit,
  findParty,
  partySuggestions,
  partyIndex,
  partyJobTransport,
  threadId,
  sourceMessageId,
  onPartyLookupPending,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
  onFieldEdit?: (kind: 'company' | 'agency') => void;
  /** Find in HMS. Null or absent keeps the company and agency as plain text, as before. */
  findParty?: PartyFinder | null;
  /** Suggestions from the email, for staff to confirm. The pane computes them; nothing is picked by itself. */
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  threadId?: string | null;
  sourceMessageId?: string | null;
  /** Tells the pane whether a field's automatic HMS search still decides its pick, so a rates run waits for it. */
  onPartyLookupPending?: (kind: 'company' | 'agency', pending: boolean) => void;
}) {
  // Each field's picker searches that field's own text and holds only that kind: its results, its pick and its suggestions.
  // HOOK(#84, not on main): the HMS typeahead's onSearchName lands on the onSearchName prop below.
  const partyPicker = (kind: 'company' | 'agency') =>
    findParty ? (
      <PartyPicker
        autoLookup
        kind={kind}
        name={kind === 'company' ? header.company : header.agency}
        parties={header.parties ?? {}}
        find={findParty}
        jobTransport={partyJobTransport}
        threadId={threadId}
        sourceMessageId={sourceMessageId}
        suggestions={partySuggestions}
        indexSearch={partyIndex}
        onLookupPending={(pending) => onPartyLookupPending?.(kind, pending)}
        onPick={(party) => {
          onFieldEdit?.(kind);
          return onPatch?.({
            parties:
              party.kind === 'company'
                ? { ...header.parties, company: party }
                : { ...header.parties, agency: party },
            ...(party.kind === 'company' ? { company: party.name } : { agency: party.name }),
          });
        }}
        onClear={(cleared) => {
          onFieldEdit?.(cleared);
          return onPatch?.({
            parties:
              cleared === 'company'
                ? { ...header.parties, company: undefined }
                : { ...header.parties, agency: undefined },
          });
        }}
        onSearchName={(searched, searchKind) => {
          onFieldEdit?.(searchKind);
          return onPatch?.(searchKind === 'company' ? { company: searched } : { agency: searched });
        }}
      />
    ) : null;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[13px] text-[#64748b]">
        Optional if none in email. Company is the end client; Agency is the travel agent. Confirm an HMS result before using its contract rate.
      </p>
      <Field label="Agency (travel agent)" htmlFor="quote-agency">
        <input
          id="quote-agency"
          aria-label="Agency (travel agent)"
          className={paneFieldClass}
          value={header.agency}
          onChange={(event) => {
            onFieldEdit?.('agency');
            onPatch?.({ agency: event.target.value, ...pickClearedBy('agency', header, event.target.value) });
          }}
        />
        {partyPicker('agency')}
        {header.parties?.agency ? (
          <span className="w-fit rounded-[2px] bg-[#eff6ff] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#0066cc]">HMS agency contract selected</span>
        ) : null}
      </Field>
      <Field label="Company (end client)" htmlFor="quote-company">
        <input
          id="quote-company"
          aria-label="Company (end client)"
          className={paneFieldClass}
          value={header.company}
          onChange={(event) => {
            onFieldEdit?.('company');
            onPatch?.({ company: event.target.value, ...pickClearedBy('company', header, event.target.value) });
          }}
        />
        {partyPicker('company')}
        {header.parties?.company ? (
          <span className="w-fit rounded-[2px] bg-[#eff6ff] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#0066cc]">HMS company contract selected</span>
        ) : null}
      </Field>
      {/* The client block on the quote and the HMS booking. Typed by staff; nothing fills these from the email. */}
      <Field label="Attention" htmlFor="quote-attention">
        <input
          id="quote-attention"
          aria-label="Attention"
          className={paneFieldClass}
          value={header.attention}
          onChange={(event) => onPatch?.({ attention: event.target.value })}
        />
      </Field>
      <Field label="Client email" htmlFor="quote-client-email">
        <input
          id="quote-client-email"
          aria-label="Client email"
          className={paneFieldClass}
          value={header.clientEmail}
          onChange={(event) => onPatch?.({ clientEmail: event.target.value })}
        />
      </Field>
      <Field label="Client telephone" htmlFor="quote-client-telephone">
        <input
          id="quote-client-telephone"
          aria-label="Client telephone"
          className={paneFieldClass}
          value={header.clientTelephone}
          onChange={(event) => onPatch?.({ clientTelephone: event.target.value })}
        />
      </Field>
    </div>
  );
}

/** Reports one stay extra's unreadable value without treating validation as a quote edit. */
function stayFieldErrorReporter(
  extras: StaffStayExtras,
  onPatch: ((stayKey: string, extras: Partial<StaffStayExtras>) => void) | undefined,
  stayKey: string,
  field: StaffExtraField,
) {
  return (message: string | null) => {
    const current = extras.fieldErrors ?? {};
    if ((current[field] ?? null) === message) return;
    const next: Partial<Record<StaffExtraField, string>> = { ...current };
    if (message) next[field] = message;
    else delete next[field];
    onPatch?.(stayKey, { fieldErrors: next });
  };
}

function StayExtrasFields({
  header,
  stayKey,
  stayNumber,
  onPatch,
}: {
  header: StaffQuoteHeader;
  stayKey: string;
  stayNumber: number;
  onPatch?: (stayKey: string, extras: Partial<StaffStayExtras>) => void;
}) {
  const extras = staffStayExtrasFor(header, stayKey);
  const patch = (values: Partial<StaffStayExtras>) => onPatch?.(stayKey, values);
  const clearedErrors = (...fields: StaffExtraField[]) => withoutFieldErrors(extras.fieldErrors, fields);
  const otherNeedsLabel = Boolean(extras.otherEnabled && extras.other?.amountMinor) && !extras.other?.label?.trim();
  const chargeLine = (
    label: 'Shuttle' | 'Lunch allowance' | 'Dinner allowance' | 'Other',
    enabled: boolean,
    onEnabled: (checked: boolean) => void,
    amountLabel: string,
    amount: number | undefined,
    onAmountChange: (minor: number | undefined) => void,
    errorField: StaffExtraField,
    required = false,
  ) => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-x-2 gap-y-1.5 border-t border-[#e2e8f0] pt-2 first:border-t-0 first:pt-0">
      <label className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[#475569]">
        <input
          type="checkbox"
          aria-label={label}
          checked={enabled}
          disabled={required}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <ZarMinorInput
        ariaLabel={amountLabel}
        minor={amount}
        disabled={!enabled}
        onMinorChange={onAmountChange}
        onErrorChange={stayFieldErrorReporter(extras, onPatch, stayKey, errorField)}
      />
      {label === 'Shuttle' && enabled ? (
        <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
          <span>Trips</span>
          <CountInput
            ariaLabel="Shuttle trips"
            value={extras.shuttleTrips}
            max={50}
            placeholder="1"
            onValueChange={(shuttleTrips) => patch({ shuttleTrips })}
            onErrorChange={stayFieldErrorReporter(extras, onPatch, stayKey, 'shuttleTrips')}
          />
        </label>
      ) : null}
      {label === 'Lunch allowance' && enabled ? (
        <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
          <span>Note (optional)</span>
          <input
            aria-label="Lunch label"
            className={paneFieldClass}
            maxLength={120}
            value={extras.lunchAllowanceLabel ?? ''}
            onChange={(event) => patch({ lunchAllowanceLabel: event.target.value })}
          />
        </label>
      ) : null}
      {label === 'Dinner allowance' && enabled ? (
        <>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Charging unit</span>
            <select
              aria-label="Dinner add-on unit"
              className={paneFieldClass}
              value={extras.dinnerAllowanceUnit ?? ''}
              onChange={(event) => patch({ dinnerAllowanceUnit: event.target.value as DinnerAddOnUnit | undefined })}
            >
              <option value="">Choose a unit</option>
              <option value="per_person_per_night">Per person per night</option>
              <option value="per_room_per_night">Per room per night</option>
              <option value="per_person">Per person</option>
            </select>
          </label>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Label (optional)</span>
            <input
              aria-label="Dinner label"
              className={paneFieldClass}
              maxLength={120}
              value={extras.dinnerAllowanceLabel ?? ''}
              onChange={(event) => patch({ dinnerAllowanceLabel: event.target.value })}
            />
          </label>
        </>
      ) : null}
      {label === 'Other' ? (
        <>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Label</span>
            <input
              aria-label="Other label"
              aria-invalid={otherNeedsLabel || undefined}
              className={paneFieldClass}
              disabled={!enabled}
              maxLength={120}
              placeholder="e.g. Parking"
              value={extras.other?.label ?? ''}
              onChange={(event) =>
                patch({ other: { unit: extras.other?.unit ?? 'item', ...extras.other, label: event.target.value } })
              }
            />
          </label>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Unit</span>
            <select
              aria-label="Other unit"
              className={paneFieldClass}
              disabled={!enabled}
              value={extras.other?.unit ?? 'item'}
              onChange={(event) =>
                patch({
                  other: {
                    label: extras.other?.label ?? '',
                    amountMinor: extras.other?.amountMinor,
                    unit: event.target.value as StaffQuoteOtherUnit,
                  },
                })
              }
            >
              <option value="per_person_night">R per person per night</option>
              <option value="per_person">R per person</option>
              <option value="per_trip">R per trip</option>
              <option value="item">R once (item)</option>
            </select>
          </label>
          {otherNeedsLabel ? <p className="col-span-2 text-[13px] text-[#b45309]">Add a label for this amount.</p> : null}
        </>
      ) : null}
      {label === 'Dinner allowance' && required ? (
        <p className="col-span-2 text-[13px] text-[#475569]">
          {!(amount && amount > 0)
            ? 'Dinner price — enter amount'
            : !extras.dinnerAllowanceUnit
              ? 'Choose how the dinner price is charged.'
              : 'Run Get rates again to apply the dinner price before documents can be made.'}
        </p>
      ) : null}
    </div>
  );

  return (
    <section role="group" aria-label={`Extras for Stay ${stayNumber}`} className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">Extras</h5>
      {chargeLine(
        'Shuttle',
        extras.shuttleEnabled,
        (shuttleEnabled) =>
          patch({ shuttleEnabled, ...(!shuttleEnabled ? { fieldErrors: clearedErrors('shuttleAmount', 'shuttleTrips') } : {}) }),
        'Shuttle amount',
        extras.shuttleMinor,
        (shuttleMinor) => patch({ shuttleMinor }),
        'shuttleAmount',
      )}
      {chargeLine(
        'Lunch allowance',
        extras.lunchEnabled,
        (lunchEnabled) => patch({ lunchEnabled, ...(!lunchEnabled ? { fieldErrors: clearedErrors('lunchAllowance') } : {}) }),
        'Lunch allowance amount',
        extras.lunchAllowanceMinor,
        (lunchAllowanceMinor) => patch({ lunchAllowanceMinor }),
        'lunchAllowance',
      )}
      {chargeLine(
        'Dinner allowance',
        extras.dinnerEnabled,
        (dinnerEnabled) => patch({ dinnerEnabled, ...(!dinnerEnabled ? { fieldErrors: clearedErrors('dinnerAllowance') } : {}) }),
        'Dinner allowance amount',
        extras.dinnerAllowanceMinor,
        (dinnerAllowanceMinor) => patch({ dinnerAllowanceMinor }),
        'dinnerAllowance',
        Boolean(extras.dinnerAllowanceRequired),
      )}
      {chargeLine(
        'Other',
        extras.otherEnabled,
        (otherEnabled) => patch({ otherEnabled, ...(!otherEnabled ? { fieldErrors: clearedErrors('otherAmount') } : {}) }),
        'Other amount',
        extras.other?.amountMinor,
        (amountMinor) => patch({ other: { label: extras.other?.label ?? '', unit: extras.other?.unit ?? 'item', amountMinor } }),
        'otherAmount',
      )}
    </section>
  );
}

function RatePlanFields({
  ratePlans,
  ratePlan,
  onRatePlanChange,
  notesBlock,
  notes,
  onNotesChange,
}: {
  ratePlans: RatePlanChoice[];
  ratePlan: string;
  onRatePlanChange: (value: string) => void;
  notesBlock: string;
  /** The staff note for HMS, stored on the quote header so it survives the pane and goes to the booking. */
  notes: string;
  onNotesChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Rate plan" htmlFor="quote-rate-plan">
        <select
          id="quote-rate-plan"
          aria-label="Rate plan"
          className={paneFieldClass}
          value={ratePlan}
          onChange={(event) => onRatePlanChange(event.target.value)}
        >
          <option value="all">All rates</option>
          {(['public', 'contract', 'government', 'other'] as const).map((category) => {
            const plans = ratePlans.filter((entry) => entry.category === category);
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

/** The type Nava reads the email as: the staff pick first, then the analysis. Other when it is not a quote or booking. */
function intentOf(session: QuoteSession): QuoteIntent | null {
  if (session.phase === 'non_quote') return 'other';
  if (session.treatAs) return session.treatAs;
  return session.analysis?.luna?.workflow ?? null;
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
  if (rows.some((group) => !rowRoomCode(group))) return 'Choose a room type for each room before searching.';
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
  onTreatAs,
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
  contact,
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
  /** Static Centurion rates from the authenticated read-only query. */
  rateCatalogue?: RatePlanCatalogueEntry[];
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
  onTreatAs?: (treatAs: 'quote' | 'create_booking') => void;
  onStaffNote?: (note: string) => void;
  /** A retained staff correction, owned by the pane so it survives a trip off the tool screen. */
  staffNoteDraft?: string;
  onStaffNoteDraftChange?: (value: string) => void;
  /** HMS queue progress for the staff quote run in flight. */
  hmsQueue?: { pending: boolean; status: QueueStatus | null };
  /** Loads one HMS audit screenshot of a completed staff quote run. */
  onLoadRunScreenshot?: LoadRunScreenshot;
}) {
  const currentEmailKey = session.binding?.internetMessageId ?? session.binding?.entryId ?? null;
  const failedRatesNotice = useFailedHmsJobNoticeMessage('quote-rates', currentEmailKey);
  const failedRatesNoticeReason = failedRatesNotice?.startsWith('Rates failed: ')
    ? failedRatesNotice.slice('Rates failed: '.length)
    : null;
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
  const intent = intentOf(session);
  const amendment = amendmentOf(session);
  if (session.phase === 'non_quote') {
    // One notice. Staff only see more when Nava flagged something they must act on: the not-supported guidance, or a file it could not read.
    const unreadFiles = (session.reviewItems ?? []).filter((item) => item.kind === 'document_failure');
    return (
      <div className="flex flex-col gap-3">
        <WorkflowBadge analysis={session.analysis} amendmentKind={amendment?.kind ?? null} intent={intent} onIntentChange={onTreatAs} />
        {/* A change or cancellation has its own card above, so "not a quote or booking" would contradict the badge. */}
        {amendment ? null : (
          <Notice tone="info">Not a quote or booking. Change the type above if Nava got it wrong.</Notice>
        )}
        {TELL_NAVA_ENABLED ? (
          <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
        ) : null}
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
    Boolean(session.offers.length || session.reviewedReplyHtml || canCreatePdf(session) || authorizedPartial || openItems.length);

  // While Nava reads, or after a read failed, a blank stay keeps the form open so she can type before the read lands.
  const formGroups =
    !session.groups.length && (session.phase === 'analysing' || session.phase === 'failed')
      ? [draftStayGroup()]
      : session.groups;

  const header = session.staffHeader ?? emptyStaffQuoteHeader();
  const ratePlans = ratePlanChoices(rateCatalogue ?? [], session.rateOptions ?? []);
  const ratePlan =
    ratePlanState?.selectionEpoch === selectionEpoch && ratePlanState.analysis === session.analysis
      ? ratePlanState.value
      : header.salesStrategy === 'Government'
        ? 'government'
        : 'all';
  // A government party defaults to Government (session.ts prefill); "All rates" returns to that default.
  const governmentParty = session.analysis?.luna?.party?.kind === 'government';
  const changeRatePlan = (value: string) => {
    setRatePlanState({ selectionEpoch, analysis: session.analysis, value });
    // The search's sales strategy lives in the header. A government plan asks HMS for Government
    // pricing. "All rates" restores the party's default: Government for a government party, else BAR.
    // Public (BAR) and any other plan ask for BAR.
    const government =
      value === 'all'
        ? governmentParty
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
  stays.forEach((stay, stayIndex) =>
    stay.rows.forEach((row) =>
      rowLabels.set(row.id, stays.length > 1 ? `Stay ${stayIndex + 1} · ${rowRoomLabel(row)}` : rowRoomLabel(row)),
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
          (row) => Boolean(row.arrivalDate && row.departureDate && rowRoomTypeCode(row) && row.quantity && row.adults),
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
    const groupOptions = (session.rateOptions ?? []).filter((option) => option.groupId === group.id);
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

  return (
    <div className="flex flex-col gap-3.5">
      <WorkflowBadge analysis={session.analysis} amendmentKind={amendment?.kind ?? null} intent={intent} onIntentChange={onTreatAs} />
      {TELL_NAVA_ENABLED ? (
        <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
      ) : null}
      {session.phase === 'analysing' ? <StatusNote>{analysingCopy(session)}</StatusNote> : null}
      <PaneStatusLine session={session} />
      {session.analysis?.alternatives.length ? (
        <StatusNote>The email also mentions: {session.analysis.alternatives.join(', ')}. These are not quoted yet.</StatusNote>
      ) : null}
      {showWorkspace ? (
        <Section step={2} title="Stay" id="quote-stay" action={<StepState state={stayReady ? 'Done' : 'Pending'} />}>
          {stays.map((stay, index) => (
            <StayCard
              key={stay.id}
              stayId={stay.id}
              rows={stay.rows}
              index={index}
              stayCount={stays.length}
              requestedRoomsTotal={session.analysis?.requestedRoomsByStay?.[stay.id]}
              mealPlan={mealPlanForStay(stay.id, stay.rows)}
              onMealPlanChange={(value) =>
                setMealPlanFilters((current) => ({ ...current, [stay.id]: value }))
              }
              onPatch={onPatchGroup}
              onStayAction={onStayAction}
              evidence={session.analysis?.luna?.evidence}
            />
          ))}
          {session.groups.length ? (
            <p className="text-center text-[12.5px] font-semibold text-[#475569]">
              {`${roomTotals.rooms} ${roomTotals.rooms === 1 ? 'room' : 'rooms'} · ${roomTotals.guests} ${roomTotals.guests === 1 ? 'guest' : 'guests'}`}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <SecondaryButton className="w-full" onClick={() => onStayAction?.({ type: 'add_stay', token: newQuoteToken() })}>
              + Add another date range
            </SecondaryButton>
            <p className="text-center text-[13px] text-[#64748b]">Each date range is searched and priced independently.</p>
          </div>
        </Section>
      ) : null}
      {showWorkspace ? (
        <Section step={3} title="Company / agency" id="quote-party" action={<StepState state={partyState} />}>
          <StaffPartyFields
            header={header}
            onPatch={(header) => onPatchStaffHeader?.(header, { staffEdit: true })}
            onFieldEdit={markPartyFieldEdited}
            findParty={findParty}
            partySuggestions={partySuggestions}
            partyIndex={partyIndex}
            partyJobTransport={partyJobTransport}
            threadId={session.staffSource?.threadId ?? null}
            sourceMessageId={session.staffSource?.messageId ?? null}
            onPartyLookupPending={onPartyLookupPending}
          />
        </Section>
      ) : null}
      {showWorkspace ? (
        <Section step={4} title="Rates" id="quote-rates" action={<StepState state={ratesState} />}>
          <RatePlanFields
            key={selectionEpoch}
            ratePlans={ratePlans}
            ratePlan={ratePlan}
            onRatePlanChange={changeRatePlan}
            notesBlock={quoteNotesBlock(session, rowLabels, contact)}
            notes={header.notes ?? ''}
            onNotesChange={(value) => onPatchStaffHeader?.({ notes: value }, { staffEdit: true })}
          />
          {showRates ? (
            <>
              <h4 className="text-[13px] font-semibold text-[#475569]">Search availability & room rates</h4>
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
                const stayFound = Boolean(session.staffQuotes[stayKey] ?? selectedQuote);
                return (
                  <article key={`${stay.id}-search`} className="flex flex-col gap-3 rounded-[4px] border border-[#cbd5e1] bg-white p-3">
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
                          Search again
                        </SecondaryButton>
                        {queuedThisStay ? <p role="status">Search queued until the current stay finishes.</p> : null}
                        {retryActionReason ? <p className="text-[13px] text-[#334155]">{retryActionReason}</p> : null}
                      </>
                    ) : (
                      <>
                        <PrimaryButton
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
                          {step?.status === 'failed' ? 'Retry search' : 'Search availability'}
                        </PrimaryButton>
                        {queuedThisStay ? <p role="status">Search queued until the current stay finishes.</p> : null}
                        {step?.status === 'failed' && step.retryGuidance && step.retryGuidance !== failedRatesNoticeReason ? (
                          <p className="text-[13px] text-[#334155]">{step.retryGuidance}</p>
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
                    {stay.rows.map((group) => {
                      const rateGroup = rateGroups.find((item) => item.group.id === group.id);
                      const rowStep = stepFor(group);
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
                            onSavedRateChanged={followSavedRate}
                          />
                        </div>
                      );
                      return (
                        <div key={group.id} className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2.5">
                          <h5 className="text-[13px] font-semibold text-[#475569]">{`${rowLabels.get(group.id) ?? 'Room type needed'} rates`}</h5>
                          {rowStep?.roomAlternatives?.filter((alternative) => alternative.groupId === group.id).map((alternative) => (
                            <div key={`${alternative.roomCode}:${alternative.quantity}`} className="flex flex-col gap-2 rounded-[4px] border border-[#cbd5e1] bg-[#f8fafc] p-2.5">
                              <p className="text-[13px] text-[#334155]">
                                Requested type not available — available instead: {alternative.roomLabel} × {alternative.quantity}
                              </p>
                              <SecondaryButton
                                className="w-full"
                                disabled={loadingThisStay || pinRunningThisStay || !onPatchGroup}
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
                          ) : session.rateOptions?.some((option) => option.groupId === group.id) ? (
                            <p className="text-[13px] text-[#64748b]">No rates match this filter. Choose All rates to show every HMS code.</p>
                          ) : null}
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
                    <StayExtrasFields
                      header={header}
                      stayKey={stayKey}
                      stayNumber={stayIndex + 1}
                      onPatch={onPatchStayExtras}
                    />
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
        <>
          <NotSupportedList
            flags={session.analysis?.luna?.flags}
            tasks={session.analysis?.luna?.tasks}
            amendment={amendment}
            unreadFiles={hasUnreadFiles}
          />
          <NeedsAnswerList missing={session.analysis?.luna?.missing} />
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
      {showWorkspace ? (
        <Section step={5} title="Quote" id="quote-quote" action={<StepState state={quoteState} />}>
          <p className="text-[12px] font-semibold text-[#64748b]">Reply text · PDF · Excel</p>
          {showReply ? (
            <DocumentReview
              session={session}
              onReplyChange={onReplyChange}
              onPreparePdf={onPreparePdf}
              onDownloadWorkbook={onDownloadWorkbook}
              workbookPending={workbookPending}
            />
          ) : (
            <p className="text-[13px] text-[#64748b]">Complete Rates first to prepare a reply, PDF or Excel file.</p>
          )}
          {replyContent}
        </Section>
      ) : replyContent ? (
        <div className="flex flex-col gap-2.5">{replyContent}</div>
      ) : null}
    </div>
  );
}
