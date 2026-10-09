/** Largest amount accepted for one extra, in cents (R1,000,000). Mirrors the server schema. */
export const MAX_EXTRA_AMOUNT_MINOR = 100_000_000;
export const EXTRA_AMOUNT_CAP_MESSAGE = 'Amounts above R1,000,000 are not accepted';
export const EXTRA_AMOUNT_FORMAT_MESSAGE = 'Enter an amount in rand, like 450 or 1,250.50';

export type ZarInputResult =
  /** Nothing typed: the amount is cleared. */
  | { status: 'empty' }
  /** A complete amount, in cents. */
  | { status: 'ok'; minor: number }
  /** Still typing, such as "125." or "1,0". Not committed yet. */
  | { status: 'partial' }
  | { status: 'over_cap'; message: string }
  | { status: 'invalid'; message: string };

/**
 * Reads an amount the way staff type it: "450", "R 450", "450.00", "1,000", "R1,000.50".
 * A comma is a thousands separator only in full groups of three, so "450,50" is refused rather than misread.
 */
export function parseZarInput(raw: string): ZarInputResult {
  const compact = raw.replace(/[\s\u00a0]/g, '');
  if (!compact) return { status: 'empty' };
  const body = compact.replace(/^R/i, '');
  // Still being typed: a trailing dot, or a comma group that is not complete yet.
  if (/^\d*\.$/.test(body) || /^\d{1,3},\d{0,2}$/.test(body) || /^\d{1,3}(,\d{3})+\.$/.test(body)) {
    return { status: 'partial' };
  }
  let digits: string;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(body)) digits = body.replace(/,/g, '');
  else if (/^\d+(\.\d{1,2})?$/.test(body)) digits = body;
  else return { status: 'invalid', message: EXTRA_AMOUNT_FORMAT_MESSAGE };
  const minor = Math.round(Number(digits) * 100);
  if (!Number.isSafeInteger(minor)) return { status: 'invalid', message: EXTRA_AMOUNT_FORMAT_MESSAGE };
  if (minor === 0) return { status: 'invalid', message: 'Enter an amount above zero, or leave it blank' };
  if (minor > MAX_EXTRA_AMOUNT_MINOR) return { status: 'over_cap', message: EXTRA_AMOUNT_CAP_MESSAGE };
  return { status: 'ok', minor };
}

export type CountInputResult =
  | { status: 'empty' }
  | { status: 'ok'; count: number }
  | { status: 'over_cap'; message: string }
  | { status: 'invalid'; message: string };

/** A whole number of trips or days, from 1 up to max. */
export function parseCountInput(raw: string, max: number): CountInputResult {
  const compact = raw.trim();
  if (!compact) return { status: 'empty' };
  if (!/^\d+$/.test(compact)) return { status: 'invalid', message: 'Enter a whole number' };
  const count = Number(compact);
  if (count < 1) return { status: 'invalid', message: 'Enter at least 1' };
  if (count > max) return { status: 'over_cap', message: `Up to ${max} allowed` };
  return { status: 'ok', count };
}
