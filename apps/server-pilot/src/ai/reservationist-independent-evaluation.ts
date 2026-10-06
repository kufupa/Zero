import {createHash} from 'node:crypto';
import {fingerprint} from './reservationist-replay.js';
import type {BacktestCase} from './reservationist-backtest.js';
import type {RuntimePlan,RuntimeTask,RuntimeTaskResult} from './reservationist-runtime.js';
import {assertReservationistResultFreshForAction} from './draft-approval.js';
import {deriveDocumentRequestContinuations,assertDocumentRequestContinuation,type DocumentRequestContinuation} from './reservationist-document-continuation.js';
import {assertReservationistRecipientReceipt,RECIPIENT_PREPARATION_CLAUSE} from './reservationist-recipient-preparation.js';
import {assertReservationistExistingDocumentTargets,type ReservationistExistingDocumentTarget} from './reservationist-existing-document.js';

export type IndependentSourceSpan={messageId:string;sourceHash:string;start:number;end:number;quote:string};
export type IndependentAlternativeSourceSpan={source:IndependentSourceSpan;review:{version:'independent-exact-alternative-span-v1';caseId:string;inputHash:string;threadId:string;obligationId:string;originalSourceDigest:string;messageAt:string;direction:'inbound';evaluatorOnly:true;reviewer:IndependentExpectation['reviewer']}};
export type IndependentCanonicalRequestAttestation={version:'independent-canonical-request-containment-v1';caseId:string;inputHash:string;threadId:string;obligationId:string;originalKind:'quote';originalSourceDigest:string;taskScopeHash:string;canonicalRequestSource:IndependentSourceSpan;maximumTaskParentSource:IndependentSourceSpan;currentAuthoredContextSource:IndependentSourceSpan;messageAt:string;direction:'inbound';responseTaskContainsCanonicalRequestSource:true;evaluatorOnly:true;responseOnly:true;nativeState:'unverified';reviewer:IndependentExpectation['reviewer']};
export type IndependentKindAlternativeAttestation={version:'independent-exact-kind-alternative-v1';caseId:string;inputHash:string;threadId:string;obligationId:string;originalKind:'cancel_request'|'new_booking';alternativeKinds:['change'];source:IndependentSourceSpan;originalSourceDigest:string;taskScopeHash:string;messageAt:string;direction:'inbound';evaluatorOnly:true;responseOnly:true;nativeState:'unverified';reviewer:IndependentExpectation['reviewer']};
export type IndependentClarificationAttestation={version:'independent-exact-clarification-v1';caseId:string;inputHash:string;threadId:string;obligationId:string;originalKind:string;source:IndependentSourceSpan;taskScopeHash:string;clause:string;clauseHash:string;requiredEvidenceRefs:string[];status:'needs_clarification';responseOnly:true;nativeState:'unverified';approvalVersion:string;reviewedAt:string;reviewer:IndependentExpectation['reviewer'];continuation?:{proof:DocumentRequestContinuation;digest:string}};
export type IndependentObligation={canonicalRequestAttestation?:IndependentCanonicalRequestAttestation;clarificationAttestation?:IndependentClarificationAttestation;kindAlternativeAttestation?:IndependentKindAlternativeAttestation;alternativeSourceSpans?:IndependentAlternativeSourceSpan[];id:string;kind:string;semanticTopic:string;required:true;source:IndependentSourceSpan;completion:{permittedTaskOutcomes:string[];requiresSourceEvidence:string[];focusedMissingTopics:string[];noSuccessFromUnavailable:true;staffOnlyHandoffCountsAsComplete:false;responseObligationCanBeSatisfiedByFocusedClarification?:boolean;responseObligationCanBeSatisfiedByExactRequestedArrivalAcknowledgement?:boolean;responseObligationCanBeSatisfiedByServerBoundRecipientHandling?:boolean;literalGuestClauseNotRequiredWhenServerBindingProvesRequestedHandling?:boolean;customerAcknowledgementNeverCompletesHotelPermission?:boolean;sourceTaskCompletedOnlyWhenOutcomeIn:string[];blockedCountsAsSuccessfulResponse:false;genericHandoffCountsAsSuccessfulResponse:false};expectedFacts:{path:string;value:unknown;source:IndependentSourceSpan}[]};
export type IndependentExpectation={schemaVersion:'reservationist-independent-expectations-v1';caseId:string;inputHash:string;groupId:string;lane:'development'|'holdout';reviewer:{type:'independent_ai';agent:string;model:string;reviewedAt:string;authorityRef:string;independentOfImplementationExecutor:true};reviewStatus:'independently_adjudicated';modelExecutionEligible:boolean;historicalSourceQualificationEligible:boolean;obligations:IndependentObligation[];approval:{status:'independently_adjudicated';version:string;reviewerRef:string;sourceHashes:string[]}};
export type IndependentCurrentResultObservation={version:'independent-current-result-observation-v1';observationKind:'saved_result_observed_currently';caseId:string;inputHash:string;runtimeDigest:string;observedAt:string;scope:{ownerRef:string;threadId:string;propertyCode:string};recipientProofs:{taskId:string;receiptDigest:string;headerSourceHash:string;mailboxSourceHash:string}[]};
export type IndependentCausalInput=Pick<BacktestCase,'threadId'|'trigger'|'context'>;
export type IndependentObligationScore={id:string;matchedTaskId:string|null;responseSatisfied:boolean;workCompleted:boolean;reasons:string[]};
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const records=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(record).filter((v):v is Record<string,unknown>=>v!==null):[];
const strings=(value:unknown):string[]=>Array.isArray(value)&&value.every(v=>typeof v==='string')?value:[];
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const sourceMessage=(input:IndependentCausalInput,span:IndependentSourceSpan)=>[input.trigger,...input.context].find(m=>m.id===span.messageId);
/** Evaluation mirrors the supported business board labels while extraction keeps original wording. */
const boardLabels:Readonly<Record<string,string>>={room_only:'room_only','room only':'room_only','room only r':'room_only',breakfast:'breakfast','bed & breakfast':'breakfast','bed and breakfast':'breakfast','bed & breakfast r':'breakfast',dinner_bed_breakfast:'dinner_bed_breakfast','dinner, bed & breakfast':'dinner_bed_breakfast','dinner, bed and breakfast':'dinner_bed_breakfast','dinner bed & breakfast':'dinner_bed_breakfast','dinner bed & breakfast r':'dinner_bed_breakfast','dinner, bed & breakfast r':'dinner_bed_breakfast','dinner, bed, breakfast & beverage r':'dinner_bed_breakfast'};
const canonicalBoard=(value:unknown):string|undefined=>{if(typeof value!=='string')return undefined;const label=value.toLowerCase().replace(/\s+/g,' ').trim();return Object.hasOwn(boardLabels,label)?boardLabels[label]:undefined;};
function validSpan(input:IndependentCausalInput,span:IndependentSourceSpan):boolean{
 const m=sourceMessage(input,span);
 return !!m&&typeof span.quote==='string'&&/^[a-f0-9]{64}$/.test(span.sourceHash)&&hash(m.text)===span.sourceHash&&Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)&&span.start>=0&&span.end>span.start&&span.end<=m.text.length&&m.text.slice(span.start,span.end)===span.quote&&!!m.eventAt&&!!input.trigger.eventAt&&Date.parse(m.eventAt)<=Date.parse(input.trigger.eventAt);
}
function kindMatches(kind:string,actual:string):boolean{return kind===actual||kind==='payment_status'&&actual==='question';}
function validAlternatives(obligation:IndependentObligation,expectation:IndependentExpectation,input:IndependentCausalInput):boolean{
 const alternatives=obligation.alternativeSourceSpans;if(alternatives===undefined)return true;
 if(!Array.isArray(alternatives)||!alternatives.length||alternatives.length>8||new Set(alternatives.map(a=>fingerprint(a.source))).size!==alternatives.length)return false;
 return alternatives.every(a=>{const r=a.review,m=sourceMessage(input,a.source),reviewer=r?.reviewer;
  return validSpan(input,a.source)&&a.source.messageId===obligation.source.messageId&&a.source.sourceHash===obligation.source.sourceHash&&a.source.messageId===input.trigger.id&&m?.direction==='inbound'&&expectation.approval.sourceHashes.includes(a.source.sourceHash)&&r?.version==='independent-exact-alternative-span-v1'&&r.caseId===expectation.caseId&&r.inputHash===expectation.inputHash&&r.threadId===input.threadId&&r.obligationId===obligation.id&&r.originalSourceDigest===fingerprint(obligation.source)&&r.messageAt===m.eventAt&&r.direction==='inbound'&&r.evaluatorOnly===true&&reviewer?.type==='independent_ai'&&!!reviewer.agent&&!!reviewer.model&&reviewer.authorityRef===expectation.reviewer.authorityRef&&reviewer.independentOfImplementationExecutor===true&&Number.isFinite(Date.parse(reviewer.reviewedAt))&&Date.parse(reviewer.reviewedAt)>=Date.parse(m.eventAt!);
 });
}
/** Exact original authored interval; newline offsets belong to the source and are never trimmed. */
function canonicalAuthoredEnd(text:string):number{
 const history=text.search(/^(?:[ \t]*>?[ \t]*(?:From:[ \t]|Sent:[ \t]|Subject:[ \t]|On [^\r\n]{1,250}(?:\r?\n[^\r\n]{1,250}){0,2}wrote:|Begin forwarded message:|Forwarded message:)|[ \t]*-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-{2,})/im);
 return history<0?text.length:history;
}
function canonicalWordBoundaries(text:string,start:number,end:number):boolean{
 const word=(v:string|undefined)=>v!==undefined&&/[\p{L}\p{N}_]/u.test(v);
 const boundary=(at:number)=>{
  if(at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1]!)&&/[\uDC00-\uDFFF]/.test(text[at]!))return false;
  const before=Array.from(text.slice(0,at)).at(-1),after=Array.from(text.slice(at)).at(0);
  return !(word(before)&&word(after));
 };
 return boundary(start)&&boundary(end);
}
function validCanonicalRequest(obligation:IndependentObligation,expectation:IndependentExpectation,input:IndependentCausalInput):boolean{
 const a=obligation.canonicalRequestAttestation;if(a===undefined)return true;
 if(!record(a)||![a.canonicalRequestSource,a.maximumTaskParentSource,a.currentAuthoredContextSource].every(s=>record(s)&&typeof s.messageId==='string'&&typeof s.sourceHash==='string'&&typeof s.quote==='string'&&Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end))||!record(a.reviewer))return false;
 const m=sourceMessage(input,a.canonicalRequestSource),r=a.reviewer;
 if(a.version!=='independent-canonical-request-containment-v1'||a.caseId!==expectation.caseId||a.inputHash!==expectation.inputHash||a.threadId!==input.threadId||a.obligationId!==obligation.id||obligation.kind!=='quote'||a.originalKind!=='quote'||a.originalSourceDigest!==fingerprint(obligation.source)||a.taskScopeHash!==fingerprint({kind:obligation.kind,source:obligation.source,completion:obligation.completion})||a.responseTaskContainsCanonicalRequestSource!==true||a.evaluatorOnly!==true||a.responseOnly!==true||a.nativeState!=='unverified'||r?.type!=='independent_ai'||!r.agent||!r.model||r.authorityRef!==expectation.reviewer.authorityRef||r.independentOfImplementationExecutor!==true||!Number.isFinite(Date.parse(r.reviewedAt))||Date.parse(r.reviewedAt)>Date.now()||Date.parse(r.reviewedAt)<Date.parse(m?.eventAt??''))return false;
 const spans=[a.canonicalRequestSource,a.maximumTaskParentSource,a.currentAuthoredContextSource];if(!m||m.id!==input.trigger.id||m.direction!=='inbound'||a.direction!=='inbound'||a.messageAt!==m.eventAt||spans.some(s=>!validSpan(input,s)||s.messageId!==obligation.source.messageId||s.sourceHash!==obligation.source.sourceHash)||!expectation.approval.sourceHashes.includes(a.canonicalRequestSource.sourceHash))return false;
 const c=a.canonicalRequestSource,p=a.maximumTaskParentSource,x=a.currentAuthoredContextSource;if(x.start!==0||x.end!==canonicalAuthoredEnd(m.text)||!canonicalWordBoundaries(m.text,c.start,c.end)||!canonicalWordBoundaries(m.text,p.start,p.end)||x.start>p.start||x.end<p.end||p.start>c.start||p.end<c.end||c.quote.length<8||p.quote.length>4096||x.quote.length>40000||! /\b(?:provide|request|send|quote)\b[\s\S]*\b(?:rates?|prices?|quotation|quote)\b/i.test(c.quote))return false;
 if(/^\s*>/m.test(x.quote)||/\b(?:not|never|don't|do not|if|unless|without|whether|withdraw|disregard|ignore|previous|historical|other property|another property)\b/i.test(x.quote)||/\b(?:and\s+(?:advise|provide|send|review)|payment\s+links?|vouchers?|invoices?)\b/i.test(p.quote))return false;
 return true;
}
function canonicalTaskSourceMatches(obligation:IndependentObligation,task:RuntimeTask,input:IndependentCausalInput):boolean{
 const a=obligation.canonicalRequestAttestation,s=task.source;if(!a||!s||s.page!==1||s.start===undefined||s.end===undefined||s.quote===undefined||task.kind!==obligation.kind)return false;
 const exact=(p:IndependentSourceSpan)=>s.attachmentId===`message:${p.messageId}`&&s.sourceHash===p.sourceHash&&s.start===p.start&&s.end===p.end&&s.quote===p.quote;
 if(exact(obligation.source)||obligation.alternativeSourceSpans?.some(v=>exact(v.source)))return true;
 const c=a.canonicalRequestSource,p=a.maximumTaskParentSource,m=sourceMessage(input,c);if(!m||s.attachmentId!==`message:${c.messageId}`||s.sourceHash!==c.sourceHash||!Number.isSafeInteger(s.start)||!Number.isSafeInteger(s.end)||s.start<p.start||s.end>p.end||s.start>c.start||s.end<c.end||m.text.slice(s.start,s.end)!==s.quote)return false;
 return canonicalWordBoundaries(m.text,s.start,s.end);
}
function validKindAlternative(obligation:IndependentObligation,expectation:IndependentExpectation,input:IndependentCausalInput):boolean{
 const a=obligation.kindAlternativeAttestation;if(a===undefined)return true;const m=sourceMessage(input,obligation.source),reviewer=a.reviewer;
 return a.version==='independent-exact-kind-alternative-v1'&&['cancel_request','new_booking'].includes(obligation.kind)&&a.originalKind===obligation.kind&&Array.isArray(a.alternativeKinds)&&a.alternativeKinds.length===1&&a.alternativeKinds[0]==='change'&&validSpan(input,a.source)&&fingerprint(a.source)===fingerprint(obligation.source)&&a.source.messageId===input.trigger.id&&m?.direction==='inbound'&&expectation.approval.sourceHashes.includes(a.source.sourceHash)&&a.caseId===expectation.caseId&&a.inputHash===expectation.inputHash&&a.threadId===input.threadId&&a.obligationId===obligation.id&&a.originalSourceDigest===fingerprint(obligation.source)&&a.taskScopeHash===fingerprint({kind:obligation.kind,source:obligation.source,focusedMissingTopics:obligation.completion.focusedMissingTopics})&&a.messageAt===m.eventAt&&a.direction==='inbound'&&a.evaluatorOnly===true&&a.responseOnly===true&&a.nativeState==='unverified'&&reviewer?.type==='independent_ai'&&!!reviewer.agent&&!!reviewer.model&&reviewer.authorityRef===expectation.reviewer.authorityRef&&reviewer.independentOfImplementationExecutor===true&&Number.isFinite(Date.parse(reviewer.reviewedAt))&&Date.parse(reviewer.reviewedAt)>=Date.parse(m.eventAt!);
}
function validClarificationAttestation(o:IndependentObligation,e:IndependentExpectation,c:IndependentCausalInput):boolean{
 const a=o.clarificationAttestation;if(a===undefined)return true;
 const reviewer=a?.reviewer,m=sourceMessage(c,o.source),at=Date.parse(a?.reviewedAt),reviewAt=Date.parse(reviewer?.reviewedAt??'');
 if(!a||a.version!=='independent-exact-clarification-v1'||a.caseId!==e.caseId||a.inputHash!==e.inputHash||a.threadId!==c.threadId||a.obligationId!==o.id||a.originalKind!==o.kind||fingerprint(a.source)!==fingerprint(o.source)||!validSpan(c,a.source)||a.taskScopeHash!==fingerprint({kind:o.kind,source:o.source,focusedMissingTopics:o.completion.focusedMissingTopics})||typeof a.clause!=='string'||!a.clause.trim()||a.clause.length>4000||hash(a.clause)!==a.clauseHash||a.status!=='needs_clarification'||a.responseOnly!==true||a.nativeState!=='unverified'||a.approvalVersion!==e.approval.version||!Number.isFinite(at)||at<Date.parse(c.trigger.eventAt??'')||reviewAt!==at||at>Date.now()||reviewer?.type!=='independent_ai'||!reviewer.agent||!reviewer.model||reviewer.authorityRef!==e.reviewer.authorityRef||reviewer.independentOfImplementationExecutor!==true||!e.approval.sourceHashes.includes(a.source.sourceHash)||m?.direction!=='inbound'||!Array.isArray(a.requiredEvidenceRefs)||a.requiredEvidenceRefs.length<1||a.requiredEvidenceRefs.length>2||new Set(a.requiredEvidenceRefs).size!==a.requiredEvidenceRefs.length)return false;
 if(a.source.messageId===c.trigger.id)return a.continuation===undefined&&a.requiredEvidenceRefs.length===1&&a.requiredEvidenceRefs[0]===`message:${a.source.messageId}`;
 if(o.kind!=='existing_document'||!a.continuation||a.continuation.proof.taskId!==undefined||a.continuation.digest!==fingerprint(a.continuation.proof))return false;
 const proof=a.continuation.proof,messages=[...c.context,c.trigger].map(m=>({id:m.id,at:m.eventAt??'',text:m.text,direction:m.direction as 'inbound'|'outbound'}));
 if(!deriveDocumentRequestContinuations({messages,triggerMessageId:c.trigger.id,causalAt:c.trigger.eventAt??''}).some(p=>fingerprint(p)===a.continuation!.digest))return false;
 return proof.priorRequestSource.attachmentId===`message:${a.source.messageId}`&&proof.priorRequestSource.sourceHash===a.source.sourceHash&&proof.priorRequestSource.start===a.source.start&&proof.priorRequestSource.end===a.source.end&&proof.priorRequestSource.quote===a.source.quote&&a.requiredEvidenceRefs.length===2&&a.requiredEvidenceRefs.includes(proof.priorRequestSource.attachmentId)&&a.requiredEvidenceRefs.includes(proof.currentActivationSource.attachmentId);
}
function belongsToTask(value:Record<string,unknown>,taskId:string):boolean{return value.taskId===taskId||['binding','input','observation','value'].some(key=>record(value[key])?.taskId===taskId)||String(value.key??'').endsWith(`_${taskId}`);}
function exactReviewedClarification(o:IndependentObligation,t:RuntimeTaskResult,planned:RuntimeTask,c:IndependentCausalInput,runtime:Record<string,unknown>,planFacts:unknown):boolean{
 const a=o.clarificationAttestation,s=planned.source;if(!a||t.status!=='needs_clarification'||o.completion.responseObligationCanBeSatisfiedByFocusedClarification!==true||t.guestText!==a.clause||!s||s.attachmentId!==`message:${a.source.messageId}`||s.sourceHash!==a.source.sourceHash||s.page!==1||s.start!==a.source.start||s.end!==a.source.end||s.quote!==a.source.quote||t.evidenceRefs.length!==a.requiredEvidenceRefs.length||!a.requiredEvidenceRefs.every(ref=>t.evidenceRefs.includes(ref)))return false;
 const ids=(planned as RuntimeTask&{factIds?:string[]}).factIds;if(ids!==undefined&&(!Array.isArray(ids)||ids.length))return false;if(records(planFacts).some(f=>belongsToTask(f,t.id))||['preparedFacts','packets','existingDocumentReceipts','readReceipts','currentNativeObservations','artifacts'].some(key=>records(runtime[key]).some(value=>belongsToTask(value,t.id)||(key==='artifacts'&&t.evidenceRefs.includes(String(value.ref))))))return false;
 const text=t.guestText;if(/\b(?:confirmed|completed|cleared|included|guaranteed|saved|booked|created|cancelled|canceled|approved|executed|attached|sent|delivered)\b/i.test(text.replace(/completion remains unverified/g,'')))return false;
 if(a.continuation){if(!/^Staff must verify the invoice for the current booking request against the original workflow sources; its completion remains unverified[.]$/.test(text))return false;}else if(o.kind==='acceptance'){if(!/^Staff must verify the accepted offer and requested booking details against the original sources before preparing the booking[.]$/.test(text))return false;}else if(['change','new_booking','cancel_request'].includes(o.kind)){const quote=o.source.quote.replace(/[\r\n]+/g,' ').trim(),topic=/\b(?:remove|removed|removal)\b/i.test(quote)?'allocation removal':/\b(?:add|added|addition)\b/i.test(quote)?'allocation addition':'booking changes',expected=`Staff must verify the requested ${topic} and applicable booking details against the original sources before preparing the amendment. Requested amendment: “${quote}”`;if(text!==expected)return false;}else return false;
 if(a.continuation){try{assertDocumentRequestContinuation({...a.continuation.proof,taskId:planned.id},{messages:[...c.context,c.trigger].map(m=>({id:m.id,at:m.eventAt??'',text:m.text,direction:m.direction as 'inbound'|'outbound'})),triggerMessageId:c.trigger.id,causalAt:c.trigger.eventAt??''},{id:planned.id,kind:'existing_document',factIds:[],source:s});}catch{return false;}}
 return true;
}
function usesKindAlternative(obligation:IndependentObligation,task:RuntimeTask):boolean{return !kindMatches(obligation.kind,task.kind)&&obligation.kindAlternativeAttestation?.alternativeKinds.includes(task.kind as 'change')===true;}
function exactAlternativeTaskSource(obligation:IndependentObligation,task:RuntimeTask):boolean{const a=obligation.kindAlternativeAttestation,s=task.source;return !!a&&!!s&&s.page===1&&s.attachmentId===`message:${a.source.messageId}`&&s.sourceHash===a.source.sourceHash&&s.start===a.source.start&&s.end===a.source.end&&s.quote===a.source.quote;}
function matchingTasks(obligation:IndependentObligation,plan:RuntimePlan,input:IndependentCausalInput,applyCanonicalRequest=true):RuntimeTask[]{
 return plan.tasks.filter(task=>{
  const s=task.source;if((!kindMatches(obligation.kind,task.kind)&&!usesKindAlternative(obligation,task))||!s||s.page!==1||s.start===undefined||s.end===undefined||s.quote===undefined)return false;
  if(usesKindAlternative(obligation,task))return exactAlternativeTaskSource(obligation,task);
  if(applyCanonicalRequest&&obligation.canonicalRequestAttestation)return canonicalTaskSourceMatches(obligation,task,input);
  const primary=obligation.source;
  const primaryBound=s.attachmentId===`message:${primary.messageId}`&&s.sourceHash===primary.sourceHash;
  const contains=primaryBound&&s.start<=primary.start&&s.end>=primary.end;
  const anchors=obligation.semanticTopic.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&!['the','for','and','existing','applicable','options','details','policy','request','review','accommodation','booking'].includes(w));
  const narrower=primaryBound&&s.start>=primary.start&&s.end<=primary.end&&anchors.some(w=>new RegExp(`\\b${w}\\b`,'i').test(s.quote!));
  const exactAlternative=obligation.alternativeSourceSpans?.some(a=>s.attachmentId===`message:${a.source.messageId}`&&s.sourceHash===a.source.sourceHash&&s.start===a.source.start&&s.end===a.source.end&&s.quote===a.source.quote)===true;
  if(!contains&&!narrower&&!exactAlternative)return false;
  const m=sourceMessage(input,primary);return !!m&&m.text.slice(s.start,s.end)===s.quote;
 });
}
function focused(obligation:IndependentObligation,text:string):boolean{
 const terms=obligation.completion.focusedMissingTopics.map(s=>s.toLowerCase()).filter(Boolean);
 return terms.some(term=>new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[^a-z0-9])`,'i').test(text));
}
/** A named source prerequisite is an honest response, never completed source work. */
function focusedSourcePrerequisite(obligation:IndependentObligation,text:string):boolean{
 const match=/^Staff must verify (.{1,160}) against the applicable source before answering this request[.]$/i.exec(text.trim());
 if(!match||/\b(?:confirmed|completed|cleared|included|guaranteed|available)\b/i.test(match[1]!))return false;
 const normalize=(value:string)=>value.toLowerCase().replace(/\bcancellation\s+terms\b/g,'cancellation policy').replace(/\bcopy-all email addresses\b/g,'reply recipient scope');
 return obligation.completion.focusedMissingTopics.some(topic=>{const escaped=normalize(topic).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`,'i').test(normalize(match[1]!));});
}
function sourceTaskProof(obligation:IndependentObligation,task:RuntimeTaskResult,runtime:Record<string,unknown>,sourceAt:string,causalInput:IndependentCausalInput):boolean{
 if(obligation.completion.responseObligationCanBeSatisfiedByServerBoundRecipientHandling===true||obligation.completion.requiresSourceEvidence.includes('existing_mailbox_recipient_authorization'))return false;
 if(!obligation.completion.sourceTaskCompletedOnlyWhenOutcomeIn.includes(task.status)||!task.evidenceRefs.length)return false;
 const artifacts=records(runtime.artifacts).filter(a=>task.evidenceRefs.includes(String(a.ref))&&a.mimeType==='application/pdf'&&/^[a-f0-9]{64}$/.test(String(a.sha256))&&Number.isSafeInteger(a.sizeBytes)&&Number(a.sizeBytes)>0);
 if(obligation.kind==='quote'){
  const refs=strings(runtime.quoteRefs),offers=[...records(runtime.quoteRevisions),...records(runtime.importedOffers),...records(runtime.approvedOverrides)];
  if(!artifacts.length||!offers.some(o=>refs.includes(String(o.id))&&Number.isSafeInteger(o.totalMinor??o.approvedTotalMinor)&&Number(o.totalMinor??o.approvedTotalMinor)>=0&&!!o.authorizationId&&/^[a-f0-9]{64}$/.test(String(o.scopeDigest))&&(Array.isArray(o.groups)?records(o.groups).every(g=>task.evidenceRefs.includes(String(g.sourceRef))):task.evidenceRefs.includes(String(o.ref)))))return false;
  try{assertReservationistResultFreshForAction({version:1,quoteRevisions:runtime.quoteRevisions,importedOffers:runtime.importedOffers,approvedOverrides:runtime.approvedOverrides},new Date(sourceAt));return true;}catch{return false;}
 }
 if(obligation.kind==='existing_document'){
  const receipts=records(runtime.existingDocumentReceipts).filter(r=>{const b=record(r.binding),c=record(r.capture),body=record(c?.body),i=record(r.input),source=record(i?.taskSource);return b?.taskId===task.id&&b.threadId===causalInput.threadId&&b.triggerMessageId===causalInput.trigger.id&&source?.sourceRef===`message:${obligation.source.messageId}`&&source.sourceHash===obligation.source.sourceHash&&[obligation.source,...(obligation.alternativeSourceSpans??[]).map(a=>a.source)].some(span=>source?.sourceRef===`message:${span.messageId}`&&source.sourceHash===span.sourceHash&&Number(source.start)<=span.start&&Number(source.end)>=span.end)&&artifacts.some(a=>c?.artifactRef===a.ref&&body?.sha256===a.sha256&&body?.sizeBytes===a.sizeBytes);});
  if(!receipts.length)return false;
  try{const targets=receipts.map(r=>{const b=record(r.binding);return{reservationRef:b?.reservationRef??null,...(b?.priorQuoteRef!==undefined?{priorQuoteRef:b.priorQuoteRef}:{})} as ReservationistExistingDocumentTarget;});assertReservationistExistingDocumentTargets(obligation.source.quote,targets);}catch{return false;}
  try{assertReservationistResultFreshForAction({version:1,tasks:[task],existingDocumentReceipts:receipts},new Date(sourceAt));return true;}catch{return false;}
 }
 if(['acceptance','new_booking','change','cancel_request','channel_booking_sync'].includes(obligation.kind)){
  const expected=obligation.kind==='acceptance'?'accepted_quote':obligation.kind;
  const packets=records(runtime.packets).filter(p=>p.taskId===task.id&&p.kind===expected&&p.saved===false&&p.status==='pending_pms_action'&&p.businessRulesValidated===true);
  if(packets.length!==1)return false;
  const p=packets[0];
  if(obligation.kind==='change'||obligation.kind==='cancel_request'||obligation.kind==='channel_booking_sync'){
   const binding=record(p.requestBinding);if(binding?.requestId!==causalInput.trigger.id||binding.threadId!==causalInput.threadId||binding.sourceRef!==`message:${obligation.source.messageId}`||binding.sourceHash!==obligation.source.sourceHash)return false;
  }
  if(['accepted_quote','new_booking'].includes(expected)&&(!p.schemaValid||!Array.isArray(p.rooms)||!p.rooms.length||p.nativeSaveAcceptance!=='untested'))return false;
  try{assertReservationistResultFreshForAction({version:1,tasks:[task],packets},new Date(sourceAt));return true;}catch{return false;}
 }
 const facts=records(runtime.preparedFacts).filter(f=>record(f.value)?.authority!=='customer_claim'&&f.authority==='authorized'&&f.status==='known'&&f.scopeVerified===true&&f.disclosure!=='staff_only'&&task.evidenceRefs.includes(String(f.evidenceRef)));
 if(obligation.kind==='payment_status'){
  const receipts=records(runtime.readReceipts).filter(r=>{const b=record(r.binding);return b?.taskId===task.id&&b.threadId===causalInput.threadId&&b.triggerMessageId===causalInput.trigger.id&&records(r.sourceProofs).length>0;});
  if(receipts.length!==1||!facts.some(f=>/deposit|payment|folio/.test(String(f.key))))return false;
  try{assertReservationistResultFreshForAction({version:1,tasks:[task],readReceipts:receipts},new Date(sourceAt));return true;}catch{return false;}
 }
 return facts.some(f=>focused(obligation,String(f.key)+' '+String(f.label)));
}
function currentRecipientResponse(obligation:IndependentObligation,task:RuntimeTaskResult,planned:RuntimeTask,runtime:Record<string,unknown>,causal:IndependentCausalInput,expectation:IndependentExpectation,observation:IndependentCurrentResultObservation|undefined):boolean{
 if(obligation.kind!=='question'||obligation.completion.responseObligationCanBeSatisfiedByServerBoundRecipientHandling!==true||!obligation.completion.requiresSourceEvidence.includes('existing_mailbox_recipient_authorization')||task.status!=='complete'||task.guestText!==RECIPIENT_PREPARATION_CLAUSE||!observation||observation.version!=='independent-current-result-observation-v1'||observation.observationKind!=='saved_result_observed_currently'||observation.caseId!==expectation.caseId||observation.inputHash!==expectation.inputHash||observation.runtimeDigest!==fingerprint(runtime)||!Number.isFinite(Date.parse(observation.observedAt))||observation.scope?.threadId!==causal.threadId||!observation.scope.ownerRef||!observation.scope.propertyCode||!Array.isArray(observation.recipientProofs)||observation.recipientProofs.length>32)return false;
 const receipts=records(runtime.recipientPreparations).filter(r=>record(r.input)?.taskId===task.id),proofs=observation.recipientProofs.filter(p=>p.taskId===task.id);
 if(receipts.length!==1||proofs.length!==1)return false;
 try{
  const receipt=receipts[0]!,at=new Date(observation.observedAt);assertReservationistRecipientReceipt(receipt,at);
  const input=receipt.input,original=causal.trigger,source=planned.source,proof=proofs[0]!;
  if(!source||original.id!==obligation.source.messageId||original.direction!=='inbound'||input.requestId!==original.id||input.triggerMessageId!==original.id||input.threadId!==causal.threadId||input.ownerRef!==observation.scope.ownerRef||input.propertyCode!==observation.scope.propertyCode||input.originalRequest.text!==original.text||input.originalRequest.at!==original.eventAt||fingerprint(input.taskSource)!==fingerprint(source)||proof.receiptDigest!==receipt.digest||proof.headerSourceHash!==input.headerProof.sourceRowHash||proof.mailboxSourceHash!==input.mailboxSource.sourceHash||!task.evidenceRefs.includes(`message:${original.id}`))return false;
  const text=typeof runtime.textBody==='string'?runtime.textBody:'',html=typeof runtime.htmlBody==='string'?runtime.htmlBody:'';
  if([...receipt.prepared.to,...receipt.prepared.cc,...receipt.prepared.bcc].some(address=>text.toLowerCase().includes(address.toLowerCase())||html.toLowerCase().includes(address.toLowerCase())))return false;
  assertReservationistResultFreshForAction({...runtime,version:1},at);return true;
 }catch{return false;}
}
function requestedArrivalResponse(obligation:IndependentObligation,task:RuntimeTaskResult,runtime:Record<string,unknown>,input:IndependentCausalInput):boolean{
 if(obligation.kind!=='question'||obligation.completion.responseObligationCanBeSatisfiedByExactRequestedArrivalAcknowledgement!==true||obligation.completion.customerAcknowledgementNeverCompletesHotelPermission!==true||task.status!=='complete')return false;
 const message=sourceMessage(input,obligation.source);if(!message||message.id!==input.trigger.id||message.direction!=='inbound')return false;
 const match=/^I (?:will|would) like to check[ -]?in by ((?:[1-9]|1[0-2])(?::[0-5]\d)?\s?(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d)[.]?$/i.exec(obligation.source.quote.trim());if(!match)return false;
 const time=match[1],exact=`We have noted your request to check in by ${time}. Staff must verify the requested arrival time.`;
 if(task.guestText!==exact||!task.evidenceRefs.includes(`message:${message.id}`))return false;
 const facts=records(runtime.preparedFacts).filter(f=>f.key===`requested_arrival_time_${task.id}`&&f.source==='inbound'&&f.authority==='authorized'&&f.status==='known'&&f.disclosure==='guest'&&f.scopeVerified===true&&f.evidenceRef===`message:${message.id}`&&f.sourceHash===obligation.source.sourceHash);
 const value=record(facts[0]?.value);return facts.length===1&&value?.requestedTime===time&&value.authority==='customer_claim'&&value.hotelPermission==='unverified';
}
/** Evaluation-only boundary. The causal runner never receives this expectation envelope. */
export function scoreIndependentReservationistEvaluation(input:{expectation:IndependentExpectation;causalInput:IndependentCausalInput;plan:RuntimePlan;runtime:unknown;sourceAt?:string;currentResultObservation?:IndependentCurrentResultObservation}){
 const {expectation:e,causalInput:c,plan}=input,r=record(input.runtime),globalReasons:string[]=[];
 const obligations=Array.isArray(e?.obligations)?e.obligations:[];
 const provenanceValid=e?.schemaVersion==='reservationist-independent-expectations-v1'&&e.caseId===c?.trigger?.id&&e.inputHash===fingerprint({trigger:c.trigger,context:c.context})&&e.reviewer?.type==='independent_ai'&&e.reviewer.independentOfImplementationExecutor===true&&!!e.reviewer.agent&&!!e.reviewer.model&&!!e.reviewer.authorityRef&&Number.isFinite(Date.parse(e.reviewer.reviewedAt))&&e.reviewStatus==='independently_adjudicated'&&e.approval?.status==='independently_adjudicated'&&!!e.approval.version&&!!e.approval.reviewerRef&&e.approval.sourceHashes.length>0&&e.approval.sourceHashes.every(s=>/^[a-f0-9]{64}$/.test(s))&&obligations.length>0&&obligations.length<=32&&new Set(obligations.map(o=>o.id)).size===obligations.length&&obligations.every(o=>o.required===true&&validSpan(c,o.source)&&validAlternatives(o,e,c)&&validCanonicalRequest(o,e,c)&&validKindAlternative(o,e,c)&&validClarificationAttestation(o,e,c)&&e.approval.sourceHashes.includes(o.source.sourceHash)&&o.expectedFacts.every(f=>validSpan(c,f.source))&&o.completion.noSuccessFromUnavailable===true&&o.completion.staffOnlyHandoffCountsAsComplete===false&&o.completion.blockedCountsAsSuccessfulResponse===false&&o.completion.genericHandoffCountsAsSuccessfulResponse===false);
 if(!provenanceValid)globalReasons.push('expectation_provenance_invalid');
 const planValid=Array.isArray(plan.tasks)&&plan.tasks.length<=32&&new Set(plan.tasks.map(t=>t.id)).size===plan.tasks.length;
 if(!planValid)globalReasons.push('actual_plan_invalid');
 const tasks=records(r?.tasks),body=typeof r?.textBody==='string'?r.textBody:'';
 const runtimeSafe=!!r&&r.version==='reservationist-runtime-v1'&&record(r.assessment)?.ok===true&&Array.isArray(r.errors)&&r.errors.length===0&&['ready_for_staff_review','pending_pms_action','needs_clarification'].includes(String(r.readiness))&&new Set(tasks.map(t=>t.id)).size===tasks.length;
 if(!runtimeSafe)globalReasons.push('runtime_not_safe');
 const matched=new Set<string>();let alternativeResponseUsed=false,canonicalResponseUsed=false;
 const expectedFactMatches=(expected:IndependentObligation['expectedFacts'][number]):boolean=>{
  const get=(value:unknown,path:string):unknown=>path.split('.').reduce<unknown>((current,key)=>record(current)?.[key],value);
  return records(plan.facts).some(f=>{const source=record(f.source);if(source?.attachmentId!==`message:${expected.source.messageId}`||source.sourceHash!==expected.source.sourceHash)return false;const value=f.value;
   if(expected.path==='stay.arrival')return record(value)?.arrival===expected.value;
   if(expected.path==='stay.departure')return record(value)?.departure===expected.value;
   if(expected.path==='stay.customerClaim'){const dates=record(value),claim=record(expected.value);return dates?.arrival===claim?.arrival&&dates?.departure===claim?.departure;}
   if(expected.path==='board'){const actual=canonicalBoard(typeof value==='string'?value:record(value)?.board),wanted=canonicalBoard(expected.value);return f.kind==='board'&&actual!==undefined&&wanted!==undefined&&actual===wanted;}
   const actual=get(value,expected.path);return actual!==undefined&&expected.value!==undefined&&fingerprint(actual)===fingerprint(expected.value);
  });
 };
 const scores:IndependentObligationScore[]=obligations.map(o=>{
  const reasons:string[]=[];let chosen:RuntimeTask|undefined;
  if(o.expectedFacts.some(f=>!expectedFactMatches(f)))reasons.push('expected_fact_missing_or_mismatch');
  if(provenanceValid&&planValid){const candidates=matchingTasks(o,plan,c).filter(t=>!matched.has(t.id));if(candidates.length===1)chosen=candidates[0];else reasons.push(candidates.length?'obligation_task_ambiguous':'obligation_task_missing');}
  if(chosen)matched.add(chosen.id);
  const canonicalOnly=!!chosen&&!!o.canonicalRequestAttestation&&!matchingTasks(o,plan,c,false).some(t=>t.id===chosen.id);
  const raw=chosen?tasks.find(t=>t.id===chosen.id):undefined;
  const task=raw&&typeof raw.guestText==='string'&&Array.isArray(raw.evidenceRefs)&&raw.evidenceRefs.every(v=>typeof v==='string')?raw as unknown as RuntimeTaskResult:undefined;
  if(!task)reasons.push('obligation_result_missing');
  const visible=!!task&&task.disclosure!=='staff_only'&&!!task.guestText.trim()&&body.includes(task.guestText);
  if(task&&!visible)reasons.push('obligation_response_not_visible');
  let workCompleted=false,responseSatisfied=false;
  if(task&&chosen&&runtimeSafe&&visible&&o.completion.permittedTaskOutcomes.includes(task.status)){
   const alternative=usesKindAlternative(o,chosen);
   if(exactReviewedClarification(o,task,chosen,c,r!,plan.facts)){responseSatisfied=true;alternativeResponseUsed=true;}else if(alternative){
    const nativeAssertion=/\b(?:confirmed|completed|cleared|included|guaranteed|saved|booked|created|cancelled|canceled|approved|executed|available)\b/i.test(task.guestText);
    if(task.status==='needs_clarification'&&o.completion.responseObligationCanBeSatisfiedByFocusedClarification!==false&&task.evidenceRefs.includes(`message:${o.source.messageId}`)&&!nativeAssertion&&(/\b(?:please|confirm|clarify|provide|specify|which|what|missing|unavailable|required|unable|cannot|need)\b|\b(?:could|can|would) you\b|not available|could not/i.test(task.guestText)&&focused(o,task.guestText)||focusedSourcePrerequisite(o,task.guestText))){responseSatisfied=true;alternativeResponseUsed=true;}else reasons.push('kind_alternative_response_invalid');
   }else{
   const sourceProof=sourceTaskProof(o,task,r!,input.sourceAt??c.trigger.eventAt??'',c);
   workCompleted=!canonicalOnly&&sourceProof;
   if(sourceProof)responseSatisfied=true;
   else if(currentRecipientResponse(o,task,chosen,r!,c,e,input.currentResultObservation))responseSatisfied=true;
   else if(requestedArrivalResponse(o,task,r!,c))responseSatisfied=true;
   else if(task.status==='needs_clarification'&&o.completion.responseObligationCanBeSatisfiedByFocusedClarification!==false&&(focusedSourcePrerequisite(o,task.guestText)||/\b(?:please|confirm|clarify|provide|specify|which|what|missing|unavailable|required|unable|cannot|need)\b|\b(?:could|can|would) you\b|not available|could not/i.test(task.guestText)&&focused(o,task.guestText)))responseSatisfied=true;
   else reasons.push(task.status==='needs_clarification'?'clarification_topic_missing':'source_task_proof_missing');
   }
  }else if(task)reasons.push('obligation_outcome_invalid');
  if(!provenanceValid||!planValid||!runtimeSafe||reasons.includes('expected_fact_missing_or_mismatch')){workCompleted=false;responseSatisfied=false;}
  if(canonicalOnly&&responseSatisfied)canonicalResponseUsed=true;
  return {id:o.id,matchedTaskId:chosen?.id??null,responseSatisfied,workCompleted,reasons};
 });
 const responseComplete=provenanceValid&&runtimeSafe&&scores.length>0&&scores.every(s=>s.responseSatisfied),workComplete=responseComplete&&scores.every(s=>s.workCompleted);
 return {caseId:e.caseId,provenanceValid,pass:responseComplete,responseComplete,workComplete,eligibleForModelEvaluation:provenanceValid&&e.modelExecutionEligible,qualificationEligible:provenanceValid&&e.historicalSourceQualificationEligible&&!alternativeResponseUsed&&!canonicalResponseUsed,canonicalResponseUsed,obligations:scores,counts:{required:scores.length,responseSatisfied:scores.filter(s=>s.responseSatisfied).length,workCompleted:scores.filter(s=>s.workCompleted).length,matchedTasks:provenanceValid&&planValid?scores.filter(s=>s.matchedTaskId!==null).length:0,expectedFacts:obligations.reduce((sum,o)=>sum+o.expectedFacts.length,0),expectedFactsMatched:provenanceValid&&planValid?obligations.reduce((sum,o)=>sum+o.expectedFacts.filter(expectedFactMatches).length,0):0},reasons:globalReasons};
}
