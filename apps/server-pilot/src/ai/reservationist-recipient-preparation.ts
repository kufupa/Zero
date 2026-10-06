import {createHash} from 'node:crypto';
import {z} from 'zod';
import {quoteDigest} from '../quote-proposal/quote-revision.js';

const ref=z.string().min(1).max(256), hash=z.string().regex(/^[a-f0-9]{64}$/), time=z.string().datetime({offset:true});
const addresses=z.array(z.string().min(1).max(320)).max(100);
const captureSchema=z.object({version:ref,ownerRef:ref,observedAt:time,row:z.object({id:ref,email:ref,send_from_config:z.object({aliases:addresses}).strict(),is_active:z.literal(true),updated_at:time}).strict()}).passthrough();
const inputSchema=z.object({
 kind:z.literal('user_authorized_local_recipient_preparation'),authorizationSource:z.literal('reservationist-recovery-user-20261004'),
 taskId:ref,requestId:ref,ownerRef:ref,threadId:ref,propertyCode:ref,triggerMessageId:ref,
 taskSource:z.object({attachmentId:ref,sourceHash:hash,page:z.literal(1),quote:z.string().min(1).max(40000),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict(),
 originalRequest:z.object({text:z.string().min(1).max(40000),at:time}).strict(),
 headerProof:z.object({ownerRef:ref,threadId:ref,messageRef:ref,at:time,bodyHash:hash,sourceRowHash:hash,headers:z.object({from:addresses,to:addresses,cc:addresses,bcc:addresses}).strict()}).strict(),
 mailboxSource:z.object({capture:captureSchema,serialized:z.string().min(1).max(32768),sourceHash:hash}).strict(),
 preparedAt:time,expiresAt:time,maxSourceAgeMs:z.number().int().positive().max(1800000),historicalMailboxTruth:z.literal(false),emailSend:z.literal(false),productionDraftWrite:z.literal(false)
}).strict();
export type RecipientPreparationInput=z.infer<typeof inputSchema>;
export type RecipientPreparationReceipt={input:RecipientPreparationInput;prepared:{to:string[];cc:string[];bcc:string[]};deliveryConfirmed:false;digest:string};
export const RECIPIENT_PREPARATION_CLAUSE='Reply recipients are prepared for staff review; no email has been sent.';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function address(value:string):string{
 const match=/^(?:[^<>\r\n]+\s*)?<([^<>\s@]+@[^<>\s@]+)>$/.exec(value.trim()), email=(match?.[1]??value.trim()).toLowerCase();
 if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email))throw new Error('recipient_address_invalid');
 return email;
}
export function prepareReservationistRecipients(value:RecipientPreparationInput):RecipientPreparationReceipt{
 const input=inputSchema.parse(value),s=input.taskSource,h=input.headerProof,c=input.mailboxSource.capture,now=Date.parse(input.preparedAt),observed=Date.parse(c.observedAt),expiry=Date.parse(input.expiresAt);
 if(s.attachmentId!==`message:${input.triggerMessageId}`||s.sourceHash!==sha(input.originalRequest.text)||s.end<=s.start||input.originalRequest.text.slice(s.start,s.end)!==s.quote||h.ownerRef!==input.ownerRef||h.threadId!==input.threadId||h.messageRef!==input.triggerMessageId||h.at!==input.originalRequest.at||h.bodyHash!==s.sourceHash||Date.parse(h.at)>now||c.ownerRef!==input.ownerRef||c.row.id!==input.ownerRef||observed>now||now-observed>input.maxSourceAgeMs||expiry<=now||expiry>observed+input.maxSourceAgeMs||Date.parse(c.row.updated_at)>observed||sha(input.mailboxSource.serialized)!==input.mailboxSource.sourceHash||quoteDigest(JSON.parse(input.mailboxSource.serialized))!==quoteDigest(c))throw new Error('recipient_source_invalid');
 // Qualifiers in the original semantic row cannot be discarded by selecting a narrower span.
 const history=input.originalRequest.text.search(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,})/im);
 if(history>=0&&s.end>history)throw new Error('recipient_request_history');
 const original=input.originalRequest.text;
 // Line breaks do not end a sentence: qualifiers may precede the selected request on another line.
 let begin=0,end=original.length;
 for(const boundary of original.matchAll(/[.!?;](?=\s|$)/g)){
  const after=boundary.index!+boundary[0].length;
  if(after<=s.start)begin=after;
  else if(after>=s.end){end=after;break;}
 }
 const sentence=original.slice(begin,end);
 if(!/\b(?:copy all|reply all|all recipients)\b/i.test(s.quote)||/^\s*>/m.test(sentence)||/\b(?:if|unless|without|no|not|never|do not|don't|when (?:approved|authorized)|another (?:thread|message|booking))\b/i.test(sentence))throw new Error('recipient_request_invalid');
 const self=new Set([c.row.email,...c.row.send_from_config.aliases].map(address));
 const to=[...new Set(h.headers.from.map(address))].filter(a=>!self.has(a));
 const cc=[...new Set([...h.headers.to,...h.headers.cc].map(address))].filter(a=>!self.has(a)&&!to.includes(a));
 // Parse hidden headers for integrity, but never promote them to reply recipients.
 h.headers.bcc.forEach(address);
 if(to.length!==1)throw new Error('recipient_sender_ambiguous');
 const data={input,prepared:{to,cc,bcc:[] as string[]},deliveryConfirmed:false as const};
 return {...data,digest:quoteDigest(data)};
}
export function assertReservationistRecipientReceipt(value:unknown,now=new Date()):asserts value is RecipientPreparationReceipt{
 const receipt=z.object({input:inputSchema,prepared:z.object({to:addresses,cc:addresses,bcc:z.array(z.string()).length(0)}).strict(),deliveryConfirmed:z.literal(false),digest:hash}).strict().parse(value);
 const expected=prepareReservationistRecipients(receipt.input),observed=Date.parse(receipt.input.mailboxSource.capture.observedAt);
 if(!Number.isFinite(now.getTime())||now.getTime()<Date.parse(receipt.input.preparedAt)||now.getTime()>=Date.parse(receipt.input.expiresAt)||now.getTime()-observed>receipt.input.maxSourceAgeMs||quoteDigest(receipt)!==quoteDigest(expected))throw new Error('recipient_receipt_invalid_or_expired');
}
