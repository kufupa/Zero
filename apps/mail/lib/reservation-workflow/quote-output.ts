import type { ReservationPaneSnapshot, ReservationSourceContext } from './types';
import { requestPath, valueAt } from './views';

export type QuoteOutputArtifact = {
  kind: 'pdf_quote' | 'xlsx_quote'; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; bytesBase64: string;
};
export type QuoteOutput = {
  requestId: string; operationId: string; observationRef: string;
  cover: { to: string; subject: string; body: string } | null;
  artifacts: QuoteOutputArtifact[]; failures: string[]; issues: string[]; stale: boolean;
};
export type QuoteOutputResult = { status: 'saved' | 'created' | 'cancelled' | 'error' | 'unknown'; message: string };
const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Only durable host-generated output, attached to this source and generation, is eligible. */
export function getQuoteOutput(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot | null,
  requestId: string, operationId?: string): QuoteOutput | null {
  if (!snapshot) return null;
  const draft = snapshot.session.draft;
  if (!source.mailboxId || !source.threadId || draft.transportId !== source.mailboxId ||
      draft.propertyCode !== source.propertyId || draft.source.messageId !== source.messageId ||
      draft.source.threadId !== source.threadId || draft.source.sourceHash !== source.sourceHash ||
      snapshot.sourceMessageId !== source.messageId ||
      !draft.proposal.content.requests.some((request) => request.id === requestId && request.kind === 'quote')) return null;
  const operation = [...draft.operationResults].reverse().find((row) => row.requestId === requestId &&
    row.workflow === 'quote' && row.generationId === draft.generationId &&
    (row.status === 'succeeded' || row.status === 'failed') && (!operationId || row.id === operationId));
  if (!operation) return null;
  const observation = [...draft.observations].reverse().find((row) => operation.observationRefs.includes(row.ref) &&
    row.kind === 'document' && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode &&
    row.sourceMessageId === source.messageId && row.criteria.workflow === 'quote' &&
    row.criteria.requestId === requestId && row.criteria.operationId === operation.id);
  if (!observation) return null;
  const result = rec(observation.result), cover = rec(result.coverEmail);
  if (operationId && result.sourceHash !== source.sourceHash) return null;
  const raw = Array.isArray(result.artifacts) ? result.artifacts : [];
  const artifacts: QuoteOutputArtifact[] = [];
  const issues: string[] = [];
  for (const entry of raw) {
    const item = rec(entry), kind = item.kind;
    if ((kind !== 'pdf_quote' && kind !== 'xlsx_quote') || typeof item.fileName !== 'string' ||
        typeof item.mimeType !== 'string' || typeof item.sizeBytes !== 'number' ||
        typeof item.sha256 !== 'string' || typeof item.bytesBase64 !== 'string') {
      issues.push('A generated attachment is incomplete. Generate the quote again.');
      continue;
    }
    artifacts.push({ kind, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes,
      sha256: item.sha256, bytesBase64: item.bytesBase64 });
  }
  const failures = Array.isArray(result.failures) ? result.failures.filter((item): item is string => typeof item === 'string' && !!item) : [];
  const requested = valueAt(snapshot, `${requestPath(requestId)}/body/outputIntent/artifacts`);
  const outputKinds = Array.isArray(requested) ? requested : [];
  const parsedCover = typeof cover.to === 'string' && !!cover.to.trim() &&
    typeof cover.subject === 'string' && !!cover.subject.trim() && typeof cover.body === 'string' && !!cover.body.trim()
    ? { to: cover.to, subject: cover.subject, body: cover.body } : null;
  const textOnly = Array.isArray(result.artifacts) && raw.length === 0 && outputKinds.length === 1 && outputKinds[0] === 'email_quote' &&
    Array.isArray(result.outputKinds) && result.outputKinds.length === 1 && result.outputKinds[0] === 'email_quote' &&
    operation.status === 'succeeded' && observation.status === 'complete' && observation.coverage.complete &&
    failures.length === 0 && parsedCover !== null;
  if (!outputKinds.length || outputKinds.some((kind) => !['email_quote', 'pdf_quote', 'xlsx_quote'].includes(kind)) ||
      new Set(outputKinds).size !== outputKinds.length) issues.push('The requested output types are unclear. Generate the quote again.');
  if (result.sourceHash !== source.sourceHash) issues.push('The generated output no longer matches this email.');
  if (raw.length > 32 || new Set(artifacts.map((item) => item.kind)).size !== artifacts.length) issues.push('The generated attachments are ambiguous.');
  if (artifacts.some((item) => !outputKinds.includes(item.kind))) issues.push('A generated attachment was not requested. Generate the quote again.');
  if (!artifacts.length && !textOnly) issues.push('No quotation file was generated. Resolve the output failures first.');
  if (outputKinds.includes('pdf_quote') && !artifacts.some((item) => item.kind === 'pdf_quote') && !failures.some((failure) => failure.startsWith('pdf_'))) issues.push('The PDF is missing. Generate the quote again.');
  if (outputKinds.includes('xlsx_quote') && !artifacts.some((item) => item.kind === 'xlsx_quote') && !failures.some((failure) => failure.startsWith('xlsx_'))) issues.push('The Excel file is missing. Generate the quote again.');
  if (!parsedCover) issues.push('The cover reply is missing. Generate the quote again.');
  const stale = operation.draftRevision !== snapshot.session.revision;
  if (stale) issues.push('The quote changed after these files were generated. Generate the quote again.');
  return { requestId, operationId: operation.id, observationRef: observation.ref, cover: parsedCover,
    artifacts, failures, issues, stale };
}

export function quoteCoverHtml(body: string): string {
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

