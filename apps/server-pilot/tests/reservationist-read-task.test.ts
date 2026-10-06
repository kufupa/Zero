import {describe,it,expect,vi} from 'vitest';
import {prepareReservationistReadTask} from '../src/ai/reservationist-read-task.js';
import {syntheticReservationistRead as underlyingFixture,syntheticUnavailableReadSection as unavailable} from './helpers/synthetic-reservationist-read.js';
const at='2026-10-04T10:00:00.000Z',expiry='2026-10-04T10:05:00.000Z';
function fact(value:unknown){return{state:'known',value,data:value,evidenceRef:'source',observedAt:at,expiresAt:expiry,sourceUpdatedAt:null};}
async function fixture(options:Parameters<typeof underlyingFixture>[0]={}){
 const f=await underlyingFixture(options);if(!options.input?.taskSource){const phrases={reservation_status:'reservation status',arrival:'arrival date',departure:'departure date',folio_balance:'folio balance',deposit_due:'deposit amount due',deposit_recorded:'recorded deposit amount'};const text=`Please check ${f.input.fields.map((field:keyof typeof phrases)=>phrases[field]).join(' and ')} for reservation ABC123.`;f.input.taskSource={...f.input.taskSource,quote:text,start:0,end:text.length};}return f;
}
async function run(options:Parameters<typeof fixture>[0]={}){const f=await fixture(options);const result=await prepareReservationistReadTask(f.input,{context:f.context,request:f.request,signal:f.context.signal,authorizeRead:f.authorizeRead,authorizeEvidence:f.authorizeEvidence});return{...f,result};}
describe('source-authorized reservationist read tasks',()=>{
 it('evaluates newly completed read evidence with the supplied current-read clock and preserves original binding',async()=>{const f=await fixture({folio:true,fields:['folio_balance']});f.input.clock.sourceMode='current_read';const original=JSON.stringify(f.input),completed='2026-10-04T10:00:01.000Z';let value=at,advanced=0;f.context.now=()=>new Date(value);f.handler.mockImplementation(async()=>{await new Promise(r=>setTimeout(r,5));return{toolId:'hms_read_folio',schemaVersion:'folio-read/1',status:'ok',data:{reservationBinding:'exact_parent_redacted',guestPrivacy:'identity_redacted',currency:'ZAR',totalBalance:'75.00',disclosure:{recipientClass:'reservation_guest',inquiryClass:'labelled_narrow_status',claimEligibility:'full'},rowsScanned:1,bytesObserved:100,durationMs:1,observedAt:completed},completeness:'complete',unavailableSections:[],scopeRef:'reservation',evidence:[{evidenceRef:'source',sourceSystem:'hms',sourceSurface:'Folio',requestBranchId:'branch',observedAt:completed,sourceUpdatedAt:null,expiresAt:expiry,scopeVerified:true,artifactRef:null,sourceHash:'a'.repeat(64)}],page:null,issues:[]} as any;});f.authorizeEvidence.mockImplementation(async({binding,grant}:any)=>[{authorizationId:grant.authorizationId,inputDigest:binding.inputDigest,requestDigest:binding.requestDigest,evidenceRef:'source',sourceHash:'a'.repeat(64),observedAt:completed,expiresAt:expiry,disclosure:'guest'}]);const result=await prepareReservationistReadTask(f.input,{...f.deps,evaluateSourceAt:()=>{advanced++;value=completed;return value;}} as any);expect(result.status).toBe('complete');expect(result.preparedFacts[0]?.observedAt).toBe(completed);expect(advanced).toBeGreaterThan(0);expect(JSON.stringify(f.input)).toBe(original);});
 it('uses guarded reservation dispatch and renders only asked source fields',async()=>{
  const {result,readContext,context}=await run();expect(result.recoveryCodes).toEqual([]);expect(result.status).toBe('complete');expect(context.budget.total).toBe(1);expect(readContext).toHaveBeenCalledOnce();expect(result.guestText).toContain('Tentative');expect(result.guestText).toContain('2026-10-12');expect(result.guestText).not.toContain('PRIVATE-100');expect(result.guestText).not.toContain('2026-10-15');expect(result.preparedFacts.map(f=>f.key)).toEqual(['reservation_status','arrival']);expect(result.readReceipt?.sourceProofs[0].sourceHash).toBe('a'.repeat(64));
 });
 it('describes recorded balances/deposits without asserting funds cleared',async()=>{
  const {result}=await run({folio:true});expect(result.recoveryCodes).toEqual([]);expect(result.status).toBe('complete');expect(result.guestText).toContain('ZAR 75.00');expect(result.guestText).toContain('ZAR 20.00');expect(result.guestText).not.toMatch(/paid|cleared|settled/i);expect(result.preparedFacts.map(f=>f.key)).toEqual(['folio_balance','deposit_due','deposit_recorded']);
 });
 it.each([{ownerRef:'foreign'},{threadId:'foreign'},{requestId:'foreign'},{propertyCode:'foreign'},{candidateId:'foreign'},{reservationRef:'foreign'}])('blocks context/request scope mismatch before read %j',async input=>{
  const {result,handler,readContext}=await run({folio:true,input});expect(result.status).toBe('blocked');expect(handler).not.toHaveBeenCalled();expect(readContext).not.toHaveBeenCalled();
 });
 it.each([null,{inputDigest:'foreign'},{requestDigest:'foreign'},{disclosure:'staff_only'},{allowedFields:[]},{maxSourceAgeMs:undefined},{expiresAt:at}])('requires independent exact guest grant before source dispatch %j',async grant=>{
  const {result,handler}=await run({folio:true,grant});expect(result.status).not.toBe('complete');expect(handler).not.toHaveBeenCalled();expect(result.preparedFacts).toEqual([]);
 });
 it.each([null,{sourceHash:'invalid'},{disclosure:'staff_only'},{observedAt:'2026-10-04T10:01:00.000Z'},{expiresAt:at},{evidenceRef:'foreign'}])('does not upgrade missing or invalid captured source proof %j',async proof=>{
  const {result}=await run({folio:true,proof});expect(result.status).not.toBe('complete');expect(result.preparedFacts).toEqual([]);
 });
 it('recomputes folio disclosure rather than trusting a full eligibility label',async()=>{
  const {result}=await run({folio:true,data:{disclosure:{recipientClass:'third_party',inquiryClass:'labelled_narrow_status',claimEligibility:'full'}}});expect(result.status).toBe('blocked');expect(result.guestText).not.toContain('75.00');
 });
 it('preserves incomplete requested fields without inventing zero deposits',async()=>{
  const {result}=await run({folio:true,data:{depositSummary:undefined,deposits:unavailable},receipt:{status:'partial',completeness:'partial'}});expect(result.status).toBe('needs_clarification');expect(result.preparedFacts.map(f=>f.key)).toEqual(['folio_balance']);expect(result.guestText).toContain('75.00');expect(result.guestText).not.toContain('0.00');expect(result.recoveryCodes).toContain('read_field_unavailable:deposit_recorded');
 });
 it('renders an observed confirmed existing status with its independent receipt',async()=>{
  const {result}=await run({status:'Confirmed'});expect(result.status).toBe('complete');expect(result.recoveryCodes).toEqual([]);expect(result.guestText).toContain('The existing reservation record shows status: Confirmed.');expect(result.readReceipt?.result.data).toBeTruthy();
 });
 it('rejects authorization mutation and keeps the original task binding',async()=>{
  const {result,handler}=await run({folio:true,mutateBinding:true});expect(result.status).toBe('blocked');expect(handler).not.toHaveBeenCalled();
 });
 it('renders a source-proved partial rich folio balance without assuming absent deposit totals',async()=>{
  const money={amount:'75.00',currency:'ZAR',basis:'ledger_balance',taxTreatment:'unknown'};
  const {result}=await run({folio:true,fields:['folio_balance'],data:{totalBalance:undefined,depositSummary:undefined,balance:{state:'partial',completeness:'partial',issues:[],data:{items:[{folioRef:fact('redacted'),folioType:fact('guest'),balance:fact(money)}]}},deposits:unavailable},receipt:{status:'partial',completeness:'partial'}});expect(result.status).toBe('needs_clarification');expect(result.guestText).toContain('ZAR 75.00');expect(result.preparedFacts).toHaveLength(1);
 });
 it('rejects rich finance values whose source fact is expired',async()=>{
  const money={amount:'75.00',currency:'ZAR',basis:'ledger_balance',taxTreatment:'unknown'};
  const {result}=await run({folio:true,fields:['folio_balance'],data:{totalBalance:undefined,depositSummary:undefined,balance:{state:'available',completeness:'complete',issues:[],data:{items:[{folioRef:fact('redacted'),folioType:fact('guest'),balance:{...fact(money),expiresAt:at}}]}}}});expect(result.status).toBe('blocked');expect(result.preparedFacts).toEqual([]);
 });
 it('requires original asked fields and a historical source clock before dispatch',async()=>{
  const {result,handler}=await run({folio:true,input:{clock:{causalAt:'2026-10-04T09:00:00.000Z',sourceAt:at,deadlineAt:Date.now()+60000}}});expect(result.status).toBe('blocked');expect(handler).not.toHaveBeenCalled();
 });
 it('honors existing read requester authorization and budget before handler invocation',async()=>{
  const {result,handler}=await run({folio:true,context:{requester:{authorizationId:'grant',transportId:'transport',threadId:'thread',triggerMessageId:'trigger',allowedClaimKinds:[],expiresAt:expiry}}});expect(result.status).toBe('blocked');expect(handler).not.toHaveBeenCalled();
 });
 it('rejects a wrong receipt scope and unsafe source values',async()=>{
  expect((await run({folio:true,receipt:{scopeRef:'foreign'}})).result.status).toBe('blocked');expect((await run({folio:true,data:{totalBalance:'75.001'}})).result.status).toBe('blocked');
 });
 it('rejects canceled work before source authorization or dispatch',async()=>{
  const f=await fixture({folio:true});const controller=new AbortController();controller.abort();await expect(prepareReservationistReadTask(f.input,{context:f.context,request:f.request,signal:controller.signal,authorizeRead:f.authorizeRead,authorizeEvidence:f.authorizeEvidence})).rejects.toThrow();expect(f.authorizeRead).not.toHaveBeenCalled();expect(f.handler).not.toHaveBeenCalled();
 });
});

describe('independent read ask field coverage',()=>{
 it.each(['future','regression','historical'])('denies an invalid %s advancing evaluation clock',async kind=>{const f=await fixture({folio:true,fields:['folio_balance']});if(kind!=='historical')f.input.clock.sourceMode='current_read';const result=await prepareReservationistReadTask(f.input,{...f.deps,evaluateSourceAt:()=>kind==='future'?new Date(Date.now()+60000).toISOString():'2026-10-04T09:59:59.000Z'});expect(result.status).toBe('blocked');expect(result.preparedFacts).toEqual([]);if(kind==='historical')expect(f.handler).not.toHaveBeenCalled();});
 it('rechecks source authorization expiry after a delayed read',async()=>{const f=await fixture({folio:true,fields:['folio_balance']});f.input.clock.sourceMode='current_read';const result=await prepareReservationistReadTask(f.input,{...f.deps,evaluateSourceAt:()=>expiry});expect(result.status).toBe('blocked');expect(result.recoveryCodes).toContain('read_authority_denied');expect(result.preparedFacts).toEqual([]);});
 it.each([
  ['What is the folio balance and deposit amount due for reservation ABC123?',['folio_balance','deposit_due']],
  ['What is the arrival and departure date of reservation ABC123?',['arrival','departure']],
  ['Please verify the payment for reservation ABC123.',['deposit_due','deposit_recorded']],
  ['What deposit is outstanding and what has been recorded for reservation ABC123?',['deposit_due','deposit_recorded']],
  ['What is the status of reservation ABC123?',['reservation_status']],
  ['What is the recorded deposit amount for reservation ABC123?',['deposit_recorded']],
  ['What deposit amount remains due for reservation ABC123?',['deposit_due']],
 ] as const)('derives complete asked fields from %s',async(text,fields)=>{
  const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual(fields);
 });
 it('refuses provider-selected subsets when a source asks for both balance and deposit',async()=>{
  const text='What is the folio balance and deposit amount due for reservation ABC123?';
  const f=await fixture({folio:true,fields:['folio_balance'],input:{taskSource:{sourceRef:'message:trigger',sourceHash:'b'.repeat(64),quote:text,start:0,end:text.length}}});
  const result=await prepareReservationistReadTask(f.input,f.deps);expect(result.status).toBe('blocked');expect(f.handler).not.toHaveBeenCalled();
 });
});

describe('honest partial finance completion',()=>{
 it.each(['Can I just please confirm – you made 2 standard queen reservations?','Please verify that you made the reservation.'])('recognizes a completed reservation creation inquiry without treating it as a create: %s',async text=>{const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual(['reservation_status']);const f=await fixture({fields:['reservation_status'],input:{taskSource:{sourceRef:'message:trigger',sourceHash:'b'.repeat(64),quote:text,start:0,end:text.length}}});const result=await prepareReservationistReadTask(f.input,f.deps);expect(result.status).toBe('complete');expect(f.readContext).toHaveBeenCalledOnce();});
 it.each(['Please make two standard queen reservations.','Please confirm then make a reservation.','Please confirm the rate before you make the reservations.'])('does not read status for prospective creation phrasing: %s',async text=>{const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual([]);});
 it.each(['Please confirm that this booking is cancelled.','Has my reservation been confirmed?','Does my booking exist?','Have you made the two reservations?'])('derives current reservation status from an explicit state enquiry: %s',async text=>{
  const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual(['reservation_status']);
  const f=await fixture({fields:['reservation_status'],input:{taskSource:{sourceRef:'message:trigger',sourceHash:'b'.repeat(64),quote:text,start:0,end:text.length}}});
  const result=await prepareReservationistReadTask(f.input,f.deps);expect(result.status).toBe('complete');expect(f.readContext).toHaveBeenCalledOnce();
 });
 it.each(['Please cancel my booking.','Please confirm a new booking.','What is your cancellation policy?','Can I cancel without a fee?','Please quote a confirmed rate.'])('does not substitute a current status read for an action or policy: %s',async text=>{
  const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual([]);
 });
 it('does not certify a whole balance from an explicit unavailable section and legacy amount',async()=>{
  const {result}=await run({folio:true,fields:['folio_balance'],data:{balance:unavailable}});expect(result.status).toBe('needs_clarification');expect(result.guestText).not.toContain('75.00');expect(result.preparedFacts).toEqual([]);
 });
 it('labels a partial single-account amount and keeps whole balance unresolved',async()=>{
  const money={amount:'75.00',currency:'ZAR',basis:'ledger_balance',taxTreatment:'unknown'};
  const {result}=await run({folio:true,fields:['folio_balance'],data:{balance:{state:'partial',completeness:'partial',issues:[],data:{items:[{folioRef:fact('redacted'),folioType:fact('guest'),balance:fact(money)}]}}},receipt:{status:'partial',completeness:'partial'}});expect(result.status).toBe('needs_clarification');expect(result.guestText).toContain('observed partial folio balance');expect(result.guestText).toContain('75.00');expect(result.recoveryCodes).toContain('read_partial_total:folio_balance');
 });
});


describe('received existing-booking status requests',()=>{
 it.each(["I'd like to confirm if you have received a booking for myself and one other.",'Please confirm you have the reservation.','Please check whether the hotel has received our booking.','Please verify you have my booking.'])('reads current status for %s',async text=>{
  const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).toEqual(['reservation_status']);const f=await fixture({fields:['reservation_status'],input:{taskSource:{sourceRef:'message:trigger',sourceHash:'b'.repeat(64),quote:text,start:0,end:text.length}}});expect((await prepareReservationistReadTask(f.input,f.deps)).status).toBe('complete');expect(f.readContext).toHaveBeenCalledOnce();
 });
 it.each(['Please confirm then book a room.','Please confirm the rate when you have the reservation.','We have received a booking request from a guest.','Please confirm if you have rooms available.','Please confirm my payment was received.'])('does not invent a reservation-status request from %s',async text=>{const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields(text)).not.toContain('reservation_status');});
 it('retains a separately requested financial assertion alongside existing booking status',async()=>{const {deriveReservationistReadFields}=await import('../src/ai/reservationist-read-task.js');expect(deriveReservationistReadFields('Please confirm you have the reservation and that it is paid and confirmed.')).toEqual(['reservation_status','deposit_recorded']);});
});
