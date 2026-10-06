import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {quoteDigest,type ImportedOfferSource} from '../src/quote-proposal/quote-revision.js';
import {createReservationistBusinessServices} from '../src/ai/reservationist-business-services.js';
import type {ReservationistExecutionServices,SourceOfferAttestation} from '../src/ai/reservationist-execution.js';
import type {AttachmentAdmission} from '../src/ai/reservationist-attachment-input.js';
import type {BookingSourceProof} from '../src/ai/reservationist-booking-packet.js';
import {prepareBookingPacket} from '../src/ai/reservationist-booking-packet.js';
import {syntheticRevision} from './helpers/synthetic-quote-revision.js';
const sha=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
type Context=Parameters<NonNullable<ReservationistExecutionServices['resolveBookingTask']>>[0];
async function fixture(){
 const original=await syntheticRevision(['100.00','150.00']),{id,...revisionData}=structuredClone(original);
 revisionData.groups[0].inclusions.restrictions={status:'supported',sourceRefs:['original-restrictions']};
 const revision={...revisionData,id:`quote:${quoteDigest(revisionData)}`};
 const text='Please book the rooms as allocated in the original quotation.',at='2026-10-05T10:00:00Z',source={attachmentId:'message:m',sourceHash:sha(text),page:1,start:0,end:text.length,quote:text};
 const ctx:Context={task:{id:'accept',kind:'acceptance',factIds:[],source},facts:[],input:{version:1,requestId:'request',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'m',at},messages:[{id:'m',at,direction:'inbound',text}],authorizedArtifacts:[],clock:{causalAt:at,sourceAt:at,sourceMode:'current_read',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}},signal:new AbortController().signal};
 const bytes=Buffer.from('%PDF-synthetic-original-offer'),hash=sha(bytes),page='Printed 2026-10-04. Valid until 2026-10-07. 2 rooms 2 nights total ZAR 500.00. Original quotation terms.';
 const document:AttachmentAdmission={status:'admitted',reason:'text',metadata:{attachmentId:'original-pdf',messageId:'original-message',ownerRef:'owner',threadId:'thread',messageAt:'2026-10-04T10:00:00Z',mimeType:'application/pdf',sizeBytes:bytes.length,sourceHash:hash,disclosure:'guest'},source:{attachmentId:'original-pdf',sourceHash:hash,disclosure:'guest',pageCount:1,pages:[page]},bytes:{body:bytes,sha256:hash,contentType:'application/pdf',locator:{s3Key:'attachments/original-message/original.pdf',messageId:'original-message',mimeType:'application/pdf',sizeBytes:bytes.length}},draftReady:false};
 const originalOffer:ImportedOfferSource={ref:'original-pdf',sourceHash:hash,authorizationId:revision.authorizationId,scopeDigest:revision.scopeDigest,propertyCode:revision.propertyCode,currency:revision.currency,printedDate:revision.authoredDate,sentAt:document.metadata.messageAt,validUntil:'2026-10-07',terms:'Original quotation terms.',lines:[{id:'line',page:1,quote:'2 rooms 2 nights total ZAR 500.00.',amount:'500.00'}]};
 const attestation:SourceOfferAttestation&{originalRevisionDigest:string;acceptanceSourceDigest:string}={sourceDigest:quoteDigest(originalOffer),originalRevisionDigest:quoteDigest(revision),acceptanceSourceDigest:quoteDigest(source),requestId:ctx.input.requestId,ownerRef:'owner',threadId:'thread',scopeDigest:revision.scopeDigest,evaluatedAt:at,factAttestation:{factDigests:{}}};
 const sentProof={revisionId:revision.id,authorizationId:revision.authorizationId,sentAt:originalOffer.sentAt,sourceRef:originalOffer.ref,sourceHash:hash};
 const authorized=vi.fn(async(_proof:BookingSourceProof,_signal:AbortSignal)=>true);
 const accepted={document,originalOffer,revision,sentProof,attestation,authorizeSource:authorized};
 ctx.input.messages.unshift({id:document.metadata.messageId,at:document.metadata.messageAt,direction:'outbound',text:'Original quotation attached.'});ctx.input.authorizedArtifacts=[{attachmentId:document.metadata.attachmentId,sourceHash:hash}];
 ctx.facts=[{id:'guest1',kind:'guest',value:{firstName:'Alex',lastName:'Example',roomRef:'g1',roomIndex:1},source:{attachmentId:'original-guests',sourceHash:'b'.repeat(64),page:1,quote:'Alex Example'},disclosure:'guest',verification:'text_verified',authority:'customer_claim'},{id:'guest2',kind:'guest',value:{firstName:'Taylor',lastName:'Example',roomRef:'g1',roomIndex:2},source:{attachmentId:'original-guests',sourceHash:'b'.repeat(64),page:1,quote:'Taylor Example'},disclosure:'guest',verification:'text_verified',authority:'customer_claim'}];
 attestation.factAttestation={factDigests:Object.fromEntries(ctx.facts.map(f=>[f.id,quoteDigest(f)]))};
 const proof:BookingSourceProof={sourceRef:'current-native',sourceHash:'b'.repeat(64),authorizationId:revision.authorizationId,propertyCode:revision.propertyCode,scopeDigest:revision.scopeDigest,observedAt:at,expiresAt:'2026-10-05T11:00:00Z',maxSourceAgeMs:3600000};
 const readQuote=vi.fn(async()=>{throw new Error('Current repricing forbidden');});
 const readBookingPrerequisites=vi.fn(async()=>({availability:{...proof,available:true},duplicates:{...proof,matches:[]},codes:{...proof,roomTypes:['SKNG'],ratePlans:['BAR'],sources:['E-Mail'],tracks:['BAR'],guarantees:['Non-Guaranteed Individual'],eligibility:[{groupId:'g1',roomCode:'SKNG',rateCode:'BAR',board:'room_only',dates:['2026-10-12','2026-10-13'],adults:1,childAges:[],context:{}}]},authorizedFields:{...proof,sourceOfBusiness:'E-Mail',track:'BAR',guaranteeType:'Non-Guaranteed Individual'},partyFacts:[],guestFacts:[{...proof,sourceRef:'original-guests',observedAt:'2026-10-04T10:00:00Z',factRef:'guest1',groupId:'g1',roomIndex:1,firstName:'Alex',lastName:'Example'},{...proof,sourceRef:'original-guests',observedAt:'2026-10-04T10:00:00Z',factRef:'guest2',groupId:'g1',roomIndex:2,firstName:'Taylor',lastName:'Example'}],authorizeSource:async()=>true}));
 const options={authorizationId:revision.authorizationId,authorizeContext:async()=>true,signer:{signerName:'',signerEmail:''},resolvePolicy:async()=>null,readQuote,readBookingPrerequisites,readAcceptedQuoteSource:async()=>accepted};
 return{ctx,accepted,options,readQuote,readBookingPrerequisites};
}
it('composes original accepted pricing through existing booking packet without a current quote',async()=>{
 const f=await fixture(),resolved=await createReservationistBusinessServices(f.options).resolveBookingTask!(f.ctx);
 expect(f.readQuote).not.toHaveBeenCalled();expect(f.readBookingPrerequisites).toHaveBeenCalledOnce();expect(resolved.evidence.revision).toEqual(f.accepted.revision);
 const packet=await prepareBookingPacket(resolved.input,{resolveEvidence:async()=>resolved.evidence,authorizeSource:resolved.authorizeSource,signal:f.ctx.signal,deadlineAt:f.ctx.input.clock.deadlineAt,clock:f.ctx.input.clock});
 expect(packet).toMatchObject({kind:'accepted_quote',status:'pending_pms_action',totalMinor:50000,saved:false,nativePriceApplication:'pending_staff_review'});
 expect(packet.rooms[0].pricing.nightly.map(n=>n.amountMinor)).toEqual([10000,15000]);expect(packet.rooms).toHaveLength(2);expect(f.accepted.authorizeSource).toHaveBeenCalled();
});
it.each(['no-revision','wrong-owner','changed-acceptance','changed-sent','changed-line','changed-total','changed-night-allocation','denied','expired','availability','mutated-callback','not-authorized','no-causal-message','original-inbound','original-private','original-time-mismatch','source-private','content-type-mismatch'] as const)('fails closed on %s while retaining original offer',async mode=>{
 const f=await fixture();
 if(mode==='no-revision')f.options.readAcceptedQuoteSource=async()=>({...f.accepted,revision:null}) as never;
 if(mode==='wrong-owner')f.accepted.attestation.ownerRef='foreign';
 if(mode==='not-authorized')f.ctx.input.authorizedArtifacts=[];
 if(mode==='no-causal-message')f.ctx.input.messages=f.ctx.input.messages.filter(m=>m.id!==f.accepted.document.metadata.messageId);
 if(mode==='original-inbound')f.ctx.input.messages[0].direction='inbound';
 if(mode==='original-private')f.ctx.input.messages[0].disclosure='staff_only';
 if(mode==='original-time-mismatch')f.ctx.input.messages[0].at='2026-10-04T11:00:00Z';
 if(mode==='source-private')f.accepted.document.metadata.disclosure='staff_only';
 if(mode==='content-type-mismatch')f.accepted.document.bytes!.contentType='image/png';
 if(mode==='changed-acceptance')f.ctx.task.source.sourceHash='d'.repeat(64);
 if(mode==='changed-sent')f.accepted.sentProof.sentAt='2026-10-06T10:00:00Z';
 if(mode==='changed-line')f.accepted.originalOffer.lines[0].quote='Not in original document';
 if(mode==='changed-total')f.accepted.originalOffer.lines[0].amount='550.00';
 if(mode==='changed-night-allocation'){const g=f.accepted.revision.groups[0];g.nightly[0].amountMinor+=100;g.nightly[1].amountMinor-=100;const{id,...data}=f.accepted.revision;f.accepted.revision.id=`quote:${quoteDigest(data)}`;f.accepted.sentProof.revisionId=f.accepted.revision.id;}
 if(mode==='denied')f.accepted.authorizeSource.mockImplementation(async()=>false);
 if(mode==='expired'){f.ctx.input.trigger.at='2026-10-09T10:00:00Z';f.ctx.input.messages.find(m=>m.id==='m')!.at=f.ctx.input.trigger.at;f.ctx.input.clock.causalAt=f.ctx.input.trigger.at;f.ctx.input.clock.sourceAt=f.ctx.input.trigger.at;}
 if(mode==='availability')f.readBookingPrerequisites.mockImplementation(async()=>{throw new Error('native unavailable');});
 if(mode==='mutated-callback')f.accepted.authorizeSource.mockImplementation(async()=>{f.ctx.input.authorizationScope!.ownerRef='foreign';return true;});
 await expect(createReservationistBusinessServices(f.options).resolveBookingTask!(f.ctx)).rejects.toThrow();expect(f.readQuote).not.toHaveBeenCalled();
});

it('uses authorized causal staff-only original pricing only for the nonexecuting staff packet',async()=>{
 const f=await fixture();f.ctx.input.messages[0].disclosure='staff_only';f.accepted.document.metadata.disclosure='staff_only';f.accepted.document.source!.disclosure='staff_only';
 const resolved=await createReservationistBusinessServices(f.options).resolveBookingTask!(f.ctx);
 const packet=await prepareBookingPacket(resolved.input,{resolveEvidence:async()=>resolved.evidence,authorizeSource:resolved.authorizeSource,signal:f.ctx.signal,deadlineAt:f.ctx.input.clock.deadlineAt,clock:f.ctx.input.clock});
 expect(f.readQuote).not.toHaveBeenCalled();expect(packet).toMatchObject({kind:'accepted_quote',status:'pending_pms_action',totalMinor:50000,saved:false});expect(packet.rooms[0].pricing.nightly.map(n=>n.amountMinor)).toEqual([10000,15000]);
});
