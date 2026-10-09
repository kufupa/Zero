import { FIXTURE_PDF } from './fixtures';
import { canCreateNativeDraft } from './session';
import type { QuotePdf, QuoteSession } from './types';

export function requireReviewedNativeDraft(session: QuoteSession): {
  html: string;
  pdf: { fileName: string; pdfBase64: string };
} | null {
  const html = session.reviewedReplyHtml.trim();
  if (!session.pdf || !html) return null;
  if (!canCreateNativeDraft(session)) return null;
  if (session.pdf.fileName === FIXTURE_PDF.fileName) return null;
  return {
    html: withStaffNote(html, session.staffHeader?.notes),
    pdf: { fileName: session.pdf.fileName, pdfBase64: session.pdf.bytesBase64 },
  };
}

/** The unpriced staff note goes into the reply as its own escaped paragraph, as it does on the PDF. */
function withStaffNote(html: string, notes: string | undefined): string {
  const note = notes?.trim();
  if (!note) return html;
  const escaped = note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
  return `${html}<p><strong>Note:</strong> ${escaped}</p>`;
}

export function selectedQuotePdf(session: QuoteSession): QuotePdf | null {
  return session.pdf;
}
