import {createHash} from 'node:crypto';
import type {S3Storage} from '../storage/s3.js';
import {readAuthorizedArtifactBytes,ARTIFACT_MAX_INPUT_BYTES,type AuthorizedArtifactBytes} from '../mail/artifacts/read-artifact.js';
import type {ReservationistAttachmentMetadata} from './reservationist-attachment-input.js';
export const RESERVATIONIST_ACQUISITION_VERSION='reservationist-corpus-acquisition-v1';
export type CorpusAttachmentAcquisitionInput={
 message:{id:string;transportId:string;threadId:string|null;eventAt:string;businessDirection:string};
 descriptor:{id:string;messageId:string;filename?:string|null;contentType:string;byteSize:number;s3Key:string;inline?:boolean};
 scope:{ownerRef:string;threadId:string;requestAt:string;sourceSnapshotHash:string;disclosure:'guest'|'staff_only'};
 storage:S3Storage;signal:AbortSignal;
};
export type CorpusAttachmentAcquisitionResult={status:'acquired';version:typeof RESERVATIONIST_ACQUISITION_VERSION;authority:'authorized_corpus_read';sourceSnapshotHash:string;metadata:ReservationistAttachmentMetadata;filename:string|null;bytes:AuthorizedArtifactBytes}|{status:'ineligible'|'failed';code:string};
/** Offline recovery authority comes from the user-authorized corpus, never a production tenant grant. */
export async function acquireCausalReservationistAttachment(input:CorpusAttachmentAcquisitionInput):Promise<CorpusAttachmentAcquisitionResult>{
 input.signal.throwIfAborted();
 const message={...input.message},descriptor={...input.descriptor},scope={...input.scope};
 const at=Date.parse(message.eventAt),requestAt=Date.parse(scope.requestAt);
 if(input.storage.bucket!=='nava-zero-mail-845242190536-af-south-1'||message.transportId!=='transport-centurion'||scope.ownerRef!==message.transportId||!message.id||!descriptor.id||descriptor.messageId!==message.id||!message.threadId||message.threadId!==scope.threadId||!['inbound','outbound'].includes(message.businessDirection)||message.businessDirection==='outbound'&&at>=requestAt||!Number.isFinite(at)||!Number.isFinite(requestAt)||at>requestAt||at<Date.parse('2026-09-07T22:00:00Z')||at>=Date.parse('2026-10-02T22:00:00Z')||! /^[a-f0-9]{64}$/.test(scope.sourceSnapshotHash)||!['guest','staff_only'].includes(scope.disclosure))return{status:'ineligible',code:'causal_scope_mismatch'};
 if(!descriptor.s3Key.startsWith(`attachments/${message.id}/`)||descriptor.s3Key.includes('\\')||descriptor.s3Key.split('/').some(part=>!part||part==='.'||part==='..'))return{status:'ineligible',code:'locator_scope_mismatch'};
 if(!Number.isSafeInteger(descriptor.byteSize)||descriptor.byteSize<1||descriptor.byteSize>ARTIFACT_MAX_INPUT_BYTES)return{status:'ineligible',code:'byte_limit'};
 if(!descriptor.contentType||descriptor.contentType.length>128)return{status:'ineligible',code:'invalid_mime'};
 const locator={s3Key:descriptor.s3Key,messageId:message.id,mimeType:descriptor.contentType,sizeBytes:descriptor.byteSize};
 let bytes:AuthorizedArtifactBytes|null;
 const unchanged=()=>JSON.stringify(input.message)===JSON.stringify(message)&&JSON.stringify(input.descriptor)===JSON.stringify(descriptor)&&JSON.stringify(input.scope)===JSON.stringify(scope);
 if(['application/pdf','text/plain'].includes(descriptor.contentType))bytes=await readAuthorizedArtifactBytes({attachmentId:descriptor.id,authorizedAttachmentIds:new Set([descriptor.id]),s3:input.storage,signal:input.signal,resolveLocator:async()=>({...locator}),expectedLocator:locator,revalidate:async()=>unchanged()});
 else{
  const head=await input.storage.headObject(locator.s3Key);
  if(!head||head.sizeBytes!==descriptor.byteSize||head.contentType&&head.contentType!==descriptor.contentType||!unchanged())return{status:'failed',code:'object_identity_or_access'};
  const object=await input.storage.getObjectBounded(locator.s3Key,descriptor.byteSize,input.signal);
  bytes=object&&object.body.length===descriptor.byteSize&&(!object.contentType||object.contentType===descriptor.contentType)?{...object,locator,sha256:createHash('sha256').update(object.body).digest('hex')}:null;
 }
 input.signal.throwIfAborted();
 if(!bytes||JSON.stringify(input.message)!==JSON.stringify(message)||JSON.stringify(input.descriptor)!==JSON.stringify(descriptor)||JSON.stringify(input.scope)!==JSON.stringify(scope))return{status:'failed',code:'object_identity_or_access'};
 return{status:'acquired',version:RESERVATIONIST_ACQUISITION_VERSION,authority:'authorized_corpus_read',sourceSnapshotHash:scope.sourceSnapshotHash,filename:descriptor.filename||null,metadata:{attachmentId:descriptor.id,messageId:message.id,threadId:message.threadId,ownerRef:message.transportId,messageAt:message.eventAt,mimeType:descriptor.contentType,sizeBytes:bytes.body.length,sourceHash:bytes.sha256,disclosure:scope.disclosure,inline:descriptor.inline},bytes};
}
