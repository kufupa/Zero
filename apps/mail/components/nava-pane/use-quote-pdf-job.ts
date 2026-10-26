import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';

import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import { withContactLines } from '@/lib/quote-workflow/document-contact';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { quoteWrapperHtml } from '@/lib/quote-proposal/copy';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { combinedDocumentRequest, workbookRequestFor } from '@/lib/quote-workflow/quote-workbook-download';
import {
  canCreatePdf,
  dinnerAddOnInputProblem,
  dinnerAllowanceStillRequired,
  evidenceMatchesSession,
  isMultiStay,
  staffSourceReady,
} from '@/lib/quote-workflow/session';
import {
  bindQualifiedStaffProposalPdf,
  type QualifiedStaffPdfInput,
} from '@/lib/quote-workflow/staff-quote-bind';
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
  quoteSession: QuoteSession;
  quoteSessionRef: MutableRef<QuoteSession>;
  documentContact: StoredContact | null;
  documentContactRef: MutableRef<StoredContact | null>;
  dispatchQuote: Dispatch<QuoteSessionAction>;
  activeEmail: PaneBridge['activeEmail'];
  activeTransportId: string | null;
  staffSignerName: string;
  activePaneConfig: QuotePaneConfig | null;
  replyGreetingName: ReplyGreetingName;
  workItemId: string | null;
  transportId: string | null;
};

type PdfJobOwner = { workItemId: string; transportId: string };
type PdfJobQueryInput = Pick<
  QualifiedStaffPdfInput,
  'revisionRef' | 'additionalStays' | 'attention' | 'company' | 'clientEmail' | 'clientTelephone' | 'agency' | 'notes'
> & { workItemId: string };

const PDF_JOB_POLL_MS = 3_000;
const PDF_JOB_MAX_POLLS = 180;

function quotePdfJobQueryInput(input: QualifiedStaffPdfInput, workItemId: string): PdfJobQueryInput {
  return {
    workItemId,
    revisionRef: input.revisionRef,
    ...(input.additionalStays?.length ? { additionalStays: input.additionalStays } : {}),
    attention: input.attention,
    company: input.company,
    clientEmail: input.clientEmail,
    clientTelephone: input.clientTelephone,
    agency: input.agency,
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function emailKey(email: PaneBridge['activeEmail']): string {
  return email
    ? JSON.stringify([email.storeId ?? null, email.folderEntryId ?? null, email.entryId, email.internetMessageId ?? null])
    : 'null';
}

function bindingMatchesEmail(
  session: QuoteSession,
  activeEmail: PaneBridge['activeEmail'],
  activeTransportId: string | null,
): boolean {
  const binding = session.binding;
  return Boolean(
    binding && activeEmail && binding.transportId === activeTransportId && binding.entryId === activeEmail.entryId &&
      (!activeEmail.storeId || binding.storeId === activeEmail.storeId) &&
      (!activeEmail.folderEntryId || binding.folderEntryId === activeEmail.folderEntryId) &&
      (!activeEmail.internetMessageId || binding.internetMessageId === activeEmail.internetMessageId),
  );
}

function pdfScopeKey(
  session: QuoteSession,
  input: QualifiedStaffPdfInput,
  workItemId: string | null,
  transportId: string | null,
  activeEmail: PaneBridge['activeEmail'],
): string {
  const binding = session.binding;
  return JSON.stringify([
    workItemId,
    transportId,
    emailKey(activeEmail),
    binding
      ? [binding.transportId, binding.storeId, binding.folderEntryId, binding.entryId, binding.internetMessageId ?? null, binding.scopeEpoch]
      : null,
    session.inputRevision,
    binding?.selectionEpoch ?? 0,
    session.staffSource?.messageId ?? null,
    session.staffSource?.sourceHash ?? null,
    quotePdfJobQueryInput(input, workItemId ?? ''),
  ]);
}

function pdfRequestKey(input: QualifiedStaffPdfInput, workItemId: string | null, transportId: string | null): string {
  return JSON.stringify([workItemId, transportId, quotePdfJobQueryInput(input, workItemId ?? '')]);
}

function qualifiedPdfMutation(owner: PdfJobOwner | null, transportId: string | null) {
  const mutate = trpcClient.workstation.qualifiedQuoteProposalPdf?.mutate;
  if (!mutate) return undefined;
  return (input: QualifiedStaffPdfInput) =>
    mutate(
      { ...input, ...(owner ? { workItemId: owner.workItemId } : {}) },
      inMailbox(owner?.transportId ?? transportId),
    );
}

function reviewedReplyFor(args: {
  session: QuoteSession;
  staffQuote: QuoteSession['staffQuote'];
  contact: StoredContact | null;
  activeEmail: PaneBridge['activeEmail'];
  staffSignerName: string;
  activePaneConfig: QuotePaneConfig | null;
  replyGreetingName: ReplyGreetingName;
}): string | undefined {
  if (args.session.analysis?.intent !== 'quote' || isMultiStay(args.session)) return undefined;
  const quote = args.staffQuote ?? args.session.staffQuote;
  if (!quote) return undefined;
  return quoteWrapperHtml(
    args.replyGreetingName(args.contact?.name, args.activeEmail),
    args.staffSignerName,
    {
      ...(quote.dinnerAddOn ? { dinnerAddOn: quote.dinnerAddOn } : {}),
      totalMinor: quote.totalMinor,
      propertyCode: args.activePaneConfig?.propertyCode,
    },
  );
}

export function useQuotePdfJob({
  quoteSession,
  quoteSessionRef,
  documentContact,
  documentContactRef,
  dispatchQuote,
  activeEmail,
  activeTransportId,
  staffSignerName,
  activePaneConfig,
  replyGreetingName,
  workItemId,
  transportId,
}: UseQuotePdfJobArgs) {
  // Only one quote PDF request at a time, for single- and multi-stay quotes.
  const pdfInFlight = useRef(false);
  const [pdfPending, setPdfPending] = useState(false);
  const [pdfRestoring, setPdfRestoring] = useState(false);
  const restoreInFlight = useRef(false);
  const lastPdfKey = useRef<string | null>(null);
  const latest = useRef({ workItemId, transportId, quoteSessionRef, documentContactRef, activeEmail, activeTransportId });
  latest.current = { workItemId, transportId, quoteSessionRef, documentContactRef, activeEmail, activeTransportId };

  const stillCurrent = (snapshot: string): boolean => {
    const current = latest.current;
    const session = current.quoteSessionRef.current;
    if (!bindingMatchesEmail(session, current.activeEmail, current.activeTransportId)) return false;
    const currentRequest = workbookRequestFor(session);
    if (currentRequest.status !== 'ok') return false;
    const currentInput = withContactLines(currentRequest.input, current.documentContactRef.current);
    return pdfScopeKey(session, currentInput, current.workItemId, current.transportId, current.activeEmail) === snapshot;
  };

  useEffect(() => {
    setPdfRestoring(false);
    restoreInFlight.current = false;
    const owner = workItemId && transportId ? { workItemId, transportId } : null;
    if (
      !owner ||
      owner.transportId !== activeTransportId ||
      !bindingMatchesEmail(quoteSession, activeEmail, activeTransportId)
    ) return;
    const request = workbookRequestFor(quoteSession);
    if (request.status !== 'ok') return;
    const contact = documentContactRef.current;
    const input = withContactLines(request.input, contact);
    const queryInput = quotePdfJobQueryInput(input, owner.workItemId);
    const snapshot = pdfScopeKey(quoteSession, input, workItemId, transportId, activeEmail);
    const requestKey = pdfRequestKey(input, workItemId, transportId);
    const selectionEpoch = quoteSession.binding?.selectionEpoch ?? 0;
    const inputRevision = quoteSession.inputRevision;
    if (quoteSession.pdf && lastPdfKey.current === requestKey) return;
    const query = trpcClient.workstation.quotePdfJob?.query;
    if (!query) return;
    const selectedOfferIds = input.additionalStays?.length
      ? [input.revisionRef, ...input.additionalStays.map((stay) => stay.revisionRef)]
      : [input.revisionRef];
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishRestore = () => {
      restoreInFlight.current = false;
      setPdfRestoring(false);
    };
    const poll = async () => {
      if (cancelled) return;
      const job = await query(queryInput, inMailbox(owner.transportId)).catch(() => null);
      if (cancelled) return;
      if (!stillCurrent(snapshot)) {
        finishRestore();
        return;
      }
      if (job?.result) {
        // Reuse the PDF integrity/revision checks against stored bytes; this callback does not call the PDF mutation.
        const restored = await bindQualifiedStaffProposalPdf({
          mutate: async () => ({
            revisionId: job.result!.revisionId,
            pdfHash: job.result!.pdfHash,
            fileName: job.result!.fileName,
            pdfBase64: job.result!.pdfBase64,
            totalMinor: job.result!.totalMinor,
          }),
          input,
          expectedTotalMinor: request.expectedTotalMinor,
        });
        if (cancelled) return;
        if (!stillCurrent(snapshot)) {
          finishRestore();
          return;
        }
        if (restored.status === 'ok') {
          lastPdfKey.current = requestKey;
          dispatchQuote({
            type: 'pdf_ready',
            pdf: {
              fileName: restored.pdf.fileName,
              bytesBase64: restored.pdf.pdfBase64,
              pdfHash: restored.pdf.pdfHash,
              revisionId: restored.pdf.revisionId,
              totalMinor: restored.pdf.totalMinor,
            },
            selectionEpoch,
            inputRevision,
            selectedOfferIds,
            reviewedReplyHtml: reviewedReplyFor({
              session: quoteSession,
              staffQuote: quoteSession.staffQuote,
              contact,
              activeEmail,
              staffSignerName,
              activePaneConfig,
              replyGreetingName,
            }),
          });
        } else {
          toast.warning(restored.reason);
        }
        finishRestore();
        return;
      }
      if (
        job &&
        (job.state === 'queued' || job.state === 'claimed' || job.state === 'running' || job.state === 'retry_wait')
      ) {
        restoreInFlight.current = true;
        setPdfRestoring(true);
        if (++polls < PDF_JOB_MAX_POLLS) timer = setTimeout(() => void poll(), PDF_JOB_POLL_MS);
        else finishRestore();
        return;
      }
      finishRestore();
    };
    restoreInFlight.current = true;
    setPdfRestoring(true);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      restoreInFlight.current = false;
    };
  }, [
    quoteSession,
    documentContact?.name,
    documentContact?.company,
    documentContact?.endClient,
    documentContact?.email,
    documentContact?.phone,
    workItemId,
    transportId,
    activeEmail?.entryId,
    activeEmail?.storeId,
    activeEmail?.folderEntryId,
    activeEmail?.internetMessageId,
    activeEmail?.senderName,
    activeEmail?.senderEmail,
    activeTransportId,
    staffSignerName,
    activePaneConfig?.propertyCode,
    replyGreetingName,
    dispatchQuote,
  ]);

  /**
   * Builds the quotation PDF for one date option from that option's own run.
   * A null stayKey means the selected option (the "Prepare quotation PDF" button).
   */
  const preparePdfFor = (stayKey: string | null) => {
    if (pdfInFlight.current || restoreInFlight.current) return;
    const session = quoteSessionRef.current;
    const owner = workItemId && transportId ? { workItemId, transportId } : null;
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
      const input = withContactLines(request.input, documentContactRef.current);
      const snapshot = pdfScopeKey(session, input, workItemId, transportId, activeEmail);
      void bindQualifiedStaffProposalPdf({
        mutate: qualifiedPdfMutation(owner, activeTransportId),
        input,
        expectedTotalMinor: request.expectedTotalMinor,
      }).then((remote) => {
        if (!stillCurrent(snapshot)) return;
        if (remote.status === 'unavailable') {
          toast.warning(remote.reason);
          return;
        }
        lastPdfKey.current = pdfRequestKey(input, workItemId, transportId);
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
    const reviewedReplyHtml = reviewedReplyFor({
      session,
      staffQuote: quote,
      contact: documentContactRef.current,
      activeEmail,
      staffSignerName,
      activePaneConfig,
      replyGreetingName,
    });
    const input: QualifiedStaffPdfInput = {
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
    };
    const snapshot = pdfScopeKey(session, input, workItemId, transportId, activeEmail);
    pdfInFlight.current = true;
    setPdfPending(true);
    void bindQualifiedStaffProposalPdf({
      mutate: qualifiedPdfMutation(owner, activeTransportId),
      input,
      expectedTotalMinor: quote.totalMinor,
    }).then((remote) => {
      if (!stillCurrent(snapshot)) return;
      if (remote.status === 'unavailable') {
        toast.warning(remote.reason);
        return;
      }
      lastPdfKey.current = pdfRequestKey(input, workItemId, transportId);
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

  return { pdfPending: pdfPending || pdfRestoring, preparePdfFor };
}
