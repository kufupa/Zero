import {createHash} from 'node:crypto';
import type {ReservationistRuntimeInput} from './reservationist-runtime.js';
import type {AuthorizedTaskAnswer} from './reservationist-execution.js';
export type LocalEvaluationAnswerSource={kind:AuthorizedTaskAnswer['kind'];value:string|boolean;messageId:string;sourceHash:string;start:number;end:number;quote:string;disclosure:'guest'};
function answerEntailed(source:LocalEvaluationAnswerSource):boolean{
 const quote=source.quote.trim();if(/\b(?:not|never|no|cannot|can't|don't|do not|unknown|unconfirmed|maybe|perhaps|approximately|around|another|other|except|unless)\b|\bor\b|\?/i.test(quote))return false;
 const value=String(source.value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 if(source.kind==='check_in'||source.kind==='check_out'||source.kind==='breakfast_time'){
  const times=quote.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g)??[];if(times.length!==1||times[0]!==source.value)return false;
  const label=source.kind==='check_in'?'check[ -]?in(?: time)?':source.kind==='check_out'?'check[ -]?out(?: time)?':'breakfast(?: time)?';return new RegExp(`^${label}\\s+(?:is|at|starts at)\\s+${value}[.]?$`,'i').test(quote);
 }
 if(source.kind==='parking')return typeof source.value==='boolean'&&(source.value?/^parking\s+(?:is\s+)?available[.]?$/i:/^parking\s+(?:is\s+)?unavailable[.]?$/i).test(quote);
 // Complex policy and operational answers require the existing source-authorized service instead.
 return false;
}
export function originalAnswerRow(source:LocalEvaluationAnswerSource,text:string):string|null{
 // A line wrap never separates an answer from its original qualifier or instruction.
 let start=0;for(const boundary of text.matchAll(/\r?\n[ \t]*\r?\n/g)){const end=boundary.index!;if(!/[.!?]$/.test(text.slice(start,end).trim()))continue;if(start<=source.start&&end>=source.end)return text.slice(start,end).trim();start=boundary.index!+boundary[0].length;}return start<=source.start&&source.end<=text.length?text.slice(start).trim():null;
}
export function validateReservationistMailAnswers(sources:readonly LocalEvaluationAnswerSource[],input:ReservationistRuntimeInput){
 for(const source of sources){const message=input.messages.find(m=>m.id===source.messageId);if(!answerEntailed(source)||!message||originalAnswerRow(source,message.text)!==source.quote.trim()||message.direction!=='outbound'||message.disclosure!=='guest'||source.disclosure!=='guest'||Date.parse(message.at)>Date.parse(input.clock.causalAt)||createHash('sha256').update(message.text).digest('hex')!==source.sourceHash||!Number.isSafeInteger(source.start)||!Number.isSafeInteger(source.end)||source.start<0||source.end<=source.start||message.text.slice(source.start,source.end)!==source.quote||!({parking:/\bparking\b/i,check_in:/check[ -]?in|arrival time/i,check_out:/check[ -]?out|departure time/i,breakfast_time:/breakfast/i,policy:/policy|terms|conditions|rules/i,account_payment:/account|credit terms/i,transfer:/transfer|shuttle/i,cancel_request:/cancel/i})[source.kind]?.test(source.quote)||typeof source.value==='string'&&!source.quote.includes(source.value)||typeof source.value==='boolean'&&(source.kind!=='parking'||!(source.value?/\bparking\s+(?:is\s+)?available\b/i:/\bparking\s+(?:is\s+)?(?:unavailable|not available)\b/i).test(source.quote)))throw new Error('local_answer_source_invalid');}
}
