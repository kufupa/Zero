import { allocationTotal, canCreatePdf } from '@/lib/quote-workflow/session';
import type { QuoteOffer, QuoteSession, StayGroupRequirement } from '@/lib/quote-workflow/types';
import { DocumentReview } from './document-review';
import { RequirementCard } from './requirement-card';
import { ToolStepList } from './tool-step-list';

function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <p aria-live="polite" className="rounded-sm border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]">
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
      className={`flex flex-col gap-1 rounded-sm border p-2.5 text-left ${
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

export function QuoteWorkflowPanel({
  session,
  onPatchGroup,
  onRunNext,
  onRunStep,
  onSelectOffer,
  onReplyChange,
  onPreparePdf,
}: {
  session: QuoteSession;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onRunNext?: () => void;
  onRunStep?: (stepId: string) => void;
  onSelectOffer?: (offerId: string) => void;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
}) {
  if (session.phase === 'analysing') {
    return <StatusNote>Analysing selected email and authorised thread sources…</StatusNote>;
  }
  if (session.phase === 'unsynced') {
    return <StatusNote>This selected email is not synced to the authorised mailbox yet.</StatusNote>;
  }
  if (session.phase === 'missing_source') {
    return (
      <StatusNote>
        Authorised attachment content is missing. Filenames are not document bytes.
        {session.missing.length ? ` Missing: ${session.missing.join(', ')}.` : ''}
      </StatusNote>
    );
  }
  if (session.phase === 'failed') {
    return <StatusNote>{session.errorMessage ?? 'Analysis failed.'}</StatusNote>;
  }
  if (session.phase === 'unsupported') {
    return <StatusNote>{session.errorMessage ?? 'Unsupported request.'}</StatusNote>;
  }
  if (session.phase === 'non_quote') {
    return <StatusNote>This message is not a quoting request. No quoting workflow was opened.</StatusNote>;
  }
  if (session.phase === 'idle') {
    return <StatusNote>Select an inbound email in Outlook to analyse quote requirements.</StatusNote>;
  }

  const booked = allocationTotal(session.offers.filter((o) => session.selectedOfferIds.includes(o.id)));
  const distinctKeys = new Set(session.offers.filter((o) => o.kind === 'allocation').map((o) => o.quoteRequestKey));
  const jointUnknown = distinctKeys.size > 1;

  return (
    <div className="flex flex-col gap-3">
      {session.mailboxStatus && session.mailboxStatus !== 'ready' ? (
        <StatusNote>
          {session.mailboxStatus === 'unsynced'
            ? 'Mailbox quoteWorkflow.analyseSelection: unsynced. Local regex preview below is not the AI reservationist and is not mailbox-synced.'
            : session.mailboxStatus === 'missing_source'
              ? 'Mailbox quoteWorkflow.analyseSelection: authorised attachment bytes are missing. Filenames are not document content.'
              : 'Mailbox quoteWorkflow.analyseSelection client is not bound. Local regex preview below is not the AI reservationist.'}
        </StatusNote>
      ) : null}
      {session.analysis?.secondaryAsks.length ? (
        <StatusNote>Secondary questions preserved: {session.analysis.secondaryAsks.join(' · ')}</StatusNote>
      ) : null}
      {session.analysis?.alternatives.length ? (
        <StatusNote>Requested alternatives preserved: {session.analysis.alternatives.join(', ')}</StatusNote>
      ) : null}
      {session.groups.map((group, index) => (
        <RequirementCard key={group.id} group={group} index={index} onPatch={onPatchGroup} />
      ))}
      <ToolStepList
        steps={session.steps}
        running={Boolean(session.runningStepId)}
        onRunNext={onRunNext}
        onRunStep={onRunStep}
      />
      {session.offers.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Results</h3>
          <p className="text-[11px] text-[#64748b]">
            Selected allocation total {money(booked)}. Alternatives are not summed as if booked.
            {jointUnknown
              ? ' Separate date searches do not prove joint availability.'
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
      {session.offers.length || session.reviewedReplyHtml || canCreatePdf(session) ? (
        <DocumentReview session={session} onReplyChange={onReplyChange} onPreparePdf={onPreparePdf} />
      ) : null}
    </div>
  );
}
