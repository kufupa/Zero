/** Native quote reads are bounded by the server; ordinary requests stay short. */
export function trpcRequestTimeoutMs(input: RequestInfo | URL): number {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const pathname = new URL(raw, 'https://timeout.invalid').pathname;
    const routes = decodeURIComponent(pathname.split('/').at(-1) ?? '').split(',');
    if (routes.includes('workstation.executeStaffQuote')) return 20 * 60_000;
    if (routes.includes('quoteWorkflow.analyseSelection')) return 45_000;
    if (
      routes.includes('workstation.qualifiedQuoteProposalPdf') ||
      routes.includes('workstation.quoteProposalPdf') ||
      routes.includes('workstation.prepareBookingDraft') ||
      routes.includes('workstation.usePriorQuoteForBooking')
    )
      return 60_000;
  } catch {
    // Malformed URLs do not receive an extended deadline.
  }
  return 5_000;
}
