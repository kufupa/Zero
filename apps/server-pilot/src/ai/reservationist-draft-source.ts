import {quoteTargetForTransport} from '../hms/hms-quote-target.js';
import {operationalDraftProofSchema,assertOperationalDraftSources,operationalDraftMessages,type OperationalDraftMessageRow} from './reservationist-operational-draft-source.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {canonicalJson} from './draft-approval.js';
import {assertReservationistChannelBookingSyncPacket} from './reservationist-pending-action.js';
import {deriveRequestedArrivalAcknowledgement} from './reservationist-execution.js';
import type {ReservationistRuntimeInput,RuntimePlan} from './reservationist-runtime.js';
import type {ReservationistPersistedResult} from './drafts.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(512);
/** Existing reservationist worker deployment is scoped to the Centurion property. */
export const RESERVATIONIST_DRAFT_PROPERTY_CODE='HRCEN' as const;
/** Quote-only: HRDAV when HMS_DAVINCI_MAKE_QUOTE=on for a Da Vinci mailbox; otherwise HRCEN. */
export function reservationistDraftPropertyCode(transportId:string,env:NodeJS.Dict<string>=process.env):typeof RESERVATIONIST_DRAFT_PROPERTY_CODE|'HRDAV'{
 const resolved=quoteTargetForTransport(transportId,env);
 return resolved.ok&&resolved.target.propertyCode==='HRDAV'?'HRDAV':RESERVATIONIST_DRAFT_PROPERTY_CODE;
}
const arrivalSourceSchema=z.object({attachmentId:id,sourceHash:hash,page:z.literal(1),quote:z.string().min(1).max(4096),start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const arrivalSchema=z.object({task:z.object({id,kind:z.literal('question'),required:z.literal(true),source:arrivalSourceSchema}).strict(),receipt:z.object({kind:z.literal('requested_arrival_acknowledgement'),authority:z.literal('customer_claim'),hotelPermission:z.literal('unverified'),taskId:id,requestId:id,ownerRef:id,threadId:id,propertyCode:id,triggerMessageId:id,requestedTime:z.string().min(1).max(32),source:z.object({sourceRef:id,sourceHash:hash,quote:z.string().min(1).max(4096),start:z.number().int().min(0),end:z.number().int().min(1),observedAt:z.string().datetime(),disclosure:z.literal('guest')}).strict()}).strict()}).strict();
const sourceSchema=z.object({version:z.literal(1),runId:id,generationId:id,transportId:id,propertyCode:id,threadId:id,requestedByUserId:id,triggerMessageId:id,causalAt:z.string().datetime(),resultDigest:hash,
 messages:z.array(z.object({id,at:z.string().datetime(),direction:z.enum(['inbound','outbound']),sourceHash:hash,identityHash:hash}).strict()).min(1).max(64),
 attachments:z.array(z.object({attachmentId:id,messageId:id,s3Key:z.string().min(1).max(4096),mimeType:z.string().min(1).max(256),sizeBytes:z.number().int().min(0).max(20*1024*1024),sourceHash:hash,inline:z.boolean()}).strict()).max(256),
 arrivalAcknowledgements:z.array(arrivalSchema).max(32).optional(),
 operationalAnswers:z.array(operationalDraftProofSchema).max(32).optional(),
}).strict();
export type ReservationistDraftSource=z.infer<typeof sourceSchema>;
export function draftSourceHash(value:unknown):string{return createHash('sha256').update(canonicalJson(value)).digest('hex');}
export function draftSourceMessage(row:{id:string;direction:string;receivedAt:Date|null;sentAt:Date|null;textBody:string|null;htmlBody:string|null;subject:string|null;fromAddress:string;toAddresses:string[];ccAddresses:string[];bccAddresses:string[]}){
 return {id:row.id,at:(row.direction==='inbound'?row.receivedAt:row.sentAt)!.toISOString(),direction:row.direction as 'inbound'|'outbound',sourceHash:createHash('sha256').update(row.textBody??row.htmlBody??'','utf8').digest('hex'),identityHash:draftSourceHash({subject:row.subject,fromAddress:row.fromAddress,toAddresses:row.toAddresses,ccAddresses:row.ccAddresses,bccAddresses:row.bccAddresses})};
}
function validate(value:unknown):ReservationistDraftSource{
 const source=sourceSchema.parse(value),ids=new Set(source.messages.map(m=>m.id));
 if(ids.size!==source.messages.length||!source.messages.some(m=>m.id===source.triggerMessageId&&m.direction==='inbound'&&m.at===source.causalAt)||source.messages.some(m=>Date.parse(m.at)>Date.parse(source.causalAt))||new Set(source.attachments.map(a=>a.attachmentId)).size!==source.attachments.length||source.attachments.some(a=>!ids.has(a.messageId))||source.attachments.reduce((sum,a)=>sum+a.sizeBytes,0)>20*1024*1024)throw new Error('reservationist_draft_source_invalid');
 if(new Set(source.arrivalAcknowledgements?.map(item=>item.task.id)).size!==(source.arrivalAcknowledgements?.length??0))throw new Error('arrival_draft_source_duplicate');
 return source;
}
/** Retain the original validated plan source; no source is inferred from rendered copy. */
export function deriveArrivalDraftSources(plan:RuntimePlan,input:ReservationistRuntimeInput):NonNullable<ReservationistDraftSource['arrivalAcknowledgements']>{
 return plan.tasks.flatMap(task=>{
  if(task.kind!=='question'||task.required!==true||!task.source)return [];
  const parsed=arrivalSourceSchema.safeParse(task.source);if(!parsed.success)return [];
  const original={id:task.id,kind:'question' as const,required:true as const,source:parsed.data};
  const receipt=deriveRequestedArrivalAcknowledgement({task:{id:task.id,kind:'question',factIds:[],source:parsed.data},facts:[],input,signal:new AbortController().signal});
  return receipt?[{task:original,receipt}]:[];
 });
}
/** Only source-derived customer preferences qualify; this does not authorize hotel permission. */
export function assertArrivalDraftSources(result:ReservationistPersistedResult,source:ReservationistDraftSource,messages:ReservationistRuntimeInput['messages']):void{
 const proofs=source.arrivalAcknowledgements??[],facts=result.preparedFacts??[];
 if(facts.length!==proofs.length)throw new Error('arrival_draft_source_missing');
 const input:ReservationistRuntimeInput={version:1,requestId:source.triggerMessageId,propertyCode:source.propertyCode,authorizationScope:{ownerRef:source.transportId,threadId:source.threadId},trigger:{id:source.triggerMessageId,at:source.causalAt},messages,authorizedArtifacts:[],clock:{causalAt:source.causalAt,sourceAt:source.causalAt,sourceMode:'current_read',deadlineAt:Date.now()+30000},capabilities:{pmsWrite:false,emailSend:false}};
 for(const proof of proofs){
  const expected=deriveArrivalDraftSources({tasks:[proof.task],facts:[]},input);
  if(expected.length!==1||!isDeepStrictEqual(proof,expected[0]))throw new Error('arrival_draft_source_changed');
  const receipt=expected[0]!.receipt,fact={key:`requested_arrival_time_${proof.task.id}`,label:'Customer requested arrival time',value:{requestedTime:receipt.requestedTime,authority:'customer_claim',hotelPermission:'unverified'},source:'inbound',authority:'authorized',status:'known',evidenceRef:receipt.source.sourceRef,sourceHash:receipt.source.sourceHash,scopeVerified:true,disclosure:'guest'};
  if(facts.filter(item=>isDeepStrictEqual(item,fact)).length!==1)throw new Error('arrival_draft_fact_invalid');
  const task={id:proof.task.id,status:'complete',guestText:`We have noted your request to check in by ${receipt.requestedTime}. Staff must verify the requested arrival time.`,evidenceRefs:[receipt.source.sourceRef],disclosure:'guest',kind:'question',required:true};
  if(result.tasks.filter(item=>isDeepStrictEqual(item,task)).length!==1)throw new Error('arrival_draft_task_invalid');
 }
}
export function sealReservationistDraftSource(value:ReservationistDraftSource){const source=validate(value);return {...source,digest:draftSourceHash(source)};}
export function assertReservationistDraftSource(value:unknown,live:ReservationistDraftSource):void{
 const {digest,...data}=z.object({digest:hash}).passthrough().parse(value),source=validate(data),current=validate(live);
 if(digest!==draftSourceHash(source)||!isDeepStrictEqual(source,current))throw new Error('reservationist_draft_source_changed');
}
export function assertChannelPacketDraftSource(value:unknown,source:ReservationistDraftSource,now:Date):void{
 assertReservationistChannelBookingSyncPacket(value,now);
 const binding=value.requestBinding!;
 if(value.propertyCode!==source.propertyCode||binding.ownerRef!==source.transportId||binding.threadId!==source.threadId||binding.requestId!==source.triggerMessageId||binding.sourceRef!==`message:${source.triggerMessageId}`||binding.observedAt!==source.causalAt||binding.sourceHash!==source.messages.find(message=>message.id===source.triggerMessageId)?.sourceHash)throw new Error('channel_draft_source_scope_invalid');
 for(const proof of value.sourceProofs!){const message=source.messages.find(message=>`message:${message.id}`===proof.sourceRef),attachment=source.attachments.find(attachment=>attachment.attachmentId===proof.sourceRef),at=message?.at??source.messages.find(message=>message.id===attachment?.messageId)?.at;
  if(proof.sourceHash!==(message?.sourceHash??attachment?.sourceHash)||proof.observedAt!==at)throw new Error('channel_draft_source_proof_invalid');
 }
}

/** Every source-only prepared fact must have a narrow independently recomputed typed receipt. */
export function assertSourcePreparedDraftFacts(result:ReservationistPersistedResult,source:ReservationistDraftSource,rows:readonly OperationalDraftMessageRow[],signal:AbortSignal):void{
 signal.throwIfAborted();if(source.propertyCode!==RESERVATIONIST_DRAFT_PROPERTY_CODE&&source.propertyCode!==reservationistDraftPropertyCode(source.transportId))throw new Error('operational_draft_property_invalid');const operational=source.operationalAnswers??[],keys=new Set(operational.map(p=>`${p.answer.kind}_${p.task.id}`));
 const arrivalFacts=(result.preparedFacts??[]).filter(f=>!keys.has(f.key)),operationalFacts=(result.preparedFacts??[]).filter(f=>keys.has(f.key));
 const binding={requestId:source.triggerMessageId,ownerRef:source.transportId,threadId:source.threadId,propertyCode:RESERVATIONIST_DRAFT_PROPERTY_CODE,triggerMessageId:source.triggerMessageId,causalAt:source.causalAt};
 const messages=operationalDraftMessages(rows,binding);
 assertArrivalDraftSources({...result,preparedFacts:arrivalFacts},source,messages);
 assertOperationalDraftSources({...result,preparedFacts:operationalFacts},operational,binding,rows,signal);
 signal.throwIfAborted();
}
