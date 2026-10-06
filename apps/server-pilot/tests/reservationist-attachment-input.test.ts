import { admitReservationistAttachment,validateReservationistRaster,isReservationistSignatureNoise } from '../src/ai/reservationist-attachment-input.js';
import { createHash } from 'node:crypto';
import {validateDocumentPlan,guestDocumentFacts} from '../src/ai/reservationist-document-facts.js';
import { expect, it } from 'vitest';
const body = Buffer.from('2 adults');
const metadata = {
  attachmentId: 'a',
  messageId: 'm',
  threadId: 't',
  ownerRef: 'o',
  messageAt: '2026-10-01T00:00:00Z',
  mimeType: 'text/plain',
  sizeBytes: body.length,
  sourceHash: createHash('sha256').update(body).digest('hex'),
  disclosure: 'guest' as const,
};
const scope = { ownerRef: 'o', threadId: 't', requestAt: '2026-10-02T00:00:00Z' };
const read = {
  attachmentId: 'a',
  authorizedAttachmentIds: new Set(['a']),
  signal: new AbortController().signal,
  resolveLocator: async () => ({
    messageId: 'm',
    mimeType: 'text/plain',
    sizeBytes: body.length,
    s3Key: 'attachments/m/a',
  }),
  s3: {
    getObjectBounded: async () => ({ body, contentType: 'text/plain' }),
    headObject: async () => ({ sizeBytes: body.length, contentType: 'text/plain' }),
  } as any,
  revalidate: async () => true,
};
it('admits actual prior bytes with hash and owner proof without draft readiness', async () => {
  const result = await admitReservationistAttachment({ metadata, scope, read });
  expect(result.status).toBe('admitted');
  expect(result.source?.pages).toEqual(['2 adults']);
  expect(result.draftReady).toBe(false);
});
it('denies future, cross-owner, altered-byte and mime identities', async () => {
  for (const altered of [
    { messageAt: '2026-10-03T00:00:00Z' },
    { ownerRef: 'x' },
    { sourceHash: 'b'.repeat(64) },
    { mimeType: 'application/pdf' },
  ])
    expect(
      (await admitReservationistAttachment({ metadata: { ...metadata, ...altered }, scope, read }))
        .status,
    ).toBe('manual_required');
});
it('keeps unknown files for recovery while filtering explicit CID signature noise', async () => {
  expect(
    (
      await admitReservationistAttachment({
        metadata: { ...metadata, mimeType: 'application/octet-stream' },
        scope,
        read,
      })
    ).status,
  ).toBe('manual_required');
  expect(
    (
      await admitReservationistAttachment({
        metadata: { ...metadata, mimeType: 'image/png', inline: true, signatureNoise: true },
        scope,
        read,
      })
    ).status,
  ).toBe('ignored_signature');
});
it('denies oversized metadata before byte reads and missing live authorization', async () => {
  expect(
    (
      await admitReservationistAttachment({
        metadata: { ...metadata, sizeBytes: 30 * 1024 * 1024 },
        scope,
        read,
      })
    ).reason,
  ).toBe('too_large');
  expect(
    (
      await admitReservationistAttachment({
        metadata,
        scope,
        read: { ...read, revalidate: async () => false },
      })
    ).status,
  ).toBe('manual_required');
});
it('handles bounded scanned, encrypted, malformed PDFs with existing sandbox adapter', async () => {
  const pdf = Buffer.from('%PDF-synthetic');
  const meta = {
    ...metadata,
    mimeType: 'application/pdf',
    sizeBytes: pdf.length,
    sourceHash: createHash('sha256').update(pdf).digest('hex'),
  };
  const pdfRead = {
    ...read,
    resolveLocator: async () => ({
      messageId: 'm',
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      s3Key: 'attachments/m/a',
    }),
    s3: {
      headObject: async () => ({ sizeBytes: pdf.length, contentType: 'application/pdf' }),
      getObjectBounded: async () => ({ body: pdf, contentType: 'application/pdf' }),
    } as any,
  };
  const sandbox =
    (info: string, exit = 0) =>
    async (tool: string) => ({
      stdout: Buffer.from(tool === 'pdfinfo' ? info : ''),
      stderr: Buffer.alloc(0),
      exitCode: tool === 'pdfinfo' ? exit : 0,
    });
  const scanned = await admitReservationistAttachment({
    metadata: meta,
    scope,
    read: pdfRead,
    runner: sandbox('Pages: 1\nEncrypted: no'),
  });
  expect(scanned.status).toBe('admitted');
  expect(scanned.source?.pages).toBeNull();
  expect(
    (
      await admitReservationistAttachment({
        metadata: meta,
        scope,
        read: pdfRead,
        runner: sandbox('Pages: 1\nEncrypted: yes'),
      })
    ).reason,
  ).toBe('encrypted');
  expect(
    (
      await admitReservationistAttachment({
        metadata: meta,
        scope,
        read: pdfRead,
        runner: sandbox('', 1),
      })
    ).reason,
  ).toBe('malformed');
});

const rasterFixtures={
 'image/png':'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4z8DwnwGMERQARNAF+7BYSawAAAAASUVORK5CYII=',
 'image/jpeg':'/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
 'image/webp':'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
};
function rasterInput(mimeType:string,body:Buffer){const metadata={attachmentId:'image',messageId:'m',threadId:'t',ownerRef:'o',messageAt:'2026-10-01T00:00:00Z',mimeType,sizeBytes:body.length,sourceHash:createHash('sha256').update(body).digest('hex'),disclosure:'staff_only' as const};const locator={messageId:'m',mimeType,sizeBytes:body.length,s3Key:'attachments/m/image'};return{metadata,scope:{...scope},read:{...read,attachmentId:'image',authorizedAttachmentIds:new Set(['image']),resolveLocator:async()=>locator,s3:{headObject:async()=>({sizeBytes:body.length,contentType:mimeType}),getObjectBounded:async()=>({body,contentType:mimeType})} as typeof read.s3}};}
it.each(Object.entries(rasterFixtures))('admits original %s bytes as a one-page visual source with no OCR text',async(mimeType,base64)=>{
 const body=Buffer.from(base64,'base64'),candidate=rasterInput(mimeType,body),result=await admitReservationistAttachment(candidate);
 expect(result).toMatchObject({status:'admitted',reason:'visual_review_required',draftReady:false,source:{pages:null,pageCount:1,sourceHash:candidate.metadata.sourceHash,disclosure:'staff_only'}});expect(result.bytes?.body).toEqual(body);
 expect(validateReservationistRaster(body,mimeType)).toEqual({width:2,height:3});
});
it.each(['identity','foreign_locator','revoked_after_read','magic','dimensions','animation','truncated','gif'])('keeps unsafe raster %s manual',async key=>{
 let body=Buffer.from(rasterFixtures['image/png'],'base64'),mimeType='image/png';
 if(key==='magic')body=Buffer.from('arbitrary OCR text');if(key==='dimensions'){body=Buffer.from(body);body.writeUInt32BE(100000,16);}if(key==='animation'){body=Buffer.from(rasterFixtures['image/webp'],'base64');mimeType='image/webp';body.write('ANIM',12);}
 if(key==='truncated')body=body.subarray(0,24);if(key==='gif'){body=Buffer.from('GIF89a');mimeType='image/gif';}
 const candidate=rasterInput(mimeType,body);if(key==='identity')candidate.metadata.sourceHash='b'.repeat(64);if(key==='foreign_locator')candidate.read.resolveLocator=async()=>({messageId:'other',mimeType,sizeBytes:body.length,s3Key:'attachments/other/image'});
 if(key==='revoked_after_read'){let calls=0;candidate.read.revalidate=async()=>++calls===1;}
 expect((await admitReservationistAttachment(candidate)).status).toBe('manual_required');
});

it('keeps raster facts visual-only and denies metadata/scope mutation during the read',async()=>{
 const body=Buffer.from(rasterFixtures['image/png'],'base64'),candidate=rasterInput('image/png',body),result=await admitReservationistAttachment(candidate);
 const fact={id:'guest',kind:'guest',value:{firstName:'Jane',lastName:'Smith'},disclosure:'guest',source:{attachmentId:'image',sourceHash:candidate.metadata.sourceHash,page:1,region:[0,0,1,1]}};
 const plan=validateDocumentPlan({facts:[fact],tasks:[],unresolvedAsks:[]},[result.source!]);expect(plan.facts[0].verification).toBe('visual_review_required');expect(guestDocumentFacts(plan)).toEqual([]);
 expect(()=>validateDocumentPlan({facts:[{...fact,source:{...fact.source,quote:'Jane Smith',start:0,end:10}}],tasks:[],unresolvedAsks:[]},[result.source!])).toThrow();
 const changed=rasterInput('image/png',body);changed.read.s3.getObjectBounded=async()=>{changed.scope.ownerRef='foreign';return{body,contentType:'image/png'};};
 expect((await admitReservationistAttachment(changed)).status).toBe('manual_required');
});

const docxMime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function officeInput(){
 const body=Buffer.from('PK\u0003\u0004synthetic-docx'),candidate=rasterInput(docxMime,body);
 return {...candidate,read:{...candidate.read,expectedLocator:{messageId:'m',mimeType:docxMime,sizeBytes:body.length,s3Key:'attachments/m/image'}}};
}
it('extracts derived DOCX PDF pages while retaining original bytes and explicit rendering hashes',async()=>{
 const candidate=officeInput(),pdf=Buffer.from('%PDF-derived-office');
 const result=await admitReservationistAttachment({...candidate,officeConverter:async(original,signal)=>{expect(original).toEqual(Buffer.from('PK\u0003\u0004synthetic-docx'));signal.throwIfAborted();return pdf;},runner:async tool=>({stdout:Buffer.from(tool==='pdfinfo'?'Pages: 1\nEncrypted: no':'CHECK IN: 30 September 2026\f'),stderr:Buffer.alloc(0),exitCode:0})});
 expect(result.status).toBe('admitted');expect(result.bytes?.sha256).toBe(candidate.metadata.sourceHash);expect(result.bytes?.body).toEqual(Buffer.from('PK\u0003\u0004synthetic-docx'));
 expect(result.source).toMatchObject({sourceHash:candidate.metadata.sourceHash,pages:['CHECK IN: 30 September 2026'],pageCount:1,rendering:{method:'gotenberg_libreoffice',originalSourceHash:candidate.metadata.sourceHash,derivedPdfSHA256:createHash('sha256').update(pdf).digest('hex'),pageProvenance:'derived_pdf'}});
 expect(()=>validateDocumentPlan({facts:[],tasks:[],unresolvedAsks:[]},[result.source!])).not.toThrow();
 for(const source of [{...result.source!,sourceHash:'b'.repeat(64)},{...result.source!,pages:['invented']},{...result.source!,rendering:{...result.source!.rendering!,derivedPdfSHA256:'invalid'}}])expect(()=>validateDocumentPlan({facts:[],tasks:[],unresolvedAsks:[]},[source])).toThrow('Invalid derived document rendering');
});
it.each(['missing_locator','foreign_owner','hash_changed','converter_failure','invalid_pdf','textless_pdf','revoked_after_parser'])('keeps DOCX %s manual without exposing an unbound derived source',async key=>{
 const candidate=officeInput();let converted=0;
 if(key==='missing_locator')candidate.read.expectedLocator=undefined as any;
 if(key==='foreign_owner')candidate.metadata.ownerRef='foreign';
 if(key==='hash_changed')candidate.metadata.sourceHash='b'.repeat(64);
 let live=true;if(key==='revoked_after_parser')candidate.read.revalidate=async()=>live;
 const result=await admitReservationistAttachment({...candidate,officeConverter:async original=>{converted++;original.fill(0);if(key==='converter_failure')throw new Error('failed');return Buffer.from(key==='invalid_pdf'?'wrong file':'%PDF-derived-office');},runner:async tool=>{if(key==='revoked_after_parser'&&tool==='pdftotext')live=false;return{stdout:Buffer.from(tool==='pdfinfo'?'Pages: 1\nEncrypted: no':key==='textless_pdf'?'':'Actual original text\f'),stderr:Buffer.alloc(0),exitCode:0};}});
 expect(result.status).toBe('manual_required');expect(result.source).toBeUndefined();expect(result.bytes).toBeUndefined();
 if(['missing_locator','foreign_owner','hash_changed'].includes(key))expect(converted).toBe(0);
});
it('isolates converter mutations from the exact original DOCX bytes',async()=>{
 const candidate=officeInput(),result=await admitReservationistAttachment({...candidate,officeConverter:async original=>{original.fill(0);return Buffer.from('%PDF-derived-office');},runner:async tool=>({stdout:Buffer.from(tool==='pdfinfo'?'Pages: 1\nEncrypted: no':'Actual original text\f'),stderr:Buffer.alloc(0),exitCode:0})});
 expect(result.status).toBe('admitted');expect(createHash('sha256').update(result.bytes!.body).digest('hex')).toBe(candidate.metadata.sourceHash);
});
it('does not convert DOCX without opt-in or after source authorization changes',async()=>{
 const noConverter=await admitReservationistAttachment(officeInput());expect(noConverter.reason).toBe('office_converter_unavailable');
 let converted=0;const revoked=officeInput();let reads=0;revoked.read.revalidate=async()=>++reads===1;
 expect((await admitReservationistAttachment({...revoked,officeConverter:async()=>{converted++;return Buffer.from('%PDF-no');}})).status).toBe('manual_required');expect(converted).toBe(0);
 const changed=officeInput();expect((await admitReservationistAttachment({...changed,officeConverter:async()=>{changed.scope.ownerRef='foreign';return Buffer.from('%PDF-derived');},runner:async tool=>({stdout:Buffer.from(tool==='pdfinfo'?'Pages: 1\nEncrypted: no':'text\f'),stderr:Buffer.alloc(0),exitCode:0})})).status).toBe('manual_required');
});

const signatureDescriptor={id:'logo',messageId:'m',isInline:true,contentId:'footer@sender',mimeType:'image/gif'};
const signatureText='Please quote one single room.\nKind regards,\nAlex Example\n[cid:footer@sender]\nCompany contact details';
const classifySignature=(text=signatureText,altered={},attachments:any[]=[signatureDescriptor],currentRequestText=text)=>isReservationistSignatureNoise({messageText:text,currentRequestText,attachment:{...signatureDescriptor,...altered},attachments});
it('classifies only a unique original CID raster entirely in a proved signature footer',()=>{expect(classifySignature()).toBe(true);expect(classifySignature(signatureText,{mimeType:'image/png'})).toBe(true);expect(classifySignature(signatureText,{contentId:'<footer@sender>'})).toBe(true);});
it.each(['Please quote based on the dates below.','Please advise availability based on single and double occupancy for the dates below.'])('keeps an explicit dates reference separate from a footer image dependency: %s',request=>{
 const text=request+'\n12 October 2026 to 14 October 2026\nKind regards,\n[cid:footer@sender]';expect(classifySignature(text)).toBe(true);
});
it.each(['Please quote based on the room allocation below.','Please quote using the dates shown in the image below.','Please quote based on the dates below and the attached voucher.'])('preserves other and explicit attachment dependencies beside dates: %s',request=>expect(classifySignature(request+'\nKind regards,\n[cid:footer@sender]')).toBe(false));
it.each([
 'Please quote the attached image.\nKind regards,\n[cid:footer@sender]',
 'Please use the document below for this quote.\nKind regards,\n[cid:footer@sender]',
 'Please quote. [cid:footer@sender]\nKind regards,\n[cid:footer@sender]',
 'Please quote.\n[cid:footer@sender]',
 'Kind regards,\nFrom: Prior customer\n[cid:footer@sender]',
 'Please quote.\nKind regards,\nPlease see the attached room allocation.\n[cid:footer@sender]',
])('keeps business, pre-footer, unbounded and quoted image contexts: %s',text=>expect(classifySignature(text)).toBe(false));
it('keeps missing/duplicate CID ownership, noninline documents and current delegated images for review',()=>{
 expect(classifySignature(signatureText,{contentId:'unknown'})).toBe(false);expect(classifySignature(signatureText,{},[signatureDescriptor,{...signatureDescriptor,id:'other'}])).toBe(false);expect(classifySignature(signatureText,{isInline:false})).toBe(false);expect(classifySignature(signatureText,{mimeType:'application/pdf'})).toBe(false);expect(classifySignature(signatureText,{},[signatureDescriptor],'Please quote using the attached image.')).toBe(false);
});
it('feeds only demonstrated signature classification to the existing ignored_signature admission seam',async()=>{const m={...metadata,mimeType:'image/gif',inline:true,contentId:'footer@sender',signatureNoise:classifySignature()};expect((await admitReservationistAttachment({metadata:m,scope,read})).status).toBe('ignored_signature');expect((await admitReservationistAttachment({metadata:{...m,signatureNoise:classifySignature('Please quote the attached image.\nKind regards,\n[cid:footer@sender]')},scope,read})).reason).toBe('unsupported_business_attachment');});

