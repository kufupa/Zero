import {assertCurrentLookupTargetReceipt} from './reservationist-lookup-target.js';
import {draftQuoteOccupancyHold} from './child-occupancy.js';
import {assertReservationistRecipientReceipt,RECIPIENT_PREPARATION_CLAUSE,type RecipientPreparationReceipt} from './reservationist-recipient-preparation.js';
import {assertReservationistChannelBookingSyncPacket} from './reservationist-pending-action.js';
import {assertReservationistExistingDocumentReceiptFresh,type ReservationistExistingDocumentReceipt} from './reservationist-existing-document.js';
import {
  isDraftRouteReleaseDescriptor,
  isDraftRouteEvidence,
  resolveCurrentDraftRouteAuthority,
  type DraftRouteReleaseDescriptor,
} from './draft-route-factory.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
} from '../db/schema/mail.js';
import { EvidenceRefSchema, isEvidenceFresh } from './draft-evidence.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { z } from 'zod';
import { load } from 'cheerio';
import { assessQuoteAcceptance, PRICED_QUOTE_REUSE_MS, quoteDigest } from '../quote-proposal/quote-revision.js';
import type { BookingAcceptanceProof } from './reservationist-booking-packet.js';
import { reservationContextReadResultSchema } from '../hms/reservation-context-contract.js';
import type { PreparedFact } from './prepared-draft-input.js';
import type { ReservationistReadReceipt } from './reservationist-read-task.js';

/** Versioned, closed token carried from explicit human review to send. */
export const DRAFT_APPROVAL_VERSION = 'u6-draft-approval-v1';
export const DRAFT_APPROVAL_POLICY_VERSION = 'u6-draft-policy-v1';
export const DRAFT_APPROVAL_PURPOSE = 'draft-only';

export class DraftApprovalError extends Error {
  readonly code = 'DRAFT_APPROVAL_INVALID' as const;

  constructor(message = 'draft approval is invalid') {
    super(message);
    this.name = 'DraftApprovalError';
  }
}

export class DraftQuoteOccupancyError extends DraftApprovalError {}

export type DraftApprovalAttachment = {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  contentBase64?: string;
};

/** Pending packets are plans, never independent observed PMS/payment completion. */
export function assertReservationistResultWording(
  result: unknown,
  payload: Pick<DraftApprovalPayload, 'subject' | 'html' | 'text'>,
  now = new Date(),
): void {
  if (result === undefined || result === null) return;
  const value = result as {
    version?: unknown;
    readiness?: unknown;
    tasks?: {id?: string; kind?: string; status?: unknown; guestText?: string; evidenceRefs?: string[]}[];
    readReceipts?: ReservationistReadReceipt[];
    preparedFacts?: PreparedFact[];
  };
  if (value.version !== 1)
    throw new DraftApprovalError('reservationist result version unavailable');
  let text = [payload.subject, payload.text, load(payload.html).text()].join(' ');
  // A recorded existing status is admitted only from the exact typed fresh read and rendered fact.
  for(const receipt of value.readReceipts??[]){
    const parsed=reservationContextReadResultSchema.safeParse(receipt?.result);if(!parsed.success)continue;
    const fact=parsed.data.data?.core.data?.status;if(fact?.state!=='known'||typeof fact.value!=='string'||!/^[A-Za-z][A-Za-z _-]{0,63}$/.test(fact.value))continue;
    const task=value.tasks?.find(task=>task.id===receipt.binding?.taskId),evidence=receipt.result.evidence.find(e=>e.evidenceRef===fact.evidenceRef);
    const authorized=value.preparedFacts?.find(item=>item.key==='reservation_status'&&item.value===fact.value&&item.status==='known'&&item.authority==='authorized'&&item.scopeVerified===true&&item.disclosure==='guest'&&item.evidenceRef===fact.evidenceRef&&item.requesterAuthorizationId===receipt.grant?.authorizationId&&receipt.sourceProofs.some(proof=>proof.evidenceRef===item.evidenceRef&&proof.sourceHash===item.sourceHash));
    const clause=`The existing reservation record shows status: ${fact.value}.`;
    if(task?.kind!=='question'||!receipt.grant?.allowedFields.includes('reservation_status')||!['complete','needs_clarification'].includes(String(task.status))||!task.guestText?.includes(clause)||!task.evidenceRefs?.includes(fact.evidenceRef)||!authorized||!evidence||fact.observedAt!==evidence.observedAt||fact.expiresAt!==evidence.expiresAt||Date.parse(fact.expiresAt)<=now.getTime())continue;
    assertReservationistResultFreshForAction({version:1,tasks:[task],readReceipts:[receipt]},now);
    text=text.split(clause).join('');
  }
  // Conditional policy classes and fee bases are not completed customer actions.
  // Admit only the exact source-authorized renderer clause; every status token
  // must also have non-action grammar, even if policy metadata is forged.
  const completionToken = /\b(?:confirmed|booked|completed|secured|approved|made|saved|guaranteed|cleared|paid|settled)\b/gi;
  for (const fact of value.preparedFacts ?? []) {
    const task = value.tasks?.find(t => fact.key === `quote_terms_cancellation_${t.id}`);
    if (task?.kind !== 'question' || task.status !== 'complete' || fact.source !== 'mail' || fact.authority !== 'authorized' || fact.status !== 'known' || fact.scopeVerified !== true || fact.disclosure !== 'guest' || !/^[a-f0-9]{64}$/.test(fact.sourceHash ?? '') || !/^[a-f0-9]{64}$/.test(fact.scopeHash ?? '') || !fact.evidenceRef || !task.evidenceRefs?.includes(fact.evidenceRef) || typeof fact.value !== 'string' || fact.value.length > 512 || task.guestText !== `Regarding your question: ${fact.value}`) continue;
    const policy = fact.value, tokens = [...policy.matchAll(completionToken)];
    const conditional = tokens.length > 0 && tokens.every(match => {
      const before = policy.slice(0, match.index), after = policy.slice(match.index! + match[0].length);
      if (match[0].toLowerCase() === 'guaranteed') return /\b(?:fee|charge)[^.!?;]{0,100}\b(?:will|may) be charged for $/i.test(before) && /^ reservations (?:who|that)\b/i.test(after);
      if (match[0].toLowerCase() === 'booked') return /\b(?:cancellation fee|fee|charge)[^.!?;]{0,140}\b(?:value|cost) of (?:one night[’']s |the )?accommodation $/i.test(before) && /^(?:[.!?;]|$)/.test(after);
      return false;
    });
    if (conditional) text = text.split(task.guestText!).join('');
  }
  // Evaluate each claim independently: a negated clause cannot clear a later claim.
  const completion = /\b(?:confirmed|booked|completed|secured|approved|made|saved|guaranteed|cleared|paid|settled)\b/gi;
  const hasCompletionClaim = text.split(/[.!?;\n]+|\b(?:but|however|yet)\b/i).some((clause) => {
    for (const match of clause.matchAll(completion)) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index! + match[0].length);
      const relevant = /\b(?:booking|reservations?|rooms?|accommodation|payment|funds|deposit)\b/i.test(clause) ||
        match[0].toLowerCase() === 'paid' && /^\s+in\s+full\b/i.test(after);
      if (!relevant) continue;
      // Negation must govern this status, not merely occur elsewhere in the text.
      const negated = /\b(?:not|never)\s+(?:(?:yet|been|already)\s+){0,2}$/i.test(before) ||
        /\bno\s+(?:payment|funds|deposit|booking|reservation|rooms?)\s+(?:(?:has|have|been|is|are|was|were)\s+){0,3}$/i.test(before);
      if (!negated) return true;
    }
    return false;
  });
  if (hasCompletionClaim)
    throw new DraftApprovalError(
      'reservationist completion requires independent observed action evidence',
    );
}

/** Server-issued freshness observation; no TTL or commercial cutoff is invented here. */
export type ReservationistSourceFreshnessProof = {
  authorizationId: string;
  sourceRefs: string[];
  observedAt: string;
  expiresAt: string;
  purpose: 'offer_source' | 'current_inventory';
};
/** Current lookup read facts must retain the exact typed read result and source join. */
export function assertReservationistLookupReadFacts(receipt:ReservationistReadReceipt,facts:PreparedFact[],now:Date):void{
 const target=receipt.lookupTargetReceipt;if(!target)return;
 assertCurrentLookupTargetReceipt(target,now,{taskId:receipt.binding.taskId,requestId:receipt.binding.requestId,ownerRef:receipt.binding.ownerRef,threadId:receipt.binding.threadId,triggerMessageId:receipt.binding.triggerMessageId,propertyCode:receipt.binding.propertyCode,candidateId:receipt.binding.candidateId,reservationRef:receipt.binding.reservationRef,authorizationId:receipt.grant.authorizationId});
 const read=reservationContextReadResultSchema.parse(receipt.result),selected=facts.filter(f=>f.scopeHash===target.digest);
 if(!selected.length)throw new DraftApprovalError('current lookup read fact unavailable');
 for(const f of selected){const source=f.key==='reservation_status'?read.data?.core.data?.status:f.key==='arrival'?read.data?.stay.data?.arrival:f.key==='departure'?read.data?.stay.data?.departure:null;
  if(!source||source.state!=='known'||quoteDigest(source.value)!==quoteDigest(f.value)||f.status!=='known'||f.authority!=='authorized'||f.source!=='hms'||f.scopeVerified!==true||f.disclosure!=='guest'||f.requesterAuthorizationId!==receipt.grant.authorizationId||f.manifestSha256!==target.digest||f.evidenceRef!==source.evidenceRef||f.observedAt!==source.observedAt||f.expiresAt!==source.expiresAt||!receipt.sourceProofs.some(p=>p.evidenceRef===f.evidenceRef&&p.sourceHash===f.sourceHash))throw new DraftApprovalError('current lookup read fact source mismatch');
 }
}
export function assertReservationistResultFreshForAction(result: unknown, now = new Date()): void {
  if (result == null) return;
  const value = result as { recipientPreparations?:RecipientPreparationReceipt[]; version?: unknown; quoteRevisions?: unknown[]; importedOffers?: unknown[]; approvedOverrides?: unknown[]; packets?: unknown[]; readReceipts?: ReservationistReadReceipt[]; existingDocumentReceipts?: ReservationistExistingDocumentReceipt[]; preparedFacts?: PreparedFact[]; tasks?: {id?: string; status?: string; evidenceRefs?: string[]}[] };
  if (value.version !== 1) throw new DraftApprovalError('reservationist result version unavailable');
  if (!Number.isFinite(now.getTime())) throw new DraftApprovalError('reservationist source evaluation time unavailable');
  for(const task of value.tasks??[])if((task as {guestText?:string}).guestText===RECIPIENT_PREPARATION_CLAUSE&&!value.recipientPreparations?.some(r=>r.input.taskId===task.id))throw new DraftApprovalError('recipient preparation receipt unavailable');
  for(const fact of value.preparedFacts??[])if(fact.key.startsWith('reply_recipients_')&&!value.recipientPreparations?.some(r=>r.digest===fact.scopeHash))throw new DraftApprovalError('recipient preparation receipt unavailable');
  for(const task of value.tasks??[]){const count=/^Please see the (\d+) existing documents attached[.]$/.exec((task as {guestText?:string}).guestText??'');if(count&&(!Number.isSafeInteger(Number(count[1]))||Number(count[1])<2||value.existingDocumentReceipts?.filter(r=>r.binding.taskId===task.id).length!==Number(count[1])))throw new DraftApprovalError('existing document batch receipt unavailable');}
  for(const receipt of value.recipientPreparations??[]){
   try{assertReservationistRecipientReceipt(receipt,now);const r=receipt.input,task=value.tasks?.find(t=>t.id===r.taskId),fact=value.preparedFacts?.find(f=>f.key===`reply_recipients_${r.taskId}`);
    if(!task||task.status!=='complete'||(task as {guestText?:string}).guestText!==RECIPIENT_PREPARATION_CLAUSE||!task.evidenceRefs?.includes(`recipient-header:${r.headerProof.sourceRowHash}`)||!task.evidenceRefs.includes(`mailbox-config:${r.mailboxSource.sourceHash}`)||!fact||fact.scopeHash!==receipt.digest||fact.sourceHash!==r.headerProof.sourceRowHash||fact.observedAt!==r.mailboxSource.capture.observedAt||fact.expiresAt!==r.expiresAt||fact.authority!=='authorized'||fact.source!=='mail'||fact.scopeVerified!==true||fact.disclosure!=='guest'||quoteDigest(fact.value)!==quoteDigest({toCount:receipt.prepared.to.length,ccCount:receipt.prepared.cc.length,receiptDigest:receipt.digest,historicalMailboxTruth:false,emailSend:false}))throw new Error('recipient binding invalid');
   }catch{throw new DraftApprovalError('recipient preparation source unavailable or expired');}
  }
  for (const receipt of value.existingDocumentReceipts ?? []) {
    try {
      assertReservationistExistingDocumentReceiptFresh(receipt, now);
      const task = value.tasks?.find(task => task.id === receipt.binding.taskId);
      if (!task || task.status !== 'complete' || !task.evidenceRefs?.includes(receipt.binding.sourceRef) || !task.evidenceRefs.includes(receipt.capture.artifactRef)) throw new Error('document task binding unavailable');
      if(receipt.input.requestedTargets){const members=value.existingDocumentReceipts!.filter(r=>r.binding.taskId===receipt.binding.taskId),targets=receipt.input.requestedTargets;if(members.length!==targets.length||members.some(r=>quoteDigest(r.input.requestedTargets)!==quoteDigest(targets))||!targets.every(t=>members.filter(r=>r.binding.reservationRef===t.reservationRef&&r.binding.priorQuoteRef===t.priorQuoteRef).length===1)||new Set(members.map(r=>r.capture.body.sha256)).size!==members.length||new Set(members.map(r=>r.capture.artifactRef)).size!==members.length||new Set(members.map(r=>r.binding.documentRef)).size!==members.length)throw new Error('document batch incomplete');}
    } catch { throw new DraftApprovalError('reservationist existing document source authority unavailable or expired'); }
  }
  const current=value as typeof value&{preparedFacts?:PreparedFact[];currentNativeObservations?:import('./reservationist-execution.js').CurrentNativeObservationReceipt[]};
  for(const task of current.tasks??[])if((task as {guestText?:string}).guestText?.includes('The current native observation shows')&&!current.currentNativeObservations?.some(r=>r.observation.taskId===task.id))throw new DraftApprovalError('current native observation receipt unavailable');
  const nativeFacts=current.preparedFacts?.filter(f=>f.key.startsWith('current_native_options_'))??[];
  for(const fact of nativeFacts)if(!current.currentNativeObservations?.some(r=>quoteDigest(r.fact)===quoteDigest(fact)))throw new DraftApprovalError('current native observation receipt unavailable');
  for(const receipt of current.currentNativeObservations??[]){
   const {digest,...data}=receipt,o=receipt.observation,s=o.source,task=current.tasks?.find(t=>t.id===o.taskId),fail=()=>{throw new DraftApprovalError('current native observation authority unavailable or expired');};
   if(!['room_options','breakfast_options'].includes(receipt.topic)||receipt.fact.key!==`current_native_options_${o.taskId}`||quoteDigest(receipt.fact.value)!==quoteDigest({labels:receipt.labels,sourceAt:o.sourceAt,historicalTruth:false,held:false})||! /^[a-f0-9]{64}$/.test(s.sha256)||!s.toolVersion||s.request.propertyCode!==o.propertyCode||s.result.propertyCode!==o.propertyCode||s.result.outcome!=='quote'||Date.parse(o.sourceAt)<Date.parse(s.observedAt)||digest!==quoteDigest(data)||o.kind!=='current_native_observation'||!o.requestId||!o.ownerRef||!o.threadId||!o.propertyCode||!task||task.status!=='complete'||!task.evidenceRefs?.includes(s.ref)||receipt.fact.evidenceRef!==s.ref||receipt.fact.sourceHash!==s.sha256||receipt.fact.observedAt!==s.observedAt||receipt.fact.expiresAt!==o.expiresAt||receipt.fact.authority!=='authorized'||receipt.fact.source!=='hms'||receipt.fact.disclosure!=='guest'||!Number.isSafeInteger(o.maxSourceAgeMs)||o.maxSourceAgeMs<0||!Number.isFinite(Date.parse(s.observedAt))||Date.parse(s.observedAt)>now.getTime()||now.getTime()-Date.parse(s.observedAt)>o.maxSourceAgeMs||!Number.isFinite(Date.parse(o.expiresAt))||Date.parse(o.expiresAt)<=now.getTime())fail();
   if(o.groupIds.length!==s.request.rooms.length||new Set(o.groupIds).size!==o.groupIds.length||s.result.groups.length!==s.request.rooms.length||s.request.rooms.some(room=>{const g=s.result.groups.filter(g=>g.id===room.id);return !o.groupIds.includes(room.id)||g.length!==1||quoteDigest(g[0].request)!==quoteDigest(room)||g[0].completeness.search!=='complete'||g[0].completeness.requiredFacts!=='complete';}))fail();
   const labels=[...new Set(s.result.groups.flatMap(g=>g.options.filter(opt=>opt.availability==='available'&&opt.eligibility==='verified'&&opt.matchStatus==='match'&&opt.held===false).map(opt=>receipt.topic==='room_options'?opt.room.label:opt.board)))];
   if(quoteDigest(labels)!==quoteDigest(receipt.labels))fail();
  }
  const acceptedRevisionDigests = new Set<string>();
  for (const raw of value.packets ?? []) {
    type PacketProof = {kind?: string; sourceRef?: string; sourceHash?: string; authorizationId?: string; propertyCode?: string; scopeDigest?: string; reservationRef?: string; observedAt?: string; expiresAt?: string; maxSourceAgeMs?: number};
    const packet = raw as {kind?: string; taskId?: string; status?: string; saved?: boolean; businessRulesValidated?: boolean; authorizationId?: string; propertyCode?: string; revisionId?: string; scopeDigest?: string; reservationRef?: string; sourceRefs?: string[]; sourceProofs?: PacketProof[]; acceptanceProof?: BookingAcceptanceProof; requestBinding?: {requestId?: string;ownerRef?: string;threadId?: string;taskId?: string;sourceRef?: string;sourceHash?: string;observedAt?: string;changes?: unknown}; requested?: unknown; digest?: string};
    // Failed packets remain review evidence. They do not assert action readiness.
    if (packet.status !== 'pending_pms_action') continue;
    const fail = () => { throw new DraftApprovalError('reservationist packet source authority unavailable or expired'); };
    if(packet.kind==='channel_booking_sync'){try{assertReservationistChannelBookingSyncPacket(packet,now);}catch{fail();}continue;}
    const {digest, ...packetData} = packet;
    if (!['accepted_quote','new_booking','change','cancel_request'].includes(packet.kind ?? '') || !packet.taskId || packet.saved !== false || packet.businessRulesValidated !== true || !packet.authorizationId || !packet.propertyCode || !digest || digest !== quoteDigest(packetData) || !Array.isArray(packet.sourceRefs) || !packet.sourceRefs.length || !Array.isArray(packet.sourceProofs) || !packet.sourceProofs.length || packet.sourceProofs.length > 256) fail();
    const proofs = packet.sourceProofs!;
    if (!proofs.some(proof => proof.kind === 'current') || new Set(packet.sourceRefs).size !== packet.sourceRefs!.length || packet.sourceRefs!.some(ref => !proofs.some(proof => proof.sourceRef === ref))) fail();
    for (const proof of proofs) {
      const observed = Date.parse(proof.observedAt ?? '');
      if (!['current','causal'].includes(proof.kind ?? '') || !proof.sourceRef || !packet.sourceRefs!.includes(proof.sourceRef) || !/^[a-f0-9]{64}$/.test(proof.sourceHash ?? '') || proof.authorizationId !== packet.authorizationId || proof.propertyCode !== packet.propertyCode || !Number.isFinite(observed) || observed > now.getTime()) fail();
      if (proof.scopeDigest !== undefined && proof.scopeDigest !== packet.scopeDigest || proof.reservationRef !== undefined && proof.reservationRef !== packet.reservationRef) fail();
      if (proof.kind === 'current' && (!Number.isSafeInteger(proof.maxSourceAgeMs) || proof.maxSourceAgeMs! < 0 || now.getTime() - observed > proof.maxSourceAgeMs! || !Number.isFinite(Date.parse(proof.expiresAt ?? '')) || Date.parse(proof.expiresAt!) <= now.getTime() || Date.parse(proof.expiresAt!) <= observed)) fail();
    }
    if (packet.kind === 'change' || packet.kind === 'cancel_request') {
      const request = packet.requestBinding;
      if (!packet.taskId || !packet.reservationRef || !request?.requestId || !request.ownerRef || !request.threadId || request.taskId !== packet.taskId || quoteDigest(request.changes ?? null) !== quoteDigest(packet.requested ?? null) || !proofs.some(proof => proof.kind === 'causal' && proof.sourceRef === request.sourceRef && proof.sourceHash === request.sourceHash && proof.observedAt === request.observedAt)) fail();
    }
    if (packet.kind === 'accepted_quote') {
      const accepted = packet.acceptanceProof;
      if (!accepted || accepted.revision.id !== packet.revisionId || accepted.revision.scopeDigest !== packet.scopeDigest || accepted.revision.authorizationId !== packet.authorizationId || accepted.revision.propertyCode !== packet.propertyCode || !Number.isFinite(Date.parse(accepted.sourceEvaluationAt)) || Date.parse(accepted.sourceEvaluationAt) > now.getTime() || assessQuoteAcceptance(accepted).status !== 'accepted' || !proofs.some(proof => proof.kind === 'causal' && proof.sourceRef === accepted.sentProof?.sourceRef && proof.sourceHash === accepted.sentProof?.sourceHash && proof.observedAt === accepted.sentProof?.sentAt) || accepted.revision.groups.some(group => !proofs.some(proof => proof.kind === 'causal' && proof.sourceRef === group.sourceRef && proof.sourceHash === group.sourceHash && proof.observedAt === group.observedAt))) fail();
      acceptedRevisionDigests.add(quoteDigest(accepted!.revision));
    }
  }
  for(const fact of value.preparedFacts??[]){if(['deposit_due','deposit_recorded'].includes(fact.key)&&fact.scopeHash&&!value.readReceipts?.some(receipt=>receipt.paymentTargetReceipt?.digest===fact.scopeHash))throw new DraftApprovalError('reservationist payment target source unavailable');}
  for(const fact of value.preparedFacts??[])if(fact.source==='hms'&&fact.manifestSha256&&fact.manifestSha256===fact.scopeHash&&!value.readReceipts?.some(r=>r.lookupTargetReceipt?.digest===fact.scopeHash))throw new DraftApprovalError('current lookup target receipt unavailable');
  for (const receipt of value.readReceipts ?? []) {
    if((receipt.binding?.reservationRef??'').startsWith('resref_')&&!receipt.lookupTargetReceipt)throw new DraftApprovalError('current lookup target receipt unavailable');
    if(receipt.lookupTargetReceipt){try{if(value.preparedFacts)assertReservationistLookupReadFacts(receipt,value.preparedFacts,now);if(!receipt.sourceProofs.some(p=>p.evidenceRef===receipt.lookupTargetReceipt!.sourceRef&&p.sourceHash===receipt.lookupTargetReceipt!.sourceHash&&p.observedAt===receipt.lookupTargetReceipt!.observedAt))throw new Error('lookup read source mismatch');assertCurrentLookupTargetReceipt(receipt.lookupTargetReceipt,now,{taskId:receipt.binding.taskId,requestId:receipt.binding.requestId,ownerRef:receipt.binding.ownerRef,threadId:receipt.binding.threadId,triggerMessageId:receipt.binding.triggerMessageId,propertyCode:receipt.binding.propertyCode,candidateId:receipt.binding.candidateId,reservationRef:receipt.binding.reservationRef,authorizationId:receipt.grant.authorizationId});}catch{throw new DraftApprovalError('current lookup target source unavailable or expired');}}
    if(receipt.paymentTargetReceipt){const target=receipt.paymentTargetReceipt,{digest,...data}=target,b=target.binding,nowMs=now.getTime();
     if(!b||digest!==quoteDigest(data)||b.taskSourceDigest!==quoteDigest(target.taskSource)||b.targetFactsDigest!==quoteDigest(target.facts)||!Array.isArray(target.facts)||target.facts.filter(f=>f.kind==='reservation_reference').length!==1||target.facts.find(f=>f.kind==='reservation_reference')?.value!==b.reservationRef||target.facts.some(f=>!['dates','guest','reservation_reference'].includes(f.kind))||!target.facts.some(f=>['dates','guest'].includes(f.kind))||!['taskId','requestId','ownerRef','threadId','propertyCode','candidateId','reservationRef'].every(key=>b[key as keyof typeof b]===receipt.binding[key as keyof typeof receipt.binding])||b.authorizationId!==receipt.grant.authorizationId||!receipt.sourceProofs.some(proof=>proof.evidenceRef===b.sourceRef&&proof.sourceHash===b.sourceHash&&proof.observedAt===b.observedAt)||!/^[a-f0-9]{64}$/.test(b.sourceHash)||!b.sourceRef||!Number.isSafeInteger(b.maxSourceAgeMs)||b.maxSourceAgeMs<0||!Number.isFinite(Date.parse(b.observedAt))||Date.parse(b.observedAt)>nowMs||nowMs-Date.parse(b.observedAt)>b.maxSourceAgeMs||!Number.isFinite(Date.parse(b.expiresAt))||Date.parse(b.expiresAt)<=nowMs)throw new DraftApprovalError('reservationist payment target source unavailable or expired');
    }
    const complete = value.tasks?.some(task => task.id === receipt.binding?.taskId && task.status === 'complete');
    if (!receipt.sourceProofs?.length && !complete) continue;
    const fail = () => { throw new DraftApprovalError('reservationist read source authority unavailable or expired'); };
    const {binding, grant, result: capture, sourceProofs: proofs} = receipt;
    if (!binding || !grant || !capture || !Array.isArray(proofs) || !proofs.length || proofs.length > 64 || !/^[a-f0-9]{64}$/.test(binding.inputDigest) || !/^[a-f0-9]{64}$/.test(binding.requestDigest) || Object.entries(binding).some(([key,val]) => typeof val !== 'string' || !val || grant[key as keyof typeof grant] !== val) || !grant.authorizationId || grant.disclosure !== 'guest' || !Array.isArray(grant.allowedFields) || !grant.allowedFields.length || new Set(grant.allowedFields).size !== grant.allowedFields.length || grant.allowedFields.some(field => !['reservation_status','arrival','departure','folio_balance','deposit_due','deposit_recorded'].includes(field)) || !Number.isSafeInteger(grant.maxSourceAgeMs) || grant.maxSourceAgeMs < 0 || !Number.isFinite(Date.parse(grant.issuedAt)) || Date.parse(grant.issuedAt) > now.getTime() || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.getTime() || Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt) || capture.scopeRef !== binding.reservationRef || !['ok','partial'].includes(capture.status) || !Array.isArray(capture.evidence) || !capture.evidence.length || new Set(proofs.map(proof => proof.evidenceRef)).size !== proofs.length) fail();
    const fresh = (observedAt: string, expiresAt: string) => Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) <= now.getTime() && now.getTime() - Date.parse(observedAt) <= grant.maxSourceAgeMs && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now.getTime() && Date.parse(expiresAt) > Date.parse(observedAt);
    for (const proof of proofs) {
      const evidence = capture.evidence.find(evidence => evidence.evidenceRef === proof.evidenceRef);
      if (!evidence || !/^[a-f0-9]{64}$/.test(proof.sourceHash) || proof.authorizationId !== grant.authorizationId || proof.inputDigest !== binding.inputDigest || proof.requestDigest !== binding.requestDigest || proof.disclosure !== 'guest' || !fresh(proof.observedAt, proof.expiresAt) || evidence.sourceSystem !== 'hms' || !evidence.scopeVerified || !fresh(evidence.observedAt, evidence.expiresAt) || evidence.observedAt !== proof.observedAt || evidence.expiresAt !== proof.expiresAt || evidence.sourceHash !== undefined && evidence.sourceHash !== proof.sourceHash) fail();
    }
    if (capture.evidence.some(evidence => !proofs.some(proof => proof.evidenceRef === evidence.evidenceRef))) fail();
    if (complete && capture.evidence.some(evidence => !value.tasks!.find(task => task.id === binding.taskId)?.evidenceRefs?.includes(evidence.evidenceRef))) fail();
  }
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  for (const raw of [...(value.quoteRevisions ?? []), ...(value.importedOffers ?? []), ...(value.approvedOverrides ?? [])]) {
    type Offer = { authorizationId?: string; authoredDate?: string; validity?: { days?: number; anchor?: string; cutoff?: string; expiresAt?: string }; validUntil?: string; sourceFreshness?: ReservationistSourceFreshnessProof; groups?: {sourceRef?: string}[]; sourceRef?: string; ref?: string; sourceRevision?: Offer };
    const wrapper = raw as Offer;
    const offer = wrapper.sourceRevision ?? wrapper;
    if (wrapper.sourceRevision && wrapper.authorizationId !== offer.authorizationId)
      throw new DraftApprovalError('reservationist override source authorization mismatch');
    if (!wrapper.sourceRevision && acceptedRevisionDigests.has(quoteDigest(offer))) continue;
    let insideAuthoredWindow = false;
    if (offer.validity?.cutoff === 'unresolved') {
      // The sourced three-day term proves the interior, not the exact final-day cutoff.
      // Keep the Johannesburg calendar-day interpretation used by quote acceptance.
      const authored = Date.parse(`${offer.authoredDate ?? ''}T00:00:00Z`);
      const elapsed = (Date.parse(`${day}T00:00:00Z`) - authored) / 86400000;
      if (offer.validity.days !== 3 || offer.validity.anchor !== 'authored_date' || !/^\d{4}-\d{2}-\d{2}$/.test(offer.authoredDate ?? '') || !Number.isFinite(authored) || new Date(authored).toISOString().slice(0, 10) !== offer.authoredDate || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 3)
        throw new DraftApprovalError('reservationist offer expired or validity cutoff unresolved');
      insideAuthoredWindow = true;
    }
    if (offer.validity?.expiresAt !== undefined && (!Number.isFinite(Date.parse(offer.validity.expiresAt)) || Date.parse(offer.validity.expiresAt) <= now.getTime()))
      throw new DraftApprovalError('reservationist offer validity expired or unavailable');
    if (offer.validUntil) {
      const parsed = Date.parse(offer.validUntil + 'T00:00:00Z');
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== offer.validUntil || offer.validUntil <= day)
        throw new DraftApprovalError('reservationist offer expired or cutoff unresolved');
    } else if (!insideAuthoredWindow && (!offer.validity?.expiresAt || !Number.isFinite(Date.parse(offer.validity.expiresAt)) || Date.parse(offer.validity.expiresAt) <= now.getTime())) {
      throw new DraftApprovalError('reservationist offer validity authority unavailable');
    }
    const proof = offer.sourceFreshness;
    const refs = offer.groups?.map(group => group.sourceRef).filter((ref): ref is string => !!ref) ?? [offer.sourceRef ?? offer.ref].filter((ref): ref is string => !!ref);
    const observed = Date.parse(proof?.observedAt ?? '');
    const storedExpiry = Date.parse(proof?.expiresAt ?? '');
    const liveUntil =
      proof?.purpose === 'offer_source' && Number.isFinite(observed)
        ? observed + PRICED_QUOTE_REUSE_MS
        : storedExpiry;
    if (!offer.authorizationId || proof?.authorizationId !== offer.authorizationId || !proof.sourceRefs?.length || !refs.length || refs.some(ref => !proof.sourceRefs.includes(ref)) || proof.sourceRefs.some(ref => !refs.includes(ref)) || !['offer_source', 'current_inventory'].includes(proof.purpose) || !Number.isFinite(observed) || observed > now.getTime() || !Number.isFinite(storedExpiry) || liveUntil <= now.getTime() || storedExpiry <= observed)
      throw new DraftApprovalError('reservationist source freshness authority unavailable or expired');
  }
}

/** Trusted normal-worker capability/release identity bound into approval. */
export type DraftApprovalRouteBinding = import('./draft-route-factory.js').DraftModelRouteConfig['route'] & {
  release: DraftRouteReleaseDescriptor;
};

export type DraftApprovalPayload = {
  draftId?: string;
  generationId?: string | null;
  transportId?: string;
  threadId?: string | null;
  revisionId?: string | null;
  threadStateVersion?: string | null;
  evidence?: unknown[];
  resultDigest?: string;
  routeBinding?: DraftApprovalRouteBinding;
  policyVersion?: string;
  approvedByUserId?: string;
  approvedAt?: string;
  origin?: 'manual' | 'ai';
  subject: string;
  html: string;
  text: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: DraftApprovalAttachment[];
};

export type DraftApproval = {
  version: typeof DRAFT_APPROVAL_VERSION;
  purpose: typeof DRAFT_APPROVAL_PURPOSE;
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
  policyVersion: typeof DRAFT_APPROVAL_POLICY_VERSION;
  approvedByUserId: string;
  approvedAt: string;
  bodyDigest: string;
  recipientDigest: string;
  attachmentDigest: string;
  evidenceDigest: string;
  resultDigest?: string;
  routeBinding?: DraftApprovalRouteBinding;
  fingerprint: string;
  signature: string;
};

function isDraftRouteBinding(value: unknown): value is DraftApprovalRouteBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DraftApprovalRouteBinding>;
  const release=candidate.release;
  return (
    isDraftRouteEvidence(candidate) &&
    isDraftRouteReleaseDescriptor(release)
  );
}

/** Extract only the complete trusted route evidence persisted by the worker. */
export function resolveDraftApprovalRouteBinding(
  metrics: unknown,
): DraftApprovalRouteBinding | undefined {
  if (typeof metrics !== 'object' || metrics === null) return undefined;
  const candidate = (metrics as { routeBinding?: unknown }).routeBinding;
  return isDraftRouteBinding(candidate) ? candidate : undefined;
}

/** Resolve the server-only key used to authenticate approval snapshots. */
export function getDraftApprovalSigningSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new DraftApprovalError('approval signing secret unavailable');
  return secret;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Stable JSON for signed/fingerprinted approval inputs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortCanonical(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortCanonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function normalizedRecipients(input: DraftApprovalPayload): {
  to: string[];
  cc: string[];
  bcc: string[];
} {
  const normalize = (values: string[]) => values.map((value) => value.trim().toLowerCase());
  return {
    to: normalize(input.to),
    cc: normalize(input.cc),
    bcc: normalize(input.bcc),
  };
}

function normalizedAttachments(input: DraftApprovalPayload): Array<{
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentDigest: string;
}> {
  return input.attachments.map((attachment) => {
    const contentBase64 = attachment.contentBase64 ?? '';
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType ?? '',
      sizeBytes: attachment.sizeBytes ?? Buffer.from(contentBase64, 'base64').length,
      contentDigest: digest(contentBase64),
    };
  });
}

function requiredString(value: string | null | undefined, field: string): string {
  if (!value?.trim()) throw new DraftApprovalError(`approval field missing: ${field}`);
  return value;
}

function assertAiPayload(input: DraftApprovalPayload): void {
  if (input.origin !== 'ai') {
    throw new DraftApprovalError('only AI drafts may receive an approval token');
  }
  requiredString(input.draftId, 'draftId');
  requiredString(input.generationId, 'generationId');
  requiredString(input.transportId, 'transportId');
  requiredString(input.threadId, 'threadId');
  requiredString(input.revisionId, 'revisionId');
  requiredString(input.threadStateVersion, 'threadStateVersion');
  requiredString(input.approvedByUserId, 'approvedByUserId');
  requiredString(input.approvedAt, 'approvedAt');
  if (input.policyVersion !== DRAFT_APPROVAL_POLICY_VERSION) {
    throw new DraftApprovalError('approval policy version is not supported');
  }
}

function approvalFingerprint(input: {
  version: string;
  purpose: string;
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
  policyVersion: string;
  approvedByUserId: string;
  approvedAt: string;
  bodyDigest: string;
  recipientDigest: string;
  attachmentDigest: string;
  evidenceDigest: string;
  resultDigest?: string;
  routeBinding?: DraftApprovalRouteBinding;
}): string {
  return digest(input);
}

function approvalSignature(
  input: Parameters<typeof approvalFingerprint>[0] & { fingerprint: string },
  signingSecret: string,
): string {
  return createHmac('sha256', signingSecret).update(canonicalJson(input)).digest('hex');
}

/** Build a closed, opaque approval snapshot after the user reviewed the current editor. */
export function buildDraftApproval(
  input: DraftApprovalPayload,
  signingSecret: string,
): DraftApproval {
  if (input.resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.resultDigest))
    throw new DraftApprovalError('invalid result digest');
  requiredString(signingSecret, 'signingSecret');
  assertAiPayload(input);
  const recipients = normalizedRecipients(input);
  const attachments = normalizedAttachments(input);
  const bodyDigest = digest({
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  const recipientDigest = digest(recipients);
  const attachmentDigest = digest(attachments);
  const evidenceDigest = digest(input.evidence ?? []);
  const approval = {
    version: DRAFT_APPROVAL_VERSION,
    purpose: DRAFT_APPROVAL_PURPOSE,
    draftId: requiredString(input.draftId, 'draftId'),
    generationId: requiredString(input.generationId, 'generationId'),
    transportId: requiredString(input.transportId, 'transportId'),
    threadId: requiredString(input.threadId, 'threadId'),
    revisionId: requiredString(input.revisionId, 'revisionId'),
    threadStateVersion: requiredString(input.threadStateVersion, 'threadStateVersion'),
    policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
    approvedByUserId: requiredString(input.approvedByUserId, 'approvedByUserId'),
    approvedAt: requiredString(input.approvedAt, 'approvedAt'),
    bodyDigest,
    recipientDigest,
    attachmentDigest,
    evidenceDigest,
    ...(input.resultDigest ? { resultDigest: input.resultDigest } : {}),
    ...(input.routeBinding ? { routeBinding: input.routeBinding } : {}),
  } as const;
  const fingerprint = approvalFingerprint(approval);
  const signed = {
    ...approval,
    fingerprint,
  };
  return {
    ...signed,
    signature: approvalSignature(signed, signingSecret),
  };
}

const draftApprovalSchema = z
  .object({
    version: z.literal(DRAFT_APPROVAL_VERSION),
    purpose: z.literal(DRAFT_APPROVAL_PURPOSE),
    draftId: z.string().min(1),
    generationId: z.string().min(1),
    transportId: z.string().min(1),
    threadId: z.string().min(1),
    revisionId: z.string().min(1),
    threadStateVersion: z.string().min(1),
    policyVersion: z.literal(DRAFT_APPROVAL_POLICY_VERSION),
    approvedByUserId: z.string().min(1),
    approvedAt: z.string().datetime(),
    bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recipientDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attachmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resultDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    routeBinding: z
      .object({
        routeId: z.string().min(1),
        modelId: z.string().min(1),
        purpose: z.literal('draft'),
        protocol: z.enum(['in_process','azure-foundry-responses']),
        access: z.literal('current_app'),
        egress: z.enum(['none','azure-foundry']),
        retention: z.literal('bounded'),
        usage: z.literal('reported'),
        release: z
          .object({
            releaseId: z.string().min(1),
            releaseVersion: z.string().min(1),
            sourceRevision: z.string().min(1),
            fingerprint: z.string().min(1),
            purpose: z.literal('draft'),
            capabilityFamilyVersions: z.record(z.string().min(1)),
            issuedAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            withdrawn: z.boolean(),
          })
          .strict(),
      })
      .strict()
      .refine(value=>value.protocol==='in_process'?value.egress==='none':value.egress==='azure-foundry')
      .transform((value):DraftApprovalRouteBinding=>value.protocol==='in_process'?{...value,protocol:'in_process',egress:'none'}:{...value,protocol:'azure-foundry-responses',egress:'azure-foundry'})
      .optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function parseDraftApproval(raw: unknown, signingSecret: string): DraftApproval {
  requiredString(signingSecret, 'signingSecret');
  const parsed = draftApprovalSchema.safeParse(raw);
  if (!parsed.success) throw new DraftApprovalError('approval token shape is not supported');
  const expected = approvalFingerprint({
    version: parsed.data.version,
    purpose: parsed.data.purpose,
    draftId: parsed.data.draftId,
    generationId: parsed.data.generationId,
    transportId: parsed.data.transportId,
    threadId: parsed.data.threadId,
    revisionId: parsed.data.revisionId,
    threadStateVersion: parsed.data.threadStateVersion,
    policyVersion: parsed.data.policyVersion,
    approvedByUserId: parsed.data.approvedByUserId,
    approvedAt: parsed.data.approvedAt,
    bodyDigest: parsed.data.bodyDigest,
    recipientDigest: parsed.data.recipientDigest,
    attachmentDigest: parsed.data.attachmentDigest,
    evidenceDigest: parsed.data.evidenceDigest,
    ...(parsed.data.resultDigest ? { resultDigest: parsed.data.resultDigest } : {}),
    routeBinding: parsed.data.routeBinding,
  });
  if (expected !== parsed.data.fingerprint) {
    throw new DraftApprovalError('approval fingerprint mismatch');
  }
  const { signature, ...signed } = parsed.data;
  const expectedSignature = approvalSignature(signed, signingSecret);
  const providedSignature = Buffer.from(signature, 'hex');
  const calculatedSignature = Buffer.from(expectedSignature, 'hex');
  if (
    providedSignature.length !== calculatedSignature.length ||
    !timingSafeEqual(providedSignature, calculatedSignature)
  ) {
    throw new DraftApprovalError('approval signature mismatch');
  }
  return parsed.data;
}

/** Compare a submitted send payload to the exact body/recipient/attachment review. */
export function assertDraftApprovalMatchesPayload(
  rawApproval: unknown,
  input: DraftApprovalPayload,
  signingSecret: string,
): DraftApproval {
  const approval = parseDraftApproval(rawApproval, signingSecret);
  const boundFields: Array<keyof DraftApprovalPayload> = [
    'draftId',
    'generationId',
    'transportId',
    'threadId',
    'revisionId',
    'threadStateVersion',
    'policyVersion',
    'routeBinding',
    'resultDigest',
  ];
  for (const field of boundFields) {
    const submitted = input[field];
    const expected = approval[field as keyof DraftApproval];
    if (
      submitted !== undefined &&
      (field === 'routeBinding'
        ? canonicalJson(submitted) !== canonicalJson(expected)
        : submitted !== expected)
    ) {
      throw new DraftApprovalError(`approval field changed: ${field}`);
    }
  }
  const rebuilt = buildDraftApproval(
    {
      ...input,
      draftId: input.draftId ?? approval.draftId,
      generationId: input.generationId ?? approval.generationId,
      transportId: input.transportId ?? approval.transportId,
      threadId: input.threadId ?? approval.threadId,
      revisionId: input.revisionId ?? approval.revisionId,
      threadStateVersion: input.threadStateVersion ?? approval.threadStateVersion,
      policyVersion: input.policyVersion ?? approval.policyVersion,
      approvedByUserId: approval.approvedByUserId,
      approvedAt: approval.approvedAt,
      resultDigest: input.resultDigest ?? approval.resultDigest,
      routeBinding: input.routeBinding ?? approval.routeBinding,
      origin: 'ai',
    },
    signingSecret,
  );
  if (
    rebuilt.resultDigest !== approval.resultDigest ||
    rebuilt.bodyDigest !== approval.bodyDigest ||
    rebuilt.recipientDigest !== approval.recipientDigest ||
    rebuilt.attachmentDigest !== approval.attachmentDigest ||
    (input.evidence !== undefined &&
      (rebuilt.evidenceDigest !== approval.evidenceDigest ||
        rebuilt.fingerprint !== approval.fingerprint))
  ) {
    throw new DraftApprovalError('approval does not match current send payload');
  }
  return approval;
}

function checkEvidenceFreshness(evidence: unknown[], now: Date): boolean {
  // An approved-local mail-only draft makes no external factual claim and
  // therefore has no HMS evidence to expire.  The human approval still binds
  // the exact body, recipients, revision, generation, route, and thread
  // state; non-empty evidence remains strict HMS-only validation below.
  if (!Array.isArray(evidence) || evidence.length === 0) return true;
  for (const raw of evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== 'hms') return false;
    if (!isEvidenceFresh(parsed.data, now)) return false;
  }
  return true;
}

export type CurrentDraftApprovalPayload = DraftApprovalPayload & {
  draftId: string;
  generationId: string;
  transportId: string;
  threadId: string;
  revisionId: string;
  threadStateVersion: string;
};

/**
 * Re-read mutable draft/generation/revision state immediately before enqueue or
 * SMTP. This intentionally accepts a loader dependency to avoid coupling the
 * token module to a router (the queue and router both use this fence).
 */
export async function assertDraftApprovalCurrent(input: {
  db: DB;
  approval: unknown;
  payload: DraftApprovalPayload;
  loadThreadStateVersion: (
    db: DB,
    input: { transportId: string; threadId: string },
  ) => Promise<string>;
  queueMessageId?: string;
  /** Only set by the caller holding a short transaction. */
  lockQuoteOrigin?: boolean;
  now?: Date;
  signingSecret: string;
}): Promise<DraftApproval> {
  const approval = assertDraftApprovalMatchesPayload(
    input.approval,
    input.payload,
    input.signingSecret,
  );
  const now = input.now ?? new Date();
  const [draft] = await input.db
    .select()
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.id, approval.draftId),
        eq(mailDraft.transportId, approval.transportId),
        eq(mailDraft.origin, 'ai'),
        or(
          and(eq(mailDraft.isSent, false), eq(mailDraft.status, 'active')),
          and(eq(mailDraft.isSent, true), eq(mailDraft.status, 'sent')),
        ),
      ),
    )
    .limit(1);
  if (
    !draft ||
    draft.generationId !== approval.generationId ||
    draft.threadId !== approval.threadId
  ) {
    throw new DraftApprovalError('draft is no longer an active AI draft');
  }

  const [revision] = await input.db
    .select()
    .from(mailDraftRevision)
    .where(
      and(
        eq(mailDraftRevision.draftId, approval.draftId),
        eq(mailDraftRevision.id, approval.revisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new DraftApprovalError('approved draft revision no longer exists');

  const [latestRevision] = await input.db
    .select({
      id: mailDraftRevision.id,
      kind: mailDraftRevision.kind,
      sentMessageId: mailDraftRevision.sentMessageId,
    })
    .from(mailDraftRevision)
    .where(eq(mailDraftRevision.draftId, approval.draftId))
    .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
    .limit(1);
  if (
    latestRevision?.id !== approval.revisionId &&
    !(
      input.queueMessageId &&
      latestRevision?.kind === 'sent' &&
      latestRevision.sentMessageId === input.queueMessageId
    )
  ) {
    throw new DraftApprovalError('draft changed after approval');
  }

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, approval.generationId),
        eq(aiDraftGeneration.transportId, approval.transportId),
        eq(aiDraftGeneration.threadId, approval.threadId),
      ),
    )
    .limit(1);
  if (!generation || generation.status !== 'succeeded') {
    throw new DraftApprovalError('approved generation is unavailable');
  }
  if (digest(generation.evidence ?? []) !== approval.evidenceDigest) {
    throw new DraftApprovalError('draft evidence changed after approval');
  }
  if (!checkEvidenceFreshness(generation.evidence ?? [], now)) {
    throw new DraftApprovalError('draft evidence is no longer fresh');
  }

  const [run] = await input.db
    .select({ metrics: aiWorkflowRun.metrics, triggerMessageId: aiWorkflowRun.triggerMessageId })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.generationId, approval.generationId),
        eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.state, 'succeeded'),
      ),
    )
    .orderBy(desc(aiWorkflowRun.finishedAt), desc(aiWorkflowRun.createdAt))
    .limit(1);
  if (
    (run?.metrics as { modelRouteUnavailable?: unknown } | null)?.modelRouteUnavailable === true
  ) {
    throw new DraftApprovalError('approved draft route unavailable');
  }

  if (!approval.routeBinding?.release) {
    throw new DraftApprovalError('approved draft route release unavailable');
  }
  const occupancyHold = await draftQuoteOccupancyHold(input.db, { transportId: approval.transportId,
    threadId: approval.threadId, messageId: draft.replyToMessageId, triggerMessageId: run?.triggerMessageId ?? null,
    result: run?.metrics?.reservationistResult, lockOrigin: input.lockQuoteOrigin });
  if (occupancyHold) throw new DraftQuoteOccupancyError(occupancyHold);
  assertReservationistResultFreshForAction(run?.metrics?.reservationistResult, now);
  assertReservationistResultWording(run?.metrics?.reservationistResult, input.payload, now);
  const persistedDigest = (run?.metrics as { resultDigest?: unknown } | null)?.resultDigest;
  if (persistedDigest !== approval.resultDigest)
    throw new DraftApprovalError('reservationist result changed');
  const persistedRoute = resolveDraftApprovalRouteBinding(run?.metrics);
  if (!persistedRoute || canonicalJson(persistedRoute) !== canonicalJson(approval.routeBinding)) {
    throw new DraftApprovalError('approved draft route release changed');
  }
  const currentAuthority = resolveCurrentDraftRouteAuthority();
  const currentRoute = currentAuthority
    ? { ...currentAuthority.route, release: currentAuthority.release }
    : undefined;
  if (!currentRoute || canonicalJson(currentRoute) !== canonicalJson(approval.routeBinding)) {
    throw new DraftApprovalError('approved draft route release changed');
  }

  const liveThreadStateVersion = await input.loadThreadStateVersion(input.db, {
    transportId: approval.transportId,
    threadId: approval.threadId,
  });
  if (liveThreadStateVersion !== approval.threadStateVersion) {
    throw new DraftApprovalError('thread changed after approval');
  }
  return approval;
}

/**
 * Linearize an approved AI send inside the caller's short DB transaction.
 * The draft row is the mutable-state claim: edits that already committed are
 * observed by the locked validation, while edits that race afterward wait for
 * the row lock and cannot update a sent draft. No model or SMTP I/O belongs in
 * this transaction.
 */
export async function claimDraftApprovalForSend(
  input: Parameters<typeof assertDraftApprovalCurrent>[0] & { queueMessageId: string },
): Promise<DraftApproval> {
  if (!input.queueMessageId.trim()) {
    throw new DraftApprovalError('send claim is missing its queue message id');
  }
  const parsedApproval = parseDraftApproval(input.approval, input.signingSecret);
  const [lockedDraft] = await input.db
    .select({
      id: mailDraft.id,
    })
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.id, parsedApproval.draftId),
        eq(mailDraft.transportId, parsedApproval.transportId),
        eq(mailDraft.origin, 'ai'),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'active'),
      ),
    )
    .limit(1)
    .for('update');
  if (!lockedDraft) throw new DraftApprovalError('draft changed before send claim');

  const approval = await assertDraftApprovalCurrent({ ...input, lockQuoteOrigin: true });
  const [claimed] = await input.db
    .update(mailDraft)
    .set({
      isSent: true,
      status: 'sent',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailDraft.id, lockedDraft.id),
        eq(mailDraft.transportId, approval.transportId),
        eq(mailDraft.origin, 'ai'),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'active'),
      ),
    )
    .returning({ id: mailDraft.id });
  if (!claimed) throw new DraftApprovalError('draft changed during send claim');
  return approval;
}
