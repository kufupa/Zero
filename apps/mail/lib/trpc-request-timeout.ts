/** Native quote reads are bounded by the server; ordinary requests stay short. */
export function trpcRequestTimeoutMs(input: RequestInfo | URL): number {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const pathname = new URL(raw, 'https://timeout.invalid').pathname;
    const routes = decodeURIComponent(pathname.split('/').at(-1) ?? '').split(',');
    if (routes.includes('workstation.executeStaffQuote')) return 20 * 60_000;
    // Each of these waits for the background trace of a provisional quote (QUOTE_TRACE_ASYNC=on; about 45s)
    // before it runs, then does its own work. They need 120s; the 5s default would fail right after a quote.
    if (
      routes.includes('workstation.quoteRunScreenshot') ||
      routes.includes('workstation.qualifiedProposalChoices') ||
      routes.includes('workstation.qualifiedQuoteProposalPdf') ||
      routes.includes('workstation.quoteWorkbook') ||
      routes.includes('workstation.prepareBookingDraft') ||
      routes.includes('workstation.usePriorQuoteForBooking') ||
      routes.includes('workstation.getPriorStaffQuoteRequote') ||
      routes.includes('workstation.sourceQuoteProposalPdf')
    )
      return 120_000;
    // After the 120s group, so a batch that also carries one of those routes keeps the longer deadline.
    if (routes.includes('workstation.quoteProposalPdf')) return 60_000;
    // retryTranslation: one translation call, bounded by the server at 40 s (TRANSLATE_DEADLINE_MS).
    // retryFailedRead loads the selected source and attachments before the queue returns its run id (15 s read bound).
    if (
      routes.includes('workItems.retryTranslation') ||
      routes.includes('workItems.retryFailedRead')
    )
      return 45_000;
  } catch {
    // Malformed URLs do not receive an extended deadline.
  }
  return 5_000;
}
