import { triggerBlobDownload } from '../attachment-access';
import { canCreatePdf, dinnerAllowanceStillRequired, evidenceMatchesSession, staffSourceReady } from './session';
import type { QualifiedStaffPdfInput, QualifiedStaffWorkbookResult } from './staff-quote-bind';
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
  if (dinnerAllowanceStillRequired(session.staffHeader)) {
    return unavailable('Enter the dinner allowance per person per night before downloading the Excel.');
  }
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
    },
    expectedTotalMinor: quote.totalMinor,
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
    });
    const bytes = bytesFromBase64(result?.xlsxBase64 ?? '');
    const matches =
      !!result &&
      typeof result.fileName === 'string' &&
      /^Quote - .+\.xlsx$/.test(result.fileName) &&
      result.revisionId === args.input.revisionRef &&
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

/** The "Download Excel" handler: checks the approved quote, asks the server, and saves the file. */
export async function downloadStaffQuoteWorkbook(args: {
  session: QuoteSession;
  mutate?: (input: QualifiedStaffPdfInput) => Promise<QualifiedStaffWorkbookResult>;
  notify?: (message: string) => void;
  download?: (blob: Blob, fileName: string) => void;
}): Promise<void> {
  const request = workbookRequestFor(args.session);
  if (request.status === 'unavailable') {
    args.notify?.(request.reason);
    return;
  }
  const bound = await bindQualifiedStaffWorkbook({
    mutate: args.mutate,
    input: request.input,
    expectedTotalMinor: request.expectedTotalMinor,
    download: args.download,
  });
  if (bound.status === 'unavailable') args.notify?.(bound.reason);
}
