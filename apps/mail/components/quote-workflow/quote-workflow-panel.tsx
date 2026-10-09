import { Fragment, useEffect, useState } from 'react';
import {
  allocationTotal,
  amendmentOf,
  canCreatePdf,
  groupStays,
  newQuoteToken,
  optionLetter,
  pendingPdfStayKey,
  pickNextRunnableStep,
  quoteRunBlockReason,
  requestedQuoteKeys,
  rowRoomCode,
  stayKeyForGroup,
  staffSourceReady,
  stayTotals,
} from '@/lib/quote-workflow/session';
import { completedDateOptions } from '@/lib/quote-workflow/multi-option-draft';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { EXTRA_AMOUNT_FORMAT_MESSAGE, parseCountInput, parseZarInput } from '@/lib/quote-workflow/zar-input';
import { emptyStaffQuoteHeader } from '@/lib/quote-workflow/types';
import type { PartyFinder, PartyIndexSearcher, PartySuggestion } from '@/lib/quote-workflow/party-lookup';
import type {
  QueueStatus,
  QuoteOffer,
  QuoteReviewItem,
  QuoteSession,
  QuoteToolStep,
  RateOption,
  StaffQuoteHeader,
  StaffExtraField,
  StaffQuoteOtherUnit,
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
} from '@/components/nava-pane/pane-ui';
import { BookingCards } from './booking-card';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { PartyPicker } from './party-picker';
import { DocumentReview } from './document-review';
import { HmsQueueStatusLine } from './hms-queue-status';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { PaneStatusLine } from './pane-status-line';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import { RateCards } from './rate-cards';
import { StayCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import { WorkflowBadge, type QuoteIntent } from './workflow-badge';

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
  onMinorChange,
  onErrorChange,
}: {
  ariaLabel: string;
  minor: number | undefined;
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
      {error ? <span className="mt-0.5 block text-[11px] font-normal text-[#b45309]">{error}</span> : null}
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
      {error ? <span className="mt-0.5 block text-[11px] font-normal text-[#b45309]">{error}</span> : null}
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

/** Reports one field's unreadable text through the header, so the quote gate sees it. No revision bump. */
function fieldErrorReporter(
  header: StaffQuoteHeader,
  onPatch: ((header: Partial<StaffQuoteHeader>) => void) | undefined,
  field: StaffExtraField,
) {
  return (message: string | null) => {
    const current = header.fieldErrors ?? {};
    if ((current[field] ?? null) === message) return;
    const next: Partial<Record<StaffExtraField, string>> = { ...current };
    if (message) next[field] = message;
    else delete next[field];
    onPatch?.({ fieldErrors: next });
  };
}

/** Rate type, company and agency: the fields that decide the quote, each with its HMS picker. */
function StaffPartyFields({
  header,
  onPatch,
  findParty,
  partySuggestions,
  partyIndex,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
  /** Find in HMS. Null or absent keeps the company and agency as plain text, as before. */
  findParty?: PartyFinder | null;
  /** Suggestions from the email, for staff to confirm. The pane computes them; nothing is picked by itself. */
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
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
        suggestions={partySuggestions}
        indexSearch={partyIndex}
        onPick={(party) =>
          onPatch?.({
            parties:
              party.kind === 'company'
                ? { ...header.parties, company: party }
                : { ...header.parties, agency: party },
            ...(party.kind === 'company' ? { company: party.name } : { agency: party.name }),
          })
        }
        onClear={(cleared) =>
          onPatch?.({
            parties:
              cleared === 'company'
                ? { ...header.parties, company: undefined }
                : { ...header.parties, agency: undefined },
          })
        }
        onSearchName={(searched, searchKind) =>
          onPatch?.(searchKind === 'company' ? { company: searched } : { agency: searched })
        }
      />
    ) : null;
  return (
    <>
      <p className="text-[11px] text-[#64748b]">These exact values go on the PDF. Leave Agency blank if there is none.</p>
      <Field label="Rate type" required htmlFor="quote-rate-type">
        <select
          id="quote-rate-type"
          aria-label="Rate type"
          className={paneFieldClass}
          value={header.salesStrategy}
          onChange={(event) =>
            onPatch?.({ salesStrategy: event.target.value === 'Government' ? 'Government' : 'BAR' })
          }
        >
          <option value="BAR">BAR (best available rate)</option>
          <option value="Government">Government rate</option>
        </select>
      </Field>
      <Field label="Company" htmlFor="quote-company">
        <input
          id="quote-company"
          aria-label="Company"
          className={paneFieldClass}
          value={header.company}
          onChange={(event) =>
            onPatch?.({ company: event.target.value, ...pickClearedBy('company', header, event.target.value) })
          }
        />
        {partyPicker('company')}
      </Field>
      <Field label="Agency" htmlFor="quote-agency">
        <input
          id="quote-agency"
          aria-label="Agency"
          className={paneFieldClass}
          value={header.agency}
          onChange={(event) =>
            onPatch?.({ agency: event.target.value, ...pickClearedBy('agency', header, event.target.value) })
          }
        />
        {partyPicker('agency')}
      </Field>
    </>
  );
}

/** Contact, allowances and notes. Folded in the pane's Extras disclosure. */
function StaffExtraFields({
  header,
  onPatch,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
}) {
  // An amount with no label is not dropped: the label is required and the quote raises a review item for it.
  const otherNeedsLabel = Boolean(header.other?.amountMinor) && !header.other?.label?.trim();
  return (
    <>
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
      <div className="flex flex-col gap-1.5 border-t border-[#e2e8f0] pt-2">
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
          Dinner allowance (R per person per night)
          <ZarMinorInput
            ariaLabel="Dinner allowance (R per person per night)"
            minor={header.dinnerAllowanceMinor}
            onMinorChange={(dinnerAllowanceMinor) => onPatch?.({ dinnerAllowanceMinor })}
            onErrorChange={fieldErrorReporter(header, onPatch, 'dinnerAllowance')}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
          Dinner label, optional (e.g. food only)
          <input
            aria-label="Dinner label"
            className={paneFieldClass}
            maxLength={120}
            value={header.dinnerAllowanceLabel ?? ''}
            onChange={(event) => onPatch?.({ dinnerAllowanceLabel: event.target.value })}
          />
        </label>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-[#e2e8f0] pt-2">
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
          Lunch allowance (R per person per night)
          <ZarMinorInput
            ariaLabel="Lunch allowance (R per person per night)"
            minor={header.lunchAllowanceMinor}
            onMinorChange={(lunchAllowanceMinor) => onPatch?.({ lunchAllowanceMinor })}
            onErrorChange={fieldErrorReporter(header, onPatch, 'lunchAllowance')}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
          Lunch label, optional (e.g. with 1 soft drink)
          <input
            aria-label="Lunch label"
            className={paneFieldClass}
            maxLength={120}
            value={header.lunchAllowanceLabel ?? ''}
            onChange={(event) => onPatch?.({ lunchAllowanceLabel: event.target.value })}
          />
        </label>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-[#e2e8f0] pt-2">
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
          Office transfer (R per person per day)
          <ZarMinorInput
            ariaLabel="Office transfer (R per person per day)"
            minor={header.officeTransferMinor}
            onMinorChange={(officeTransferMinor) => onPatch?.({ officeTransferMinor })}
            onErrorChange={fieldErrorReporter(header, onPatch, 'officeTransfer')}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
          Office transfer days, optional (blank = nights of stay)
          <CountInput
            ariaLabel="Office transfer days"
            value={header.officeTransferDays}
            max={31}
            placeholder="nights of stay"
            onValueChange={(officeTransferDays) => onPatch?.({ officeTransferDays })}
            onErrorChange={fieldErrorReporter(header, onPatch, 'officeTransferDays')}
          />
        </label>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-[#e2e8f0] pt-2">
        <label className="flex items-center gap-2 text-[11.5px] font-semibold text-[#475569]">
          <input
            type="checkbox"
            aria-label="Shuttle requested"
            checked={Boolean(header.shuttleRequested)}
            onChange={(event) =>
              onPatch?.({
                shuttleRequested: event.target.checked,
                ...(event.target.checked
                  ? {}
                  : { fieldErrors: withoutFieldErrors(header.fieldErrors, ['shuttleAmount', 'shuttleTrips']) }),
              })
            }
          />
          Shuttle requested
        </label>
        {header.shuttleRequested ? (
          <div role="group" aria-label="Shuttle: trips × R per trip" className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold text-[#475569]">Shuttle: trips × R per trip</span>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
                Trips
                <CountInput
                  ariaLabel="Shuttle trips"
                  value={header.shuttleTrips}
                  max={50}
                  placeholder="1"
                  onValueChange={(shuttleTrips) => onPatch?.({ shuttleTrips })}
                  onErrorChange={fieldErrorReporter(header, onPatch, 'shuttleTrips')}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
                R per trip
                <ZarMinorInput
                  ariaLabel="Shuttle amount"
                  minor={header.shuttleMinor}
                  onMinorChange={(shuttleMinor) => onPatch?.({ shuttleMinor })}
                  onErrorChange={fieldErrorReporter(header, onPatch, 'shuttleAmount')}
                />
              </label>
            </div>
            {header.shuttleMinor ? null : (
              <p className="text-[11px] text-[#b45309]">
                No price yet. The shuttle stays a review item until you enter R per trip.
              </p>
            )}
          </div>
        ) : null}
      </div>
      <div role="group" aria-label="Other: label, amount, unit" className="flex flex-col gap-1.5 border-t border-[#e2e8f0] pt-2">
        <span className="text-[11.5px] font-semibold text-[#475569]">Other: label, amount, unit</span>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
            Label
            <input
              aria-label="Other label"
              aria-invalid={otherNeedsLabel || undefined}
              className={paneFieldClass}
              maxLength={120}
              placeholder="e.g. Parking"
              required={otherNeedsLabel}
              value={header.other?.label ?? ''}
              onChange={(event) =>
                onPatch?.({ other: { unit: header.other?.unit ?? 'item', ...header.other, label: event.target.value } })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
            Amount (R)
            <ZarMinorInput
              ariaLabel="Other amount"
              minor={header.other?.amountMinor}
              onMinorChange={(amountMinor) =>
                onPatch?.({ other: { label: header.other?.label ?? '', unit: header.other?.unit ?? 'item', amountMinor } })
              }
              onErrorChange={fieldErrorReporter(header, onPatch, 'otherAmount')}
            />
          </label>
        </div>
        {otherNeedsLabel ? <p className="text-[11px] text-[#b45309]">Add a label for this amount</p> : null}
        <label className="flex flex-col gap-1 text-[11px] text-[#64748b]">
          Unit
          <select
            aria-label="Other unit"
            className={paneFieldClass}
            value={header.other?.unit ?? 'item'}
            onChange={(event) =>
              onPatch?.({
                other: {
                  label: header.other?.label ?? '',
                  amountMinor: header.other?.amountMinor,
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
      </div>
      <label className="flex flex-col gap-1 border-t border-[#e2e8f0] pt-2 text-[11.5px] font-semibold text-[#475569]">
        Notes for the quote
        <textarea
          aria-label="Notes for the quote"
          className={`${paneTextareaClass} min-h-[3.5rem] font-normal`}
          maxLength={1000}
          value={header.notes ?? ''}
          onChange={(event) => onPatch?.({ notes: event.target.value })}
        />
        <span className="text-[11px] font-normal text-[#64748b]">
          Unpriced. Printed on the PDF and added to the reply as a note.
        </span>
      </label>
    </>
  );
}

/** Whether any extra is already set, so the Extras disclosure opens and staff see what Nava read. */
function hasExtras(header: StaffQuoteHeader): boolean {
  return Boolean(
    header.dinnerAllowanceMinor ||
      header.lunchAllowanceMinor ||
      header.officeTransferMinor ||
      header.shuttleRequested ||
      header.other?.amountMinor,
  );
}

/** Date options: one row per date option with its dates, total, PDF state, and actions. Sits at the top of the rates step. */
function StayScopePicker({
  session,
  onSelect,
  onPreparePdf,
}: {
  session: QuoteSession;
  onSelect?: (stayKey: string) => void;
  onPreparePdf?: (stayKey: string) => void;
}) {
  const stayKeys = requestedQuoteKeys(session.groups);
  if (stayKeys.length <= 1) return null;
  const allOptionsReply = completedDateOptions(session).length >= 2;
  const noReplySender = session.analysis?.noReplySender === true;
  const pending = pendingPdfStayKey(session);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11.5px] font-semibold text-[#475569]">Date options</h3>
      <p className="text-[11px] text-[#64748b]">
        This email asks for more than one set of dates. Run each option; Nava keeps every result.
      </p>
      {pending ? (
        <p className="text-[11px] text-amber-800">
          Option {optionLetter(stayKeys.indexOf(pending))} has no PDF yet. Prepare its PDF before running another option.
        </p>
      ) : null}
      {stayKeys.map((key, index) => {
        const letter = optionLetter(index);
        const selected = session.selectedStayKey === key;
        const quote = session.staffQuotes[key];
        const hasPdf = Boolean(session.stayPdfs[key]);
        const step = session.steps.find((item) => item.shareKey === key);
        const status = quote
          ? `Quoted ${money(quote.totalMinor)} · ${hasPdf ? 'PDF ready' : 'PDF not built'}`
          : step?.status === 'failed'
            ? 'Search failed. Run this option again.'
            : step?.status === 'running'
              ? 'Running now.'
              : 'Not run yet.';
        return (
          <div
            key={key}
            className={`flex flex-col gap-1 rounded-xs border p-3 ${
              selected ? 'border-[#1a4332] bg-[#eaf4ee]' : 'border-[#cbd5e1] bg-white'
            }`}
          >
            <button
              type="button"
              aria-pressed={selected}
              aria-label={`Select date scope ${key.replace(':', ' to ')}`}
              className="flex flex-col gap-0.5 text-left text-[12px] font-semibold text-[#1e293b]"
              onClick={() => onSelect?.(key)}
            >
              <span>
                Option {letter} · {key.replace(':', ' → ')}
                {selected ? ' · selected' : ''}
              </span>
              <span className="text-[11px] font-normal text-[#475569]">{status}</span>
            </button>
            {quote && !hasPdf ? (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  disabled={!onPreparePdf}
                  onClick={() => onPreparePdf?.(key)}
                  className="h-7 self-start rounded-sm border border-[#1a4332] bg-white px-2 text-[11px] font-semibold text-[#1a4332] disabled:opacity-40"
                >
                  Prepare PDF for option {letter}
                </button>
                {onPreparePdf ? null : <p className="text-[11px] text-[#64748b]">Not available here.</p>}
              </div>
            ) : null}
            {selected && hasPdf && !noReplySender ? (
              <p className="text-[11px] text-[#475569]">
                {allOptionsReply
                  ? `Use Draft option ${letter} only below for this option.`
                  : 'Use Insert draft in Outlook for this option.'}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <p aria-live="polite" className="rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]">
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
      <span className="text-[12.5px] font-bold text-[#1e293b]">
        {offer.roomLabel} · {offer.rateCode} · {offer.board}
      </span>
      <span className="text-[11px] text-[#64748b]">
        {offer.kind === 'alternative' ? 'Alternative — not counted in the total' : 'Counted in the total'}
      </span>
      <span className="text-[13.5px] font-extrabold text-[#1e293b]">{money(offer.stayTotalMinor)}</span>
      <span className="text-[10px] text-[#64748b]">Checked in HMS {offer.observedAt}</span>
      {varying ? (
        <details>
          <summary className="text-[11px] text-[#0066cc]">Nightly breakdown</summary>
          <ul className="text-[11px] text-[#475569]">
            {offer.nightly.map((night) => (
              <li key={night.date}>
                {night.date}: {money(night.amountMinor)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {offer.restrictions.map((restriction) => (
        <p key={restriction} className="text-[11px] text-amber-800">
          {restriction}
        </p>
      ))}
      {showShot ? <p className="text-[11px] text-[#64748b]">{shot}</p> : null}
    </button>
  );
}

/** The request's rooms and guests. The Available chip shows once HMS has found the selected stay. */
function RequestTotals({ groups, available }: { groups: StayGroupRequirement[]; available: boolean }) {
  const totals = stayTotals(groups);
  return (
    <div className="flex items-center justify-between gap-2 rounded-[3px] border border-[#cbd5e1] bg-[#f8fafc] px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.3px] text-[#64748b]">Total</span>
        <span className="text-[13px] font-bold text-[#1e293b]">
          {totals.rooms} {totals.rooms === 1 ? 'room' : 'rooms'} · {totals.guests} {totals.guests === 1 ? 'guest' : 'guests'}
        </span>
      </div>
      {available ? (
        <span className="rounded-full bg-[#eaf4ee] px-2 py-0.5 text-[11px] font-bold text-[#1a4332]">Available</span>
      ) : null}
    </div>
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

/**
 * Why "Get rates from HMS" cannot run now, or null when it can. A runnable step's own wait shows first, as before;
 * every row still needs a room type before rates run.
 */
function ratesBlockReason(session: QuoteSession, nextStep: QuoteToolStep | undefined): string | null {
  if (nextStep) {
    const stepWait = quoteRunBlockReason(session, nextStep);
    if (stepWait) return stepWait;
    return session.groups.some((group) => !rowRoomCode(group)) ? 'Choose a room type for each row.' : null;
  }
  if (!session.groups.length) return 'Nava has not found a stay yet.';
  if (session.groups.some((group) => !group.arrivalDate || !group.departureDate)) {
    return 'Add arrival and departure dates first.';
  }
  if (session.groups.some((group) => !rowRoomCode(group))) return 'Choose a room type for each row.';
  if (session.groups.some((group) => !group.quantity)) return 'Add the number of rooms first.';
  if (session.steps.length > 0 && session.steps.every((step) => step.status === 'succeeded')) {
    return 'Already up to date.';
  }
  return 'Nothing is ready to search yet.';
}

export function QuoteWorkflowPanel({
  session,
  onPatchGroup,
  onStayAction,
  onRunNext,
  onRunStep,
  onSelectOffer,
  onReplyChange,
  onPreparePdf,
  onPreparePdfFor,
  onDownloadWorkbook,
  workbookPending,
  onHandleReviewItem,
  onUndoReviewItem,
  onRetryRead,
  onViewSource,
  onEditReply,
  onPatchStaffHeader,
  findParty,
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
}: {
  session: QuoteSession;
  /** Set only when the server pane save flag is on. Null keeps the booking card copy-only. */
  paneSave?: PaneStayClient | null;
  partySuggestions?: PartySuggestion[];
  /** The HMS list searched while staff type. Null or absent leaves only the live search. */
  partyIndex?: PartyIndexSearcher | null;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  /** Adds, duplicates or removes a room or a stay. The shell keeps a removed stay for Undo. */
  onStayAction?: (action: StayEditAction) => void;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
  onSelectOffer?: (offerId: string) => void;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
  onPreparePdfFor?: (stayKey: string) => void;
  onDownloadWorkbook?: () => void;
  /** An Excel export is being made; the Excel button is disabled meanwhile. */
  workbookPending?: boolean;
  onHandleReviewItem?: (itemId: string) => void;
  onUndoReviewItem?: (itemId: string) => void;
  /** Runs the read again after an analysis failure. Absent when there is nothing to retry. */
  onRetryRead?: () => void;
  onViewSource?: (item: QuoteReviewItem) => void;
  onEditReply?: () => void;
  onPatchStaffHeader?: (header: Partial<StaffQuoteHeader>) => void;
  /** HMS company and agency search for the quote header's Find in HMS picker. Null or absent: no picker. */
  findParty?: PartyFinder | null;
  onSelectStayKey?: (stayKey: string) => void;
  onTreatAs?: (treatAs: 'quote' | 'create_booking') => void;
  onStaffNote?: (note: string) => void;
  /** Unfinished Tell Nava text, owned by the pane so it survives a trip off the tool screen. */
  staffNoteDraft?: string;
  onStaffNoteDraftChange?: (value: string) => void;
  /** HMS queue progress for the staff quote run in flight. */
  hmsQueue?: { pending: boolean; status: QueueStatus | null };
  /** Loads one HMS audit screenshot of a completed staff quote run. */
  onLoadRunScreenshot?: LoadRunScreenshot;
}) {
  // A rate card tapped and waiting for its pin to reach the session. The re-run starts once the pin is there, so it reads it.
  const [pinRun, setPinRun] = useState<{ groupId: string; rateCode: string; stepId: string } | null>(null);
  useEffect(() => {
    if (!pinRun) return;
    const group = session.groups.find((item) => item.id === pinRun.groupId);
    if (group?.rateCode !== pinRun.rateCode) return;
    setPinRun(null);
    onRunStep?.(pinRun.stepId);
  }, [pinRun, session.groups, onRunStep]);
  if (session.phase === 'idle') {
    return <StatusNote>Select an email in Outlook. Nava will read it and list what the quote needs.</StatusNote>;
  }
  if (session.phase === 'unsynced') {
    return <StatusNote>This email has not finished syncing yet. Wait a moment, then select it again.</StatusNote>;
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
        <Notice tone="info">Not a quote or booking. Change the type above if Nava got it wrong.</Notice>
        <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
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

  if (session.phase === 'analysing' && !session.groups.length && !openItems.length) {
    return <StatusNote>{analysingCopy(session)}</StatusNote>;
  }

  const header = session.staffHeader ?? emptyStaffQuoteHeader();
  const stays = groupStays(session.groups);
  const nextStep = pickNextRunnableStep(session.steps, session.runningStepId);
  const ratesReason = ratesBlockReason(session, nextStep);
  const running = Boolean(session.runningStepId) || Boolean(hmsQueue?.pending);
  const showRates = session.phase !== 'failed' && session.phase !== 'missing_source';
  // Rate cards show for a room group with two or more options. One option keeps the plain result below.
  const rateGroups = session.groups.flatMap((group) => {
    const options = (session.rateOptions ?? []).filter((option) => option.groupId === group.id);
    if (options.length < 2) return [];
    const step = session.steps.find((item) => item.kind === 'quote_stay' && item.shareKey === stayKeyForGroup(group));
    return [
      {
        group,
        options,
        step,
        blockReason: step ? quoteRunBlockReason(session, step) : 'Nothing is ready to search yet.',
        pendingRateCode:
          pinRun?.groupId === group.id
            ? pinRun.rateCode
            : step !== undefined && session.runningStepId === step.id
              ? (group.rateCode ?? null)
              : null,
      },
    ];
  });
  /** Tapping a rate pins it on its group and re-runs that date option. Only a card whose run is not in flight can start one. */
  const pickRate = (option: RateOption) => {
    const group = session.groups.find((item) => item.id === option.groupId);
    if (!group || !onPatchGroup) return;
    const step = session.steps.find((item) => item.kind === 'quote_stay' && item.shareKey === stayKeyForGroup(group));
    if (!step || quoteRunBlockReason(session, step)) return;
    onPatchGroup(group.id, { board: option.board, roomCodes: [option.roomCode], rateCode: option.rateCode });
    setPinRun({ groupId: group.id, rateCode: option.rateCode, stepId: step.id });
  };

  return (
    <div className="flex flex-col gap-3">
      <WorkflowBadge analysis={session.analysis} amendmentKind={amendment?.kind ?? null} intent={intent} onIntentChange={onTreatAs} />
      <CorrectionNote onStaffNote={onStaffNote} draft={staffNoteDraft} onDraftChange={onStaffNoteDraftChange} />
      {session.phase === 'analysing' ? <StatusNote>{analysingCopy(session)}</StatusNote> : null}
      <PaneStatusLine session={session} />
      {session.analysis?.alternatives.length ? (
        <StatusNote>The email also mentions: {session.analysis.alternatives.join(', ')}. These are not quoted yet.</StatusNote>
      ) : null}
      {showWorkspace ? (
        <Section step={1} title="Stay details">
          {stays.map((stay, index) => (
            <StayCard
              key={stay.id}
              stayId={stay.id}
              rows={stay.rows}
              index={index}
              stayCount={stays.length}
              onPatch={onPatchGroup}
              onStayAction={onStayAction}
              evidence={session.analysis?.luna?.evidence}
            />
          ))}
          <div className="flex flex-col gap-2">
            <SecondaryButton onClick={() => onStayAction?.({ type: 'add_stay', token: newQuoteToken() })}>
              Add stay
            </SecondaryButton>
            {session.groups.length ? (
              <RequestTotals groups={session.groups} available={Boolean(session.staffQuote)} />
            ) : null}
          </div>
          <StaffPartyFields
            header={header}
            onPatch={onPatchStaffHeader}
            findParty={findParty}
            partySuggestions={partySuggestions}
            partyIndex={partyIndex}
          />
          <Disclosure summary={<span>Extras: allowances, contact, notes</span>} defaultOpen={hasExtras(header)}>
            <StaffExtraFields header={header} onPatch={onPatchStaffHeader} />
          </Disclosure>
          <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} amendment={amendment} unreadFiles={hasUnreadFiles} />
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
        </Section>
      ) : null}
      {showWorkspace && (showRates || session.offers.length) ? (
        <Section step={2} title="Rates from HMS">
          {showRates ? (
            <StayScopePicker session={session} onSelect={onSelectStayKey} onPreparePdf={onPreparePdfFor} />
          ) : null}
          {showRates ? (
            <PrimaryButton
              onClick={onRunNext}
              disabled={ratesReason !== null}
              disabledReason={ratesReason}
              loading={running}
              loadingText="Getting rates from HMS… about 2 minutes"
            >
              Get rates from HMS
            </PrimaryButton>
          ) : null}
          {showRates ? (
            <Disclosure summary={<span>HMS steps</span>} defaultOpen={session.steps.length > 1}>
              <ToolStepList
                steps={session.steps}
                runningStepId={session.runningStepId}
                onRunStep={onRunStep}
                blockReason={(step) => quoteRunBlockReason(session, step)}
              />
            </Disclosure>
          ) : null}
          {hmsQueue ? <HmsQueueStatusLine pending={hmsQueue.pending} status={hmsQueue.status} /> : null}
          {rateGroups.map((rates) => (
            <Fragment key={rates.group.id}>
              <RateCards
                options={rates.options}
                partyName={contractPartyName(header)}
                disabled={running || pinRun !== null || rates.blockReason !== null}
                pendingRateCode={rates.pendingRateCode}
                onPick={pickRate}
              />
              {rates.blockReason ? <p className="text-[11px] text-[#64748b]">{rates.blockReason}</p> : null}
            </Fragment>
          ))}
          {session.offers.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[11.5px] font-semibold text-[#475569]">Results</h3>
              <p className="text-[11px] text-[#64748b]">
                Selected total {money(allocationTotal(session.offers.filter((o) => session.selectedOfferIds.includes(o.id))))}.
                Alternatives are not added to this total.
                {new Set(session.offers.filter((o) => o.kind === 'allocation').map((o) => o.quoteRequestKey)).size > 1
                  ? ' Each date search keeps its own quote and PDF. Once two or more options are finished, Create one reply with all date options puts them in one draft.'
                  : ''}
              </p>
              {session.offers.map((offer) => {
                const staffQuote = session.staffQuote?.revisionRef === offer.id ? session.staffQuote : null;
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
        </Section>
      ) : null}
      {session.bookingDraft ? (
        <BookingCards
          draft={session.bookingDraft}
          groups={session.groups}
          paneSave={paneSave}
          parties={session.staffHeader.parties}
        />
      ) : null}
      {showReply ? (
        <Section step={3} title="Quote documents">
          <DocumentReview
            session={session}
            onReplyChange={onReplyChange}
            onPreparePdf={onPreparePdf}
            onDownloadWorkbook={onDownloadWorkbook}
            workbookPending={workbookPending}
          />
        </Section>
      ) : null}
    </div>
  );
}
