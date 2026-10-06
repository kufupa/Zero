import { describe, expect, it } from 'vitest';
import { ConservativePaidLedger, validatedRequestReservation } from '../src/ai/reservationist-reserved-cost.js';

const authorization = { source: 'synthetic-user-authorization', startedAt: '2026-10-04T22:00:00Z', expiresAt: '2026-10-05T06:00:00Z', cumulativeCapUsd: 25 };
const now = () => Date.parse('2026-10-04T23:00:00Z');
const bound = { maxInputTokens: 922000, maxOutputTokens: 32768, inputUsdPerMillion: .3, outputUsdPerMillion: .9, sourceHash: 'a'.repeat(64), version: 'synthetic-provider-ceiling' };

describe('explicit conservative continuation accounting', () => {
  it('requires an explicit finite changed ceiling and preserves old usage and reservations', () => {
    const prior = [{requestId:'unknown',reservedUsd:.3060912,estimatedUsd:null,state:'failed_unknown' as const}], auth={...authorization,cumulativeCapUsd:30};
    expect(()=>new ConservativePaidLedger(auth,prior,now)).toThrow(/authorization/);
    const ledger=new ConservativePaidLedger(auth,prior,now,30);ledger.reserve('new',.3060912);ledger.settle('new',.01);
    expect(ledger.snapshot()).toMatchObject({accountedUsd:.3160912,actualCostUnknown:true});
    expect(ledger.snapshot().attempts[0]).toEqual(prior[0]);
    expect(()=>new ConservativePaidLedger(auth,prior,now,Infinity)).toThrow(/authorization/);
  });
  it('retains unknown actual cost and debits the full failed reservation while allowing a bounded next request', () => {
    const reserve = validatedRequestReservation(bound);
    const ledger = new ConservativePaidLedger(authorization, [{ requestId: 'prior', reservedUsd: reserve, estimatedUsd: null, state: 'failed_unknown' }], now);
    expect(ledger.snapshot()).toMatchObject({ actualCostUnknown: true, accountedUsd: .3060912 });
    ledger.reserve('next', reserve);
    ledger.settle('next', .001);
    expect(ledger.snapshot()).toMatchObject({ actualCostUnknown: true, accountedUsd: .3070912 });
    expect(ledger.snapshot().attempts[0]?.estimatedUsd).toBeNull();
  });
  it('counts unresolved dispatched reservations on resume, without renewing the cumulative cap', () => {
    const ledger = new ConservativePaidLedger(authorization, [{ requestId: 'pending', reservedUsd: 24.9, estimatedUsd: null, state: 'reserved' }], now);
    expect(() => ledger.reserve('next', .2)).toThrow(/cap/);
    expect(ledger.snapshot().accountedUsd).toBe(24.9);
  });
  it('preserves every failed request and refuses duplicate or repeated settlement identities', () => {
    const ledger = new ConservativePaidLedger(authorization, [], now);
    ledger.reserve('one', .4); ledger.settle('one', null);
    expect(() => ledger.reserve('one', .4)).toThrow(/identity/);
    expect(() => ledger.settle('one', 0)).toThrow(/settled/);
    expect(ledger.snapshot().attempts).toEqual([{ requestId: 'one', reservedUsd: .4, estimatedUsd: null, state: 'failed_unknown' }]);
  });
  it('refuses reported spend beyond the validated reservation and keeps its full debit', () => {
    const ledger = new ConservativePaidLedger(authorization, [], now);
    ledger.reserve('one', .4);
    expect(() => ledger.settle('one', .5)).toThrow(/bound/);
    expect(ledger.snapshot()).toMatchObject({ actualCostUnknown: true, accountedUsd: .4, boundViolated: true });
    expect(() => ledger.reserve('two', .1)).toThrow(/bound/);
  });
  it.each([NaN, Infinity, -1, 0])('rejects nonfinite or nonpositive reservation %s', value => {
    const ledger = new ConservativePaidLedger(authorization, [], now);
    expect(() => ledger.reserve('bad', value)).toThrow();
  });
  it('refuses outside the freshly authorized window and snapshots cannot alter accounting', () => {
    const ledger = new ConservativePaidLedger(authorization, [], () => Date.parse(authorization.expiresAt));
    expect(() => ledger.reserve('late', .1)).toThrow(/window/);
    const active = new ConservativePaidLedger(authorization, [], now); active.reserve('one', .1);
    active.snapshot().attempts[0]!.reservedUsd = 0;
    expect(active.snapshot().accountedUsd).toBe(.1);
  });
  it.each(['cap', 'duration', 'source', 'duplicate', 'underreserve'])('rejects invalid authorization or imported %s evidence', kind => {
    const auth = { ...authorization }, rows = [{ requestId: 'one', reservedUsd: .1, estimatedUsd: .01, state: 'reported' as const }];
    if (kind === 'cap') auth.cumulativeCapUsd = 26;
    if (kind === 'duration') auth.expiresAt = '2026-10-05T07:00:00Z';
    if (kind === 'source') auth.source = '';
    if (kind === 'duplicate') rows.push({ ...rows[0]! });
    if (kind === 'underreserve') rows[0]!.estimatedUsd = .2;
    expect(() => new ConservativePaidLedger(auth, rows, now)).toThrow();
  });
  it.each(['input', 'output', 'rate', 'source'])('requires finite provider/rate evidence for %s bound', kind => {
    const b = { ...bound };
    if (kind === 'input') b.maxInputTokens = Infinity;
    if (kind === 'output') b.maxOutputTokens = 32769;
    if (kind === 'rate') b.outputUsdPerMillion = -1;
    if (kind === 'source') b.sourceHash = 'unknown';
    expect(() => validatedRequestReservation(b)).toThrow();
  });
  it('rejects malformed imported unknown attempts instead of granting a fresh accounting ledger', () => {
    const invalid = { requestId: '', reservedUsd: 0, estimatedUsd: null, state: 'failed_unknown' as const };
    expect(() => new ConservativePaidLedger(authorization, [invalid], now)).toThrow();
  });
  it('preserves a provider-bound violation across a fresh resumed ledger', () => {
    const ledger = new ConservativePaidLedger(authorization, [], now);
    ledger.reserve('one', .1);
    expect(() => ledger.settle('one', .2)).toThrow(/bound/);
    const saved = ledger.snapshot();
    const resumed = new ConservativePaidLedger(saved.authorization, saved.attempts, now);
    expect(() => resumed.reserve('two', .1)).toThrow(/bound/);
    expect(resumed.snapshot().boundViolated).toBe(true);
  });
});

it('read-only dispatch admission preserves the reserved row and checks exact identity/state/window',()=>{let clock=Date.parse('2026-10-04T23:00:00Z');const ledger=new ConservativePaidLedger(authorization,[],()=>clock);ledger.reserve('one',.1);const before=ledger.snapshot();expect(()=>ledger.assertDispatchAllowed('one')).not.toThrow();expect(ledger.snapshot()).toEqual(before);expect(()=>ledger.assertDispatchAllowed('foreign')).toThrow(/identity|reserved/);ledger.settle('one',.01);expect(()=>ledger.assertDispatchAllowed('one')).toThrow(/reserved|state/);ledger.reserve('two',.1);clock=Date.parse(authorization.expiresAt);expect(()=>ledger.assertDispatchAllowed('two')).toThrow(/window/);expect(ledger.snapshot().attempts[1]).toMatchObject({state:'reserved',reservedUsd:.1});});
