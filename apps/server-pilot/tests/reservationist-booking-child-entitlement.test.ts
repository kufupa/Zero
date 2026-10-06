import {describe,it,expect} from 'vitest';
import {resolveQuoteRevision,quoteDigest,type QuoteSourceRecord,type InclusionPolicy} from '../src/quote-proposal/quote-revision.js';
import {prepareBookingPacket} from '../src/ai/reservationist-booking-packet.js';
const at='2026-10-04T10:00:00.000Z';
let schemaEvidenceCalls=0,sourceAuthorizerCalls=0;
async function bookingCase(label:string,board:'room_only'|'breakfast',ages:number[],policyAges:number[]|undefined,alter?:'wrong_code'|'wrong_guest'|'wrong_business'|'meal_missing'|'meal_unresolved'|'meal_source_empty'|'second_guest_invalid',quantity=1){
 const request={propertyCode:'HRCEN',arrivalDate:'2026-10-12',departureDate:'2026-10-14',requestedCurrency:'ZAR',rooms:[{id:'g1',quantity,adults:1,children:ages.length,childAges:ages}]};
 const record:QuoteSourceRecord={ref:'synthetic-source',sha256:'a'.repeat(64),toolVersion:'synthetic-offline-v1',observedAt:'2026-10-04T09:00:00.000Z',request,result:{outcome:'quote',propertyCode:'HRCEN',groups:[{id:'g1',request:request.rooms[0],completeness:{search:'complete',requiredFacts:'complete'},options:[{id:'selected',room:{code:'STQN',label:'Synthetic Queen',buildingCode:'MAIN'},rate:{code:'BAR',label:'Synthetic rate'},board:board==='room_only'?'Room Only R':'Bed & Breakfast R',appliedContext:{},eligibility:'verified',availability:'available',matchStatus:'match',held:false,totals:{taxInclusive:null},nightly:[{date:'2026-10-12',inventory:2,price:{amount:'100.00',currency:'ZAR'}},{date:'2026-10-13',inventory:2,price:{amount:'150.00',currency:'ZAR'}}]}]}]}};
 const policy:InclusionPolicy={ref:'synthetic-policy',propertyCode:'HRCEN',sourceHashes:['b'.repeat(64)],authoredDates:['2026-10-03'],families:[{rateCode:'BAR',board}],vat:'included',levy:'included',restrictions:{status:'supported',sourceRefs:['synthetic-policy']},...(policyAges===undefined?{}:{childMealEntitlement:{status:'supported',sourceRefs:['synthetic-policy'],childAges:policyAges}})};
 try{
  if(alter==='meal_missing')delete policy.childMealEntitlement;
  if(alter==='meal_unresolved')policy.childMealEntitlement!.status='unresolved';
  if(alter==='meal_source_empty')policy.childMealEntitlement!.sourceRefs=[];
  const revision=await resolveQuoteRevision({propertyCode:'HRCEN',authoredDate:'2026-10-04',selections:[{sourceRef:record.ref,groupId:'g1',optionId:'selected'}],resolveSource:async()=>record,resolvePolicy:async()=>policy,admission:{authorizationId:'synthetic-auth',sourceEvaluationAt:at,maxSourceAgeMs:3600000,expectedRequests:{[record.ref]:structuredClone(request)},authorizeSource:async()=>true}});
  const proof={sourceRef:record.ref,sourceHash:record.sha256,authorizationId:revision.authorizationId!,propertyCode:'HRCEN',scopeDigest:revision.scopeDigest,observedAt:at,expiresAt:'2026-10-04T12:00:00.000Z',maxSourceAgeMs:3600000};
  const guests=[{factRef:'adult',firstName:'Alex',lastName:'Synthetic'},...ages.map((age,i)=>({factRef:`child-${i}`,firstName:`Child${i}`,lastName:'Synthetic',age}))];
  const input={revisionId:revision.id,scopeDigest:revision.scopeDigest,rooms:[{groupId:'g1',roomIndex:1,guests:structuredClone(guests),sourceOfBusiness:'E-Mail',track:'BAR',guaranteeType:'Non-Guaranteed Individual'}]};
  const evidence={revision,availability:{...proof,available:true},duplicates:{...proof,matches:[]},codes:{...proof,roomTypes:alter==='wrong_code'?[]:['STQN'],ratePlans:['BAR'],sources:['E-Mail'],tracks:['BAR'],guarantees:['Non-Guaranteed Individual'],eligibility:[{groupId:'g1',roomCode:'STQN',rateCode:'BAR',board,dates:['2026-10-12','2026-10-13'],adults:1,childAges:ages,context:{}}]},authorizedFields:{...proof,sourceOfBusiness:'E-Mail',track:'BAR',guaranteeType:'Non-Guaranteed Individual'},guestFacts:guests.map(g=>({...proof,...g,groupId:'g1',roomIndex:1})),partyFacts:[],acceptance:{acceptedAt:at,scopeDigest:revision.scopeDigest,sentProof:{revisionId:revision.id,authorizationId:revision.authorizationId!,sentAt:at,sourceRef:'synthetic-sent',sourceHash:'c'.repeat(64)},inventoryEvidence:{revisionId:revision.id,scopeDigest:revision.scopeDigest,authorizationId:revision.authorizationId!,observedAt:at,available:true,maxAgeMs:60000}},causalAt:at};
  if(quantity===2){const room2=structuredClone(input.rooms[0]!);room2.roomIndex=2;for(const guest of room2.guests){guest.factRef+='-room2';guest.firstName+='Second';}input.rooms.push(room2);evidence.guestFacts.push(...room2.guests.map(g=>({...proof,...g,groupId:'g1',roomIndex:2})));if(alter==='second_guest_invalid')room2.guests[1]!.lastName='Foreign';}
  if(alter==='wrong_guest')input.rooms[0]!.guests[0]!.lastName='Foreign';
  if(alter==='wrong_business')input.rooms[0]!.track='Foreign';
  const packet=await prepareBookingPacket(input,{resolveEvidence:async()=>{schemaEvidenceCalls++;return evidence;},authorizeSource:async()=>{sourceAuthorizerCalls++;return true;},signal:new AbortController().signal,deadlineAt:Date.now()+60000});
  return {label,board,requestedChildAges:ages,supportedPolicyChildAges:policyAges??null,revisionResolved:true,revisionId:revision.id,totalMinor:revision.totalMinor,policySourceRef:policy.ref,packetStatus:packet.status,packetRooms:packet.rooms.length,saved:packet.saved,nativeSaveAcceptance:packet.nativeSaveAcceptance,packetErrors:packet.errors,inputDigest:quoteDigest(input),evidenceDigest:quoteDigest(evidence),alter:alter??null};
 }catch(error){return{label,board,requestedChildAges:ages,supportedPolicyChildAges:policyAges??null,revisionResolved:false,error:String(error)};}
}

const cases:Parameters<typeof bookingCase>[]=[
 ['room_only_child_missing_meal_positive','room_only',[8],undefined],
 ['BB_catalog_superset_positive','breakfast',[8],[8,12]],
 ['BB_catalog_order_positive','breakfast',[8,12],[12,8]],
 ['BB_exact_control','breakfast',[8],[8]],
 ['BB_missing_meal_denied','breakfast',[8],[8],'meal_missing'],
 ['BB_unresolved_meal_denied','breakfast',[8],[8],'meal_unresolved'],
 ['BB_empty_meal_sources_denied','breakfast',[8],[8],'meal_source_empty'],
 ['BB_uncovered_child_denied','breakfast',[8],[12]],
 ['two_physical_rooms_children_positive','breakfast',[8],[8,12],undefined,2],
 ['two_physical_rooms_bad_second_guest_denied','breakfast',[8],[8,12],'second_guest_invalid',2],
 ['bad_native_code_denied','breakfast',[8],[8],'wrong_code'],
 ['unauthorized_business_denied','breakfast',[8],[8],'wrong_business']
];
describe('applicable child meal entitlement through real revision and physical booking packets',()=>{
 it.each(cases.map(args=>({label:args[0],args})))('$label',async({args})=>{
  const result=await bookingCase(args[0],args[1],args[2],args[3],args[4],args[5]);
  const positive=args[0].endsWith('_positive')||args[0]==='BB_exact_control';
  if(positive){expect(result.revisionResolved).toBe(true);if(!result.revisionResolved)throw new Error('expected real resolver positive');expect(result.packetStatus).toBe('pending_pms_action');expect(result.packetRooms).toBe(args[5]??1);expect(result.totalMinor).toBe(25000*(args[5]??1));expect(result.saved).toBe(false);expect(result.nativeSaveAcceptance).toBe('untested');}
  else if(result.revisionResolved){expect(result.packetStatus).toBe('blocked');expect(result.packetRooms).toBe(0);expect(result.saved).toBe(false);}
  else expect(result.error).toMatch(/child_meal_entitlement_unproven/);
 });
});
