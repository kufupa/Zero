export type RateClaim = {
  kind: 'exact' | 'ceiling' | 'budget' | 'average_daily' | 'total' | 'paid';
  amount: string;
  currency: string;
  basis: 'per_room_per_night' | 'total' | 'unknown';
  scopeDigest: string;
  taxBasis: 'gross_included' | 'exclusive' | 'unknown';
  source: { ref: string; page: number; quote: string };
  precision: number;
};
type RateTargetScope = {
  currency: string;
  scopeDigest: string;
  taxBasis: 'gross_included' | 'exclusive' | 'unknown';
  totalMinor: number;
};
export type RateComparisonTarget = RateTargetScope & ({
  basis: 'per_room_per_night';
  nightlyMinor: number[];
  quantity: number;
} | {
  basis: 'total';
  nightlyMinor?: never;
  quantity?: never;
});
export type RateComparison = {
  status: 'match' | 'mismatch' | 'cannot_check';
  agreement?: 'ceiling' | 'nightly' | 'total_only';
  differenceMinor?: number;
  roundingBoundMinor?: number;
  claim: RateClaim;
  target: RateComparisonTarget;
  reason?: string;
};
/** Reuses selected source cents. Never scrapes PMS, approves payment, or treats a budget as agreed price. */
export function compareRateClaim(claim: RateClaim, target: RateComparisonTarget): RateComparison {
  const base = { claim, target };
  const cannot = (reason: string): RateComparison => ({ ...base, status: 'cannot_check', reason });
  if (
    !['exact', 'ceiling', 'budget', 'average_daily', 'total', 'paid'].includes(claim.kind) ||
    !['per_room_per_night', 'total', 'unknown'].includes(claim.basis) ||
    !['gross_included', 'exclusive', 'unknown'].includes(claim.taxBasis) ||
    !['gross_included', 'exclusive', 'unknown'].includes(target.taxBasis) ||
    !['per_room_per_night', 'total'].includes(target.basis) ||
    !claim.scopeDigest ||
    !target.scopeDigest ||
    claim.amount.length > 64 ||
    (target.basis === 'per_room_per_night' && (!Array.isArray(target.nightlyMinor) || target.nightlyMinor.length > 366)) ||
    (target.basis === 'total' && ('nightlyMinor' in target || 'quantity' in target))
  )
    return cannot('invalid_contract');
  if (
    !claim.source.ref ||
    !Number.isInteger(claim.source.page) ||
    claim.source.page < 1 ||
    !claim.source.quote.trim()
  )
    return cannot('source_missing');
  if (
    claim.currency !== target.currency ||
    claim.scopeDigest !== target.scopeDigest ||
    claim.taxBasis === 'unknown' ||
    target.taxBasis === 'unknown' ||
    claim.taxBasis !== target.taxBasis
  )
    return cannot('incompatible_scope_currency_or_tax');
  if (claim.kind === 'paid' || claim.kind === 'budget') return cannot('not_a_price_agreement');
  if (
    !Number.isInteger(claim.precision) ||
    claim.precision < 0 ||
    claim.precision > 2 ||
    !/^\d+(?:\.\d{1,2})?$/.test(claim.amount)
  )
    return cannot('amount_precision');
  const [whole, fraction = ''] = claim.amount.split('.');
  if (fraction.length !== claim.precision) return cannot('amount_precision');
  const big = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return cannot('amount_overflow');
  const amountMinor = Number(big);
  if (target.basis === 'total') {
    if (!Number.isSafeInteger(target.totalMinor) || target.totalMinor < 0) return cannot('invalid_target');
    if (claim.kind !== 'total') return cannot('nightly_target_unavailable');
    if (claim.basis !== 'total') return cannot('ambiguous_basis');
    const differenceMinor = amountMinor - target.totalMinor;
    return { ...base, status: differenceMinor === 0 ? 'match' : 'mismatch', agreement: 'total_only', differenceMinor };
  }
  if (
    !target.nightlyMinor.length ||
    !Number.isSafeInteger(target.quantity) ||
    target.quantity < 1 ||
    !Number.isSafeInteger(target.totalMinor) ||
    target.totalMinor < 0 ||
    target.nightlyMinor.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    return cannot('invalid_target');
  let totalMinor = 0;
  for (const nightlyMinor of target.nightlyMinor) {
    const lineMinor = nightlyMinor * target.quantity;
    if (!Number.isSafeInteger(lineMinor)) return cannot('invalid_target');
    totalMinor += lineMinor;
    if (!Number.isSafeInteger(totalMinor)) return cannot('invalid_target');
  }
  if (totalMinor !== target.totalMinor) return cannot('invalid_target');
  if (claim.kind === 'total') {
    if (claim.basis !== 'total') return cannot('ambiguous_basis');
    const differenceMinor = amountMinor - target.totalMinor;
    return {
      ...base,
      status: differenceMinor === 0 ? 'match' : 'mismatch',
      agreement: 'total_only',
      differenceMinor,
    };
  }
  if (claim.basis !== 'per_room_per_night') return cannot('ambiguous_basis');
  if (claim.kind === 'average_daily') {
    const count = target.nightlyMinor.length * target.quantity;
    if (!Number.isSafeInteger(count)) return cannot('amount_overflow');
    const expected = amountMinor * count;
    if (!Number.isSafeInteger(expected)) return cannot('amount_overflow');
    const doubledRoundingBound = 10 ** (2 - claim.precision) * count;
    if (!Number.isSafeInteger(doubledRoundingBound)) return cannot('amount_overflow');
    const roundingBoundMinor = doubledRoundingBound / 2,
      differenceMinor = expected - target.totalMinor;
    if (Math.abs(differenceMinor) === roundingBoundMinor)
      return cannot('rounding_boundary_unknown');
    return {
      ...base,
      status: Math.abs(differenceMinor) < roundingBoundMinor ? 'match' : 'mismatch',
      agreement: 'total_only',
      differenceMinor,
      roundingBoundMinor,
    };
  }
  const differenceMinor = amountMinor - Math.max(...target.nightlyMinor);
  if (claim.kind === 'ceiling')
    return {
      ...base,
      status: differenceMinor >= 0 ? 'match' : 'mismatch',
      agreement: 'ceiling',
      differenceMinor,
    };
  const nightlyDifferenceMinor = target.nightlyMinor.reduce((largest, n) => {
    const difference = amountMinor - n;
    return Math.abs(difference) > Math.abs(largest) ? difference : largest;
  }, 0);
  const matching = nightlyDifferenceMinor === 0;
  return {
    ...base,
    status: matching ? 'match' : 'mismatch',
    agreement: 'nightly',
    differenceMinor: nightlyDifferenceMinor,
  };
}
