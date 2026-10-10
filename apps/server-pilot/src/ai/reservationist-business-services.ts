import {quoteDigest,occupiedDates,exactMinor,resolveQuoteRevision,type QuoteSourceRecord,type InclusionPolicy,type Board,type QuoteRevision} from '../quote-proposal/quote-revision.js';
import {assertRevisionSourceFacts,nativePartyLabelMatches} from './reservationist-source-facts.js';
import type {BookingEvidence,BookingInput,BookingSourceProof} from './reservationist-booking-packet.js';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {RevisionProposalHeader} from '../quote-proposal/proposal-pdf.js';
import {resolveReservationistAcceptedQuoteSource,type ReservationistAcceptedQuoteSource} from './reservationist-accepted-quote-source.js';
import {ReservationistTaskEvidenceUnavailable,deriveStaffAnswerTopics,type ReservationistExecutionServices} from './reservationist-execution.js';
import {isReservationistSignatureNoise} from './reservationist-attachment-input.js';
import {PartyRateFailure,PARTY_NO_CONTRACT_CODE,PARTY_SEARCH_INCOMPLETE_CODE,partySearchCovered} from './party-rate-failure.js';
import {boards,norm,buildRateOptions,requestMatches,sellable,type RateOption} from './rate-options.js';
type Context=Parameters<NonNullable<ReservationistExecutionServices['resolveQuoteTask']>>[0];
export type NativeQuoteRequest=QuoteSourceRecord['request']&{search:{includeRestricted:false;includeAlternatives:boolean;salesStrategy:'Government'|'Preset'|'BAR'};details:'full';maxOptionsPerGroup:number};
export type ReservationistPartyRead={ref:string;sha256:string;observedAt:string;kind:'organization'|'bookingAgency';query:string;outcome:'resolved'|'ambiguous'|'no_match';candidates:{nativeId:string;displayName:string;kind:string}[]};
export type ReservationistBookingPrerequisites=Pick<BookingEvidence,'availability'|'duplicates'|'codes'|'authorizedFields'|'partyFacts'>&{guestFacts?:BookingEvidence['guestFacts'];authorizeSource:(proof:BookingSourceProof,signal:AbortSignal)=>Promise<boolean>};
function missing(code:string,fields:string[]):never{throw new ReservationistTaskEvidenceUnavailable(code,fields);}
function authored(ctx:Context){const m=ctx.input.messages.find(m=>`message:${m.id}`===ctx.task.source.attachmentId);return m?.text.split(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im)[0]??ctx.task.source.quote??'';}
/** Original authored event scope only; this predicate grants no price or party authority. */
export function isReservationistConferenceOnlyQuote(ctx:Context):boolean{
 const requestText=authored(ctx).split(/^[\t ]*(?:(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu)[0]!;
 const event=(text:string)=>text.split(/[.!?;\r\n]+/).some(row=>/\b(?:conference|conferencing|meeting|event)\b/i.test(row)&&!/\b(?:not|no|never|without|cancel|cancelled|canceled)\b/i.test(row));
 const accommodation=(text:string)=>/\b(?:accommodation|overnight|bedrooms?|guest[ -]?rooms?|single|double|twin|check[ -]?(?:in|out))\b|\b\d+\s+(?:(?:standard|deluxe)\s+)?rooms?\b/i.test(text);
 const taskText=ctx.task.source.quote??'';
 return ctx.task.kind==='quote'&&((event(taskText)&&!accommodation(taskText))||(event(requestText)&&!accommodation(requestText)));
}
/** An original options request allows an unselected native board, never a fabricated meal. */
function requestedQuoteAlternatives(ctx:Context):boolean{
 const message=ctx.input.messages.find(m=>`message:${m.id}`===ctx.task.source.attachmentId),span=ctx.task.source;
 if(ctx.task.kind!=='quote'||!message||message.direction!=='inbound'||message.disclosure==='staff_only'||span.sourceHash!==createHash('sha256').update(message.text).digest('hex')||span.quote===undefined||span.start===undefined||span.end===undefined||message.text.slice(span.start,span.end)!==span.quote)return false;
 const text=authored(ctx).split(/^[\t ]*(?:(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu)[0]!;
 return text.split(/[.!?;\r\n]+/).some(row=>/\b(?:room|breakfast|board|rate)\s+options?\b|\b(?:options?|alternatives?)\b.{0,40}\b(?:rooms?|breakfast|board|rates?)\b/i.test(row)&&!/\b(?:not|no|never|without|previous|old)\b/i.test(row));
}
/** Only a complete same-message quote may leave meal selection to native evidence. */
function sourceLeavesBoardUnspecified(ctx:Context):boolean{
 if(ctx.task.kind!=='quote'||ctx.facts.filter(f=>['dates','room'].includes(f.kind)).some(f=>f.source.attachmentId!==ctx.task.source.attachmentId))return false;
 const message=ctx.input.messages.find(m=>`message:${m.id}`===ctx.task.source.attachmentId);if(!message||message.direction!=='inbound'||message.disclosure==='staff_only')return false;
 const admissions=ctx.attachmentAdmissions??[],descriptors=admissions.map(a=>({id:a.metadata.attachmentId,messageId:a.metadata.messageId,contentId:a.metadata.contentId??null}));
 if(ctx.input.authorizedArtifacts.some(raw=>{
  const item=raw as {attachmentId?:string;sourceHash?:string},admission=admissions.find(a=>a.metadata.attachmentId===item?.attachmentId&&a.metadata.sourceHash===item?.sourceHash),m=admission?.metadata,owner=m&&ctx.input.messages.find(message=>message.id===m.messageId);
  return !m||!owner||admission.status!=='ignored_signature'||admission.reason!=='signature_noise'||m.ownerRef!==ctx.input.authorizationScope?.ownerRef||m.threadId!==ctx.input.authorizationScope?.threadId||m.messageAt!==owner.at||Date.parse(m.messageAt)>Date.parse(ctx.input.clock.causalAt)||!isReservationistSignatureNoise({messageText:owner.text,currentRequestText:message.text,attachment:{id:m.attachmentId,messageId:m.messageId,isInline:m.inline===true,contentId:m.contentId??null,mimeType:m.mimeType},attachments:descriptors});
 }))return false;
 const text=authored(ctx).split(/^[\t ]*(?:(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu)[0]!;
  const requirements=text.replace(/\b(?:breakfast|board|meal)\s+(?:options?|alternatives?)\b/gi,'').replace(/\b(?:options?|alternatives?)\s+(?:for|of)\s+(?:breakfast|board|meal)\b/gi,'');
 return !/\b(?:breakfast|dinner|lunch|meals?|board|DBB|BB|RO)\b|\bB\s*&\s*B\b|\broom\s+only\b/i.test(requirements);
}
/** Facts determine native search scope; customer class never changes the requested task. */
export function deriveReservationistQuoteRequest(ctx:Context):NativeQuoteRequest{
 if(!['quote','new_booking','acceptance'].includes(ctx.task.kind)||ctx.input.capabilities.pmsWrite!==false||ctx.input.capabilities.emailSend!==false)throw new Error('business_request_scope_invalid');
 if(isReservationistConferenceOnlyQuote(ctx))throw new ReservationistTaskEvidenceUnavailable('conference_quote_source_unavailable',['source-backed conference package availability, rates and terms'],['conference_package']);
 const facts=ctx.facts.filter(f=>f.verification==='text_verified'&&f.disclosure==='guest'),dates=facts.filter(f=>f.kind==='dates');
 if(ctx.task.kind!=='quote'&&facts.some(f=>f.kind==='room'&&f.value.quotationBasis==='per_room_rate'))throw new Error('business_rate_example_booking_forbidden');
 if(!dates.length||new Set(dates.map(f=>f.kind==='dates'?quoteDigest({arrival:f.value.arrival,departure:f.value.departure}):'')).size!==1)missing('business_dates_unavailable',['one source-bound stay date range']);
 const stay=dates[0]!.value as {arrival:string;departure:string};occupiedDates(stay.arrival,stay.departure);
 const roomFacts=[...new Map(facts.filter(f=>f.kind==='room').map(f=>[quoteDigest(f.value),f])).values()];if(!roomFacts.length)missing('business_room_allocation_unavailable',['explicit room quantity and occupancy']);
 const text=authored(ctx),isGovernment=/\bgovernment\s+rate\b|\b(?:government|department|treasury)\b/i.test(text)&&/\bofficial|government\s+rate\b/i.test(text),roomCodes=/\bstandard\s+room\b/i.test(text)?['STWN','STQN','SKNG']:/\bdeluxe\s+(?:room|queen)\b/i.test(text)?['DLXQN']:undefined;
 const rooms=roomFacts.map(f=>{if(f.kind!=='room')throw new Error('business_room_type');if(f.value.quantity===undefined)missing('business_room_quantity_unavailable',['explicit room quantity']);const requestedBoards=facts.filter(b=>b.kind==='board'&&(typeof b.value==='string'||b.value.roomRef===f.value.roomRef)).map(b=>{if(b.kind!=='board')throw new Error('business_board_type');return boards[norm(typeof b.value==='string'?b.value:b.value.board)];});if(!requestedBoards.length&&!sourceLeavesBoardUnspecified(ctx)||requestedBoards.some(b=>!b)||new Set(requestedBoards).size>1)missing('business_board_unavailable',['one supported board for each room allocation']);return{id:f.value.roomRef,quantity:f.value.quantity,adults:f.value.adults,children:f.value.childAges.length,childAges:[...f.value.childAges],required:{...(requestedBoards.length?{boardBases:[requestedBoards[0]!]}:{}),...(roomCodes?{roomCodes}:{} )}};});
 if(new Set(rooms.map(r=>r.id)).size!==rooms.length)missing('business_room_allocation_ambiguous',['unique room allocation references']);
 return{propertyCode:ctx.input.propertyCode,arrivalDate:stay.arrival,departureDate:stay.departure,requestedCurrency:'ZAR',rooms,search:{includeRestricted:false,includeAlternatives:false,salesStrategy:isGovernment?'Government':'BAR'},details:'full',maxOptionsPerGroup:50};
}
export function deriveReservationistProposalHeader(ctx:Context,signer:Pick<RevisionProposalHeader,'signerName'|'signerEmail'>):RevisionProposalHeader{
 const parties=ctx.facts.filter(f=>f.kind==='party'&&f.verification==='text_verified'&&f.disclosure==='guest').map(f=>f.value as string),agency=parties.find(p=>/\b(?:travel|tours|tourism|agency)\b/i.test(p))??'',company=parties.find(p=>p!==agency)??'';
 return{attention:'',company,agency,clientEmail:'',clientTelephone:'',...signer};
}
/**
 * A quote for picked parties offers only the rows HMS flags as negotiated (rateScope 'contextual', from isNegotiatedRate).
 * With none flagged it offers the public BAR rows. Rate names never decide: a plan named after the party is offered only
 * when HMS flags it. Without a party context the options pass through unchanged.
 */
export function partyContractChoice<O extends { rateScope?: string }>(
  rateContext: Record<string, unknown> | undefined,
  options: readonly O[],
): O[] {
  if (!rateContext || !Object.keys(rateContext).length) return [...options];
  const contract = options.filter((option) => option.rateScope === 'contextual');
  if (contract.length) return contract;
  return options.filter((option) => option.rateScope === 'public');
}

/** The Rate Shop's largest return per group (quote-contract.mjs MAX_OPTIONS). A picked party's summary asks for all of it. */
const PARTY_SUMMARY_MAX_OPTIONS=200;
/**
 * Keeps each requested room's own options from a party read that asked HMS for every room type, cut to the request's own
 * limit as a room-filtered read is (the runner orders matches first). A cut row that is not an alternative may be a flagged
 * row, so that group's search is not covered.
 */
function narrowToRequestedRooms(source:QuoteSourceRecord,rooms:QuoteSourceRecord['request']['rooms'],limit:number):QuoteSourceRecord{
 const wanted=new Map(rooms.map(room=>[room.id,room.required?.roomCodes??[]] as const));
 return{...source,result:{...source.result,groups:source.result.groups.map(group=>{const codes=wanted.get(group.id)??[],own=codes.length?group.options.filter(option=>codes.includes(option.room.code)):group.options,cut=own.slice(limit).some(option=>option.matchStatus!=='alternative');
  return{...group,options:own.slice(0,limit),completeness:cut?{...group.completeness,search:'truncated'}:group.completeness};})}};
}

/** Pick a requested qualified option by exact total cents; unqualified alternatives never win. */
export function selectReservationistQuoteOptions(source:QuoteSourceRecord):{sourceRef:string;groupId:string;optionId:string}[]{
 return selectQuoteOptions(source,false);
}
function quoteOptionCandidates(source:QuoteSourceRecord){
 if(!source.request.rooms.length||source.request.rooms.length>64||new Set(source.request.rooms.map(r=>r.id)).size!==source.request.rooms.length||source.result.groups.length!==source.request.rooms.length||new Set(source.result.groups.map(g=>g.id)).size!==source.result.groups.length)missing('business_selected_scope_unavailable',['all requested room groups']);
 const candidates=source.request.rooms.map(request=>{const group=source.result.groups.find(g=>g.id===request.id);if(!group||group.options.length>50||quoteDigest(group.request)!==quoteDigest(request)||group.completeness.search!=='complete'||group.completeness.requiredFacts!=='complete')missing('business_selected_scope_unavailable',['complete bounded native room source']);const qualified=partyContractChoice(source.request.rateContext,group.options.filter(o=>o.matchStatus==='match'&&requestMatches(request,o)&&sellable(source,request.quantity,o)));
 const totals=qualified.map(o=>({o,total:o.nightly.reduce((sum,n)=>sum+exactMinor(n.price.amount),0)*request.quantity})).filter(v=>Number.isSafeInteger(v.total)&&v.total>0).sort((a,b)=>a.total-b.total||a.o.id.localeCompare(b.o.id));if(!totals.length)missing('business_selected_price_unavailable',['qualified available option covering every requested room-night']);return{request,totals};});
 return candidates;
}
function selectQuoteOptions(source:QuoteSourceRecord,forFullRead:boolean):{sourceRef:string;groupId:string;optionId:string}[]{
 if(!source.request.rooms.length||source.request.rooms.length>64||new Set(source.request.rooms.map(r=>r.id)).size!==source.request.rooms.length||source.result.groups.length!==source.request.rooms.length)missing('business_selected_scope_unavailable',['all requested room groups']);
 const candidates=quoteOptionCandidates(source);
 // A summary candidate narrows native codes only; it never certifies joint inventory.
 if(forFullRead)return candidates.map(({request,totals})=>({sourceRef:source.ref,groupId:request.id,optionId:totals[0]!.o.id}));
 // Use the same building/room/date pools that the revision validator checks. No HMS building: one pool per room type.
 // Bound search and refuse an unresolved allocation instead of returning a partial optimum.
 const minimumRemaining=candidates.map((_,i)=>candidates.slice(i).reduce((sum,c)=>sum+c.totals[0]!.total,0));
 let visited=0,bestTotal=Infinity,best:{sourceRef:string;groupId:string;optionId:string}[]|undefined;
 const choose=(index:number,total:number,pools:Map<string,{demand:number;supply:number}>,selected:{sourceRef:string;groupId:string;optionId:string}[])=>{
  if(++visited>10000)missing('business_selected_allocation_limit',['a bounded jointly qualified room allocation']);
  if(!Number.isSafeInteger(total)||total>=bestTotal||index<candidates.length&&total+minimumRemaining[index]!>=bestTotal)return;
  if(index===candidates.length){bestTotal=total;best=selected;return;}
  const {request,totals}=candidates[index]!;
  for(const {o,total:optionTotal}of totals){if(!o.room.buildingCode&&o.room.buildingCode!==null)continue;const pool=o.room.buildingCode?`${source.request.propertyCode}:${o.room.buildingCode}:${o.room.code}`:candidates.length===1?`${source.request.propertyCode}:source:${source.ref}:${request.id}:${o.room.code}`:`${source.request.propertyCode}:property:${o.room.code}`,next=new Map(pools);let feasible=true;
   for(const n of o.nightly){const key=`${pool}|${n.date}`,old=next.get(key),demand=(old?.demand??0)+request.quantity;if(old&&old.supply!==n.inventory||!Number.isSafeInteger(demand)||demand>n.inventory){feasible=false;break;}next.set(key,{demand,supply:n.inventory});}
   if(feasible)choose(index+1,total+optionTotal,next,[...selected,{sourceRef:source.ref,groupId:request.id,optionId:o.id}]);
  }
 };
 choose(0,0,new Map(),[]);if(!best)missing('business_selected_joint_inventory_unavailable',['consistent known inventory pools covering all requested rooms and dates']);return best;
}
export function createReservationistBusinessServices(options:{authorizationId:string;authorizeContext:(ctx:Context)=>Promise<boolean>;readQuote:(request:QuoteSourceRecord['request'],signal:AbortSignal)=>Promise<QuoteSourceRecord>;readParty?:(kind:'organization'|'bookingAgency',name:string,signal:AbortSignal)=>Promise<ReservationistPartyRead>;resolvePolicy:(propertyCode:string,rateCode:string,board:Board)=>Promise<InclusionPolicy|null>;resolveSelectedPolicy?:(ctx:Context,source:QuoteSourceRecord,selections:readonly {sourceRef:string;groupId:string;optionId:string}[],propertyCode:string,rateCode:string,board:Board)=>Promise<InclusionPolicy|null>;signer:Pick<RevisionProposalHeader,'signerName'|'signerEmail'>;readBookingPrerequisites?:(ctx:Context,revision:QuoteRevision)=>Promise<ReservationistBookingPrerequisites>;readAcceptedQuoteSource?:(ctx:Context)=>Promise<ReservationistAcceptedQuoteSource|null>;maxSourceAgeMs?:number},staffApproval?:{context:Context;request:NativeQuoteRequest;header:RevisionProposalHeader;rates?:'party'|'public';onRateOptions?:(options:RateOption[])=>void}):ReservationistExecutionServices{
 if(!options.authorizationId||!options.authorizeContext||!options.readQuote||!options.resolvePolicy)throw new Error('business_services_configuration_invalid');
 // Server-only admission: staff corrections are not relabelled as extracted mail facts.
 const staffDigest=staffApproval?quoteDigest({input:staffApproval.context.input,task:staffApproval.context.task,facts:staffApproval.context.facts,request:staffApproval.request,header:staffApproval.header}):null;
 const approved=(ctx:Context)=>{if(!staffApproval)return false;if(ctx!==staffApproval.context||ctx.task.kind!=='quote'||staffDigest!==quoteDigest({input:ctx.input,task:ctx.task,facts:ctx.facts,request:staffApproval.request,header:staffApproval.header}))throw new Error('staff_quote_approval_changed');return true;};
  // A staff quote never looks a party up by name. The parties the staff picked in HMS arrive as native ids in the
  // approved request, verified before the lock. A typed company or agency is text for the PDF only.
 const internallyScopedRateExamples=new WeakSet<object>();
 const revisions=new Map<string,Set<string>>(),observations=new Map<string,QuoteSourceRecord>(),claimSources=new Map<string,{contextDigest:string;source:QuoteSourceRecord}>(),maxAge=options.maxSourceAgeMs??15*60000;
 const observationContextDigest=(ctx:Context)=>quoteDigest({requestId:ctx.input.requestId,scope:ctx.input.authorizationScope,propertyCode:ctx.input.propertyCode,trigger:ctx.input.trigger,messages:ctx.input.messages,causalAt:ctx.input.clock.causalAt});
 const claimContextDigest=(ctx:Context)=>{const{sourceAt: _sourceAt,...clock}=ctx.input.clock;return quoteDigest({input:{...ctx.input,clock},task:ctx.task,facts:ctx.facts});};
 const guard=async(ctx:Context)=>{ctx.signal.throwIfAborted();if(staffApproval)approved(ctx);if(ctx.input.clock.sourceMode!=='current_read'||!ctx.input.authorizationScope?.ownerRef||!ctx.input.authorizationScope.threadId||!await options.authorizeContext(ctx))throw new Error('business_context_unauthorized');ctx.signal.throwIfAborted();if(staffApproval)approved(ctx);};
 const services:ReservationistExecutionServices={
 resolveQuoteTask:async ctx=>{await guard(ctx);
 const examples=ctx.facts.filter(f=>f.kind==='room'&&f.value.quotationBasis==='per_room_rate');
 if(examples.length===1&&!internallyScopedRateExamples.has(ctx))missing('business_quote_rate_examples_scope_unavailable',['both source-requested single and double rate examples']);
 if(examples.length>1){
  if(ctx.task.kind!=='quote'||examples.length!==2||new Set(examples.map(f=>f.kind==='room'?f.value.adults:0)).size!==2||examples.some(f=>f.kind!=='room'||f.value.quantity!==1||f.value.childAges.length||![1,2].includes(f.value.adults))||ctx.facts.some(f=>f.kind==='room'&&f.value.quotationBasis!=='per_room_rate')||ctx.facts.some(f=>f.kind==='rate_claim'))missing('business_quote_rate_examples_scope_unavailable',['independent single/double rate scopes without a supplied ambiguous price claim']);
  const offers=[];
  for(const example of examples){const facts=ctx.facts.filter(f=>f.kind!=='room'||f.id===example.id),scoped={...ctx,facts};internallyScopedRateExamples.add(scoped);const resolved=await services.resolveQuoteTask!(scoped);offers.push(resolved,...resolved.alternatives??[]);}
  if(offers.length>5)missing('business_quote_alternatives_bound_unavailable',['at most five independently qualified selected alternatives']);
  return{...offers[0]!,alternatives:offers.slice(1)};
 }
 const request=approved(ctx)?structuredClone(staffApproval!.request):deriveReservationistQuoteRequest(ctx),header=approved(ctx)?structuredClone(staffApproval!.header):deriveReservationistProposalHeader(ctx,options.signer);if(!staffApproval&&options.readParty){for(const [kind,name]of [['organization',header.company],['bookingAgency',header.agency]] as const){if(!name)continue;const party=await options.readParty(kind,name,ctx.signal);const partyAt=ctx.evaluateSourceAt?.()??ctx.input.clock.sourceAt;await guard(ctx);if(party.kind!==kind||party.query!==name||!/^[a-f0-9]{64}$/.test(party.sha256)||!party.ref||!['resolved','ambiguous','no_match'].includes(party.outcome)||!Number.isFinite(Date.parse(party.observedAt))||Date.parse(party.observedAt)>Date.parse(partyAt)||Date.parse(partyAt)-Date.parse(party.observedAt)>maxAge||party.candidates.some(p=>!p.nativeId||!p.displayName||p.kind!==kind))throw new Error('business_party_source_unbound');if(party.outcome==='resolved'&&party.candidates.length===1&&nativePartyLabelMatches(name,party.candidates[0]!.displayName)){request.rateContext??={};request.rateContext[kind==='bookingAgency'?'agency':'organization']={nativeId:party.candidates[0]!.nativeId,name:party.candidates[0]!.displayName};}else if(!(kind==='organization'&&party.outcome==='no_match'&&party.candidates.length===0&&(request.search.salesStrategy==='Government'||ctx.task.kind==='quote'&&request.search.salesStrategy==='BAR')))missing('business_party_identity_unavailable',['unique exact native party identity']);}}
 // Native Preset search requires an exact resolved party; public requests use BAR.
 if(request.search.salesStrategy!=='Government'&&request.rateContext)request.search.salesStrategy='Preset';
 const normalize=await import(pathToFileURL(fileURLToPath(new URL('../../tooling/playwright-quote/quote-contract.mjs',import.meta.url))).href) as {normalizeQuoteRequest:(input:unknown)=>{ok:boolean;request:QuoteSourceRecord['request']}};
 const readBound=async(readRequest:QuoteSourceRecord['request'])=>{
  const normalized=normalize.normalizeQuoteRequest({schemaVersion:2,...readRequest});if(!normalized.ok)throw new Error('business_quote_request_invalid');const expected=structuredClone(normalized.request),before=quoteDigest(readRequest);
  const source=await options.readQuote(structuredClone(readRequest),ctx.signal),sourceAt=ctx.evaluateSourceAt?.()??ctx.input.clock.sourceAt;await guard(ctx);
  if(quoteDigest(readRequest)!==before||source.result.propertyCode!==ctx.input.propertyCode||quoteDigest(source.request)!==quoteDigest(expected))throw new Error('business_quote_source_scope_mismatch');
  if(!Number.isFinite(Date.parse(source.observedAt))||Date.parse(source.observedAt)>Date.parse(sourceAt))missing('business_quote_clock_unavailable',['source-evaluation time after the completed current read']);
  if(Date.parse(sourceAt)-Date.parse(source.observedAt)>maxAge)missing('business_quote_source_expired',['fresh current quote observation']);
  return{source,sourceAt,expected};
 };
 // Native full detail inspection is bounded to five offers. Search first, then
 // narrow only to codes selected from that actual complete, qualified result.
 // A picked party's summary asks HMS for every room type, up to the Rate Shop's maximum: HMS hides the flagged rows behind a
 // room-type filter, and other rooms must not crowd the requested room out of the read. The requested room types stay local.
 const partyRead=Boolean(request.rateContext);
 const searchRequest=partyRead?{...request,rooms:request.rooms.map(room=>{const required={...room.required};delete required.roomCodes;return{...room,required};}),maxOptionsPerGroup:PARTY_SUMMARY_MAX_OPTIONS,details:'summary'}:{...request,details:'summary'};
 const read=await readBound(searchRequest),summary=partyRead?{...read,source:narrowToRequestedRooms(read.source,request.rooms,request.maxOptionsPerGroup)}:read;observations.set(observationContextDigest(ctx),structuredClone(summary.source));
 const alternativeRequest=staffApproval?false:requestedQuoteAlternatives(ctx);
 if(alternativeRequest&&request.rooms.length!==1)missing('business_quote_alternatives_scope_unavailable',['independently scoped alternatives for each requested room allocation']);
 // A picked party's contract is confirmed or ruled out only by a read that covered every requested room. A cut list or a missing
 // page may hide a flagged row, so the quote is public and says so.
 if(staffApproval&&partyRead&&summary.source.result.groups.some(group=>!partySearchCovered(group)||group.completeness.requiredFacts!=='complete'))throw new PartyRateFailure(PARTY_SEARCH_INCOMPLETE_CODE);
 const candidates=quoteOptionCandidates(summary.source);
 // A picked party's contract is never replaced silently by public rates. Staff: a contract on another board alone quotes the requested
 // board at public and the review says so; no contract on any board retries at public rates as before; a requested contract that
 // cannot be priced is a party failure with its own copy. Other paths fail on any unpriced contract, as before public rows were offered.
 if(request.rateContext)for(const {request:room,totals} of candidates){
  if(totals.some(v=>v.o.rateScope==='contextual'))continue;
  const rows=summary.source.result.groups.find(g=>g.id===room.id)!.options,contract=rows.some(o=>o.rateScope==='contextual');
  if(!staffApproval){if(contract)missing('business_selected_price_unavailable',['qualified available option covering every requested room-night']);continue;}
  if(!contract)throw new PartyRateFailure(PARTY_NO_CONTRACT_CODE);
  if(rows.some(o=>o.rateScope==='contextual'&&requestMatches(room,o)))throw new PartyRateFailure('business_selected_price_unavailable');
 }
 // Price the cheapest qualified room for each observed board, as separate selected alternatives.
 // Remaining room labels are current observations, never individually priced promises.
 const byPair=new Map<string,(typeof candidates)[number]['totals'][number]>();
 if(alternativeRequest)for(const v of candidates[0]!.totals){const board=boards[norm(v.o.board??'')];if(board){const key=board;if(!byPair.has(key))byPair.set(key,v);}}
 if(alternativeRequest&&(!byPair.size||byPair.size>5))missing('business_quote_alternatives_bound_unavailable',['at most five independently qualified selected board alternatives']);
 if(alternativeRequest&&ctx.facts.some(f=>f.kind==='rate_claim'))missing('business_quote_alternatives_claim_scope_unavailable',['the specific alternative to which the supplied rate claim applies']);
 const selectionSets=alternativeRequest?[...byPair.values()].map(v=>[{sourceRef:summary.source.ref,groupId:request.rooms[0]!.id,optionId:v.o.id}]):[selectQuoteOptions(summary.source,true)];
 const results=[];
 for(const chosen of selectionSets){
 const selectedRequest={...request,rooms:request.rooms.map(room=>{const selection=chosen.find(s=>s.groupId===room.id),group=summary.source.result.groups.find(g=>g.id===room.id),option=group?.options.find(o=>o.id===selection?.optionId);if(!option)throw new Error('business_selected_source_missing');return{...room,required:{...room.required,roomCodes:[option.room.code],rateCodes:[option.rate.code],...(alternativeRequest||!room.required?.boardBases?.length?{boardBases:[boards[norm(option.board??'')]!]}:{})}};})};
 const {source,sourceAt,expected}=await readBound(selectedRequest);if(source.result.outcome!=='quote')missing('business_selected_scope_unavailable',['complete narrowed full native quote source']);const selections=selectReservationistQuoteOptions(source);const taskSources=revisions.get(ctx.task.id)??new Set<string>();taskSources.add(source.sha256);revisions.set(ctx.task.id,taskSources);if(!alternativeRequest)claimSources.set(ctx.task.id,{contextDigest:claimContextDigest(ctx),source:structuredClone(source)});
 results.push({propertyCode:ctx.input.propertyCode,authoredDate:sourceAt.slice(0,10),selections,resolveSource:async(ref:string)=>{await guard(ctx);if(ref!==source.ref)throw new Error('business_quote_source_unknown');return source;},resolvePolicy:async(property:string,rate:string,board:Board)=>{await guard(ctx);const policy=options.resolveSelectedPolicy?await options.resolveSelectedPolicy(ctx,source,selections,property,rate,board):await options.resolvePolicy(property,rate,board);await guard(ctx);if(policy===null)throw new ReservationistTaskEvidenceUnavailable('business_quote_policy_unavailable',['source-backed VAT and tourism levy inclusions'],['tax_inclusion']);return policy;},admission:{authorizationId:options.authorizationId,sourceEvaluationAt:sourceAt,maxSourceAgeMs:maxAge,expectedRequests:{[source.ref]:expected},authorizeSource:async(ref:string,id:string)=>{await guard(ctx);return ref===source.ref&&id===options.authorizationId;}}});
 }
 // ponytail: the option cards are optional. A failure building them must never fail a quote that already priced.
 if(staffApproval){try{staffApproval.onRateOptions?.(buildRateOptions(summary.source,selectionSets[0]!));}catch{/* cards stay empty */}}
 return{...results[0]!,...(alternativeRequest?{alternatives:results.slice(1)}:{})};},
 resolveProposalHeader:async(ctx)=>{await guard(ctx);return deriveReservationistProposalHeader(ctx,options.signer);},
 authorizeGuestProposal:async(ctx,revision:QuoteRevision,facts)=>{await guard(ctx);return facts===null&&revision.authorizationId===options.authorizationId&&revision.held===false&&revision.groups.every(g=>revisions.get(ctx.task.id)?.has(g.sourceHash)===true);}
 };
 services.resolveCurrentNativeObservation=async ctx=>{
  await guard(ctx);const topics=deriveStaffAnswerTopics(ctx.task.source.quote??'');if(ctx.task.kind!=='question'||topics.length!==1||!['room_options','breakfast_options'].includes(topics[0]!))return null;
  const source=observations.get(observationContextDigest(ctx));if(!source)return null;
  const rooms=ctx.facts.filter(f=>f.kind==='room'),dates=ctx.facts.filter(f=>f.kind==='dates');
  if(!dates.some(f=>f.kind==='dates'&&f.value.arrival===source.request.arrivalDate&&f.value.departure===source.request.departureDate)||rooms.length!==source.request.rooms.length||!source.request.rooms.every(r=>rooms.some(f=>f.kind==='room'&&f.value.roomRef===r.id&&f.value.quantity===r.quantity&&f.value.adults===r.adults&&quoteDigest(f.value.childAges)===quoteDigest(r.childAges))))return null;
  const sourceAt=ctx.evaluateSourceAt?.()??ctx.input.clock.sourceAt;await guard(ctx);const expiresAt=new Date(Date.parse(source.observedAt)+maxAge).toISOString();if(Date.parse(sourceAt)<Date.parse(source.observedAt)||Date.parse(sourceAt)>=Date.parse(expiresAt))return null;
  return{kind:'current_native_observation',taskId:ctx.task.id,requestId:ctx.input.requestId,ownerRef:ctx.input.authorizationScope!.ownerRef,threadId:ctx.input.authorizationScope!.threadId,propertyCode:ctx.input.propertyCode,sourceAt,taskSource:structuredClone(ctx.task.source),source:structuredClone(source),expiresAt,maxSourceAgeMs:maxAge,groupIds:source.request.rooms.map(r=>r.id)};
 };
 services.authorizeRateClaimBinding=async(ctx,revision,claim)=>{
  const before=quoteDigest({context:claimContextDigest(ctx),revision,claim}),captured=claimSources.get(ctx.task.id);
  try{await guard(ctx);}catch{ctx.signal.throwIfAborted();return null;}
  if(quoteDigest({context:claimContextDigest(ctx),revision,claim})!==before||!captured||captured.contextDigest!==claimContextDigest(ctx)||!ctx.task.factIds.includes(claim.id)||!ctx.facts.some(f=>f.id===claim.id&&quoteDigest(f)===quoteDigest(claim))||claim.kind!=='rate_claim'||claim.verification!=='text_verified'||claim.disclosure!=='guest'||ctx.input.capabilities.pmsWrite!==false||ctx.input.capabilities.emailSend!==false)return null;
  const source=captured.source,at=Date.parse(ctx.input.clock.sourceAt),sourceAt=Date.parse(source.observedAt);
  if(!Number.isFinite(at)||!Number.isFinite(sourceAt)||sourceAt>at||at-sourceAt>maxAge||revision.authorizationId!==options.authorizationId||revision.propertyCode!==ctx.input.propertyCode||revision.held!==false||revision.groups.length!==source.request.rooms.length||revision.groups.some(g=>g.sourceRef!==source.ref||g.sourceHash!==source.sha256))return null;
  let selections:ReturnType<typeof selectReservationistQuoteOptions>;try{selections=selectReservationistQuoteOptions(source);}catch{return null;}
  if(revision.groups.some(g=>{const request=source.request.rooms.find(r=>r.id===g.id),selection=selections.find(s=>s.groupId===g.id),option=source.result.groups.find(s=>s.id===g.id)?.options.find(o=>o.id===selection?.optionId);return!request||!option||g.optionId!==option.id||g.arrivalDate!==source.request.arrivalDate||g.departureDate!==source.request.departureDate||g.quantity!==request.quantity||g.adults!==request.adults||quoteDigest(g.childAges)!==quoteDigest(request.childAges)||g.roomCode!==option.room.code||g.rateCode!==option.rate.code||g.board!==boards[norm(option.board??'')]||quoteDigest(g.context)!==quoteDigest(option.appliedContext)||g.nightly.length!==option.nightly.length||g.nightly.some((n,i)=>n.date!==option.nightly[i]!.date||n.amountMinor!==exactMinor(option.nightly[i]!.price.amount));}))return null;
  const{id,...revisionData}=revision;if(id!==`quote:${quoteDigest(revisionData)}`)return null;
  const scopeDigest=quoteDigest(revision.groups.map(g=>({arrival:g.arrivalDate,departure:g.departureDate,quantity:g.quantity,adults:g.adults,childAges:g.childAges,room:g.roomCode,rate:g.rateCode,board:g.board,currency:g.currency,context:g.context})));if(revision.scopeDigest!==scopeDigest||revision.groups.some(g=>g.observedAt!==source.observedAt||g.currency!==source.request.requestedCurrency||g.perRoomMinor!==g.nightly.reduce((s,n)=>s+n.amountMinor,0)||g.totalMinor!==g.perRoomMinor*g.quantity)||revision.totalMinor!==revision.groups.reduce((s,g)=>s+g.totalMinor,0))return null;
  const message=ctx.input.messages.find(m=>`message:${m.id}`===claim.source.attachmentId),span=claim.source;
  if(!message||message.direction!=='inbound'||message.disclosure==='staff_only'||!Number.isFinite(Date.parse(message.at))||Date.parse(message.at)>Date.parse(ctx.input.clock.causalAt)||createHash('sha256').update(message.text).digest('hex')!==span.sourceHash||span.page!==1||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start!<0||span.end!<=span.start!||message.text.slice(span.start,span.end)!==span.quote)return null;
  const authoredEnd=message.text.search(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im);if(authoredEnd>=0&&span.end!>authoredEnd)return null;
  // Inspect the original monetary row, including qualifiers outside a narrowed model citation.
  let rowStart=0,row:string|undefined;for(const boundary of [...message.text.matchAll(/\n|;|[.!?](?=\s|$)/g),{index:message.text.length,0:''}]){const end=boundary.index!;if(rowStart<=span.start!&&end+boundary[0].length>=span.end!){row=message.text.slice(rowStart,end);break;}rowStart=end+boundary[0].length;}if(!row||/\b(?:not|never|no|without|previous|historical|cancelled|canceled)\b/i.test(row.replace(/\bnot exceed\b/gi,'')))return null;
  const amounts=[...row.matchAll(/\b(?:ZAR|R)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.]|,\d)/gi)].map(m=>{try{return exactMinor(m[1]!.replaceAll(',',''));}catch{return null;}});let claimedMinor:number;try{claimedMinor=exactMinor(claim.value.amount);}catch{return null;}if(!Number.isSafeInteger(claim.amountCents)||claimedMinor!==claim.amountCents||new Set(amounts).size!==1||amounts[0]!==claim.amountCents||claim.value.currency!==revision.currency||! /\b(?:ZAR|R)\s*\d/i.test(span.quote??'')||/\bper\s+(?:person|adult|child|guest)\b|\bdinner\s+(?:ZAR|R)\s*\d|\b(?:budget|meal allowance)\b/i.test(row))return null;
  const tax='(?:(?:all\\s+)?taxes\\s+and\\s+levies|VAT\\s*(?:and|&)\\s*(?:tourism\\s+)?lev(?:y|ies))',inclusive=new RegExp(`\\b${tax}\\s+(?:are\\s+)?included\\b|\\binclud(?:ing|es?)\\s+${tax}\\b`,'i').test(row),exclusive=new RegExp(`\\bexclud(?:ing|es?)\\s+${tax}\\b|\\b${tax}\\s+(?:are\\s+)?excluded\\b`,'i').test(row);if(inclusive===exclusive||inclusive&&/\bexclud(?:ing|ed|es?)\b/i.test(row)||exclusive&&/\binclud(?:ing|ed|es?)\b/i.test(row))return null;
  const roomRefs=[...row.matchAll(/\b(?:room|group)\b\s*(?:ref(?:erence)?|id)?\s*[:#-]?\s*([\p{L}\p{N}_-]+)/giu)].map(m=>m[1]!).filter(ref=>!['per'].includes(ref.toLowerCase()));
  let groups=revision.groups;
  if(claim.value.roomRef){groups=groups.filter(g=>g.id===claim.value.roomRef);if(groups.length!==1||!roomRefs.length||roomRefs.some(ref=>ref!==claim.value.roomRef))return null;}
  else if(claim.value.basis==='total'||claim.value.basis==='ceiling'&&/\btotal\b/i.test(row)){if(!/\b(?:entire|whole|full)\s+(?:stay|offer|booking|quotation)|\ball\s+(?:requested\s+)?rooms\b/i.test(row)||roomRefs.length)return null;}
  else if(groups.length!==1||roomRefs.some(ref=>ref!==groups[0]!.id&&ref!=='per'))return null;
  const nightly=/\bper (?:room per )?night\b|\bnightly\b/i.test(row),adr=/\bADR\b|\baverage daily\b/i.test(row),total=/\btotal\b/i.test(row),ceiling=/\b(?:ceiling|maximum|cap(?:ped)?)\b|up to|not exceed/i.test(row),budget=/\bbudget\b|\baround\b|\bapproximately\b|\broughly\b|\babout\b/i.test(row);
  if(budget||claim.value.basis==='budget'||claim.value.basis==='unknown'||claim.value.basis==='ceiling'&&!ceiling||claim.value.basis!=='ceiling'&&ceiling||claim.value.basis==='total'&&(!total||nightly||adr)||claim.value.basis==='nightly'&&(!nightly||total||adr)||claim.value.basis==='adr'&&(!adr||total||nightly)||claim.value.basis==='ceiling'&&(nightly===total||adr))return null;
  return{claimFactId:claim.id,claimDigest:quoteDigest(claim),sourceDigest:quoteDigest(claim.source),revisionId:revision.id,authorizationId:revision.authorizationId,scopeDigest:revision.scopeDigest,requestId:ctx.input.requestId,ownerRef:ctx.input.authorizationScope!.ownerRef,threadId:ctx.input.authorizationScope!.threadId,evaluatedAt:ctx.input.clock.sourceAt,groupIds:groups.map(g=>g.id),taxBasis:inclusive?'gross_included':'exclusive',evidenceRefs:[claim.source.attachmentId,...new Set(groups.map(g=>g.sourceRef))]};
 };
 services.resolveBookingTask=async ctx=>{
  const contextDigest=()=>{const{sourceAt: _sourceAt,...clock}=ctx.input.clock;return quoteDigest({input:{...ctx.input,clock},task:ctx.task,facts:ctx.facts});},originalContext=contextDigest();
  await guard(ctx);
  if(contextDigest()!==originalContext)throw new Error('booking_context_changed');
  if(!['new_booking','acceptance'].includes(ctx.task.kind)||ctx.task.kind==='acceptance'&&!options.readAcceptedQuoteSource)missing('booking_acceptance_source_unavailable',['the original sent offer and unchanged acceptance proof']);
  if(!options.readBookingPrerequisites)missing('booking_native_prerequisites_unavailable',['source-backed availability, duplicate check, native fields and property rules']);
  const bound=async()=>{await guard(ctx);if(contextDigest()!==originalContext)throw new Error('booking_context_changed');};
  let accepted:Awaited<ReturnType<typeof resolveReservationistAcceptedQuoteSource>>|undefined,revision:QuoteRevision;
  if(ctx.task.kind==='acceptance'){
   const original=await options.readAcceptedQuoteSource!(ctx);await bound();if(!original)missing('booking_acceptance_source_unavailable',['the original sent offer and unchanged acceptance proof']);
   accepted=await resolveReservationistAcceptedQuoteSource(ctx,original!,bound);revision=accepted.revision;
  }else{const quotation=await services.resolveQuoteTask!(ctx);await bound();revision=await resolveQuoteRevision(quotation as Parameters<typeof resolveQuoteRevision>[0]);}
  await bound();
  const beforeRevision=quoteDigest(revision),prerequisites=await options.readBookingPrerequisites(ctx,revision);await bound();
  ctx.evaluateSourceAt?.();await bound();
  if(quoteDigest(revision)!==beforeRevision)throw new Error('booking_revision_changed');
  if(!prerequisites?.availability||!prerequisites.duplicates||!prerequisites.codes||!prerequisites.authorizedFields||!Array.isArray(prerequisites.partyFacts)||typeof prerequisites.authorizeSource!=='function')missing('booking_native_prerequisites_unavailable',['complete source-backed booking prerequisite reads']);
  const fields=prerequisites.authorizedFields;if(!fields.sourceOfBusiness?.trim()||!fields.track?.trim()||!fields.guaranteeType?.trim())missing('booking_native_fields_unavailable',['source of business, track and guarantee selected by applicable source-backed rules']);
  const prerequisiteDigest=quoteDigest(prerequisites),authorizeNative=prerequisites.authorizeSource,retained=structuredClone({...prerequisites,authorizeSource:undefined});
  const guests=ctx.facts.filter(f=>f.kind==='guest'),identities=new Set<string>(),guestProofs:BookingEvidence['guestFacts']=[],rooms:BookingInput['rooms']=[];
  for(const g of revision.groups)for(let roomIndex=1;roomIndex<=g.quantity;roomIndex++){
   const assigned=guests.filter(f=>f.kind==='guest'&&f.value.roomRef===g.id&&f.value.roomIndex===roomIndex);
   if(assigned.length!==g.adults+g.children)missing('booking_guest_assignment_unavailable',['explicit distinct guests assigned to each physical room']);
   const roomGuests=assigned.map(f=>{
    if(f.kind!=='guest')throw new Error('booking_guest_type');
    const identity=norm(`${f.value.firstName} ${f.value.lastName}`);if(identities.has(identity))missing('booking_guest_duplicate',['distinct source-backed guest identities across physical rooms']);identities.add(identity);
    if(f.verification!=='text_verified'||f.disclosure!=='guest')missing('booking_guest_source_unavailable',['verified original guest identity and assignment']);
    const message=ctx.input.messages.find(m=>`message:${m.id}`===f.source.attachmentId);let proof:BookingEvidence['guestFacts'][number];
    if(message){
     if(message.direction!=='inbound'||message.disclosure==='staff_only'||Date.parse(message.at)>Date.parse(ctx.input.clock.causalAt)||createHash('sha256').update(message.text).digest('hex')!==f.source.sourceHash||f.source.start===undefined||f.source.end===undefined||message.text.slice(f.source.start,f.source.end)!==f.source.quote)throw new Error('booking_guest_source_changed');
     proof={sourceRef:f.source.attachmentId,sourceHash:f.source.sourceHash,authorizationId:revision.authorizationId!,propertyCode:revision.propertyCode,scopeDigest:revision.scopeDigest,observedAt:message.at,factRef:f.id,groupId:g.id,roomIndex,...f.value};
    }else{
     const matches=(retained.guestFacts??[]).filter(p=>p.factRef===f.id&&p.groupId===g.id&&p.roomIndex===roomIndex&&p.sourceRef===f.source.attachmentId&&p.sourceHash===f.source.sourceHash&&p.firstName===f.value.firstName&&p.lastName===f.value.lastName&&p.age===f.value.age&&p.profileId===f.value.profileId);
     if(matches.length!==1)missing('booking_guest_source_unavailable',['source-owner proof for the original attachment guest identity']);proof=matches[0]!;
    }
    guestProofs.push(proof);return{factRef:f.id,firstName:f.value.firstName,lastName:f.value.lastName,...(f.value.age===undefined?{}:{age:f.value.age}),...(f.value.profileId===undefined?{}:{profileId:f.value.profileId})};
   });
   rooms.push({groupId:g.id,roomIndex,guests:roomGuests,sourceOfBusiness:fields.sourceOfBusiness,track:fields.track,guaranteeType:fields.guaranteeType});
  }
  if(guestProofs.length!==guests.length)missing('booking_guest_assignment_unavailable',['every guest bound to exactly one physical room']);
  assertRevisionSourceFacts(ctx.facts,revision,rooms,guestProofs);
  const evidence:BookingEvidence={revision,availability:retained.availability,duplicates:retained.duplicates,codes:retained.codes,authorizedFields:retained.authorizedFields,partyFacts:retained.partyFacts,guestFacts:guestProofs,causalAt:ctx.input.clock.causalAt,...(accepted?{importedOffer:accepted.importedOffer,acceptance:{acceptedAt:accepted.acceptedAt,scopeDigest:revision.scopeDigest,sentProof:accepted.sentProof,inventoryEvidence:{revisionId:revision.id,scopeDigest:revision.scopeDigest,authorizationId:revision.authorizationId,observedAt:retained.availability.observedAt,available:retained.availability.available,maxAgeMs:retained.availability.maxSourceAgeMs!}}}:{})};
  const messageProofs=new Set(guestProofs.filter(p=>p.sourceRef.startsWith('message:')).map(p=>quoteDigest(p)));
  const originalProofs=accepted?[{sourceRef:accepted.sentProof.sourceRef,sourceHash:accepted.sentProof.sourceHash,authorizationId:revision.authorizationId,propertyCode:revision.propertyCode,scopeDigest:revision.scopeDigest,observedAt:accepted.sentProof.sentAt},...revision.groups.map(g=>({sourceRef:g.sourceRef,sourceHash:g.sourceHash,authorizationId:revision.authorizationId,propertyCode:revision.propertyCode,scopeDigest:revision.scopeDigest,observedAt:g.observedAt}))]:[],originalDigests=new Set(originalProofs.map(p=>quoteDigest(p)));
  const allowed=new Set([retained.availability,retained.duplicates,retained.codes,retained.authorizedFields,...retained.partyFacts,...guestProofs,...originalProofs,...(accepted?[]:revision.groups.map(g=>({sourceRef:g.sourceRef,sourceHash:g.sourceHash,authorizationId:revision.authorizationId!,propertyCode:revision.propertyCode,scopeDigest:revision.scopeDigest,observedAt:g.observedAt,expiresAt:revision.sourceFreshness!.expiresAt,maxSourceAgeMs:Date.parse(revision.sourceFreshness!.expiresAt)-Date.parse(revision.sourceFreshness!.observedAt)})))].map(p=>quoteDigest(p)));
  return{input:{kind:accepted?'accepted_quote':'new_booking',taskId:ctx.task.id,revisionId:revision.id,scopeDigest:revision.scopeDigest,rooms},evidence,authorizeSource:async(proof,signal)=>{
   signal.throwIfAborted();await bound();if(quoteDigest(prerequisites)!==prerequisiteDigest||prerequisites.authorizeSource!==authorizeNative||!allowed.has(quoteDigest(proof)))throw new Error('booking_prerequisite_source_changed');
   const digest=quoteDigest(proof),authorized=originalDigests.has(digest)?await accepted!.authorizeSource(proof,signal):messageProofs.has(digest)||await authorizeNative(proof,signal);await bound();
   if(quoteDigest(proof)!==digest||quoteDigest(prerequisites)!==prerequisiteDigest)throw new Error('booking_prerequisite_source_changed');return authorized;
  }};
 };
 return services;
}
