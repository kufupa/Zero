import type { QuotePdf, QuoteSession } from './types';

export function requireReviewedNativeDraft(session: QuoteSession): {
  html: string;
  pdf: { fileName: string; pdfBase64: string };
} | null {
  const html = session.reviewedReplyHtml.trim();
  if (!session.pdf || !html) return null;
  return {
    html,
    pdf: { fileName: session.pdf.fileName, pdfBase64: session.pdf.bytesBase64 },
  };
}

export function selectedQuotePdf(session: QuoteSession): QuotePdf | null {
  return session.pdf;
}
