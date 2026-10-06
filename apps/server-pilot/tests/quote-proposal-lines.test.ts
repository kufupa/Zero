import { describe, expect, it } from 'vitest';
import { deriveQuoteLines } from '../src/quote-proposal/quote-lines.js';

import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

describe('revision display runs', () => {
 it('groups contiguous equal-price nights and reconciles integer cents', async () => {
  const revision = await syntheticRevision(); const lines = deriveQuoteLines(revision);
  expect(lines.map(l => [l.nights, l.rateMinor, l.totalMinor])).toEqual([[1,10001,20002],[2,50000,200000]]);
  expect(lines[0]).toMatchObject({ arrivalDate: '2026-10-12', departureDate: '2026-10-13', sourceRef: 'synthetic', groupId: 'g1', description: 'Standard King · 1 adult per room · Room Only' });
  expect(lines.reduce((n,l)=>n+l.totalMinor,0)).toBe(revision.totalMinor);
 });
 it('keeps returning prices separate instead of averaging or joining nonconsecutive dates', async () => {
  expect(deriveQuoteLines(await syntheticRevision(['100.00','200.00','100.00']))).toHaveLength(3);
 });
 it('supports twelve-plus runs without renderer-capacity admission', async () => {
  expect(deriveQuoteLines(await syntheticRevision(Array.from({length:13},(_,i)=>`${100+i}.01`)))).toHaveLength(13);
 });
 it('refuses tampered totals, absent evidence and unsupported extras/overrides', async () => {
  const r = await syntheticRevision();
  expect(() => deriveQuoteLines({...r,totalMinor:r.totalMinor+1})).toThrow(/identity|total/);
  expect(() => deriveQuoteLines({...r,extras:[{amountMinor:123}]} as any)).toThrow(/unsupported/);
  expect(() => deriveQuoteLines({...r,overrides:[]} as any)).toThrow(/unsupported/);
 });
});

import { deriveAuthorizedExtraLines } from '../src/quote-proposal/quote-lines.js';
it('only suppresses proven same-person same-date meal entitlement; chargeable child breakfast remains',async()=>{
 const r=await syntheticRevision();
 const facts={revisionId:r.id,authorizationId:r.authorizationId,sourceRef:'document',sourceHash:'c'.repeat(64),extras:[{id:'meal',label:'Child breakfast',quantity:1,units:2,unitKind:'person_service' as const,unitMinor:12550,service:'breakfast',persons:[{id:'child-1',age:8}],dates:['2026-10-12','2026-10-13']}],includedEntitlements:[{sourceRef:'policy',sourceHash:'b'.repeat(64),service:'breakfast',personIds:['adult-1'],dates:['2026-10-12','2026-10-13']}]};
 expect(deriveAuthorizedExtraLines(r,facts)[0].totalMinor).toBe(25100);
 facts.includedEntitlements[0].personIds=['child-1'];
 expect(deriveAuthorizedExtraLines(r,facts)).toEqual([]);
 facts.includedEntitlements[0].dates=['2026-10-12'];
 expect(deriveAuthorizedExtraLines(r,facts)[0]).toMatchObject({units:1,totalMinor:12550});
 expect(()=>deriveAuthorizedExtraLines(r,{...facts,revisionId:'foreign'})).toThrow(/scope/);
});

