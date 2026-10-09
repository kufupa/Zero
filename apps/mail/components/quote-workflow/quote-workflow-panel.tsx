import { Fragment, useEffect, useState } from 'react';
import {
  allocationTotal,
  amendmentOf,
  canCreatePdf,
  optionLetter,
  pendingPdfStayKey,
  quoteRunBlockReason,
  requestedQuoteKeys,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import { completedDateOptions } from '@/lib/quote-workflow/multi-option-draft';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { emptyStaffQuoteHeader } from '@/lib/quote-workflow/types';
import type { QueueStatus, QuoteOffer, QuoteReviewItem, QuoteSession, StaffQuoteHeader, StayGroupRequirement } from '@/lib/quote-workflow/types';
import { BookingCards } from './booking-card';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { DocumentReview } from './document-review';
import { HmsQueueStatusLine } from './hms-queue-status';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { PaneStatusLine } from './pane-status-line';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import { RequirementCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import { WorkflowBadge } from './workflow-badge';


const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

function analysingCopy(session: QuoteSession): string {
  return session.staffNote ? 'Nava is re-reading with your note…' : 'Nava is reading the email…';
}

function TellLunaBox({
  onStaffNote,
}: {
  onStaffNote?: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = note.trim();
        if (!trimmed) return;
        onStaffNote?.(trimmed);
      }}
    >
      <label className="text-[11.5px] font-semibold text-[#475569]" htmlFor="tell-luna-note">
        Tell Nava what&apos;s wrong
      </label>
      <textarea
        id="tell-luna-note"
        aria-label="Tell Nava what's wrong"
        placeholder="e.g. 3 nights from 12 Nov, 2 adults, dinner included"
        className="min-h-[4.5rem] w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1.5 text-[12.5px] text-[#1e293b]"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="text-[11px] text-[#64748b]">
        Nava will re-read the email with your note. Your note wins over the email.
      </p>
      <button
        type="submit"
        className="self-start rounded-sm border border-[#0066cc] bg-white px-2 py-1 text-[11px] font-medium text-[#0066cc]"
      >
        Re-read with your note
      </button>
    </form>
  );
}

function formatZarMinor(minor: number | undefined): string {
  return minor !== undefined && minor > 0 ? (minor / 100).toFixed(2).replace(/\.00$/, '') : '';
}

function ZarMinorInput({
  ariaLabel,
  minor,
  onMinorChange,
}: {
  ariaLabel: string;
  minor: number | undefined;
  onMinorChange: (minor: number | undefined) => void;
}) {
  const formatted = formatZarMinor(minor);
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(formatted);
  }, [formatted, focused]);
  return (
    <input
      aria-label={ariaLabel}
      className={fieldClass}
      inputMode="decimal"
      value={focused ? draft : formatted}
      onFocus={() => {
        setDraft(formatted);
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
        const raw = draft.trim();
        if (!raw) {
          onMinorChange(undefined);
          return;
        }
        const rand = Number(raw);
        onMinorChange(Number.isFinite(rand) && rand > 0 ? Math.round(rand * 100) : undefined);
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        if (!raw.trim()) {
          onMinorChange(undefined);
          return;
        }
        if (/\.\d{0,1}$/.test(raw) && raw.endsWith('.')) return;
        const rand = Number(raw.trim());
        if (Number.isFinite(rand) && rand > 0) onMinorChange(Math.round(rand * 100));
      }}
    />
  );
}

function StaffHeaderFields({
  header,
  onPatch,
}: {
  header: StaffQuoteHeader;
  onPatch?: (header: Partial<StaffQuoteHeader>) => void;
}) {
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Quote header</h3>
      <p className="text-[11px] text-[#64748b]">
        These exact values go on the PDF. Leave Agency blank if there is none.
      </p>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Rate type
        <select
          aria-label="Rate type"
          className={fieldClass}
          value={header.salesStrategy}
          onChange={(event) =>
            onPatch?.({ salesStrategy: event.target.value === 'Government' ? 'Government' : 'BAR' })
          }
        >
          <option value="BAR">BAR (best available rate)</option>
          <option value="Government">Government rate</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Company
        <input
          aria-label="Company"
          className={fieldClass}
          value={header.company}
          onChange={(event) => onPatch?.({ company: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Agency
        <input
          aria-label="Agency"
          className={fieldClass}
          value={header.agency}
          onChange={(event) => onPatch?.({ agency: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Attention
        <input
          aria-label="Attention"
          className={fieldClass}
          value={header.attention}
          onChange={(event) => onPatch?.({ attention: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Client email
        <input
          aria-label="Client email"
          className={fieldClass}
          value={header.clientEmail}
          onChange={(event) => onPatch?.({ clientEmail: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Client telephone
        <input
          aria-label="Client telephone"
          className={fieldClass}
          value={header.clientTelephone}
          onChange={(event) => onPatch?.({ clientTelephone: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Dinner allowance (ZAR / person / night)
        <ZarMinorInput
          ariaLabel="Dinner allowance"
          minor={header.dinnerAllowanceMinor}
          onMinorChange={(dinnerAllowanceMinor) => onPatch?.({ dinnerAllowanceMinor })}
        />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] font-semibold text-[#475569]">
        <input
          type="checkbox"
          aria-label="Shuttle requested"
          checked={Boolean(header.shuttleRequested)}
          onChange={(event) => onPatch?.({ shuttleRequested: event.target.checked })}
        />
        Shuttle requested
      </label>
      {header.shuttleRequested ? (
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
          Shuttle amount (ZAR)
          <ZarMinorInput
            ariaLabel="Shuttle amount"
            minor={header.shuttleMinor}
            onMinorChange={(shuttleMinor) => onPatch?.({ shuttleMinor })}
          />
        </label>
      ) : null}
    </section>
  );
}

/** Date options summary: one row per date option with its dates, total, PDF state, and actions. */
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
  const pending = pendingPdfStayKey(session);
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Date options</h3>
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
            className={`flex flex-col gap-1 rounded-xs border p-2 ${
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
              <button
                type="button"
                disabled={!onPreparePdf}
                onClick={() => onPreparePdf?.(key)}
                className="h-7 self-start rounded-sm border border-[#1a4332] bg-white px-2 text-[11px] font-semibold text-[#1a4332] disabled:opacity-40"
              >
                Prepare PDF for option {letter}
              </button>
            ) : null}
            {selected && hasPdf ? (
              <p className="text-[11px] text-[#475569]">
                {allOptionsReply
                  ? `Use Draft option ${letter} only below for this option.`
                  : 'Use Insert draft in Outlook for this option.'}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
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
      className={`flex flex-col gap-1 rounded-xs border p-2.5 text-left ${
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

function hideQuoteWorkspace(phase: QuoteSession['phase']): boolean {
  return (
    phase === 'idle' ||
    phase === 'unsynced' ||
    phase === 'unsupported' ||
    phase === 'non_quote'
  );
}

export function QuoteWorkflowPanel({
  session,
  onPatchGroup,
  onRunNext,
  onRunStep,
  onSelectOffer,
  onReplyChange,
  onPreparePdf,
  onPreparePdfFor,
  onHandleReviewItem,
  onUndoReviewItem,
  onViewSource,
  onEditReply,
  onPatchStaffHeader,
  onSelectStayKey,
  onTreatAs,
  onStaffNote,
  hmsQueue,
  onLoadRunScreenshot,
  paneSave,
}: {
  session: QuoteSession;
  /** Set only when the server pane save flag is on. Null keeps the booking card copy-only. */
  paneSave?: PaneStayClient | null;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
  onSelectOffer?: (offerId: string) => void;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
  onPreparePdfFor?: (stayKey: string) => void;
  onHandleReviewItem?: (itemId: string) => void;
  onUndoReviewItem?: (itemId: string) => void;
  onViewSource?: (item: QuoteReviewItem) => void;
  onEditReply?: () => void;
  onPatchStaffHeader?: (header: Partial<StaffQuoteHeader>) => void;
  onSelectStayKey?: (stayKey: string) => void;
  onTreatAs?: (treatAs: 'quote' | 'create_booking') => void;
  onStaffNote?: (note: string) => void;
  /** HMS queue progress for the staff quote run in flight. */
  hmsQueue?: { pending: boolean; status: QueueStatus | null };
  /** Loads one HMS audit screenshot of a completed staff quote run. */
  onLoadRunScreenshot?: LoadRunScreenshot;
}) {
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
  if (session.phase === 'non_quote') {
    return (
      <div className="flex flex-col gap-3">
        <WorkflowBadge analysis={session.analysis} amendmentKind={amendmentOf(session)?.kind ?? null} />
        <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} amendment={amendmentOf(session)} />
        <NeedsAnswerList missing={session.analysis?.luna?.missing} />
        {(session.reviewItems ?? [])
          .filter((item) => item.kind === 'document_failure')
          .map((item) => (
            <StatusNote key={item.id}>{item.text}</StatusNote>
          ))}
        <StatusNote>Nava thinks this is not a quote request, so no quote was started. If that is wrong, use the buttons below.</StatusNote>
        <TellLunaBox onStaffNote={onStaffNote} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-sm border border-[#0066cc] bg-white px-2 py-1 text-[11px] font-medium text-[#0066cc]"
            onClick={() => onTreatAs?.('quote')}
          >
            This is a quote request
          </button>
          <button
            type="button"
            className="rounded-sm border border-[#0066cc] bg-white px-2 py-1 text-[11px] font-medium text-[#0066cc]"
            onClick={() => onTreatAs?.('create_booking')}
          >
            This is a booking
          </button>
        </div>
        <p className="text-[11px] text-[#64748b]">Use if Nava sorted this email wrong.</p>
      </div>
    );
  }

  const openItems = openReviewItems(session);
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

  return (
    <div className="flex flex-col gap-3">
      <WorkflowBadge analysis={session.analysis} amendmentKind={amendmentOf(session)?.kind ?? null} />
      <TellLunaBox onStaffNote={onStaffNote} />
      {session.phase === 'analysing' ? <StatusNote>{analysingCopy(session)}</StatusNote> : null}
      <PaneStatusLine session={session} />
      {showWorkspace ? (
        <>
          <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} amendment={amendmentOf(session)} />
          <NeedsAnswerList missing={session.analysis?.luna?.missing} />
          <ItemsForYou
            openItems={openItems}
            handledItems={handledItems}
            onViewSource={onViewSource}
            onEditReply={onEditReply}
            onHandle={onHandleReviewItem}
            onUndo={onUndoReviewItem}
          />
        </>
      ) : null}
      {session.analysis?.alternatives.length ? (
        <StatusNote>The email also mentions: {session.analysis.alternatives.join(', ')}. These are not quoted yet.</StatusNote>
      ) : null}
      {showWorkspace ? (
        <StaffHeaderFields
          header={session.staffHeader ?? emptyStaffQuoteHeader()}
          onPatch={onPatchStaffHeader}
        />
      ) : null}
      {showWorkspace ? (
        <StayScopePicker session={session} onSelect={onSelectStayKey} onPreparePdf={onPreparePdfFor} />
      ) : null}
      {session.groups.map((group, index) => (
        <RequirementCard
          key={group.id}
          group={group}
          index={index}
          onPatch={onPatchGroup}
          evidence={session.analysis?.luna?.evidence}
        />
      ))}
      {session.phase !== 'failed' && session.phase !== 'missing_source' ? (
        <ToolStepList
          steps={session.steps}
          runningStepId={session.runningStepId}
          onRunNext={onRunNext}
          onRunStep={onRunStep}
          blockReason={(step) => quoteRunBlockReason(session, step)}
        />
      ) : null}
      {hmsQueue ? <HmsQueueStatusLine pending={hmsQueue.pending} status={hmsQueue.status} /> : null}
      {session.offers.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Results</h3>
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
        </section>
      ) : null}
      {session.bookingDraft ? (
        <BookingCards draft={session.bookingDraft} groups={session.groups} paneSave={paneSave} />
      ) : null}
      {showReply ? (
        <DocumentReview session={session} onReplyChange={onReplyChange} onPreparePdf={onPreparePdf} />
      ) : null}
    </div>
  );
}
