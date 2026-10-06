import {createHash} from 'node:crypto';
import {z} from 'zod';
import {existingDocumentReadResultSchema,type ExistingDocumentReadResult} from '../mail/artifacts/existing-document-contracts.js';
import {readRefSchema,readDigestSchema,readTimestampSchema} from '../hms/read-service-contracts.js';
import {quoteDigest} from '../quote-proposal/quote-revision.js';

const purposeSchema=z.enum(['tax_certificate','receipt','tax_invoice','reservation_confirmation','pro_forma','folio','statement','contract','existing_quote','property_information']);
export type ReservationistDocumentPurpose=z.infer<typeof purposeSchema>;
const purposeKinds={tax_certificate:'supplier_compliance',receipt:'other_existing',tax_invoice:'tax_invoice',reservation_confirmation:'reservation_confirmation',pro_forma:'pro_forma',folio:'folio',statement:'statement',contract:'contract',existing_quote:'pro_forma',property_information:'property_information'} as const;
const purposePatterns={tax_certificate:/\btax certificates?\b/i,receipt:/\breceipts?\b/i,tax_invoice:/\b(?:tax )?invoices?\b/i,reservation_confirmation:/\b(?:reservation |booking )?confirmations?\b/i,pro_forma:/\bpro[ -]?formas?\b/i,folio:/\bfolios?\b/i,statement:/\bstatements?\b/i,contract:/\bcontracts?\b/i,existing_quote:/\b(?:quotes?|quotations?|proposals?)\b/i,property_information:/\bproperty information\b/i};
const scopedPurposes=new Set<ReservationistDocumentPurpose>(['receipt','tax_invoice','reservation_confirmation','pro_forma','folio','statement','existing_quote']);
export function deriveReservationistDocumentPurpose(text:string):ReservationistDocumentPurpose{
 const matches=(Object.keys(purposePatterns) as ReservationistDocumentPurpose[]).filter(purpose=>purposePatterns[purpose].test(purpose==='tax_invoice'?text.replace(/\bpro[ -]?formas?\s+invoices?\b/gi,''):text)&&(purpose!=='existing_quote'||/\b(?:resend|re[ -]?send|copy|attach|existing|previous|prior|original)\b/i.test(text)&&!/\bnew\s+(?:quote|quotation|proposal)\b/i.test(text)));
 if(matches.length!==1)throw new Error('existing_document_purpose_unavailable');return matches[0];
}
const sourceSchema=z.object({sourceRef:readRefSchema,sourceHash:readDigestSchema,page:z.number().int().positive(),quote:z.string().min(1).max(4096),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict();
const targetSchema=z.object({reservationRef:readRefSchema.nullable(),priorQuoteRef:readRefSchema.optional()}).strict();
export type ReservationistExistingDocumentTarget=z.infer<typeof targetSchema>;
/** Literal requested quantity only; it never supplies a target or authorizes a document. */
export function reservationistDocumentRequestCount(quote:string):number|undefined{
 const count=/\b(one|two|three|four|five|six|seven|eight|\d+)\s+(?:(?:separate|existing|original|booking|reservation|tax)\s+)*(?:receipts?|confirmations?|invoices?|pro[ -]?formas?|folios?|statements?|contracts?|quotes?|quotations?|proposals?|certificates?)\b/i.exec(quote)?.[1];
 return count===undefined?undefined:/^\d+$/.test(count)?Number(count):['one','two','three','four','five','six','seven','eight'].indexOf(count.toLowerCase())+1;
}
/** Printed cardinality and distinct literal targets; no target is inferred from evaluator data. */
export function assertReservationistExistingDocumentTargets(quote:string,targets:ReservationistExistingDocumentTarget[]):void{
 const purpose=deriveReservationistDocumentPurpose(quote),numeric=reservationistDocumentRequestCount(quote);
 if(!targets.length||targets.length>8||new Set(targets.map(t=>quoteDigest(t))).size!==targets.length||numeric!==undefined&&numeric!==targets.length)throw new Error('existing_document_target_cardinality_unavailable');
 if(targets.length>1&&(numeric===undefined||targets.some(t=>purpose==='existing_quote'?t.reservationRef!==null||!t.priorQuoteRef||!containsReference(quote,t.priorQuoteRef):!t.reservationRef||t.priorQuoteRef!==undefined||!containsReference(quote,t.reservationRef))||!scopedPurposes.has(purpose)))throw new Error('existing_document_target_scope_unavailable');
 if(targets.length>1){
  const clause=quote.trim().replace(/[.]$/,'');
  if([...clause.matchAll(/\b(?:one|two|three|four|five|six|seven|eight|\d+)\s+(?:(?:separate|existing|original|booking|reservation|tax)\s+)*(?:receipts?|confirmations?|invoices?|pro[ -]?formas?|folios?|statements?|contracts?|quotes?|quotations?|proposals?|certificates?)\b/gi)].length!==1)throw new Error('existing_document_target_cardinality_conflict');
  if(/[.!?;>]/.test(clause)||/\b(?:not|no|never|unless|without|whether|if|don't|disregard|withdraw|another|other|different|actually|instead|only|previous|earlier|history|quoted)\b/i.test(clause))throw new Error('existing_document_target_clause_unavailable');
  const list=/\bfor\s+(?:(?:reservations?|bookings?|quotes?|quotations?|proposals?)\s+)([A-Za-z0-9_-]+(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)[A-Za-z0-9_-]+)*)$/i.exec(clause)?.[1];
  const refs=list?.split(/\s*(?:,\s*(?:and\s+)?|\band\s+|&\s*)/i),expected=new Set(targets.map(t=>purpose==='existing_quote'?t.priorQuoteRef:t.reservationRef));
  if(!refs||refs.length!==targets.length||new Set(refs).size!==refs.length||!refs.every(r=>expected.has(r)))throw new Error('existing_document_target_list_unavailable');
 }
}
const inputSchema=z.object({taskId:readRefSchema,requestId:readRefSchema,ownerRef:readRefSchema,threadId:readRefSchema,triggerMessageId:readRefSchema,propertyCode:readRefSchema,reservationRef:readRefSchema.nullable(),priorQuoteRef:readRefSchema.optional(),requestedTargets:z.array(targetSchema).min(1).max(8).optional(),taskSource:sourceSchema,originalRequest:z.object({text:z.string().min(1).max(256*1024),at:readTimestampSchema,sourceRef:readRefSchema,sourceHash:readDigestSchema,pageHash:readDigestSchema,page:z.number().int().positive(),disclosure:z.literal('guest')}).strict(),clock:z.object({causalAt:readTimestampSchema,sourceAt:readTimestampSchema,sourceMode:z.enum(['historical','current_read']).optional(),deadlineAt:z.number().finite()}).strict()}).strict();
export type ReservationistExistingDocumentInput=z.infer<typeof inputSchema>;
const proofSchema=z.object({sourceRef:readRefSchema,sourceHash:readDigestSchema,documentRef:readRefSchema,documentVersion:z.string().min(1).max(128),purpose:purposeSchema,ownerRef:readRefSchema,threadId:readRefSchema.nullable(),propertyCode:readRefSchema,reservationRef:readRefSchema.nullable(),priorQuoteRef:readRefSchema.optional(),authorizationId:readRefSchema,issuedAt:readTimestampSchema,observedAt:readTimestampSchema,expiresAt:readTimestampSchema,maxSourceAgeMs:z.number().int().nonnegative().safe(),page:z.number().int().positive(),pageText:z.string().min(1).max(256*1024),pageHash:readDigestSchema}).strict();
export type ReservationistExistingDocumentSourceProof=z.infer<typeof proofSchema>;
export type ReservationistExistingDocumentCapture={artifactRef:string;filename:string;body:Buffer;read:ExistingDocumentReadResult;sourceProof:ReservationistExistingDocumentSourceProof};
const bindingSchema=z.object({taskId:readRefSchema,requestId:readRefSchema,ownerRef:readRefSchema,threadId:readRefSchema,triggerMessageId:readRefSchema,propertyCode:readRefSchema,reservationRef:readRefSchema.nullable(),priorQuoteRef:readRefSchema.optional(),parentRef:readRefSchema.nullable().optional(),purpose:purposeSchema,inputDigest:readDigestSchema,requestDigest:readDigestSchema,documentDigest:readDigestSchema,documentRef:readRefSchema,sourceRef:readRefSchema,sourceHash:readDigestSchema,documentVersion:z.string().min(1).max(128)}).strict();
export type ReservationistExistingDocumentBinding=z.infer<typeof bindingSchema>;
const grantSchema=bindingSchema.extend({authorizationId:readRefSchema,disclosure:z.literal('guest'),issuedAt:readTimestampSchema,expiresAt:readTimestampSchema,maxSourceAgeMs:z.number().int().nonnegative().safe()}).strict();
export type ReservationistExistingDocumentGrant=z.infer<typeof grantSchema>;
const descriptorSchema=z.object({artifactRef:readRefSchema,filename:z.string().min(1).max(128),body:z.object({sha256:readDigestSchema,sizeBytes:z.number().int().positive().max(20*1024*1024)}).strict(),read:existingDocumentReadResultSchema,sourceProof:proofSchema}).strict();
const receiptSchema=z.object({input:inputSchema,binding:bindingSchema,grant:grantSchema,capture:descriptorSchema,sourceProof:proofSchema}).strict();
export type ReservationistExistingDocumentReceipt=z.infer<typeof receiptSchema>;
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const descriptor=(document:ReservationistExistingDocumentCapture)=>({artifactRef:document.artifactRef,filename:document.filename,body:{sha256:sha(document.body),sizeBytes:document.body.length},read:document.read,sourceProof:document.sourceProof});
function containsReference(text:string,ref:string){return new RegExp(`(?:^|[^A-Za-z0-9_-])${ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[^A-Za-z0-9_-])`).test(text);}
function targetsPriorQuote(text:string,ref:string){
 const escaped=ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(`\\b(?:quote|quotation|proposal)\\s+(?:(?:reference|ref|number|no\\.?|id)\\s*[:#-]?\\s*)?[:#-]?\\s*${escaped}(?=$|[^A-Za-z0-9_-])`,'i').test(text);
}
function validateRequest(input:ReservationistExistingDocumentInput){
 const {taskSource:s,originalRequest:o,clock}=input;
 if(s.sourceRef!==o.sourceRef||s.sourceHash!==o.sourceHash||s.page!==o.page||sha(o.text)!==o.pageHash||o.sourceRef.startsWith('message:')&&o.pageHash!==o.sourceHash||o.text.slice(s.start,s.end)!==s.quote||s.end-s.start!==s.quote.length||Date.parse(o.at)>Date.parse(clock.causalAt)||clock.sourceMode!=='current_read'&&Date.parse(clock.sourceAt)>Date.parse(clock.causalAt))throw new Error('existing_document_request_mismatch');
 const purpose=deriveReservationistDocumentPurpose(s.quote);
 const target={reservationRef:input.reservationRef,...(input.priorQuoteRef!==undefined?{priorQuoteRef:input.priorQuoteRef}:{})},targets=input.requestedTargets??[target];assertReservationistExistingDocumentTargets(s.quote,targets);
 if(!targets.some(t=>quoteDigest(t)===quoteDigest(target)))throw new Error('existing_document_batch_target_denied');
 if(targets.length>1){const history=o.text.search(/^(?:From:\s|Sent:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im),authored=history>=0?o.text.slice(0,history):o.text;if(history>=0&&s.end>history||/\b(?:actually|instead|disregard|withdraw|only\s+(?:one|1)\s+(?:receipt|invoice|confirmation|document))\b/i.test(authored))throw new Error('existing_document_batch_request_conflict');}
 if(purpose==='existing_quote'){if(!input.priorQuoteRef||targets.length===1&&(!targetsPriorQuote(s.quote,input.priorQuoteRef)||!targetsPriorQuote(o.text,input.priorQuoteRef)))throw new Error('existing_document_quote_target_unavailable');}
 else if(scopedPurposes.has(purpose)&&!input.reservationRef)throw new Error('existing_document_target_unavailable');
 return purpose;
}
function bindingFor(input:ReservationistExistingDocumentInput,capture:z.infer<typeof descriptorSchema>):ReservationistExistingDocumentBinding{
 const p=capture.sourceProof,purpose=validateRequest(input);
 return {taskId:input.taskId,requestId:input.requestId,ownerRef:input.ownerRef,threadId:input.threadId,triggerMessageId:input.triggerMessageId,propertyCode:input.propertyCode,reservationRef:input.reservationRef,...(input.priorQuoteRef!==undefined?{priorQuoteRef:input.priorQuoteRef}:{}),...(purpose==='existing_quote'?{parentRef:capture.read.data?.document.parentRef??null}:{}),purpose,inputDigest:quoteDigest(input),requestDigest:quoteDigest({taskSource:input.taskSource,originalRequest:input.originalRequest}),documentDigest:quoteDigest(capture),documentRef:p.documentRef,sourceRef:p.sourceRef,sourceHash:p.sourceHash,documentVersion:p.documentVersion};
}
/** Revalidate the retained capture at promotion; does not refresh or invent source authority. */
export function assertReservationistExistingDocumentReceiptFresh(raw:unknown,now:Date):void{
 const r=receiptSchema.parse(raw),{input,capture,grant,sourceProof:p,binding}=r,t=now.getTime();
 if(!Number.isFinite(t)||quoteDigest(binding)!==quoteDigest(bindingFor(input,capture))||quoteDigest(p)!==quoteDigest(capture.sourceProof)||Object.entries(binding).some(([key,value])=>grant[key as keyof ReservationistExistingDocumentGrant]!==value))throw new Error('existing_document_binding_denied');
 const d=capture.read.data?.document,purpose=binding.purpose;
 const fresh=(observed:string,expires:string,maxAge:number)=>Date.parse(observed)<=t&&t-Date.parse(observed)<=maxAge&&Date.parse(expires)>t&&Date.parse(expires)>Date.parse(observed);
 if(grant.authorizationId!==p.authorizationId||!fresh(grant.issuedAt,grant.expiresAt,grant.maxSourceAgeMs)||!fresh(p.observedAt,p.expiresAt,p.maxSourceAgeMs)||t-Date.parse(p.observedAt)>grant.maxSourceAgeMs||Date.parse(p.issuedAt)>Date.parse(p.observedAt)||(input.clock.sourceMode!=='current_read'||purpose==='existing_quote')&&Date.parse(p.issuedAt)>Date.parse(input.clock.causalAt))throw new Error('existing_document_source_expired');
 if(!d||capture.read.status!=='ok'||capture.read.blocker!==null||capture.read.issues.length||d.documentRef!==p.documentRef||d.version!==p.documentVersion||d.sha256!==p.sourceHash||capture.body.sha256!==p.sourceHash||capture.read.data!.sourceHash!==p.sourceHash||d.sizeBytes!==capture.body.sizeBytes||d.displayName!==capture.filename||d.mime!=='application/pdf'||d.priceVisibility==='unknown'||!d.retrievable||d.retrievalBlocker!==null||!d.currentVersion||!['final','sent'].includes(d.status)||d.kind!==purposeKinds[purpose]||d.issuedAt!==p.issuedAt||d.propertyRef!==input.propertyCode||p.propertyCode!==input.propertyCode||p.ownerRef!==input.ownerRef||p.purpose!==purpose||p.reservationRef!==input.reservationRef||p.priorQuoteRef!==input.priorQuoteRef)throw new Error('existing_document_scope_denied');
 const target=purpose==='existing_quote'?input.priorQuoteRef:input.reservationRef;
 if(scopedPurposes.has(purpose)&&(p.threadId!==input.threadId||d.parentRef!==target)||!scopedPurposes.has(purpose)&&(d.source!=='approved_property_document'||p.threadId!==null&&p.threadId!==input.threadId))throw new Error('existing_document_target_denied');
 const data=capture.read.data!;
 if(data.extractionState!=='complete'||data.text===null||!data.text.includes(p.pageText)||!data.pageCount||p.page>data.pageCount||sha(p.pageText)!==p.pageHash||!purposePatterns[purpose].test(p.pageText)||data.validation.identity!=='match'||data.validation.kind!=='match'||data.validation.version!=='current'||data.validation.priceVisibility!=='allowed'||Object.values(data.validation).some(value=>['mismatch','superseded','forbidden'].includes(value)))throw new Error('existing_document_page_denied');
 if(scopedPurposes.has(purpose)&&(!target||!containsReference(p.pageText,target)))throw new Error('existing_document_page_target_denied');
 if(data.artifactExpiresAt!==null&&Date.parse(data.artifactExpiresAt)<=t)throw new Error('existing_document_artifact_expired');
}
/** Read-only source edge. Source owners supply existing typed metadata and original private bytes. */
export async function prepareReservationistExistingDocument(rawInput:ReservationistExistingDocumentInput,deps:{resolve:(signal:AbortSignal)=>Promise<ReservationistExistingDocumentCapture>;authorize:(binding:ReservationistExistingDocumentBinding,document:ReservationistExistingDocumentCapture,signal:AbortSignal)=>Promise<ReservationistExistingDocumentGrant|null>;signal:AbortSignal}){
 const input=inputSchema.parse(rawInput);validateRequest(input);deps.signal.throwIfAborted();
 if(Date.now()>=input.clock.deadlineAt)throw new Error('existing_document_deadline_exceeded');
 const signal=AbortSignal.any([deps.signal,AbortSignal.timeout(Math.max(1,Math.min(15*60000,input.clock.deadlineAt-Date.now())))]);
 const bounded=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
 const raw=await bounded(deps.resolve(signal));signal.throwIfAborted();
 if(!raw||!Buffer.isBuffer(raw.body)||raw.body.subarray(0,5).toString()!=='%PDF-')throw new Error('existing_document_identity_denied');
 const capture=descriptorSchema.parse(descriptor(raw)),binding=bindingFor(input,capture),inputBefore=quoteDigest(input),bindingBefore=quoteDigest(binding),before=quoteDigest(capture);
 const rawGrant=await bounded(deps.authorize(binding,raw,signal));signal.throwIfAborted();
 if(quoteDigest(input)!==inputBefore||quoteDigest(binding)!==bindingBefore||quoteDigest(descriptor(raw))!==before)throw new Error('existing_document_source_mutated');
 if(!rawGrant)throw new Error('existing_document_authority_unavailable');
 const receipt=receiptSchema.parse({input,binding,grant:rawGrant,capture,sourceProof:capture.sourceProof});assertReservationistExistingDocumentReceiptFresh(receipt,new Date(input.clock.sourceAt));
 return {document:{...raw,body:Buffer.from(raw.body),read:structuredClone(capture.read),sourceProof:structuredClone(capture.sourceProof)},receipt};
}
