/** Host-owned identity of the staff-selected email. The hash and arrival time come from paneSource.resolveSource. */
export type ReservationSourceContext = {
  mailboxId: string;
  propertyId: string;
  propertySwitch?: 'HRDAV' | 'HRDAVS';
  propertySelectionEpoch?: number;
  internetMessageId: string | null;
  messageId: string;
  threadId: string | null;
  sourceHash: string;
  arrivedAt: string;
  selectionEpoch: number;
  subject: string;
  sender: string;
  receivedAt?: string;
  sourceText?: string;
  selfPreStay?: boolean;
  attachments: ReservationAttachmentView[];
};

export type ReservationAttachmentView = {
  sourceRef: string;
  name: string;
  mimeType?: string;
  size?: number;
  uploadability: 'ready' | 'checking' | 'unsupported' | 'unknown';
  detail?: string;
};

export type QuoteOutputArtifact = {
  kind: 'pdf_quote' | 'xlsx_quote'; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; bytesBase64: string;
};
export type QuoteOutput = {
  requestId: string; operationId: string; observationRef: string;
  cover: { to: string; subject: string; body: string } | null;
  artifacts: QuoteOutputArtifact[]; failures: string[]; issues: string[]; stale: boolean; inventoryDecline: boolean;
};
export type QuoteOutputResult = { status: 'saved' | 'created' | 'cancelled' | 'error' | 'unknown'; message: string; draftId?: string };

export function completeQuotePackage(output: QuoteOutput): boolean {
  return Boolean(output.cover) && output.issues.length === 0 && output.failures.length === 0 &&
    (output.inventoryDecline || (output.artifacts.some(item => item.kind === 'pdf_quote') &&
      output.artifacts.some(item => item.kind === 'xlsx_quote')));
}

export function quoteCoverHtml(body: string): string {
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}
