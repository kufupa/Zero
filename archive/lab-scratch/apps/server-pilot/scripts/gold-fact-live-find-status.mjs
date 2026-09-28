/**
 * Pure helpers for gold-fact live find status / session-poison detection.
 * Kept separate so Vitest can lock the 813≠not_found rule without Playwright.
 */

export function classifyOsressResponse(searchText, parse) {
  if (parse === 'ok') return 'pagedata';
  if (/type=["']password["']/i.test(searchText)) return 'login';
  if (/loadLocalizedPage/i.test(searchText)) return 'loadLocalized';
  return searchText.slice(0, 80).replace(/\d{5,}/g, '[n]');
}

/** 813 loadLocalized / login bounce is session failure — never "not_found". */
export function statusForOsressFind({ parse, corrOutcome, responseClass, hasRoomType }) {
  if (responseClass === 'login') return 'login';
  if (responseClass === 'loadLocalized') return 'loadLocalized';
  if (parse !== 'ok') return 'error';
  if (corrOutcome === 'matched') return hasRoomType ? 'ok' : 'partial';
  if (corrOutcome === 'ambiguous') return 'ambiguous';
  if (corrOutcome === 'not_found') return 'not_found';
  return 'error';
}

export function isOsressSessionPoison(dump) {
  if (!dump || typeof dump !== 'object') return false;
  if (dump.responseClass === 'loadLocalized' || dump.status === 'loadLocalized') return true;
  if (dump.responseClass === 'login' || dump.status === 'login') return true;
  return (
    dump.parse !== 'ok' &&
    typeof dump.searchBytes === 'number' &&
    dump.searchBytes > 0 &&
    dump.searchBytes < 1000 &&
    typeof dump.ms === 'number' &&
    dump.ms < 200
  );
}

/**
 * Playwright shared-context race: session recycle closes browser while another
 * parallel ctx.request find is still in flight.
 */
export function isBrowserClosedFindError(err) {
  const msg = String(err?.message || err || '');
  return (
    /Target page, context or browser has been closed/i.test(msg) ||
    /browser has been closed/i.test(msg) ||
    /context or browser has been closed/i.test(msg)
  );
}
