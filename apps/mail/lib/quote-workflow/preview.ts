/** Explicit non-production preview only. Never used as live evidence. */
export function isQuoteFixturePreview(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('quotePreview') === 'fixture';
  } catch {
    return false;
  }
}
