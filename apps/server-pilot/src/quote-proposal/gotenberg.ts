export async function convertXlsxWithGotenberg(
  xlsxBytes: Uint8Array,
  opts: { url: string; fetchImpl?: typeof fetch } = { url: '' },
): Promise<Uint8Array> {
  const base = opts.url.replace(/\/+$/, '');
  if (!base) throw new Error('GOTENBERG_URL missing');
  const form = new FormData();
  form.append('files', new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'quote.xlsx');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/forms/libreoffice/convert`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`gotenberg convert failed: ${res.status}`);
  }
  if (res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') {
    throw new Error('gotenberg convert returned non-PDF MIME');
  }
  const pdf = new Uint8Array(await res.arrayBuffer());
  if (pdf.length <= 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') {
    throw new Error('gotenberg convert returned empty or invalid PDF bytes');
  }
  return pdf;
}

/** Explicit Office input; no default endpoint or persistence. */
export async function convertDocxWithGotenberg(
  docxBytes: Uint8Array,
  opts: {url:string;signal:AbortSignal;fetchImpl?:typeof fetch},
): Promise<Uint8Array> {
  const base=opts.url.replace(/\/+$/,'');
  if(!base)throw new Error('GOTENBERG_URL missing');
  if(docxBytes.length<4||docxBytes.length>20*1024*1024||docxBytes[0]!==80||docxBytes[1]!==75||docxBytes[2]!==3||docxBytes[3]!==4)throw new Error('invalid_docx_bytes');
  opts.signal.throwIfAborted();
  const form=new FormData();
  form.append('files',new Blob([Uint8Array.from(docxBytes)],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'document.docx');
  const res=await (opts.fetchImpl??fetch)(`${base}/forms/libreoffice/convert`,{method:'POST',body:form,signal:AbortSignal.any([opts.signal,AbortSignal.timeout(30000)])});
  if(!res.ok)throw new Error(`gotenberg convert failed: ${res.status}`);
  if(res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/pdf')throw new Error('gotenberg convert returned non-PDF MIME');
  const limit=20*1024*1024,declared=res.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('gotenberg PDF too large');
  if(!res.body)throw new Error('gotenberg PDF body missing');
  const reader=res.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){opts.signal.throwIfAborted();const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>limit)throw new Error('gotenberg PDF too large');chunks.push(item.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  const pdf=new Uint8Array(size);let offset=0;for(const chunk of chunks){pdf.set(chunk,offset);offset+=chunk.length;}
  if(pdf.length<=5||new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw new Error('gotenberg convert returned empty or invalid PDF bytes');
  return pdf;
}
