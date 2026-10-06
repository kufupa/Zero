import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {prepareReservationistExistingDocument,assertReservationistExistingDocumentReceiptFresh,deriveReservationistDocumentPurpose} from '../src/ai/reservationist-existing-document.js';
import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {syntheticReservationistDocumentFixture as fixture,syntheticReservationistPriorQuoteFixture as priorQuoteFixture} from './helpers/synthetic-reservationist-document.js';
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
describe('exact source-bound existing document capture',()=>{
 it('preserves original authorized PDF bytes and uses the existing typed read metadata',async()=>{const f=fixture();const r=await f.run();expect(r.document.body.equals(f.document.body)).toBe(true);expect(r.receipt.binding.purpose).toBe('tax_certificate');expect(r.receipt.binding.documentDigest).toBe(quoteDigest(r.receipt.capture));assertReservationistExistingDocumentReceiptFresh(r.receipt,new Date(f.input.clock.sourceAt));});
 it.each(['owner','thread','request','purpose','reservation','hash','version','future','expired','page'])('rejects %s source substitution',async key=>{const f=fixture('receipt');if(key==='owner')f.document.sourceProof.ownerRef='foreign';if(key==='thread')f.document.sourceProof.threadId='foreign';if(key==='request')f.authorize.mockImplementation(async(b:any)=>({...b,requestId:'foreign'}) as any);if(key==='purpose')f.document.sourceProof.purpose='tax_certificate';if(key==='reservation')f.document.sourceProof.reservationRef='XYZ999';if(key==='hash')f.document.sourceProof.sourceHash='a'.repeat(64);if(key==='version')f.document.sourceProof.documentVersion='v2';if(key==='future')f.document.sourceProof.observedAt='2026-10-04T09:01:00Z';if(key==='expired')f.document.sourceProof.expiresAt=f.input.clock.sourceAt;if(key==='page')f.document.sourceProof.pageText='Invoice XYZ999';await expect(f.run()).rejects.toThrow();});
 it('rejects reservation reference prefix and suffix collisions',async()=>{for(const reference of ['ABC1234','XABC123']){const f=fixture('receipt');f.document.sourceProof.pageText=`Receipt ${reference}`;f.document.sourceProof.pageHash=hash(f.document.sourceProof.pageText);f.document.read.data.text=f.document.sourceProof.pageText;await expect(f.run()).rejects.toThrow(/page_target/);}});
 it('rejects invoice metadata and invoice page for certificate even when the grant is positive',async()=>{const f=fixture();f.document.read.data.document.kind='tax_invoice';f.document.sourceProof.pageText='Tax invoice';f.document.sourceProof.pageHash=hash('Tax invoice');await expect(f.run()).rejects.toThrow();});
 it('rejects arbitrary boolean authorization',async()=>{const f=fixture();f.authorize.mockImplementation(async()=>true as any);await expect(f.run()).rejects.toThrow();});
 it('rejects callback mutation of original bytes or authorization binding',async()=>{for(const what of ['body','binding']){const f=fixture();f.authorize.mockImplementation(async(b:any)=>{if(what==='body')f.document.body[0]=0;else b.ownerRef='foreign';return {...b,authorizationId:'grant',disclosure:'guest',issuedAt:'2026-10-04T08:30:00Z',expiresAt:'2026-10-04T10:00:00Z',maxSourceAgeMs:3600000};});await expect(f.run()).rejects.toThrow();}});
 it('keeps missing reservation receipt target unavailable without authorizing a guessed target',async()=>{const f=fixture('receipt');f.input.reservationRef=null;await expect(f.run()).rejects.toThrow(/target.*unavailable/);expect(f.authorize).not.toHaveBeenCalled();});
 it('rejects a narrowed request span for a different document and a future original request',async()=>{for(const what of ['span','clock']){const f=fixture();if(what==='span')f.input.taskSource.quote='receipt';else f.input.originalRequest.at='2026-10-04T08:01:00Z';await expect(f.run()).rejects.toThrow();}});
 it('revalidates retained byte/read/source/request digests and window before promotion',async()=>{const f=fixture();const r=await f.run();expect(()=>assertReservationistExistingDocumentReceiptFresh(r.receipt,new Date('2026-10-04T10:00:00Z'))).toThrow();const changed=structuredClone(r.receipt);changed.sourceProof.reservationRef='foreign';expect(()=>assertReservationistExistingDocumentReceiptFresh(changed,new Date(f.input.clock.sourceAt))).toThrow();});
 it('preserves historical causal scope and never borrows a future original document',async()=>{const f=fixture();f.input.clock.sourceMode='historical';f.input.clock.sourceAt=f.input.clock.causalAt;await expect(f.run()).rejects.toThrow();});
});

describe('explicit prebooking prior quote document',()=>{
 it.each(['Please resend quotation Q-123.','Please attach the existing quote Q-123.','Please send me a copy of proposal Q-123.'])('captures %s without requiring a reservation',async text=>{
  const f=priorQuoteFixture(text),r=await f.run();
  expect(r.receipt.binding).toMatchObject({purpose:'existing_quote',reservationRef:null,priorQuoteRef:'Q-123',parentRef:'Q-123',documentRef:'opaque-original-document'});
  expect(r.receipt.grant).toMatchObject({priorQuoteRef:'Q-123',parentRef:'Q-123'});expect(r.document.body.equals(f.document.body)).toBe(true);
  assertReservationistExistingDocumentReceiptFresh(r.receipt,new Date(f.input.clock.sourceAt));
 });
 it.each(['source-target','parent-target','thread','late-quote','late-version','property','grant-target'])('rejects %s substitution after selecting a prior quote',async key=>{
  const f=priorQuoteFixture();
  if(key==='source-target')f.document.sourceProof.priorQuoteRef='Q-999';
  if(key==='parent-target')f.document.read.data.document.parentRef='Q-999';
  if(key==='thread')f.document.sourceProof.threadId='foreign';
  if(key==='property')f.document.sourceProof.propertyCode='OTHER';
  if(key==='late-quote'){f.document.sourceProof.issuedAt='2026-10-04T08:01:00Z';f.document.read.data.document.issuedAt=f.document.sourceProof.issuedAt;}
  if(key==='late-version')f.document.read.data.document.currentVersion=false;
  if(key==='grant-target')f.authorize.mockImplementation(async(b:any)=>({...b,priorQuoteRef:'Q-999',authorizationId:'grant',disclosure:'guest',issuedAt:'2026-10-04T08:30:00Z',expiresAt:'2026-10-04T10:00:00Z',maxSourceAgeMs:3600000}));
  await expect(f.run()).rejects.toThrow();
 });
 it.each(['Please resend quotation Q-1234.','Please resend quotation XQ-123.','Please prepare a new quote Q-123.','Please attach a new quotation Q-123.','Please resend the quotation.'])('denies unsourced or new quote target %s before resolution',async text=>{
  const f=priorQuoteFixture(text),resolve=vi.fn(async()=>f.document);
  await expect(prepareReservationistExistingDocument(f.input,{resolve,authorize:f.authorize,signal:new AbortController().signal})).rejects.toThrow(/purpose|target/);
  expect(resolve).not.toHaveBeenCalled();expect(f.authorize).not.toHaveBeenCalled();
 });
 it('does not treat an unrelated reference in the same span as the requested quote target',async()=>{
  const f=priorQuoteFixture('Please resend quotation Q-999. Q-123 is an unrelated account reference.');const resolve=vi.fn(async()=>f.document);
  await expect(prepareReservationistExistingDocument(f.input,{resolve,authorize:f.authorize,signal:new AbortController().signal})).rejects.toThrow(/target/);expect(resolve).not.toHaveBeenCalled();
 });
 it('does not treat a same-sentence account reference as the requested quote target',async()=>{
  const f=priorQuoteFixture('Please resend quotation Q-999 and use account Q-123.');const resolve=vi.fn(async()=>f.document);
  await expect(prepareReservationistExistingDocument(f.input,{resolve,authorize:f.authorize,signal:new AbortController().signal})).rejects.toThrow(/target/);expect(resolve).not.toHaveBeenCalled();
 });
 it('requires the target inside the selected task span even when another request sentence contains it',async()=>{
  const f=priorQuoteFixture('Please resend the quotation. Reference Q-123 is for a different request.');const span='Please resend the quotation.';f.input.taskSource.quote=span;f.input.taskSource.end=span.length;
  const resolve=vi.fn(async()=>f.document);await expect(prepareReservationistExistingDocument(f.input,{resolve,authorize:f.authorize,signal:new AbortController().signal})).rejects.toThrow(/target/);expect(resolve).not.toHaveBeenCalled();
 });
 it.each(['Q-1234','XQ-123'])('rejects captured quote page reference collision %s',async ref=>{
  const f=priorQuoteFixture();f.document.sourceProof.pageText=`Quotation ${ref}`;f.document.sourceProof.pageHash=hash(f.document.sourceProof.pageText);f.document.read.data.text=f.document.sourceProof.pageText;await expect(f.run()).rejects.toThrow(/page_target/);
 });
 it('keeps a missing explicit prior reference unavailable without property-wide authorization',async()=>{
  const f=priorQuoteFixture();delete f.input.priorQuoteRef;const resolve=vi.fn(async()=>f.document);await expect(prepareReservationistExistingDocument(f.input,{resolve,authorize:f.authorize,signal:new AbortController().signal})).rejects.toThrow(/target/);expect(resolve).not.toHaveBeenCalled();
 });
});

 describe('specific compound document purposes',()=>{
  it.each(['Please send pro-forma invoice.','Please send pro forma invoice.','Please send PRO-FORMA INVOICE.'])('recognizes one compound purpose: %s',text=>expect(deriveReservationistDocumentPurpose(text)).toBe('pro_forma'));
  it.each(['Please send a pro-forma invoice and a tax invoice.','Please send a pro-forma invoice. Also send the invoice.','Please send the tax invoice and pro-forma.'])('keeps independently named document purposes ambiguous: %s',text=>expect(()=>deriveReservationistDocumentPurpose(text)).toThrow(/purpose_unavailable/));
 });

 it('reads a compound pro-forma invoice through exact typed capture and authorization',async()=>{const f=fixture('receipt'),text='Please send pro-forma invoice for reservation ABC123.',page='Pro-forma invoice ABC123';f.input.taskSource={...f.input.taskSource,sourceHash:hash(text),quote:text,start:0,end:text.length};f.input.originalRequest={...f.input.originalRequest,text,sourceHash:hash(text),pageHash:hash(text)};f.document.read.data.document.kind='pro_forma';f.document.read.data.text=page;f.document.sourceProof={...f.document.sourceProof,purpose:'pro_forma',pageText:page,pageHash:hash(page)};const r=await f.run();expect(r.receipt.binding.purpose).toBe('pro_forma');expect(r.document.body.equals(f.document.body)).toBe(true);expect(f.authorize).toHaveBeenCalledOnce();});
