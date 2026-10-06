import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {FakeS3Storage} from '../src/storage/s3.js';
import {acquireCausalReservationistAttachment} from '../src/ai/reservationist-attachment-acquisition.js';

async function fixture(){
 const storage=new FakeS3Storage('nava-zero-mail-845242190536-af-south-1'),body=Buffer.from('%PDF-1.4 original synthetic');
 const message={id:'m',transportId:'transport-centurion',threadId:'t',eventAt:'2026-09-12T10:00:00Z',businessDirection:'inbound'};
 const descriptor={id:'a',messageId:'m',filename:null,contentType:'application/pdf',byteSize:body.length,s3Key:'attachments/m/000-original',inline:false};
 await storage.putObject({key:descriptor.s3Key,body,contentType:descriptor.contentType});
 return{storage,body,message,descriptor,scope:{ownerRef:'transport-centurion',threadId:'t',requestAt:message.eventAt,sourceSnapshotHash:'a'.repeat(64),disclosure:'guest' as const},signal:new AbortController().signal};
}
describe('causal corpus attachment byte acquisition',()=>{
 it('acquires actual bytes with original ownership and fresh hash without requiring filename or prior hash',async()=>{
  const f=await fixture(),r=await acquireCausalReservationistAttachment(f);
  expect(r.status).toBe('acquired');if(r.status!=='acquired')throw new Error('missing receipt');
  expect(r.bytes.body).toEqual(f.body);expect(r.metadata).toMatchObject({attachmentId:'a',messageId:'m',threadId:'t',ownerRef:'transport-centurion',messageAt:f.message.eventAt,sourceHash:createHash('sha256').update(f.body).digest('hex')});expect(r.authority).toBe('authorized_corpus_read');
 });
 it.each(['owner','thread','future','outbound','message','locator','traversal','snapshot','bucket','size'])('denies invalid %s before object reads',async kind=>{
  const f=await fixture(),read=vi.spyOn(f.storage,'getObjectBounded');
  if(kind==='owner')f.message.transportId='foreign';if(kind==='thread')f.message.threadId='foreign';if(kind==='future')f.message.eventAt='2026-09-13T10:00:00Z';if(kind==='outbound')f.message.businessDirection='outbound';if(kind==='message')f.descriptor.messageId='foreign';if(kind==='locator')f.descriptor.s3Key='attachments/foreign/object';if(kind==='traversal')f.descriptor.s3Key='attachments/m/../object';if(kind==='snapshot')f.scope.sourceSnapshotHash='bad';if(kind==='bucket')Object.assign(f.storage,{bucket:'foreign'});if(kind==='size')f.descriptor.byteSize=21*1024*1024;
  expect((await acquireCausalReservationistAttachment(f)).status).not.toBe('acquired');expect(read).not.toHaveBeenCalled();
 });
 it('acquires unsupported business bytes without claiming they are admitted or missing',async()=>{
  const f=await fixture();f.descriptor.contentType='application/msword';await f.storage.putObject({key:f.descriptor.s3Key,body:f.body,contentType:f.descriptor.contentType});const r=await acquireCausalReservationistAttachment(f);expect(r).toMatchObject({status:'acquired',metadata:{mimeType:'application/msword'}});
 });
 it('allows a prior staff offer as causal context while current or future outbound remains ineligible',async()=>{
  const f=await fixture();f.message.businessDirection='outbound';f.scope.requestAt='2026-09-13T10:00:00Z';expect((await acquireCausalReservationistAttachment(f)).status).toBe('acquired');
 });
 it('refuses changed object size and aborts before storage access',async()=>{
  const f=await fixture();f.descriptor.byteSize++;expect((await acquireCausalReservationistAttachment(f)).status).toBe('failed');const c=new AbortController();c.abort();await expect(acquireCausalReservationistAttachment({...f,signal:c.signal})).rejects.toThrow();
 });
 it('refuses scope mutation during the bounded object read',async()=>{
  const f=await fixture(),read=f.storage.getObjectBounded.bind(f.storage);
  vi.spyOn(f.storage,'getObjectBounded').mockImplementation(async(...args)=>{const result=await read(...args);f.message.threadId='foreign';return result;});
  expect((await acquireCausalReservationistAttachment(f)).status).toBe('failed');
 });
});
