import {afterEach,expect,it,vi} from 'vitest';
import {sealReservationistDraftSource,assertReservationistDraftSource,assertChannelPacketDraftSource,assertCancellationPacketDraftSource,assertMetadataSourceRecoveries,assertArrivalDraftSources,deriveArrivalDraftSources,draftSourceMessage,reservationistDraftPropertyCode} from '../src/ai/reservationist-draft-source.js';
import {prepareReservationistChannelBookingSync,prepareReservationistPendingAction} from '../src/ai/reservationist-pending-action.js';
import {validateDocumentPlan} from '../src/ai/reservationist-document-facts.js';
import {createHash} from 'node:crypto';
import {renderReservationistMessage} from '../src/ai/reservationist-worker-input.js';
import {deriveOperationalDraftSources,operationalDraftMessages} from '../src/ai/reservationist-operational-draft-source.js';
import {validateReservationistMailAnswers} from '../src/ai/reservationist-mail-answer-source.js';
const source={version:1 as const,runId:'run',generationId:'generation',transportId:'owner',propertyCode:'HRCEN',threadId:'thread',requestedByUserId:'user',triggerMessageId:'trigger',causalAt:'2026-10-05T01:00:00.000Z',resultDigest:'e'.repeat(64),messages:[{id:'trigger',at:'2026-10-05T01:00:00.000Z',direction:'inbound' as const,sourceHash:'a'.repeat(64),identityHash:'b'.repeat(64)}],attachments:[]};
it('accepts the runtime requestSource on an arrival acknowledgement during draft review',()=>{
 const text='I will like to check in by 3:00pm.',at=source.causalAt,requestSource={attachmentId:'message:trigger',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length},input={version:1 as const,requestId:'trigger',propertyCode:'HRCEN',trigger:{id:'trigger',at},messages:[{id:'trigger',at,direction:'inbound' as const,text,disclosure:'guest' as const}],authorizationScope:{ownerRef:'owner',threadId:'thread'},authorizedArtifacts:[],clock:{causalAt:at,sourceAt:at,sourceMode:'current_read' as const,deadlineAt:Date.now()+30_000},capabilities:{pmsWrite:false as const,emailSend:false as const}},proofs=deriveArrivalDraftSources({tasks:[{id:'arrival',kind:'question',required:true,source:requestSource}],facts:[]},input),proof=proofs[0]!;
 const result={tasks:[{id:'arrival',status:'complete',guestText:'We have noted your request to check in by 3:00pm. Staff must verify the requested arrival time.',evidenceRefs:[proof.receipt.source.sourceRef],disclosure:'guest',kind:'question',required:true,requestSource}],preparedFacts:[{key:'requested_arrival_time_arrival',label:'Customer requested arrival time',value:{requestedTime:'3:00pm',authority:'customer_claim',hotelPermission:'unverified'},source:'inbound',authority:'authorized',status:'known',evidenceRef:proof.receipt.source.sourceRef,sourceHash:proof.receipt.source.sourceHash,scopeVerified:true,disclosure:'guest'}]} as any;
 const live={...source,transportId:'owner',propertyCode:'HRCEN',threadId:'thread',triggerMessageId:'trigger',causalAt:at,messages:[{...source.messages[0]!,at,direction:'inbound' as const,sourceHash:requestSource.sourceHash}],arrivalAcknowledgements:proofs};
 expect(proofs).toHaveLength(1);
 expect(()=>assertArrivalDraftSources(result,live as any,input.messages as any)).not.toThrow();
});
it('accepts the runtime requestSource on an operational mail answer during draft review',()=>{
 const priorAt=new Date('2026-10-05T00:30:00.000Z'),triggerAt=new Date(source.causalAt),addresses={transportId:'owner',threadId:'thread',subject:null,ccAddresses:[],bccAddresses:[]},trigger={...addresses,id:'trigger',direction:'inbound',receivedAt:triggerAt,sentAt:null,textBody:'Is parking available?',htmlBody:null,fromAddress:'guest@example.invalid',toAddresses:['hotel@example.invalid']},reply={...addresses,id:'reply',direction:'outbound',receivedAt:priorAt,sentAt:priorAt,textBody:'Parking is available.',htmlBody:null,fromAddress:'hotel@example.invalid',toAddresses:['guest@example.invalid']},binding={requestId:'trigger',ownerRef:'owner',threadId:'thread',propertyCode:'HRCEN' as const,triggerMessageId:'trigger',causalAt:source.causalAt},messages=operationalDraftMessages([reply,trigger],binding),ask=messages.find(message=>message.id==='trigger')!,answer=messages.find(message=>message.id==='reply')!,requestSource={attachmentId:'message:trigger',sourceHash:createHash('sha256').update(ask.text).digest('hex'),page:1,start:0,end:ask.text.length,quote:ask.text},answerHash=createHash('sha256').update(answer.text).digest('hex'),result={tasks:[{id:'parking',status:'complete',guestText:'Parking is available.',evidenceRefs:['message:reply'],disclosure:'guest',kind:'question',required:true,requestSource}],preparedFacts:[{key:'parking_parking',label:'parking',value:true,source:'mail',authority:'authorized',status:'known',evidenceRef:'message:reply',sourceHash:answerHash,scopeVerified:true,disclosure:'guest'}]} as any;
 expect(deriveOperationalDraftSources({tasks:[{id:'parking',kind:'question',required:true,source:requestSource}],facts:[]},result,binding,[reply,trigger],new AbortController().signal)).toHaveLength(1);
});
it('seals exact bounded source scope and accepts only its unchanged live contract',()=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,source)).not.toThrow();});
it('rejects oversized changed source bodies before rendering',()=>{
 expect(()=>renderReservationistMessage({textBody:null,htmlBody:'x'.repeat(2_000_001)})).toThrow('worker_intake_context_limit');
});
it('uses trusted mailbox arrival and binds both email body alternatives',()=>{
 const row={id:'trigger',direction:'inbound',arrivedAt:new Date('2026-10-05T01:00:00.000Z'),receivedAt:new Date('2026-10-01T01:00:00.000Z'),sentAt:null,textBody:'Please quote.',htmlBody:'<p>Please quote.</p>',subject:null,fromAddress:'guest@example.invalid',toAddresses:['hotel@example.invalid'],ccAddresses:[],bccAddresses:[]};
 const original=draftSourceMessage(row),changed=draftSourceMessage({...row,htmlBody:'<p>Different dates.</p>'});
 expect(original.at).toBe(row.arrivedAt.toISOString());expect(original.sourceHash).toBe(createHash('sha256').update(renderReservationistMessage(row).text).digest('hex'));expect(changed.sourceHash).not.toBe(original.sourceHash);expect(changed.identityHash).not.toBe(original.identityHash);
 const live=operationalDraftMessages([{...row,transportId:'owner',threadId:'thread'}],{requestId:'trigger',ownerRef:'owner',threadId:'thread',propertyCode:'HRCEN',triggerMessageId:'trigger',causalAt:row.arrivedAt.toISOString()});
 expect(live[0]?.text).toBe(renderReservationistMessage(row).text);expect(live[0]?.at).toBe(original.at);
 const fallback={...row,arrivedAt:null,createdAt:new Date('2026-10-05T02:00:00.000Z')};expect(draftSourceMessage(fallback).at).toBe(fallback.createdAt.toISOString());
 const outbound={...row,transportId:'owner',threadId:'thread',direction:'outbound',arrivedAt:new Date('2026-10-05T00:00:00.000Z')};
 const imported={...outbound,id:'imported',pop3Uidl:'before',sentAt:null};
 const rows=[{...row,transportId:'owner',threadId:'thread'},{...outbound,id:'unsent',sentAt:null},{...outbound,id:'late',sentAt:new Date('2026-10-05T02:00:00.000Z')},{...outbound,id:'sent',sentAt:new Date('2026-10-05T00:30:00.000Z')},imported,{...imported,id:'backdated',arrivedAt:new Date('2026-10-05T02:00:00.000Z'),sentAt:new Date('2026-10-05T00:30:00.000Z')},{...imported,id:'returned-native',createdAt:new Date('2026-10-05T00:00:00.000Z'),sentAt:new Date('2026-10-05T02:00:00.000Z')}];
 expect(operationalDraftMessages(rows,{requestId:'trigger',ownerRef:'owner',threadId:'thread',propertyCode:'HRCEN',triggerMessageId:'trigger',causalAt:row.arrivedAt.toISOString()}).map(m=>m.id)).toEqual(['trigger','sent','imported']);
 expect(draftSourceMessage(imported).at).toBe(imported.arrivedAt.toISOString());
});
it('retains equivalent wrapped answers across MIME views, but rejects a conflicting view',()=>{
 const at=new Date('2026-10-05T01:00:00.000Z'),sent=new Date('2026-10-04T01:00:00.000Z');
 const addresses={transportId:'owner',threadId:'thread',subject:null,ccAddresses:[],bccAddresses:[]};
 const trigger={...addresses,id:'trigger',direction:'inbound',arrivedAt:at,createdAt:at,receivedAt:at,sentAt:null,textBody:'When is check-in?',htmlBody:null,fromAddress:'guest@example.invalid',toAddresses:['hotel@example.invalid']};
 const prior={...addresses,id:'reply',direction:'outbound',arrivedAt:sent,createdAt:sent,receivedAt:sent,sentAt:sent,textBody:'Check-in time is\n14:00.',htmlBody:'<p>Check-in time is 14:00.</p>',fromAddress:'hotel@example.invalid',toAddresses:['guest@example.invalid']};
 const binding={requestId:'trigger',ownerRef:'owner',threadId:'thread',propertyCode:'HRCEN' as const,triggerMessageId:'trigger',causalAt:at.toISOString()};
 for(const reply of [prior,{...prior,textBody:'Check-in time is 14:00.',htmlBody:'<p>Check-in time is<br>14:00.</p>'}]){
  const messages=operationalDraftMessages([reply,trigger],binding),request=messages.find(m=>m.id==='trigger')!,answer=messages.find(m=>m.id==='reply')!;
  const source={attachmentId:'message:trigger',sourceHash:createHash('sha256').update(request.text).digest('hex'),page:1,start:0,end:request.text.length,quote:request.text};
  const sourceHash=createHash('sha256').update(answer.text).digest('hex'),result={tasks:[{id:'check-in',status:'complete',guestText:'Check-in time is 14:00.',evidenceRefs:['message:reply'],disclosure:'guest',kind:'question',required:true,requestSource:source}],preparedFacts:[{key:'check_in_check-in',label:'check_in',value:'14:00',source:'mail',authority:'authorized',status:'known',evidenceRef:'message:reply',sourceHash,scopeVerified:true,disclosure:'guest'}]} as any;
  expect(deriveOperationalDraftSources({tasks:[{id:'check-in',kind:'question',required:true,source}],facts:[]},result,binding,[reply,trigger],new AbortController().signal)).toHaveLength(1);
  const conflict={...reply,htmlBody:'<p>Check-in time is 15:00.</p>'};
  const conflictText=operationalDraftMessages([conflict,trigger],binding).find(m=>m.id==='reply')!.text;
  const conflictResult={...result,preparedFacts:[{...result.preparedFacts[0],sourceHash:createHash('sha256').update(conflictText).digest('hex')}]};
  expect(deriveOperationalDraftSources({tasks:[{id:'check-in',kind:'question',required:true,source}],facts:[]},conflictResult,binding,[conflict,trigger],new AbortController().signal)).toHaveLength(0);
 }
});
it('proves the same parking answer in both MIME alternatives but rejects a conflict',()=>{
 const at=new Date('2026-10-05T01:00:00.000Z'),sent=new Date('2026-10-04T01:00:00.000Z');
 const addresses={transportId:'owner',threadId:'thread',subject:null,ccAddresses:[],bccAddresses:[]};
 const trigger={...addresses,id:'trigger',direction:'inbound',arrivedAt:at,createdAt:at,receivedAt:at,sentAt:null,textBody:'Is parking available?',htmlBody:null,fromAddress:'guest@example.invalid',toAddresses:['hotel@example.invalid']};
 const prior={...addresses,id:'reply',direction:'outbound',arrivedAt:sent,createdAt:sent,receivedAt:sent,sentAt:sent,textBody:'Parking is available',htmlBody:'<p>Parking is available.</p>',fromAddress:'hotel@example.invalid',toAddresses:['guest@example.invalid']};
 const binding={requestId:'trigger',ownerRef:'owner',threadId:'thread',propertyCode:'HRCEN' as const,triggerMessageId:'trigger',causalAt:at.toISOString()};
 const messages=operationalDraftMessages([prior,trigger],binding),reply=messages.find(m=>m.id==='reply')!,request=messages.find(m=>m.id==='trigger')!;
 const sourceHash=createHash('sha256').update(reply.text).digest('hex'),quote='Parking is available',start=reply.text.indexOf(quote);
 const answer={kind:'parking' as const,value:true,messageId:'reply',sourceHash,start,end:start+quote.length,quote,disclosure:'guest' as const};
 const input={version:1 as const,requestId:'trigger',propertyCode:'HRCEN',trigger:{id:'trigger',at:at.toISOString()},messages,authorizationScope:{ownerRef:'owner',threadId:'thread'},authorizedArtifacts:[],clock:{causalAt:at.toISOString(),sourceAt:at.toISOString(),deadlineAt:Date.now()+10000},capabilities:{pmsWrite:false as const,emailSend:false as const}};
 expect(()=>validateReservationistMailAnswers([answer],input)).not.toThrow();
 const requestSource={attachmentId:'message:trigger',sourceHash:createHash('sha256').update(request.text).digest('hex'),page:1,start:0,end:request.text.length,quote:request.text};
 const result={tasks:[{id:'parking',status:'complete',guestText:'Parking is available.',evidenceRefs:['message:reply'],disclosure:'guest',kind:'question',required:true,requestSource}],preparedFacts:[{key:'parking_parking',label:'parking',value:true,source:'mail',authority:'authorized',status:'known',evidenceRef:'message:reply',sourceHash,scopeVerified:true,disclosure:'guest'}]} as any;
 expect(deriveOperationalDraftSources({tasks:[{id:'parking',kind:'question',required:true,source:requestSource}],facts:[]},result,binding,[prior,trigger],new AbortController().signal)).toHaveLength(1);
 const conflict=operationalDraftMessages([{...prior,htmlBody:'<p>Parking is not available.</p>'},trigger],binding);
 const changed=conflict.find(m=>m.id==='reply')!;
 expect(()=>validateReservationistMailAnswers([{...answer,sourceHash:createHash('sha256').update(changed.text).digest('hex')}],{...input,messages:conflict})).toThrow('local_answer_source_invalid');
 for(const htmlBody of ['<p>Parking is available.</p><p>Parking is unavailable.</p>','<p>Parking is available.</p><p>It is unavailable.</p>']){
  const conflictingRows=[{...prior,htmlBody},trigger],conflicting=operationalDraftMessages(conflictingRows,binding),message=conflicting.find(m=>m.id==='reply')!;
  const hash=createHash('sha256').update(message.text).digest('hex');
  expect(()=>validateReservationistMailAnswers([{...answer,sourceHash:hash}],{...input,messages:conflicting})).toThrow('local_answer_source_invalid');
  const changedResult={...result,preparedFacts:[{...result.preparedFacts[0],sourceHash:hash}]};
  expect(deriveOperationalDraftSources({tasks:[{id:'parking',kind:'question',required:true,source:requestSource}],facts:[]},changedResult,binding,conflictingRows,new AbortController().signal)).toHaveLength(0);
 }
});
it.each(['transportId','threadId','requestedByUserId','triggerMessageId'] as const)('rejects foreign %s',key=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,{...source,[key]:'foreign'})).toThrow();});
it('rejects changed text, incomplete and malformed source snapshots',()=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,{...source,messages:[{...source.messages[0]!,sourceHash:'c'.repeat(64)}]})).toThrow();for(const value of [null,{version:1}, {...receipt,extra:true},{...receipt,digest:'0'.repeat(64)}])expect(()=>assertReservationistDraftSource(value,source)).toThrow();});
it('rejects noncausal messages, missing trigger and unknown attachment ownership',()=>{expect(()=>sealReservationistDraftSource({...source,messages:[{...source.messages[0]!,at:'2026-10-06T01:00:00.000Z'}]})).toThrow();expect(()=>sealReservationistDraftSource({...source,messages:[]})).toThrow();expect(()=>sealReservationistDraftSource({...source,attachments:[{attachmentId:'a',messageId:'foreign',s3Key:'attachments/foreign/a',mimeType:'application/pdf',sizeBytes:10,sourceHash:'d'.repeat(64),inline:false}]})).toThrow();});

it('retains more than eight original descriptors but denies an oversized aggregate',()=>{const attachments=Array.from({length:12},(_,i)=>({attachmentId:'a'+i,messageId:'trigger',s3Key:'attachments/trigger/'+i,mimeType:'image/png',sizeBytes:10,sourceHash:'d'.repeat(64),inline:true}));expect(()=>sealReservationistDraftSource({...source,attachments})).not.toThrow();expect(()=>sealReservationistDraftSource({...source,attachments:attachments.map(a=>({...a,sizeBytes:2*1024*1024}))})).toThrow();});

it('seals an unread oversized file by metadata without claiming a content hash',()=>{
 const file={attachmentId:'large',messageId:'trigger',s3Key:'attachments/trigger/large',mimeType:'application/pdf',sizeBytes:21*1024*1024,inline:false,contentId:null,sourceIdentity:'metadata_only' as const},current={...source,attachments:[file]},sealed=sealReservationistDraftSource(current);
 expect(sealed.attachments[0]?.sourceHash).toBeUndefined();expect(()=>assertReservationistDraftSource(sealed,current)).not.toThrow();
 expect(()=>assertReservationistDraftSource(sealed,{...current,attachments:[{...file,contentId:'changed'}]})).toThrow();
 expect(()=>sealReservationistDraftSource({...current,attachments:[{...file,sourceHash:'d'.repeat(64)}]})).toThrow();
});

it('requires a visible staff-only recovery for each metadata-only source',()=>{
 const file={attachmentId:'large',messageId:'trigger',s3Key:'attachments/trigger/large',mimeType:'application/pdf',sizeBytes:21*1024*1024,inline:false,contentId:null,sourceIdentity:'metadata_only' as const},current={...source,attachments:[file]};
 const recovery={kind:'attachment_manual' as const,reason:'too_large',sourceRef:'large',messageId:'trigger',sourceKind:'attachment' as const,sourceIdentity:'metadata_only' as const,disclosure:'staff_only' as const};
 const result={version:1 as const,readiness:'needs_clarification',tasks:[],quoteRevisionIds:[],artifactRefs:[],actionDigest:'a'.repeat(64),sourceRecoveries:[recovery]};
 expect(()=>assertMetadataSourceRecoveries(current,result)).not.toThrow();
 for(const changed of [{...result,sourceRecoveries:[]},{...result,readiness:'no_action'},{...result,sourceRecoveries:[{...recovery,messageId:'other'}]},{...result,sourceRecoveries:[{...recovery,signatureNoise:true}]}])expect(()=>assertMetadataSourceRecoveries(current,changed)).toThrow();
});

it('binds a genuine canonical channel receipt to the exact original draft source scope',()=>{
 const text='Please ensure you UPDATE your system. Booking reference CH-123. Arrival 2026-10-12 departure 2026-10-14. Room A: quantity 1, 2 adults, 0 children. Guest Jane Smith room A.',sourceHash=createHash('sha256').update(text).digest('hex'),at=source.causalAt,document={attachmentId:'message:trigger',sourceHash,disclosure:'guest' as const,pages:[text],pageCount:1,observedAt:at};
 const span=(quote:string)=>({attachmentId:document.attachmentId,sourceHash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
 const facts=validateDocumentPlan({facts:[{id:'ref',kind:'reservation_reference',value:'CH-123',disclosure:'guest',source:span('Booking reference CH-123.')},{id:'dates',kind:'dates',value:{arrival:'2026-10-12',departure:'2026-10-14'},disclosure:'guest',source:span('Arrival 2026-10-12 departure 2026-10-14.')},{id:'room',kind:'room',value:{roomRef:'A',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:span('Room A: quantity 1, 2 adults, 0 children.')},{id:'guest',kind:'guest',value:{firstName:'Jane',lastName:'Smith',roomRef:'A'},disclosure:'guest',source:span('Guest Jane Smith room A.')}],tasks:[],unresolvedAsks:[]},[document]).facts;
 const packet=prepareReservationistChannelBookingSync({taskId:'sync',requestId:'trigger',propertyCode:'HRCEN',ownerRef:'owner',threadId:'thread',taskSource:span('Please ensure you UPDATE your system.'),facts,sources:[document],clock:{causalAt:at,sourceAt:at,sourceMode:'current_read'}}),bound={...source,messages:[{...source.messages[0]!,sourceHash}]};
 expect(packet.status).toBe('pending_pms_action');expect(()=>assertChannelPacketDraftSource(packet,bound,new Date(at))).not.toThrow();
 for(const changed of [{...bound,propertyCode:'FOREIGN'},{...bound,transportId:'foreign'},{...bound,threadId:'foreign'},{...bound,triggerMessageId:'foreign'},{...bound,causalAt:'2026-10-05T01:01:00.000Z'},{...bound,messages:[{...bound.messages[0]!,sourceHash:'c'.repeat(64)}]}])expect(()=>assertChannelPacketDraftSource(packet,changed,new Date(at))).toThrow();
});
it('binds review-only cancellation preflight to the exact inbound draft source',async()=>{
 const at=source.causalAt,review={outcome:'prepared_for_human_review' as const,roomScope:{state:'unresolved' as const,complete:false as const},policy:{state:'unknown' as const},fee:{state:'unknown_precommit' as const,amount:null,currency:null},action:{actor:'human' as const,cancellationStarted:false as const,commitAvailable:false as const}},input={kind:'cancel_request' as const,taskId:'cancel',requestId:source.triggerMessageId,ownerRef:source.transportId,threadId:source.threadId,propertyCode:source.propertyCode,reservationRef:'ABC123',clock:{causalAt:at,sourceAt:at,sourceMode:'current_read' as const}},evidence={...input,authorizationId:'synthetic-auth',resolvedConfirmation:'ABC123',sourceRef:'hms-record:synthetic',sourceHash:'c'.repeat(64),observedAt:at,expiresAt:'2026-10-05T02:00:00.000Z',maxSourceAgeMs:3600000,current:{arrivalDate:'2026-10-12',departureDate:'2026-10-14'},requestSource:{taskId:input.taskId,sourceRef:`message:${source.triggerMessageId}`,sourceHash:source.messages[0]!.sourceHash,observedAt:at},cancellationReview:review};
 const packet=await prepareReservationistPendingAction(input,{signal:new AbortController().signal,resolveEvidence:async()=>evidence,authorizeSource:async()=>true});
 expect(packet.status).toBe('pending_pms_action');expect(packet.businessRulesValidated).toBe(false);expect(()=>assertCancellationPacketDraftSource(packet,source)).not.toThrow();
 expect(()=>assertCancellationPacketDraftSource(packet,{...source,transportId:'foreign'})).toThrow();
});

afterEach(()=>{vi.unstubAllEnvs();});

it('resolves registered draft properties and refuses unknown transports',()=>{
 const ready={HMS_DAVINCI_MAKE_QUOTE:'on',RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV:'/tmp/hrdav-quote.json'};
 expect(()=>reservationistDraftPropertyCode('owner')).toThrow();
 expect(reservationistDraftPropertyCode('transport-centurion')).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-davinci')).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-faith',{HMS_DAVINCI_MAKE_QUOTE:'true'})).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-davinci',ready)).toBe('HRDAV');
 expect(reservationistDraftPropertyCode('transport-kmgidi',ready)).toBe('HRDAV');
 expect(reservationistDraftPropertyCode('transport-centurion',{HMS_DAVINCI_MAKE_QUOTE:'on'})).toBe('HRCEN');
 expect(()=>sealReservationistDraftSource({...source,transportId:'transport-davinci',propertyCode:'HRDAV'})).not.toThrow();
});
