import {createHash} from 'node:crypto';
import {occupiedDates,quoteDigest,resolveImportedOffer,type ImportedOfferSource,type QuoteRevision} from '../quote-proposal/quote-revision.js';
import {assertSourceOfferFactAttestation} from './reservationist-source-facts.js';
import {ReservationistTaskEvidenceUnavailable,type ReservationistExecutionServices,type SourceOfferAttestation} from './reservationist-execution.js';
import type {AttachmentAdmission} from './reservationist-attachment-input.js';
import type {BookingEvidence,BookingSourceProof} from './reservationist-booking-packet.js';
type Context=Parameters<NonNullable<ReservationistExecutionServices['resolveBookingTask']>>[0];
type SentProof=NonNullable<BookingEvidence['acceptance']>['sentProof'];
/** Source owner supplies the retained original revision; document totals never create room nights. */
export type ReservationistAcceptedQuoteSource={
 document:AttachmentAdmission|null;
 originalOffer:ImportedOfferSource|null;
 revision:QuoteRevision|null;
 sentProof:SentProof;
 attestation:SourceOfferAttestation&{originalRevisionDigest:string;acceptanceSourceDigest:string};
 authorizeSource:(proof:BookingSourceProof,signal:AbortSignal)=>Promise<boolean>;
};
const missing=(code:string,topic:string):never=>{throw new ReservationistTaskEvidenceUnavailable(code,[topic]);};
export async function resolveReservationistAcceptedQuoteSource(ctx:Context,source:ReservationistAcceptedQuoteSource,authorizeContext:()=>Promise<void>){
 const contextDigest=()=>{const{sourceAt: _sourceAt,...clock}=ctx.input.clock;return quoteDigest({input:{...ctx.input,clock},task:ctx.task,facts:ctx.facts});},originalContext=contextDigest(),originalSource=quoteDigest(source),authorize=source.authorizeSource;
 const bound=async()=>{ctx.signal.throwIfAborted();await authorizeContext();if(contextDigest()!==originalContext||quoteDigest(source)!==originalSource||source.authorizeSource!==authorize)throw new Error('accepted_quote_source_changed');};
 await bound();
 const {document,originalOffer,revision,sentProof,attestation}=source;
 if(!document||!originalOffer||!revision||!sentProof)missing('booking_acceptance_source_unavailable','the original sent quotation and its unchanged room allocation');
 const d=document!,s=originalOffer!,r=revision!,sent=sentProof!,a=attestation,scope=ctx.input.authorizationScope,m=ctx.input.messages.find(m=>m.id===ctx.input.trigger.id),task=ctx.task.source;
 if(ctx.task.kind!=='acceptance'||!scope||!m||m.direction!=='inbound'||m.disclosure==='staff_only'||m.at!==ctx.input.trigger.at||m.at!==ctx.input.clock.causalAt||task.attachmentId!==`message:${m.id}`||task.sourceHash!==createHash('sha256').update(m.text).digest('hex')||task.page!==1||!Number.isSafeInteger(task.start)||!Number.isSafeInteger(task.end)||task.start!<0||task.end!<=task.start!||m.text.slice(task.start,task.end)!==task.quote)throw new Error('accepted_quote_request_unbound');
 const quoted=m.text.search(/^(?:From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/im);
 if(quoted>=0&&task.end!>quoted)throw new Error('accepted_quote_request_quoted');
 const originalMessage=ctx.input.messages.find(message=>message.id===d.metadata.messageId),inventory=ctx.input.authorizedArtifacts as Array<{attachmentId?:string;sourceHash?:string}>;
 if(!originalMessage||originalMessage.direction!=='outbound'||originalMessage.at!==d.metadata.messageAt||!Number.isFinite(Date.parse(originalMessage.at))||Date.parse(originalMessage.at)>Date.parse(m.at)||!inventory.some(artifact=>artifact.attachmentId===d.metadata.attachmentId&&artifact.sourceHash===d.metadata.sourceHash))throw new Error('accepted_quote_original_source_unbound');
 // Original offer pricing stays in the staff packet; its causal source may be private.
 if(!['guest','staff_only'].includes(d.metadata.disclosure)||d.metadata.disclosure!==(originalMessage.disclosure??'guest')||d.source?.disclosure!==d.metadata.disclosure||d.bytes?.contentType.split(';')[0]?.trim().toLowerCase()!=='application/pdf')throw new Error('accepted_quote_original_document_unbound');
 if(d.status!=='admitted'||d.reason!=='text'||!d.bytes||!d.source?.pages?.length||d.metadata.mimeType!=='application/pdf'||d.metadata.ownerRef!==scope.ownerRef||d.metadata.threadId!==scope.threadId||d.metadata.attachmentId!==s.ref||d.source.attachmentId!==s.ref||d.metadata.sourceHash!==s.sourceHash||d.source.sourceHash!==s.sourceHash||d.bytes.sha256!==s.sourceHash||createHash('sha256').update(d.bytes.body).digest('hex')!==s.sourceHash||d.bytes.body.length!==d.metadata.sizeBytes||d.bytes.locator.messageId!==d.metadata.messageId||d.bytes.locator.mimeType!=='application/pdf'||d.bytes.locator.sizeBytes!==d.metadata.sizeBytes||!d.bytes.locator.s3Key.startsWith(`attachments/${d.metadata.messageId}/`))throw new Error('accepted_quote_original_document_unbound');
 if(!s.authorizationId||s.authorizationId!==r.authorizationId||s.propertyCode!==ctx.input.propertyCode||r.propertyCode!==ctx.input.propertyCode||s.scopeDigest!==r.scopeDigest||s.currency!==r.currency||s.printedDate!==r.authoredDate||s.sentAt!==d.metadata.messageAt||sent.sentAt!==s.sentAt||sent.sourceRef!==s.ref||sent.sourceHash!==s.sourceHash||sent.revisionId!==r.id||sent.authorizationId!==r.authorizationId||Date.parse(s.sentAt)>Date.parse(m.at))throw new Error('accepted_quote_sent_source_unbound');
 const {id,...data}=r;
 if(id!==`quote:${quoteDigest(data)}`||r.held!==false||!r.groups.length||r.groups.length>24||new Set(r.groups.map(g=>g.id)).size!==r.groups.length)throw new Error('accepted_quote_revision_unbound');
 const pageText=d.source.pages.join('\n');
 if(!pageText.includes(s.terms)||s.lines.some(line=>!d.source!.pages![line.page-1]?.includes(line.quote)))throw new Error('accepted_quote_original_lines_unbound');
 if(a.sourceDigest!==quoteDigest(s)||a.originalRevisionDigest!==quoteDigest(r)||a.acceptanceSourceDigest!==quoteDigest(task)||a.requestId!==ctx.input.requestId||a.ownerRef!==scope.ownerRef||a.threadId!==scope.threadId||a.scopeDigest!==r.scopeDigest||!Number.isFinite(Date.parse(a.evaluatedAt))||Date.parse(a.evaluatedAt)>Date.parse(ctx.input.clock.sourceAt))throw new Error('accepted_quote_owner_attestation_unbound');
 assertSourceOfferFactAttestation(ctx.facts,a.factAttestation);
 const sentSource:BookingSourceProof={sourceRef:sent.sourceRef,sourceHash:sent.sourceHash,authorizationId:sent.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:sent.sentAt};
 const authorizeBound=async(proof:BookingSourceProof,signal:AbortSignal)=>{signal.throwIfAborted();const digest=quoteDigest(proof);await bound();const ok=await authorize(proof,signal);await bound();if(quoteDigest(proof)!==digest)throw new Error('accepted_quote_proof_changed');return ok;};
 const offer=await resolveImportedOffer({ref:s.ref,authorizationId:r.authorizationId,evaluationAt:m.at,resolveSource:async()=>s,authorizeSource:async()=>authorizeBound(sentSource,ctx.signal)});await bound();
 if(offer.totalMinor!==r.totalMinor||r.groups.reduce((sum,g)=>sum+g.totalMinor,0)!==r.totalMinor)throw new Error('accepted_quote_original_total_conflict');
 for(const g of r.groups){
  const dates=occupiedDates(g.arrivalDate,g.departureDate);
  if(g.currency!==r.currency||!Number.isSafeInteger(g.quantity)||g.quantity<1||g.nightly.length!==dates.length||g.nightly.some((n,i)=>n.date!==dates[i]||!Number.isSafeInteger(n.amountMinor)||n.amountMinor<0)||g.perRoomMinor!==g.nightly.reduce((sum,n)=>sum+n.amountMinor,0)||g.totalMinor!==g.perRoomMinor*g.quantity||!g.sourceRef||!/^[a-f0-9]{64}$/.test(g.sourceHash)||!Number.isFinite(Date.parse(g.observedAt))||Date.parse(g.observedAt)>Date.parse(s.sentAt))throw new Error('accepted_quote_original_room_nights_unbound');
  if(!await authorizeBound({sourceRef:g.sourceRef,sourceHash:g.sourceHash,authorizationId:r.authorizationId,propertyCode:r.propertyCode,scopeDigest:r.scopeDigest,observedAt:g.observedAt},ctx.signal))throw new Error('accepted_quote_original_group_unauthorized');
 }
 if(s.validUntil<m.at.slice(0,10))missing('booking_acceptance_expired','a current authorization for the expired original quotation');
 // Preserve the existing authored-date three-day ambiguity guard, before native reads.
 const elapsed=(Date.parse(new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(m.at))+'T00:00:00Z')-Date.parse(r.authoredDate+'T00:00:00Z'))/86400000;
 if(elapsed<0||elapsed>=3)missing('booking_acceptance_validity_unavailable','the original quotation validity at the time it was accepted');
 return{revision:r,importedOffer:offer,acceptedAt:m.at,sentProof:sent,authorizeSource:authorizeBound};
}
