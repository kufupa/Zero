import { describe, expect, it, vi } from 'vitest';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { renderRevisionProposalHtml, buildRevisionProposalPdf } from '../src/quote-proposal/proposal-pdf.js';
const header={attention:'Synthetic <script>alert(1)</script>',company:'Test',clientEmail:'test@example.invalid',clientTelephone:'',agency:'Synthetic',signerName:'Test',signerEmail:'test@example.invalid'};
describe('complete revision proposal rendering',()=>{
 it.each([1,7,13])('renders %s varying price runs with complete pages and one total',async(count)=>{
  const r=await syntheticRevision(Array.from({length:count},(_,i)=>`${100+i}.01`));
  const html=renderRevisionProposalHtml(r,header).replace(/data:image\/png;base64,[^"]+/g,'data:image/png;base64,');
  expect((html.match(/data-line=/g)||[]).length).toBe(count);
  expect((html.match(/data-proposal-total=/g)||[]).length).toBe(1);
  expect((html.match(/class="proposal-page"/g)||[]).length).toBe(Math.ceil(count/6));
  expect(html).not.toContain(r.id);expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
  expect(html).not.toContain('Breakfast is included');expect(html).toContain('VAT and tourism levy included');
  expect(html).toContain('three days');expect(html).toContain('no rooms are currently being held');
 });
 it('binds PDF bytes and hash to the immutable revision, using local HTML without remote resources',async()=>{
  const r=await syntheticRevision();const fetchMock=vi.fn(async(_url:unknown,init:any)=>{
   const blob=init.body.get('files') as Blob;expect(await blob.text()).not.toContain(r.id);
   return new Response('%PDF-1.4 synthetic',{headers:{'content-type':'application/pdf'}});
  });
  const result=await buildRevisionProposalPdf(r,header,{url:'http://local.test',fetchImpl:fetchMock as any});
  expect(result.revisionId).toBe(r.id);expect(result.pdfHash).toMatch(/^[a-f0-9]{64}$/);
  expect(fetchMock.mock.calls[0][0]).toBe('http://local.test/forms/chromium/convert/html');
 });
});

it('renders authorized extras and reconciles one combined final total',async()=>{
 const r=await syntheticRevision();const facts={revisionId:r.id,authorizationId:r.authorizationId,sourceRef:'document',sourceHash:'c'.repeat(64),extras:[{id:'trip',label:'Airport trip',quantity:1,units:2,unitKind:'trip' as const,unitMinor:50000,service:'transport',persons:[],dates:['2026-10-12','2026-10-15']}],includedEntitlements:[]};
 const html=renderRevisionProposalHtml(r,header,facts);
 expect(html.includes('Airport trip')).toBe(true);
 expect(html.includes(`data-proposal-total="${r.totalMinor+100000}"`)).toBe(true);
});
import { renderImportedProposalHtml, renderApprovedOverrideHtml } from '../src/quote-proposal/proposal-pdf.js';
import { resolveImportedOffer, resolveApprovedOverride } from '../src/quote-proposal/quote-revision.js';
it('preserves imported original lines and approved override without inventing native nights',async()=>{
 const r=await syntheticRevision();
 const source={ref:'sent',sourceHash:'a'.repeat(64),authorizationId:r.authorizationId,scopeDigest:r.scopeDigest,propertyCode:'HRCEN',currency:'ZAR',printedDate:'2026-10-04',sentAt:'2026-10-04T10:00:00Z',validUntil:'2026-10-07',terms:'Original signed terms',lines:[{id:'original',page:1,quote:'Agreed package, original line',amount:'1234.56'}]};
 const offer=await resolveImportedOffer({ref:'sent',authorizationId:r.authorizationId,evaluationAt:'2026-10-05T10:00:00Z',resolveSource:async()=>source,authorizeSource:async()=>true});
 const html=renderImportedProposalHtml(offer,header);expect(html.includes('Agreed package, original line')).toBe(true);expect(html.replace(/\s/g,'').includes('R1234.56')).toBe(true);expect(html.includes('NIGHTS')).toBe(false);
 const override=await resolveApprovedOverride({revision:r,ref:'approval',evaluationAt:'2026-10-05T10:00:00Z',resolveApproval:async()=>({ref:'approval',authorizationId:r.authorizationId,revisionId:r.id,sourceHash:'a'.repeat(64),actorRef:'staff',reason:'Approved adjustment',approvedAt:'2026-10-04T11:00:00Z',amount:'2000.00',currency:'ZAR'}),authorizeActor:async()=>true});
 const amended=renderApprovedOverrideHtml(override,header);expect(amended.includes('Approved adjustment')).toBe(false);expect(amended.replace(/\s/g,'').includes('R2000.00')).toBe(true);expect(amended.includes(r.id)).toBe(false);
});


it('preserves an imported source currency on every line and final total without conversion', async () => {
  const r = await syntheticRevision();
  const source = { ref:'usd-source',sourceHash:'a'.repeat(64),authorizationId:r.authorizationId,scopeDigest:r.scopeDigest,propertyCode:'HRCEN',currency:'USD',printedDate:'2026-10-04',sentAt:'2026-10-04T10:00:00Z',validUntil:'2026-10-07',terms:'Original source currency',lines:[{id:'usd-line',page:1,quote:'USD package',amount:'100.01'}] };
  const offer = await resolveImportedOffer({ref:source.ref,authorizationId:r.authorizationId,evaluationAt:'2026-10-05T10:00:00Z',resolveSource:async()=>source,authorizeSource:async()=>true});
  const html = renderImportedProposalHtml(offer,header);
  expect(html.includes('USD 100.01')).toBe(true);expect(html.includes('R100.01')).toBe(false);expect((html.match(/USD 100.01/g)??[]).length).toBe(2);
});
it('retains selected currency on native and approved totals', async () => {
  const r=structuredClone(await syntheticRevision());r.currency='USD';for(const group of r.groups)group.currency='USD';
  const { quoteDigest }=await import('../src/quote-proposal/quote-revision.js');const {id,...data}=r;r.id=`quote:${quoteDigest(data)}`;
  const html=renderRevisionProposalHtml(r,header);expect(html.includes('USD 100.01')).toBe(true);expect(html.includes('R100.01')).toBe(false);
  const override=await resolveApprovedOverride({revision:r,ref:'usd-approval',evaluationAt:'2026-10-05T10:00:00Z',resolveApproval:async()=>({ref:'usd-approval',authorizationId:r.authorizationId,revisionId:r.id,sourceHash:'a'.repeat(64),actorRef:'staff',reason:'Approved USD replacement',approvedAt:'2026-10-04T11:00:00Z',amount:'2000.00',currency:'USD'}),authorizeActor:async()=>true});
  expect(renderApprovedOverrideHtml(override,header).replace(/\s/g,'').includes('USD2000.00')).toBe(true);
});

it('keeps adjustment actor, approval time, private reason and original revision out of guest PDF text',async()=>{
 const r=await syntheticRevision();const approval={ref:'private-approval-ref',authorizationId:r.authorizationId,revisionId:r.id,sourceHash:'a'.repeat(64),actorRef:'private-staff-actor',reason:'Confidential account dispute settlement',approvedAt:'2026-10-04T11:00:00Z',amount:'2000.00',currency:'ZAR'};
 const packet=await resolveApprovedOverride({revision:r,ref:approval.ref,evaluationAt:'2026-10-05T10:00:00Z',resolveApproval:async()=>approval,authorizeActor:async()=>true});
 const html=renderApprovedOverrideHtml(packet,header);
 for(const privateValue of [approval.actorRef,approval.reason,approval.approvedAt,r.id,approval.ref])expect(html.includes(privateValue)).toBe(false);
 expect(packet).toMatchObject({actorRef:approval.actorRef,reason:approval.reason,approvedAt:approval.approvedAt,originalTotalMinor:r.totalMinor,approvedTotalMinor:200000});
 expect(html.includes('Approved replacement total')).toBe(true);expect(html.replace(/\s/g,'').includes('R2000.00')).toBe(true);
});

it('keeps internal revision identifiers and evidence explanations out of guest quotations',async()=>{const r=await syntheticRevision(),html=renderRevisionProposalHtml(r,header);expect(html).not.toContain(r.id);expect(html).not.toContain('commercial evidence');expect(html).toContain('VAT and tourism levy included');expect(html).toContain('no rooms are currently being held');});
