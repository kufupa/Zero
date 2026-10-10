import {
  resolveQuoteRevision,
  assessQuoteAcceptance,
  propertyPoolBasis,
  type QuoteSourceRecord,
} from '../src/quote-proposal/quote-revision.js';
import { describe, expect, it } from 'vitest';

export function source(): QuoteSourceRecord {
  return {
    ref: 'source-1',
    sha256: 'a'.repeat(64),
    toolVersion: '2.0.0',
    observedAt: '2026-10-04T09:00:00Z',
    request: {
      requestedCurrency: 'ZAR',
      propertyCode: 'HRCEN',
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      rooms: [{ id: 'g1', quantity: 2, adults: 1, children: 0, childAges: [] }],
    },
    result: {
      outcome: 'quote',
      propertyCode: 'HRCEN',
      groups: [
        {
          id: 'g1',
          request: { id: 'g1', quantity: 2, adults: 1, children: 0, childAges: [] },
          completeness: { search: 'complete', requiredFacts: 'complete' },
          options: [
            {
              id: 'HRCEN:STQN:BAR',
              room: { code: 'STQN', label: 'Standard Queen', buildingCode: 'MAIN' },
              rate: { code: 'BAR', label: 'Best available' },
              board: 'Room Only R',
              appliedContext: {},
              eligibility: 'verified',
              availability: 'available',
              matchStatus: 'match',
              held: false,
              totals: { taxInclusive: null },
              nightly: [
                { date: '2026-10-12', inventory: 3, price: { amount: '100.01', currency: 'ZAR' } },
                { date: '2026-10-13', inventory: 3, price: { amount: '500.00', currency: 'ZAR' } },
                { date: '2026-10-14', inventory: 3, price: { amount: '500.00', currency: 'ZAR' } },
              ],
            },
          ],
        },
      ],
    },
  };
}
const policy = {
  ref: 'policy-1',
  propertyCode: 'HRCEN',
  sourceHashes: ['b'.repeat(64)],
  authoredDates: ['2026-09-26'],
  families: [{ rateCode: 'BAR', board: 'room_only' as const }],
  vat: 'included' as const,
  levy: 'included' as const,
};
function admission(records: QuoteSourceRecord[]) {
  return {
    authorizationId: 'auth-1',
    sourceEvaluationAt: '2026-10-04T10:00:00Z',
    maxSourceAgeMs: 86400000,
    expectedRequests: Object.fromEntries(records.map((r) => [r.ref, structuredClone(r.request)])),
    authorizeSource: async () => true,
  };
}
export async function revision(record = source()) {
  return resolveQuoteRevision({
    admission: admission([record]),
    propertyCode: 'HRCEN',
    selections: [{ sourceRef: record.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' }],
    authoredDate: '2026-10-04',
    resolveSource: async () => record,
    resolvePolicy: async () => policy,
  });
}
describe('server-resolved immutable nightly quote revisions', () => {
  it('request-bound resolution rejects wrong authorized stay and future source', async () => {
    const record = source();
    const input = {
      propertyCode: 'HRCEN',
      selections: [{ sourceRef: record.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' }],
      authoredDate: '2026-10-04',
      resolveSource: async () => record,
      resolvePolicy: async () => policy,
      admission: {
        authorizationId: 'auth-1',
        authorizeSource: async () => true,
        sourceEvaluationAt: '2026-10-04T10:00:00Z',
        maxSourceAgeMs: 3600000,
        expectedRequests: { 'source-1': { ...record.request, arrivalDate: '2026-10-11' } },
      },
    };
    await expect(resolveQuoteRevision(input)).rejects.toThrow(/request/);
    input.admission.expectedRequests['source-1'] = record.request;
    input.admission.sourceEvaluationAt = '2026-10-04T08:00:00Z';
    await expect(resolveQuoteRevision(input)).rejects.toThrow(/source_time/);
  });
  it('sums exact native cents times selected quantity, retains native tax unknown and commercial provenance', async () => {
    const r = await revision();
    expect(r.totalMinor).toBe(220002);
    expect(r.groups[0].perRoomMinor).toBe(110001);
    expect(r.groups[0].nativeTaxInclusive).toBeNull();
    expect(r.groups[0].inclusions.policyRef).toBe('policy-1');
    expect(r.held).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.groups[0].nightly)).toBe(true);
    expect(r.id).toMatch(/^quote:[a-f0-9]{64}$/);
  });
  it.each([
    'missing',
    'duplicate',
    'extra',
    'zero',
    'decimal',
    'currency',
    'wrong_property',
    'wrong_quantity',
    'incomplete',
    'unknown_board',
    'context',
  ])('rejects %s evidence without emitting a revision', async (kind) => {
    const s = source(),
      o = s.result.groups[0].options[0];
    if (kind === 'missing') o.nightly.pop();
    if (kind === 'duplicate') o.nightly[1] = o.nightly[0];
    if (kind === 'extra') o.nightly.push({ ...o.nightly[0], date: '2026-10-16' });
    if (kind === 'zero') o.nightly[0].price.amount = '0.00';
    if (kind === 'decimal') o.nightly[0].price.amount = '100.001';
    if (kind === 'currency') o.nightly[0].price.currency = 'USD';
    if (kind === 'wrong_property') s.result.propertyCode = 'OTHER';
    if (kind === 'wrong_quantity') s.result.groups[0].request.quantity = 1;
    if (kind === 'incomplete') s.result.groups[0].completeness.search = 'partial';
    if (kind === 'unknown_board') o.board = 'unknown';
    if (kind === 'context') s.request.rateContext = { organization: { nativeId: 'org-1' } };
    await expect(revision(s)).rejects.toThrow();
  });
  it('rejects impossible calendar dates rather than rolling February into March', async () => {
    const s = source();
    s.request.arrivalDate = '2026-02-30';
    await expect(revision(s)).rejects.toThrow(/calendar/);
  });
  it('checks joint inventory by occupied date across staggered independent sources', async () => {
    const a = source(),
      b = source();
    b.ref = 'source-2';
    b.request.rooms[0].id = 'g2';
    b.request.rooms[0].quantity = 2;
    b.result.groups[0].id = 'g2';
    b.result.groups[0].request = { ...b.request.rooms[0] };
    await expect(
      resolveQuoteRevision({
        admission: admission([a, b]),
        propertyCode: 'HRCEN',
        authoredDate: '2026-10-04',
        selections: [
          { sourceRef: a.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' },
          { sourceRef: b.ref, groupId: 'g2', optionId: 'HRCEN:STQN:BAR' },
        ],
        resolveSource: async (ref) => (ref === a.ref ? a : b),
        resolvePolicy: async () => policy,
      }),
    ).rejects.toThrow(/inventory/);
    b.request.arrivalDate = '2026-10-15';
    b.request.departureDate = '2026-10-18';
    b.result.groups[0].options[0].nightly.forEach((n, i) => (n.date = `2026-10-${15 + i}`));
    const r = await resolveQuoteRevision({
      admission: admission([a, b]),
      propertyCode: 'HRCEN',
      authoredDate: '2026-10-04',
      selections: [
        { sourceRef: a.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' },
        { sourceRef: b.ref, groupId: 'g2', optionId: 'HRCEN:STQN:BAR' },
      ],
      resolveSource: async (ref) => (ref === a.ref ? a : b),
      resolvePolicy: async () => policy,
    });
    expect(r.groups).toHaveLength(2);
  });
  it('never adds unselected alternatives', async () => {
    const s = source();
    s.result.groups[0].options.push({ ...s.result.groups[0].options[0], id: 'alternative' });
    expect((await revision(s)).totalMinor).toBe(220002);
  });
  it('preserves clearly valid unchanged agreed prices independently of current drift and never renews forwarding', async () => {
    const r = await revision();
    const proof = {
      sentProof: {
        revisionId: r.id,
        authorizationId: r.authorizationId,
        sentAt: '2026-10-04T10:00:00Z',
        sourceRef: 'sent-1',
        sourceHash: 'a'.repeat(64),
      },
      inventoryEvidence: {
        revisionId: r.id,
        scopeDigest: r.scopeDigest,
        authorizationId: r.authorizationId,
        observedAt: '2026-10-05T08:00:00Z',
        available: true,
        maxAgeMs: 86400000,
      },
    };
    expect(
      assessQuoteAcceptance({
        ...proof,
        revision: r,
        acceptedAt: '2026-10-05T10:00:00+02:00',
        scopeDigest: r.scopeDigest,
        currentTotalMinor: 999999,
        availabilityVerified: true,
      }),
    ).toMatchObject({ status: 'accepted', agreedTotalMinor: 220002 });
    expect(
      assessQuoteAcceptance({
        revision: r,
        acceptedAt: '2026-10-09T10:00:00+02:00',
        scopeDigest: r.scopeDigest,
        availabilityVerified: true,
      }),
    ).toMatchObject({ status: 'expired' });
    expect(
      assessQuoteAcceptance({
        revision: r,
        acceptedAt: '2026-10-07T10:00:00+02:00',
        scopeDigest: r.scopeDigest,
        availabilityVerified: true,
      }),
    ).toMatchObject({ status: 'boundary_check' });
    expect(
      assessQuoteAcceptance({
        revision: r,
        acceptedAt: '2026-10-05T10:00:00+02:00',
        scopeDigest: 'edited',
        availabilityVerified: true,
      }),
    ).toMatchObject({ status: 'scope_changed' });
  });
});
it('fails closed without mandatory authorization admission and invalid authored acceptance date', async () => {
  const s = source();
  await expect(
    resolveQuoteRevision({
      propertyCode: 'HRCEN',
      authoredDate: '2026-10-04',
      selections: [{ sourceRef: s.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' }],
      resolveSource: async () => s,
      resolvePolicy: async () => policy,
    } as any),
  ).rejects.toThrow(/admission/);
  const r = await revision();
  expect(
    assessQuoteAcceptance({
      revision: { ...r, authoredDate: 'invalid' },
      acceptedAt: '2026-10-05T00:00:00Z',
      scopeDigest: r.scopeDigest,
      availabilityVerified: true,
    } as any).status,
  ).toBe('invalid_time');
});
it('rejects unresolved child meal entitlement and retains sourced inclusion provenance', async () => {
  const s = source();
  const req = s.request.rooms[0];
  req.children = 1;
  req.childAges = [7];
  s.result.groups[0].request = structuredClone(req);
  s.result.groups[0].options[0].board = 'Bed & Breakfast R';
  const p = {
    ...policy,
    families: [{ rateCode: 'BAR', board: 'breakfast' as const }],
    bundleLabels: ['Adult breakfast'],
    restrictions: { status: 'supported' as const, sourceRefs: ['rule-1'] },
  };
  const input = {
    admission: admission([s]),
    propertyCode: 'HRCEN',
    authoredDate: '2026-10-04',
    selections: [{ sourceRef: s.ref, groupId: 'g1', optionId: 'HRCEN:STQN:BAR' }],
    resolveSource: async () => s,
    resolvePolicy: async () => p,
  };
  await expect(resolveQuoteRevision(input)).rejects.toThrow(/child_meal/);
  const r = await resolveQuoteRevision({
    ...input,
    resolvePolicy: async () => ({
      ...p,
      childMealEntitlement: {
        status: 'supported' as const,
        sourceRefs: ['meal-1'],
        childAges: [7],
      },
    }),
  });
  expect(r.groups[0].inclusions.authoredDates).toEqual(policy.authoredDates);
  expect(r.groups[0].inclusions.bundleLabels).toEqual(['Adult breakfast']);
  expect(r.inventoryStatus).toBe('observed_not_held');
  await expect(
    resolveQuoteRevision({
      ...input,
      resolvePolicy: async () => ({
        ...p,
        restrictions: { status: 'conflicting' as const, sourceRefs: ['rule-1'] },
      }),
    }),
  ).rejects.toThrow();
});
it('requires authorized sent offer and scoped fresh inventory for acceptance', async () => {
  const r = await revision();
  expect(
    assessQuoteAcceptance({
      revision: r,
      acceptedAt: '2026-10-05T00:00:00Z',
      scopeDigest: r.scopeDigest,
      availabilityVerified: true,
    } as any).status,
  ).toBe('sent_offer_unproven');
});
it('imports authorized source offer lines without invented nightly prices or renewed validity', async () => {
  const { resolveImportedOffer } = await import('../src/quote-proposal/quote-revision.js');
  const offer = {
    ref: 'offer',
    sourceHash: 'c'.repeat(64),
    authorizationId: 'auth-1',
    scopeDigest: 'd'.repeat(64),
    propertyCode: 'HRCEN',
    currency: 'ZAR',
    printedDate: '2026-09-26',
    sentAt: '2026-09-26T10:00:00Z',
    validUntil: '2026-09-29',
    terms: 'Valid for three days',
    lines: [{ id: 'line', page: 1, quote: 'Synthetic source total 123.45', amount: '123.45' }],
  };
  const r = await resolveImportedOffer({
    ref: 'offer',
    authorizationId: 'auth-1',
    evaluationAt: '2026-10-04T00:00:00Z',
    resolveSource: async () => offer,
    authorizeSource: async () => true,
  });
  expect(r.totalMinor).toBe(12345);
  expect(r.printedDate).toBe('2026-09-26');
  expect('nightly' in r).toBe(false);
  expect(Object.isFrozen(r.lines)).toBe(true);
  await expect(
    resolveImportedOffer({
      ref: 'offer',
      authorizationId: 'wrong',
      evaluationAt: '2026-10-04T00:00:00Z',
      resolveSource: async () => offer,
      authorizeSource: async () => true,
    }),
  ).rejects.toThrow();
});
it('requires authorized override provenance and retains original source price', async () => {
  const { resolveApprovedOverride } = await import('../src/quote-proposal/quote-revision.js');
  const r = await revision();
  const approval = {
    ref: 'approval',
    authorizationId: r.authorizationId,
    revisionId: r.id,
    sourceHash: 'e'.repeat(64),
    actorRef: 'staff-1',
    reason: 'Authorized synthetic adjustment',
    approvedAt: '2026-10-04T11:00:00Z',
    amount: '2000.00',
    currency: 'ZAR',
  };
  const o = await resolveApprovedOverride({
    revision: r,
    ref: 'approval',
    evaluationAt: '2026-10-04T12:00:00Z',
    resolveApproval: async () => approval,
    authorizeActor: async () => true,
  });
  expect(o.originalTotalMinor).toBe(r.totalMinor);
  expect(o.approvedTotalMinor).toBe(200000);
  await expect(
    resolveApprovedOverride({
      revision: r,
      ref: 'approval',
      evaluationAt: '2026-10-04T12:00:00Z',
      resolveApproval: async () => approval,
      authorizeActor: async () => false,
    }),
  ).rejects.toThrow();
});
it('rejects altered revision totals before acceptance or approval', async () => {
  const r = await revision();
  const altered = { ...r, totalMinor: 1 };
  expect(
    assessQuoteAcceptance({
      revision: altered,
      acceptedAt: '2026-10-05T00:00:00Z',
      scopeDigest: r.scopeDigest,
    }),
  ).toMatchObject({ status: 'invalid_revision' });
});
it('persists source freshness using the admitted source age bound without renewing the observation',async()=>{
 const value=await revision();
 expect((value as any).sourceFreshness).toEqual({authorizationId:'auth-1',sourceRefs:['source-1'],observedAt:'2026-10-04T09:00:00.000Z',expiresAt:'2026-10-05T09:00:00.000Z',purpose:'offer_source'});
 expect(value.validity.cutoff).toBe('unresolved');
});

it('evaluates accepted-offer validity at acceptance and current inventory at its independent source time',async()=>{
 const r=await revision();
 const sentProof={revisionId:r.id,authorizationId:r.authorizationId,sentAt:'2026-10-04T09:30:00Z',sourceRef:'sent',sourceHash:'a'.repeat(64)};
 const inventoryEvidence={revisionId:r.id,scopeDigest:r.scopeDigest,authorizationId:r.authorizationId,observedAt:'2026-10-04T11:00:00Z',available:true,maxAgeMs:60000};
 expect(assessQuoteAcceptance({revision:r,acceptedAt:'2026-10-04T10:00:00Z',scopeDigest:r.scopeDigest,sentProof,inventoryEvidence,sourceEvaluationAt:'2026-10-04T11:00:00Z'} as any)).toMatchObject({status:'accepted',agreedTotalMinor:r.totalMinor});
 expect(assessQuoteAcceptance({revision:r,acceptedAt:'2026-10-04T10:00:00Z',scopeDigest:r.scopeDigest,sentProof,inventoryEvidence})).toMatchObject({status:'availability_unproven'});
});

it('uses a source-scoped room pool for one selected group when native building is explicitly null',async()=>{
 const s=source();s.result.groups[0].options[0].room.buildingCode=null;
 const r=await resolveQuoteRevision({propertyCode:'HRCEN',authoredDate:'2026-10-04',selections:[{sourceRef:s.ref,groupId:'g1',optionId:'HRCEN:STQN:BAR'}],resolveSource:async()=>s,resolvePolicy:async()=>policy,admission:admission([s])});
 expect(r.totalMinor).toBe(220002);expect(r.groups[0].poolId).toContain('source-1');
});
function secondRow(room:string,building:unknown){
 const b=source();b.ref='source-2';b.request.rooms[0].id='g2';b.result.groups[0].id='g2';b.result.groups[0].request.id='g2';const o=b.result.groups[0].options[0];o.id=`HRCEN:${room}:BAR`;o.room.code=room;(o.room as {buildingCode:unknown}).buildingCode=building;return b;
}
function twoRows(a:QuoteSourceRecord,b:QuoteSourceRecord){
 return resolveQuoteRevision({propertyCode:'HRCEN',authoredDate:'2026-10-04',selections:[{sourceRef:a.ref,groupId:'g1',optionId:a.result.groups[0].options[0].id},{sourceRef:b.ref,groupId:'g2',optionId:b.result.groups[0].options[0].id}],resolveSource:async ref=>ref===a.ref?a:b,resolvePolicy:async()=>policy,admission:admission([a,b])});
}
it('sums same-type unknown-building rows against one property-wide pool across selected groups',async()=>{
 const a=source();a.result.groups[0].options[0].room.buildingCode=null;
 await expect(twoRows(a,secondRow('STQN',null))).rejects.toThrow('joint_inventory_insufficient');
});
it('pools unknown-building room types separately and flags the mix for a staff check',async()=>{
 const a=source();a.result.groups[0].options[0].room.buildingCode=null;
 const r=await twoRows(a,secondRow('STWN',null));
 expect(r.groups.map(g=>g.poolId)).toEqual(['HRCEN:property:STQN','HRCEN:property:STWN']);expect(propertyPoolBasis(r)).toBe('property_room_type');
});
it('keeps building pools and no staff-check flag when HMS gives the building',async()=>{
 const r=await twoRows(source(),secondRow('STWN','MAIN'));
 expect(r.groups.map(g=>g.poolId)).toEqual(['HRCEN:MAIN:STQN','HRCEN:MAIN:STWN']);expect(propertyPoolBasis(r)).toBeNull();
 const one=source();one.result.groups[0].options[0].room.buildingCode=null;expect(propertyPoolBasis(await revision(one))).toBeNull();
});
it('pools one room type property-wide when HMS gave its building on one row and none on another',async()=>{
 const a=source();a.result.groups[0].options[0].room.buildingCode=null;
 await expect(twoRows(a,secondRow('STQN','MAIN'))).rejects.toThrow('joint_inventory_insufficient');
 const b=source();const flipped=secondRow('STQN',null);
 await expect(twoRows(b,flipped)).rejects.toThrow('joint_inventory_insufficient');
});
it('rejects a malformed building instead of pooling it',async()=>{
 const a=source();a.result.groups[0].options[0].room.buildingCode=null;
 await expect(twoRows(a,secondRow('STWN',''))).rejects.toThrow('inventory_pool_unknown');
});

it('preserves source publication provenance without inventing an invoice-authored date',async()=>{
 const record=source(),termsPolicy={...policy,authoredDates:[],sourcePublications:[{sourceHash:policy.sourceHashes[0]!,publishedAt:'2026-09-11T07:43:58.000Z'}]};
 const r=await resolveQuoteRevision({admission:admission([record]),propertyCode:'HRCEN',selections:[{sourceRef:record.ref,groupId:'g1',optionId:'HRCEN:STQN:BAR'}],authoredDate:'2026-10-04',resolveSource:async()=>record,resolvePolicy:async()=>termsPolicy});
 expect(r.groups[0]!.inclusions.authoredDates).toEqual([]);expect((r.groups[0]!.inclusions as any).sourcePublications).toEqual(termsPolicy.sourcePublications);
});
it.each(['missing','invalid_date','foreign_hash','future','unbound_additional_hash'])('rejects invalid hotel terms publication %s',async key=>{
 const record=source(),termsPolicy={...policy,authoredDates:[],sourcePublications:[{sourceHash:policy.sourceHashes[0]!,publishedAt:'2026-09-11T07:43:58.000Z'}]};if(key==='missing')termsPolicy.sourcePublications=[];if(key==='invalid_date')termsPolicy.sourcePublications[0]!.publishedAt='not-a-date';if(key==='foreign_hash')termsPolicy.sourcePublications[0]!.sourceHash='c'.repeat(64);if(key==='future')termsPolicy.sourcePublications[0]!.publishedAt='2026-10-05T00:00:00Z';if(key==='unbound_additional_hash')termsPolicy.sourceHashes=[...termsPolicy.sourceHashes,'c'.repeat(64)];
 await expect(resolveQuoteRevision({admission:admission([record]),propertyCode:'HRCEN',selections:[{sourceRef:record.ref,groupId:'g1',optionId:'HRCEN:STQN:BAR'}],authoredDate:'2026-10-04',resolveSource:async()=>record,resolvePolicy:async()=>termsPolicy})).rejects.toThrow('unqualified_inclusions');
});
