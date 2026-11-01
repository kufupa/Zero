import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ValidatedDocumentPlan} from './reservationist-document-facts.js';
import type {ReservationistMessageView} from './reservationist-message-view.js';
type Source=ValidatedDocumentPlan['tasks'][number]['source'];
type Message={id:string;at:string;text:string;direction?:'inbound'|'outbound';disclosure?:'guest'|'staff_only';sourceViews?:ReservationistMessageView[]};
type Activation={quote:string;start:number;view:ReservationistMessageView['name']};
export type DocumentRequestContinuation={id:string;taskId?:string;kind:'invoice_continuation';priorRequestSource:Source;currentActivationSource:Source;closure:'unverified'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const history=(text:string)=>text.search(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,})/im);
const authoredText=(text:string)=>{const cut=history(text);return cut<0?text:text.slice(0,cut);};
const trimSignoff=(text:string)=>{
 const signoff=/\r?\n[\t ]*(?:(?:thank\s+you\s+and\s+)?(?:kind|warm|best)\s+regards|regards)\b[^\r\n]*/i.exec(text);if(!signoff)return text.trim();
 const tail=text.slice(signoff.index);if(/(?:^|\r?\n)[\t ]*(?:p\.?\s*s\.?\s*:?\s*)?(?:only\s+if|if|unless|provided\s+(?:that\s+)?|subject\s+to)\b/i.test(tail))return text.trim();
 return text.slice(0,signoff.index).trim();
};
const paragraph=(text:string,index:number)=>{const left=text.lastIndexOf('\n\n',index),right=text.indexOf('\n\n',index);return trimSignoff(text.slice(left<0?0:left+2,right<0?text.length:right));};
const equivalentText=(text:string)=>text.replace(/\s+/g,' ').toLowerCase();
const blocked=(text:string)=>/\b(?:withdraw\w*|supersed\w*|cancel\w*|disregard|ignore|already\s+(?:sent|received|paid)|(?:received|sent|delivered|paid)\s+(?:(?:the|your|our|my|their)\s+)?(?:final\s+)?invoice|invoice[^.!?;\n]{0,60}\b(?:received|sent|delivered|paid)|no\s+(?:invoice|booking)|do\s+not)\b/i.test(text);
const rejectedBooking=(text:string)=>/\b(?:not|never|don't|no\s+longer)\s+(?:(?:yet|been|be|being)\s+){0,2}accept\w*\b|\b(?:not|never|don't|no\s+longer)\s+(?:(?:yet|been|be|being)\s+){0,2}(?:book\w*|reserv\w*)\b(?:\s+(?:(?:the|these|those|our|your|this|that)\s+)?(?:rooms?|booking|reservation|accommodation|stay|it|them|yet)\b|(?=[.!?;]|$))|\b(?:reject\w*|declin\w*|refus\w*)\b[^.!?;\n]{0,80}\b(?:quot(?:e|ation)\w*|offer|booking|reservation)\b|\b(?:quot(?:e|ation)\w*|offer|booking|reservation)\b[^.!?;\n]{0,80}\b(?:reject\w*|declin\w*|refus\w*)\b/i.test(text);
const affirmative=(text:string)=>!(/\b(?:no|not|never|without|unless|whether|previous|historical|don't|do not)\b|\?/i.test(text))&&!/\bif\b/i.test(text.replace(/\bif\s+you\s+could\s+(?:(?:kindly|please)\s+)*please?\s*/ig,''));
const namedProperties=(text:string)=>[...text.matchAll(/\b(?:for|at|our|the)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,3}\s+Hotel)\b/gu)].map(m=>m[1]!);
const span=(m:Message,quote:string,start:number):Source=>({attachmentId:`message:${m.id}`,sourceHash:hash(m.text),page:1,quote,start,end:start+quote.length});
const bookingScopes=(text:string,parent:string)=>text.split(/\n\s*\n/).map(trimSignoff).filter(p=>equivalentText(p)!==equivalentText(parent)&&/\b(?:request|booking|reservation|accommodation)\b/i.test(p)&&/\b(?:event|group|stay|booking|reservation)\b/i.test(p));
/** A prior invoice request may need clarification in an explicitly reactivated same workflow. */
export function deriveDocumentRequestContinuations(input:{messages:readonly Message[];triggerMessageId?:string;causalAt:string}):DocumentRequestContinuation[]{
 const trigger=input.messages.find(m=>m.id===input.triggerMessageId),causal=Date.parse(input.causalAt);
 if(!trigger||trigger.direction!=='inbound'||trigger.disclosure==='staff_only'||Date.parse(trigger.at)!==causal||!Number.isFinite(causal))return[];
 const boundary=history(trigger.text);if(boundary<0)return[];const current=trigger.text.slice(0,boundary);
 if(blocked(current)||/\b(?:different|another|unrelated)\s+(?:property|hotel|booking|quotation|quote|event)\b/i.test(current)||/^\s*>/m.test(current))return[];
 const views:ReservationistMessageView[]=trigger.sourceViews??[{name:'plain',start:0,end:current.length}],activationsByView=new Map<ReservationistMessageView['name'],Map<string,Activation[]>>();let conditionalActivation=false;
 const condition=/\b(?:if|unless|without|not|never|no|whether|don't|do not|would|should)\b|\?/i;
 for(const view of views){
  const text=trigger.sourceViews?trigger.text.slice(view.start,view.end):current,activations=new Map<string,Activation[]>();
  if(rejectedBooking(text))return[];
  for(const active of text.matchAll(/[^.!?;]*\b(?:quote|quotation|offer)\b[^.!?;]*[.!?;]?\s*[^.!?;]*\b(?:accept|book|reserve)\b[^.!?;]*[.!?;]?/gi)){
   const matched=active[0].trim(),verb=/\b(?:accept|book|reserve)\b/i.exec(matched)!,tail=matched.slice(verb.index!+verb[0].length),sentenceTail=tail.search(/[.!?;]/),paragraphTail=tail.search(/\r?\n[\t ]*\r?\n/),signoffTail=tail.search(/\r?\n[\t ]*(?:(?:thank\s+you\s+and\s+)?(?:kind|warm|best)\s+regards|regards)[^\r\n]*(?=\r?\n|$)/i),endOffset=[sentenceTail,paragraphTail,signoffTail].filter(offset=>offset>=0).sort((a,b)=>a-b)[0]??tail.length,quote=matched.slice(0,verb.index!+verb[0].length+endOffset+(endOffset===sentenceTail?1:0)).trim(),following=text.slice(active.index!+active[0].indexOf(matched)+quote.length).trimStart(),nextBreak=following.search(/\r?\n[\t ]*\r?\n/),nextParagraph=following.slice(0,nextBreak<0?following.length:nextBreak),start=view.start+active.index!+active[0].indexOf(matched),key=quote.replace(/\s+/g,' ').replace(/[.!?;]+$/,'').toLowerCase(),copies=activations.get(key)??[];
   if(condition.test(quote)||/^(?:if|only\s+if|unless|provided\s+(?:that\s+)?|subject\s+to)\b/i.test(nextParagraph))conditionalActivation=true;
   copies.push({quote,start,view:view.name});activations.set(key,copies);
  }
  activationsByView.set(view.name,activations);
 }
 const names=views.map(view=>view.name),keys=new Set(names.flatMap(name=>[...(activationsByView.get(name)?.keys()??[])])),activations:Activation[][]=[];
 for(const key of keys){const copies=names.map(name=>activationsByView.get(name)?.get(key)??[]),count=Math.max(...copies.map(view=>view.length));for(let index=0;index<count;index++){const group=copies.map(view=>view[index]).filter((active):active is Activation=>!!active);if(group.length)activations.push(group);}}
 if(activations.length!==1||conditionalActivation)return[];
 const histories=activations[0]!.flatMap(active=>{const view=views.find(item=>item.name===active.view);const text=view?.quoted?trigger.text.slice(view.quoted.start,view.quoted.end):trigger.sourceViews?null:trigger.text.slice(boundary);return text===null?[]:[{active,text}];});
 const found:DocumentRequestContinuation[]=[];
 for(const message of input.messages){
  if(message.id===trigger.id||message.direction!=='inbound'||message.disclosure==='staff_only'||!Number.isFinite(Date.parse(message.at))||Date.parse(message.at)>=causal)continue;
  const cut=history(message.text),authored=cut<0?message.text:message.text.slice(0,cut),requestViews=message.sourceViews?.map(view=>({text:message.text.slice(view.start,view.end),offset:view.start}))??[{text:authored,offset:0}],copies=requestViews.flatMap((view,viewIndex)=>[...view.text.matchAll(/\bsend\s+(?:the\s+)?(?:final\s+)?invoice(?:\s+for\s+payment)?[.]?/gi)].map((match,index)=>{const parent=paragraph(view.text,match.index!);return{quote:match[0],parent,start:view.offset+match.index!,viewIndex,index,scope:bookingScopes(view.text,parent).map(equivalentText).sort()};})),requests=copies.filter((request,index)=>!copies.slice(0,index).some(previous=>previous.viewIndex!==request.viewIndex&&previous.index===request.index&&equivalentText(previous.quote)===equivalentText(request.quote)&&equivalentText(previous.parent)===equivalentText(request.parent)&&isDeepStrictEqual(previous.scope,request.scope)));
  if(requestViews.some(view=>/(?:^|\n)[\t ]*p\.?\s*s\.?\s*:?[ \t]*[^\n]*\b(?:if|unless|provided|subject\s+to)\b/i.test(view.text)))continue;
  if(requests.length!==1||blocked(authored))continue;
  const currentProperties=namedProperties(current),priorProperties=namedProperties(authored);if(currentProperties.length&&(!priorProperties.length||currentProperties.some(p=>!priorProperties.includes(p))))continue;
  const request=requests[0]!,quote=request.quote,parent=request.parent;if(!affirmative(parent)||!(/\b(?:book|booking|reservation|accommodation)\b/i.test(parent)))continue;
  const scopeParagraphs=[...new Set(requestViews.flatMap(view=>bookingScopes(view.text,parent)))];
  const match=histories.find(({text})=>text.includes(parent)&&text.includes(quote)&&(!scopeParagraphs.length||scopeParagraphs.some(p=>text.includes(p))));if(!match)continue;
  if(input.messages.some(m=>m.id!==trigger.id&&Date.parse(m.at)>Date.parse(message.at)&&Date.parse(m.at)<=causal&&blocked(authoredText(m.text))))continue;if(authored.slice(Math.max(0,request.start-150),request.start).split('\n').at(-1)?.trim().startsWith('>'))continue;
  found.push({id:`invoice-continuation-${found.length+1}`,kind:'invoice_continuation',priorRequestSource:span(message,quote,request.start),currentActivationSource:span(trigger,match.active.quote,match.active.start),closure:'unverified'});
 }
 return found.length===1?found:[];
}
export function assertDocumentRequestContinuation(value:DocumentRequestContinuation,input:{messages:readonly Message[];triggerMessageId?:string;causalAt:string},task:ValidatedDocumentPlan['tasks'][number]):void{
 const{taskId,...proof}=value;
 if(task.kind!=='existing_document'||taskId!==task.id||!isDeepStrictEqual(task.source,value.priorRequestSource)||!deriveDocumentRequestContinuations(input).some(candidate=>isDeepStrictEqual(candidate,proof)))throw new Error('document_continuation_source_binding_invalid');
}
