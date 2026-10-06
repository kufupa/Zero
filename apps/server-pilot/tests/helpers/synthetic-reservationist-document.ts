import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import {prepareReservationistExistingDocument} from '../../src/ai/reservationist-existing-document.js';
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
export function syntheticReservationistDocumentFixture(purpose='tax_certificate'){
 const text=purpose==='receipt'?'Please resend the receipt for reservation ABC123.':'Please resend the tax certificate.';
 const body=Buffer.from(`%PDF-1.4 synthetic ${purpose}`),sha256=hash(body),page=purpose==='receipt'?'Receipt ABC123':'Tax certificate';
 const input:any={taskId:'doc',requestId:'request',ownerRef:'owner',threadId:'thread',triggerMessageId:'message',propertyCode:'HRCEN',reservationRef:purpose==='receipt'?'ABC123':null,taskSource:{sourceRef:'message:message',sourceHash:hash(text),page:1,quote:text,start:0,end:text.length},originalRequest:{text,at:'2026-10-04T08:00:00Z',sourceRef:'message:message',sourceHash:hash(text),pageHash:hash(text),page:1,disclosure:'guest'},clock:{causalAt:'2026-10-04T08:00:00Z',sourceAt:'2026-10-04T09:00:00Z',sourceMode:'current_read',deadlineAt:Date.now()+60000}};
 const document:any={artifactRef:`original:${sha256}`,filename:'Original.pdf',body,read:{status:'ok',blocker:null,issues:[],data:{document:{documentRef:'docref',source:purpose==='receipt'?'hms_sent_attachment':'approved_property_document',kind:purpose==='receipt'?'other_existing':'supplier_compliance',version:'v1',issuedAt:'2026-10-03T08:00:00Z',status:'sent',parentRef:purpose==='receipt'?'ABC123':null,payerRef:null,displayName:'Original.pdf',mime:'application/pdf',sizeBytes:body.length,sha256,retrievable:true,retrievalBlocker:null,priceVisibility:'hidden',propertyRef:'HRCEN',guestRef:null,stayStart:null,stayEnd:null,currentVersion:true},artifactRef:null,text:page,extractionState:'complete',pageCount:1,validation:{identity:'match',stayDates:'unknown',payer:'unknown',kind:'match',version:'current',priceVisibility:'allowed'},format:'text',sourceHash:sha256,artifactExpiresAt:null}},sourceProof:{sourceRef:'source-document',sourceHash:sha256,documentRef:'docref',documentVersion:'v1',purpose,ownerRef:'owner',threadId:purpose==='receipt'?'thread':null,propertyCode:'HRCEN',reservationRef:purpose==='receipt'?'ABC123':null,authorizationId:'grant',issuedAt:'2026-10-03T08:00:00Z',observedAt:'2026-10-04T08:30:00Z',expiresAt:'2026-10-04T10:00:00Z',maxSourceAgeMs:3600000,page:1,pageText:page,pageHash:hash(page)}};
 const authorize=vi.fn(async(binding:any)=>({...binding,authorizationId:'grant',disclosure:'guest',issuedAt:'2026-10-04T08:30:00Z',expiresAt:'2026-10-04T10:00:00Z',maxSourceAgeMs:3600000}));
 return {input,document,authorize,run:()=>prepareReservationistExistingDocument(input,{resolve:async()=>document,authorize,signal:new AbortController().signal})};
}
/** Explicit local prior-quote target; no source selection or successful result is stubbed. */
export function syntheticReservationistPriorQuoteFixture(text='Please resend quotation Q-123.',priorQuoteRef='Q-123'){
 const f=syntheticReservationistDocumentFixture('receipt'),page=`Quotation ${priorQuoteRef}`;
 f.input.reservationRef=null;f.input.priorQuoteRef=priorQuoteRef;
 f.input.taskSource={...f.input.taskSource,quote:text,start:0,end:text.length,sourceHash:hash(text)};
 f.input.originalRequest={...f.input.originalRequest,text,sourceHash:hash(text),pageHash:hash(text)};
 f.document.read.data.document={...f.document.read.data.document,kind:'pro_forma',parentRef:priorQuoteRef,documentRef:'opaque-original-document'};
 f.document.read.data.text=page;
 f.document.sourceProof={...f.document.sourceProof,purpose:'existing_quote',reservationRef:null,priorQuoteRef,documentRef:'opaque-original-document',pageText:page,pageHash:hash(page)};
 return f;
}
