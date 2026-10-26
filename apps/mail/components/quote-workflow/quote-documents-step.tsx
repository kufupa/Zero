import type { ReactNode } from 'react';
import { PrimaryButton, Section, SecondaryButton, StepState } from '@/components/nava-pane/pane-ui';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { DocumentReview } from './document-review';

export type CurrentQuoteAction =
  | { kind: 'scroll'; targetId: string; label: string }
  | { kind: 'search'; label: string }
  | { kind: 'documents'; label: string };

export function QuoteDocumentsStep({
  session,
  showReply,
  currentAction,
  quoteState,
  onReplyChange,
  onPreparePdf,
  onDownloadWorkbook,
  workbookPending,
  pdfPending,
  replyContent,
}: {
  session: QuoteSession;
  showReply: boolean;
  currentAction: CurrentQuoteAction;
  quoteState: 'Done' | 'Pending';
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
  onDownloadWorkbook?: () => void;
  workbookPending?: boolean;
  pdfPending?: boolean;
  replyContent?: ReactNode;
}) {
  return (
    <Section step={3} title="Documents" id="quote-quote" action={<StepState state={quoteState} />}>
      <p className="text-[12px] font-semibold text-[#64748b]">Reply text · PDF · Excel</p>
      {showReply ? (
        <DocumentReview
          session={session}
          onReplyChange={onReplyChange}
          onPreparePdf={onPreparePdf}
          onDownloadWorkbook={onDownloadWorkbook}
          workbookPending={workbookPending}
          pdfPending={pdfPending}
          primaryAction={false}
        />
      ) : (
        <>
          {currentAction.kind === 'documents' ? (
            <PrimaryButton disabled disabledReason="Complete Rates first to prepare a reply, PDF or Excel file.">
              Prepare PDF
            </PrimaryButton>
          ) : (
            <SecondaryButton disabled disabledReason="Complete Rates first to prepare a reply, PDF or Excel file.">
              Prepare PDF
            </SecondaryButton>
          )}
          <p className="text-[13px] text-[#64748b]">Complete Rates first to prepare a reply, PDF or Excel file.</p>
        </>
      )}
      {replyContent}
    </Section>
  );
}
