import {normalizeContentId} from '../mail/cid-images.js';
import {createHash} from 'node:crypto';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  ARTIFACT_MAX_OUTPUT_BYTES,
  isDocxMimeType,
  readAuthorizedArtifactBytes,
  extractEmbeddedPdfText,
  type AuthorizedArtifactBytes,
  type SandboxRunner,
} from '../mail/artifacts/read-artifact.js';
import { maskCardNumbers } from './card-mask.js';
import type { DocumentDisclosure, DocumentSource } from './reservationist-document-facts.js';
export type ReservationistAttachmentMetadata = {
  attachmentId: string;
  messageId: string;
  threadId: string;
  ownerRef: string;
  messageAt: string;
  mimeType: string;
  sizeBytes: number;
  sourceHash: string;
  disclosure: DocumentDisclosure;
  inline?: boolean;
  contentId?: string;
  signatureNoise?: boolean;
};
/** Only a unique exact CID wholly below an original signoff is disposable. */
export function isReservationistSignatureNoise(input:{messageText:string;currentRequestText:string;attachment:{id:string;messageId:string;isInline:boolean;contentId:string|null;mimeType:string};attachments:readonly {id:string;messageId:string;contentId:string|null}[]}):boolean{
 const {attachment,messageText,currentRequestText}=input;
 if(!attachment.isInline||!/^image\/(?:png|jpeg|gif|webp)$/.test(attachment.mimeType)||messageText.length>40000||currentRequestText.length>40000||!attachment.contentId)return false;
 const cid=normalizeContentId(attachment.contentId);
 if(!cid||input.attachments.filter(a=>a.messageId===attachment.messageId&&a.contentId&&normalizeContentId(a.contentId)===cid).length!==1)return false;
 const history=/^[\t ]*(?:From:\s|Sent:\s|Subject:\s|On [^\r\n]{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message)|>)/im;
 const historyAt=messageText.search(history),currentHistoryAt=currentRequestText.search(history),authored=historyAt<0?messageText:messageText.slice(0,historyAt),current=currentHistoryAt<0?currentRequestText:currentRequestText.slice(0,currentHistoryAt);
 const signoff=/^[\t ]*(?:(?:thank\s+you\s+and\s+)?(?:kind|warm|best)\s+regards|regards)[^\p{L}\p{N}\r\n]*$/imu,signoffAt=authored.search(signoff);
 if(signoffAt<0)return false;
 // A current/delegated attachment dependency or a real request below the
 // signoff keeps every relevant image available to the business path.
 const dependency=/\b(?:attach(?:ed|ment)?|enclos(?:ed|ure)?|voucher|POP|proof of payment|image|picture|photo|scan|document|logo|banner|signature|footer)\b|\b(?:see|use|read|refer|based|shown)\b[^.!?;\r\n]{0,80}\b(?:below|following|previous|prior|forwarded)\b|\b(?:use|add|include|put|place|copy|show|insert)\b[^.!?;\r\n]{0,80}\b(?:it|this|that|them|these|those)\b/i;
 const currentSignoff=current.search(signoff),currentRequest=currentSignoff<0?current:current.slice(0,currentSignoff);
 const postscript=currentSignoff<0?'':current.slice(currentSignoff);
 // Explicit dates below refer to the authored calendar text. Preserve every
 // other reference and any separately stated attachment dependency.
 const withoutDateReference=(text:string)=>text.replace(/\bdates\s+below\b/gi,'dates');
 if(dependency.test(withoutDateReference(authored.slice(0,signoffAt)))||dependency.test(withoutDateReference(currentRequest))||/\b(?:please|kindly|can you|could you|request|attached|enclosed)\b[^.!?;\r\n]{0,120}\b(?:quote|quotation|rooms?|stay|booking|reservation|invoice|voucher|payment|allocation|attachment|document|image)\b/i.test(authored.slice(signoffAt))||/\b(?:please|kindly|can you|could you|use|add|include|put|place|copy|show|insert|see|read|refer)\b[^.!?;\r\n]{0,120}\b(?:attachment|image|picture|photo|scan|document|logo|banner|signature|footer|it|this|that|them|these|those)\b/i.test(postscript))return false;
 const refs=[...messageText.matchAll(/\bcid:([^\s[\]<>"')]+)/gi)].filter(ref=>normalizeContentId(ref[1]!)===cid);
 return refs.length>0&&refs.every(ref=>ref.index!>signoffAt&&(historyAt<0||ref.index!<historyAt));
}
export type AttachmentAdmission = {
  status: 'admitted' | 'manual_required' | 'ignored_signature';
  reason: string;
  relation?: 'prior' | 'current';
  metadata: ReservationistAttachmentMetadata;
  source?: DocumentSource;
  /** Private bytes for approved model file part only. Never serialize the admission into a prompt. */
  bytes?: AuthorizedArtifactBytes;
  draftReady: false;
};
export type ReservationistOfficeConverter = (originalDocx: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
export async function extractReservationistOfficeText(input:{body:Uint8Array;attachmentId:string;signal:AbortSignal;officeConverter:ReservationistOfficeConverter;runner?:SandboxRunner;revalidate:()=>Promise<boolean>}):Promise<{reason:string;pdfBody:Buffer|null;pages:readonly string[]|null;pageCount:number|null}>{
 const fail=(reason:string)=>({reason,pdfBody:null,pages:null,pageCount:null});
 const stillAuthorized=async()=>{try{return await input.revalidate();}catch{return false;}};
 const original=Buffer.from(input.body);
 if(original.length>ARTIFACT_MAX_INPUT_BYTES)return fail('too_large');
 if(original.length<4||!original.subarray(0,4).equals(Buffer.from([80,75,3,4])))return fail('malformed');
 let pdfBody:Buffer;
 try{const converted=await input.officeConverter(Buffer.from(original),input.signal);input.signal.throwIfAborted();pdfBody=Buffer.from(converted);
  if(pdfBody.length<5||pdfBody.length>ARTIFACT_MAX_INPUT_BYTES||pdfBody.subarray(0,5).toString()!=='%PDF-')return fail('office_conversion_invalid');
 }catch{input.signal.throwIfAborted();return fail('office_conversion_failed');}
 if(!await stillAuthorized())return fail('identity_or_authorization_changed');
 const extracted=await extractEmbeddedPdfText({body:pdfBody,declaredSize:pdfBody.length,declaredMime:'application/pdf',objectMime:'application/pdf'},{attachmentId:input.attachmentId,signal:input.signal,runner:input.runner});
 if(extracted.data.reason!=='text')return fail(extracted.data.reason);
 const pageCount=extracted.data.pageCount!,split=extracted.data.text!.split('\f');
 if(split.length===pageCount+1&&!split.at(-1)?.trim())split.pop();
 if(split.length!==pageCount)return fail('page_boundaries_unavailable');
 if(!await stillAuthorized())return fail('identity_or_authorization_changed');
 return{reason:'text',pdfBody,pages:split,pageCount};
}
export type ReservationistRasterMime='image/png'|'image/jpeg'|'image/webp';
/** Header-only validation: no decoder, OCR, metadata text or altered bytes enter the source. */
export function validateReservationistRaster(bytes:Uint8Array,mimeType:string):{width:number;height:number}{
 if(!(bytes instanceof Uint8Array))throw new Error('invalid_raster_bytes');
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width=0,height=0;
 if(b.length<12||b.length>ARTIFACT_MAX_INPUT_BYTES)throw new Error('invalid_raster_size');
 if(mimeType==='image/png'){
  if(!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('invalid_raster_magic');
  let offset=8,seenData=false,ended=false;
  while(offset+12<=b.length){const length=b.readUInt32BE(offset),type=b.toString('ascii',offset+4,offset+8),end=offset+12+length;if(end>b.length)throw new Error('truncated_raster');
   if(offset===8){if(type!=='IHDR'||length!==13)throw new Error('invalid_png_header');width=b.readUInt32BE(offset+8);height=b.readUInt32BE(offset+12);}
   if(type==='acTL')throw new Error('animated_raster_unsupported');if(type==='IDAT')seenData=true;if(type==='IEND'){if(length!==0||end!==b.length)throw new Error('invalid_png_end');ended=true;break;}offset=end;
  }if(!seenData||!ended)throw new Error('truncated_raster');
 }else if(mimeType==='image/jpeg'){
  if(b[0]!==255||b[1]!==216||b[b.length-2]!==255||b[b.length-1]!==217)throw new Error('invalid_raster_magic');
  let offset=2,seenScan=false;
  while(offset+4<=b.length){if(b[offset]!==255)throw new Error('invalid_jpeg_marker');while(b[offset]===255)offset++;const marker=b[offset++]!;if(marker===217)break;if(marker===1||marker>=208&&marker<=215)continue;
   const length=b.readUInt16BE(offset);if(length<2||offset+length>b.length)throw new Error('truncated_raster');
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)throw new Error('invalid_jpeg_frame');height=b.readUInt16BE(offset+3);width=b.readUInt16BE(offset+5);}
   if(marker===218){seenScan=true;break;}offset+=length;
  }if(!seenScan)throw new Error('jpeg_scan_missing');
 }else if(mimeType==='image/webp'){
  if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP'||b.readUInt32LE(4)+8!==b.length)throw new Error('invalid_raster_magic');
  let offset=12,seenImage=false;
  while(offset+8<=b.length){const type=b.toString('ascii',offset,offset+4),length=b.readUInt32LE(offset+4),start=offset+8,end=start+length;if(end>b.length)throw new Error('truncated_raster');
   if(type==='ANIM'||type==='ANMF')throw new Error('animated_raster_unsupported');
   if(type==='VP8X'){if(length<10||b[start]!&2)throw new Error('animated_or_invalid_webp');width=b.readUIntLE(start+4,3)+1;height=b.readUIntLE(start+7,3)+1;}
   if(type==='VP8 '){if(length<10||b[start+3]!==157||b[start+4]!==1||b[start+5]!==42)throw new Error('invalid_webp_frame');width=b.readUInt16LE(start+6)&16383;height=b.readUInt16LE(start+8)&16383;seenImage=true;}
   if(type==='VP8L'){if(length<5||b[start]!==47)throw new Error('invalid_webp_lossless');const bits=b.readUInt32LE(start+1);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;seenImage=true;}
   offset=end+(length&1);
  }if(!seenImage||offset!==b.length)throw new Error('invalid_webp_payload');
 }else throw new Error('unsupported_raster_mime');
 if(width<1||height<1||width>8192||height>8192||width*height>40000000)throw new Error('raster_dimensions_exceeded');return{width,height};
}
/** Server-resolved causal scope; live grant revalidation is mandatory. */
export async function admitReservationistAttachment(input: {
  metadata: ReservationistAttachmentMetadata;
  scope: { ownerRef: string; threadId: string; requestAt: string };
  read: Parameters<typeof readAuthorizedArtifactBytes>[0];
  runner?: SandboxRunner;
  /** Explicit trusted converter only; absent never contacts an Office service. */
  officeConverter?: ReservationistOfficeConverter;
}): Promise<AttachmentAdmission> {
  const m = { ...input.metadata },originalScope={...input.scope};
  const fail = (
    reason: string,
    status: AttachmentAdmission['status'] = 'manual_required',
  ): AttachmentAdmission => ({ status, reason, metadata: m, draftReady: false });
  if (
    !m.attachmentId ||
    !m.messageId ||
    m.ownerRef !== input.scope.ownerRef ||
    m.threadId !== input.scope.threadId ||
    input.read.attachmentId !== m.attachmentId ||
    !input.read.revalidate
  )
    return fail('unauthorized_scope');
  const at = Date.parse(m.messageAt),
    requestAt = Date.parse(input.scope.requestAt);
  if (!Number.isFinite(at) || !Number.isFinite(requestAt)) return fail('invalid_time');
  if (at > requestAt) return fail('future_attachment');
  if (!['guest', 'staff_only'].includes(m.disclosure) || !/^[a-f0-9]{64}$/.test(m.sourceHash))
    return fail('invalid_identity');
  if (!Number.isInteger(m.sizeBytes) || m.sizeBytes < 1) return fail('invalid_size');
  if (m.sizeBytes > ARTIFACT_MAX_INPUT_BYTES) return fail('too_large');
  // Only explicit server classification plus inline CID raster is disposable noise.
  if (
    m.inline === true &&
    m.signatureNoise === true &&
    /^image\/(png|jpeg|gif|webp)$/.test(m.mimeType)
  )
    return fail('signature_noise', 'ignored_signature');
  if (['image/png','image/jpeg','image/webp'].includes(m.mimeType)) {
    try {
      if(!input.read.authorizedAttachmentIds.has(m.attachmentId))return fail('unauthorized_scope');
      const locator=await input.read.resolveLocator(m.attachmentId);
      if(!locator||locator.messageId!==m.messageId||locator.mimeType!==m.mimeType||locator.sizeBytes!==m.sizeBytes||!locator.s3Key.startsWith(`attachments/${m.messageId}/`)||locator.s3Key.includes('\\')||locator.s3Key.split('/').some(part=>!part||part==='.'||part==='..')||input.read.expectedLocator&&(['messageId','mimeType','sizeBytes','s3Key'] as const).some(key=>locator[key]!==input.read.expectedLocator![key])||input.read.expectedSha256!==undefined&&input.read.expectedSha256!==m.sourceHash)return fail('identity_or_authorization_changed');
      const head=await input.read.s3.headObject(locator.s3Key);
      if(!head||head.sizeBytes!==m.sizeBytes||head.contentType&&head.contentType!==m.mimeType||!await input.read.revalidate())return fail('identity_or_authorization_changed');
      input.read.signal.throwIfAborted();const object=await input.read.s3.getObjectBounded(locator.s3Key,m.sizeBytes,input.read.signal);input.read.signal.throwIfAborted();
      if(!object||object.body.length!==m.sizeBytes||object.contentType&&object.contentType!==m.mimeType||createHash('sha256').update(object.body).digest('hex')!==m.sourceHash||!await input.read.revalidate()||JSON.stringify(m)!==JSON.stringify(input.metadata)||JSON.stringify(originalScope)!==JSON.stringify(input.scope))return fail('identity_or_authorization_changed');
      validateReservationistRaster(object.body,m.mimeType);
      return {status:'admitted',reason:'visual_review_required',metadata:m,relation:at===requestAt?'current':'prior',bytes:{body:object.body,contentType:m.mimeType,sha256:m.sourceHash,locator},source:{attachmentId:m.attachmentId,sourceHash:m.sourceHash,disclosure:m.disclosure,pages:null,pageCount:1},draftReady:false};
    }catch{input.read.signal.throwIfAborted();return fail('malformed_or_unsupported_raster');}
  }
  const office=isDocxMimeType(m.mimeType);
  if(office&&!input.officeConverter)return fail('office_converter_unavailable');
  if (!['application/pdf', 'text/plain'].includes(m.mimeType) && !office)
    return fail('unsupported_business_attachment');
  const bytes = await readAuthorizedArtifactBytes({
    ...input.read,
    expectedSha256: m.sourceHash,
    allowOffice:office,
    resolveLocator: async (id) => {
      const locator = await input.read.resolveLocator(id);
      return locator &&
        locator.messageId === m.messageId &&
        locator.mimeType === m.mimeType &&
        locator.sizeBytes === m.sizeBytes
        ? locator
        : null;
    },
  });
  if (!bytes) return fail('identity_or_authorization_changed');
  if(!await input.read.revalidate!()||JSON.stringify(m)!==JSON.stringify(input.metadata)||JSON.stringify(originalScope)!==JSON.stringify(input.scope))return fail('identity_or_authorization_changed');
  let pages: readonly string[] | null, pageCount: number, reason: string;
  let rendering:DocumentSource['rendering'];
  if(office){
    const extracted=await extractReservationistOfficeText({body:bytes.body,attachmentId:m.attachmentId,signal:input.read.signal,officeConverter:input.officeConverter!,runner:input.runner,revalidate:async()=>createHash('sha256').update(bytes.body).digest('hex')===m.sourceHash&&await input.read.revalidate!()&&JSON.stringify(m)===JSON.stringify(input.metadata)&&JSON.stringify(originalScope)===JSON.stringify(input.scope)});
    if(extracted.reason!=='text'||!extracted.pdfBody||!extracted.pages||extracted.pageCount===null)return fail(extracted.reason);
    reason=extracted.reason;pages=extracted.pages;pageCount=extracted.pageCount;
    rendering={method:'gotenberg_libreoffice',originalSourceHash:m.sourceHash,derivedPdfSHA256:createHash('sha256').update(extracted.pdfBody).digest('hex'),pageProvenance:'derived_pdf',textSHA256:createHash('sha256').update(JSON.stringify(pages)).digest('hex')};
  } else if (m.mimeType === 'application/pdf') {
    const extracted = await extractEmbeddedPdfText(
      {
        body: bytes.body,
        declaredSize: bytes.body.length,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      { attachmentId: m.attachmentId, signal: input.read.signal, runner: input.runner },
    );
    reason = extracted.data.reason;
    if (reason !== 'text' && reason !== 'no_embedded_text') return fail(reason);
    pageCount = extracted.data.pageCount!;
    if (reason === 'text') {
      const split = extracted.data.text!.split('\f');
      if (split.length === pageCount + 1 && !split.at(-1)?.trim()) split.pop();
      // Never fabricate page provenance if Poppler output lacks page boundaries.
      if (split.length !== pageCount) return fail('page_boundaries_unavailable');
      pages = split;
    } else pages = null;
  } else {
    if (bytes.body.byteLength > ARTIFACT_MAX_OUTPUT_BYTES) return fail('too_large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.body);
    } catch {
      return fail('malformed');
    }
    if (!text.trim()) return fail('no_embedded_text');
    // Same masking as PDF text: card numbers and security codes never reach the model or a stored source.
    pages = [maskCardNumbers(text)];
    pageCount = 1;
    reason = 'text';
  }
  return {
    status: 'admitted',
    reason,
    metadata: m,
    relation: at === requestAt ? 'current' : 'prior',
    bytes,
    source: {
      attachmentId: m.attachmentId,
      sourceHash: bytes.sha256,
      disclosure: m.disclosure,
      pages,
      pageCount,
      ...(rendering?{rendering}:{}),
    },
    draftReady: false,
  };
}
