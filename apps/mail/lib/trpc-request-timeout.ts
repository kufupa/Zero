/** Native quote reads are bounded by the server; ordinary requests stay short. */
export function trpcRequestTimeoutMs(input: RequestInfo | URL): number {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const pathname = new URL(raw, 'https://timeout.invalid').pathname;
    const routes = decodeURIComponent(pathname.split('/').at(-1) ?? '').split(',');
    if (routes.includes('workstation.executeStaffQuote')) return 20 * 60_000;
    // voucherFind: a 15 s text read, then up to 20 s for a scanned PDF's vision read (SCANNED_PDF_VISION).
    // retryTranslation: one translation call, bounded by the server at 40 s (TRANSLATE_DEADLINE_MS).
    if (
      routes.includes('quoteWorkflow.analyseSelection') ||
      routes.includes('quoteWorkflow.voucherFind') ||
      routes.includes('workItems.retryTranslation')
    )
      return 45_000;
    // Browser runs under the hotel lock: a find or name search takes about 1-2 minutes; the server bounds it at 5.
    if (routes.includes('paneStayLookup.findStay') || routes.includes('paneStayLookup.searchGuest'))
      return 6 * 60_000;
    // The party search runs one lookup per kind (company, agency) under the same lock: the server bounds each run at
    // 150 s, so the pair stays inside this six-minute wait.
    if (routes.includes('panePartyLookup.findParty')) return 6 * 60_000;
    // A cancel run is bounded by the server at 20 minutes, so the browser waits slightly longer than that.
    if (routes.includes('paneStayCancel.previewCancel') || routes.includes('paneStayCancel.commitCancel'))
      return 21 * 60_000;
    // A pane save runs the duplicate read (up to 5 minutes) and the save (up to 20) under the hotel lock.
    if (routes.includes('quoteWorkflow.previewStay') || routes.includes('quoteWorkflow.commitStay'))
      return 27 * 60_000;
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
  } catch {
    // Malformed URLs do not receive an extended deadline.
  }
  return 5_000;
}
