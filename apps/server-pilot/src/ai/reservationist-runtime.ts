import {assertReservationistChannelBookingSyncPacket,isReservationistCancellationReviewPacket} from './reservationist-pending-action.js';
import {createHash} from 'node:crypto';
import { assessReply } from './reply-assessment.js';
import { assertReservationistResultFreshForAction,assertReservationistResultWording } from './draft-approval.js';
import type { QuoteRevision, ImportedOffer } from '../quote-proposal/quote-revision.js';
import type { AuthorizedProposalFacts } from '../quote-proposal/quote-lines.js';
import type { ExecutionRateComparison } from './reservationist-execution.js';
import type { PreparedFact } from './prepared-draft-input.js';
import {quoteDigest} from '../quote-proposal/quote-revision.js';
import {composeReservationistReply} from './reply-playbooks.js';
import type { ReservationistMessageView } from './reservationist-message-view.js';
export const RESERVATIONIST_RUNTIME_VERSION='reservationist-runtime-v1';
export const RESERVATIONIST_COPY_VERSION='reservationist-copy-v1';
export type ReservationistRuntimeInput={version:1;requestId:string;propertyCode:string;trigger:{id:string;at:string};messages:{id:string;at:string;direction:'inbound'|'outbound';text:string;subject?:string;disclosure?:'guest'|'staff_only';sourceViews?:ReservationistMessageView[]}[];authorizationScope?:{ownerRef:string;threadId:string};authorizedArtifacts:unknown[];requiredTaskKinds?:string[];requiredAskSpans?:{sourceId:string;start:number;end:number;text:string}[];requiredTaskIds?:string[];requiredArtifactRefs?:string[];clock:{causalAt:string;sourceAt:string;sourceMode?:'historical'|'current_read';deadlineAt:number};capabilities:{pmsWrite:false;emailSend:false}};
export type RuntimeTask={id:string;kind:string;required:boolean;source?:{attachmentId:string;sourceHash:string;page:number;start?:number;end?:number;quote?:string}};
export type RuntimeTaskResult={id:string;status:'complete'|'needs_clarification'|'blocked'|'pending_pms_action';guestText:string;evidenceRefs:string[];disclosure?:'guest'|'staff_only';requestSource?:NonNullable<RuntimeTask['source']>;bookingSuggestion?:import('./reservationist-booking-suggestion.js').ReservationistBookingSuggestion};
export type FactRecoveryProvenance={reason:string;taskIds:string[];sources:{attachmentId:string;sourceHash:string}[]};
export type RuntimeSourceRecovery={kind:'unresolved_fact'|'attachment_manual';reason:string;sourceRef?:string;sourceHash?:string;sourceIdentity?:'metadata_only';sourceKind?:'message'|'attachment';messageId?:string;mimeType?:string;signatureNoise?:boolean;disclosure:'staff_only';provenance?:FactRecoveryProvenance};
export type RuntimeWorkResult={recipientPreparations?:import('./reservationist-recipient-preparation.js').RecipientPreparationReceipt[];currentNativeObservations?:import('./reservationist-execution.js').CurrentNativeObservationReceipt[];sourceRecoveries?:RuntimeSourceRecovery[];tasks:RuntimeTaskResult[];artifacts:{ref:string;sha256:string;sizeBytes:number;fileName:string;mimeType:string}[];requiredArtifactRefs?:string[];approvedGuestClauses?:Record<string,string>;preparedFacts?:PreparedFact[];quoteRefs:string[];packets:{saved:false;status:string;kind?:string;taskId?:string;businessRulesValidated?:boolean;cancellationReview?:unknown}[];errors:string[];quoteRevisions?:QuoteRevision[];proposalFacts?:{ref:string;facts:AuthorizedProposalFacts}[];importedOffers?:ImportedOffer[];approvedOverrides?:unknown[];rateComparisons?:ExecutionRateComparison[];readReceipts?:import('./reservationist-read-task.js').ReservationistReadReceipt[];existingDocumentReceipts?:import('./reservationist-existing-document.js').ReservationistExistingDocumentReceipt[];readRecoveries?:{taskId:string;codes:string[]}[];paymentComparisons?:import('./reservationist-execution.js').ExecutionPaymentComparison[]};
export type RuntimePlan={sourceRecoveries?:RuntimeWorkResult['sourceRecoveries'];tasks:RuntimeTask[];facts:unknown[];factRecoveryProvenance?:FactRecoveryProvenance[];noAction?:{kind:'no_current_request'|'source_review';modelSelectionCompleted:true;inputDigest:string;triggerMessageId:string;sourceHash:string}};
export type ReservationistSourceEvaluation={evaluateSourceAt:()=>string};
const currentExecutionInputs=new WeakMap<ReservationistRuntimeInput,{originalDigest:string;evaluation:ReservationistSourceEvaluation}>();
/** Only a runtime-created view may advance the evaluation clock; the causal input stays unchanged. */
export function isReservationistExecutionInput(input:ReservationistRuntimeInput,original:ReservationistRuntimeInput,evaluation:ReservationistSourceEvaluation|undefined):boolean{
 const registered=currentExecutionInputs.get(input);
 return !!registered&&registered.evaluation===evaluation&&registered.originalDigest===quoteDigest(original)&&quoteDigest({...input,clock:{...input.clock,sourceAt:original.clock.sourceAt}})===registered.originalDigest;
}
/** Shared orchestration; injected work stage must use server-authorized fact/literal guards. No evaluator input or write edge exists. */
export async function runReservationistRuntime(input:ReservationistRuntimeInput,deps:{plan:(input:ReservationistRuntimeInput,signal:AbortSignal)=>Promise<RuntimePlan>;execute:(plan:RuntimePlan,input:ReservationistRuntimeInput,signal:AbortSignal,evaluation?:ReservationistSourceEvaluation)=>Promise<RuntimeWorkResult>;currentReadEvaluation?:boolean;currentReadEvaluationClock?:()=>number;signal?:AbortSignal;verifyGuestClause?:(task:RuntimeTaskResult,signal:AbortSignal)=>Promise<boolean>;verifyArtifact?:(artifact:RuntimeWorkResult['artifacts'][number],signal:AbortSignal)=>Promise<boolean>}){
 if(input.version!==1||input.capabilities.pmsWrite!==false||input.capabilities.emailSend!==false)throw new Error('capability_denied');
 const causal=Date.parse(input.clock.causalAt),trigger=Date.parse(input.trigger.at);
 if(!Number.isFinite(causal)||trigger!==causal||!Number.isFinite(Date.parse(input.clock.sourceAt))||(input.clock.sourceMode!=='current_read'&&Date.parse(input.clock.sourceAt)>causal)||!input.requestId||!input.propertyCode||input.messages.length>64||input.messages.reduce((sum,message)=>sum+message.text.length,0)>1280000||new Set(input.messages.map(m=>m.id)).size!==input.messages.length||!input.messages.some(m=>m.id===input.trigger.id&&m.direction==='inbound'&&Date.parse(m.at)===causal)||input.messages.some(m=>!m.id||m.text.length>40000||!['inbound','outbound'].includes(m.direction)||!Number.isFinite(Date.parse(m.at))||Date.parse(m.at)>causal))throw new Error('causal_input_invalid');
 if(!Number.isFinite(input.clock.deadlineAt)||Date.now()>=input.clock.deadlineAt)throw new Error('deadline_exceeded');
 if(deps.currentReadEvaluation&&(input.clock.sourceMode!=='current_read'||Date.parse(input.clock.sourceAt)>Date.now()))throw new Error('current_evaluation_clock_invalid');
 const injectedClock=deps.currentReadEvaluationClock;
 if(injectedClock!==undefined&&(typeof injectedClock!=='function'||deps.currentReadEvaluation!==true))throw new Error('current_evaluation_clock_invalid');
 let recordedSourceAt:number|undefined;const clockInputDigest=quoteDigest(input);

 const sampleRecordedClock=()=>{if(quoteDigest(input)!==clockInputDigest)throw new Error('causal_input_changed');const value=injectedClock!();if(quoteDigest(input)!==clockInputDigest)throw new Error('causal_input_changed');if(!Number.isSafeInteger(value)||value<causal||value>Date.now()||recordedSourceAt!==undefined&&value<recordedSourceAt)throw new Error('current_evaluation_clock_invalid');recordedSourceAt=value;return value;};
 if(injectedClock)sampleRecordedClock();
 const signal=AbortSignal.any([AbortSignal.timeout(input.clock.deadlineAt-Date.now()),...(deps.signal?[deps.signal]:[])]);signal.throwIfAborted();
 if((input.requiredAskSpans?.length??0)>32)throw new Error('ask_source_binding_invalid');
 for(const ask of input.requiredAskSpans??[]){
  const message=input.messages.find(message=>`message:${message.id}`===ask.sourceId&&message.id===input.trigger.id&&message.direction==='inbound');
  if(!message||!Number.isSafeInteger(ask.start)||!Number.isSafeInteger(ask.end)||ask.start<0||ask.end<=ask.start||ask.end>message.text.length||message.text.slice(ask.start,ask.end)!==ask.text)throw new Error('ask_source_binding_invalid');
 }
 const plan=await deps.plan(input,signal);signal.throwIfAborted();
 if(quoteDigest(input)!==clockInputDigest)throw new Error('causal_input_changed');
 const factRecoveryProvenance=structuredClone(plan.factRecoveryProvenance??[]),recoveryTaskIdentity=quoteDigest(plan.tasks),recoveryInputIdentity=quoteDigest({messages:input.messages,authorizedArtifacts:input.authorizedArtifacts});
 if(!plan.tasks.length){
  const triggerMessage=input.messages.find(m=>m.id===input.trigger.id)!,proof=plan.noAction;
  if(!proof||!['no_current_request','source_review'].includes(proof.kind)||proof.modelSelectionCompleted!==true||proof.inputDigest!==clockInputDigest||proof.triggerMessageId!==input.trigger.id||proof.sourceHash!==createHash('sha256').update(triggerMessage.text).digest('hex')||!Array.isArray(input.requiredTaskKinds)||input.requiredTaskKinds.length||!Array.isArray(input.requiredAskSpans)||input.requiredAskSpans.length||input.requiredTaskIds?.length||input.requiredArtifactRefs?.length||plan.facts.length||plan.factRecoveryProvenance?.length)throw new Error('no_action_unproven');
  const sourceRecoveries=structuredClone(plan.sourceRecoveries??[]),inventory=input.authorizedArtifacts as {attachmentId?:string;sourceHash?:string;sourceIdentity?:string;messageId?:string;messageAt?:string;mimeType?:string;ownerRef?:string;threadId?:string}[];
  const invalidRecovery=(r:RuntimeSourceRecovery)=>{
   if(r.kind!=='attachment_manual'||r.disclosure!=='staff_only'||!r.reason||r.reason.length>4096||!r.sourceRef)return true;
   if(r.sourceIdentity==='metadata_only'){
    if(!input.authorizationScope?.ownerRef||!input.authorizationScope.threadId)return true;
    const matches=inventory.filter(a=>a.attachmentId===r.sourceRef&&a.sourceIdentity==='metadata_only'&&a.sourceHash===undefined&&a.messageId===r.messageId&&a.mimeType===r.mimeType&&a.ownerRef===input.authorizationScope?.ownerRef&&a.threadId===input.authorizationScope?.threadId&&input.messages.some(m=>m.id===a.messageId&&m.at===a.messageAt));
    return proof.kind!=='source_review'||r.sourceHash!==undefined||r.sourceKind!=='attachment'||r.signatureNoise===true||r.provenance!==undefined||matches.length!==1;
   }
   return r.provenance?.reason!==r.reason||r.provenance.taskIds.length!==0||r.provenance.sources.length!==1||r.provenance.sources[0]!.attachmentId!==r.sourceRef||!inventory.some(a=>a.attachmentId===r.sourceRef&&a.sourceHash===r.provenance!.sources[0]!.sourceHash);
  };
  if(sourceRecoveries.length>64||sourceRecoveries.some(invalidRecovery))throw new Error('no_action_unproven');
  if(proof.kind==='source_review'&&!sourceRecoveries.length)throw new Error('no_action_unproven');
  const work:RuntimeWorkResult={tasks:[],artifacts:[],quoteRefs:[],packets:[],errors:[],preparedFacts:[],sourceRecoveries,approvedGuestClauses:{}},assessment=assessReply({replyText:'',asks:[],facts:[],authorizedAttachmentRefs:[],audience:'guest'}),result={...work,version:RESERVATIONIST_RUNTIME_VERSION,copyVersion:RESERVATIONIST_COPY_VERSION,family:'quote' as const,...(proof.kind==='source_review'?{readiness:'needs_clarification' as const}:{readiness:'no_action' as const,noAction:proof}),tasks:[] as (RuntimeTaskResult&{kind:string;required:boolean})[],assessment,textBody:'',htmlBody:''};return{...result,digest:quoteDigest(result)};
 }
 if(plan.tasks.length>32||new Set(plan.tasks.map(t=>t.id)).size!==plan.tasks.length)throw new Error('task_plan_invalid');
 if(input.requiredAskSpans?.length){
  const used=new Set<string>();
  for(const ask of input.requiredAskSpans){const document=/^(?:tax certificate|certificate|receipt|invoice|confirmation|document|existing quote|quote|quotation|proposal)$/i.test(ask.text),kind=document?'existing_document':'question';const task=plan.tasks.find(task=>!used.has(task.id)&&task.kind===kind&&task.source?.attachmentId===ask.sourceId&&task.source.start!==undefined&&task.source.end!==undefined&&task.source.start<=ask.start&&task.source.end>=ask.end&&task.source.quote?.toLowerCase().includes(ask.text.toLowerCase()));if(!task)throw new Error('required_obligation_omitted');
   const message=input.messages.find(message=>`message:${message.id}`===ask.sourceId)!;
   const source=task.source!;
   if(source.sourceHash!==createHash('sha256').update(message.text,'utf8').digest('hex')||source.page!==1||!Number.isSafeInteger(source.start)||!Number.isSafeInteger(source.end)||source.start!<0||source.end!>message.text.length||message.text.slice(source.start,source.end)!==source.quote)throw new Error('task_source_binding_invalid');
   const coveredAsks=input.requiredAskSpans.filter(other=>other.sourceId===ask.sourceId&&source.start!<=other.start&&source.end!>=other.end);
   if(coveredAsks.length!==1)throw new Error('ambiguous_ask_source_span');
   used.add(task.id);}
 }
 if(input.requiredTaskKinds?.some(kind=>!plan.tasks.some(t=>t.kind===kind)))throw new Error('required_obligation_omitted');
 if(input.requiredTaskIds?.some(id=>!plan.tasks.some(t=>t.id===id)))throw new Error('required_obligation_omitted');
 let executionInput=input,evaluation:ReservationistSourceEvaluation|undefined,sourceEvaluatedAt=injectedClock?new Date(recordedSourceAt!).toISOString():input.clock.sourceAt;
 if(deps.currentReadEvaluation){
  const originalDigest=quoteDigest(input),clock=Object.freeze({...input.clock,get sourceAt(){return sourceEvaluatedAt;}});
  executionInput=Object.freeze({...input,clock});
  evaluation=Object.freeze({evaluateSourceAt:()=>{signal.throwIfAborted();const now=Date.now();if(now>=input.clock.deadlineAt)throw new Error('deadline_exceeded');if(quoteDigest(input)!==originalDigest)throw new Error('causal_input_changed');sourceEvaluatedAt=new Date(injectedClock?sampleRecordedClock():Math.max(Date.parse(sourceEvaluatedAt),now)).toISOString();return sourceEvaluatedAt;}});
  currentExecutionInputs.set(executionInput,{originalDigest,evaluation});
  evaluation.evaluateSourceAt();
 }
 const work=await deps.execute(plan,executionInput,signal,evaluation);signal.throwIfAborted();
 evaluation?.evaluateSourceAt();
 const evaluatedAt=new Date(sourceEvaluatedAt);
 if(work.tasks.length!==plan.tasks.length||new Set(work.tasks.map(t=>t.id)).size!==work.tasks.length||plan.tasks.some(t=>!work.tasks.some(w=>w.id===t.id)))throw new Error('task_coverage_missing');
 if(work.tasks.some(task=>!['complete','needs_clarification','blocked','pending_pms_action'].includes(task.status)||task.guestText.length>4096||!Array.isArray(task.evidenceRefs)))throw new Error('task_result_invalid');
 if(work.tasks.some(task=>task.status==='complete'&&task.disclosure!=='staff_only'&&!task.evidenceRefs.length))throw new Error('completed_task_evidence_missing');
 if(work.packets.some(p=>!p||p.saved!==false))throw new Error('capability_saved_packet_denied');
 const packetKind=(kind:string)=>kind==='acceptance'?'accepted_quote':kind==='new_booking'?'new_booking':['change','cancel_request','channel_booking_sync'].includes(kind)?kind:null;
 for(const task of work.tasks){
  const kind=plan.tasks.find(item=>item.id===task.id)!.kind,expected=packetKind(kind),packets=work.packets.filter(packet=>packet.taskId===task.id);
  const pendingPacketValid=kind==='cancel_request'?isReservationistCancellationReviewPacket(packets[0]):packets[0]?.businessRulesValidated===true;
  if(task.status==='pending_pms_action'&&(!expected||packets.length!==1||packets[0]!.kind!==expected||packets[0]!.status!=='pending_pms_action'||!pendingPacketValid))throw new Error(['acceptance','new_booking'].includes(kind)?'pending_booking_packet_unproven':'pending_action_packet_unproven');
 }
 for(const packet of work.packets){
  const task=work.tasks.find(task=>task.id===packet.taskId),kind=task?plan.tasks.find(item=>item.id===task.id)!.kind:null;
  const status=task?.status;
  if(kind==='channel_booking_sync'&&status==='pending_pms_action')assertReservationistChannelBookingSyncPacket(packet,evaluatedAt);
  const businessEvidenceValid=kind==='cancel_request'&&status==='pending_pms_action'?isReservationistCancellationReviewPacket(packet):packet.businessRulesValidated===(status==='pending_pms_action');
  if(!task||!kind||packetKind(kind)!==packet.kind||packet.status!==status||!['pending_pms_action','blocked','needs_clarification'].includes(status!)||!businessEvidenceValid||work.packets.filter(other=>other.taskId===packet.taskId).length!==1)throw new Error('pending_packet_task_binding_invalid');
 }
 for(const artifact of work.artifacts)if(!deps.verifyArtifact||!(await deps.verifyArtifact(artifact,signal)))throw new Error('artifact_identity_unproven');
 const refs=new Set(work.artifacts.filter(a=>a.sizeBytes>5&&a.mimeType==='application/pdf'&&/^[a-f0-9]{64}$/.test(a.sha256)).map(a=>a.ref));
 if([...(input.requiredArtifactRefs??[]),...(work.requiredArtifactRefs??[])].some(ref=>!refs.has(ref)))throw new Error('required_artifact_unavailable');
 if(work.tasks.some(task=>task.disclosure!=='staff_only'&&/\battached\b/i.test(task.guestText)&&!task.evidenceRefs.some(ref=>refs.has(ref))))throw new Error('attachment_task_identity_unproven');
 if(!work.approvedGuestClauses)throw new Error('verified_clauses_required');
 if(work.tasks.some(t=>t.disclosure!=='staff_only'&&t.status!=='pending_pms_action'&&work.approvedGuestClauses![t.id]!==t.guestText))throw new Error('unverified_body_literal');
 for(const task of work.tasks)if(task.disclosure!=='staff_only'&&task.status!=='pending_pms_action'&&(!deps.verifyGuestClause||!await deps.verifyGuestClause(task,signal)))throw new Error('clause_authority_unproven');
 // A batch's missing-context diagnostic remains visible after its exact selected tasks pass execution validators.
 // Unscoped/selection uncertainty and unreadable sources have no such completion proof.
 const sourceIdentity=(source:{attachmentId:string;sourceHash:string})=>{
  if(!source||typeof source.attachmentId!=='string'||!/^[a-f0-9]{64}$/.test(source.sourceHash))return false;
  const message=input.messages.find(m=>source.attachmentId===`message:${m.id}`||source.attachmentId===`message-subject:${m.id}`);
  if(message){const subject=source.attachmentId.startsWith('message-subject:'),text=subject?message.subject:message.text;
   return typeof text==='string'&&(!subject||message.id===input.trigger.id&&message.direction==='inbound'&&message.disclosure!=='staff_only'&&message.at===input.clock.causalAt)&&createHash('sha256').update(text).digest('hex')===source.sourceHash;}
  return input.authorizedArtifacts.some(a=>!!a&&typeof a==='object'&&(a as {attachmentId?:string}).attachmentId===source.attachmentId&&(a as {sourceHash?:string}).sourceHash===source.sourceHash);
 };
 const blockingRecovery=(recovery:NonNullable<RuntimeWorkResult['sourceRecoveries']>[number])=>{
  const p=recovery.provenance;
  return recovery.kind!=='unresolved_fact'||recoveryTaskIdentity!==quoteDigest(plan.tasks)||recoveryInputIdentity!==quoteDigest({messages:input.messages,authorizedArtifacts:input.authorizedArtifacts})||!p||p.reason!==recovery.reason||!factRecoveryProvenance.some(original=>quoteDigest(original)===quoteDigest(p))||
   !Array.isArray(p.taskIds)||p.taskIds.length!==plan.tasks.length||new Set(p.taskIds).size!==p.taskIds.length||p.taskIds.some(id=>!plan.tasks.some(t=>t.id===id)||!work.tasks.some(t=>t.id===id&&t.status==='complete'))||
   !plan.tasks.some(t=>['quote','acceptance','new_booking'].includes(t.kind))||!Array.isArray(p.sources)||!p.sources.length||p.sources.length>72||new Set(p.sources.map(s=>s.attachmentId)).size!==p.sources.length||p.sources.some(s=>!sourceIdentity(s));
 };
 const pending=work.tasks.some(t=>t.status==='pending_pms_action');
 const readiness=work.errors.length>0?'blocked':work.tasks.some(t=>t.status==='blocked')?'blocked':pending?'pending_pms_action':(work.tasks.some(t=>t.status==='needs_clarification')||work.sourceRecoveries?.some(blockingRecovery))?'needs_clarification':'ready_for_staff_review';
 const family=plan.tasks.some(t=>['book','acceptance','new_booking','create'].includes(t.kind))||pending?'booking':'quote';
 const lines=work.tasks.filter(t=>t.disclosure!=='staff_only').map(t=>{
  if(t.status!=='pending_pms_action')return t.guestText;
  const kind=plan.tasks.find(task=>task.id===t.id)!.kind;
  return kind==='channel_booking_sync'?'Your channel booking details are prepared for staff review; no system update has been completed.':kind==='cancel_request'?'Your cancellation request is prepared for staff review; no cancellation has been completed.':kind==='change'?'Your amendment request is prepared for staff review; no changes have been made.':'Your booking request is prepared, subject to staff completion and availability.';
 }).filter(Boolean);
 if(lines.some(text=>/\b(?:booking (?:has been made|is confirmed)|payment (?:has )?cleared)\b/i.test(text)))throw new Error('unproven_completion_clause');
 const {textBody,htmlBody}=composeReservationistReply(family,lines);
 assertReservationistResultWording({...work,version:1,tasks:work.tasks.map(task=>({...task,kind:plan.tasks.find(item=>item.id===task.id)!.kind}))},{subject:'',text:textBody,html:htmlBody},evaluatedAt);
 if(plan.tasks.some(t=>t.kind==='quote')&&work.quoteRevisions?.length||work.currentNativeObservations?.length||work.preparedFacts?.some(f=>f.key.startsWith('current_native_options_'))||work.tasks.some(t=>t.guestText.includes('The current native observation shows'))||work.packets.some(packet=>packet.kind==='cancel_request'&&packet.status==='pending_pms_action'))assertReservationistResultFreshForAction({...work,version:1},evaluatedAt);
 if(work.tasks.some(t=>t.guestText==='Reply recipients are prepared for staff review; no email has been sent.')&&!work.recipientPreparations?.length)throw new Error('recipient_preparation_receipt_missing');
 for(const receipt of work.recipientPreparations??[])assertReservationistResultFreshForAction({...work,version:1},new Date(receipt.input.preparedAt));
 const assessment=assessReply({replyText:textBody,asks:plan.tasks.map(t=>({code:t.kind==='quote'?`quote_total_${t.id}`:t.id,label:t.id,required:t.required})),facts:work.preparedFacts??[],authorizedAttachmentRefs:[...refs],audience:'guest'});
 if(!assessment.ok)throw new Error('reply_assessment_failed');
 const result={...work,...(evaluation?{sourceEvaluatedAt}:{}),assessment,version:RESERVATIONIST_RUNTIME_VERSION,copyVersion:RESERVATIONIST_COPY_VERSION,family,readiness,tasks:work.tasks.map(task=>{const planned=plan.tasks.find(item=>item.id===task.id)!;const {requestSource:_untrusted,...executed}=task;return{...executed,kind:planned.kind,required:planned.required,...(planned.source?{requestSource:structuredClone(planned.source)}:{})};}),textBody,htmlBody};
 return {...result,digest:quoteDigest(result)};
}
