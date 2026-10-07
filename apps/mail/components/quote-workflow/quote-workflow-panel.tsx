import { allocationTotal, canCreatePdf, requestedQuoteKeys, staffSourceReady } from '@/lib/quote-workflow/session';
import { notNoise, openReviewItems } from '@/lib/quote-workflow/review-items';
import { emptyStaffQuoteHeader } from '@/lib/quote-workflow/types';
import type { QuoteOffer, QuoteReviewItem, QuoteSession, StaffQuoteHeader, StayGroupRequirement } from '@/lib/quote-workflow/types';
import { BookingCards } from './booking-card';
import { DocumentReview } from './document-review';
import { ItemsForYou } from './items-for-you';
import { NeedsAnswerList } from './needs-answer-list';
import { NotSupportedList } from './not-supported-list';
import { RequirementCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';
import { WorkflowBadge } from './workflow-badge';


const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

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
        PDF uses these exact values. Blank agency stays empty.
      </p>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Rate
        <select
          aria-label="Sales strategy"
          className={fieldClass}
          value={header.salesStrategy}
          onChange={(event) =>
            onPatch?.({ salesStrategy: event.target.value === 'Government' ? 'Government' : 'BAR' })
          }
        >
          <option value="BAR">BAR</option>
          <option value="Government">Government</option>
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
        <input
          aria-label="Dinner allowance"
          className={fieldClass}
          inputMode="decimal"
          value={
            header.dinnerAllowanceMinor
              ? (header.dinnerAllowanceMinor / 100).toFixed(2).replace(/\.00$/, '')
              : ''
          }
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (!raw) {
              onPatch?.({ dinnerAllowanceMinor: undefined });
              return;
            }
            const rand = Number(raw);
            onPatch?.({
              dinnerAllowanceMinor:
                Number.isFinite(rand) && rand > 0 ? Math.round(rand * 100) : undefined,
            });
          }}
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
          <input
            aria-label="Shuttle amount"
            className={fieldClass}
            inputMode="decimal"
            value={
              header.shuttleMinor ? (header.shuttleMinor / 100).toFixed(2).replace(/\.00$/, '') : ''
            }
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (!raw) {
                onPatch?.({ shuttleMinor: undefined });
                return;
              }
              const rand = Number(raw);
              onPatch?.({
                shuttleMinor: Number.isFinite(rand) && rand > 0 ? Math.round(rand * 100) : undefined,
              });
            }}
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
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Date scope</h3>
      <p className="text-[11px] text-[#64748b]">
        Quote one date range. Other stays stay visible and unfinished. Results are not aggregated.
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
          {selectedStayKey === key ? ' · selected' : ' · unfinished until selected'}
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
}: {
  offer: QuoteOffer;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const varying = new Set(offer.nightly.map((n) => n.amountMinor)).size > 1;
  const shot =
    offer.screenshot && 'unavailable' in offer.screenshot
      ? offer.screenshot.reason
      : offer.screenshot
        ? `Screenshot from tool run ${offer.screenshot.toolRunId}`
        : 'No authorised screenshot is tied to this tool run.';
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
        {offer.kind === 'alternative' ? 'Alternative — not included in the selected allocation total' : 'Allocation'}
      </span>
      <span className="text-[13.5px] font-extrabold text-[#1e293b]">{money(offer.stayTotalMinor)}</span>
      <span className="text-[10px] text-[#64748b]">Observed {offer.observedAt}</span>
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
      <p className="text-[11px] text-[#64748b]">{shot}</p>
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
}) {
  if (session.phase === 'idle') {
    return <StatusNote>Select an inbound email in Outlook to analyse quote requirements.</StatusNote>;
  }
  if (session.phase === 'unsynced') {
    return <StatusNote>This selected email is not synced to the authorised mailbox yet.</StatusNote>;
  }
  if (session.phase === 'unsupported') {
    return <StatusNote>{session.errorMessage ?? 'Unsupported request.'}</StatusNote>;
  }
  if (session.phase === 'non_quote') {
    return (
      <div className="flex flex-col gap-3">
        <WorkflowBadge analysis={session.analysis} />
        <NotSupportedList flags={session.analysis?.luna?.flags} tasks={session.analysis?.luna?.tasks} />
        <NeedsAnswerList missing={session.analysis?.luna?.missing} />
        {(session.reviewItems ?? [])
          .filter((item) => item.kind === 'document_failure')
          .map((item) => (
            <StatusNote key={item.id}>{item.text}</StatusNote>
          ))}
        <StatusNote>This message is not a quoting request. No quoting workflow was opened.</StatusNote>
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
    return <StatusNote>Analysing selected email and authorised thread sources…</StatusNote>;
  }

  return (
    <div className="flex flex-col gap-3">
      <WorkflowBadge analysis={session.analysis} />
      {session.phase === 'analysing' ? (
        <StatusNote>Analysing selected email and authorised thread sources…</StatusNote>
      ) : null}
      {session.phase === 'failed' ? <StatusNote>{session.errorMessage ?? 'Analysis failed.'}</StatusNote> : null}
      {session.phase === 'missing_source' ? (
        <StatusNote>
          Authorised attachment content is missing. Filenames are not document bytes.
          {session.missing.length ? ` Missing: ${session.missing.join(', ')}.` : ''}
        </StatusNote>
      ) : null}
      {session.errorMessage && session.phase !== 'failed' ? <StatusNote>{session.errorMessage}</StatusNote> : null}
      {session.mailboxStatus && session.mailboxStatus !== 'ready' ? (
        <StatusNote>
          {session.mailboxStatus === 'unsynced'
            ? 'Mailbox quoteWorkflow.analyseSelection: unsynced. This result is not mailbox-synced.'
            : session.mailboxStatus === 'missing_source'
              ? 'Mailbox quoteWorkflow.analyseSelection: authorised attachment bytes are missing. Filenames are not document content.'
              : 'Mailbox quoteWorkflow.analyseSelection client is not bound.'}
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
        <StatusNote>Requested alternatives preserved: {session.analysis.alternatives.join(', ')}</StatusNote>
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
      {session.offers.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Results</h3>
          <p className="text-[11px] text-[#64748b]">
            Selected allocation total {money(allocationTotal(session.offers.filter((o) => session.selectedOfferIds.includes(o.id))))}.
            Alternatives are not summed as if booked.
            {new Set(session.offers.filter((o) => o.kind === 'allocation').map((o) => o.quoteRequestKey)).size > 1
              ? ' Separate date searches keep their own revisions. Combined PDF is blocked; prepare PDF for the selected stay only.'
              : ''}
          </p>
          {session.offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              selected={session.selectedOfferIds.includes(offer.id)}
              onSelect={onSelectOffer}
            />
          ))}
        </section>
      ) : null}
      {session.bookingDraft ? <BookingCards draft={session.bookingDraft} /> : null}
      {showReply ? (
        <DocumentReview session={session} onReplyChange={onReplyChange} onPreparePdf={onPreparePdf} />
      ) : null}
    </div>
  );
}
