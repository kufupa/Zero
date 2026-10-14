import { triggerBlobDownload } from '../attachment-access';
import { withContactLines } from './document-contact';
import {
  canCreatePdf,
  combinedStayRuns,
  dinnerAddOnInputProblem,
  dinnerAllowanceStillRequired,
  evidenceMatchesSession,
  isMultiStay,
  ratedStayCount,
  staffSourceReady,
} from './session';
import { revisionMatchesRequest, type QualifiedStaffPdfInput, type QualifiedStaffWorkbookResult } from './staff-quote-bind';
import type { QuoteSession } from './types';

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NOT_READY = 'The quote is not ready for Excel yet. Run the search again, then download the Excel.';

type Unavailable = { status: 'unavailable'; reason: string };
const unavailable = (reason: string): Unavailable => ({ status: 'unavailable', reason });

export type WorkbookRequest =
  | { status: 'ok'; input: QualifiedStaffPdfInput; expectedTotalMinor: number }
  | Unavailable;

/**
 * The approved quote the Excel comes from. It passes the same gates as the PDF, so the two files describe
 * one authority: the same selected stay, the same run, and the same approved header.
 */
export function workbookRequestFor(session: QuoteSession): WorkbookRequest {
  if (dinnerAllowanceStillRequired(session)) {
    return unavailable(dinnerAddOnInputProblem(session) ?? 'Dinner price — enter amount.');
  }
  if (isMultiStay(session)) return combinedDocumentRequest(session);
  const key = session.selectedStayKey;
  const quote = key ? (session.staffQuotes[key] ?? null) : null;
  if (!key || !quote) return unavailable(NOT_READY);
  const authorised =
    staffSourceReady(session) && session.evidence?.kind === 'authorised' && evidenceMatchesSession(session);
  if (!authorised) return unavailable('This is sample data, so no Excel can be made. Open a live email to continue.');
  if (!canCreatePdf(session)) return unavailable('Pick a room option from the HMS results before downloading the Excel.');
  const source = session.staffSource;
  if (!source || quote.totalMinor <= 0) return unavailable(NOT_READY);
  const header = quote.approvedHeader;
  if (!header) {
    return unavailable('The quote header was not saved with this quote. Run the search again, then download the Excel.');
  }
  return {
    status: 'ok',
    input: {
      workflowRunId: quote.workflowRunId,
      revisionRef: quote.revisionRef,
      messageId: source.messageId,
      outlookEmail: session.binding?.mailboxEmail ?? '',
      factRefs: quote.factRefs,
      company: header.company,
      agency: header.agency,
      attention: header.attention,
      clientEmail: header.clientEmail,
      clientTelephone: header.clientTelephone,
      ...(header.notes ? { notes: header.notes } : {}),
    },
    expectedTotalMinor: quote.totalMinor,
  };
}

/**
 * The one document for a multi-stay quote, made from every stay's current run. The first stay is the primary run and
 * each other stay goes in additionalStays. Until every stay is rated the reason is the count, e.g. "1 of 2 stays rated".
 */
export function combinedDocumentRequest(session: QuoteSession): WorkbookRequest {
  const authorised =
    staffSourceReady(session) && session.evidence?.kind === 'authorised' && evidenceMatchesSession(session);
  if (!authorised) return unavailable('This is sample data, so no quote can be made. Open a live email to continue.');
  const runs = combinedStayRuns(session);
  const source = session.staffSource;
  if (!runs || !source) {
    const { rated, total } = ratedStayCount(session);
    return unavailable(`${rated} of ${total} stays rated`);
  }
  const primary = runs[0]!;
  const header = primary.approvedHeader;
  return {
    status: 'ok',
    input: {
      workflowRunId: primary.workflowRunId,
      revisionRef: primary.revisionRef,
      messageId: source.messageId,
      outlookEmail: session.binding?.mailboxEmail ?? '',
      factRefs: primary.factRefs,
      company: header.company,
      agency: header.agency,
      attention: header.attention,
      clientEmail: header.clientEmail,
      clientTelephone: header.clientTelephone,
      ...(header.notes ? { notes: header.notes } : {}),
      additionalStays: runs.slice(1).map((run) => ({
        workflowRunId: run.workflowRunId,
        revisionRef: run.revisionRef,
        factRefs: run.factRefs,
        ...(run.approvedHeader.notes ? { notes: run.approvedHeader.notes } : {}),
      })),
    },
    expectedTotalMinor: runs.reduce((sum, run) => sum + run.totalMinor, 0),
  };
}

function bytesFromBase64(value: string): Uint8Array | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export type BoundStaffWorkbook = { status: 'ok'; fileName: string } | Unavailable;

/**
 * Asks the server for the workbook and saves it only when it matches the quote on screen: the same revision,
 * the same total, and a real xlsx package (zip magic bytes).
 */
export async function bindQualifiedStaffWorkbook(args: {
  mutate?: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffWorkbookResult>;
  input: QualifiedStaffPdfInput;
  expectedTotalMinor: number;
  download?: (blob: Blob, fileName: string) => void;
}): Promise<BoundStaffWorkbook> {
  if (!args.mutate) {
    return unavailable('Excel download is not connected to this pane yet. Refresh the pane and try again.');
  }
  try {
    const result = await args.mutate({
      workflowRunId: args.input.workflowRunId,
      revisionRef: args.input.revisionRef,
      messageId: args.input.messageId,
      outlookEmail: args.input.outlookEmail,
      factRefs: args.input.factRefs,
      attention: args.input.attention,
      company: args.input.company,
      clientEmail: args.input.clientEmail,
      clientTelephone: args.input.clientTelephone,
      agency: args.input.agency,
      ...(args.input.notes ? { notes: args.input.notes } : {}),
      ...(args.input.additionalStays?.length ? { additionalStays: args.input.additionalStays } : {}),
    });
    const bytes = bytesFromBase64(result?.xlsxBase64 ?? '');
    const matches =
      !!result &&
      typeof result.fileName === 'string' &&
      /^Quote - .+\.xlsx$/.test(result.fileName) &&
      revisionMatchesRequest(args.input, result.revisionId) &&
      Number.isSafeInteger(result.totalMinor) &&
      result.totalMinor > 0 &&
      result.totalMinor === args.expectedTotalMinor &&
      bytes !== null &&
      bytes.length > 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b;
    if (!matches || !bytes) {
      return unavailable('The Excel does not match this quote. Run the quote again, then download the Excel.');
    }
    (args.download ?? triggerBlobDownload)(new Blob([bytes], { type: XLSX_MIME_TYPE }), result.fileName);
    return { status: 'ok', fileName: result.fileName };
  } catch (error) {
    return unavailable(error instanceof Error && error.message ? error.message : 'The Excel could not be made. Try again.');
  }
}

/**
 * The "Download Excel" handler: checks the approved quote, asks the server, and saves the file. Resolves true when the
 * file was saved, so the caller can record it.
 */
export async function downloadStaffQuoteWorkbook(args: {
  session: QuoteSession;
  /** The email's contact; fills blank attention, email and telephone lines. */
  contact?: Parameters<typeof withContactLines>[1];
  mutate?: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffWorkbookResult>;
  notify?: (message: string) => void;
  download?: (blob: Blob, fileName: string) => void;
}): Promise<boolean> {
  const request = workbookRequestFor(args.session);
  if (request.status === 'unavailable') {
    args.notify?.(request.reason);
    return false;
  }
  const bound = await bindQualifiedStaffWorkbook({
    mutate: args.mutate,
    input: withContactLines(request.input, args.contact),
    expectedTotalMinor: request.expectedTotalMinor,
    download: args.download,
  });
  if (bound.status === 'unavailable') {
    args.notify?.(bound.reason);
    return false;
  }
  return true;
}
