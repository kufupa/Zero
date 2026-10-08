import { Fragment, useEffect, useState } from 'react';
import { allocationTotal, canCreatePdf, requestedQuoteKeys, staffSourceReady } from '@/lib/quote-workflow/session';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { emptyStaffQuoteHeader } from '@/lib/quote-workflow/types';
import type { QueueStatus, QuoteOffer, QuoteReviewItem, QuoteSession, StaffQuoteHeader, StayGroupRequirement } from '@/lib/quote-workflow/types';
import { BookingCards } from './booking-card';
import { DocumentReview } from './document-review';
import { HmsQueueStatusLine } from './hms-queue-status';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import { RequirementCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import { WorkflowBadge } from './workflow-badge';


const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

function analysingCopy(session: QuoteSession): string {
  return session.staffNote ? 'Luna is re-reading with your note…' : 'Luna is reading the email…';
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
        Tell Luna what&apos;s wrong
      </label>
      <textarea
        id="tell-luna-note"
        aria-label="Tell Luna what's wrong"
        placeholder="e.g. 3 nights from 12 Nov, 2 adults, dinner included"
        className="min-h-[4.5rem] w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1.5 text-[12.5px] text-[#1e293b]"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="text-[11px] text-[#64748b]">
        Luna will re-read the email with your note. Your note wins over the email.
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

function StayScopePicker({
  stayKeys,
  selectedStayKey,
  onSelect,
}: {
  stayKeys: string[];
  selectedStayKey: string | null;
  onSelect?: (stayKey: string) => void;
}) {
  if (stayKeys.length <= 1) return null;
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Which stay to quote</h3>
      <p className="text-[11px] text-[#64748b]">
        Quote one stay at a time. The other stays stay listed but not quoted yet. Results are not combined.
      </p>
      {stayKeys.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={selectedStayKey === key}
          aria-label={`Select date scope ${key.replace(':', ' to ')}`}
          className={`h-8 rounded-xs border px-2 text-left text-[12px] font-semibold ${
            selectedStayKey === key ? 'border-[#1a4332] bg-[#eaf4ee] text-[#1e293b]' : 'border-[#cbd5e1] bg-white text-[#1e293b]'
          }`}
          onClick={() => onSelect?.(key)}
        >
          {key.replace(':', ' → ')}
          {selectedStayKey === key ? ' · selected' : ' · not quoted yet, click to quote'}
        </button>
      ))}
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
}: {
  session: QuoteSession;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
  onSelectOffer?: (offerId: string) => void;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
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
    return <StatusNote>Select an email in Outlook. Luna will read it and list what the quote needs.</StatusNote>;
  }
  if (session.phase === 'unsynced') {
    return <StatusNote>This email has not finished syncing yet. Wait a moment, then select it again.</StatusNote>;
  }
  if (session.phase === 'unsupported') {
    return (
      <StatusNote>{session.errorMessage ?? 'Luna cannot handle this email yet. Handle it by hand in Outlook.'}</StatusNote>
    );
  }
  if (session.phase === 'non_quote') {
    return (
      <div className="flex flex-col gap-3">
        <WorkflowBadge analysis={session.analysis} amendmentKind={session.analysis?.amendment?.kind} />
        <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} />
        <NeedsAnswerList missing={session.analysis?.luna?.missing} />
        {(session.reviewItems ?? [])
          .filter((item) => item.kind === 'document_failure')
          .map((item) => (
            <StatusNote key={item.id}>{item.text}</StatusNote>
          ))}
        <StatusNote>Luna thinks this is not a quote request, so no quote was started. If that is wrong, use the buttons below.</StatusNote>
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
        <p className="text-[11px] text-[#64748b]">Use if Luna sorted this email wrong.</p>
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
      <WorkflowBadge analysis={session.analysis} amendmentKind={session.analysis?.amendment?.kind} />
      <TellLunaBox onStaffNote={onStaffNote} />
      {session.phase === 'analysing' ? <StatusNote>{analysingCopy(session)}</StatusNote> : null}
      {session.phase === 'failed' ? (
        <StatusNote>
          {session.errorMessage ?? 'Luna could not read this email. Select it again, or use Tell Luna to explain what is wrong.'}
        </StatusNote>
      ) : null}
      {session.phase === 'missing_source' ? (
        <StatusNote>
          Luna could not read the attachment contents. Open the attachment in Outlook and check it by hand.
          {session.missing.length ? ` Could not read: ${session.missing.join(', ')}.` : ''}
        </StatusNote>
      ) : null}
      {session.errorMessage && session.phase !== 'failed' ? <StatusNote>{session.errorMessage}</StatusNote> : null}
      {session.mailboxStatus && session.mailboxStatus !== 'ready' ? (
        <StatusNote>
          {session.mailboxStatus === 'unsynced'
            ? 'This email has not finished syncing, so this result may be out of date. Wait for sync, then select the email again.'
            : session.mailboxStatus === 'missing_source'
              ? 'Attachment contents are missing. Open the attachment in Outlook and check it by hand.'
              : 'Luna is not connected to this pane yet. Refresh the pane and try again.'}
        </StatusNote>
      ) : null}
      {showWorkspace ? (
        <>
          <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} />
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
        <StayScopePicker
          stayKeys={requestedQuoteKeys(session.groups)}
          selectedStayKey={session.selectedStayKey}
          onSelect={onSelectStayKey}
        />
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
              ? ' Each date search keeps its own quote. A combined PDF is blocked, so prepare the PDF for one stay at a time.'
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
      {session.bookingDraft ? <BookingCards draft={session.bookingDraft} groups={session.groups} /> : null}
      {showReply ? (
        <DocumentReview session={session} onReplyChange={onReplyChange} onPreparePdf={onPreparePdf} />
      ) : null}
    </div>
  );
}
