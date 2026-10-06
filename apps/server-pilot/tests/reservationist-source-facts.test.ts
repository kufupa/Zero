import {describe,it,expect} from 'vitest';
import * as sourceFacts from '../src/ai/reservationist-source-facts.js';
import {syntheticRevision} from './helpers/synthetic-quote-revision.js';
import type {BookingEvidence} from '../src/ai/reservationist-booking-packet.js';
import {quoteDigest,resolveQuoteRevision} from '../src/quote-proposal/quote-revision.js';
import {createHash} from 'node:crypto';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';
const source={attachmentId:'message:inbound',sourceHash:'a'.repeat(64),page:1,quote:'Synthetic original request',start:0,end:26};
const fact=(id:string,kind:string,value:unknown):any=>({id,kind,value,source,disclosure:'guest',verification:'text_verified',authority:'customer_claim'});
const assertRevision=(facts:any[],revision:any,rooms?:any[],guestFacts?:BookingEvidence['guestFacts'])=>(sourceFacts as any).assertRevisionSourceFacts(facts,revision,rooms,guestFacts);
const assertOffer=(facts:any[],attestation:any)=>(sourceFacts as any).assertSourceOfferFactAttestation(facts,attestation);
describe('original source facts bound to native revision',()=>{
 it('accepts exact explicit quantities, occupancy, dates and board from the selected revision',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');
  expect(()=>assertRevision([fact('date','dates',{arrival:'2026-10-12',departure:'2026-10-13'}),fact('room','room',{roomRef:'g1',quantity:2,adults:1,childAges:[]}),fact('board','board','room_only')],r)).not.toThrow();
 });
 it.each(['quantity','adults','children','dates','board','party'])('rejects %s mismatch even when the native revision itself is authorized',async kind=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');let f:any;
  if(kind==='quantity')f=fact('room','room',{roomRef:'g1',quantity:3,adults:1,childAges:[]});if(kind==='adults')f=fact('room','room',{roomRef:'g1',adults:2,childAges:[]});if(kind==='children')f=fact('room','room',{roomRef:'g1',adults:1,childAges:[7]});if(kind==='dates')f=fact('dates','dates',{arrival:'2026-11-01',departure:'2026-11-03'});if(kind==='board')f=fact('board','board','breakfast');if(kind==='party')f=fact('party','party','Original Organization');
  expect(()=>assertRevision([f],r)).toThrow(/mismatch|missing/);
 });
 it('retains absent quantities rather than requiring an inferred default',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');expect(()=>assertRevision([fact('room','room',{roomRef:'g1',adults:1,childAges:[]})],r)).not.toThrow();
 });
 it('rejects unknown board labels rather than guessing an inclusion',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');expect(()=>assertRevision([fact('board','board','Full board perhaps')],r)).toThrow('missing');
 });
 it('supports the explicit native board display labels without inventing room defaults',async()=>{
  const r=await syntheticRevision(['100.00'],'Bed & Breakfast R','STQN');expect(()=>assertRevision([fact('board','board','Bed & Breakfast R')],r)).not.toThrow();
 });
});
describe('explicit native acronym remains bound to selected quotation context',()=>{
 it('accepts an explicitly printed native suffix only for quotation facts',async()=>{const r=structuredClone(await syntheticRevision(['100.00'],'Room Only R','STQN')); r.groups[0]!.context={organization:{nativeId:'63',name:'Example Public Service - EPS'}};expect(()=>assertRevision([fact('party','party','EPS')],r)).not.toThrow();expect(()=>assertRevision([fact('party','party','EPS')],r,[])).toThrow('source_fact_party_mismatch');});
 it.each(['Other Organization','EPS Other Organization','Example Public Service - EPS Holdings','Example Public Service (EPS'])('rejects unsupported label %s',async name=>{const r=structuredClone(await syntheticRevision(['100.00'],'Room Only R','STQN')); r.groups[0]!.context={organization:{nativeId:'63',name}};expect(()=>assertRevision([fact('party','party','EPS')],r)).toThrow('source_fact_party_mismatch');});
});
describe('physical guest source binding',()=>{
 const guest=fact('guest:alex','guest',{firstName:'Alex',lastName:'Example',roomRef:'g1',roomIndex:1});
 const rooms=[{groupId:'g1',roomIndex:1,guests:[{factRef:'guest:alex',firstName:'Alex',lastName:'Example'}]},{groupId:'g1',roomIndex:2,guests:[{factRef:'guest:taylor',firstName:'Taylor',lastName:'Example'}]}];
 it('uses original fact identity and exact physical guest assignment',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');expect(()=>assertRevision([guest],r,[rooms[0]])).not.toThrow();
 });
 it.each(['identity','name','index','age','profile'])('rejects substituted guest %s',async kind=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN'),copy=structuredClone(rooms),f=structuredClone(guest);
  if(kind==='identity')copy[0].guests[0].factRef='another-fact';if(kind==='name')copy[0].guests[0].firstName='Morgan';if(kind==='index')copy[0].roomIndex=2;if(kind==='age')f.value.age=35;if(kind==='profile')f.value.profileId='profile:7';expect(()=>assertRevision([f],r,copy)).toThrow('mismatch');
 });
 it('does not assign a guest whose original roomIndex is missing',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN'),f=structuredClone(guest);delete f.value.roomIndex;expect(()=>assertRevision([f],r,rooms)).toThrow('missing');
 });
 it('keeps quote guest identities optional until booking rooms are supplied',async()=>{
  const r=await syntheticRevision(['100.00'],'Room Only R','STQN');expect(()=>assertRevision([guest],r)).not.toThrow();
 });
});
describe('opaque original-offer task fact attestation',()=>{
 const dates=fact('date','dates',{arrival:'2026-11-01',departure:'2026-11-03'});
 it('requires exact server-attested task facts instead of guessing imported stay fields',()=>{
  expect(()=>assertOffer([dates],{factDigests:{date:quoteDigest(dates)}})).not.toThrow();expect(()=>assertOffer([dates],undefined)).toThrow('missing');
 });
 it('rejects substituted fact digests, missing facts and unrequested evidence',()=>{
  for(const attestation of [{factDigests:{date:'b'.repeat(64)}},{factDigests:{}},{factDigests:{date:quoteDigest(dates),foreign:'a'.repeat(64)}}])expect(()=>assertOffer([dates],attestation)).toThrow(/mismatch|missing/);
 });
 it('cannot use a rate claim binding as attestation for requested dates',()=>{
  expect(()=>assertOffer([dates],{factDigests:{rate:'a'.repeat(64)}})).toThrow(/mismatch|missing/);
 });
});

it('does not silently ignore a reservation reference required before creating a new booking',async()=>{
 const r=await syntheticRevision(['100.00'],'Room Only R','STQN');const rooms=[{groupId:'g1',roomIndex:1,guests:[]}];expect(()=>assertRevision([fact('ref','reservation_reference','ABC123')],r,rooms)).toThrow('missing');
});
it('does not certify extra booking guests without supplied original facts when task guests are present',async()=>{
 const r=await syntheticRevision(['100.00'],'Room Only R','STQN');expect(()=>assertRevision([fact('alex','guest',{firstName:'Alex',lastName:'Example',roomRef:'g1',roomIndex:1})],r,[{groupId:'g1',roomIndex:1,guests:[{factRef:'alex',firstName:'Alex',lastName:'Example'}]},{groupId:'g1',roomIndex:2,guests:[{factRef:'unbound',firstName:'Morgan',lastName:'Sample'}]}])).toThrow('missing');
});
it('keeps rate and payment claims in their separate comparison authorities',()=>{
 expect(()=>assertOffer([fact('rate','rate_claim',{amount:'100.00'}),fact('paid','payment_claim',{amount:'100.00'})],undefined)).not.toThrow();
});
it('rejects duplicate original fact identifiers in an opaque attestation',()=>{
 const date=fact('date','dates',{arrival:'2026-10-12',departure:'2026-10-13'});expect(()=>assertOffer([date,date],{factDigests:{date:quoteDigest(date)}})).toThrow(/missing|mismatch/);
});

it('permits earlier independently supplied guest source facts for additional physical guests',async()=>{
 const r=await syntheticRevision(['100.00'],'Room Only R','STQN');const alex=fact('alex','guest',{firstName:'Alex',lastName:'Example',roomRef:'g1',roomIndex:1}),rooms=[{groupId:'g1',roomIndex:1,guests:[{factRef:'alex',firstName:'Alex',lastName:'Example'}]},{groupId:'g1',roomIndex:2,guests:[{factRef:'morgan',firstName:'Morgan',lastName:'Sample'}]}];
 const proof:any={sourceRef:'earlier-message',sourceHash:'a'.repeat(64),authorizationId:r.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:'2026-10-03T09:00:00Z',factRef:'morgan',groupId:'g1',roomIndex:2,firstName:'Morgan',lastName:'Sample'};
 expect(()=>assertRevision([alex],r,rooms,[proof])).not.toThrow();expect(()=>assertRevision([alex],r,rooms,[{...proof,firstName:'Other'}])).toThrow('missing');
});

describe('explicit per-group board source scope',()=>{
 it('accepts different explicitly requested boards only for their matching selected groups',()=>{const revision:any={groups:[{id:'A',roomCode:'SKNG',board:'room_only'},{id:'B',roomCode:'EXKNG',board:'breakfast'}]};expect(()=>assertRevision([fact('a','board',{board:'room_only',roomRef:'A'}),fact('b','board',{board:'breakfast',roomRef:'B'})],revision)).not.toThrow();});
 it('rejects unknown targets or a wrong target board and keeps global scalar applies-all strict',()=>{const revision:any={groups:[{id:'A',roomCode:'SKNG',board:'room_only'},{id:'B',roomCode:'EXKNG',board:'breakfast'}]};for(const value of [{board:'breakfast',roomRef:'A'},{board:'breakfast',roomRef:'C'},'breakfast'])expect(()=>assertRevision([fact('b','board',value)],revision)).toThrow(/board/);});
});

describe('exact lexical board source aliases',()=>{
 async function nativeBoardRevision(board:string){
  const seed=await syntheticRevision(['100.00']),g=seed.groups[0],room={id:g.id,quantity:g.quantity,adults:g.adults,children:g.children,childAges:g.childAges},request={propertyCode:'HRCEN',requestedCurrency:'ZAR',arrivalDate:g.arrivalDate,departureDate:g.departureDate,rooms:[room]};
  const source:any={ref:'synthetic-board',sha256:'a'.repeat(64),toolVersion:'2',observedAt:'2026-10-04T09:00:00Z',request,result:{outcome:'quote',propertyCode:'HRCEN',groups:[{id:g.id,request:room,completeness:{search:'complete',requiredFacts:'complete'},options:[{id:'selected',room:{code:g.roomCode,label:g.roomLabel,buildingCode:'MAIN'},rate:{code:g.rateCode,label:g.rateLabel},board,appliedContext:{},eligibility:'verified',availability:'available',matchStatus:'match',held:false,totals:{taxInclusive:true},nightly:g.nightly.map(n=>({date:n.date,inventory:5,price:{amount:'100.00',currency:'ZAR'}}))}]}]}};
  return resolveQuoteRevision({propertyCode:'HRCEN',authoredDate:'2026-10-04',selections:[{sourceRef:source.ref,groupId:g.id,optionId:'selected'}],resolveSource:async()=>source,resolvePolicy:async()=>({ref:'synthetic-board-policy',propertyCode:'HRCEN',sourceHashes:['b'.repeat(64)],authoredDates:['2026-09-26'],families:[{rateCode:g.rateCode,board:board==='Room Only R'?'room_only':board==='Bed & Breakfast R'?'breakfast':'dinner_bed_breakfast'}],vat:'included',levy:'included'}),admission:{authorizationId:'synthetic-auth',sourceEvaluationAt:'2026-10-04T10:00:00Z',maxSourceAgeMs:3600000,expectedRequests:{[source.ref]:request},authorizeSource:async()=>true}});
 }
 async function extractBoard(value:any,text:string,selected=text){
  const sourceHash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:synthetic-board',sourceHash,page:1,quote:selected,start:text.indexOf(selected),end:text.indexOf(selected)+selected.length};
  return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'board',kind:'board',value,source,disclosure:'guest'}],tasks:[{id:'quote',kind:'quote',factIds:['board'],source}],unresolvedAsks:[]}})} as any,messages:[{id:'synthetic-board',at:'2026-10-04T10:00:00Z',text}],causalAt:'2026-10-04T10:00:00Z',admissions:[],signal:new AbortController().signal});
 }
 it.each([
  ['B&B','Bed & Breakfast R'],['BB','Bed & Breakfast R'],['DBB','Dinner Bed & Breakfast R'],['RO','Room Only R'],
  ['room only','Room Only R'],['bed and breakfast','Bed & Breakfast R'],['bed & breakfast','Bed & Breakfast R'],['dinner bed and breakfast','Dinner Bed & Breakfast R'],['dinner bed & breakfast','Dinner Bed & Breakfast R'],['dinner, bed and breakfast','Dinner Bed & Breakfast R'],['dinner, bed & breakfast r','Dinner, Bed & Breakfast R'],['dinner, bed, breakfast & beverage r','Dinner, Bed, Breakfast & Beverage R'],['ROOM ONLY','Room Only R'],
 ])('maps only original explicit %s after extraction to its independently selected native board',async(label,native)=>{
  const text=`Please quote Group g1: ${label}.`,plan=await extractBoard({board:label,roomRef:'g1'},text),revision=await nativeBoardRevision(native);
  expect(plan.facts[0].verification).toBe('text_verified');expect(()=>assertRevision(plan.facts,revision)).not.toThrow();
 });
 it('keeps exact mixed-group room-only and breakfast aliases tied to the selected native groups',async()=>{
  const text='Please quote Group A: bed and breakfast. Group B: room only.',a=await extractBoard({board:'bed and breakfast',roomRef:'A'},text,'Group A: bed and breakfast'),b=await extractBoard({board:'room only',roomRef:'B'},text,'Group B: room only');
  const breakfast=await syntheticRevision(['100.00'],'Bed & Breakfast R'),roomOnly=await syntheticRevision(['100.00'],'Room Only R'),revision={...breakfast,groups:[{...breakfast.groups[0],id:'A'},{...roomOnly.groups[0],id:'B'}]};
  expect(()=>assertRevision([...a.facts,...b.facts],revision)).not.toThrow();expect(()=>assertRevision(a.facts,{...revision,groups:revision.groups.map(g=>({...g,board:'room_only'}))})).toThrow(/mismatch/);
 });
 it.each(['breakfast included','full board','room only perhaps'])('does not automatically authorize inclusion prose %s',async label=>{
  const plan=await extractBoard({board:label,roomRef:'g1'},`Please quote Group g1: ${label}.`),revision=await syntheticRevision(['100.00'],'Bed & Breakfast R');expect(()=>assertRevision(plan.facts,revision)).toThrow(/missing/);
 });
 it('does not borrow another original group board even when both words appear on the page',async()=>{
  await expect(extractBoard({board:'room only',roomRef:'A'},'Please quote Group A: bed and breakfast. Group B: room only.','Group B: room only')).rejects.toThrow(/entailed/);
 });
 it('keeps a scalar alias applies-to-all and rejects wrong or unknown selected group targets',async()=>{
  const revision:any={groups:[{id:'A',roomCode:'SKNG',board:'breakfast'},{id:'B',roomCode:'EXKNG',board:'room_only'}]};
  for(const value of ['room only',{board:'room only',roomRef:'A'},{board:'room only',roomRef:'C'},{board:'room only',roomRef:'Group B'}])expect(()=>assertRevision([fact('board','board',value)],revision)).toThrow(/mismatch/);
 });
});

it('allows causal quotation addressee without asserting a native organization association',async()=>{
 const revision=await syntheticRevision(['100.00'],'Room Only R','STQN');
 const party=fact('party','party','Example Public Department');
 expect(()=>sourceFacts.assertRevisionSourceFacts([party],revision,undefined,[],{company:'Example Public Department',agency:''})).not.toThrow();
 expect(()=>sourceFacts.assertRevisionSourceFacts([party],revision,undefined,[],{company:'Other Department',agency:''})).toThrow('party');
 expect(()=>sourceFacts.assertRevisionSourceFacts([party],revision,[],[],{company:'Example Public Department',agency:''})).toThrow('party');
});
it('does not let a matching quotation addressee mask conflicting native party context',async()=>{const revision=structuredClone(await syntheticRevision(['100.00'],'Room Only R','STQN'));revision.groups[0].context={organization:{name:'Different Company',nativeId:'2'}};expect(()=>sourceFacts.assertRevisionSourceFacts([fact('party','party','Requested Department')],revision,undefined,[],{company:'Requested Department',agency:''})).toThrow('party');});

it.each(['breakfast and\ndinner','BED \t & \n BREAKFAST'])('compares a source-verified scalar meal label across original whitespace: %s',label=>{const board=label.startsWith('breakfast')?'dinner_bed_breakfast':'breakfast',revision:any={groups:[{id:'1',board}]},source=fact('board','board',label),before=structuredClone(source);expect(()=>assertRevision([source],revision)).not.toThrow();expect(source).toEqual(before);expect(()=>assertRevision([source],{groups:[{id:'1',board:'room_only'}]}as any)).toThrow('mismatch');});
