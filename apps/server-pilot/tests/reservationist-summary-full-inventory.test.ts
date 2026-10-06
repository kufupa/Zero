import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createReservationistBusinessServices, selectReservationistQuoteOptions } from '../src/ai/reservationist-business-services.js';
import { createExistingOwnerNativeQuoteReader, isReservationistAuditedSummaryPartial } from '../src/ai/reservationist-evaluation-composition.js';
import { resolveQuoteRevision } from '../src/quote-proposal/quote-revision.js';

async function fixture() {
  const nativeContract = '../tooling/playwright-quote/quote-contract.mjs';
  const { normalizeQuoteRequest, composeAllocation } = await import(nativeContract);
  const text = 'Please quote Group A: 1 room, 1 adult. Group B: 1 room, 1 adult. Bed & Breakfast. Arrival 12 October 2026 departure 14 October 2026.';
  const source = { attachmentId: 'message:m', sourceHash: createHash('sha256').update(text).digest('hex'), page: 1, quote: text, start: 0, end: text.length };
  const fact = (id: string, kind: string, value: unknown) => ({ id, kind, value, source, verification: 'text_verified', disclosure: 'guest' });
  const now = new Date().toISOString();
  const c: any = { task: { id: 'q', kind: 'quote', source, factIds: ['dates', 'room-A', 'room-B', 'board'] }, facts: [fact('dates', 'dates', { arrival: '2026-10-12', departure: '2026-10-14' }), ...['A', 'B'].map(id => fact(`room-${id}`, 'room', { roomRef: id, quantity: 1, adults: 1, childAges: [] })), fact('board', 'board', 'Bed & Breakfast')], input: { propertyCode: 'HRCEN', messages: [{ id: 'm', text }], authorizationScope: { ownerRef: 'owner', threadId: 'thread' }, capabilities: { pmsWrite: false, emailSend: false }, clock: { sourceMode: 'current_read', sourceAt: now } }, signal: new AbortController().signal };
  const make = (request: any, full: boolean) => {
    const normalized = normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
    const groups = normalized.rooms.map((room: any) => ({ id: room.id, request: room, outcome: 'quote', completeness: { search: 'complete', requiredFacts: 'complete' }, issues: [], options: ['STQN', 'STWN'].filter(code => !room.required?.roomCodes || room.required.roomCodes.includes(code)).map(code => ({ id: `HRCEN:${code}:BAR`, room: { code, label: code, buildingCode: full ? 'MAIN' : null }, rate: { code: 'BAR', label: 'Best Available' }, board: 'Bed & Breakfast R', appliedContext: {}, held: false, eligibility: 'verified', availability: 'available', matchStatus: 'match', totals: { taxInclusive: true }, issues: [], nightly: ['2026-10-12', '2026-10-13'].map(date => ({ date, inventory: 5, price: { amount: code === 'STQN' ? '100.00' : '120.00', currency: 'ZAR' } })) })) }));
    return { ref: full ? 'native:full' : 'native:summary', sha256: (full ? 'f' : 'a').repeat(64), observedAt: now, toolVersion: 'native-fixture', request: normalized, result: { outcome: full ? 'quote' : 'partial', propertyCode: 'HRCEN', groups }, allocation: composeAllocation(groups, 'HRCEN') };
  };
  return { c, make, normalizeQuoteRequest, composeAllocation };
}

it('uses complete summary prices only to narrow a full read, then validates actual known shared pools', async () => {
  const f = await fixture(), calls: any[] = [];
  let summary: any;
  const services = createReservationistBusinessServices({ authorizationId: 'auth', authorizeContext: async () => true, signer: { signerName: 'Reservations', signerEmail: '' }, readQuote: async request => { calls.push(structuredClone(request)); const s = f.make(request, calls.length === 2); if (calls.length === 1) { summary = structuredClone(s); expect(() => selectReservationistQuoteOptions(s)).toThrow('business_selected_joint_inventory_unavailable'); } return s; }, resolvePolicy: async () => ({ propertyCode: 'HRCEN', sourceHashes: ['b'.repeat(64)], authoredDates: ['2026-09-08'], families: [{ rateCode: 'BAR', board: 'breakfast' }], vat: 'included', levy: 'included' }) });
  const resolved = await services.resolveQuoteTask!(f.c);
  expect(calls).toHaveLength(2);
  expect(calls[0].details).toBe('summary');
  expect(calls[1].details).toBe('full');
  expect(calls[1].rooms.map((r: any) => r.required.roomCodes)).toEqual([['STQN'], ['STQN']]);
  expect(summary.result.outcome).toBe('partial');
  expect(summary.result.groups.every((g: any) => g.options.every((o: any) => o.room.buildingCode === null))).toBe(true);
  expect(resolved.selections.every(s => s.sourceRef === 'native:full')).toBe(true);
  const revision = await resolveQuoteRevision(resolved);
  expect(revision.totalMinor).toBe(40000);
  expect(revision.groups.every(g => g.sourceRef === 'native:full')).toBe(true);
});

it.each(['unknown', 'disagree', 'insufficient', 'partial'] as const)('never returns a final quote when the narrowed full result has %s inventory evidence', async mode => {
  const f = await fixture(), calls: any[] = [];
  const services = createReservationistBusinessServices({ authorizationId: 'auth', authorizeContext: async () => true, signer: { signerName: 'Reservations', signerEmail: '' }, readQuote: async request => { calls.push(request); const s = f.make(request, calls.length === 2); if (calls.length === 2) { if (mode === 'partial') s.result.outcome = 'partial'; for (const [index, g] of s.result.groups.entries()) for (const o of g.options) { if (mode === 'unknown') o.room.buildingCode = null; if (mode === 'disagree' && index === 1) o.nightly[0].inventory = 6; if (mode === 'insufficient') for (const n of o.nightly) n.inventory = 1; } } return s; }, resolvePolicy: async () => null });
  await expect(services.resolveQuoteTask!(f.c)).rejects.toThrow(/business_selected_(?:joint_inventory|scope)_unavailable/);
  expect(calls).toHaveLength(2);
});

it.each(['valid', 'unknown_pool', 'duplicate_group', 'full', 'group_partial', 'capture_issue', 'option_issue', 'wrong_allocation', 'unverified_audit'] as const)('native reader admits only truthful audited summary partials solely awaiting selection/pool detail: %s', async mode => {
  const f = await fixture(), root = await mkdtemp(join(process.cwd(), '../../.private/playwright-quote/summary-reader-synthetic-'));
  try {
    const request: any = { propertyCode: 'HRCEN', arrivalDate: '2026-10-12', departureDate: '2026-10-14', requestedCurrency: 'ZAR', details: mode === 'full' ? 'full' : 'summary', rooms: ['A', 'B'].map(id => ({ id, quantity: 1, adults: 1, children: 0, childAges: [] })) };
    if(mode==='unknown_pool')for(const room of request.rooms)room.required={roomCodes:['STQN'],rateCodes:['BAR']};
    const s = f.make(request, false), evidence = join(root, 'actual'); await mkdir(evidence);
    const native: any = { schemaVersion: 2, outcome: 'partial', observedAt: s.observedAt, requested: s.request, groups: s.result.groups, allocation: s.allocation, issues: [], searchCompleteness: { status: 'complete' }, audit: { status: 'complete' }, evidenceDirectory: evidence };
    if(mode==='duplicate_group')native.groups[1]=structuredClone(native.groups[0]);
    if (mode === 'group_partial') native.groups[0].completeness.requiredFacts = 'partial';
    if (mode === 'capture_issue') native.issues.push({ code: 'PUBLIC_RESET_FAILED' });
    if (mode === 'option_issue') native.groups[0].options[0].issues.push({ code: 'INCOMPLETE_DATES' });
    if (mode === 'wrong_allocation') native.allocation = { status: 'unknown', pools: [] };
    if (mode === 'unverified_audit') native.audit.status = 'partial';
    const bytes = Buffer.from(JSON.stringify(native)); await writeFile(join(evidence, 'result.json'), bytes);
    const dispatch = vi.fn(async () => ({ stdout: `Evidence: ${evidence}\n` }));
    const read = createExistingOwnerNativeQuoteReader({ owner: { cdpUrl: 'http://127.0.0.1:9222', browserOwnership: 'borrowed', propertyCode: 'HRCEN', secretPath: '/synthetic/private-secret' }, outputDir: root, dispatch });
    if (mode === 'valid'||mode==='unknown_pool') { const result = await read(request, f.c.signal); expect(result.result.outcome).toBe('partial'); expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(result.result.groups).toEqual(native.groups); }
    else await expect(read(request, f.c.signal)).rejects.toThrow('native_quote_capture_scope_or_completeness_invalid');
    expect(dispatch).toHaveBeenCalledOnce();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('exports the same audited summary predicate for recorded sources without granting quote authority',async()=>{
  const f=await fixture();
  const request:any={propertyCode:'HRCEN',arrivalDate:'2026-10-12',departureDate:'2026-10-14',requestedCurrency:'ZAR',details:'summary',rooms:['A','B'].map(id=>({id,quantity:1,adults:1,children:0,childAges:[]}))};
  const s=f.make(request,false),raw:any={schemaVersion:2,outcome:'partial',requested:s.request,groups:s.result.groups,allocation:s.allocation,issues:[],searchCompleteness:{status:'complete'},audit:{status:'complete'}};
  expect(isReservationistAuditedSummaryPartial(raw,s.request,f.composeAllocation)).toBe(true);
  expect(raw.outcome).toBe('partial');
  for(const malformed of [null,{}, {...raw,audit:{status:'partial'}},{...raw,requested:{...s.request,arrivalDate:'2026-10-13'}},{...raw,groups:[null]}])expect(isReservationistAuditedSummaryPartial(malformed,s.request,f.composeAllocation)).toBe(false);
});


it.each(['valid','unknown_availability','positive_inventory','missing_night','incomplete_search','option_issue'] as const)('delivers an audited zero-availability summary without granting quote authority: %s',async mode=>{
 const f=await fixture(),request:any={propertyCode:'HRCEN',arrivalDate:'2026-10-12',departureDate:'2026-10-14',requestedCurrency:'ZAR',details:'summary',rooms:[{id:'A',quantity:1,adults:1,children:0,childAges:[],required:{boardBases:['breakfast']}}]},s=f.make(request,false);
 for(const group of s.result.groups){group.outcome='partial';for(const option of group.options){option.availability='unavailable';for(const night of option.nightly)night.inventory=0;}}
 if(mode==='unknown_availability')s.result.groups[0].options[0].availability='unknown';
 if(mode==='positive_inventory')for(const night of s.result.groups[0].options[0].nightly)night.inventory=5;
 if(mode==='missing_night')s.result.groups[0].options[0].nightly.pop();
 if(mode==='incomplete_search')s.result.groups[0].completeness.search='partial';
 if(mode==='option_issue')s.result.groups[0].options[0].issues.push({code:'UNREAD_NIGHT'});
 const raw:any={schemaVersion:2,outcome:'partial',requested:s.request,groups:s.result.groups,allocation:f.composeAllocation(s.result.groups,'HRCEN'),issues:[],searchCompleteness:{status:'complete'},audit:{status:'complete'}};
 if(mode!=='valid'){expect(isReservationistAuditedSummaryPartial(raw,s.request,f.composeAllocation)).toBe(false);return;}
 expect(isReservationistAuditedSummaryPartial(raw,s.request,f.composeAllocation)).toBe(true);
 const root=await mkdtemp(join(process.cwd(),'../../.private/playwright-quote/negative-summary-synthetic-'));
 try{
  const evidence=join(root,'actual');await mkdir(evidence);Object.assign(raw,{observedAt:s.observedAt,evidenceDirectory:evidence});const bytes=Buffer.from(JSON.stringify(raw));await writeFile(join(evidence,'result.json'),bytes);
  const read=createExistingOwnerNativeQuoteReader({owner:{cdpUrl:'http://127.0.0.1:9222',browserOwnership:'borrowed',propertyCode:'HRCEN',secretPath:'/synthetic/private-secret'},outputDir:root,dispatch:async()=>({stdout:`Evidence: ${evidence}\n`})});
  const delivered=await read(request,f.c.signal);expect(delivered.result.outcome).toBe('partial');expect(delivered.result.groups).toEqual(raw.groups);expect(delivered.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(()=>selectReservationistQuoteOptions(delivered)).toThrow('business_selected_price_unavailable');
  const calls:any[]=[],c={...f.c,facts:f.c.facts.filter((fact:any)=>fact.id!=='room-B')},services=createReservationistBusinessServices({authorizationId:'auth',authorizeContext:async()=>true,signer:{signerName:'Local',signerEmail:''},readQuote:async request=>{calls.push(request);const current=f.make(request,false);for(const group of current.result.groups){group.outcome='partial';for(const option of group.options){option.availability='unavailable';for(const night of option.nightly)night.inventory=0;}}return current;},resolvePolicy:async()=>null});
  await expect(services.resolveQuoteTask!(c)).rejects.toThrow('business_selected_price_unavailable');expect(calls).toHaveLength(1);expect(calls[0].details).toBe('summary');
 }finally{await rm(root,{recursive:true,force:true});}
});
