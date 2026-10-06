import {assertCurrentLookupTargetReceipt,type CurrentLookupTargetReceipt} from './reservationist-lookup-target.js';
import type {ValidatedDocumentFact,ValidatedDocumentPlan} from './reservationist-document-facts.js';
import {z} from 'zod';
import {executeRead,type ReadExecutionContext} from '../hms/read-service.js';
import {reservationContextRequestSchema,reservationContextReadResultSchema,type ReservationContextRequest} from '../hms/reservation-context-contract.js';
import {folioReadRequestSchema,readRefSchema,readTimestampSchema,readDigestSchema,readResultSchema,readInputDigest,type FolioReadRequest,type ReadResult,type ReadEvidence} from '../hms/read-service-contracts.js';
import {folioReadDataSchema,folioClaimEligibility} from '../hms/folio-read-contract.js';
import type {PreparedFact} from './prepared-draft-input.js';
export const reservationistReadFields=['reservation_status','arrival','departure','folio_balance','deposit_due','deposit_recorded'] as const;
export type ReservationistReadField=typeof reservationistReadFields[number];
const fieldSchema=z.enum(reservationistReadFields);
const inputSchema=z.object({taskId:readRefSchema,requestId:readRefSchema,ownerRef:readRefSchema,threadId:readRefSchema,triggerMessageId:readRefSchema,propertyCode:readRefSchema,candidateId:readRefSchema,reservationRef:readRefSchema,lookupTargetDigest:readDigestSchema.optional(),fields:z.array(fieldSchema).min(1).max(6).refine(fields=>new Set(fields).size===fields.length),taskSource:z.object({sourceRef:readRefSchema,sourceHash:readDigestSchema,quote:z.string().min(1).max(4096),start:z.number().int().min(0),end:z.number().int().min(1)}).strict(),clock:z.object({causalAt:readTimestampSchema,sourceAt:readTimestampSchema,sourceMode:z.enum(['historical','current_read']).optional(),deadlineAt:z.number().finite()}).strict()}).strict();
export type ReservationistReadTaskInput=z.infer<typeof inputSchema>;
export type ReservationistReadBinding={inputDigest:string;requestDigest:string;taskId:string;requestId:string;ownerRef:string;threadId:string;triggerMessageId:string;propertyCode:string;candidateId:string;reservationRef:string};
export type ReservationistReadGrant=ReservationistReadBinding&{authorizationId:string;allowedFields:ReservationistReadField[];disclosure:'guest'|'staff_only';issuedAt:string;expiresAt:string;maxSourceAgeMs:number};
export type ReservationistReadSourceProof={evidenceRef:string;sourceHash:string;observedAt:string;expiresAt:string;disclosure:'guest'|'staff_only';authorizationId:string;inputDigest:string;requestDigest:string};
export type PaymentTargetBinding={taskId:string;requestId:string;ownerRef:string;threadId:string;propertyCode:string;candidateId:string;reservationRef:string;evaluatedAt:string;taskSourceDigest:string;targetFactsDigest:string;authorizationId:string;sourceRef:string;sourceHash:string;observedAt:string;expiresAt:string;maxSourceAgeMs:number};
export type PaymentTargetReceipt={binding:PaymentTargetBinding;facts:ValidatedDocumentFact[];taskSource:ValidatedDocumentPlan['tasks'][number]['source'];digest:string};
export type ReservationistReadReceipt={lookupTargetReceipt?:CurrentLookupTargetReceipt;paymentTargetReceipt?:PaymentTargetReceipt;binding:ReservationistReadBinding;grant:ReservationistReadGrant;result:ReadResult<unknown>;sourceProofs:ReservationistReadSourceProof[]};
export type ReservationistReadTaskResult={status:'complete'|'needs_clarification'|'blocked';guestText:string;preparedFacts:PreparedFact[];evidenceRefs:string[];recoveryCodes:string[];readReceipt?:ReservationistReadReceipt};
export type ReservationistReadTaskDependencies={evaluateSourceAt?:()=>string;lookupTarget?:{receipt:CurrentLookupTargetReceipt;authorize:(receipt:CurrentLookupTargetReceipt,signal:AbortSignal)=>Promise<boolean>};context:ReadExecutionContext;request:ReservationContextRequest|FolioReadRequest;signal:AbortSignal;authorizeRead:(binding:ReservationistReadBinding,signal:AbortSignal)=>Promise<ReservationistReadGrant|null>;authorizeEvidence:(input:{binding:ReservationistReadBinding;grant:ReservationistReadGrant;receipt:ReadResult<unknown>},signal:AbortSignal)=>Promise<ReservationistReadSourceProof[]|null>};
const fieldSections={reservation_status:'core',arrival:'stay',departure:'stay',folio_balance:'balance',deposit_due:'deposits',deposit_recorded:'deposits'} as const;
const receivedBookingStatusAsk=(text:string)=>text.split(/[.!?;]+/).some(clause=>/\b(?:confirm|check|verify)\b/i.test(clause)&&/\b(?:you|the hotel|the property)\s+(?:have|has)\s+(?:received\s+)?(?:(?:a|the|my|our|this|that)\s+)?(?:booking|reservation)\b/i.test(clause)&&!/\b(?:rate|price|quote|quotation|policy|cancel|make|create|book|reserve)\b/i.test(clause));
const reservationStatusPattern=/\breservation\s+status\b|\bstatus\s+of\s+(?:(?:the|my|our|your)\s+)?(?:reservation|booking)\b|\b(?:confirm|check|verify|tell)\b[^.!?;\n]{0,100}\b(?:booking|reservation)\b[^.!?;\n]{0,60}\b(?:is|was|has\s+been)\s+(?:cancelled|canceled|confirmed|tentative|provisional)\b|\b(?:has|have|is|was)\b[^.!?;\n]{0,60}\b(?:booking|reservation)\b[^.!?;\n]{0,40}\b(?:been\s+)?(?:cancelled|canceled|confirmed|tentative|provisional)\b[^.!?;\n]*[?]|\b(?:does|do)\b[^.!?;\n]{0,60}\b(?:booking|reservation)s?\b[^.!?;\n]{0,40}\bexist\b|\bhave\s+you\s+made\b[^.!?;\n]{0,100}\breservations?\b|\b(?:confirm|check|verify)\b[^.!?;\n]{0,80}\byou\s+(?:made|have\s+made)\b[^.!?;\n]{0,100}\b(?:reservations?|bookings?)\b/i;
const reservationStatusAsk={test:(text:string)=>reservationStatusPattern.test(text)||receivedBookingStatusAsk(text)};
const fieldAsks={reservation_status:reservationStatusAsk,arrival:/\barrival\b|check[ -]?in|stay dates/i,departure:/\bdeparture\b|check[ -]?out|stay dates/i,folio_balance:/\bbalance\b/i,deposit_due:/\bdeposit|payment\b/i,deposit_recorded:/\bdeposit|payment\b/i};
/** Complete source asks are derived independently of the provider's selected fields. */
export function deriveReservationistReadFields(sourceText:string):ReservationistReadField[]{
 const fields=new Set<ReservationistReadField>();
 if(reservationStatusAsk.test(sourceText))fields.add('reservation_status');
 if(/\barrival\b|check[ -]?in|\bstay dates\b/i.test(sourceText))fields.add('arrival');
 if(/\bdeparture\b|check[ -]?out|\bstay dates\b/i.test(sourceText))fields.add('departure');
 if(/\bbalance\b|\bfolio\b/i.test(sourceText))fields.add('folio_balance');
 if(/\bdeposit(?:s)?\b|\bpayment(?:s)?\b|\bpaid\b/i.test(sourceText)){
  const due=/\bdue\b|\boutstanding\b|\bow(?:e|ing)\b|\bremaining\b|\bremains\b/i.test(sourceText),recorded=/\brecorded\b|\breceived\b|\bpaid\b|\bcredited\b/i.test(sourceText);
  if(due)fields.add('deposit_due');if(recorded)fields.add('deposit_recorded');if(!due&&!recorded){fields.add('deposit_due');fields.add('deposit_recorded');}
 }
 return reservationistReadFields.filter(field=>fields.has(field));
}
const grantSchema=z.object({authorizationId:readRefSchema,inputDigest:readDigestSchema,requestDigest:readDigestSchema,taskId:readRefSchema,requestId:readRefSchema,ownerRef:readRefSchema,threadId:readRefSchema,triggerMessageId:readRefSchema,propertyCode:readRefSchema,candidateId:readRefSchema,reservationRef:readRefSchema,allowedFields:z.array(fieldSchema).min(1).max(6),disclosure:z.enum(['guest','staff_only']),issuedAt:readTimestampSchema,expiresAt:readTimestampSchema,maxSourceAgeMs:z.number().int().nonnegative().safe()}).strict();
const proofSchema=z.object({evidenceRef:readRefSchema,sourceHash:readDigestSchema,observedAt:readTimestampSchema,expiresAt:readTimestampSchema,disclosure:z.enum(['guest','staff_only']),authorizationId:readRefSchema,inputDigest:readDigestSchema,requestDigest:readDigestSchema}).strict();
class ReadTaskError extends Error{constructor(readonly status:'blocked'|'needs_clarification',code:string){super(code);}}
/** Uses the existing typed dispatch and authorization/lock guards. No save or raw-handler edge. */
export async function prepareReservationistReadTask(rawInput:ReservationistReadTaskInput,deps:ReservationistReadTaskDependencies):Promise<ReservationistReadTaskResult>{
 deps.signal.throwIfAborted();
 const output:ReservationistReadTaskResult={status:'needs_clarification',guestText:'Please confirm the requested reservation or ledger details so staff can verify the answer.',preparedFacts:[],evidenceRefs:[],recoveryCodes:[]};
 let signal=deps.signal;
 try{
  const input=inputSchema.parse(rawInput),causalAt=Date.parse(input.clock.causalAt),{context}=deps;let sourceAt=Date.parse(input.clock.sourceAt);
  if(deps.evaluateSourceAt&&input.clock.sourceMode!=='current_read')throw new ReadTaskError('blocked','read_evaluation_clock_invalid');
  if(Date.now()>=input.clock.deadlineAt)throw new ReadTaskError('blocked','read_deadline_exceeded');
  signal=AbortSignal.any([deps.signal,context.signal,AbortSignal.timeout(Math.max(1,input.clock.deadlineAt-Date.now()))]);signal.throwIfAborted();
  const request=deps.request.toolId==='hms_read_reservation'?reservationContextRequestSchema.parse(deps.request):folioReadRequestSchema.parse(deps.request);
  if(input.clock.sourceMode!=='current_read'&&sourceAt>causalAt||context.now().getTime()!==sourceAt||context.transportId!==input.ownerRef||context.threadId!==input.threadId||context.triggerMessageId!==input.triggerMessageId||context.propertyCode!==input.propertyCode||context.parentRef!==input.requestId||request.candidateId!==input.candidateId||request.reservationRef!==input.reservationRef)throw new ReadTaskError('blocked','read_scope_mismatch');
  if(readInputDigest([...input.fields].sort())!==readInputDigest([...deriveReservationistReadFields(input.taskSource.quote)].sort()))throw new ReadTaskError('blocked','read_requested_field_coverage_mismatch');
  const expectedSections=[...new Set(input.fields.map(field=>fieldSections[field]))];
  if(readInputDigest([...request.sections].sort())!==readInputDigest(expectedSections.sort())||input.fields.some(field=>!fieldAsks[field].test(input.taskSource.quote))||input.taskSource.end-input.taskSource.start!==input.taskSource.quote.length)throw new ReadTaskError('blocked','read_request_fields_mismatch');
  const binding:ReservationistReadBinding={inputDigest:readInputDigest(input),requestDigest:readInputDigest(request),taskId:input.taskId,requestId:input.requestId,ownerRef:input.ownerRef,threadId:input.threadId,triggerMessageId:input.triggerMessageId,propertyCode:input.propertyCode,candidateId:input.candidateId,reservationRef:input.reservationRef};
  const lookup=deps.lookupTarget;
  if(input.reservationRef.startsWith('resref_')&&!lookup)throw new ReadTaskError('blocked','current_lookup_target_unavailable');
  if(input.lookupTargetDigest||lookup){
   if(!lookup||input.lookupTargetDigest!==lookup.receipt.digest||input.clock.sourceMode!=='current_read')throw new ReadTaskError('blocked','current_lookup_target_unavailable');
   const identity=()=>readInputDigest({input:rawInput,request:deps.request,context:{transportId:context.transportId,threadId:context.threadId,triggerMessageId:context.triggerMessageId,propertyCode:context.propertyCode,parentRef:context.parentRef,branchId:context.branchId,releaseId:context.releaseId,requester:context.requester},receipt:lookup.receipt});const before=identity();
   assertCurrentLookupTargetReceipt(lookup.receipt,new Date(sourceAt),{taskId:binding.taskId,requestId:binding.requestId,ownerRef:binding.ownerRef,threadId:binding.threadId,triggerMessageId:binding.triggerMessageId,propertyCode:binding.propertyCode,candidateId:binding.candidateId,reservationRef:binding.reservationRef,authorizationId:context.requester.authorizationId});
   if(!await lookup.authorize(lookup.receipt,signal)||identity()!==before)throw new ReadTaskError('blocked','current_lookup_target_denied');
   assertCurrentLookupTargetReceipt(lookup.receipt,new Date(sourceAt),{taskId:binding.taskId,requestId:binding.requestId,ownerRef:binding.ownerRef,threadId:binding.threadId,triggerMessageId:binding.triggerMessageId,propertyCode:binding.propertyCode,candidateId:binding.candidateId,reservationRef:binding.reservationRef,authorizationId:context.requester.authorizationId});
  }
  const bindingDigest=readInputDigest(binding);
  const rawGrant=await deps.authorizeRead(binding,signal);if(readInputDigest(binding)!==bindingDigest)throw new ReadTaskError('blocked','read_authority_denied');signal.throwIfAborted();
  if(!rawGrant)throw new ReadTaskError('needs_clarification','read_authority_unavailable');
  const grant=grantSchema.parse(rawGrant);
  if(Object.entries(binding).some(([key,value])=>grant[key as keyof ReservationistReadGrant]!==value)||grant.authorizationId!==context.requester.authorizationId||grant.disclosure!=='guest'||input.fields.some(field=>!grant.allowedFields.includes(field))||Date.parse(grant.issuedAt)>sourceAt||Date.parse(grant.expiresAt)<=sourceAt||Date.parse(grant.expiresAt)<=Date.parse(grant.issuedAt))throw new ReadTaskError('blocked','read_authority_denied');
  const rawResult=await executeRead({...context,signal},request);signal.throwIfAborted();
  if(deps.evaluateSourceAt){const evaluated=Date.parse(deps.evaluateSourceAt());if(!Number.isFinite(evaluated)||evaluated<sourceAt||evaluated>Date.now()||Date.now()>=input.clock.deadlineAt)throw new ReadTaskError('blocked','read_evaluation_clock_invalid');sourceAt=evaluated;}
  if(Date.parse(grant.issuedAt)>sourceAt||Date.parse(grant.expiresAt)<=sourceAt)throw new ReadTaskError('blocked','read_authority_denied');
  const receipt=readResultSchema.parse(rawResult) as ReadResult<unknown>;
  output.evidenceRefs=[input.taskSource.sourceRef,...receipt.evidence.map(evidence=>evidence.evidenceRef)];output.readReceipt={binding,grant,result:receipt,sourceProofs:[],...(lookup?{lookupTargetReceipt:structuredClone(lookup.receipt)}:{})};
  if(receipt.toolId!==request.toolId||receipt.scopeRef!==input.reservationRef)throw new ReadTaskError('blocked','read_receipt_scope_mismatch');
  if(!['ok','partial'].includes(receipt.status)||!receipt.data)throw new ReadTaskError('needs_clarification','read_source_unavailable');
  const evidenceInputDigest=readInputDigest({binding,grant,receipt});
  const rawProofs=await deps.authorizeEvidence({binding,grant,receipt},signal);if(readInputDigest({binding,grant,receipt})!==evidenceInputDigest)throw new ReadTaskError('blocked','read_capture_denied');signal.throwIfAborted();
  if(!rawProofs?.length)throw new ReadTaskError('needs_clarification','read_capture_unavailable');
  const proofs=z.array(proofSchema).max(64).parse(rawProofs);output.readReceipt.sourceProofs=proofs;
  const fresh=(observedAt:string,expiresAt:string)=>Date.parse(observedAt)<=sourceAt&&sourceAt-Date.parse(observedAt)<=grant.maxSourceAgeMs&&Date.parse(expiresAt)>sourceAt&&Date.parse(expiresAt)>Date.parse(observedAt);
  if(new Set(proofs.map(proof=>proof.evidenceRef)).size!==proofs.length||proofs.some(proof=>proof.authorizationId!==grant.authorizationId||proof.inputDigest!==binding.inputDigest||proof.requestDigest!==binding.requestDigest||proof.disclosure!=='guest'||!fresh(proof.observedAt,proof.expiresAt)||!receipt.evidence.some(evidence=>evidence.evidenceRef===proof.evidenceRef)))throw new ReadTaskError('blocked','read_capture_denied');
  for(const evidence of receipt.evidence){const proof=proofs.find(proof=>proof.evidenceRef===evidence.evidenceRef);if(!proof)throw new ReadTaskError('needs_clarification','read_capture_unavailable');if(evidence.sourceSystem!=='hms'||!evidence.scopeVerified||evidence.requestBranchId!==context.branchId||!fresh(evidence.observedAt,evidence.expiresAt)||proof.observedAt!==evidence.observedAt||proof.expiresAt!==evidence.expiresAt||evidence.sourceHash&&proof.sourceHash!==evidence.sourceHash)throw new ReadTaskError('blocked','read_evidence_denied');}
  if(lookup&&!proofs.some(proof=>proof.evidenceRef===lookup.receipt.sourceRef&&proof.sourceHash===lookup.receipt.sourceHash&&proof.observedAt===lookup.receipt.observedAt))throw new ReadTaskError('blocked','current_lookup_source_mismatch');
  const lines:string[]=[];
  const add=(field:ReservationistReadField,value:unknown,evidence:ReadEvidence,text:string)=>{const proof=proofs.find(proof=>proof.evidenceRef===evidence.evidenceRef)!;output.preparedFacts.push({key:field,label:field.replaceAll('_',' '),value,source:'hms',authority:'authorized',status:'known',evidenceRef:evidence.evidenceRef,sourceHash:proof.sourceHash,scopeVerified:true,observedAt:evidence.observedAt,expiresAt:evidence.expiresAt,...(lookup?{scopeHash:lookup.receipt.digest,manifestSha256:lookup.receipt.digest}:{}),requesterAuthorizationId:grant.authorizationId,disclosure:'guest'});lines.push(text);};
  if(request.toolId==='hms_read_reservation'){
   const result=reservationContextReadResultSchema.parse(receipt);const data=result.data!;
   for(const field of input.fields){if(!['reservation_status','arrival','departure'].includes(field))throw new ReadTaskError('blocked','read_field_type_mismatch');const section=field==='reservation_status'?data.core:data.stay;if(!section.data){output.recoveryCodes.push(`read_field_unavailable:${field}`);continue;}const key=field==='reservation_status'?'status':field;const fact=(section.data as Record<string,unknown>)[key] as {state:string;value:unknown;evidenceRef:string;observedAt:string;expiresAt:string};
    if(!fact||fact.state!=='known'){output.recoveryCodes.push(`read_field_unavailable:${field}`);continue;}const evidence=receipt.evidence.find(evidence=>evidence.evidenceRef===fact.evidenceRef);if(!evidence||!fresh(fact.observedAt,fact.expiresAt)||typeof fact.value!=='string')throw new ReadTaskError('blocked','read_fact_unbound');
    if(field==='reservation_status'){if(!/^[A-Za-z][A-Za-z _-]{0,63}$/.test(fact.value))throw new ReadTaskError('blocked','read_status_invalid');add(field,fact.value,evidence,`The existing reservation record shows status: ${fact.value}.`);}else{const date=new Date(`${fact.value}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(fact.value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==fact.value)throw new ReadTaskError('blocked','read_date_invalid');add(field,fact.value,evidence,`The recorded ${field} date is ${fact.value}.`);}
   }
  }else{
   const data=folioReadDataSchema.parse(receipt.data),eligibility=folioClaimEligibility(data.disclosure.recipientClass,data.disclosure.inquiryClass);
   if(!['reservation_guest','authorized_booking_contact'].includes(data.disclosure.recipientClass)||eligibility==='blocked')throw new ReadTaskError('blocked','read_disclosure_denied');if(eligibility!=='full')output.recoveryCodes.push('read_inquiry_partial');
   const evidence=receipt.evidence[0];if(!evidence||data.observedAt!==evidence.observedAt)throw new ReadTaskError('blocked','read_fact_unbound');
   for(const field of input.fields){
    let amount:string|undefined,selectedEvidence=evidence,partial=false;
    if(field==='folio_balance')amount=data.totalBalance;else if(field==='deposit_due')amount=data.depositSummary?.due.amount;else if(field==='deposit_recorded')amount=data.depositSummary?.paid.amount;else throw new ReadTaskError('blocked','read_field_type_mismatch');
    const explicitSection=field==='folio_balance'?data.balance:data.deposits;
    if(explicitSection)amount=undefined;
    if(!explicitSection&&(receipt.status==='partial'||receipt.completeness!=='complete'))partial=true;
    if(amount===undefined){
     const section=field==='folio_balance'?data.balance:data.deposits;
     if(section?.data){
      partial=section.state==='partial'||section.completeness!=='complete';
      const items=section.data.items as Array<Record<string,unknown>>,values:bigint[]=[];let unavailable=false;
      for(const item of items){
       const fact=item[field==='folio_balance'?'balance':field==='deposit_due'?'due':'paid'] as {state:string;value?:{amount:string;currency:string;basis:string};evidenceRef:string;observedAt:string;expiresAt:string};
       if(!fact||fact.state!=='known'){unavailable=true;break;}
       const factEvidence=receipt.evidence.find(source=>source.evidenceRef===fact.evidenceRef),value=fact.value;
       if(!factEvidence||!fresh(fact.observedAt,fact.expiresAt)||!value||value.currency!==data.currency||value.basis!==(field==='folio_balance'?'ledger_balance':'ledger_movement')||! /^-?(?:0|[1-9]\d*)\.\d{2}$/.test(value.amount))throw new ReadTaskError('blocked','read_fact_unbound');
       const [whole,fraction]=value.amount.replace('-','').split('.');values.push((BigInt(whole)*100n+BigInt(fraction))*(value.amount.startsWith('-')?-1n:1n));selectedEvidence=factEvidence;
      }
      // A partial multi-row observation cannot certify a total. A single known balance is a scoped observed amount.
      if(!unavailable&&values.length===1){const total=values[0],unsigned=total<0n?-total:total;amount=`${total<0n?'-':''}${unsigned/100n}.${(unsigned%100n).toString().padStart(2,'0')}`;}
      else if(!unavailable&&values.length>1&&section.state==='available'&&section.completeness==='complete'){const total=values.reduce((sum,value)=>sum+value,0n),unsigned=total<0n?-total:total;amount=`${total<0n?'-':''}${unsigned/100n}.${(unsigned%100n).toString().padStart(2,'0')}`;}
     }
    }
    if(amount===undefined){output.recoveryCodes.push(`read_field_unavailable:${field}`);continue;}
    if(partial)output.recoveryCodes.push(`read_partial_total:${field}`);
    const value={amount,currency:data.currency,basis:field==='folio_balance'?'ledger_balance':'ledger_movement'},label=field==='folio_balance'?(partial?'The observed partial folio balance':'The recorded folio balance'):field==='deposit_due'?'The recorded deposit amount due':'The recorded deposit ledger amount';add(field,value,selectedEvidence,`${label} is ${data.currency} ${amount}.`);
   }
  }
  output.status=output.recoveryCodes.length?'needs_clarification':'complete';output.guestText=[...lines,...(output.recoveryCodes.length?['Staff must verify the remaining requested record details.']:[])].join(' ')||output.guestText;return output;
 }catch(error){signal.throwIfAborted();output.status=error instanceof ReadTaskError?error.status:'blocked';output.recoveryCodes.push(error instanceof ReadTaskError?error.message:'read_authority_or_schema_failure');output.preparedFacts=[];return output;}
}
