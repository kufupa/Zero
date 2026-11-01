import {expect,it} from 'vitest';
import * as drafts from '../src/trpc/routes/drafts.js';
import {RESERVATIONIST_VOUCHER_REVIEW_REASON} from '../src/ai/reservationist-extraction.js';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
const now=new Date('2026-10-04T10:00:00Z');
const summary=(result:any)=>(drafts as any).buildReservationistReviewSummary({version:1,readiness:'needs_clarification',...result},now);
const requestSource=(quote:string,attachmentId='message:inbound')=>({attachmentId,sourceHash:'a'.repeat(64),page:1,start:0,end:quote.length,quote});
const price={currency:'ZAR',totalMinor:26200,nightly:[{date:'2026-10-12',amountMinor:10000},{date:'2026-10-13',amountMinor:16200}],source:{observedAt:'2026-10-04T09:00:00Z'}};
const cancellationReview={outcome:'prepared_for_human_review',roomScope:{state:'unresolved',complete:false},policy:{state:'unknown'},fee:{state:'unknown_precommit',amount:null,currency:null},action:{actor:'human',cancellationStarted:false,commitAvailable:false}};
const cancellationPacket=()=>{const packet={kind:'cancel_request',taskId:'cancel',status:'pending_pms_action',saved:false,businessRulesValidated:false,reservationRef:'12345678',propertyCode:'HRCEN',authorizationId:'synthetic-auth',errors:[],sourceRefs:['hms-record:synthetic','message:inbound'],sourceProofs:[{kind:'current',sourceRef:'hms-record:synthetic',sourceHash:'b'.repeat(64),authorizationId:'synthetic-auth',propertyCode:'HRCEN',reservationRef:'12345678',resolvedConfirmation:'12345678-1',observedAt:'2026-10-04T09:00:00Z',expiresAt:'2026-10-04T11:00:00Z',maxSourceAgeMs:7200000},{kind:'causal',sourceRef:'message:inbound',sourceHash:'a'.repeat(64),authorizationId:'synthetic-auth',propertyCode:'HRCEN',reservationRef:'12345678',observedAt:'2026-10-04T08:00:00Z'}],requestBinding:{requestId:'inbound',ownerRef:'synthetic-owner',threadId:'synthetic-thread',taskId:'cancel',sourceRef:'message:inbound',sourceHash:'a'.repeat(64),observedAt:'2026-10-04T08:00:00Z'},current:{arrivalDate:'2026-10-12',departureDate:'2026-10-14'},cancellationReview};return {...packet,digest:quoteDigest(packet)};};
const booking={kind:'new_booking',taskId:'book',status:'pending_pms_action',saved:false,businessRulesValidated:true,currency:'ZAR',totalMinor:52400,rooms:[{groupId:'g1',roomIndex:1,guests:[{firstName:'Alex',lastName:'Example'}],request:{arrival:'2026-10-12',departure:'2026-10-14',adults:1,childAges:[],roomType:'STQN',ratePlan:'BAR'},pricing:price},{groupId:'g1',roomIndex:2,guests:[{firstName:'Morgan',lastName:'Sample'}],request:{arrival:'2026-10-12',departure:'2026-10-14',adults:1,childAges:[],roomType:'STQN',ratePlan:'BAR'},pricing:price}]};
it('shows a new booking with source-observed per-room guests, dates and exact agreed nightly prices',()=>{
 const result=summary({tasks:[{id:'book',kind:'new_booking',status:'pending_pms_action'}],packets:[booking]});
 expect(result.tasks[0].label).toBe('Prepare new booking');
 const detail=result.tasks[0].details.join('\n');
 expect(detail).toContain('Room 1');expect(detail).toContain('Alex Example');expect(detail).toContain('Room 2');expect(detail).toContain('Morgan Sample');expect(detail).toContain('2026-10-12 to 2026-10-14');expect(detail).toContain('2026-10-13: ZAR 162.00');expect(detail).toContain('ZAR 524.00');expect(detail).toContain('Observed 2026-10-04T09:00:00Z');expect(detail).toContain('No booking has been saved');
});
it('keeps accepted quote wording separate from new booking',()=>{
 const result=summary({tasks:[{id:'book',kind:'acceptance',status:'pending_pms_action'}],packets:[{...booking,kind:'accepted_quote'}]});
 expect(result.tasks[0].details.join('\n')).toContain('Agreed quote total: ZAR 524.00');
});
it('shows amendment current and requested dates plus original request time without a completion claim',()=>{
 const packet={kind:'change',taskId:'change',status:'pending_pms_action',saved:false,businessRulesValidated:true,reservationRef:'ABC123',current:{arrivalDate:'2026-10-12',departureDate:'2026-10-14'},requested:{arrivalDate:'2026-10-15',departureDate:'2026-10-17'},sourceProofs:[{kind:'current',observedAt:'2026-10-04T09:00:00Z'}],requestBinding:{observedAt:'2026-10-04T08:00:00Z'}};
 const detail=summary({tasks:[{id:'change',kind:'change',status:'pending_pms_action'}],packets:[packet]}).tasks[0].details.join('\n');
 expect(detail).toContain('ABC123');expect(detail).toContain('Recorded stay: 2026-10-12 to 2026-10-14');expect(detail).toContain('Requested stay: 2026-10-15 to 2026-10-17');expect(detail).toContain('Requested 2026-10-04T08:00:00Z');expect(detail).toContain('No changes have been saved');
});
it('shows read recovery and claimed versus recorded payment without implying clearance',()=>{
 const result=summary({tasks:[{id:'read',kind:'question',status:'needs_clarification'}],readRecoveries:[{taskId:'read',codes:['read_field_unavailable:deposit_due','read_partial_total:folio_balance','payment_claim_ledger_mismatch']}],paymentComparisons:[{taskId:'read',claimedMinor:10000,recordedMinor:2000,status:'mismatch',cleared:false}]});
 const detail=result.tasks[0].details.join('\n');expect(detail).toContain('Deposit amount due is unavailable');expect(detail).toContain('Folio balance is partial');expect(detail).toContain('Claimed payment: ZAR 100.00');expect(detail).toContain('Recorded deposit: ZAR 20.00');expect(detail).toContain('Amounts differ');expect(detail).toContain('Payment clearance remains unverified');
 expect(detail).not.toContain('read_field_unavailable');
});
it.each([
 ['booking_native_prerequisites_unavailable','Staff must verify booking availability, duplicate-search evidence and applicable source, track and guarantee rules before preparing the booking.'],
 ['booking_native_fields_unavailable','Staff must verify the required booking system fields and guest assignments before preparing the booking.'],
])('shows actionable staff review for %s without inventing selected values', (code, instruction)=>{
 const result=summary({tasks:[{id:'book',kind:'new_booking',status:'needs_clarification'}],readRecoveries:[{taskId:'book',codes:[code]}],packets:[]});
 expect(result.tasks[0].state).toBe('Needs review');
 expect(result.tasks[0].details).toContain(instruction);
 expect(result.tasks[0].details.join('\n')).not.toContain('Requested record details');
 expect(result.tasks[0].details.join('\n')).not.toContain(code);
 expect(result.tasks[0].details.join('\n')).not.toContain('Non-Guaranteed Individual');
 expect(result.reason).toContain('staff review');
});
it('keeps booking-prerequisite review instructions attached only to the affected task',()=>{
 const result=summary({tasks:[{id:'answer',kind:'question',status:'complete'}],readRecoveries:[{taskId:'other',codes:['booking_native_prerequisites_unavailable']}],packets:[]});
 expect(result.tasks[0].details).toEqual([]);
});
it('does not attach evidence from another task or a saved/invalid packet',()=>{
 const result=summary({tasks:[{id:'book',kind:'new_booking',status:'pending_pms_action'}],packets:[{...booking,taskId:'other'},{...booking,saved:true}],readRecoveries:[{taskId:'other',codes:['payment_clearance_unproven']}]});
 expect(result.tasks[0].details).toEqual([]);
});
it('degrades malformed stored result arrays without crashing or showing invented proof',()=>{
 expect(summary({tasks:'bad',packets:{},quoteRevisions:[{groups:null}],readRecoveries:null}).tasks).toEqual([]);
});
it('keeps each room nightly amount and observation bound to its physical room',()=>{
 const detail=summary({tasks:[{id:'book',kind:'new_booking',status:'pending_pms_action'}],packets:[booking]}).tasks[0].details;
 expect(detail).toContain('Room 1 · 2026-10-13: ZAR 162.00');expect(detail).toContain('Room 2 · 2026-10-13: ZAR 162.00');expect(detail).toContain('Room 2 · Observed 2026-10-04T09:00:00Z');
});
it('keeps review details in the actual draft wire response',async()=>{
 const {toDraftWire}=await import('../src/trpc/routes/draft-wire.js');
 const review=summary({tasks:[{id:'book',kind:'new_booking',status:'pending_pms_action'}],packets:[booking]});
 const wire=toDraftWire({id:'draft',generationId:'generation',attachments:[],updatedAt:now,threadId:'thread',replyToMessageId:'message',toAddresses:[],ccAddresses:[],bccAddresses:[],subject:'Booking',textBody:'Please review.',status:'candidate',origin:'ai'} as any,false,review);
 expect(wire.reviewSummary?.tasks[0]?.details).toEqual(review.tasks[0].details);
 expect(wire.reviewSummary?.tasks[0]).toMatchObject({id:'book',kind:'new_booking'});
});
it('shows cancellation current stay and preserves no-cancellation completion wording',()=>{
 const detail=summary({tasks:[{id:'cancel',kind:'cancel_request',status:'pending_pms_action'}],packets:[cancellationPacket()]}).tasks[0].details.join('\n');
 expect(detail).toContain('Requested reference: 12345678');expect(detail).toContain('HMS confirmation read: 12345678-1');
 expect(detail).toContain('Recorded stay: 2026-10-12 to 2026-10-14');expect(detail).toContain('No cancellation has been saved');expect(detail).not.toContain('Requested stay');
});
it('withholds the stay display when the resolved confirmation is not bound to current evidence',()=>{
 const packet=cancellationPacket() as any;packet.sourceProofs[0].resolvedConfirmation='OTHER-1';const {digest:_digest,...data}=packet;packet.digest=quoteDigest(data);
 const detail=summary({tasks:[{id:'cancel',kind:'cancel_request',status:'pending_pms_action'}],packets:[packet]}).tasks[0].details.join('\n');
 expect(detail).not.toContain('HMS confirmation read: OTHER-1');expect(detail).not.toContain('Recorded stay:');
});
it('withholds cancellation stay details from legacy packets without a resolved current proof',()=>{
 const packet=cancellationPacket() as any;packet.businessRulesValidated=true;delete packet.sourceProofs[0].resolvedConfirmation;const {digest:_digest,...data}=packet;packet.digest=quoteDigest(data);
 const detail=summary({tasks:[{id:'cancel',kind:'cancel_request',status:'pending_pms_action'}],packets:[packet]}).tasks[0].details.join('\n');
 expect(detail).not.toContain('Requested reference:');expect(detail).not.toContain('HMS confirmation read:');expect(detail).not.toContain('Recorded stay:');
});
it('surfaces only the unresolved cancellation preflight facts in the staff task',()=>{
 const detail=summary({tasks:[{id:'cancel',kind:'cancel_request',status:'pending_pms_action'}],packets:[cancellationPacket()]}).tasks[0].details.join('\n');
 expect(detail).toContain('Cancellation room scope remains unresolved');
 expect(detail).toContain('Applicable cancellation policy has not been verified');
 expect(detail).toContain('Cancellation fee is unknown before commitment');
 expect(detail).toContain('Cancellation has not been started; no commit is available');
 expect(detail).not.toMatch(/ZAR|\$|[£€]|deposit|cleared/i);
});
it('shows current action evidence time and explicit property booking fields for staff review',()=>{
 const packet=structuredClone(booking) as any;packet.sourceProofs=[{kind:'current',observedAt:'2026-10-04T09:30:00Z',expiresAt:'2026-10-04T11:00:00Z'}];packet.rooms[0].request.sourceOfBusiness='E-Mail';packet.rooms[0].request.track='BAR';packet.rooms[0].request.guaranteeType='Non-Guaranteed Individual';
 const detail=summary({tasks:[{id:'book',kind:'new_booking',status:'pending_pms_action'}],packets:[packet]}).tasks[0].details.join('\n');
 expect(detail).toContain('Current evidence observed 2026-10-04T09:30:00Z');expect(detail).toContain('Expires 2026-10-04T11:00:00Z');expect(detail).toContain('Source: E-Mail');expect(detail).toContain('Guarantee: Non-Guaranteed Individual');
});
it('shows retained selected scope board, party and inclusion terms with source times and accepted validity',()=>{
 const packet=structuredClone(booking) as any;packet.kind='accepted_quote';packet.acceptanceProof={acceptedAt:'2026-10-04T08:00:00Z',sentProof:{sentAt:'2026-10-03T09:00:00Z'},revision:{authoredDate:'2026-10-03',validity:{days:3,anchor:'authored_date',cutoff:'unresolved'}}};
 packet.rooms[0].pricing.scope={roomCode:'STQN',roomLabel:'Standard Queen',rateCode:'BAR',rateLabel:'Best Available Rate',board:'breakfast',context:{organization:{name:'Synthetic Org',nativeId:'org1'}},inclusions:{vat:'included',levy:'included',bundleLabels:['Adult breakfast'],authoredDates:['2026-10-03']},partySourceProofs:[{kind:'organization',name:'Synthetic Org',sourceHash:'secret-hash',nativeId:'org1',observedAt:'2026-10-04T09:00:00Z'}]};
 const detail=summary({tasks:[{id:'book',kind:'acceptance',status:'pending_pms_action'}],packets:[packet]}).tasks[0].details.join('\n');
 expect(detail).toContain('Standard Queen');expect(detail).toContain('Best Available Rate');expect(detail).toContain('Breakfast');expect(detail).toContain('VAT included');expect(detail).toContain('Tourism levy included');expect(detail).toContain('Adult breakfast');expect(detail).toContain('Organization: Synthetic Org');expect(detail).toContain('Party evidence observed 2026-10-04T09:00:00Z');expect(detail).toContain('Quote authored 2026-10-03');expect(detail).toContain('3 days');expect(detail).toContain('Accepted 2026-10-04T08:00:00Z');expect(detail).not.toContain('secret-hash');expect(detail).not.toContain('org1');
});
it('retains approval provenance only in authorized staff pricing review while guest totals remain separate',async()=>{
 const {syntheticRevision}=await import('./helpers/synthetic-quote-revision.js');const {resolveApprovedOverride}=await import('../src/quote-proposal/quote-revision.js');
 const revision=await syntheticRevision();const override=await resolveApprovedOverride({revision,ref:'approval',evaluationAt:'2026-10-04T09:30:00Z',resolveApproval:async()=>({ref:'approval',authorizationId:revision.authorizationId,revisionId:revision.id,sourceHash:'a'.repeat(64),actorRef:'Staff Reviewer',reason:'Authorized account adjustment',approvedAt:'2026-10-04T09:00:00Z',amount:'2000.00',currency:'ZAR'}),authorizeActor:async()=>true});
 const review=summary({quoteRevisions:[revision],approvedOverrides:[override]});
 const text=review.pricingProof.join('\n');expect(text).toContain('Staff Reviewer');expect(text).toContain('Authorized account adjustment');expect(text).toContain('Approved 2026-10-04T09:00:00Z');expect(text).toContain('ZAR 2000.00');
});

it('presents source-reported channel room quantity and guest association with no system-update claim',async()=>{
 const {prepareReservationistChannelBookingSync}=await import('../src/ai/reservationist-pending-action.js');const {validateDocumentPlan}=await import('../src/ai/reservationist-document-facts.js');const {createHash}=await import('node:crypto');
 const original='Please ensure you UPDATE your system. Booking reference CH-123. Arrival 2026-10-12 departure 2026-10-14. Room A: quantity 1, 2 adults, 0 children. Guest Jane Smith room A.',hash=createHash('sha256').update(original).digest('hex'),source={attachmentId:'message:inbound',sourceHash:hash,disclosure:'guest' as const,pages:[original],pageCount:1,observedAt:now.toISOString()};
 const span=(quote:string)=>({attachmentId:source.attachmentId,sourceHash:hash,page:1,quote,start:original.indexOf(quote),end:original.indexOf(quote)+quote.length});
 const facts=validateDocumentPlan({facts:[{id:'ref',kind:'reservation_reference',value:'CH-123',disclosure:'guest',source:span('Booking reference CH-123.')},{id:'dates',kind:'dates',value:{arrival:'2026-10-12',departure:'2026-10-14'},disclosure:'guest',source:span('Arrival 2026-10-12 departure 2026-10-14.')},{id:'room',kind:'room',value:{roomRef:'A',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:span('Room A: quantity 1, 2 adults, 0 children.')},{id:'guest',kind:'guest',value:{firstName:'Jane',lastName:'Smith',roomRef:'A'},disclosure:'guest',source:span('Guest Jane Smith room A.')}],tasks:[],unresolvedAsks:[]},[source]).facts;
 const packet=prepareReservationistChannelBookingSync({taskId:'sync',requestId:'inbound',propertyCode:'HRCEN',ownerRef:'mailbox',threadId:'thread',taskSource:span('Please ensure you UPDATE your system.'),facts,sources:[source],clock:{causalAt:now.toISOString(),sourceAt:now.toISOString(),sourceMode:'current_read'}});
 expect(packet.status).toBe('pending_pms_action');const view=summary({tasks:[{id:'sync',kind:'channel_booking_sync',status:'pending_pms_action'}],packets:[packet]});
 expect(view.tasks[0].label).toBe('Review channel booking');const detail=view.tasks[0].details.join('\n');for(const value of ['CH-123','2026-10-12 to 2026-10-14','Quantity 1','Jane Smith · Room A','No system update has been saved','native reservation remains unverified'])expect(detail).toContain(value);
 expect(detail).not.toContain(hash);expect(detail).not.toContain('customer_channel');
 for(const changed of [{...packet,taskId:'other'},{...packet,saved:true},{...packet,digest:'0'.repeat(64)}])expect(summary({tasks:[{id:'sync',kind:'channel_booking_sync',status:'pending_pms_action'}],packets:[changed]}).tasks[0].details).toEqual([]);
});


it.each([
 ['recorded_quote_request_unavailable','An exact PMS quote recording for the requested dates, rooms, occupancy, meals and party context is unavailable.'],
 ['recorded_party_request_unavailable','An exact PMS party lookup recording is unavailable.'],
 ['native_quote_business_evidence_unavailable','Native quote evidence does not establish qualified rate eligibility and combined room inventory.'],
 ['business_quote_policy_unavailable','Applicable quote inclusions and tax terms are unavailable.'],
 ['business_selected_joint_inventory_unavailable','Combined availability for the requested room allocation is unproven.'],
 ['business_selected_price_unavailable','No available option with qualified pricing covers every requested room-night.'],
 ['business_party_identity_unavailable','A unique applicable party identity has not been established.'],
])('shows the exact quote evidence gap in staff review for %s', (code, instruction)=>{
 const result=summary({tasks:[{id:'quote',kind:'quote',status:'needs_clarification'}],readRecoveries:[{taskId:'quote',codes:[code]}],quoteRevisions:[],packets:[]});
 expect(result.tasks[0].details).toContain(instruction);
 expect(result.tasks[0].details.join(' ')).not.toContain('Requested record details');
 expect(result.tasks[0].details.join(' ')).not.toContain(code);
 expect(result.tasks[0].state).toBe('Needs review');
 expect(result.pricingProof).toEqual([]);
});
it('keeps quote evidence gaps attached to their task without affecting a completed quote',()=>{
 const result=summary({tasks:[{id:'good',kind:'quote',status:'complete'},{id:'gap',kind:'quote',status:'needs_clarification'}],readRecoveries:[{taskId:'gap',codes:['business_selected_joint_inventory_unavailable']}],quoteRevisions:[]});
 expect(result.tasks[0].details).toEqual([]);
 expect(result.tasks[1].details.join(' ')).toContain('Combined availability');
});

it('shows task-bound quote extraction gaps as review notes without treating them as verified facts',()=>{
 const reason='Please confirm the room allocation and adult/child occupancy, including any child ages.';
 const result=summary({tasks:[{id:'quote',kind:'quote',status:'needs_clarification'},{id:'other',kind:'quote',status:'complete'}],sourceRecoveries:[{kind:'unresolved_fact',reason,disclosure:'staff_only',provenance:{reason,taskIds:['quote'],sources:[{attachmentId:'private-original',sourceHash:'a'.repeat(64)}]}}]});
 expect(result.tasks[0].details).toContain('Source review: '+reason);
 expect(result.tasks[1].details).toEqual([]);
 expect(result.tasks[0].details.join(' ')).not.toContain('private-original');
 expect(result.tasks[0].details.join(' ')).not.toContain('a'.repeat(64));
 expect(result.pricingProof).toEqual([]);
});
it('ignores malformed or unrelated quote extraction notes and bounds their displayed length',()=>{
 const reason='x'.repeat(1000);
 const result=summary({tasks:[{id:'quote',kind:'quote',status:'needs_clarification'}],sourceRecoveries:[
 {kind:'unresolved_fact',reason,disclosure:'staff_only',provenance:{reason,taskIds:['quote'],sources:[]}},
 {kind:'unresolved_fact',reason:'unbound'},
 {kind:'unresolved_fact',reason:'different',disclosure:'staff_only',provenance:{reason:'mismatch',taskIds:['quote']}},
 {kind:'attachment_manual',reason:'not an extracted fact',disclosure:'staff_only',provenance:{reason:'not an extracted fact',taskIds:['quote']}},
 ]});
 expect(result.tasks[0].details).toEqual(['Source review: '+reason.slice(0,256)]);
});

it('lists the exact unanswered request while a completed quote remains ready',()=>{
 const quote=requestSource('Please quote accommodation.'),question=requestSource('Is an airport shuttle available?');
 const review=summary({tasks:[{id:'quote',kind:'quote',status:'complete',requestSource:quote},{id:'shuttle',kind:'question',status:'needs_clarification',requestSource:question,guestText:'Please confirm the requested answer source.'}]});
 expect(review.staffActions).toEqual([{id:`request:shuttle:message:inbound:0:${question.end}:${question.sourceHash}`,kind:'unanswered_question',text:question.quote,sourceRef:'message:inbound',sourceHash:question.sourceHash,sourceKind:'message',messageId:'inbound',blockingQuote:false,status:'open'}]);
 expect(review.tasks[0].state).toBe('Ready');
 expect(summary({tasks:[{id:'shuttle',kind:'question',status:'complete',requestSource:question}]}).staffActions).toEqual([]);
});

it('projects an exact voucher source as staff review even with no selected tasks',()=>{
 const text='Please review the attached hotel voucher.',quote='attached hotel voucher',start=text.indexOf(quote),recovery={kind:'voucher_review',reason:RESERVATIONIST_VOUCHER_REVIEW_REASON,
  sourceRef:'message:inbound',sourceHash:'a'.repeat(64),sourceKind:'message',messageId:'inbound',page:1,start,end:start+quote.length,quote,disclosure:'staff_only'};
 const review=summary({tasks:[],sourceRecoveries:[recovery]});
 expect(review.staffActions).toEqual([{id:`voucher:message:inbound:${'a'.repeat(64)}:${start}:${start+quote.length}`,kind:'voucher_review',text:quote,
  sourceRef:'message:inbound',sourceHash:'a'.repeat(64),sourceKind:'message',messageId:'inbound',reason:'Check the attached hotel voucher against the original email; no voucher has been validated or action prepared.',blockingQuote:false,status:'open'}]);
 expect(drafts.buildReservationistReviewSummary({version:1,readiness:'needs_clarification',tasks:[],sourceRecoveries:[{...recovery,sourceRef:'message:other'}]},now)!.staffActions).toEqual([]);
});

it('retains known scope and reports the task-bound missing checkout rather than a generic warning',()=>{
 const source=requestSource('Please quote a room from 12 October.'),reason='Please confirm the checkout date.';
 const review=summary({tasks:[{id:'quote',kind:'quote',status:'needs_clarification',requestSource:source}],preparedFacts:[{key:'arrival',value:'2026-10-12'}],readRecoveries:[{taskId:'quote',codes:['business_dates_unavailable']}],sourceRecoveries:[{kind:'unresolved_fact',reason,disclosure:'staff_only',provenance:{reason,taskIds:['quote'],sources:[{attachmentId:source.attachmentId,sourceHash:source.sourceHash}]}}]});
 expect(review.staffActions[0]).toMatchObject({kind:'pricing_fact',text:source.quote,reason,blockingQuote:true});
 expect(review.staffActions[0].reason).not.toContain('arrival');
});

it('names a failed business document, suppresses identified signature noise and distinguishes email failure',()=>{
 const recovery={kind:'attachment_manual',reason:'encrypted',sourceRef:'document',sourceHash:'b'.repeat(64),sourceKind:'attachment',messageId:'inbound',disclosure:'staff_only'};
 const review=drafts.buildReservationistReviewSummary({version:1,readiness:'needs_clarification',tasks:[],sourceRecoveries:[recovery,{...recovery,sourceRef:'logo',signatureNoise:true},{...recovery,sourceRef:'message:inbound',sourceHash:'a'.repeat(64),sourceKind:'message',reason:'source_batch_0_unavailable'}]},now,[{sourceRef:'document',filename:'request.pdf',messageId:'inbound'}])!;
 expect(review.staffActions).toHaveLength(2);
 expect(review.staffActions![0]).toMatchObject({kind:'business_document_failure',filename:'request.pdf',text:'request.pdf: This document is password protected.',blockingQuote:false});
 expect(review.staffActions![1]).toMatchObject({sourceKind:'message',text:'Email: Email details could not be extracted.'});
});

it('does not silently ignore an unread unknown image or borrow a filename from another message',()=>{
 const raw={version:1,tasks:[],sourceRecoveries:[{kind:'attachment_manual',sourceRef:'unknown',sourceHash:'b'.repeat(64),sourceKind:'attachment',messageId:'inbound',disclosure:'staff_only',reason:'malformed_or_unsupported_raster'}]};
 const review=drafts.buildReservationistReviewSummary(raw,now,[{sourceRef:'unknown',filename:'other-private.pdf',messageId:'other'}])!;
 expect(review.staffActions).toHaveLength(1);expect(review.staffActions![0].filename).toBeUndefined();
 expect(review.staffActions![0].text).toBe('Attachment: This image could not be read.');
});

it('shows an unread metadata-only attachment without inventing a content hash',()=>{
 const recovery={kind:'attachment_manual',sourceRef:'large',sourceIdentity:'metadata_only',sourceKind:'attachment',messageId:'inbound',disclosure:'staff_only',reason:'attachment_identity_unavailable'};
 const raw={version:1,tasks:[],sourceRecoveries:[recovery]};
 const review=drafts.buildReservationistReviewSummary(raw,now,[{sourceRef:'large',filename:'rooming.xlsx',messageId:'inbound'}])!;
 expect(review.staffActions).toHaveLength(1);
 expect(review.staffActions![0]).toMatchObject({sourceRef:'large',sourceIdentity:'metadata_only',filename:'rooming.xlsx'});
 expect(review.staffActions![0].sourceHash).toBeUndefined();
 expect(drafts.buildReservationistReviewSummary(raw,now,[{sourceRef:'large',filename:'other.xlsx',messageId:'other'}])!.staffActions).toEqual([]);
});

it('does not manufacture actions from generated prose, unbound diagnostics or malformed source identities',()=>{
 const source=requestSource('Is a shuttle available?');
 const review=summary({tasks:[{id:'missing',kind:'question',status:'needs_clarification',guestText:'Please ask about a shuttle.'},{id:'bad',kind:'question',status:'blocked',requestSource:{...source,sourceHash:source.sourceHash+'x'}}],sourceRecoveries:[{kind:'unresolved_fact',reason:'A shuttle may be needed.'},{kind:'attachment_manual',sourceRef:'pdf',reason:'encrypted',sourceKind:'attachment'}]});
 expect(review.staffActions).toEqual([]);
});

it('preserves the plan request clause through runtime instead of accepting execute-stage source text',async()=>{
 const {runReservationistRuntime}=await import('../src/ai/reservationist-runtime.js');
 const {createHash}=await import('node:crypto');
 const text='Is an airport shuttle available?',source={...requestSource(text),sourceHash:createHash('sha256').update(text).digest('hex')};
 const task={id:'shuttle',status:'needs_clarification' as const,guestText:'Staff must verify shuttle availability.',evidenceRefs:['message:inbound'],requestSource:requestSource('Invented request')};
 const input={version:1 as const,requestId:'inbound',propertyCode:'HRCEN',trigger:{id:'inbound',at:now.toISOString()},messages:[{id:'inbound',at:now.toISOString(),direction:'inbound' as const,text}],authorizedArtifacts:[],clock:{causalAt:now.toISOString(),sourceAt:now.toISOString(),deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false as const,emailSend:false as const}};
 const result=await runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'shuttle',kind:'question',required:true,source}],facts:[]}),execute:async()=>({tasks:[task],artifacts:[],quoteRefs:[],packets:[],errors:[],approvedGuestClauses:{shuttle:task.guestText}}),verifyGuestClause:async()=>true});
 expect(result.tasks[0].requestSource).toEqual(source);
 expect(summary({...result,version:1}).staffActions[0].text).toBe(text);
});

it('does not turn an unrelated failed attachment into a completed quote blocker',()=>{
 const recovery={kind:'attachment_manual',sourceRef:'document',sourceHash:'b'.repeat(64),sourceKind:'attachment',messageId:'inbound',disclosure:'staff_only',reason:'parser_failure'};
 const review=summary({tasks:[{id:'good',kind:'quote',status:'complete',requestSource:requestSource('Please quote accommodation.')}],sourceRecoveries:[recovery,recovery]});
 expect(review.staffActions).toHaveLength(1);expect(review.staffActions[0].blockingQuote).toBe(false);
});

it('changes action identity with the selected source and retains long request meaning',()=>{
 const text='Is a shuttle available '+ 'for every requested arrival '.repeat(30)+'including the late arrival?';
 const first=summary({tasks:[{id:'ask',kind:'question',status:'blocked',requestSource:requestSource(text)}]}).staffActions[0];
 const second=summary({tasks:[{id:'ask',kind:'question',status:'blocked',requestSource:requestSource(text,'message:other')}]}).staffActions[0];
 expect(first.text).toBe(text);expect(first.text).toContain('including the late arrival?');expect(second.id).not.toBe(first.id);
});
