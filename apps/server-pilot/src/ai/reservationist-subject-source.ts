import {createHash} from 'node:crypto';
import type {ReservationistRuntimeInput} from './reservationist-runtime.js';
import type {ValidatedDocumentFact,ValidatedDocumentPlan} from './reservationist-document-facts.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const excluded=/\b(?:fwd|fw|forwarded|another|other|different|instead|except|not|never|no|disregard|withdraw|actually|correction|cancelled|canceled|previous|old)\b/i;
export function isReservationistSubjectSourceEligible(subject:string):boolean{return !excluded.test(subject)&&!/[\r\n]/.test(subject);}
/** Original subject is context for an exact current request, never native authority or a fresh task. */
export function assertReservationistSubjectReference(fact:ValidatedDocumentFact,task:ValidatedDocumentPlan['tasks'][number],input:ReservationistRuntimeInput):void{
 const source=fact.source,message=input.messages.find(m=>`message-subject:${m.id}`===source.attachmentId),ask=task.source;
 if(fact.kind!=='reservation_reference'||fact.disclosure!=='guest'||fact.authority!=='customer_claim'||fact.verification!=='text_verified'||!message||message.id!==input.trigger.id||message.direction!=='inbound'||message.disclosure==='staff_only'||message.at!==input.trigger.at||message.at!==input.clock.causalAt||typeof message.subject!=='string'||message.subject.length>4096||source.page!==1||source.sourceHash!==hash(message.subject)||source.quote===undefined||source.start===undefined||source.end===undefined||source.start<0||source.end-source.start!==source.quote.length||message.subject.slice(source.start,source.end)!==source.quote||!isReservationistSubjectSourceEligible(message.subject)||ask.attachmentId!==`message:${message.id}`||ask.sourceHash!==hash(message.text)||ask.quote===undefined||ask.start===undefined||ask.end===undefined||message.text.slice(ask.start,ask.end)!==ask.quote||ask.end-ask.start!==ask.quote.length||task.kind==='quote'||!['existing_document','question','change','cancel_request'].includes(task.kind))throw new Error('subject_reference_scope_denied');
 const history=message.text.search(/^(?:From:\s|Sent:\s|Subject:\s|On [^\r\n]{1,250}(?:\r?\n[^\r\n]{1,250}){0,2}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im),authored=history<0?message.text:message.text.slice(0,history);
 if(ask.end>authored.length||excluded.test(authored)||/^\s*>/m.test(authored))throw new Error('subject_reference_request_denied');
 const refs=[...message.subject.matchAll(/(?<![A-Za-z0-9_-])\d{6,12}(?:-\d+)?(?![A-Za-z0-9_-])/g)];
 if(refs.length!==1||refs[0][0]!==fact.value||!/\b(?:confirmation\s+letter|reservation|booking)\b/i.test(message.subject.replace(/_/g,' '))||!source.quote.includes(fact.value))throw new Error('subject_reference_literal_denied');
 const bodyRefs=[...authored.matchAll(/\b(?:(?:reservation|booking|confirmation(?:\s+letter)?)\s*(?:(?:reference|ref|number|no\.?|id)\s*[:#-]?\s*)?|(?:reference|ref)\s*[:#-]?\s*)[:#-]?\s*(\d{6,12}(?:-\d+)?)(?![A-Za-z0-9_-])/gi)].map(m=>m[1]);
 if(bodyRefs.some(ref=>ref!==fact.value))throw new Error('subject_reference_body_conflict');
}
