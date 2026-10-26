import { useRef, useState } from 'react';
import type { Dispatch } from 'react';

import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import { withContactLines } from '@/lib/quote-workflow/document-contact';
import { quoteWrapperHtml } from '@/lib/quote-proposal/copy';
import { currentPaneOwner, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { combinedDocumentRequest } from '@/lib/quote-workflow/quote-workbook-download';
import {
  canCreatePdf,
  dinnerAddOnInputProblem,
  dinnerAllowanceStillRequired,
  evidenceMatchesSession,
  isMultiStay,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import { bindQualifiedStaffProposalPdf, staffQuoteFromTrpc } from '@/lib/quote-workflow/staff-quote-bind';
import type { QuotePaneConfig, QuoteSession, QuoteSessionAction } from '@/lib/quote-workflow/types';
import { isQuoteFixturePreview } from '@/lib/quote-workflow/preview';
import { toast } from 'sonner';
import { trpcClient } from '@/providers/query-provider';

type MutableRef<T> = { current: T };
type ReplyGreetingName = (
  contactName: string | null | undefined,
  email: { senderName: string; senderEmail: string } | null | undefined,
) => string;

type UseQuotePdfJobArgs = {
  quoteSessionRef: MutableRef<QuoteSession>;
  documentContactRef: MutableRef<StoredContact | null>;
  dispatchQuote: Dispatch<QuoteSessionAction>;
  activeEmail: PaneBridge['activeEmail'];
  staffSignerName: string;
  activePaneConfig: QuotePaneConfig | null;
  replyGreetingName: ReplyGreetingName;
};

export function useQuotePdfJob({
  quoteSessionRef,
  documentContactRef,
  dispatchQuote,
  activeEmail,
  staffSignerName,
  activePaneConfig,
  replyGreetingName,
}: UseQuotePdfJobArgs) {
  // Only one quote PDF request at a time, for single- and multi-stay quotes.
  const pdfInFlight = useRef(false);
  const [pdfPending, setPdfPending] = useState(false);

  /**
   * Builds the quotation PDF for one date option from that option's own run.
   * A null stayKey means the selected option (the "Prepare quotation PDF" button).
   */
  const preparePdfFor = (stayKey: string | null) => {
    if (pdfInFlight.current) return;
    const session = quoteSessionRef.current;
    // The PDF is recorded on the item it was made for, even if staff open another mail while it builds.
    const owner = currentPaneOwner();
    if (dinnerAllowanceStillRequired(session)) {
      toast.warning(dinnerAddOnInputProblem(session) ?? 'Dinner price — enter amount.');
      return;
    }
    if (isMultiStay(session)) {
      // One combined document for every stay. Until each stay is rated, the request says how many are.
      const request = combinedDocumentRequest(session);
      if (request.status === 'unavailable') {
        toast.warning(request.reason);
        return;
      }
      pdfInFlight.current = true;
      setPdfPending(true);
      const selectionEpoch = session.binding?.selectionEpoch ?? 0;
      const inputRevision = session.inputRevision;
      // The combined PDF is bound to the stays' runs, not to the selected option, so selecting another option while it
      // builds keeps it.
      const selectedOfferIds = [
        request.input.revisionRef,
        ...(request.input.additionalStays ?? []).map((stay) => stay.revisionRef),
      ];
      const staff = staffQuoteFromTrpc(trpcClient);
      void bindQualifiedStaffProposalPdf({
        mutate: staff.workstation.qualifiedQuoteProposalPdf?.mutate,
        input: withContactLines(request.input, documentContactRef.current),
        expectedTotalMinor: request.expectedTotalMinor,
      }).then((remote) => {
        if (remote.status === 'unavailable') {
          toast.warning(remote.reason);
          return;
        }
        dispatchQuote({
          type: 'pdf_ready',
          pdf: {
            fileName: remote.pdf.fileName,
            bytesBase64: remote.pdf.pdfBase64,
            pdfHash: remote.pdf.pdfHash,
            revisionId: remote.pdf.revisionId,
            totalMinor: remote.pdf.totalMinor,
          },
          selectionEpoch,
          inputRevision,
          selectedOfferIds,
        });
        trackPaneAction({ type: 'pdf.created', kind: 'combined' }, owner);
      }).finally(() => {
        pdfInFlight.current = false;
        setPdfPending(false);
      });
      return;
    }
    const key = stayKey ?? session.selectedStayKey;
    const quote = key ? (session.staffQuotes[key] ?? null) : null;
    const source = session.staffSource;
    const authorised =
      staffSourceReady(session) &&
      session.evidence?.kind === 'authorised' &&
      evidenceMatchesSession(session);
    if (!quote || !key) {
      toast.warning('The quote is not ready for a PDF yet. Run the search again, then prepare the PDF.');
      return;
    }
    if (isQuoteFixturePreview() || !authorised) {
      toast.warning('This is sample data, so no PDF can be made. Open a live email to continue.');
      return;
    }
    if (key === session.selectedStayKey && !canCreatePdf(session)) {
      toast.warning('Pick a room option from the HMS results before making the PDF.');
      return;
    }
    if (!source || quote.totalMinor <= 0) {
      toast.warning('The quote is not ready for a PDF yet. Run the search again, then prepare the PDF.');
      return;
    }
    const header = quote.approvedHeader;
    if (!header) {
      toast.warning('The quote header was not saved with this quote. Run the search again, then prepare the PDF.');
      return;
    }
    if (key !== session.selectedStayKey) dispatchQuote({ type: 'select_stay_key', stayKey: key });
    const selectionEpoch = session.binding?.selectionEpoch ?? 0;
    const inputRevision = session.inputRevision;
    const selectedOfferIds = [quote.revisionRef];
    const greetingName = replyGreetingName(documentContactRef.current?.name, activeEmail);
    const reviewedReplyHtml = session.analysis?.intent === 'quote'
      ? quoteWrapperHtml(greetingName, staffSignerName, {
          ...(quote.dinnerAddOn ? { dinnerAddOn: quote.dinnerAddOn } : {}),
          totalMinor: quote.totalMinor,
          propertyCode: activePaneConfig?.propertyCode,
        })
      : undefined;
    const staff = staffQuoteFromTrpc(trpcClient);
    pdfInFlight.current = true;
    setPdfPending(true);
    void bindQualifiedStaffProposalPdf({
      mutate: staff.workstation.qualifiedQuoteProposalPdf?.mutate,
      input: {
        workflowRunId: quote.workflowRunId,
        revisionRef: quote.revisionRef,
        messageId: source.messageId,
        outlookEmail: session.binding?.mailboxEmail ?? '',
        factRefs: quote.factRefs,
        company: header.company,
        agency: header.agency,
        ...withContactLines(
          { attention: header.attention, clientEmail: header.clientEmail, clientTelephone: header.clientTelephone },
          documentContactRef.current,
        ),
        ...(header.notes ? { notes: header.notes } : {}),
      },
      expectedTotalMinor: quote.totalMinor,
    }).then((remote) => {
      if (remote.status === 'unavailable') {
        toast.warning(remote.reason);
        return;
      }
      dispatchQuote({
        type: 'pdf_ready',
        pdf: {
          fileName: remote.pdf.fileName,
          bytesBase64: remote.pdf.pdfBase64,
          pdfHash: remote.pdf.pdfHash,
          revisionId: remote.pdf.revisionId,
          totalMinor: remote.pdf.totalMinor,
        },
        selectionEpoch,
        inputRevision,
        selectedOfferIds,
        reviewedReplyHtml,
      });
      trackPaneAction({ type: 'pdf.created', kind: 'option' }, owner);
    }).finally(() => {
      pdfInFlight.current = false;
      setPdfPending(false);
    });
  };

  return { pdfPending, preparePdfFor };
}
