import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {deriveReplyToAddress} from './workflows/candidate-draft.js';
import {deriveStaffAnswerTopics} from './reservationist-execution.js';
import {validateReservationistMailAnswers} from './reservationist-mail-answer-source.js';
import type {ReservationistRuntimeInput,RuntimePlan} from './reservationist-runtime.js';
import type {ReservationistPersistedResult} from './drafts.js';
import {maskIncomingCardNumbers} from './card-mask.js';
import {renderReservationistMessage,reservationistDisclosure,reservationistMessageAt} from './reservationist-worker-input.js';
const id=z.string().min(1).max(512),hash=z.string().regex(/^[a-f0-9]{64}$/);
const span=z.object({attachmentId:id,sourceHash:hash,page:z.literal(1),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(4096)}).strict();
export const operationalDraftProofSchema=z.object({task:z.object({id,kind:z.literal('question'),required:z.literal(true),source:span}).strict(),binding:z.object({requestId:id,ownerRef:id,threadId:id,propertyCode:z.literal('HRCEN'),triggerMessageId:id,causalAt:z.string().datetime()}).strict(),answer:z.object({kind:z.enum(['parking','check_in','check_out']),value:z.union([z.boolean(),z.string().min(1).max(32)]),messageId:id,sourceHash:hash,start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(4096),disclosure:z.literal('guest')}).strict(),authority:z.literal('causal_guest_mail')}).strict();
export type OperationalDraftProof=z.infer<typeof operationalDraftProofSchema>;
export type OperationalDraftMessageRow={id:string;transportId:string;threadId:string|null;direction:string;arrivedAt?:Date|null;createdAt?:Date|null;receivedAt:Date|null;sentAt:Date|null;textBody:string|null;htmlBody:string|null;subject:string|null;fromAddress:string;toAddresses:string[];ccAddresses:string[];bccAddresses:string[]};
type Binding=OperationalDraftProof['binding'];
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Guest disclosure is recomputed from the scoped actual trigger and original outbound To header. */
export function operationalDraftMessages(rows:readonly OperationalDraftMessageRow[],binding:Binding):ReservationistRuntimeInput['messages']{
 const trigger=rows.find(row=>row.id===binding.triggerMessageId);
 if(binding.propertyCode!=='HRCEN'||binding.requestId!==binding.triggerMessageId||!trigger||trigger.transportId!==binding.ownerRef||trigger.threadId!==binding.threadId||trigger.direction!=='inbound'||reservationistMessageAt(trigger)?.toISOString()!==binding.causalAt)throw new Error('operational_trigger_scope_invalid');
 const replyTo=deriveReplyToAddress(trigger.fromAddress);if(!replyTo)throw new Error('operational_guest_address_invalid');
 return rows.filter(row=>{const at=reservationistMessageAt(row);return at&&at.getTime()<=Date.parse(binding.causalAt);}).map(row=>{
  const at=reservationistMessageAt(row);if(row.transportId!==binding.ownerRef||row.threadId!==binding.threadId||!at||!['inbound','outbound'].includes(row.direction))throw new Error('operational_message_scope_invalid');
  return{id:row.id,at:at.toISOString(),direction:row.direction as 'inbound'|'outbound',...renderReservationistMessage(row),...(row.subject!==null?{subject:maskIncomingCardNumbers(row.subject)}:{}),disclosure:reservationistDisclosure(row,replyTo.toLowerCase())};
 });
}
function requestValid(task:OperationalDraftProof['task'],input:ReservationistRuntimeInput):boolean{
 const message=input.messages.find(m=>m.id===input.trigger.id),s=task.source;
 if(!message||message.direction!=='inbound'||message.disclosure!=='guest'||message.at!==input.clock.causalAt||s.attachmentId!==`message:${message.id}`||s.sourceHash!==sha(message.text)||s.start<0||s.end-s.start!==s.quote.length||message.text.slice(s.start,s.end)!==s.quote)return false;
 if(message.sourceViews&&!message.sourceViews.some(view=>s.start>=view.start&&s.end<=view.end))return false;
 const history=message.text.search(/^(?:From:\s|Sent:\s|Subject:\s|On [^\r\n]{1,250}(?:\r?\n[^\r\n]{1,250}){0,2}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im);
 const authored=history<0?message.text:message.text.slice(0,history),topics=deriveStaffAnswerTopics(s.quote);
 return s.end<=authored.length&&!/^\s*>/m.test(authored)&&!(/\b(?:not|no|never|unless|without|whether|if|don't|disregard|withdraw|another|other|different|early|late|fee|fees|charge|charges|cost|costs|approved|approval|confirm(?:ed)?)\b/i.test(authored))&&topics.length===1&&['parking','check_in','check_out'].includes(topics[0]!);
}
export function operationalDraftFact(proof:OperationalDraftProof){return{key:`${proof.answer.kind}_${proof.task.id}`,label:proof.answer.kind,value:proof.answer.value,source:'mail',authority:'authorized',status:'known',evidenceRef:`message:${proof.answer.messageId}`,sourceHash:proof.answer.sourceHash,scopeVerified:true,disclosure:'guest'};}
function expectedTask(proof:OperationalDraftProof){return{id:proof.task.id,status:'complete',guestText:proof.answer.kind==='parking'?'Parking is available.':proof.answer.kind==='check_in'?`Check-in time is ${proof.answer.value}.`:`Check-out time is ${proof.answer.value}.`,evidenceRefs:[`message:${proof.answer.messageId}`],disclosure:'guest',kind:'question',required:true};}
/** Produces only exact earlier affirmative guest-addressed mail facts already authorized by execution. */
export function deriveOperationalDraftSources(plan:RuntimePlan,result:Pick<ReservationistPersistedResult,'tasks'|'preparedFacts'>,binding:Binding,rows:readonly OperationalDraftMessageRow[],signal:AbortSignal):OperationalDraftProof[]{
 signal.throwIfAborted();const messages=operationalDraftMessages(rows,binding),input:ReservationistRuntimeInput={version:1,requestId:binding.requestId,propertyCode:binding.propertyCode,authorizationScope:{ownerRef:binding.ownerRef,threadId:binding.threadId},trigger:{id:binding.triggerMessageId,at:binding.causalAt},messages,authorizedArtifacts:[],clock:{causalAt:binding.causalAt,sourceAt:binding.causalAt,sourceMode:'current_read',deadlineAt:Date.now()+30000},capabilities:{pmsWrite:false,emailSend:false}};
 const proofs:OperationalDraftProof[]=[];
 for(const item of plan.tasks){
  const parsed=z.object({id,kind:z.literal('question'),required:z.literal(true),source:span}).strict().safeParse(item);if(!parsed.success||!requestValid(parsed.data,input))continue;
  const topic=deriveStaffAnswerTopics(parsed.data.source.quote)[0] as 'parking'|'check_in'|'check_out';
  const facts=(result.preparedFacts??[]).filter(f=>f.key===`${topic}_${item.id}`);if(facts.length!==1)continue;const fact=facts[0]!,message=messages.find(m=>`message:${m.id}`===fact.evidenceRef);
  if(!message||message.direction!=='outbound'||message.disclosure!=='guest'||topic==='parking'&&fact.value!==true||topic!=='parking'&&typeof fact.value!=='string')continue;
  // A candidate is accepted only when the shared validator retains its whole original paragraph.
  const candidates=[...message.text.matchAll(/^(?:Check[ -]?in(?: time)?\s+(?:is|at|starts at)\s+\d{1,2}:\d{2}[.]?|Check[ -]?out(?: time)?\s+(?:is|at|starts at)\s+\d{1,2}:\d{2}[.]?|Parking\s+(?:is\s+)?available[.]?)$/gim)].flatMap(match=>{
   const answer={kind:topic,value:fact.value as string|boolean,messageId:message.id,sourceHash:sha(message.text),start:match.index!,end:match.index!+match[0].length,quote:match[0],disclosure:'guest' as const};
   try{validateReservationistMailAnswers([answer],input);return[answer];}catch{return[];}
  });
  // MIME alternatives may repeat the same independently validated answer.
  if(message.sourceViews?message.sourceViews.some(view=>candidates.filter(answer=>answer.start>=view.start&&answer.end<=view.end).length!==1):candidates.length!==1)continue;
  const answer=candidates[0];if(!answer)continue;
  const proof=operationalDraftProofSchema.parse({task:parsed.data,binding,answer,authority:'causal_guest_mail'});
  if(!isDeepStrictEqual(fact,operationalDraftFact(proof))||result.tasks.filter(t=>isDeepStrictEqual(t,expectedTask(proof))).length!==1)continue;
  proofs.push(proof);
 }
 signal.throwIfAborted();return proofs;
}
export function assertOperationalDraftSources(result:ReservationistPersistedResult,proofs:readonly OperationalDraftProof[],binding:Binding,rows:readonly OperationalDraftMessageRow[],signal:AbortSignal):void{
 signal.throwIfAborted();if(proofs.length>32||new Set(proofs.map(p=>p.task.id)).size!==proofs.length)throw new Error('operational_draft_source_duplicate');
 for(const p of proofs)if(!isDeepStrictEqual(p.binding,binding))throw new Error('operational_draft_scope_changed');
 const expected=deriveOperationalDraftSources({tasks:proofs.map(p=>p.task),facts:[]},result,binding,rows,signal);
 if(!isDeepStrictEqual(expected,proofs))throw new Error('operational_draft_source_changed');
 const facts=result.preparedFacts??[];if(facts.length!==proofs.length||proofs.some(p=>facts.filter(f=>isDeepStrictEqual(f,operationalDraftFact(p))).length!==1))throw new Error('operational_draft_fact_missing');
 signal.throwIfAborted();
}
