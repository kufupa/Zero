import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ValidatedDocumentPlan} from './reservationist-document-facts.js';
type Source=ValidatedDocumentPlan['tasks'][number]['source'];
type Message={id:string;at:string;text:string;direction?:'inbound'|'outbound';disclosure?:'guest'|'staff_only'};
export type DocumentRequestContinuation={id:string;taskId?:string;kind:'invoice_continuation';priorRequestSource:Source;currentActivationSource:Source;closure:'unverified'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const history=(text:string)=>text.search(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,})/im);
const authoredText=(text:string)=>{const cut=history(text);return cut<0?text:text.slice(0,cut);};
const paragraph=(text:string,index:number)=>{const left=text.lastIndexOf('\n\n',index),right=text.indexOf('\n\n',index);return text.slice(left<0?0:left+2,right<0?text.length:right).trim();};
const blocked=(text:string)=>/\b(?:withdraw\w*|supersed\w*|cancel\w*|disregard|ignore|already\s+(?:sent|received|paid)|(?:received|sent|delivered|paid)\s+(?:(?:the|your|our|my|their)\s+)?(?:final\s+)?invoice|invoice[^.!?;\n]{0,60}\b(?:received|sent|delivered|paid)|no\s+(?:invoice|booking)|do\s+not)\b/i.test(text);
const affirmative=(text:string)=>!(/\b(?:no|not|never|without|unless|whether|previous|historical|don't|do not)\b|\?/i.test(text))&&!/\bif\b/i.test(text.replace(/\bif\s+you\s+could\s+(?:(?:kindly|please)\s+)*please?\s*/ig,''));
const namedProperties=(text:string)=>[...text.matchAll(/\b(?:for|at|our|the)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,3}\s+Hotel)\b/gu)].map(m=>m[1]!);
const span=(m:Message,quote:string,start:number):Source=>({attachmentId:`message:${m.id}`,sourceHash:hash(m.text),page:1,quote,start,end:start+quote.length});
/** A prior invoice request may need clarification in an explicitly reactivated same workflow. */
export function deriveDocumentRequestContinuations(input:{messages:readonly Message[];triggerMessageId?:string;causalAt:string}):DocumentRequestContinuation[]{
 const trigger=input.messages.find(m=>m.id===input.triggerMessageId),causal=Date.parse(input.causalAt);
 if(!trigger||trigger.direction!=='inbound'||trigger.disclosure==='staff_only'||Date.parse(trigger.at)!==causal||!Number.isFinite(causal))return[];
 const boundary=history(trigger.text);if(boundary<0)return[];const current=trigger.text.slice(0,boundary),quoted=trigger.text.slice(boundary);
 if(blocked(current)||/\b(?:different|another|unrelated)\s+(?:property|hotel|booking|quotation|quote|event)\b/i.test(current)||/^\s*>/m.test(current))return[];
 const activations=[...current.matchAll(/[^.!?;]*\b(?:quote|quotation|offer)\b[^.!?;]*[.!?;]?\s*[^.!?;]*\b(?:accept|book|reserve)\b[^.!?;]*[.!?;]?/gi)];
 if(activations.length!==1)return[];const active=activations[0]!,activationQuote=active[0].trim(),activationStart=active.index!+active[0].indexOf(activationQuote);
 if(/\b(?:if|unless|without|not|never|no|whether|don't|do not|would|should)\b|\?/i.test(activationQuote))return[];
 const found:DocumentRequestContinuation[]=[];
 for(const message of input.messages){
  if(message.id===trigger.id||message.direction!=='inbound'||message.disclosure==='staff_only'||!Number.isFinite(Date.parse(message.at))||Date.parse(message.at)>=causal)continue;
  const cut=history(message.text),authored=cut<0?message.text:message.text.slice(0,cut);
  const requests=[...authored.matchAll(/\bsend\s+(?:the\s+)?(?:final\s+)?invoice(?:\s+for\s+payment)?[.]?/gi)];
  if(requests.length!==1||blocked(authored))continue;
  const currentProperties=namedProperties(current),priorProperties=namedProperties(authored);if(currentProperties.length&&(!priorProperties.length||currentProperties.some(p=>!priorProperties.includes(p))))continue;
  const request=requests[0]!,quote=request[0],parent=paragraph(authored,request.index!);if(!affirmative(parent)||!quoted.includes(parent)||!(/\b(?:book|booking|reservation|accommodation)\b/i.test(parent)))continue;
  const scopeParagraphs=authored.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p!==parent&&/\b(?:request|booking|reservation|accommodation)\b/i.test(p)&&/\b(?:event|group|stay|booking|reservation)\b/i.test(p));
  if(scopeParagraphs.length&&!scopeParagraphs.some(p=>quoted.includes(p)))continue;
  if(input.messages.some(m=>m.id!==trigger.id&&Date.parse(m.at)>Date.parse(message.at)&&Date.parse(m.at)<=causal&&blocked(authoredText(m.text))))continue;if(authored.slice(Math.max(0,request.index!-150),request.index!).split('\n').at(-1)?.trim().startsWith('>'))continue;
  if(quoted.indexOf(quote)<0)continue;
  found.push({id:`invoice-continuation-${found.length+1}`,kind:'invoice_continuation',priorRequestSource:span(message,quote,request.index!),currentActivationSource:span(trigger,activationQuote,activationStart),closure:'unverified'});
 }
 return found.length===1?found:[];
}
export function assertDocumentRequestContinuation(value:DocumentRequestContinuation,input:{messages:readonly Message[];triggerMessageId?:string;causalAt:string},task:ValidatedDocumentPlan['tasks'][number]):void{
 const{taskId,...proof}=value;
 if(task.kind!=='existing_document'||taskId!==task.id||!isDeepStrictEqual(task.source,value.priorRequestSource)||!deriveDocumentRequestContinuations(input).some(candidate=>isDeepStrictEqual(candidate,proof)))throw new Error('document_continuation_source_binding_invalid');
}
