import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {ARTIFACT_MAX_INPUT_BYTES,readAuthorizedArtifactBytes} from '../src/mail/artifacts/read-artifact.js';
import {FakeS3Storage} from '../src/storage/s3.js';
import {admitReservationistAttachment} from '../src/ai/reservationist-attachment-input.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function fixture(mimeType='image/png',body=png){
 const s3=new FakeS3Storage('bounded-raster-test'),locator={s3Key:'attachments/message/raster',messageId:'message',mimeType,sizeBytes:body.length},sha256=createHash('sha256').update(body).digest('hex');
 await s3.putObject({key:locator.s3Key,body,contentType:mimeType});s3.calls.length=0;
 const read={attachmentId:'raster',authorizedAttachmentIds:new Set(['raster']),s3,signal:new AbortController().signal,resolveLocator:async()=>({...locator}),expectedLocator:{...locator},expectedSha256:sha256,revalidate:async()=>true,allowRaster:true};
 return{read,s3,locator,sha256,metadata:{attachmentId:'raster',messageId:'message',threadId:'thread',ownerRef:'owner',messageAt:'2026-10-01T00:00:00Z',mimeType,sizeBytes:body.length,sourceHash:sha256,disclosure:'guest' as const},scope:{ownerRef:'owner',threadId:'thread',requestAt:'2026-10-01T00:00:00Z'}};
}
describe('trusted worker bounded raster byte acquisition',()=>{
 it('acquires exact raster bytes before existing visual-only admission and rechecks the same hash',async()=>{
  const f=await fixture(),bytes=await readAuthorizedArtifactBytes(f.read);expect(bytes?.sha256).toBe(f.sha256);expect(bytes?.body).toEqual(png);
  expect(await admitReservationistAttachment(f)).toMatchObject({status:'admitted',reason:'visual_review_required',draftReady:false,source:{pages:null,pageCount:1}});
  expect((await readAuthorizedArtifactBytes({...f.read,expectedSha256:bytes!.sha256}))?.sha256).toBe(f.sha256);
 });
 it('retains GIF bytes and metadata as unsupported manual work',async()=>{
  const f=await fixture('image/gif',Buffer.from('GIF89a bounded unsupported business image'));
  expect((await readAuthorizedArtifactBytes(f.read))?.sha256).toBe(f.sha256);expect(await admitReservationistAttachment(f)).toMatchObject({status:'manual_required',reason:'unsupported_business_attachment',metadata:{mimeType:'image/gif'},draftReady:false});
 });
 it('leaves raster denied by default and requires exact locator plus live revalidation for opt-in',async()=>{
  for(const omitted of ['allowRaster','expectedLocator','revalidate'] as const){const f=await fixture(),read={...f.read};delete (read as Partial<typeof read>)[omitted];expect(await readAuthorizedArtifactBytes(read)).toBeNull();expect(f.s3.calls).toEqual([]);}
 });
 it.each(['unauthorized','foreign-locator','changed-locator','unsafe-path','head-mime','head-size','revoked','wrong-hash','oversized','unsupported-mime'] as const)('denies %s without admitted visual authority',async bad=>{
  const f=await fixture();
  if(bad==='unauthorized')f.read.authorizedAttachmentIds.clear();
  if(bad==='foreign-locator')f.locator.s3Key='attachments/foreign/raster';
  if(bad==='changed-locator')f.locator.messageId='foreign';
  if(bad==='unsafe-path'){f.locator.s3Key='attachments/message/../raster';f.read.expectedLocator={...f.locator};}
  if(bad==='head-mime')f.s3.stored.get(f.locator.s3Key)!.contentType='image/jpeg';
  if(bad==='head-size')f.s3.stored.get(f.locator.s3Key)!.body=Buffer.from('short');
  if(bad==='revoked')f.read.revalidate=async()=>false;
  if(bad==='wrong-hash')f.read.expectedSha256='b'.repeat(64);
  if(bad==='oversized'){f.locator.sizeBytes=ARTIFACT_MAX_INPUT_BYTES+1;f.read.expectedLocator={...f.locator};}
  if(bad==='unsupported-mime'){f.locator.mimeType='image/svg+xml';f.read.expectedLocator={...f.locator};}
  expect(await readAuthorizedArtifactBytes(f.read)).toBeNull();
 });
 it('still lets existing raster validator reject malformed bytes',async()=>{
  const f=await fixture('image/png',Buffer.from('not a raster, still bounded bytes'));expect(await readAuthorizedArtifactBytes(f.read)).not.toBeNull();expect(await admitReservationistAttachment(f)).toMatchObject({status:'manual_required',reason:'malformed_or_unsupported_raster',draftReady:false});
 });
});
