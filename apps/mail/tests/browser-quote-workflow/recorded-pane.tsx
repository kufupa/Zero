/** Recorded adapter acceptance only. Real panel/reducer/PDF bytes; no live PMS or Outlook. */
import { createRoot } from 'react-dom/client';
import { useReducer } from 'react';
import { QuoteWorkflowPanel } from '../../components/quote-workflow/quote-workflow-panel';
import { initialQuoteSession, reduceQuoteSession, canCreateNativeDraft } from '../../lib/quote-workflow/session';
import { bindExecuteStaffQuote, bindQualifiedStaffProposalPdf } from '../../lib/quote-workflow/staff-quote-bind';
import type { QualifiedStaffPdfResult } from '../../lib/quote-workflow/staff-quote-bind';
import { HRCEN_PROPERTY_CODE } from '../../lib/quote-workflow/types';
import type { StayGroupRequirement } from '../../lib/quote-workflow/types';

type RecordedProof = {
  approved: {
    messageId: string;
    sourceHash: string;
    groups: StayGroupRequirement[];
    company: string;
  };
  artifact: Omit<QualifiedStaffPdfResult, 'pdfBase64'>;
  revision: { scopeDigest: string };
  pdfBase64: string;
};

const proof = await fetch('/recorded-proof').then((response) =>
  response.json() as Promise<RecordedProof>,
);
const source = { messageId: proof.approved.messageId, threadId: 'recorded-thread', sourceHash: proof.approved.sourceHash };
let seed = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: {
  transportId: 'recorded-transport', mailboxEmail: 'recorded@example.invalid', storeId: 'recorded-store',
  folderEntryId: 'recorded-inbox', entryId: 'recorded-message', selectionEpoch: 1, scopeEpoch: 1,
} });
seed = reduceQuoteSession(seed, { type: 'analysis_ready', analysis: { intent: 'quote', secondaryAsks: [], alternatives: [], groups: [{
  ...proof.approved.groups[0], roomPreference: 'STWN', fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' }, specialRequests: [],
}] } });
seed = reduceQuoteSession(seed, { type: 'staff_source_ready', source });
seed = reduceQuoteSession(seed, { type: 'mailbox_status', status: 'ready' });
seed = reduceQuoteSession(seed, { type: 'patch_staff_header', header: { salesStrategy: 'Government', company: proof.approved.company, agency: '' } });

function RecordedPane() {
  const [session, dispatch] = useReducer(reduceQuoteSession, seed);
  (window as any).__recordedProof = { mode: 'recorded-authentic-artifact', notOutlook: true, noLivePms: true,
    totalMinor: session.staffQuote?.totalMinor, pdfHash: session.pdf?.pdfHash, reply: session.reviewedReplyHtml,
    canCreateNativeDraft: canCreateNativeDraft(session), phase: session.phase };
  async function run() {
    const step = session.steps[0];
    dispatch({ type: 'step_running', stepId: step.id });
    const result = await bindExecuteStaffQuote({ source, selectionEpoch: 1, inputRevision: session.inputRevision,
      groups: session.groups, header: session.staffHeader, propertyCode: HRCEN_PROPERTY_CODE,
      mutate: async input => ({ status: 'ready',
        workflowRunId: 'recorded-run', revisionRef: proof.artifact.revisionId, messageId: source.messageId,
        threadId: source.threadId, factRefs: [], selectionEpoch: input.selectionEpoch, inputRevision: input.inputRevision,
        inputDigest: proof.revision.scopeDigest, totalMinor: proof.artifact.totalMinor, currency: 'ZAR',
        arrivalDate: input.groups[0].arrivalDate, departureDate: input.groups[0].departureDate, description: 'Standard Twin · Government DBB' }) });
    if (result.status !== 'ok') throw new Error(result.reason);
    dispatch({ type: 'staff_quote_ready', offer: result.offer, staffQuote: result.staffQuote, selectionEpoch: 1, inputRevision: session.inputRevision });
  }
  async function pdf() {
    const quote = session.staffQuote!;
    const result = await bindQualifiedStaffProposalPdf({ expectedTotalMinor: quote.totalMinor,
      input: { workflowRunId: quote.workflowRunId, revisionRef: quote.revisionRef, messageId: source.messageId,
        outlookEmail: 'recorded@example.invalid', factRefs: [], ...quote.approvedHeader },
      mutate: async () => ({ ...proof.artifact, pdfBase64: proof.pdfBase64 }) });
    if (result.status !== 'ok') throw new Error(result.reason);
    dispatch({ type: 'pdf_ready', pdf: { fileName: result.pdf.fileName, bytesBase64: result.pdf.pdfBase64,
      pdfHash: result.pdf.pdfHash, revisionId: result.pdf.revisionId, totalMinor: result.pdf.totalMinor },
      selectionEpoch: 1, inputRevision: session.inputRevision, selectedOfferIds: session.selectedOfferIds });
  }
  return <div style={{ width: '100%', maxWidth: 380, margin: 'auto', padding: 8 }}>
    <p>RECORDED authentic quote/PDF. Not fresh HMS. Not Outlook. No writes or sends.</p>
    <QuoteWorkflowPanel session={session} onRunNext={run} onRunStep={run} onPreparePdf={pdf}
      onPatchGroup={(groupId, patch) => dispatch({ type: 'patch_group', groupId, patch })}
      onPatchStaffHeader={header => dispatch({ type: 'patch_staff_header', header })}
      onReplyChange={html => dispatch({ type: 'set_reviewed_reply', html })} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<RecordedPane />);
