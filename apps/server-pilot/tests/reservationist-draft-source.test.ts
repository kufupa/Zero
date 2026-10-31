import {afterEach,expect,it,vi} from 'vitest';
import {sealReservationistDraftSource,assertReservationistDraftSource,assertChannelPacketDraftSource,assertCancellationPacketDraftSource,reservationistDraftPropertyCode} from '../src/ai/reservationist-draft-source.js';
import {prepareReservationistChannelBookingSync,prepareReservationistPendingAction} from '../src/ai/reservationist-pending-action.js';
import {validateDocumentPlan} from '../src/ai/reservationist-document-facts.js';
import {createHash} from 'node:crypto';
const source={version:1 as const,runId:'run',generationId:'generation',transportId:'owner',propertyCode:'HRCEN',threadId:'thread',requestedByUserId:'user',triggerMessageId:'trigger',causalAt:'2026-10-05T01:00:00.000Z',resultDigest:'e'.repeat(64),messages:[{id:'trigger',at:'2026-10-05T01:00:00.000Z',direction:'inbound' as const,sourceHash:'a'.repeat(64),identityHash:'b'.repeat(64)}],attachments:[]};
it('seals exact bounded source scope and accepts only its unchanged live contract',()=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,source)).not.toThrow();});
it.each(['transportId','threadId','requestedByUserId','triggerMessageId'] as const)('rejects foreign %s',key=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,{...source,[key]:'foreign'})).toThrow();});
it('rejects changed text, incomplete and malformed source snapshots',()=>{const receipt=sealReservationistDraftSource(source);expect(()=>assertReservationistDraftSource(receipt,{...source,messages:[{...source.messages[0]!,sourceHash:'c'.repeat(64)}]})).toThrow();for(const value of [null,{version:1}, {...receipt,extra:true},{...receipt,digest:'0'.repeat(64)}])expect(()=>assertReservationistDraftSource(value,source)).toThrow();});
it('rejects noncausal messages, missing trigger and unknown attachment ownership',()=>{expect(()=>sealReservationistDraftSource({...source,messages:[{...source.messages[0]!,at:'2026-10-06T01:00:00.000Z'}]})).toThrow();expect(()=>sealReservationistDraftSource({...source,messages:[]})).toThrow();expect(()=>sealReservationistDraftSource({...source,attachments:[{attachmentId:'a',messageId:'foreign',s3Key:'attachments/foreign/a',mimeType:'application/pdf',sizeBytes:10,sourceHash:'d'.repeat(64),inline:false}]})).toThrow();});

it('retains more than eight original descriptors but denies an oversized aggregate',()=>{const attachments=Array.from({length:12},(_,i)=>({attachmentId:'a'+i,messageId:'trigger',s3Key:'attachments/trigger/'+i,mimeType:'image/png',sizeBytes:10,sourceHash:'d'.repeat(64),inline:true}));expect(()=>sealReservationistDraftSource({...source,attachments})).not.toThrow();expect(()=>sealReservationistDraftSource({...source,attachments:attachments.map(a=>({...a,sizeBytes:2*1024*1024}))})).toThrow();});

it('binds a genuine canonical channel receipt to the exact original draft source scope',()=>{
 const text='Please ensure you UPDATE your system. Booking reference CH-123. Arrival 2026-10-12 departure 2026-10-14. Room A: quantity 1, 2 adults, 0 children. Guest Jane Smith room A.',sourceHash=createHash('sha256').update(text).digest('hex'),at=source.causalAt,document={attachmentId:'message:trigger',sourceHash,disclosure:'guest' as const,pages:[text],pageCount:1,observedAt:at};
 const span=(quote:string)=>({attachmentId:document.attachmentId,sourceHash,page:1,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length});
 const facts=validateDocumentPlan({facts:[{id:'ref',kind:'reservation_reference',value:'CH-123',disclosure:'guest',source:span('Booking reference CH-123.')},{id:'dates',kind:'dates',value:{arrival:'2026-10-12',departure:'2026-10-14'},disclosure:'guest',source:span('Arrival 2026-10-12 departure 2026-10-14.')},{id:'room',kind:'room',value:{roomRef:'A',quantity:1,adults:2,childAges:[]},disclosure:'guest',source:span('Room A: quantity 1, 2 adults, 0 children.')},{id:'guest',kind:'guest',value:{firstName:'Jane',lastName:'Smith',roomRef:'A'},disclosure:'guest',source:span('Guest Jane Smith room A.')}],tasks:[],unresolvedAsks:[]},[document]).facts;
 const packet=prepareReservationistChannelBookingSync({taskId:'sync',requestId:'trigger',propertyCode:'HRCEN',ownerRef:'owner',threadId:'thread',taskSource:span('Please ensure you UPDATE your system.'),facts,sources:[document],clock:{causalAt:at,sourceAt:at,sourceMode:'current_read'}}),bound={...source,messages:[{...source.messages[0]!,sourceHash}]};
 expect(packet.status).toBe('pending_pms_action');expect(()=>assertChannelPacketDraftSource(packet,bound,new Date(at))).not.toThrow();
 for(const changed of [{...bound,propertyCode:'FOREIGN'},{...bound,transportId:'foreign'},{...bound,threadId:'foreign'},{...bound,triggerMessageId:'foreign'},{...bound,causalAt:'2026-10-05T01:01:00.000Z'},{...bound,messages:[{...bound.messages[0]!,sourceHash:'c'.repeat(64)}]}])expect(()=>assertChannelPacketDraftSource(packet,changed,new Date(at))).toThrow();
});
it('binds review-only cancellation preflight to the exact inbound draft source',async()=>{
 const at=source.causalAt,review={outcome:'prepared_for_human_review' as const,roomScope:{state:'unresolved' as const,complete:false as const},policy:{state:'unknown' as const},fee:{state:'unknown_precommit' as const,amount:null,currency:null},action:{actor:'human' as const,cancellationStarted:false as const,commitAvailable:false as const}},input={kind:'cancel_request' as const,taskId:'cancel',requestId:source.triggerMessageId,ownerRef:source.transportId,threadId:source.threadId,propertyCode:source.propertyCode,reservationRef:'ABC123',clock:{causalAt:at,sourceAt:at,sourceMode:'current_read' as const}},evidence={...input,authorizationId:'synthetic-auth',sourceRef:'hms-record:synthetic',sourceHash:'c'.repeat(64),observedAt:at,expiresAt:'2026-10-05T02:00:00.000Z',maxSourceAgeMs:3600000,current:{arrivalDate:'2026-10-12',departureDate:'2026-10-14'},requestSource:{taskId:input.taskId,sourceRef:`message:${source.triggerMessageId}`,sourceHash:source.messages[0]!.sourceHash,observedAt:at},cancellationReview:review};
 const packet=await prepareReservationistPendingAction(input,{signal:new AbortController().signal,resolveEvidence:async()=>evidence,authorizeSource:async()=>true});
 expect(packet.status).toBe('pending_pms_action');expect(packet.businessRulesValidated).toBe(false);expect(()=>assertCancellationPacketDraftSource(packet,source)).not.toThrow();
 expect(()=>assertCancellationPacketDraftSource(packet,{...source,transportId:'foreign'})).toThrow();
});

afterEach(()=>{vi.unstubAllEnvs();});

it('resolves draft property HRDAV only for Da Vinci transports when HMS_DAVINCI_MAKE_QUOTE is on',()=>{
 expect(reservationistDraftPropertyCode('owner')).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-centurion')).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-davinci')).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-faith',{HMS_DAVINCI_MAKE_QUOTE:'true'})).toBe('HRCEN');
 expect(reservationistDraftPropertyCode('transport-davinci',{HMS_DAVINCI_MAKE_QUOTE:'on'})).toBe('HRDAV');
 expect(reservationistDraftPropertyCode('transport-kmgidi',{HMS_DAVINCI_MAKE_QUOTE:'on'})).toBe('HRDAV');
 expect(reservationistDraftPropertyCode('transport-centurion',{HMS_DAVINCI_MAKE_QUOTE:'on'})).toBe('HRCEN');
 expect(()=>sealReservationistDraftSource({...source,transportId:'transport-davinci',propertyCode:'HRDAV'})).not.toThrow();
});
