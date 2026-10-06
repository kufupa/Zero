import {expect,it} from 'vitest';
import {convertDocxWithGotenberg} from '../src/quote-proposal/gotenberg.js';
const docx=Buffer.from('PK\u0003\u0004original-office');
it('posts the original DOCX as a bounded Office file to the explicitly supplied converter',async()=>{
 const original=Buffer.from(docx),signal=new AbortController().signal;
 const pdf=await convertDocxWithGotenberg(original,{url:'http://approved-local///',signal,fetchImpl:async(url,request)=>{
  expect(url).toBe('http://approved-local/forms/libreoffice/convert');expect(request?.method).toBe('POST');expect(request?.signal).toBeInstanceOf(AbortSignal);
  const file=(request!.body as FormData).get('files') as File;expect(file.name).toBe('document.docx');expect(file.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');expect(Buffer.from(await file.arrayBuffer())).toEqual(docx);
  return new Response('%PDF-actual-derived',{headers:{'content-type':'application/pdf'}});
 }});
 expect(Buffer.from(pdf).toString()).toBe('%PDF-actual-derived');expect(original).toEqual(docx);
});
it.each(['missing_endpoint','aborted','input_magic','input_size','http_error','mime','pdf_magic','declared_size','stream_size'])('rejects unsafe DOCX converter %s',async key=>{
 const controller=new AbortController();if(key==='aborted')controller.abort();let calls=0;
 const fetchImpl=async()=>{calls++;if(key==='http_error')return new Response('',{status:500});if(key==='stream_size')return new Response(new Uint8Array(20*1024*1024+1),{headers:{'content-type':'application/pdf'}});return new Response(key==='pdf_magic'?'wrong file':'%PDF-rendered',{headers:{'content-type':key==='mime'?'text/plain':'application/pdf',...(key==='declared_size'?{'content-length':String(20*1024*1024+1)}:{})}});};
 await expect(convertDocxWithGotenberg(key==='input_magic'?Buffer.from('bad'):key==='input_size'?new Uint8Array(20*1024*1024+1):docx,{url:key==='missing_endpoint'?'':'http://approved-local',signal:controller.signal,fetchImpl})).rejects.toThrow();
 if(['missing_endpoint','aborted','input_magic','input_size'].includes(key))expect(calls).toBe(0);
});
