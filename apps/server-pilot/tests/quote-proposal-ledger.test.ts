import { describe,it,expect } from 'vitest';
import { qualifiedProposalInput, resolveLedgerProposal } from '../src/trpc/routes/workstation.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
describe('qualified proposal ledger admission',()=>{
 it('accepts references only, refusing model prices or nights',()=>{
  expect(()=>qualifiedProposalInput.parse({workflowRunId:'run',revisionRef:'quote',outlookEmail:'test',lines:[]})).toThrow();
 });
 it('resolves one selected authorized revision from a successful scoped ledger',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));const revision=freshRevision(await syntheticRevision());const run={id:'run',transportId:'transport',triggerMessageId:'message',state:'succeeded',metrics:{reservationistResult:{readiness:'ready_for_staff_review',quoteRevisionIds:[revision.id],quoteRevisions:[revision],proposalFacts:[]}}};
  expect(resolveLedgerProposal(run,{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:[]})).toMatchObject({revision});
  expect(()=>resolveLedgerProposal(run,{transportId:'foreign',messageId:'message',revisionRef:revision.id,factRefs:[]})).toThrow(/scope/);
  expect(()=>resolveLedgerProposal({...run,metrics:{reservationistResult:{...run.metrics.reservationistResult,superseded:true}}},{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:[]})).toThrow(/ready/);
  expect(()=>resolveLedgerProposal({...run,metrics:{reservationistResult:{...run.metrics.reservationistResult,expired:true}}},{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:[]})).toThrow(/ready/);
  expect(()=>resolveLedgerProposal({...run,state:'failed'},{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:[]})).toThrow(/ready/);
  expect(()=>resolveLedgerProposal(run,{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:['missing']})).toThrow(/fact/);
  expect(()=>resolveLedgerProposal({...run,metrics:{reservationistResult:{...run.metrics.reservationistResult,proposalFacts:[{ref:'one',facts:{revisionId:revision.id}},{ref:'two',facts:{revisionId:revision.id}}]}}},{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:['one','two']})).toThrow(/bundle/);
 });
});

import {resolveLedgerSourceProposal} from '../src/trpc/routes/workstation.js';
import {vi,afterEach} from 'vitest';
import {quoteDigest,resolveImportedOffer,resolveApprovedOverride} from '../src/quote-proposal/quote-revision.js';
function freshRevision(raw:any){const {id,...data}=raw;data.validity={...data.validity,cutoff:'explicit',expiresAt:'2026-10-05T10:00:00Z'};return {...data,id:`quote:${quoteDigest(data)}`};}
function ledger(revision:any,extra?:any){return {transportId:'transport',triggerMessageId:'message',state:'succeeded',metrics:{reservationistResult:{readiness:'ready_for_staff_review',quoteRevisionIds:[revision.id],quoteRevisions:[revision],proposalFacts:extra?[{ref:'extras',facts:extra}]:[]}}};}
afterEach(()=>vi.useRealTimers());
describe('selected proposal extras and live freshness',()=>{
 it('rejects omission or substitution of the selected authorized extras bundle',async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));const revision=freshRevision(await syntheticRevision(['100.00']));const facts={revisionId:revision.id,authorizationId:revision.authorizationId,sourceRef:'extra-source',sourceHash:'c'.repeat(64),includedEntitlements:[],extras:[{id:'transfer',label:'Transfer',quantity:1,units:1,unitKind:'trip',unitMinor:5000,service:'transfer',persons:[],dates:[]}]};const run=ledger(revision,facts),scope={transportId:'transport',messageId:'message',revisionRef:revision.id};expect(resolveLedgerProposal(run,{...scope,factRefs:['extras']})).toMatchObject({facts});expect(()=>resolveLedgerProposal(run,{...scope,factRefs:[]})).toThrow(/fact/);expect(()=>resolveLedgerProposal(run,{...scope,factRefs:['extras','extras']})).toThrow(/fact|bundle/);});
 it('rejects a previously ready native revision once its retained source expires',async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));const revision=freshRevision(await syntheticRevision());expect(()=>resolveLedgerProposal(ledger(revision),{transportId:'transport',messageId:'message',revisionRef:revision.id,factRefs:[]})).toThrow(/expired|authority/);});
 it('exports an ordinary native quote inside its sourced window and refuses the ambiguous boundary',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));const raw=await syntheticRevision();
  const scope={transportId:'transport',messageId:'message',revisionRef:raw.id,factRefs:[]};
  expect(resolveLedgerProposal(ledger(raw),scope)).toMatchObject({revision:raw});
  vi.setSystemTime(new Date('2026-10-07T09:30:00Z'));const {id,...data}=raw;data.sourceFreshness={...raw.sourceFreshness!,observedAt:'2026-10-07T09:00:00Z',expiresAt:'2026-10-07T10:00:00Z'};
  const boundary={...data,id:`quote:${quoteDigest(data)}`};expect(()=>resolveLedgerProposal(ledger(boundary),{...scope,revisionRef:boundary.id})).toThrow(/cutoff/);
 });
 it.each(['imported_offer','approved_override'] as const)('rechecks selected %s source, scope and expiry without a historical ready bypass',async kind=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));const revision=freshRevision(await syntheticRevision());const offerSource={ref:'original',sourceHash:'a'.repeat(64),authorizationId:revision.authorizationId,scopeDigest:revision.scopeDigest,propertyCode:'HRCEN',currency:'ZAR',printedDate:'2026-10-03',sentAt:'2026-10-03T10:00:00Z',validUntil:'2026-10-05',terms:'Original synthetic terms',lines:[{id:'line',page:1,quote:'Original package',amount:'100.00'}],sourceFreshness:{authorizationId:revision.authorizationId,sourceRefs:['original'],purpose:'offer_source' as const,observedAt:'2026-10-04T09:00:00Z',expiresAt:'2026-10-04T10:00:00Z'}};const offer=await resolveImportedOffer({ref:'original',authorizationId:revision.authorizationId,evaluationAt:'2026-10-04T09:30:00Z',resolveSource:async()=>offerSource,authorizeSource:async()=>true}),override=await resolveApprovedOverride({revision,ref:'approval',evaluationAt:'2026-10-04T09:30:00Z',resolveApproval:async()=>({ref:'approval',authorizationId:revision.authorizationId,revisionId:revision.id,sourceHash:'b'.repeat(64),actorRef:'staff',reason:'Synthetic approval',approvedAt:'2026-10-04T09:00:00Z',amount:'100.00',currency:'ZAR'}),authorizeActor:async()=>true}),selected=kind==='imported_offer'?offer:override;
 const run:any=ledger(revision);run.metrics.reservationistResult.importedOffers=[offer];run.metrics.reservationistResult.approvedOverrides=[override];const scope={transportId:'transport',messageId:'message',revisionRef:selected.id,factRefs:[],kind};expect(resolveLedgerSourceProposal(run,scope)).toBe(selected);expect(()=>resolveLedgerSourceProposal(run,{...scope,transportId:'foreign'})).toThrow(/scope/);vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));expect(()=>resolveLedgerSourceProposal(run,scope)).toThrow(/expired|authority/);});
});
