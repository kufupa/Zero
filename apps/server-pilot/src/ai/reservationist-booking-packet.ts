import {fileURLToPath,pathToFileURL} from 'node:url';
import {occupiedDates,quoteDigest,exactMinor,assessQuoteAcceptance,type QuoteRevision,type ImportedOffer,type SelectedQuoteGroup} from '../quote-proposal/quote-revision.js';
export type BookingGuest={factRef:string;firstName:string;lastName:string;age?:number;profileId?:string};
export type BookingRoomInput={groupId:string;roomIndex:number;guests:BookingGuest[];sourceOfBusiness:string;track:string;guaranteeType:string};
export type BookingInput={kind?:'accepted_quote'|'new_booking';taskId?:string;revisionId:string;scopeDigest:string;rooms:BookingRoomInput[]};
export type BookingSourceProof={sourceRef:string;sourceHash:string;authorizationId:string;propertyCode:string;scopeDigest:string;observedAt:string;expiresAt?:string;maxSourceAgeMs?:number};
export type BookingPacketSourceProof=BookingSourceProof&{kind:'current'|'causal'};
export type BookingAcceptanceProof=Omit<Parameters<typeof assessQuoteAcceptance>[0],'revision'>&{revision:QuoteRevision;sourceEvaluationAt:string};
export type BookingEvidence={revision:QuoteRevision;importedOffer?:ImportedOffer;availability:BookingSourceProof&{available:boolean};duplicates:BookingSourceProof&{matches:unknown[]};codes:BookingSourceProof&{roomTypes:string[];ratePlans:string[];sources:string[];tracks:string[];guarantees:string[];eligibility:{groupId:string;roomCode:string;rateCode:string;board:string;dates:string[];adults:number;childAges:number[];context:Record<string,unknown>}[]};authorizedFields:BookingSourceProof&{sourceOfBusiness:string;track:string;guaranteeType:string};guestFacts:(BookingSourceProof&BookingGuest&{groupId:string;roomIndex:number})[];partyFacts:(BookingSourceProof&{kind:'organization'|'agency'|'arAccount'|'guest';name:string;nativeId:string})[];acceptance?:Omit<Parameters<typeof assessQuoteAcceptance>[0],'revision'>;causalAt:string};
export type BookingPricingScope=Pick<SelectedQuoteGroup,'arrivalDate'|'departureDate'|'quantity'|'roomCode'|'roomLabel'|'rateCode'|'rateLabel'|'board'|'adults'|'children'|'childAges'|'context'|'inclusions'|'nativeTaxInclusive'|'nativeBundleLabels'>&{groupId:string;partySourceProofs:BookingEvidence['partyFacts']};
/** Agreed prices are staff metadata; the native create request does not apply them. */
export type BookingPacket={kind:'accepted_quote'|'new_booking';taskId?:string;revisionId?:string;scopeDigest?:string;authorizationId?:string;propertyCode?:string;sourceProofs?:BookingPacketSourceProof[];acceptanceProof?:BookingAcceptanceProof;digest?:string;currency?:string;totalMinor?:number;nativePriceApplication:'pending_staff_review';status:'pending_pms_action'|'needs_clarification'|'blocked';saved:false;schemaValid:boolean;businessRulesValidated:boolean;nativeSaveAcceptance:'untested';rooms:{groupId:string;roomIndex:number;guests:BookingGuest[];request:Record<string,unknown>;pricing:{scope:BookingPricingScope;currency:string;totalMinor:number;nightly:{date:string;amountMinor:number}[];source:{sourceRef:string;sourceHash:string;toolVersion:string;observedAt:string}}}[];errors:string[];sourceRefs:string[]};
/** Sources are independently authorized by the server. No save-capable dependency exists. */
export async function prepareBookingPacket(input:BookingInput,deps:{resolveEvidence:(revisionId:string,signal:AbortSignal)=>Promise<BookingEvidence>;authorizeSource:(proof:BookingSourceProof,signal:AbortSignal)=>Promise<boolean>;signal:AbortSignal;deadlineAt:number;clock?:{causalAt:string;sourceAt:string;sourceMode?:'historical'|'current_read'}}):Promise<BookingPacket>{
 const result:BookingPacket={kind:input.kind==='new_booking'?'new_booking':'accepted_quote',...(input.taskId===undefined?{}:{taskId:input.taskId}),nativePriceApplication:'pending_staff_review',status:'blocked',saved:false,schemaValid:false,businessRulesValidated:false,nativeSaveAcceptance:'untested',rooms:[],errors:[],sourceRefs:[]};
 try{
 if(!Number.isFinite(deps.deadlineAt)||deps.deadlineAt<=Date.now())throw new Error('deadline_exceeded');
 if(input.taskId!==undefined&&(typeof input.taskId!=='string'||!input.taskId.trim()||input.taskId.length>128))throw new Error('task_identity_invalid');
 const signal=AbortSignal.any([deps.signal,AbortSignal.timeout(Math.min(deps.deadlineAt-Date.now(),45*60000))]);signal.throwIfAborted();
 const inputDigest=quoteDigest(input);
 const e=structuredClone(await deps.resolveEvidence(input.revisionId,signal));signal.throwIfAborted();const r=e.revision;
 if(quoteDigest(input)!==inputDigest)throw new Error('booking_request_changed');
 const evidenceDigest=quoteDigest(e);
 const {id,...revisionData}=r;
 if(id!==input.revisionId||id!==`quote:${quoteDigest(revisionData)}`||r.scopeDigest!==input.scopeDigest||!r.authorizationId||r.held!==false)throw new Error('revision_scope_changed');
 if(!/^[A-Z]{3}$/.test(r.currency))throw new Error('price_currency_invalid');
 const causal=Date.parse(deps.clock?.causalAt??e.causalAt),sourceAt=Date.parse(deps.clock?.sourceAt??e.causalAt),currentRead=deps.clock?.sourceMode==='current_read';
 if(!Number.isFinite(causal)||!Number.isFinite(sourceAt)||Date.parse(e.causalAt)!==causal||e.acceptance&&Date.parse(e.acceptance.acceptedAt)>causal||!currentRead&&sourceAt>causal)throw new Error('invalid_causal_clock');
 const isNew=input.kind==='new_booking';
 if(input.kind!==undefined&&!['accepted_quote','new_booking'].includes(input.kind))throw new Error('booking_intent_invalid');
 if(isNew){
  const proof=r.sourceFreshness;
  if(!proof||proof.authorizationId!==r.authorizationId||proof.purpose!=='offer_source'||!proof.sourceRefs.length||!Number.isFinite(Date.parse(proof.observedAt))||Date.parse(proof.observedAt)>sourceAt||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=sourceAt||Date.parse(proof.expiresAt)<=Date.parse(proof.observedAt))throw new Error('current_selected_price_unproven');
 }else if(!e.acceptance||assessQuoteAcceptance({...e.acceptance,sourceEvaluationAt:new Date(sourceAt).toISOString(),revision:r}).status!=='accepted')throw new Error('accepted_revision_unproven');
 const sourceRefs=new Set<string>(),sourceProofs:BookingPacketSourceProof[]=[],proofDigests=new Set<string>();
 const authorize=async(proof:BookingSourceProof,currentSource=false)=>{
  const proofDigest=quoteDigest(proof);
  if(!proof.sourceRef||!/^[a-f0-9]{64}$/.test(proof.sourceHash)||proof.authorizationId!==r.authorizationId||proof.propertyCode!==r.propertyCode||proof.scopeDigest!==r.scopeDigest||!Number.isFinite(Date.parse(proof.observedAt))||Date.parse(proof.observedAt)>(currentSource&&currentRead?sourceAt:causal)||currentSource&&(!Number.isSafeInteger(proof.maxSourceAgeMs)||proof.maxSourceAgeMs!<0||sourceAt-Date.parse(proof.observedAt)>proof.maxSourceAgeMs!||!proof.expiresAt||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=sourceAt||Date.parse(proof.expiresAt)<=Date.parse(proof.observedAt)))throw new Error('source_unbound_or_unauthorized');
  if(!await deps.authorizeSource(proof,signal))throw new Error('source_unbound_or_unauthorized');
  signal.throwIfAborted();
  if(quoteDigest(proof)!==proofDigest||quoteDigest(e)!==evidenceDigest||quoteDigest(input)!==inputDigest)throw new Error('authorized_evidence_changed');
  const retained:BookingPacketSourceProof={kind:currentSource?'current':'causal',sourceRef:proof.sourceRef,sourceHash:proof.sourceHash,authorizationId:proof.authorizationId,propertyCode:proof.propertyCode,scopeDigest:proof.scopeDigest,observedAt:proof.observedAt,...(currentSource?{expiresAt:proof.expiresAt,maxSourceAgeMs:proof.maxSourceAgeMs}:{})};
  const retainedDigest=quoteDigest(retained);if(!proofDigests.has(retainedDigest)){sourceProofs.push(retained);proofDigests.add(retainedDigest);}sourceRefs.add(proof.sourceRef);
 };
 for(const proof of [e.availability,e.duplicates,e.codes,e.authorizedFields])await authorize(proof,true);
 if(!isNew){const sent=e.acceptance!.sentProof!;await authorize({sourceRef:sent.sourceRef,sourceHash:sent.sourceHash,authorizationId:sent.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:sent.sentAt});
  for(const group of r.groups)await authorize({sourceRef:group.sourceRef,sourceHash:group.sourceHash,authorizationId:r.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:group.observedAt});
 }
 else{
  const refs=[...new Set(r.groups.map(group=>group.sourceRef))];
  if(quoteDigest([...r.sourceFreshness!.sourceRefs].sort())!==quoteDigest([...refs].sort()))throw new Error('selected_price_source_unbound');
  for(const group of r.groups)await authorize({sourceRef:group.sourceRef,sourceHash:group.sourceHash,authorizationId:r.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:group.observedAt,expiresAt:r.sourceFreshness!.expiresAt,maxSourceAgeMs:Date.parse(r.sourceFreshness!.expiresAt)-Date.parse(r.sourceFreshness!.observedAt)},true);
 }
 if(!e.availability.available||e.duplicates.matches.length)throw new Error('stock_or_duplicate');
 let originalInventoryUnproven=false;
 if(e.importedOffer){
  const offer=e.importedOffer,{id,...offerData}=offer;
  if(id!==`offer:${quoteDigest(offerData)}`||offer.kind!=='imported_offer'||offer.inventoryStatus!=='unproven'||offer.held!==false||offer.scopeDigest!==r.scopeDigest||offer.authorizationId!==r.authorizationId||offer.propertyCode!==r.propertyCode||offer.currency!==r.currency||offer.totalMinor!==r.totalMinor||!offer.lines.length||offer.lines.length>64||offer.lines.reduce((sum,line)=>sum+exactMinor(line.amount),0)!==offer.totalMinor||isNew||!e.acceptance||!Number.isFinite(Date.parse(offer.validUntil))||Date.parse(offer.validUntil)<Date.parse(e.acceptance.acceptedAt))throw new Error('imported_offer_conflict');
  await authorize({sourceRef:offer.ref,sourceHash:offer.sourceHash,authorizationId:offer.authorizationId,propertyCode:offer.propertyCode,scopeDigest:offer.scopeDigest,observedAt:offer.sentAt});
  if(r.inventoryStatus==='unproven'){
   if(e.acceptance.sentProof?.sourceRef!==offer.ref||e.acceptance.sentProof.sourceHash!==offer.sourceHash||e.acceptance.sentProof.sentAt!==offer.sentAt||r.groups.some(g=>g.sourceRef!==offer.ref||g.sourceHash!==offer.sourceHash||g.observedAt!==offer.sentAt||g.nightly.some(n=>n.inventory!==null)))throw new Error('original_inventory_source_unbound');
   originalInventoryUnproven=true;
  }
 }
 if(r.inventoryStatus==='unproven'&&!originalInventoryUnproven)throw new Error('original_inventory_unproven');
 const mod=await import(pathToFileURL(fileURLToPath(new URL('../../tooling/playwright-quote/create-request.mjs',import.meta.url))).href) as {loadCreateToolSchema:()=>Promise<unknown>;validateCreateRequest:(request:unknown,schema:unknown)=>{ok:boolean;errors:string[]}};
 const schema=await mod.loadCreateToolSchema();signal.throwIfAborted();const packets:BookingPacket['rooms']=[],used=new Set<string>();
 if(!r.groups.length||r.groups.length>24||new Set(r.groups.map(g=>g.id)).size!==r.groups.length||input.rooms.length>96||input.rooms.some(room=>!r.groups.some(g=>g.id===room.groupId)))throw new Error('invalid_room_groups');
 for(const g of r.groups){
  if(!g.sourceRef||!/^[a-f0-9]{64}$/.test(g.sourceHash)||!g.toolVersion||!Number.isFinite(Date.parse(g.observedAt))||Date.parse(g.observedAt)>(isNew&&currentRead?sourceAt:causal))throw new Error('price_provenance_invalid');
  const dates=occupiedDates(g.arrivalDate,g.departureDate),rooms=input.rooms.filter(room=>room.groupId===g.id);
  if(!Number.isInteger(g.quantity)||g.quantity<1||rooms.length!==g.quantity||!Number.isInteger(g.adults)||g.adults<1||!Number.isInteger(g.children)||g.children<0||g.childAges.length!==g.children)throw new Error('guest_room_assignment_missing');
  if(new Set(rooms.map(room=>room.roomIndex)).size!==rooms.length||rooms.some(room=>!Number.isSafeInteger(room.roomIndex)||room.roomIndex<1||room.roomIndex>g.quantity))throw new Error('physical_room_assignment_unproven');
  if(g.nightly.length!==dates.length||g.nightly.some((n,i)=>n.date!==dates[i]||!Number.isSafeInteger(n.amountMinor)||n.amountMinor<0||(originalInventoryUnproven?n.inventory!==null:!Number.isSafeInteger(n.inventory)||n.inventory===null||n.inventory<g.quantity))||g.perRoomMinor!==g.nightly.reduce((s,n)=>s+n.amountMinor,0)||g.totalMinor!==g.perRoomMinor*g.quantity)throw new Error('nightly_revision_invalid');
  if(!e.codes.roomTypes.includes(g.roomCode)||!e.codes.ratePlans.includes(g.rateCode)||!e.codes.eligibility.some(p=>p.groupId===g.id&&p.roomCode===g.roomCode&&p.rateCode===g.rateCode&&p.board===g.board&&quoteDigest(p.dates)===quoteDigest(dates)&&p.adults===g.adults&&quoteDigest(p.childAges)===quoteDigest(g.childAges)&&quoteDigest(p.context)===quoteDigest(g.context)))throw new Error('room_rate_period_entitlement_unproven');
  if(g.inclusions.restrictions?.status!=='supported'||g.children>0&&g.board!=='room_only'&&(g.inclusions.childMealEntitlement?.status!=='supported'||!g.inclusions.childMealEntitlement.sourceRefs.length||g.childAges.some(age=>!g.inclusions.childMealEntitlement!.childAges.includes(age))))throw new Error('inclusion_entitlement_unproven');
  for(const room of rooms){
   const partySourceProofs:BookingEvidence['partyFacts']=[];
   for(const guest of room.guests){const fact=e.guestFacts.find(f=>f.factRef===guest.factRef&&f.groupId===g.id&&f.roomIndex===room.roomIndex&&f.firstName===guest.firstName&&f.lastName===guest.lastName&&f.age===guest.age&&f.profileId===guest.profileId);if(!fact||used.has(guest.factRef))throw new Error('guest_source_unproven');await authorize(fact);used.add(guest.factRef);}
   const adults=room.guests.filter(p=>p.age===undefined||p.age>=18),children=room.guests.filter(p=>p.age!==undefined&&p.age<18);
   if(adults.length!==g.adults||children.length!==g.children||quoteDigest(children.map(p=>p.age).sort((a,b)=>a!-b!))!==quoteDigest([...g.childAges].sort((a,b)=>a-b))||room.guests.some(p=>!p.firstName.trim()||!p.lastName.trim()||p.age!==undefined&&(!Number.isInteger(p.age)||p.age<0||p.age>120)))throw new Error('guest_occupancy_or_name_missing');
   if(room.sourceOfBusiness!==e.authorizedFields.sourceOfBusiness||room.track!==e.authorizedFields.track||room.guaranteeType!==e.authorizedFields.guaranteeType||!e.codes.sources.includes(room.sourceOfBusiness)||!e.codes.tracks.includes(room.track)||!e.codes.guarantees.includes(room.guaranteeType))throw new Error('unauthorized_property_rule');
   const request:Record<string,unknown>={arrival:g.arrivalDate,departure:g.departureDate,adults:g.adults,childAges:g.childAges,roomType:g.roomCode,ratePlan:g.rateCode,sourceOfBusiness:room.sourceOfBusiness,track:room.track,guaranteeType:room.guaranteeType,firstName:adults[0]!.firstName,lastName:adults[0]!.lastName};
   for(const [kind,context]of Object.entries(g.context)){const party=context as {name?:string;nativeId?:string};if(!['organization','agency','arAccount'].includes(kind)||!party.name||!party.nativeId)throw new Error('party_identity_missing');const proof=e.partyFacts.find(p=>p.kind===kind&&p.name===party.name&&p.nativeId===party.nativeId);if(!proof)throw new Error('independent_party_unproven');await authorize(proof,true);partySourceProofs.push(structuredClone(proof));request[kind]=proof.name;}
   if(adults[0]!.profileId){const proof=e.partyFacts.find(p=>p.kind==='guest'&&p.nativeId===adults[0]!.profileId);if(!proof)throw new Error('guest_profile_unproven');await authorize(proof,true);partySourceProofs.push(structuredClone(proof));request.profileId={nativeId:proof.nativeId,kind:'guest'};}
   if(!mod.validateCreateRequest(request,schema).ok)throw new Error('schema_invalid');packets.push({groupId:g.id,roomIndex:room.roomIndex,guests:structuredClone(room.guests),request,pricing:{scope:structuredClone({groupId:g.id,arrivalDate:g.arrivalDate,departureDate:g.departureDate,quantity:g.quantity,roomCode:g.roomCode,roomLabel:g.roomLabel,rateCode:g.rateCode,rateLabel:g.rateLabel,board:g.board,adults:g.adults,children:g.children,childAges:g.childAges,context:g.context,inclusions:g.inclusions,nativeTaxInclusive:g.nativeTaxInclusive,...(g.nativeBundleLabels?{nativeBundleLabels:g.nativeBundleLabels}:{}),partySourceProofs}),currency:r.currency,totalMinor:g.perRoomMinor,nightly:g.nightly.map(night=>({date:night.date,amountMinor:night.amountMinor})),source:{sourceRef:g.sourceRef,sourceHash:g.sourceHash,toolVersion:g.toolVersion,observedAt:g.observedAt}}});
  }
 }
 if(!packets.length||r.totalMinor!==r.groups.reduce((sum,g)=>sum+g.totalMinor,0))throw new Error('no_valid_selected_rooms');signal.throwIfAborted();
 if(quoteDigest(e)!==evidenceDigest||quoteDigest(input)!==inputDigest)throw new Error('authorized_evidence_changed');
 const prepared:BookingPacket={...result,revisionId:r.id,scopeDigest:r.scopeDigest,authorizationId:r.authorizationId,propertyCode:r.propertyCode,sourceProofs,...(isNew?{}:{acceptanceProof:structuredClone({...e.acceptance!,revision:r,sourceEvaluationAt:new Date(sourceAt).toISOString()})}),currency:r.currency,totalMinor:r.totalMinor,status:'pending_pms_action',schemaValid:true,businessRulesValidated:true,rooms:packets,sourceRefs:[...sourceRefs]};
 return {...prepared,digest:quoteDigest(prepared)};
 }catch{return {...result,errors:['booking_evidence_invalid_or_unavailable']};}
}
