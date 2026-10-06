import {describe,it,expect} from 'vitest';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {prepareBookingPacket,type BookingSourceProof} from '../src/ai/reservationist-booking-packet.js';
const hash='a'.repeat(64), at='2026-10-04T10:00:00Z';
function fixture(){
 const group:any={id:'g1',sourceRef:'source',sourceHash:hash,toolVersion:'2',observedAt:at,arrivalDate:'2026-10-12',departureDate:'2026-10-14',quantity:1,adults:1,children:0,childAges:[],roomCode:'STQN',rateCode:'BAR',board:'room_only',context:{},nightly:[{date:'2026-10-12',amountMinor:10000,inventory:2},{date:'2026-10-13',amountMinor:10000,inventory:2}],totalMinor:20000,perRoomMinor:20000,inclusions:{restrictions:{status:'supported'},childMealEntitlement:{status:'supported',childAges:[]}}};
 const data:any={version:1,scopeDigest:hash,propertyCode:'HRCEN',authoredDate:'2026-10-04',validity:{days:3,anchor:'authored_date',cutoff:'unresolved'},groups:[group],currency:'ZAR',totalMinor:20000,held:false,authorizationId:'auth',inventoryStatus:'observed_not_held'};
 const revision={...data,id:`quote:${quoteDigest(data)}`};
 const proof={sourceRef:'source',sourceHash:hash,authorizationId:'auth',propertyCode:'HRCEN',scopeDigest:hash,observedAt:at,expiresAt:'2026-10-04T12:00:00Z',maxSourceAgeMs:3600000};
 const input:any={revisionId:revision.id,scopeDigest:hash,rooms:[{groupId:'g1',roomIndex:1,guests:[{factRef:'guest1',firstName:'Alex',lastName:'Example'}],sourceOfBusiness:'E-Mail',track:'BAR',guaranteeType:'Non-Guaranteed Individual'}]};
 const evidence:any={revision,availability:{...proof,available:true},duplicates:{...proof,matches:[]},codes:{...proof,roomTypes:['STQN'],ratePlans:['BAR'],sources:['E-Mail'],tracks:['BAR'],guarantees:['Non-Guaranteed Individual'],eligibility:[{groupId:'g1',roomCode:'STQN',rateCode:'BAR',board:'room_only',dates:['2026-10-12','2026-10-13'],adults:1,childAges:[],context:{}}]},authorizedFields:{...proof,sourceOfBusiness:'E-Mail',track:'BAR',guaranteeType:'Non-Guaranteed Individual'},guestFacts:[{...proof,factRef:'guest1',groupId:'g1',roomIndex:1,firstName:'Alex',lastName:'Example'}],partyFacts:[],acceptance:{acceptedAt:at,scopeDigest:hash,sentProof:{revisionId:revision.id,authorizationId:'auth',sentAt:at,sourceRef:'sent',sourceHash:hash},inventoryEvidence:{revisionId:revision.id,scopeDigest:hash,authorizationId:'auth',observedAt:at,available:true,maxAgeMs:60000}},causalAt:at};
 return {input,evidence,deps:{resolveEvidence:async()=>evidence,authorizeSource:async(_proof:BookingSourceProof,_signal:AbortSignal)=>true,signal:new AbortController().signal,deadlineAt:Date.now()+60000}};
}
describe('source-backed nonexecuting physical room packets',()=>{
 it('prepares validated pending room without write edge',async()=>{const f=fixture();const r=await prepareBookingPacket(f.input,f.deps);expect(r.status).toBe('pending_pms_action');expect(r.saved).toBe(false);expect(r.nativeSaveAcceptance).toBe('untested');});
 it.each(['hash','auth','expiry','fingerprint','eligibility','guest','party','future','duplicate','stock','name','calendar','occupancy','abort'])('rejects %s and all partial packets',async kind=>{const f=fixture();if(kind==='hash')f.evidence.codes.sourceHash='bad';if(kind==='auth')f.deps.authorizeSource=async()=>false;if(kind==='expiry')f.evidence.acceptance.acceptedAt='2026-10-08T10:00:00Z';if(kind==='fingerprint')f.evidence.revision.totalMinor++;if(kind==='eligibility')f.evidence.codes.eligibility=[];if(kind==='guest')f.evidence.guestFacts=[];if(kind==='party')f.evidence.revision.groups[0].context={arAccount:{name:'Invented'}};if(kind==='future')f.evidence.duplicates.observedAt='2026-10-05T00:00:00Z';if(kind==='duplicate')f.evidence.duplicates.matches=['prior'];if(kind==='stock')f.evidence.availability.available=false;if(kind==='name')f.input.rooms[0].guests[0].lastName='Wrong';if(kind==='calendar')f.evidence.revision.groups[0].arrivalDate='2026-02-31';if(kind==='occupancy')f.input.rooms[0].guests=[];if(kind==='abort'){const c=new AbortController();c.abort();f.deps.signal=c.signal;}const r=await prepareBookingPacket(f.input,f.deps);expect(r.status).toBe('blocked');expect(r.rooms).toEqual([]);expect(r.businessRulesValidated).toBe(false);});
});
it('blocks changed authorization proofs and preserves current versus causal packet authorities',async()=>{
 const f=fixture();f.deps.authorizeSource=async(proof:any)=>{proof.sourceHash='b'.repeat(64);return true;};
 expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('blocked');
 const valid=fixture(),packet=await prepareBookingPacket(valid.input,valid.deps);
 expect(packet).toMatchObject({authorizationId:'auth',propertyCode:'HRCEN'});
 expect((packet as any).sourceProofs).toEqual(expect.arrayContaining([expect.objectContaining({kind:'current',sourceRef:'source',sourceHash:hash,observedAt:at,expiresAt:valid.evidence.codes.expiresAt,maxSourceAgeMs:valid.evidence.codes.maxSourceAgeMs}),expect.objectContaining({kind:'causal',sourceRef:'sent',sourceHash:hash,observedAt:at})]));
});
function rehash(f:ReturnType<typeof fixture>){const {id,...data}=f.evidence.revision;f.evidence.revision.id=`quote:${quoteDigest(data)}`;f.input.revisionId=f.evidence.revision.id;f.evidence.acceptance.sentProof.revisionId=f.input.revisionId;f.evidence.acceptance.inventoryEvidence.revisionId=f.input.revisionId;}
it('quantity expands physically and a bad second assignment returns no partial packet',async()=>{const f=fixture();f.evidence.revision.groups[0].quantity=2;f.evidence.revision.groups[0].totalMinor=40000;f.evidence.revision.totalMinor=40000;f.input.rooms.push({...f.input.rooms[0],roomIndex:2,guests:[{factRef:'guest2',firstName:'Taylor',lastName:'Example'}]});f.evidence.guestFacts.push({...f.evidence.guestFacts[0],factRef:'guest2',roomIndex:2,firstName:'Taylor'});rehash(f);expect((await prepareBookingPacket(f.input,f.deps)).rooms).toHaveLength(2);f.input.rooms[1].guests[0].firstName='Invented';expect((await prepareBookingPacket(f.input,f.deps)).rooms).toEqual([]);});
it('organization agency and AR require separate matching evidence; profile is preserved',async()=>{const f=fixture();const context={organization:{name:'Synthetic Org',nativeId:'org1'},agency:{name:'Synthetic Agency',nativeId:'agency1'},arAccount:{name:'Synthetic AR',nativeId:'ar1'}};f.evidence.revision.groups[0].context=context;f.evidence.codes.eligibility[0].context=context;for(const[k,v]of Object.entries(context))f.evidence.partyFacts.push({...f.evidence.codes,kind:k,...v});f.input.rooms[0].guests[0].profileId='123';f.evidence.guestFacts[0].profileId='123';f.evidence.partyFacts.push({...f.evidence.codes,kind:'guest',name:'Alex Example',nativeId:'123'});rehash(f);const r=await prepareBookingPacket(f.input,f.deps);expect(r.rooms[0].request).toMatchObject({organization:'Synthetic Org',agency:'Synthetic Agency',arAccount:'Synthetic AR',profileId:{nativeId:'123',kind:'guest'}});f.evidence.partyFacts=f.evidence.partyFacts.filter((p:any)=>p.kind!=='arAccount');expect((await prepareBookingPacket(f.input,f.deps)).rooms).toEqual([]);});

it('keeps the accepted historical price while validating later current inventory in a separate clock',async()=>{
 const f=fixture(),current='2026-10-04T11:00:00Z';
 for(const proof of [f.evidence.availability,f.evidence.duplicates,f.evidence.codes,f.evidence.authorizedFields])proof.observedAt=current;
 f.evidence.acceptance.inventoryEvidence.observedAt=current;
 const deps={...f.deps,clock:{causalAt:at,sourceAt:current,sourceMode:'current_read' as const}};
 const packet=await prepareBookingPacket(f.input,deps);
 expect(packet.status).toBe('pending_pms_action');expect(packet.rooms[0].request.ratePlan).toBe('BAR');
 expect((await prepareBookingPacket(f.input,{...deps,clock:{...deps.clock,sourceMode:'historical'}})).status).toBe('blocked');
 f.evidence.guestFacts[0].observedAt=current;
 expect((await prepareBookingPacket(f.input,deps)).status).toBe('blocked');
});
it('refuses evidence whose causal time differs from the actual inbound clock',async()=>{
 const f=fixture();f.evidence.causalAt='2026-10-05T10:00:00Z';
 expect((await prepareBookingPacket(f.input,{...f.deps,clock:{causalAt:at,sourceAt:at,sourceMode:'historical' as const}})).status).toBe('blocked');
});

it('prepares a new booking from a selected authorized revision without inventing prior sent acceptance',async()=>{
 const f=fixture(),{id,...data}=f.evidence.revision;
 f.evidence.revision={...data,sourceFreshness:{authorizationId:'auth',sourceRefs:['source'],observedAt:at,expiresAt:'2026-10-04T11:00:00Z',purpose:'offer_source'}};
 f.evidence.revision.id=`quote:${quoteDigest(f.evidence.revision)}`;
 f.input.revisionId=f.evidence.revision.id;f.input.kind='new_booking';
 delete f.evidence.acceptance;
 const result=await prepareBookingPacket(f.input,{...f.deps,clock:{causalAt:at,sourceAt:at,sourceMode:'current_read' as const}});
 expect(result.status).toBe('pending_pms_action');expect(result.saved).toBe(false);expect(result.rooms).toHaveLength(1);
 f.evidence.availability.available=false;
 expect((await prepareBookingPacket(f.input,f.deps)).rooms).toEqual([]);
});
it('refuses a new booking revision without current price authority',async()=>{
 const f=fixture();f.input.kind='new_booking';delete f.evidence.acceptance;
 const r=await prepareBookingPacket(f.input,f.deps);expect(r.status).toBe('blocked');expect(r.rooms).toEqual([]);
});

it('requires every selected native price source independently authorized for a new booking',async()=>{
 const f=fixture();f.input.kind='new_booking';delete f.evidence.acceptance;
 f.evidence.revision.groups[0].sourceRef='native-rate';f.evidence.revision.groups[0].sourceHash='b'.repeat(64);f.evidence.revision.groups[0].toolVersion='2';f.evidence.revision.groups[0].observedAt=at;
 f.evidence.revision.sourceFreshness={authorizationId:'auth',sourceRefs:['native-rate'],observedAt:at,expiresAt:'2026-10-04T11:00:00Z',purpose:'offer_source'};
 const {id,...data}=f.evidence.revision;f.evidence.revision.id=`quote:${quoteDigest(data)}`;f.input.revisionId=f.evidence.revision.id;
 const authorized:string[]=[];f.deps.authorizeSource=async(proof:any)=>{authorized.push(proof.sourceRef);return true;};
 expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('pending_pms_action');expect(authorized).toContain('native-rate');
 f.deps.authorizeSource=async(proof:any)=>proof.sourceRef!=='native-rate';
 expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('blocked');
});

it('does not use old catalog rules or inventory for a newly prepared booking',async()=>{
 const f=fixture();f.input.kind='new_booking';delete f.evidence.acceptance;
 f.evidence.revision.sourceFreshness={authorizationId:'auth',sourceRefs:['source'],observedAt:at,expiresAt:'2026-10-04T11:00:00Z',purpose:'offer_source'};
 const {id,...data}=f.evidence.revision;f.evidence.revision.id=`quote:${quoteDigest(data)}`;f.input.revisionId=f.evidence.revision.id;
 f.evidence.availability.observedAt='2026-09-04T10:00:00Z';
 expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('blocked');
});

function twoPhysicalRooms() {
 const f=fixture();f.evidence.revision.groups[0].quantity=2;f.evidence.revision.groups[0].totalMinor=40000;f.evidence.revision.totalMinor=40000;
 f.input.rooms.push({...f.input.rooms[0],roomIndex:2,guests:[{factRef:'guest2',firstName:'Taylor',lastName:'Example'}]});
 f.evidence.guestFacts.push({...f.evidence.guestFacts[0],factRef:'guest2',roomIndex:2,firstName:'Taylor'});rehash(f);return f;
}
it('preserves exact accepted revision and varying nightly prices with source provenance in the staff packet',async()=>{
 const f=fixture();f.input.taskId='acceptance:one';f.evidence.revision.groups[0].nightly[1].amountMinor=15000;f.evidence.revision.groups[0].perRoomMinor=25000;f.evidence.revision.groups[0].totalMinor=25000;f.evidence.revision.totalMinor=25000;rehash(f);
 f.evidence.acceptance.currentTotalMinor=90000;
 const packet=await prepareBookingPacket(f.input,f.deps);
 expect(packet).toMatchObject({taskId:'acceptance:one',kind:'accepted_quote',revisionId:f.evidence.revision.id,scopeDigest:hash,currency:'ZAR',totalMinor:25000,saved:false});
 expect(packet.rooms[0]).toMatchObject({groupId:'g1',roomIndex:1,pricing:{currency:'ZAR',totalMinor:25000,nightly:[{date:'2026-10-12',amountMinor:10000},{date:'2026-10-13',amountMinor:15000}],source:{sourceRef:'source',sourceHash:hash,toolVersion:'2',observedAt:at}}});
 expect(packet.rooms[0].request).not.toHaveProperty('pricing');
 expect((packet as any).nativePriceApplication).toBe('pending_staff_review');
 f.evidence.revision.groups[0].nightly[0].amountMinor=99;
 expect((packet as any).rooms[0].pricing.nightly[0].amountMinor).toBe(10000);
});
it('rejects swaps between source-assigned physical rooms even within the same selected group',async()=>{
 const f=twoPhysicalRooms();const [a,b]=f.input.rooms.map((room:any)=>room.guests);f.input.rooms[0].guests=b;f.input.rooms[1].guests=a;
 const packet=await prepareBookingPacket(f.input,f.deps);expect(packet.status).toBe('blocked');expect(packet.rooms).toEqual([]);
});
it('preserves stable physical identity when the caller reorders complete room packets',async()=>{
 const f=twoPhysicalRooms();f.input.rooms.reverse();const packet=await prepareBookingPacket(f.input,f.deps);
 expect(packet.status).toBe('pending_pms_action');expect(packet.rooms.map(room=>(room as any).roomIndex)).toEqual([2,1]);expect(packet.rooms[0].guests[0].firstName).toBe('Taylor');
});
it.each(['missing_input','missing_source','duplicate','outside_quantity'])('rejects %s physical room identity without inventing an assignment',async kind=>{
 const f=twoPhysicalRooms();if(kind==='missing_input')delete f.input.rooms[0].roomIndex;if(kind==='missing_source')delete f.evidence.guestFacts[0].roomIndex;if(kind==='duplicate')f.input.rooms[1].roomIndex=1;if(kind==='outside_quantity')f.input.rooms[1].roomIndex=3;
 expect((await prepareBookingPacket(f.input,f.deps)).rooms).toEqual([]);
});
it('rejects empty or oversized optional task identity',async()=>{
 for(const taskId of ['', 'x'.repeat(129)]){const f=fixture();f.input.taskId=taskId;expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('blocked');}
});
it('promotes an older accepted price only with immutable acceptance provenance and fresh current proofs',async()=>{
 const {assertReservationistResultFreshForAction}=await import('../src/ai/draft-approval.js');
 const f=fixture();f.input.taskId='acceptance:one';
 f.evidence.revision.sourceFreshness={authorizationId:'auth',sourceRefs:['source'],observedAt:at,expiresAt:'2026-10-04T10:05:00Z',purpose:'offer_source'};rehash(f);
 const packet=await prepareBookingPacket(f.input,f.deps),now=new Date('2026-10-04T10:30:00Z');
 expect(packet.status).toBe('pending_pms_action');
 expect(()=>assertReservationistResultFreshForAction({version:1,quoteRevisions:[f.evidence.revision],packets:[packet]},now)).not.toThrow();
 const altered=structuredClone(packet);delete altered.acceptanceProof;const{digest,...data}=altered;altered.digest=quoteDigest(data);
 expect(()=>assertReservationistResultFreshForAction({version:1,quoteRevisions:[f.evidence.revision],packets:[altered]},now)).toThrow(/source/);
 expect(()=>assertReservationistResultFreshForAction({version:1,quoteRevisions:[f.evidence.revision],packets:[packet]},new Date('2026-10-04T11:01:00Z'))).toThrow(/source/);
});

it('refuses malformed currency and price provenance even when the accepted revision hash is recomputed',async()=>{
 for(const kind of ['currency','sourceHash','toolVersion','sourceRef','observedAt']){
  const f=fixture();if(kind==='currency')f.evidence.revision.currency='';if(kind==='sourceHash')f.evidence.revision.groups[0].sourceHash='bad';if(kind==='toolVersion')f.evidence.revision.groups[0].toolVersion='';if(kind==='sourceRef')f.evidence.revision.groups[0].sourceRef='';if(kind==='observedAt')f.evidence.revision.groups[0].observedAt='bad';rehash(f);
  expect((await prepareBookingPacket(f.input,f.deps)).status).toBe('blocked');
 }
});
it('preserves an explicit new-booking kind and per-room totals without a fabricated sent-offer proof',async()=>{
 const f=twoPhysicalRooms();f.input.kind='new_booking';f.input.taskId='new:one';delete f.evidence.acceptance;
 f.evidence.revision.sourceFreshness={authorizationId:'auth',sourceRefs:['source'],observedAt:at,expiresAt:'2026-10-04T11:00:00Z',purpose:'offer_source'};const{id,...data}=f.evidence.revision;f.evidence.revision.id=`quote:${quoteDigest(data)}`;f.input.revisionId=f.evidence.revision.id;
 const packet=await prepareBookingPacket(f.input,f.deps);expect(packet).toMatchObject({kind:'new_booking',taskId:'new:one',totalMinor:40000});expect(packet.rooms.map(room=>room.pricing.totalMinor)).toEqual([20000,20000]);expect(packet.sourceRefs).not.toContain('sent');
});
it('retains exact selected room scope, inclusion provenance and authorized party proof in every physical-room snapshot',async()=>{
 const f=twoPhysicalRooms(),g=f.evidence.revision.groups[0];
 g.roomLabel='Standard Queen';g.rateLabel='Best Available Rate';g.context={organization:{name:'Synthetic Org',nativeId:'org1'}};
 g.inclusions={policyRef:'policy',sourceHashes:[hash],authoredDates:['2026-10-03'],bundleLabels:['Room only'],restrictions:{status:'supported',sourceRefs:['policy']},childMealEntitlement:{status:'supported',sourceRefs:['policy'],childAges:[]},vat:'included',levy:'included'};
 f.evidence.codes.eligibility[0].context=structuredClone(g.context);
 const party={...f.evidence.codes,kind:'organization',name:'Synthetic Org',nativeId:'org1'};f.evidence.partyFacts=[party];rehash(f);
 const packet=await prepareBookingPacket(f.input,f.deps);expect(packet.status).toBe('pending_pms_action');
 for(const room of packet.rooms){const scope=(room.pricing as any).scope;expect(scope).toMatchObject({groupId:'g1',quantity:2,arrivalDate:g.arrivalDate,departureDate:g.departureDate,roomCode:'STQN',roomLabel:'Standard Queen',rateCode:'BAR',rateLabel:'Best Available Rate',board:'room_only',adults:1,children:0,childAges:[],context:g.context,inclusions:g.inclusions,partySourceProofs:[party]});expect(room.request).not.toHaveProperty('scope');}
 const retained=(packet.rooms[0].pricing as any).scope;g.context.organization.name='Changed';g.inclusions.bundleLabels.push('Changed');party.name='Changed';
 expect(retained.context.organization.name).toBe('Synthetic Org');expect(retained.inclusions.bundleLabels).toEqual(['Room only']);expect(retained.partySourceProofs[0].name).toBe('Synthetic Org');
 const {digest,...data}=packet;expect(digest).toBe(quoteDigest(data));retained.board='breakfast';expect(digest).not.toBe(quoteDigest(data));
});

function importedOriginalWithUnknownInventory(){
 const f=fixture();f.input.kind='accepted_quote';f.evidence.revision.inventoryStatus='unproven';
 for(const night of f.evidence.revision.groups[0].nightly)night.inventory=null;
 rehash(f);f.evidence.acceptance.sentProof.sourceRef='source';
 const source={ref:'source',sourceHash:hash,authorizationId:'auth',scopeDigest:hash,propertyCode:'HRCEN',currency:'ZAR',printedDate:'2026-10-04',sentAt:at,validUntil:'2026-10-07',terms:'Original quotation terms',lines:[{id:'line1',page:1,quote:'One room, two nights, ZAR200.00',amount:'200.00'}],kind:'imported_offer',totalMinor:20000,inventoryStatus:'unproven',held:false};
 f.evidence.importedOffer={...source,id:`offer:${quoteDigest(source)}`};return f;
}
it('qualifies unknown original inventory separately from exact imported accepted prices and fresh native evidence',async()=>{
 const f=importedOriginalWithUnknownInventory();const result=await prepareBookingPacket(f.input,f.deps);
 expect(result).toMatchObject({kind:'accepted_quote',status:'pending_pms_action',saved:false,totalMinor:20000});
 expect(result.rooms[0].pricing.nightly).toEqual([{date:'2026-10-12',amountMinor:10000},{date:'2026-10-13',amountMinor:10000}]);
 expect(result.acceptanceProof?.revision.inventoryStatus).toBe('unproven');
 expect(result.acceptanceProof?.revision.groups[0].nightly.map(n=>n.inventory)).toEqual([null,null]);
});
it.each(['missing-imported','altered-imported','rehash-altered-imported','unbound-original','different-sent-original','current-inventory-unavailable','native-eligibility-unavailable','duplicate','expired-current','unlabeled-original','new-booking','invalid-observed'])('rejects unknown original inventory when %s',async mode=>{
 const f=importedOriginalWithUnknownInventory();
 if(mode==='missing-imported')delete f.evidence.importedOffer;
 if(mode==='altered-imported')f.evidence.importedOffer.lines[0].amount='201.00';
 if(mode==='rehash-altered-imported'){f.evidence.importedOffer.lines[0].amount='201.00';const{id,...data}=f.evidence.importedOffer;f.evidence.importedOffer.id=`offer:${quoteDigest(data)}`;}
 if(mode==='unbound-original')f.evidence.importedOffer.sourceHash='b'.repeat(64);
 if(mode==='different-sent-original')f.evidence.acceptance.sentProof.sourceRef='another-sent-offer';
 if(mode==='current-inventory-unavailable')f.evidence.availability.available=false;
 if(mode==='native-eligibility-unavailable')f.evidence.codes.eligibility=[];
 if(mode==='duplicate')f.evidence.duplicates.matches=['existing'];
 if(mode==='expired-current')f.evidence.availability.expiresAt=at;
 if(mode==='unlabeled-original'){f.evidence.revision.inventoryStatus='observed_not_held';rehash(f);}
 if(mode==='new-booking'){f.input.kind='new_booking';delete f.evidence.acceptance;delete f.evidence.importedOffer;f.evidence.revision.sourceFreshness={authorizationId:'auth',sourceRefs:['source'],observedAt:at,expiresAt:'2026-10-04T11:00:00Z',purpose:'offer_source'};const{id,...data}=f.evidence.revision;f.evidence.revision.id=`quote:${quoteDigest(data)}`;f.input.revisionId=f.evidence.revision.id;}
 if(mode==='invalid-observed'){f.evidence.revision.groups[0].nightly[0].inventory=-1;rehash(f);}
 expect(await prepareBookingPacket(f.input,f.deps)).toMatchObject({status:'blocked',saved:false,rooms:[]});
});
