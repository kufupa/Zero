import {createHash} from 'node:crypto';
import {quoteDigest,type Board,type InclusionPolicy,type QuoteSourceRecord} from '../quote-proposal/quote-revision.js';
import type {AuthorizedTaskAnswer,ReservationistExecutionServices} from './reservationist-execution.js';
import type {PreparedFact} from './prepared-draft-input.js';
import {deriveStaffAnswerTopics,ReservationistTaskEvidenceUnavailable} from './reservationist-execution.js';

type Context=Parameters<NonNullable<ReservationistExecutionServices['resolveQuoteTask']>>[0];
type Selection={sourceRef:string;groupId:string;optionId:string};
type RatePolicyDocumentIdentity={
 ref:string;propertyCode:string;ownerRef:string;messageId:string;threadId:string;messageAt:string;direction:'outbound';
 attachmentId:string;sourceHash:string;body:Uint8Array;pages:string[];
};
export type ReservationistRatePolicyDocument=RatePolicyDocumentIdentity&({kind?:'family_invoice';authoredDate:string;rateCode:string;board:Board;publicationAt?:never}|{kind:'hotel_rate_terms';publicationAt:string;authoredDate?:never;rateCode?:never;board?:never});
const sha=(body:Uint8Array)=>createHash('sha256').update(body).digest('hex');
const boards:Record<string,Board>={'Room Only R':'room_only','Bed & Breakfast R':'breakfast','Dinner Bed & Breakfast R':'dinner_bed_breakfast','Dinner, Bed & Breakfast R':'dinner_bed_breakfast','Dinner, Bed, Breakfast & Beverage R':'dinner_bed_breakfast'};

function validateOriginalDocument(ctx:Context,d:ReservationistRatePolicyDocument,propertyCode:string){
 const terms=d.kind==='hotel_rate_terms';
 if(d.kind!==undefined&&!['family_invoice','hotel_rate_terms'].includes(d.kind))throw new Error('rate_policy_document_identity_invalid');
 if(!d.ref||d.propertyCode!==propertyCode||d.ownerRef!==ctx.input.authorizationScope!.ownerRef||!d.messageId||!d.threadId||!d.attachmentId||d.direction!=='outbound'||!Number.isFinite(Date.parse(d.messageAt))||Date.parse(d.messageAt)>Date.parse(ctx.input.clock.causalAt)||!/^[a-f0-9]{64}$/.test(d.sourceHash)||!d.body||d.body.length<1||d.body.length>20*1024*1024||sha(d.body)!==d.sourceHash||!Array.isArray(d.pages)||!d.pages.length||d.pages.length>50||d.pages.some((p:unknown)=>typeof p!=='string')||d.pages.join('').length>256*1024||(!terms&&(!/^\d{4}-\d{2}-\d{2}$/.test(d.authoredDate!)||!Number.isFinite(Date.parse(d.authoredDate+'T00:00:00Z'))||new Date(d.authoredDate+'T00:00:00Z').toISOString().slice(0,10)!==d.authoredDate||Date.parse(d.authoredDate+'T00:00:00Z')>Date.parse(d.messageAt)))||(terms&&(d.authoredDate!==undefined||d.rateCode!==undefined||d.board!==undefined||d.publicationAt!==d.messageAt||!Number.isFinite(Date.parse(d.publicationAt)))))throw new Error('rate_policy_document_identity_invalid');
}

/** Reads literal general hotel terms, without qualifying a selected rate, room count or guarantee. */
export function createReservationistQuoteTermsAnswerResolver(options:{
 authorizeContext:(ctx:Context)=>Promise<boolean>;
 readDocuments:(ctx:Context)=>Promise<readonly ReservationistRatePolicyDocument[]>;
}):{resolveTaskAnswer:(ctx:Context)=>Promise<AuthorizedTaskAnswer>;authorizeAnswerSource:(fact:PreparedFact,signal:AbortSignal)=>Promise<boolean>}{
 if(typeof options.authorizeContext!=='function'||typeof options.readDocuments!=='function')throw new Error('rate_policy_source_configuration_invalid');
 const authorize=options.authorizeContext,read=options.readDocuments,issued=new Map<string,()=>Promise<void>>();
 const vat=/\b1\. All rates are quoted in ZAR and include Value Added Tax \(VAT\) at the prevailing rate\./;
 const levy=/\b2\. Average Rate per night includes the 1% Tourism Levy per room per night\./;
 const cancellation=/^8\. A No-show fee equal to one night’s stay will be charged for guaranteed reservations who do not adhere to the following cancellation policy: \(a\)\. Cancellation - Seven or less rooms - within 48 hours prior to arrival will be subject to a full cancellation fee of the value of one night’s accommodation booked\. \(b\)\. Cancellation - Eight rooms or more – Legacy Hotels & Resort group cancellation policy will apply\.$/;
 return{
  resolveTaskAnswer:async ctx=>{
   const identity=()=>{const{sourceAt,...clock}=ctx.input.clock;return quoteDigest({input:{...ctx.input,clock},task:ctx.task,facts:ctx.facts});},original=identity();
   const guard=async()=>{ctx.signal.throwIfAborted();if(options.authorizeContext!==authorize||options.readDocuments!==read||ctx.input.clock.sourceMode!=='current_read'||!Number.isFinite(Date.parse(ctx.input.clock.causalAt))||ctx.input.capabilities.pmsWrite!==false||ctx.input.capabilities.emailSend!==false||!ctx.input.authorizationScope?.ownerRef||!ctx.input.authorizationScope.threadId||identity()!==original||!await authorize(ctx))throw new Error('quote_terms_source_unauthorized');ctx.signal.throwIfAborted();if(identity()!==original||options.authorizeContext!==authorize||options.readDocuments!==read)throw new Error('quote_terms_source_unauthorized');};
   await guard();
   const ask=ctx.task.source.quote??'',tax=/\b(?:tax(?:es)?|VAT|lev(?:y|ies))\b/i.test(ask),cancel=/\bcancellation\b/i.test(ask);
   if(ctx.task.kind!=='question')throw new Error('quote_terms_task_topic_invalid');
   if(tax===cancel||/\b(?:parking|transfer|shuttle|check[ -]?in|check[ -]?out|breakfast|payment|account|certificate|invoice|document|receipt)\b/i.test(ask)||cancel&&!/\b(?:policy|terms|conditions|fees?|rules)\b/i.test(ask))throw new ReservationistTaskEvidenceUnavailable('answer_evidence_unavailable',['the requested answer source'],deriveStaffAnswerTopics(ask));
   const documents=await read(ctx);await guard();
   if(!Array.isArray(documents)||documents.length>64)throw new Error('rate_policy_document_inventory_invalid');
   const documentsIdentity=quoteDigest(documents),terms=documents.filter(d=>d.kind==='hotel_rate_terms');
   if(terms.length!==1)throw new Error('quote_terms_evidence_unavailable');
   const d:ReservationistRatePolicyDocument=terms[0]!;validateOriginalDocument(ctx,d,ctx.input.propertyCode);
   const text=d.pages.join('\n'),flat=text.replace(/\s+/g,' ').trim(),v=flat.match(vat)?.[0],l=flat.match(levy)?.[0];
   const taxConflict=/\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)[^.\n]{0,100}\bexclud(?:e|ed|es|ing)\b|\bexclud(?:e|ed|es|ing)\b[^.\n]{0,100}\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)\b/i.test(text);
   if(!/We have pleasure in confirming your reservation at The Centurion Hotel, Centurion/.test(flat)||!v||!l||taxConflict)throw new Error('quote_terms_evidence_unavailable');
   let value=v+' '+l;
   if(cancel){
    const starts=d.pages.flatMap(page=>page.split('\n').filter(line=>/\b8\. A No-show/.test(line)));
    if(starts.length!==1||(flat.match(/\bcancellation\b/gi)?.length??0)!==5||(flat.match(/\bNo-show\b/gi)?.length??0)!==1||/\b(?:free cancellation|no cancellation fee|cancellation (?:is|will be) free)\b/i.test(flat))throw new Error('quote_terms_evidence_unavailable');
    const page=d.pages.find(p=>p.includes(starts[0]!))!,lines=page.split('\n'),start=lines.indexOf(starts[0]!),column=starts[0]!.indexOf('8. A No-show');
    const paragraph=lines.slice(start).map(line=>column>0?line.slice(column):line).join(' ').replace(/\s+/g,' ').trim().split(/\b9\. /)[0]!.trim();
    if(!cancellation.test(paragraph))throw new Error('quote_terms_evidence_unavailable');
    value=paragraph;
   }
   if(value.length>512||/[<>]/.test(value))throw new Error('quote_terms_evidence_unavailable');
   await guard();if(quoteDigest(documents)!==documentsIdentity)throw new Error('rate_policy_document_inventory_changed');
   const fact:PreparedFact={key:`quote_terms_${tax?'tax':'cancellation'}_${ctx.task.id}`,label:'Original hotel rate terms',value,source:'mail',authority:'authorized',status:'known',evidenceRef:d.ref,sourceHash:d.sourceHash,scopeHash:quoteDigest({context:original,document:documentsIdentity}),observedAt:d.publicationAt,scopeVerified:true,disclosure:'guest'};
   if(issued.size>=64)throw new Error('quote_terms_inventory_limit');
   issued.set(quoteDigest(fact),async()=>{await guard();validateOriginalDocument(ctx,d,ctx.input.propertyCode);if(quoteDigest(documents)!==documentsIdentity)throw new Error('rate_policy_document_inventory_changed');});
   return{kind:'policy',value,preparedFacts:[fact],evidenceRefs:[d.ref],disclosure:'guest'};
  },
  authorizeAnswerSource:async(fact,signal)=>{signal.throwIfAborted();const guard=issued.get(quoteDigest(fact));if(!guard)return false;try{await guard();signal.throwIfAborted();return true;}catch{signal.throwIfAborted();return false;}},
 };
}

/** Source-owned invoices qualify their printed family; explicit original hotel terms qualify taxes only.
 * Current prices, package labels and restrictions remain in the new native observation.
 * Original amounts and payments never become current-price or cleared-money evidence.
 */
export function createReservationistSelectedRatePolicyResolver(options:{
 authorizeContext:(ctx:Context)=>Promise<boolean>;
 readDocuments:(ctx:Context,family:{propertyCode:string;rateCode:string;board:Board})=>Promise<readonly ReservationistRatePolicyDocument[]>;
}){
 if(typeof options.authorizeContext!=='function'||typeof options.readDocuments!=='function')throw new Error('rate_policy_source_configuration_invalid');
 const authorize=options.authorizeContext,read=options.readDocuments;
 return async(ctx:Context,source:QuoteSourceRecord,selections:readonly Selection[],propertyCode:string,rateCode:string,board:Board):Promise<InclusionPolicy|null>=>{
  const identity=()=>{const{sourceAt,...clock}=ctx.input.clock;return quoteDigest({input:{...ctx.input,clock},task:ctx.task,facts:ctx.facts,source,selections});},original=identity();
  const guard=async()=>{ctx.signal.throwIfAborted();if(options.authorizeContext!==authorize||options.readDocuments!==read||ctx.input.clock.sourceMode!=='current_read'||ctx.input.capabilities.pmsWrite!==false||ctx.input.capabilities.emailSend!==false||!ctx.input.authorizationScope?.ownerRef||!ctx.input.authorizationScope.threadId||identity()!==original||!await authorize(ctx))throw new Error('rate_policy_source_unauthorized');ctx.signal.throwIfAborted();};
  await guard();
  if(propertyCode!==ctx.input.propertyCode||source.request.propertyCode!==propertyCode||source.result.propertyCode!==propertyCode||source.result.outcome!=='quote'||!source.ref||!/^[a-f0-9]{64}$/.test(source.sha256)||!rateCode||!['room_only','breakfast','dinner_bed_breakfast'].includes(board))throw new Error('rate_policy_selected_scope_invalid');
  const selected=selections.map(s=>{const group=source.result.groups.find(g=>g.id===s.groupId),option=group?.options.find(o=>o.id===s.optionId);if(s.sourceRef!==source.ref||!group||!option||group.completeness.search!=='complete'||group.completeness.requiredFacts!=='complete'||option.eligibility!=='verified'||option.availability!=='available'||option.matchStatus!=='match'||option.held!==false)throw new Error('rate_policy_selected_scope_invalid');return{group,option};});
  const matched=selected.filter(({option})=>option.rate.code===rateCode&&boards[option.board??'']===board);
  if(!matched.length)throw new Error('rate_policy_selected_family_invalid');
  if(matched.some(({option})=>!option.nightly.length||option.nightly.some(n=>{const row=n as typeof n&{restricted?:boolean;rateAvailable?:boolean};return row.restricted!==false||row.rateAvailable!==true;})))return null;
  const documents=await read(ctx,{propertyCode,rateCode,board}),documentsIdentity=quoteDigest(documents);await guard();
  if(!Array.isArray(documents)||documents.length>64)throw new Error('rate_policy_document_inventory_invalid');
  const usable=documents.filter(d=>{
   const terms=d.kind==='hotel_rate_terms';if(!terms&&(d.rateCode!==rateCode||d.board!==board))return false;
   validateOriginalDocument(ctx,d,propertyCode);
   const text=d.pages.join('\n'),flat=text.replace(/\s+/g,' ');
   if(terms){
    if(!['room_only','breakfast'].includes(board)||matched.some(({option})=>option.nightly.some(n=>n.price?.currency!=='ZAR')))return false;
    const vat=/\b1\. All rates are quoted in ZAR and include Value Added Tax \(VAT\) at the prevailing rate\./.test(flat),levy=/\b2\. Average Rate per night includes the 1% Tourism Levy per room per night\./.test(flat);
    const conflict=/\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)[^.\n]{0,100}\bexclud(?:e|ed|es|ing)\b|\bexclud(?:e|ed|es|ing)\b[^.\n]{0,100}\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)\b/i.test(text);
    return /The Centurion Hotel/.test(text)&&/We have pleasure in confirming your reservation at The Centurion Hotel, Centurion/.test(flat)&&vat&&levy&&!conflict;
   }
   const printedCodes=[...text.matchAll(/\bRate Plan\s+([A-Z][A-Z0-9]*)\b/g)].map(m=>m[1]);
   if(!/The Centurion Hotel/.test(text)||!/^\s*Tax Invoice\b/m.test(text)||!printedCodes.length||printedCodes.some(c=>c!==rateCode)||!/^\s*Tourism Levy Included\s+\d[\d,.]*\s*$/m.test(text)||!/^\s*VAT 15%\s+15\.00%\s+\d[\d,.]*\s+\d[\d,.]*\s+\d[\d,.]*\s*$/m.test(text))return false;
   const printedDate=text.match(/Invoice Date\s+(\d{2})-([A-Z]{3})-(\d{4})\b/),months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
   if(!printedDate||`${printedDate[3]}-${String(months.indexOf(printedDate[2]!)+1).padStart(2,'0')}-${printedDate[1]}`!==d.authoredDate)return false;
   return board==='dinner_bed_breakfast'?/Package Dinner \+ Bed n(?: Breakfast|[^\n]*\n\s*Breakfast)/.test(text):board==='breakfast'?/Package B&B|Package Bed (?:&|and) Breakfast|Breakfast Adult Inclusive/.test(flat)||/Package Bed n(?:[ \t]+Breakfast Rewardable\b|[ \t\d,.%]*\n[ \t]+Breakfast (?:Rewardable|Non-[ \t]*\n[ \t]+Rewardable)[; \t]*$)/m.test(text):false;
  });
  await guard();if(quoteDigest(documents)!==documentsIdentity)throw new Error('rate_policy_document_inventory_changed');
  if(!usable.length)return null;
  // General terms establish taxes only; native board and eligibility remain mandatory.
  // Neither source route establishes child meal entitlement.
  const familyInvoices=usable.filter(d=>d.kind!=='hotel_rate_terms'),qualified=familyInvoices.length?familyInvoices:usable;
  const bundleLabels=familyInvoices.length?[...new Set(matched.flatMap(({option})=>option.rate.bundleLabels?.map(b=>b.label)??[]))]:[];
  const payload={propertyCode,rateCode,board,documents:qualified.map(d=>({ref:d.ref,sourceHash:d.sourceHash,...(d.kind==='hotel_rate_terms'?{publicationAt:d.publicationAt}:{authoredDate:d.authoredDate}),ownerRef:d.ownerRef,messageId:d.messageId,threadId:d.threadId,messageAt:d.messageAt,attachmentId:d.attachmentId})),nativeSource:{ref:source.ref,sha256:source.sha256,observedAt:source.observedAt},selections:matched.map(({group,option})=>({groupId:group.id,optionId:option.id}))};
  return{ref:'source-rate-policy:'+quoteDigest(payload),propertyCode,sourceHashes:[...new Set(qualified.map(d=>d.sourceHash))],authoredDates:[...new Set(qualified.flatMap(d=>d.kind==='hotel_rate_terms'?[]:[d.authoredDate]))],...(qualified.some(d=>d.kind==='hotel_rate_terms')?{sourcePublications:qualified.filter(d=>d.kind==='hotel_rate_terms').map(d=>({sourceHash:d.sourceHash,publishedAt:d.publicationAt!}))}:{}),families:[{rateCode,board}],vat:'included',levy:'included',...(bundleLabels.length?{bundleLabels}:{}),restrictions:{status:'supported',sourceRefs:[source.ref]}};
 };
}
