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

/** The staff note as one escaped paragraph, the same wording the PDF uses. Null when there is no note. */
export function staffNoteParagraph(notes: string | undefined): string | null {
  const note = notes?.trim();
  if (!note) return null;
  const escaped = note
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
  return `<p><strong>Note:</strong> ${escaped}</p>`;
}

/**
 * Adds the staff note to a reply, once. A reply that already carries it (an edited combined reply, say) is
 * returned unchanged, so the note is never doubled.
 */
export function withStaffNote(html: string, notes: string | undefined): string {
  const paragraph = staffNoteParagraph(notes);
  return paragraph && !html.includes(paragraph) ? `${html}${paragraph}` : html;
}

export function selectedQuotePdf(session: QuoteSession): QuotePdf | null {
  return session.pdf;
}
