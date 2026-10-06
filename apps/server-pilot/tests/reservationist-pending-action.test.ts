import {describe,it,expect} from 'vitest';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {assertReservationistResultFreshForAction} from '../src/ai/draft-approval.js';
import {createHash} from 'node:crypto';
import {validateDocumentPlan} from '../src/ai/reservationist-document-facts.js';
import {prepareReservationistChannelBookingSync,assertReservationistChannelBookingSyncPacket,prepareReservationistPendingAction} from '../src/ai/reservationist-pending-action.js';
const at='2026-10-04T10:00:00Z',hash='a'.repeat(64);
const input={kind:'change' as const,taskId:'change',requestId:'inbound',propertyCode:'HRCEN',ownerRef:'mailbox',threadId:'thread',reservationRef:'reservation:one',changes:{arrivalDate:'2026-10-15',departureDate:'2026-10-17'},clock:{causalAt:at,sourceAt:at,sourceMode:'historical' as const}};
const evidence={requestId:'inbound',ownerRef:'mailbox',threadId:'thread',authorizationId:'grant',propertyCode:'HRCEN',reservationRef:'reservation:one',sourceRef:'detail:one',sourceHash:hash,observedAt:at,maxSourceAgeMs:3600000,expiresAt:'2026-10-04T11:00:00Z',current:{arrivalDate:'2026-10-12',departureDate:'2026-10-14'},requestSource:{sourceRef:'message:inbound',sourceHash:hash,observedAt:at,taskId:'change',changes:input.changes}};
const deps={resolveEvidence:async()=>evidence,authorizeSource:async()=>true,signal:new AbortController().signal};
describe('source-bound nonexecuting amendments and cancellations',()=>{
 it('retains original dates and explicit requested change without claiming a save',async()=>{const r=await prepareReservationistPendingAction(input,deps);expect(r).toMatchObject({kind:'change',taskId:'change',status:'pending_pms_action',saved:false,businessRulesValidated:true,current:evidence.current,requested:input.changes});});
 it.each(['scope','hash','future','expired','unauthorized','request','calendar','partial'])('blocks %s without partial action',async kind=>{const e=structuredClone(evidence);if(kind==='scope')e.threadId='foreign';if(kind==='hash')e.sourceHash='bad';if(kind==='future')e.observedAt='2026-10-05T00:00:00Z';if(kind==='expired')e.expiresAt=at;if(kind==='request')e.requestSource.changes.arrivalDate='2026-10-16';const i=structuredClone(input);if(kind==='calendar')i.changes.arrivalDate='2026-02-31';if(kind==='partial')delete (i.changes as any).departureDate;const r=await prepareReservationistPendingAction(i,{...deps,resolveEvidence:async()=>e,authorizeSource:async()=>kind!=='unauthorized'});expect(r.status).toBe('blocked');expect(r.businessRulesValidated).toBe(false);});
 it('rejects an old reservation read even when expiry is still future',async()=>{const e={...evidence,observedAt:'2026-09-04T10:00:00Z'};const r=await prepareReservationistPendingAction(input,{...deps,resolveEvidence:async()=>e});expect(r.status).toBe('blocked');});
 it('prepares cancellation only for the exact authorized existing reservation',async()=>{const r=await prepareReservationistPendingAction({...input,kind:'cancel_request',changes:undefined},{...deps,resolveEvidence:async()=>({...evidence,requestSource:{...evidence.requestSource,changes:undefined}})});expect(r).toMatchObject({kind:'cancel_request',status:'pending_pms_action',saved:false});});
});
it('blocks post-authorization mutation of validated action facts and preserves exact source freshness',async()=>{
 const mutation=await prepareReservationistPendingAction(input,{...deps,authorizeSource:async e=>{e.current.arrivalDate='2026-02-31';return true;}});
 expect(mutation.status).toBe('blocked');
 const packet=await prepareReservationistPendingAction(input,deps);
 expect(packet).toMatchObject({authorizationId:evidence.authorizationId,propertyCode:input.propertyCode,sourceProofs:[{kind:'current',sourceRef:evidence.sourceRef,sourceHash:evidence.sourceHash,authorizationId:evidence.authorizationId,observedAt:at,expiresAt:evidence.expiresAt,maxSourceAgeMs:evidence.maxSourceAgeMs},{kind:'causal',sourceRef:evidence.requestSource.sourceRef,sourceHash:evidence.requestSource.sourceHash,observedAt:at}],requestBinding:{requestId:input.requestId,ownerRef:input.ownerRef,threadId:input.threadId,taskId:input.taskId,sourceRef:evidence.requestSource.sourceRef,sourceHash:evidence.requestSource.sourceHash}});
});

describe('causal channel booking sync receipt',()=>{
 const text='Please ensure you UPDATE your system. Booking reference CH-123. Arrival 2026-10-12 departure 2026-10-14. Room A: quantity 1, 2 adults, 0 children. Guest Jane Smith room A.';
 const sourceHash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:inbound',sourceHash,disclosure:'guest' as const,pages:[text],pageCount:1,observedAt:at};
 const span=(quote:string)=>({attachmentId:source.attachmentId,sourceHash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
 const facts=[
  {id:'ref',kind:'reservation_reference' as const,value:'CH-123',disclosure:'guest' as const,source:span('Booking reference CH-123.')},
  {id:'dates',kind:'dates' as const,value:{arrival:'2026-10-12',departure:'2026-10-14'},disclosure:'guest' as const,source:span('Arrival 2026-10-12 departure 2026-10-14.')},
  {id:'room',kind:'room' as const,value:{roomRef:'A',quantity:1,adults:2,childAges:[]},disclosure:'guest' as const,source:span('Room A: quantity 1, 2 adults, 0 children.')},
  {id:'guest',kind:'guest' as const,value:{firstName:'Jane',lastName:'Smith',roomRef:'A'},disclosure:'guest' as const,source:span('Guest Jane Smith room A.')},
 ];
 const channel=()=>({taskId:'sync',requestId:'inbound',propertyCode:'HRCEN',ownerRef:'mailbox',threadId:'thread',taskSource:span('Please ensure you UPDATE your system.'),facts:validateDocumentPlan({facts,tasks:[],unresolvedAsks:[]},[source]).facts,sources:[structuredClone(source)],clock:structuredClone(input.clock)});
 it('prepares only the exact reported causal receipt with no PMS authority or save claim',()=>{
  const result=prepareReservationistChannelBookingSync(channel());
  expect(result).toMatchObject({kind:'channel_booking_sync',status:'pending_pms_action',saved:false,businessRulesValidated:true,sourceAuthority:'customer_channel',nativeSaveAcceptance:'untested',reported:{reservationRef:'CH-123',arrivalDate:'2026-10-12',departureDate:'2026-10-14',rooms:[{roomRef:'A',quantity:1,adults:2,childAges:[]}],guests:[{firstName:'Jane',lastName:'Smith',roomRef:'A'}]}});
  expect(result.sourceProofs?.every(p=>p.kind==='causal')).toBe(true);
  expect(()=>assertReservationistChannelBookingSyncPacket(result,new Date(at))).not.toThrow();
  expect(()=>assertReservationistResultFreshForAction({version:1,packets:[result]},new Date(at))).not.toThrow();
 });
 it.each(['reservation_reference','dates','guest','room'])('keeps missing %s as focused clarification without fabricated receipt completion',kind=>{
  const candidate=channel();candidate.facts=candidate.facts.filter(f=>f.kind!==kind);const result=prepareReservationistChannelBookingSync(candidate);
  expect(result.status).toBe('needs_clarification');expect(result.businessRulesValidated).toBe(false);expect(result.missing.length).toBeGreaterThan(0);expect(result.saved).toBe(false);
 });
 it.each(['hash','future','span','room_guest','invented_reference','inventory_claim','child_age','guest_age','rate_claim'])('rejects %s integrity failure',key=>{
  const candidate=channel();if(key==='hash')candidate.sources[0].sourceHash='b'.repeat(64);if(key==='future')candidate.sources[0].observedAt='2026-10-05T00:00:00Z';if(key==='span')candidate.taskSource.start=1;
  if(key==='room_guest'){const guest=candidate.facts.find(f=>f.kind==='guest');if(guest?.kind==='guest')guest.value.roomRef='B';}
  if(key==='invented_reference'){const ref=candidate.facts.find(f=>f.kind==='reservation_reference');if(ref?.kind==='reservation_reference')ref.value='OTHER';}
  if(key==='child_age'){const room=candidate.facts.find(f=>f.kind==='room');if(room?.kind==='room')room.value.childAges=[7];}
  if(key==='guest_age'){const guest=candidate.facts.find(f=>f.kind==='guest');if(guest?.kind==='guest')guest.value.age=7;}
  if(key==='rate_claim')candidate.facts.push({id:'rate',kind:'rate_claim',value:{amount:'100',currency:'ZAR',basis:'total'},source:span('Booking reference CH-123.'),disclosure:'guest',authority:'customer_claim',verification:'text_verified'});
  if(key==='inventory_claim')Object.assign(candidate,{availability:'verified'});
  expect(prepareReservationistChannelBookingSync(candidate)).toMatchObject({status:'blocked',saved:false,businessRulesValidated:false});
 });
 it('denies packet tampering and cannot acquire current inventory authority',()=>{
  const packet=prepareReservationistChannelBookingSync(channel());const changed=structuredClone(packet);changed.saved=true as false;
  expect(()=>assertReservationistChannelBookingSyncPacket(changed,new Date(at))).toThrow();
  const structural=structuredClone(packet);if(structural.reported)structural.reported.rooms[0].quantity=0;const room=structural.factProofs?.find(f=>f.kind==='room');if(room?.kind==='room')room.value.quantity=0;const {digest,...data}=structural;structural.digest=quoteDigest(data);
  expect(()=>assertReservationistChannelBookingSyncPacket(structural,new Date(at))).toThrow();
 });
 it.each(['Not ', 'Previous cancelled guest: ', 'Guest removed: ', 'For another booking: '])('does not hide original guest-row qualifier %s',qualifier=>{
  const candidate=channel(),original=text.replace('Guest Jane Smith room A.',`${qualifier}Guest Jane Smith room A.`),originalHash=createHash('sha256').update(original).digest('hex');
  candidate.sources=[{...source,sourceHash:originalHash,pages:[original]}];
  candidate.taskSource={...candidate.taskSource,sourceHash:originalHash};
  candidate.facts=candidate.facts.map(f=>({...f,source:{...f.source,sourceHash:originalHash,start:original.indexOf(f.source.quote!),end:original.indexOf(f.source.quote!)+f.source.quote!.length}}));
  expect(prepareReservationistChannelBookingSync(candidate)).toMatchObject({status:'blocked',businessRulesValidated:false,saved:false});
 });
 it('leaves absent guest room reference unresolved without assigning a room',()=>{
  const candidate=channel(),guest=candidate.facts.find(f=>f.kind==='guest');if(guest?.kind==='guest')delete guest.value.roomRef;
  const result=prepareReservationistChannelBookingSync(candidate);expect(result).toMatchObject({status:'needs_clarification',missing:['guest room association'],businessRulesValidated:false});expect(result.reported).toBeUndefined();
 });

 function withOriginal(original:string){const candidate=channel(),originalHash=createHash('sha256').update(original).digest('hex');candidate.sources=[{...source,sourceHash:originalHash,pages:[original]}];candidate.taskSource={...candidate.taskSource,sourceHash:originalHash};candidate.facts=candidate.facts.map(f=>{const quote=f.kind==='reservation_reference'&&original.includes('Booking Reference No CH-123.')?'Booking Reference No CH-123.':f.kind==='dates'&&original.includes('Check-in Sun')?'Check-in Sun 12 Oct 2026 Check-out Tue 14 Oct\n2026.':f.source.quote!;return {...f,source:{...f.source,sourceHash:originalHash,quote,start:original.indexOf(quote),end:original.indexOf(quote)+quote.length}};});return candidate;}
 const printed=text.replace('Booking reference CH-123.','Booking Reference No CH-123.').replace('Arrival 2026-10-12 departure 2026-10-14.','Check-in Sun 12 Oct 2026 Check-out Tue 14 Oct\n2026.');
 it('accepts reference Number label and exact date continuation without inventing missing allocation',()=>{const candidate=withOriginal(printed);const result=prepareReservationistChannelBookingSync(candidate);expect(result.status).toBe('pending_pms_action');expect(result.saved).toBe(false);candidate.facts=candidate.facts.filter(f=>f.kind!=='room');const guest=candidate.facts.find(f=>f.kind==='guest');if(guest?.kind==='guest')delete guest.value.roomRef;const missing=prepareReservationistChannelBookingSync(candidate);expect(missing.status).toBe('needs_clarification');expect(missing.missing).toContain('explicit room allocation and quantity');expect(missing.missing).toContain('guest room association');});
 it.each(['No booking exists. ', 'Not ', 'Previous cancelled '])('does not turn actual reference negation %s into a Number label',prefix=>{const original=printed.replace('Booking Reference No CH-123.',prefix+'Booking Reference No CH-123.'),candidate=withOriginal(original);expect(prepareReservationistChannelBookingSync(candidate).status).toBe('blocked');});
 it('does not join contradictory date continuation or unrelated multirow room facts',()=>{for(const original of [printed.replace('Check-in Sun','Not Check-in Sun'),printed.replace('Oct\n2026.','Oct\nUnknown 2026.'),printed.replace('Room A: quantity 1, 2 adults, 0 children.','Room A: quantity 1,\n2 adults, 0 children.')]){const candidate=withOriginal(original);if(original.includes('quantity 1,\n')){const room=candidate.facts.find(f=>f.kind==='room');if(room)room.source={...room.source,quote:'Room A: quantity 1,\n2 adults, 0 children.',start:original.indexOf('Room A:'),end:original.indexOf('Room A:')+'Room A: quantity 1,\n2 adults, 0 children.'.length};}expect(prepareReservationistChannelBookingSync(candidate).status).toBe('blocked');}});

 it('accepts authentic reference Number label independently of date wrapping',()=>{expect(prepareReservationistChannelBookingSync(withOriginal(text.replace('Booking reference CH-123.','Booking Reference No CH-123.'))).status).toBe('pending_pms_action');});
 it('accepts exact wrapped source dates independently of reference Number label',()=>{expect(prepareReservationistChannelBookingSync(withOriginal(text.replace('Arrival 2026-10-12 departure 2026-10-14.','Check-in Sun 12 Oct 2026 Check-out Tue 14 Oct\n2026.'))).status).toBe('pending_pms_action');});

 it.each(['No\n','Not\n','Previous cancelled\n','For another reservation:\n','If authorized\n','Unless authorized\n'])('retains enclosing reference qualifier %s before Number label',prefix=>{const original=printed.replace('Booking Reference No CH-123.',prefix+'Booking Reference No CH-123.');expect(prepareReservationistChannelBookingSync(withOriginal(original))).toMatchObject({status:'blocked',saved:false,businessRulesValidated:false});});

 it.each(['If authorized\n','Unless authorized\n','Not\n'])('retains enclosing wrapped date qualifier %s',prefix=>{const original=printed.replace('Check-in Sun',prefix+'Check-in Sun');expect(prepareReservationistChannelBookingSync(withOriginal(original))).toMatchObject({status:'blocked',saved:false,businessRulesValidated:false});});

});
