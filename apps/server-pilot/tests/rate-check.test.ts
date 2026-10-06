import { compareRateClaim } from '../src/quote-proposal/rate-check.js';
import { describe, it, expect } from 'vitest';
const target = {
  currency: 'ZAR',
  basis: 'per_room_per_night' as const,
  scopeDigest: 'scope',
  taxBasis: 'gross_included' as const,
  nightlyMinor: [156000, 156000],
  quantity: 1,
  totalMinor: 312000,
};
const claim = {
  kind: 'ceiling' as const,
  amount: '1700.00',
  currency: 'ZAR',
  basis: 'per_room_per_night' as const,
  scopeDigest: 'scope',
  taxBasis: 'gross_included' as const,
  source: { ref: 'voucher', page: 1, quote: 'Maximum R1700.00' },
  precision: 2,
};
describe('pure source-linked rate claim comparison', () => {
  it('ceiling above source meets constraint, exact amount retains mismatch', () => {
    expect(compareRateClaim(claim, target)).toMatchObject({
      status: 'match',
      agreement: 'ceiling',
    });
    expect(compareRateClaim({ ...claim, kind: 'exact' }, target)).toMatchObject({
      status: 'mismatch',
      differenceMinor: 14000,
    });
  });
  it('ADR agrees only at total level and rounded precision derives bounds', () => {
    expect(
      compareRateClaim(
        { ...claim, kind: 'average_daily', amount: '300.00' },
        { ...target, nightlyMinor: [10000, 50000], totalMinor: 60000 },
      ),
    ).toMatchObject({ status: 'match', agreement: 'total_only' });
    expect(
      compareRateClaim(
        { ...claim, kind: 'average_daily', amount: '300', precision: 0 },
        { ...target, nightlyMinor: [10000, 50050], totalMinor: 60050 },
      ),
    ).toMatchObject({ status: 'match', roundingBoundMinor: 100 });
    expect(
      compareRateClaim(
        { ...claim, kind: 'average_daily', amount: '300', precision: 0 },
        { ...target, nightlyMinor: [10000, 50101], totalMinor: 60101 },
      ),
    ).toMatchObject({ status: 'mismatch' });
  });
  it.each(['currency', 'scope', 'tax', 'paid', 'budget', 'source'])(
    'cannot certify incompatible %s claims',
    (kind) => {
      const c = structuredClone(claim);
      if (kind === 'currency') c.currency = 'USD';
      if (kind === 'scope') c.scopeDigest = 'other';
      if (kind === 'tax') c.taxBasis = 'unknown' as any;
      if (kind === 'paid') c.kind = 'paid' as any;
      if (kind === 'budget') c.kind = 'budget' as any;
      if (kind === 'source') c.source.quote = '';
      expect(compareRateClaim(c, target).status).toBe('cannot_check');
    },
  );
  it('one cent matters for an exact total', () => {
    expect(
      compareRateClaim({ ...claim, kind: 'total', basis: 'total', amount: '3120.01' }, target),
    ).toMatchObject({ status: 'mismatch', differenceMinor: 1 });
  });
});
it('does not certify unknown runtime kinds, empty scopes or non-nightly targets', () => {
  expect(compareRateClaim({ ...claim, kind: 'instruction' } as any, target).status).toBe(
    'cannot_check',
  );
  expect(
    compareRateClaim({ ...claim, scopeDigest: '' }, { ...target, scopeDigest: '' }).status,
  ).toBe('cannot_check');
  expect(compareRateClaim(claim, { ...target, basis: 'total' } as any).status).toBe('cannot_check');
});
it('keeps both ADR half-unit boundaries uncertain without a sourced rounding convention', () => {
  for (const totalMinor of [60001, 59999])
    expect(
      compareRateClaim(
        { ...claim, kind: 'average_daily', amount: '300.00' },
        { ...target, nightlyMinor: [10000, totalMinor - 10000], totalMinor },
      ).status,
    ).toBe('cannot_check');
});
it('refuses unsafe intermediate target totals and ADR unit counts', () => {
  expect(compareRateClaim({ ...claim, kind: 'total', basis: 'total', amount: '0.00' }, {
    ...target, nightlyMinor: [Number.MAX_SAFE_INTEGER, 1], totalMinor: 0,
  })).toMatchObject({ status: 'cannot_check', reason: 'invalid_target' });
  expect(compareRateClaim({ ...claim, kind: 'average_daily', amount: '0.00' }, {
    ...target, nightlyMinor: [0, 0], quantity: Number.MAX_SAFE_INTEGER, totalMinor: 0,
  })).toMatchObject({ status: 'cannot_check', reason: 'amount_overflow' });
});
it('reports the largest signed nightly discrepancy even when one night matches', () => {
  expect(compareRateClaim({ ...claim, kind: 'exact', amount: '1700.00' }, {
    ...target, nightlyMinor: [170000, 150000], totalMinor: 320000,
  })).toMatchObject({ status: 'mismatch', agreement: 'nightly', differenceMinor: 20000 });
  expect(compareRateClaim({ ...claim, kind: 'exact', amount: '1700.00' }, {
    ...target, nightlyMinor: [169000, 180000], totalMinor: 349000,
  })).toMatchObject({ status: 'mismatch', differenceMinor: -10000 });
});
it('refuses multiplication overflow and rounding-bound overflow while retaining exact safe totals', () => {
  expect(compareRateClaim(claim, {
    ...target, nightlyMinor: [Number.MAX_SAFE_INTEGER], quantity: 2, totalMinor: 0,
  })).toMatchObject({ status: 'cannot_check', reason: 'invalid_target' });
  expect(compareRateClaim({ ...claim, kind: 'average_daily', amount: '0', precision: 0 }, {
    ...target, nightlyMinor: [0], quantity: Number.MAX_SAFE_INTEGER, totalMinor: 0,
  })).toMatchObject({ status: 'cannot_check', reason: 'amount_overflow' });
  expect(compareRateClaim({ ...claim, kind: 'total', basis: 'total', amount: '90071992547409.91' }, {
    ...target, nightlyMinor: [Number.MAX_SAFE_INTEGER - 1, 1], totalMinor: Number.MAX_SAFE_INTEGER,
  })).toMatchObject({ status: 'match', differenceMinor: 0 });
});

const totalTarget={currency:'ZAR',basis:'total' as const,scopeDigest:'scope',taxBasis:'gross_included' as const,totalMinor:312000};
const totalClaim={...claim,kind:'total' as const,basis:'total' as const,amount:'3120.00',source:{ref:'source-letter',page:1,quote:'Total ZAR 3120.00'}};
describe('sourced total-only comparison targets',()=>{
 it('matches an exact sourced total without inventing nightly units',()=>{
  const result=compareRateClaim(totalClaim,totalTarget);expect(result).toMatchObject({status:'match',agreement:'total_only',differenceMinor:0,target:totalTarget});expect(result.target).not.toHaveProperty('nightlyMinor');expect(result.target).not.toHaveProperty('quantity');
 });
 it('retains one-cent total mismatches without ADR rounding tolerance',()=>{
  expect(compareRateClaim({...totalClaim,amount:'3120.01'},totalTarget)).toMatchObject({status:'mismatch',agreement:'total_only',differenceMinor:1});
  expect(compareRateClaim({...totalClaim,amount:'3119.99'},totalTarget)).toMatchObject({status:'mismatch',agreement:'total_only',differenceMinor:-1});
 });
 it.each(['exact','average_daily','ceiling'])('cannot certify %s without actual nightly observations',kind=>{
  const result=compareRateClaim({...claim,kind:kind as any},totalTarget);expect(result).toMatchObject({status:'cannot_check',reason:'nightly_target_unavailable'});expect(result).not.toHaveProperty('agreement');
 });
 it('cannot certify a total claim whose basis remains nightly',()=>{
  expect(compareRateClaim({...totalClaim,basis:'per_room_per_night'},totalTarget)).toMatchObject({status:'cannot_check',reason:'ambiguous_basis'});
 });
 it.each(['currency','scope','unknown_tax','different_tax','source','paid','budget'])('preserves %s authority and compatibility guard',kind=>{
  const c=structuredClone(totalClaim) as any;if(kind==='currency')c.currency='USD';if(kind==='scope')c.scopeDigest='foreign';if(kind==='unknown_tax')c.taxBasis='unknown';if(kind==='different_tax')c.taxBasis='exclusive';if(kind==='source')c.source.quote='';if(kind==='paid')c.kind='paid';if(kind==='budget')c.kind='budget';expect(compareRateClaim(c,totalTarget).status).toBe('cannot_check');
 });
 it.each([-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])('rejects invalid source total %s',totalMinor=>{
  expect(compareRateClaim(totalClaim,{...totalTarget,totalMinor} as any)).toMatchObject({status:'cannot_check',reason:'invalid_target'});
 });
 it('compares safe integer totals without unsafe multiplication',()=>{
  expect(compareRateClaim({...totalClaim,amount:'90071992547409.91'},{...totalTarget,totalMinor:Number.MAX_SAFE_INTEGER} as any)).toMatchObject({status:'match',agreement:'total_only',differenceMinor:0});
 });
 it('rejects disguised nightly fields on a total-only target',()=>{
  expect(compareRateClaim(totalClaim,{...totalTarget,nightlyMinor:[312000],quantity:1} as any)).toMatchObject({status:'cannot_check',reason:'invalid_contract'});
 });
});

