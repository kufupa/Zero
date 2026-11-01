import {describe,it,expect} from 'vitest';
import * as sourceFacts from '../src/ai/reservationist-source-facts.js';
import {syntheticRevision} from './helpers/synthetic-quote-revision.js';
import type {BookingEvidence} from '../src/ai/reservationist-booking-packet.js';
import {quoteDigest,resolveQuoteRevision} from '../src/quote-proposal/quote-revision.js';
import {createHash} from 'node:crypto';
import {extractReservationistPlan,unmatchedCurrentVoucherReviewSources} from '../src/ai/reservationist-extraction.js';
import {deriveDocumentRequestContinuations} from '../src/ai/reservationist-document-continuation.js';
import {HTML_ALTERNATIVE_MARKER} from '../src/ai/reservationist-message-view.js';
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
 it.each([
  ['Bed & Breakfast NR','breakfast'],
  ['Room Only NR','room_only'],
  ['Dinner Bed & Breakfast NR','dinner_bed_breakfast'],
  ['Dinner, Bed & Breakfast NR','dinner_bed_breakfast'],
 ])('maps %s through assertRevisionSourceFacts as %s (D7 Non-Rewardable)',(label,board)=>{
  expect(()=>assertRevision([fact('board','board',label)],{groups:[{id:'g1',board}]} as any)).not.toThrow();
 });
});

it('holds invoice continuation when either message has differing MIME views',()=>{
 const at='2026-10-01T08:00:00Z',request='Please send the final invoice for payment for the booking.';
 const prior={id:'prior',at:'2026-09-30T08:00:00Z',direction:'inbound' as const,text:request};
 const trigger={id:'current',at,direction:'inbound' as const,text:`Please see the quotation. You can book the rooms.\n\nFrom: guest@example.invalid\n\n${request}`};
 const derive=(messages:any[])=>deriveDocumentRequestContinuations({messages,triggerMessageId:'current',causalAt:at});
 expect(derive([prior,trigger])).toHaveLength(1);
 expect(derive([prior,{...trigger,sourceViews:[{}]}])).toEqual([]);
 expect(derive([{...prior,sourceViews:[{}]},trigger])).toEqual([]);
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

describe('plain and HTML citation binding',()=>{
 const plain='Do not use: Please quote one room: Arrival 21 December; departure 23 December';
 const html='Please quote one room: Arrival 21 December; departure 23 December';
 const quote='Arrival 21 December; departure 23 December';
 const at='2026-10-01T08:00:00Z',separator=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=plain.length+separator.length,text=`${plain}${separator}${html}`;
 const attachmentId='message:alternatives',sourceHash=createHash('sha256').update(text).digest('hex');
 const views=[{name:'plain' as const,start:0,end:plain.length},{name:'html' as const,start:htmlStart,end:text.length}];
 const schemas:any[]=[],prompts:string[]=[];
 const extract=async(mode:'combined'|'task_first',view?:'plain'|'html')=>{
  let calls=0;
  const dateSource={attachmentId,sourceHash,page:1,quote,...(view?{view}:{})},taskSource={attachmentId,sourceHash,page:1,quote:html,...(view?{view}:{})};
  const fact={id:'stay',kind:'dates',value:{arrival:'21 December',departure:'23 December'},disclosure:'guest',source:dateSource},task={id:'quote',kind:'quote',factIds:['stay'],source:taskSource};
  return extractReservationistPlan({mode,adapter:{reserveCalls:async()=>{},invoke:async(request:any)=>{schemas.push(request.responseSchema);prompts.push(request.systemPrompt);calls++;if(mode==='task_first'&&calls===1)return{output:{facts:[],tasks:[{...task,factIds:[]}],unresolvedAsks:[]}};if(mode==='task_first')return{output:{facts:[fact],assignments:[{taskId:'quote',factIds:['stay']}],unresolvedAsks:[]}};return{output:{facts:[fact],tasks:[task],unresolvedAsks:[]}};}} as any,messages:[{id:'alternatives',at,text,direction:'inbound',sourceViews:views}],triggerMessageId:'alternatives',causalAt:at,admissions:[],signal:new AbortController().signal});
 };
 const hasViewSchema=(node:any):boolean=>Boolean(node&&typeof node==='object'&&(node.properties?.view?.enum?.join(',')==='plain,html,plain_quoted,html_quoted'||Object.values(node).some(hasViewSchema)));
 it.each(['combined','task_first'] as const)('refuses duplicate text without a view and validates only the selected alternative (%s)',async mode=>{
  await expect(extract(mode)).rejects.toThrow('Ambiguous original text span');
  const plan=await extract(mode,'html');
  expect(schemas.every(hasViewSchema)).toBe(true);
  expect(prompts.every(prompt=>prompt.includes('When the exact quote appears more than once across source views, include source.view naming the one exact authored or quoted range; never leave duplicate-range resolution to the server.'))).toBe(true);
  expect(plan.tasks[0]).toMatchObject({source:{start:htmlStart,end:text.length}});
  expect(plan.facts[0]).toMatchObject({value:{arrival:'2026-12-21',departure:'2026-12-23'},source:{start:htmlStart+html.indexOf(quote),end:htmlStart+html.indexOf(quote)+quote.length}});
 });
 const extractHtmlFact=async(id:string,body:string,kind:string,value:any)=>{
  const plain=`${body}\nKind regards\nGuest`,html=`${plain}\nExtra line`,separator=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=plain.length+separator.length,text=`${plain}${separator}${html}`,attachmentId=`message:${id}`,sourceHash=createHash('sha256').update(text).digest('hex'),source={attachmentId,sourceHash,page:1,quote:body,view:'html'};
  const plan=await extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'fact',kind,value,disclosure:'guest',source}],tasks:[{id:'quote',kind:'quote',factIds:['fact'],source}],unresolvedAsks:[]}})} as any,messages:[{id,at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length},{name:'html',start:htmlStart,end:text.length}]}],triggerMessageId:id,causalAt:at,admissions:[],signal:new AbortController().signal});return{plan,htmlStart};
 };
 it('keeps a linked per-room rate task across wording-different authored alternatives and rejects a conflicting one',async()=>{
  const at='2026-10-01T08:00:00Z',plain='Please provide single and double occupancy rates.',separator='\n\n'+HTML_ALTERNATIVE_MARKER,htmlStart=plain.length+separator.length;
  const run=async(taskQuote:string)=>{
   const text=plain+separator+taskQuote,attachmentId='message:cross-view-rate',sourceHash=createHash('sha256').update(text).digest('hex');
   return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'rate',kind:'room',value:{roomRef:'1',quantity:1,quotationBasis:'per_room_rate',adults:1,childAges:[]},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:plain,view:'plain'}}],tasks:[{id:'quote',kind:'quote',factIds:['rate'],source:{attachmentId,sourceHash,page:1,quote:taskQuote,view:'html'}}],unresolvedAsks:[]}})} as any,messages:[{id:'cross-view-rate',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length},{name:'html',start:htmlStart,end:text.length}]}],triggerMessageId:'cross-view-rate',causalAt:at,admissions:[],signal:new AbortController().signal});
  };
  const html='Could you please provide single and double room rates?',plan=await run(html);
  expect(plan.facts[0]).toMatchObject({id:'rate',source:{start:0,end:plain.length},value:{quotationBasis:'per_room_rate'}});
  expect(plan.tasks[0]).toMatchObject({id:'quote',source:{start:htmlStart,end:htmlStart+html.length}});
  await expect(run('Please do not quote single and double room rates.')).rejects.toThrow();
 });
 it.each([
  {id:'html-room',body:'Please quote one room for one adult.',kind:'room',value:{roomRef:'1',quantity:1,adults:1,childAges:[]},expected:{convention:{rule:'centurion_staff_occupancy_v1'}}},
  {id:'html-rate',body:'Please provide single and double occupancy rates.',kind:'room',value:{roomRef:'1',quantity:1,quotationBasis:'per_room_rate',adults:1,childAges:[]},expected:{value:{quotationBasis:'per_room_rate'}}},
  {id:'html-guest',body:'Please quote one single room for Mr Alex Example.',kind:'guest',value:{firstName:'Alex',lastName:'Example',roomRef:'1',roomIndex:1},expected:{value:{firstName:'Alex',lastName:'Example',roomRef:'1',roomIndex:1}}},
 ])('scopes $id proof to the cited HTML alternative',async scenario=>{const {plan,htmlStart}=await extractHtmlFact(scenario.id,scenario.body,scenario.kind,scenario.value);expect(plan.facts[0]).toMatchObject(scenario.expected);expect(plan.facts[0]?.source.start).toBe(htmlStart);});
 it('uses an alternate guest citation only when its exact quote repeats in the selected view',async()=>{
  const quote='Please quote for Mr Alex Example.',run=async(htmlQuote:string)=>{
   const plain=`${quote}\nKind regards\nGuest`,html=`${htmlQuote}\nKind regards\nGuest\nExtra line`,separator=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=plain.length+separator.length,text=`${plain}${separator}${html}`,attachmentId='message:cross-view-guest',sourceHash=createHash('sha256').update(text).digest('hex');
   return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'guest',kind:'guest',value:{firstName:'Alex',lastName:'Example'},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote,view:'plain'}},{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults:1,childAges:[]},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:htmlQuote,view:'html'}}],tasks:[{id:'quote',kind:'quote',factIds:['room','guest'],source:{attachmentId,sourceHash,page:1,quote:htmlQuote,view:'html'}}],unresolvedAsks:[]}})} as any,messages:[{id:'cross-view-guest',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length},{name:'html',start:htmlStart,end:text.length}]}],triggerMessageId:'cross-view-guest',causalAt:at,admissions:[],signal:new AbortController().signal});
  };
  await expect(run(quote)).resolves.toMatchObject({facts:[{id:'guest'},{id:'room',convention:{rule:'centurion_staff_occupancy_v1'}}]});
  await expect(run('Please quote for Mr Morgan Sample.')).rejects.toThrow('Document fact value not entailed by source span');
 });
 it('keeps an explicitly activated room request in its selected quoted range',async()=>{
  const plain='Please send a quotation for the earlier room request.',html=`${plain}\nKind regards`,separator=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=plain.length+separator.length,htmlEnd=htmlStart+html.length,roomQuote='Please quote one room for one adult.',history=`From: guest@example.invalid\nSubject: Original request\n\n${roomQuote}`,quotedStart=htmlEnd+2,text=`${plain}${separator}${html}\n\n${history}`,attachmentId='message:quoted-room',sourceHash=createHash('sha256').update(text).digest('hex');
  const plan=await extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults:1,childAges:[]},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:roomQuote,view:'plain_quoted'}}],tasks:[{id:'quote',kind:'quote',factIds:['room'],source:{attachmentId,sourceHash,page:1,quote:plain,view:'plain'}}],unresolvedAsks:[]}})} as any,messages:[{id:'quoted-room',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length,quoted:{start:quotedStart,end:text.length}},{name:'html',start:htmlStart,end:htmlEnd}]}],triggerMessageId:'quoted-room',causalAt:at,admissions:[],signal:new AbortController().signal});
  expect(plan.facts[0]).toMatchObject({kind:'room',convention:{rule:'centurion_staff_occupancy_v1'}});
 });
 it('links a shared quoted room request to the HTML renewal, but not to a different history',async()=>{
  const plain='Please review the earlier request.',html='Please quote the earlier request.',separator=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=plain.length+separator.length,htmlEnd=htmlStart+html.length,roomQuote='Please quote one room for one adult.',history=`From: guest@example.invalid\nSubject: Original request\n\n${roomQuote}`,quotedStart=htmlEnd+2,text=`${plain}${separator}${html}\n\n${history}`,attachmentId='message:shared-history',sourceHash=createHash('sha256').update(text).digest('hex'),quoted={start:quotedStart,end:text.length};
  const run=(shared:boolean)=>extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults:1,childAges:[]},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:roomQuote,view:'plain_quoted'}}],tasks:[{id:'quote',kind:'quote',factIds:['room'],source:{attachmentId,sourceHash,page:1,quote:html,view:'html'}}],unresolvedAsks:[]}})} as any,messages:[{id:'shared-history',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length,quoted},{name:'html',start:htmlStart,end:htmlEnd,...(shared?{quoted}:{})}]}],triggerMessageId:'shared-history',causalAt:at,admissions:[],signal:new AbortController().signal});
  await expect(run(true)).resolves.toMatchObject({facts:[{id:'room',convention:{rule:'centurion_staff_occupancy_v1'}}]});
  await expect(run(false)).rejects.toThrow('Document fact value not entailed by source span');
 });
 it('retains a linked current quote when an earlier room request has MIME views',async()=>{
  const prior='Please quote one double room for two adults.',html=`${prior}\nKind regards`,marker=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=prior.length+marker.length,text=`${prior}${marker}${html}`;
  const current='Please quote the original room request.',priorHash=createHash('sha256').update(text).digest('hex'),currentHash=createHash('sha256').update(current).digest('hex');
  const run=async(kind:'quote'|'new_booking')=>extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:{attachmentId:'message:prior-room',sourceHash:priorHash,page:1,quote:prior,view:'plain'}}],tasks:[{id:'task',kind,factIds:['room'],source:{attachmentId:'message:current-quote',sourceHash:currentHash,page:1,quote:current}}],unresolvedAsks:[]}})} as any,messages:[{id:'prior-room',at:'2026-09-30T08:00:00Z',direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:prior.length},{name:'html',start:htmlStart,end:text.length}]},{id:'current-quote',at,direction:'inbound',text:current}],triggerMessageId:'current-quote',causalAt:at,admissions:[],signal:new AbortController().signal});
  await expect(run('quote')).resolves.toMatchObject({facts:[{id:'room',convention:{rule:'centurion_staff_occupancy_v1'}}]});
  await expect(run('new_booking')).rejects.toThrow('Document fact value not entailed by source span');
 });
 it('retains a quote linked across differently worded MIME views, but refuses booking or negated occupancy',async()=>{
  const marker=`\n\n${HTML_ALTERNATIVE_MARKER}`;
  const run=async(html:string,kind:'quote'|'new_booking',plain='Please quote one double room for two adults.',adults=2)=>{const htmlStart=plain.length+marker.length,text=`${plain}${marker}${html}`,sourceHash=createHash('sha256').update(text).digest('hex'),attachmentId='message:views';
   return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults,childAges:[]},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:html,view:'html'}}],tasks:[{id:'task',kind,factIds:['room'],source:{attachmentId,sourceHash,page:1,quote:plain,view:'plain'}}],unresolvedAsks:[]}})} as any,messages:[{id:'views',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length},{name:'html',start:htmlStart,end:text.length}]}],triggerMessageId:'views',causalAt:at,admissions:[],signal:new AbortController().signal});};
  await expect(run('Kindly quote one double room for two adults.','quote')).resolves.toMatchObject({facts:[{convention:{rule:'centurion_staff_occupancy_v1'}}]});
  await expect(run('Kindly quote one double room for two adults.','new_booking')).rejects.toThrow();
  await expect(run('Kindly do not quote one double room for two adults.','quote')).rejects.toThrow();
  await expect(run('Kindly quote one double room for two adults.','quote','Please do not quote one double room for two adults.')).rejects.toThrow('Conflicting quote request across message views');
  await expect(run('Kindly quote one single room for one adult.','quote',undefined,1)).rejects.toThrow('Conflicting occupancy across message views');
  await expect(run('Kindly quote one double room for two adults.','quote','Please quote one double room for two adults. Do not book us yet.')).resolves.toMatchObject({facts:[{kind:'room'}]});
 });
 it('compares only established occupancy across alternatives and retains verified guest names',async()=>{
  const marker=`\n\n${HTML_ALTERNATIVE_MARKER}`,run=(plain:string,html:string,names:boolean)=>{const htmlStart=plain.length+marker.length,text=`${plain}${marker}${html}`,sourceHash=createHash('sha256').update(text).digest('hex'),attachmentId='message:occupancy-views',src=(quote:string)=>({attachmentId,sourceHash,page:1,quote,view:'html'});
   const guests=names?[{id:'guest1',kind:'guest',value:{firstName:'Alex',lastName:'Example'},disclosure:'guest',source:src('Alex Example')},{id:'guest2',kind:'guest',value:{firstName:'Taylor',lastName:'Sample'},disclosure:'guest',source:src('Taylor Sample')}]:[];
   return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'room',kind:'room',value:{roomRef:'1',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:src(html)},...guests],tasks:[{id:'quote',kind:'quote',factIds:['room',...guests.map(g=>g.id)],source:{attachmentId,sourceHash,page:1,quote:plain,view:'plain'}}],unresolvedAsks:[]}})} as any,messages:[{id:'occupancy-views',at,direction:'inbound',text,sourceViews:[{name:'plain',start:0,end:plain.length},{name:'html',start:htmlStart,end:text.length}]}],triggerMessageId:'occupancy-views',causalAt:at,admissions:[],signal:new AbortController().signal});};
  await expect(run('Please quote one room for Mr Alex Example and Ms Taylor Sample.','Kindly quote one room for Mr Alex Example and Ms Taylor Sample.',true)).resolves.toMatchObject({facts:[{id:'room',convention:{rule:'centurion_staff_occupancy_v1'}},{id:'guest1'},{id:'guest2'}]});
  await expect(run('Please quote one room.','Kindly quote one room for two adults.',false)).resolves.toMatchObject({facts:[{id:'room',convention:{rule:'centurion_staff_occupancy_v1'}}]});
 });
 it('binds quoted history through a distinct range, not an identical authored copy',async()=>{
  const body='Please rebook this stay. Do not use the old dates: Arrival 21 December 2026; departure 23 December 2026';
  const alternate='Please rebook this stay using the previous quotation.';
  const history='From: guest@example.invalid\nSubject: Original stay\n\nArrival 21 December 2026; departure 23 December 2026';
  const request='Please rebook this stay.',dateQuote='Arrival 21 December 2026; departure 23 December 2026';
  const marker=`\n\n${HTML_ALTERNATIVE_MARKER}`,htmlStart=body.length+marker.length,htmlEnd=htmlStart+alternate.length,historyStart=htmlEnd+2,text=`${body}${marker}${alternate}\n\n${history}`;
  const attachmentId='message:quoted-alternatives',sourceHash=createHash('sha256').update(text).digest('hex');
  const sourceViews=[{name:'plain' as const,start:0,end:body.length,quoted:{start:historyStart,end:text.length}},{name:'html' as const,start:htmlStart,end:htmlEnd}];
  const extract=async(view?:'plain'|'plain_quoted')=>extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'stay',kind:'dates',value:{arrival:'21 December 2026',departure:'23 December 2026'},disclosure:'guest',source:{attachmentId,sourceHash,page:1,quote:dateQuote,...(view?{view}:{})}}],tasks:[{id:'quote',kind:'quote',factIds:['stay'],source:{attachmentId,sourceHash,page:1,quote:request,view:'plain'}}],unresolvedAsks:[]}})} as any,messages:[{id:'quoted-alternatives',at,direction:'inbound',text,sourceViews}],triggerMessageId:'quoted-alternatives',causalAt:at,admissions:[],signal:new AbortController().signal});
  await expect(extract()).rejects.toThrow('Ambiguous original text span');
  const plan=await extract('plain_quoted');
  expect(plan.facts[0]?.source.start).toBe(historyStart+history.indexOf(dateQuote));
 });
 it('counts equivalent plain/HTML voucher asks once without merging separate asks in one view',async()=>{
  const at='2026-10-01T08:00:00Z',separator=`\n\n${HTML_ALTERNATIVE_MARKER}`;
  const run=async(plain:string,html:string,tasks:{id:string;quote:string;view:'plain'|'html';kind?:'question'|'quote'}[])=>{
   const htmlStart=plain.length+separator.length,text=`${plain}${separator}${html}`,attachmentId='message:voucher-alternatives',sourceHash=createHash('sha256').update(text).digest('hex'),sourceViews=[{name:'plain' as const,start:0,end:plain.length},{name:'html' as const,start:htmlStart,end:text.length}];let calls=0;
   const messages=[{id:'voucher-alternatives',at,text,direction:'inbound' as const,sourceViews}],plan=await extractReservationistPlan({mode:'task_first',adapter:{reserveCalls:async()=>{},invoke:async()=>{calls++;if(calls===1)return{output:{facts:[],tasks:tasks.map(task=>({id:task.id,kind:task.kind??'question',factIds:[],source:{attachmentId,sourceHash,page:1,quote:task.quote,view:task.view}})),unresolvedAsks:[]}};return{output:{facts:[],assignments:tasks.map(task=>({taskId:task.id,factIds:[]})),unresolvedAsks:[]}};}} as any,messages,triggerMessageId:'voucher-alternatives',causalAt:at,admissions:[],signal:new AbortController().signal});
   return {...plan,voucherReviewSources:unmatchedCurrentVoucherReviewSources(plan.tasks,messages,'voucher-alternatives')};
  };
  const ask='Please review attached voucher';
  await expect(run(ask,`${ask}.\n\nThe rooming list is attached.`,[{id:'plain',quote:ask,view:'plain'}])).resolves.toMatchObject({tasks:[{id:'plain'}]});
  await expect(run(ask,`${ask}.\n\nThe rooming list is attached.`,[{id:'plain',quote:ask,view:'plain'},{id:'html',quote:ask,view:'html'}])).resolves.toMatchObject({tasks:[{id:'plain'},{id:'html'}],voucherReviewSources:[expect.objectContaining({quote:'attached voucher'})]});
  const repeated='Please review the attached voucher (it remains under review until signed, and the attached voucher is the corrected copy).';
  await expect(run(repeated,`${repeated}\n\nThe rooming list is attached.`,[{id:'single',quote:'Please review the attached voucher',view:'plain'}])).resolves.toMatchObject({tasks:[{id:'single'}]});
  await expect(run(repeated,`${repeated}\n\nThe rooming list is attached.`,[{id:'plain',quote:'Please review the attached voucher',view:'plain'},{id:'html',quote:'Please review the attached voucher',view:'html'}])).resolves.toMatchObject({tasks:[{id:'plain'},{id:'html'}],voucherReviewSources:[expect.objectContaining({quote:'attached voucher'})]});
  const other='Also review enclosed hotel voucher for the second guest.';
  await expect(run(`${ask}. ${other}`,`${ask}.\n\nThe rooming list is attached.`,[{id:'first',quote:`${ask}.`,view:'plain'}])).resolves.toMatchObject({tasks:[{id:'first'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  await expect(run(`${ask}. ${other}`,`${ask}.\n\nThe rooming list is attached.`,[{id:'combined',quote:`${ask}. ${other}`,view:'plain'}])).resolves.toMatchObject({tasks:[{id:'combined'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  await expect(run(`${ask}. ${other}`,`${ask}.\n\nThe rooming list is attached.`,[{id:'first',quote:`${ask}.`,view:'plain'},{id:'second',quote:other,view:'plain'}])).resolves.toMatchObject({tasks:[{id:'first'},{id:'second'}]});
  const sameSentence='Please review attached voucher for guest A and also review enclosed hotel voucher for guest B.',separateTasks=[{id:'guest-a',quote:'Please review attached voucher for guest A',view:'plain' as const},{id:'guest-b',quote:'review enclosed hotel voucher for guest B',view:'plain' as const}];
  await expect(run(sameSentence,sameSentence,separateTasks)).resolves.toMatchObject({tasks:[{id:'guest-a'},{id:'guest-b'}]});
  await expect(run(sameSentence,sameSentence,separateTasks.slice(0,1))).resolves.toMatchObject({tasks:[{id:'guest-a'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  const commaAlso='Please review attached voucher for guest A, also check enclosed hotel voucher for guest B.',commaTasks=[{id:'guest-a',quote:'Please review attached voucher for guest A',view:'plain' as const},{id:'guest-b',quote:'also check enclosed hotel voucher for guest B',view:'plain' as const}];
  await expect(run(commaAlso,commaAlso,commaTasks)).resolves.toMatchObject({tasks:[{id:'guest-a'},{id:'guest-b'}]});
  await expect(run(commaAlso,commaAlso,commaTasks.slice(0,1))).resolves.toMatchObject({tasks:[{id:'guest-a'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  const lookAt='Please review attached voucher for guest A and also look at enclosed hotel voucher for guest B.',lookAtTasks=[{id:'guest-a',quote:'Please review attached voucher for guest A',view:'plain' as const},{id:'guest-b',quote:'also look at enclosed hotel voucher for guest B',view:'plain' as const}];
  await expect(run(lookAt,lookAt,lookAtTasks)).resolves.toMatchObject({tasks:[{id:'guest-a'},{id:'guest-b'}]});
  await expect(run(lookAt,lookAt,lookAtTasks.slice(0,1))).resolves.toMatchObject({tasks:[{id:'guest-a'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  const thenCheck='Please review attached voucher for guest A, then check enclosed hotel voucher for guest B.',thenTasks=[{id:'guest-a',quote:'Please review attached voucher for guest A',view:'plain' as const},{id:'guest-b',quote:'then check enclosed hotel voucher for guest B',view:'plain' as const}];
  await expect(run(thenCheck,thenCheck,thenTasks)).resolves.toMatchObject({tasks:[{id:'guest-a'},{id:'guest-b'}]});
  await expect(run(thenCheck,thenCheck,thenTasks.slice(0,1))).resolves.toMatchObject({tasks:[{id:'guest-a'}],voucherReviewSources:[expect.objectContaining({quote:'enclosed hotel voucher'})]});
  await expect(run('Please review attached voucher for guest A.','Please review the attached voucher for guest A.',[{id:'one-request',quote:'Please review attached voucher for guest A.',view:'plain'}])).resolves.toMatchObject({tasks:[{id:'one-request'}]});
  const descriptiveSameRequest='Please review attached voucher for guest A (our accounts team will also check the attached voucher tomorrow).';
  await expect(run(descriptiveSameRequest,descriptiveSameRequest,[{id:'one-request',quote:'Please review attached voucher for guest A',view:'plain'}])).resolves.toMatchObject({tasks:[{id:'one-request'}]});
  await expect(run('Please quote one room\n\nDo not use attached voucher.','No voucher is attached.',[{id:'quote',quote:'Please quote one room',view:'plain',kind:'quote'}])).resolves.toMatchObject({tasks:[{id:'quote'}]});
  await expect(run('Please review attached voucher.','No voucher is included.',[])).resolves.toMatchObject({tasks:[],unresolvedAsks:[],voucherReviewSources:[expect.objectContaining({quote:'attached voucher'})]});
 });
});
